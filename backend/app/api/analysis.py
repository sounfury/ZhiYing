"""
分析相关 API 路由。

POST /api/books/{book_id}/analyze        -- 启动分析（可选 to_chapter）
GET  /api/books/{book_id}/progress       -- SSE 逐章进度
POST /api/books/{book_id}/analyze/stop   -- 停止分析
GET  /api/books/{book_id}/cast           -- 查看人名册
GET  /api/books/{book_id}/chapters/{cid}/result -- 单章 ledger
GET  /api/books/{book_id}/graph          -- 汇总出图（Aggregator）
GET  /api/books/{book_id}/factions       -- 查看势力册
POST /api/books/{book_id}/factions       -- 跑势力归纳（FactionWriter）
"""
from __future__ import annotations

import asyncio
import json
from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.agent.faction_writer import extract_factions
from app.agent.llm import LLMControl
from app.config import settings
from app.core.aggregator import BLOCKING_STATUSES, Aggregator, GraphQuery
from app.core.orchestrator import Orchestrator, _get_start_lock, get_orchestrator
from app.errors import AppError, ErrorCode, book_not_found
from app.logging_config import get_logger
from app.storage.filestore import Filestore, get_filestore
from app.models.book import BookStatus

logger = get_logger("api.analysis")

router = APIRouter(prefix="/api/books", tags=["analysis"])


class RetryFailedRequest(BaseModel):
    chapter_ids: Optional[list[int]] = None



# ── POST /analyze ──


@router.post("/{book_id}/analyze")
async def start_analysis(
    book_id: str,
    to_chapter: Optional[int] = Query(None, description="Only analyze chapters with order <= to_chapter"),
) -> dict:
    """
    启动分析流程（异步执行，不阻塞）。

    - book 不存在 → 404
    - status==analyzing → 409
    - 成功 → 202 Accepted
    """
    fs = get_filestore()

    # 校验 book 存在
    meta = await asyncio.to_thread(fs.read_meta, book_id)  # raises book_not_found → 404

    # #9: to_chapter 校验
    if to_chapter is not None and to_chapter < 1:
        raise AppError(
            ErrorCode.VALIDATION_ERROR,
            f"to_chapter must be >= 1, got {to_chapter}",
        )

    # 创建 Orchestrator 并启动
    orch = Orchestrator(book_id, fs, settings)
    result = await orch.start(to_chapter=to_chapter)

    return result


# ── GET /analysis/task ──


@router.get("/{book_id}/analysis/task")
async def get_analysis_task(book_id: str) -> dict:
    """Return the persistent task snapshot used for refresh/reconnect recovery."""
    fs = get_filestore()
    await asyncio.to_thread(fs.read_meta, book_id)
    task = await asyncio.to_thread(fs.read_analysis_task, book_id)
    if task is None:
        return {"active": False, "status": "idle", "phase": "idle", "chapters": [], "events": []}
    return task.model_dump(mode="json")


# ── GET /progress (SSE) ──


@router.get("/{book_id}/progress")
async def progress_sse(book_id: str, request: Request) -> StreamingResponse:
    """
    SSE 流：逐章推送分析进度。

    event: progress  data: {chapter_id, done, total, status}
    event: done      data: {chapters_done, chapters_failed}
    """
    async def event_stream():
        try:
            last_event_id = int(request.headers.get("last-event-id") or "0")
        except ValueError:
            last_event_id = 0

        def encode(event_type: str, data: dict, event_id: int | None = None) -> str:
            prefix = f"id: {event_id}\n" if event_id is not None else ""
            return f"{prefix}event: {event_type}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

        orch = get_orchestrator(book_id)

        if orch is None:
            # Backend restart / completed task: replay only events newer than the
            # browser's Last-Event-ID. History is bounded by the persisted task.
            fs = get_filestore()
            meta = await asyncio.to_thread(fs.read_meta, book_id)
            task = await asyncio.to_thread(fs.read_analysis_task, book_id)
            if task is not None:
                replayed_done = False
                for item in task.events:
                    if item.event_id <= last_event_id:
                        continue
                    if item.type == "done":
                        replayed_done = True
                    yield encode(item.type, item.data, item.event_id)
                if task.result:
                    if not replayed_done and (not task.events or task.events[-1].type != "done"):
                        yield encode("done", task.result, task.event_seq or None)
                    return
                if not task.active:
                    payload = {
                        "status": task.status, "phase": task.phase,
                        "chapters_done": len([c for c in task.chapters if c.status in ("done", "partial")]),
                        "chapters_failed": len([c for c in task.chapters if c.status == "failed"]),
                        "stopped": task.status in ("stopped", "interrupted"),
                    }
                    yield encode("done", payload, task.event_seq or None)
                    return
            progress = meta.analysis_progress
            payload = {
                "chapters_done": len(progress.chapters_done),
                "chapters_failed": len(progress.chapters_failed),
                "chapters_done_ids": progress.chapters_done,
                "chapters_failed_ids": progress.chapters_failed,
                "chapters_partial_ids": progress.chapters_partial,
                "status": meta.status.value,
                "phase": meta.status.value,
            }
            yield encode("done", payload)
            return

        history, live_queue = orch.subscribe()
        try:
            for history_event in history:
                event_id = history_event.get("id")
                if event_id is not None and event_id <= last_event_id:
                    continue
                event_type = history_event.get("type", "progress")
                data = history_event.get("data", {})
                yield encode(event_type, data, event_id)

            if orch.finished and orch.final_result is not None:
                if not history or history[-1].get("type") != "done":
                    event_id = orch._task_snapshot.event_seq if orch._task_snapshot is not None else None
                    if event_id is None or event_id > last_event_id:
                        yield encode("done", orch.final_result, event_id)
                return

            while True:
                try:
                    event = await asyncio.wait_for(live_queue.get(), timeout=30.0)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                event_type = event.get("type", "")
                data = event.get("data", {})
                event_id = event.get("id")
                if event_id is not None and event_id <= last_event_id:
                    continue
                if event_type in ("progress", "done"):
                    yield encode(event_type, data, event_id)
                if event_type == "done":
                    return
        finally:
            orch.unsubscribe(live_queue)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── Failed chapter handling ──


@router.post("/{book_id}/analyze/retry-failed")
async def retry_failed_chapters(book_id: str, body: RetryFailedRequest = RetryFailedRequest()) -> dict:
    orch = get_orchestrator(book_id)
    if orch is None:
        raise AppError(
            ErrorCode.VALIDATION_ERROR,
            "No active in-memory analysis task; restart analysis or rerun a chapter",
            status_code=409,
        )
    return await orch.retry_failed(body.chapter_ids)


@router.post("/{book_id}/analyze/skip-failed")
async def skip_failed_chapters(book_id: str) -> dict:
    orch = get_orchestrator(book_id)
    if orch is None:
        raise AppError(
            ErrorCode.VALIDATION_ERROR,
            "No active in-memory analysis task",
            status_code=409,
        )
    return await orch.skip_failed_chapters()


# ── POST /analyze/stop ──


@router.post("/{book_id}/analyze/stop")
async def stop_analysis(book_id: str) -> dict:
    """设置 stop flag 中断分析。运行中的 Agent 自然完成，未启动的章跳过。"""
    orch = get_orchestrator(book_id)

    if orch is None:
        return {"status": "idle", "message": "No analysis running"}

    orch.stop_flag.set()
    logger.info("Stop flag set: book=%s", book_id)
    return {"status": "stopping"}


# ── GET /cast ──


@router.get("/{book_id}/cast")
async def get_cast(book_id: str) -> dict:
    """返回 cast.json 内容。不存在返回空 cast。"""
    fs = get_filestore()
    cast = await asyncio.to_thread(fs.read_cast, book_id)
    return cast.model_dump(mode="json")


# ── GET /chapters/{chapter_id}/result ──


@router.get("/{book_id}/chapters/{chapter_id}/result")
async def get_chapter_result(book_id: str, chapter_id: int) -> dict:
    """返回指定章的 ChapterLedger。不存在返回 404。"""
    fs = get_filestore()
    ledger_path = fs.ledger_path(book_id, chapter_id)

    if not ledger_path.exists():
        # #12: 区分「章结果不存在」与「书不存在」
        raise AppError(
            ErrorCode.BOOK_NOT_FOUND,
            f"Chapter result not found: chapter {chapter_id} (book={book_id}) has not been analyzed yet.",
            status_code=404,
        )

    ledger = await asyncio.to_thread(fs.read_ledger, book_id, chapter_id)
    return ledger.model_dump(mode="json")


# ── GET /graph ──


@router.get("/{book_id}/graph")
async def get_graph(
    book_id: str,
    to_chapter: Optional[int] = Query(
        None,
        description="Chapter bound: prefix 1..N, or the only chapter when single_chapter=true",
    ),
    single_chapter: bool = Query(
        False,
        description="If true, only aggregate that one chapter (requires to_chapter)",
    ),
    min_appearance: int = Query(
        2, ge=0, description="Min distinct chapters to keep a person as a node"
    ),
    predicate_filter: Optional[str] = Query(
        None,
        description="Comma-separated registered predicate identifiers",
    ),
    category_filter: Optional[str] = Query(None, description="Comma-separated display categories"),
    fs: Filestore = Depends(get_filestore),
) -> dict:
    """
    确定性汇总人物关系图（无 LLM）。

    - book 不存在 → 404
    - analyzing / reconciling → 409
    - 无 ledger / uploaded → 空图 200
    - analyzed / reconcile_failed → 正常出图
    - single_chapter=true 时只出 to_chapter 一章的关系（非此前累计）
    """
    meta = await asyncio.to_thread(fs.read_meta, book_id)

    if meta.status in BLOCKING_STATUSES:
        raise AppError(
            ErrorCode.ANALYSIS_ALREADY_RUNNING,
            f"Graph unavailable while status is {meta.status.value} (book={book_id})",
            status_code=409,
        )

    if to_chapter is not None and to_chapter < 1:
        raise AppError(
            ErrorCode.VALIDATION_ERROR,
            f"to_chapter must be >= 1, got {to_chapter}",
        )

    if single_chapter and to_chapter is None:
        raise AppError(
            ErrorCode.VALIDATION_ERROR,
            "single_chapter=true requires to_chapter (the chapter to isolate)",
        )

    types: Optional[list[str]] = None
    if predicate_filter:
        types = [t.strip() for t in predicate_filter.split(",") if t.strip()]

    query = GraphQuery(
        to_chapter=to_chapter,
        single_chapter=single_chapter,
        min_appearance=min_appearance,
        predicate_filter=types,
        category_filter=[c.strip() for c in category_filter.split(",") if c.strip()] if category_filter else None,
    )
    agg = Aggregator(book_id, fs)
    data = await asyncio.to_thread(agg.compile, query)
    return data.model_dump(mode="json")


# ── GET / POST /factions ──


@router.get("/{book_id}/factions")
async def get_factions(book_id: str) -> dict:
    """返回 factions.json 内容。不存在返回空势力册。"""
    fs = get_filestore()
    await asyncio.to_thread(fs.read_meta, book_id)  # 书不存在 → 404
    book = await asyncio.to_thread(fs.read_factions, book_id)
    return book.model_dump(mode="json")


@router.post("/{book_id}/factions")
async def run_faction_extraction(book_id: str) -> dict:
    """
    跑一次势力归纳并覆盖 factions.json（同步等待，单次 LLM 会话）。

    - book 不存在 → 404
    - analyzing / reconciling → 409（人名册还在变，分块没意义）
    - 尚无已分析章 → 400
    - Agent 未提交 → 502，旧 factions.json 保持不动
    """
    fs = get_filestore()
    async with _get_start_lock(book_id):
        meta = await asyncio.to_thread(fs.read_meta, book_id)

        if meta.status in BLOCKING_STATUSES:
            raise AppError(
                ErrorCode.ANALYSIS_ALREADY_RUNNING,
                f"Faction extraction unavailable while status is {meta.status.value} (book={book_id})",
                status_code=409,
            )

        if not meta.analysis_progress.chapters_done:
            raise AppError(
                ErrorCode.VALIDATION_ERROR,
                f"No analyzed chapters yet (book={book_id}); run /analyze first",
            )

        stop_event = asyncio.Event()
        control = LLMControl.from_settings(settings, stop_event)
        result = await extract_factions(
            book_id, fs, settings, stop_event=stop_event, control=control
        )

        if not result.success or result.book is None:
            raise AppError(
                ErrorCode.LLM_PROVIDER_ERROR,
                f"Faction extraction failed: {result.warning}",
                status_code=502,
            )

        return {
            "status": "ok",
            "version": result.book.version,
            "factions": len(result.book.factions),
            "members": sum(len(f.members) for f in result.book.factions),
            "steps_used": result.steps_used,
        }


@router.get("/{book_id}/relation-types")
async def book_relation_types(book_id: str, fs: Filestore = Depends(get_filestore)) -> dict:
    await asyncio.to_thread(fs.read_meta, book_id)
    registry = await asyncio.to_thread(fs.read_relation_registry, book_id)
    return {"version": registry.version, "relation_types": [d.model_dump() for d in registry.definitions]}
