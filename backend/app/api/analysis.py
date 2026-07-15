"""
分析相关 API 路由。

POST /api/books/{book_id}/analyze        -- 启动分析（可选 to_chapter）
GET  /api/books/{book_id}/progress       -- SSE 逐章进度
POST /api/books/{book_id}/analyze/stop   -- 停止分析
GET  /api/books/{book_id}/cast           -- 查看人名册
GET  /api/books/{book_id}/chapters/{cid}/result -- 单章 ledger
"""
from __future__ import annotations

import asyncio
import json
from typing import Optional

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from app.config import settings
from app.core.orchestrator import Orchestrator, get_orchestrator
from app.errors import AppError, ErrorCode, book_not_found
from app.logging_config import get_logger
from app.storage.filestore import get_filestore

logger = get_logger("api.analysis")

router = APIRouter(prefix="/api/books", tags=["analysis"])


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


# ── GET /progress (SSE) ──


@router.get("/{book_id}/progress")
async def progress_sse(book_id: str) -> StreamingResponse:
    """
    SSE 流：逐章推送分析进度。

    event: progress  data: {chapter_id, done, total, status}
    event: done      data: {chapters_done, chapters_failed}
    """
    async def event_stream():
        orch = get_orchestrator(book_id)

        if orch is None:
            # 没有正在进行的分析
            yield f"event: done\ndata: {json.dumps({'chapters_done': 0, 'chapters_failed': 0, 'error': 'no analysis running'})}\n\n"
            return

        # #1: 编排器还在但分析已结束 → 立刻推 done 并退出
        if orch.finished and orch.final_result is not None:
            yield f"event: done\ndata: {json.dumps(orch.final_result, ensure_ascii=False)}\n\n"
            return

        while True:
            try:
                event = await asyncio.wait_for(
                    orch.progress_queue.get(), timeout=30.0
                )
            except asyncio.TimeoutError:
                # keepalive
                yield ": keepalive\n\n"
                continue

            event_type = event.get("type", "")
            data = event.get("data", {})

            if event_type == "progress":
                yield f"event: progress\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
            elif event_type == "done":
                yield f"event: done\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
                return

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


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
