"""
Orchestrator -- few_long 模式薄编排。

流程：
  1. start(to_chapter): 校验 → 过滤章队列 → 冻结 cast → status=analyzing → 异步 _run()
  2. _run(): Semaphore 并行 run_chapter_agent → 逐章 push SSE progress → barrier
  3. barrier 后: CastWriter 顺序 apply → finalize → SuspectsGenerator → ReconcileAgent → PatchApplier
  4. 更新 meta status (analyzed / reconcile_failed / failed)

D7: SSE 逐章推送
D8: to_chapter 简单截断
D9: 防重入 + 粗糙 stop flag
"""
from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import uuid4

from app.agent.cast_writer import CastWriter
from app.agent.chapter_agent import AgentResult, run_chapter_agent
from app.agent.faction_writer import extract_factions
from app.agent.relation_pipeline import enrich_ledger, enrich_ledgers
from app.agent.llm import LLMControl, LLMStopped, LLMBudgetExceeded
from app.config import Settings, settings
from app.core.reconcile_service import reconcile_book
from app.core.rebuild import (
    apply_human_edits,
    capture_relations_by_id,
    create_staging_filestore,
    discard_staging,
    publish_staging_book,
    rebuild_cast_from_extractions,
    remap_manual_relation_removals,
)
from app.errors import AppError, ErrorCode, analysis_already_running
from app.logging_config import get_logger
from app.models.book import (
    AnalysisMode,
    BookMeta,
    BookStatus,
    ChapterBrief,
)
from app.models.cast import Cast
from app.models.book import AnalysisTaskEvent, AnalysisTaskSnapshot, ChapterTaskState
from app.storage.filestore import Filestore

logger = get_logger("core.orchestrator")


# ── 全局 Orchestrator 注册表（book_id → Orchestrator 实例）──
_orchestrators: Dict[str, "Orchestrator"] = {}

# #10: 每本书一把 asyncio.Lock，防止 start() 竞态
_start_locks: Dict[str, asyncio.Lock] = {}


def get_orchestrator(book_id: str) -> Optional["Orchestrator"]:
    """获取正在运行的 Orchestrator 实例（用于 progress/stop 端点）。"""
    return _orchestrators.get(book_id)


def _get_start_lock(book_id: str) -> asyncio.Lock:
    """获取 per-book 的启动锁（防止并发 start 竞态）。"""
    if book_id not in _start_locks:
        _start_locks[book_id] = asyncio.Lock()
    return _start_locks[book_id]


class Orchestrator:
    """few_long 模式编排器。"""

    def __init__(
        self,
        book_id: str,
        filestore: Filestore,
        cfg: Optional[Settings] = None,
    ) -> None:
        """初始化并发控制、SSE 广播通道与任务快照占位；运行时状态由 start() 填充。"""
        self.book_id = book_id
        self.filestore = filestore
        self.cfg = cfg or settings

        # 并发控制
        self.stop_flag: asyncio.Event = asyncio.Event()
        self.llm_control: Optional[LLMControl] = None
        # SSE 事件广播：避免多个浏览器连接竞争消费同一个 Queue。
        self.progress_queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue()
        self.progress_history: list[Dict[str, Any]] = []
        self._subscribers: set[asyncio.Queue[Dict[str, Any]]] = set()
        self._task_snapshot: Optional[AnalysisTaskSnapshot] = None
        self._task_persist_lock = asyncio.Lock()

        # #1: 完成标记 + 结果摘要（供 SSE 端点检查是否已结束）
        self.finished: bool = False
        self.final_result: Optional[dict] = None

        # 运行时状态（start() 填充）
        self._meta: Optional[BookMeta] = None
        self._chapter_queue: List[ChapterBrief] = []
        self._cast_snapshot: Cast = Cast()
        self._total_chapters: int = 0
        self._done_count: int = 0
        # 逐章失败摘要，写入 done 事件便于前端展示
        self._chapter_errors: List[Dict[str, Any]] = []
        self._retry_queue: asyncio.Queue[int] = asyncio.Queue()
        self._retry_queued: set[int] = set()
        self._retry_wakeup: asyncio.Event = asyncio.Event()
        self._skip_failed: asyncio.Event = asyncio.Event()
        self._extraction_open: bool = False
        self._preloaded_results: Dict[int, AgentResult] = {}
        self._resume_from_snapshots: bool = False
        self._resume_reservation_cast: Cast = Cast()

    def subscribe(self) -> tuple[list[Dict[str, Any]], asyncio.Queue[Dict[str, Any]]]:
        """Return a history snapshot plus a dedicated live queue for one SSE client."""
        queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue()
        self._subscribers.add(queue)
        return list(self.progress_history), queue

    def unsubscribe(self, queue: asyncio.Queue[Dict[str, Any]]) -> None:
        """移除一个 SSE 订阅队列（客户端断开时调用）。"""
        self._subscribers.discard(queue)

    async def _persist_task(self) -> None:
        """串行化地把任务快照（含 LLM 用量）落盘；无活动任务时直接返回。"""
        if self._task_snapshot is None:
            return
        async with self._task_persist_lock:
            if self._task_snapshot is None:
                return
            if self.llm_control is not None:
                usage = self.llm_control.snapshot()
                self._task_snapshot.llm_requests = usage["llm_requests"]
                self._task_snapshot.input_tokens = usage["input_tokens"]
                self._task_snapshot.output_tokens = usage["output_tokens"]
                self._task_snapshot.total_tokens = usage["total_tokens"]
                if usage.get("stop_reason"):
                    self._task_snapshot.stop_reason = usage["stop_reason"]
            self._task_snapshot.updated_at = datetime.now()
            snapshot = self._task_snapshot.model_copy(deep=True)
            await asyncio.to_thread(
                self.filestore.write_analysis_task, self.book_id, snapshot
            )

    async def _emit(self, event_type: str, data: dict[str, Any]) -> None:
        """
        广播一个事件：追加历史、写入任务快照并推送给所有订阅者。

        done 事件终结任务快照（active=False、status/phase/result、finished_at）；
        只有生命周期事件（无 kind 字段）可以改写持久化的 phase。
        """
        event_id: int | None = None
        # 组装事件：有任务快照时带上单调递增的 event_id
        if self._task_snapshot is not None:
            self._task_snapshot.event_seq += 1
            event_id = self._task_snapshot.event_seq
        event: Dict[str, Any] = {"type": event_type, "data": data}
        if event_id is not None:
            event["id"] = event_id
        # 追加进历史并限制长度（供新订阅者回放）
        self.progress_history.append(event)
        if len(self.progress_history) > 200:
            self.progress_history = self.progress_history[-200:]
        # 写入任务快照：done 事件终结任务，其余事件追加进事件流
        if self._task_snapshot is not None:
            if event_type == "done":
                self._task_snapshot.active = False
                self._task_snapshot.status = str(data.get("status") or data.get("phase") or "completed")
                self._task_snapshot.phase = str(data.get("phase") or self._task_snapshot.phase)
                self._task_snapshot.result = dict(data)
                self._task_snapshot.finished_at = datetime.now()
            self._task_snapshot.events.append(AnalysisTaskEvent(
                event_id=event_id or self._task_snapshot.event_seq, type=event_type, data=data
            ))
            if len(self._task_snapshot.events) > 200:
                self._task_snapshot.events = self._task_snapshot.events[-200:]
            # Model telemetry also carries a provider phase (chapter/reconcile/etc.).
            # Only lifecycle progress events may replace the durable task phase.
            if data.get("phase") and not data.get("kind"):
                self._task_snapshot.phase = str(data["phase"])
            await self._persist_task()
        # Legacy queue remains for backend tests/internal consumers. SSE clients use
        # per-subscriber queues below, so multiple pages never steal each other's events.
        await self.progress_queue.put(event)
        for queue in list(self._subscribers):
            await queue.put(event)

    async def _push_progress(self, data: dict[str, Any]) -> None:
        """以 progress 事件类型广播一条进度数据。"""
        await self._emit("progress", data)

    def _chapter_counts(self) -> dict[str, int]:
        """Return live extraction queue counts for diagnostics/UI.

        Counts are mutually exclusive so they never sum above the task's chapter
        total. ``partial`` is a successful extraction outcome; ``skipped`` is a
        terminal failure/missing outcome; ``queued_retry`` goes back to queued.
        """
        if self._task_snapshot is None:
            return {
                "success_count": 0,
                "failure_count": 0,
                "running_count": 0,
                "queued_count": 0,
            }
        states = [chapter.status for chapter in self._task_snapshot.chapters]
        return {
            "success_count": sum(status in ("done", "partial") for status in states),
            "failure_count": sum(status in ("failed", "skipped") for status in states),
            "running_count": sum(status == "running" for status in states),
            "queued_count": sum(status in ("pending", "queued_retry") for status in states),
        }

    async def _set_phase(self, phase: str, **extra: Any) -> None:
        """更新任务快照的当前阶段，并附带章节计数推送进度。"""
        if self._task_snapshot is not None:
            self._task_snapshot.phase = phase
        await self._push_progress({"phase": phase, **self._chapter_counts(), **extra})

    async def _set_chapter_state(
        self, chapter_id: int, status: str, *, error: str = "", increment_attempt: bool = False
    ) -> None:
        """更新单章任务状态（不存在则新建）并持久化任务快照。"""
        if self._task_snapshot is None:
            return
        state = self._task_snapshot.chapter_state(chapter_id)
        if state is None:
            state = ChapterTaskState(chapter_id=chapter_id)
            self._task_snapshot.chapters.append(state)
        state.status = status
        state.last_error = error
        if increment_attempt:
            state.attempts += 1
        state.updated_at = datetime.now()
        await self._persist_task()

    async def _finish_task(self, payload: dict[str, Any]) -> None:
        """终结任务快照：active=False 并写入最终 status/phase/result。"""
        if self._task_snapshot is None:
            return
        self._task_snapshot.active = False
        self._task_snapshot.status = str(payload.get("status") or payload.get("phase") or "completed")
        self._task_snapshot.phase = str(payload.get("phase") or self._task_snapshot.phase)
        self._task_snapshot.result = dict(payload)
        self._task_snapshot.finished_at = datetime.now()
        await self._persist_task()

    async def retry_failed(self, chapter_ids: Optional[list[int]] = None) -> dict:
        """Queue failed chapters while the current extraction task is waiting."""
        if not self._extraction_open or self._task_snapshot is None or not self._task_snapshot.active:
            raise AppError(
                ErrorCode.VALIDATION_ERROR,
                "Failed chapters can only be retried while the task is waiting for failed chapter handling",
                status_code=409,
            )
        failed = {c.chapter_id for c in self._task_snapshot.chapters if c.status == "failed"}
        requested = failed if chapter_ids is None else set(chapter_ids)
        queued: list[int] = []
        ignored: list[int] = []
        for cid in sorted(requested):
            if cid not in failed or cid in self._retry_queued:
                ignored.append(cid)
                continue
            self._retry_queued.add(cid)
            await self._set_chapter_state(cid, "queued_retry")
            await self._retry_queue.put(cid)
            queued.append(cid)
        if queued:
            self._retry_wakeup.set()
            await self._push_progress({
                "phase": "waiting_failed", "retry_queued": queued,
                "failed_chapters": sorted(failed),
                **self._chapter_counts(),
            })
        return {"status": "queued", "queued": queued, "ignored": ignored}

    async def skip_failed_chapters(self) -> dict:
        """Continue post-processing with successful chapters only."""
        if not self._extraction_open or self._task_snapshot is None or not self._task_snapshot.active:
            raise AppError(
                ErrorCode.VALIDATION_ERROR,
                "Failed chapters can only be skipped while the task is waiting",
                status_code=409,
            )
        failed = [c.chapter_id for c in self._task_snapshot.chapters if c.status in ("failed", "queued_retry")]
        for cid in failed:
            await self._set_chapter_state(cid, "skipped", error=self._task_snapshot.chapter_state(cid).last_error)
        self._skip_failed.set()
        self._retry_wakeup.set()
        await self._push_progress({
            "phase": "failed_skipped", "failed_chapters": sorted(failed),
            **self._chapter_counts(),
        })
        return {"status": "skipping", "chapters": sorted(failed)}

    async def start(self, to_chapter: Optional[int] = None) -> dict:
        """
        启动分析（异步执行，不阻塞）。

        Returns:
            {status: "analyzing", mode: "few_long", total_chapters: N}

        Raises:
            AppError(ANALYSIS_ALREADY_RUNNING): status==analyzing
        """
        # #10: per-book 锁，防止并发 start 竞态
        async with _get_start_lock(self.book_id):
            # ── 读取 meta ──
            self._meta = await asyncio.to_thread(self.filestore.read_meta, self.book_id)

            # ── 防重入 ──
            if self._meta.status in (BookStatus.ANALYZING, BookStatus.RECONCILING):
                raise analysis_already_running(self.book_id)

            # ── 过滤分析章队列 ──
            briefs = await asyncio.to_thread(
                self.filestore.list_chapter_briefs, self.book_id
            )
            self._chapter_queue = [b for b in briefs if b.include_in_analysis]

            # to_chapter 截断
            if to_chapter is not None:
                self._chapter_queue = [
                    b for b in self._chapter_queue if b.order <= to_chapter
                ]

            self._total_chapters = len(self._chapter_queue)
            selected_ids = {b.chapter_id for b in self._chapter_queue}

            previous_task = await asyncio.to_thread(
                self.filestore.read_analysis_task, self.book_id
            )
            self._preloaded_results = {}
            self._resume_from_snapshots = False
            self._resume_reservation_cast = await asyncio.to_thread(
                self.filestore.read_cast, self.book_id
            )
            if (
                previous_task is not None
                and previous_task.kind == "full"
                and previous_task.status == "interrupted"
                and self.filestore.extraction_base_cast_path(self.book_id).exists()
            ):
                for state in previous_task.chapters:
                    if state.chapter_id not in selected_ids or state.status not in ("done", "partial"):
                        continue
                    try:
                        current = await asyncio.to_thread(
                            self.filestore.extraction_result_is_current,
                            self.book_id, state.chapter_id,
                        )
                        item = await asyncio.to_thread(
                            self.filestore.read_extraction_result,
                            self.book_id, state.chapter_id,
                        ) if current else None
                    except Exception:
                        item = None
                    if item is None:
                        continue
                    ledger = item["ledger"]
                    self._preloaded_results[state.chapter_id] = AgentResult(
                        chapter_id=state.chapter_id,
                        ledger=ledger,
                        cast_buffer=item["cast_buffer"],
                        summary=ledger.summary,
                        success=True,
                        partial=ledger.analysis_status == "partial",
                    )
                self._resume_from_snapshots = bool(self._preloaded_results)

            if self._resume_from_snapshots:
                base_cast = await asyncio.to_thread(
                    self.filestore.read_extraction_base_cast, self.book_id
                )
                self._cast_snapshot = base_cast or Cast()
            else:
                self._cast_snapshot = self._resume_reservation_cast
                # Raw extraction snapshots are the rebuild source of truth. Auto reconcile
                # mutations must never become the input baseline of a later rerun.
                await asyncio.to_thread(
                    self.filestore.write_extraction_base_cast, self.book_id, self._cast_snapshot
                )

            preloaded_ids = sorted(self._preloaded_results)
            pending_ids = [
                b.chapter_id for b in self._chapter_queue
                if b.chapter_id not in self._preloaded_results
            ]
            self._meta.status = BookStatus.ANALYZING
            self._meta.analysis_progress.mode = AnalysisMode.FEW_LONG
            self._meta.analysis_progress.chapters_done = preloaded_ids
            self._meta.analysis_progress.chapters_failed = []
            self._meta.analysis_progress.chapters_partial = sorted(
                cid for cid, result in self._preloaded_results.items() if result.partial
            )
            self._meta.analysis_progress.chapters_pending = pending_ids
            self._meta.analysis_progress.reconcile_done = False
            await asyncio.to_thread(self.filestore.write_meta, self.book_id, self._meta)

            # ── 注册 + 重置 ──
            _orchestrators[self.book_id] = self
            self.stop_flag.clear()
            previous_states = {
                state.chapter_id: state
                for state in (previous_task.chapters if previous_task is not None else [])
            }
            chapter_states: list[ChapterTaskState] = []
            for brief in self._chapter_queue:
                previous = previous_states.get(brief.chapter_id)
                result = self._preloaded_results.get(brief.chapter_id)
                chapter_states.append(ChapterTaskState(
                    chapter_id=brief.chapter_id,
                    status=("partial" if result and result.partial else "done") if result else "pending",
                    attempts=previous.attempts if previous is not None else 0,
                ))
            self._task_snapshot = AnalysisTaskSnapshot(
                task_id=str(uuid4()),
                book_id=self.book_id,
                kind="full",
                phase="extracting",
                total_chapters=self._total_chapters,
                chapters=chapter_states,
            )
            self.llm_control = LLMControl.from_settings(
                self.cfg, self.stop_flag, event_sink=self._push_progress
            )
            await self._persist_task()
            self._done_count = len(self._preloaded_results)
            self._chapter_errors = []
            self._retry_queue = asyncio.Queue()
            self._retry_queued.clear()
            self._retry_wakeup.clear()
            self._skip_failed.clear()
            self._extraction_open = True
            self.finished = False
            self.final_result = None

        # ── 异步启动 _run（锁外，不阻塞 start 返回）──
        asyncio.create_task(self._run_guarded())

        logger.info(
            "Analysis started: book=%s chapters=%d to_chapter=%s",
            self.book_id,
            self._total_chapters,
            to_chapter,
        )

        return {
            "status": "analyzing",
            "mode": "few_long",
            "total_chapters": self._total_chapters,
            "task_id": self._task_snapshot.task_id if self._task_snapshot else "",
            "resumed": self._resume_from_snapshots,
            "reused_chapters": sorted(self._preloaded_results),
        }

    async def rerun_chapter(self, chapter_id: int) -> dict:
        """Safely rerun one chapter, rebuild dependencies, then reconcile the whole book.

        All data work happens in a same-volume staging clone. The live book only
        exposes an ``analyzing`` lifecycle status; chapter/cast/ledger/auto-patch data
        are published together after the staged pipeline reaches a coherent terminal
        state. Extraction or postprocess failure discards staging and preserves the
        previously published result.
        """
        async with _get_start_lock(self.book_id):
            live_meta = await asyncio.to_thread(
                self.filestore.read_meta, self.book_id
            )
            if live_meta.status in (BookStatus.ANALYZING, BookStatus.RECONCILING):
                raise analysis_already_running(self.book_id)
            previous_meta = live_meta.model_copy(deep=True)
            if not self.filestore.pre_reconcile_dir(self.book_id).exists():
                raise AppError(
                    ErrorCode.VALIDATION_ERROR,
                    "Safe chapter rerun requires a pre_reconcile baseline; run a full analysis first",
                    status_code=409,
                )

            # Publish a server task snapshot so refresh/stop work during this synchronous API call.
            self.stop_flag.clear()
            self._task_snapshot = AnalysisTaskSnapshot(
                task_id=str(uuid4()),
                book_id=self.book_id,
                kind="rerun",
                phase="rerun_prepare",
                total_chapters=1,
                chapters=[ChapterTaskState(chapter_id=chapter_id)],
            )
            self.llm_control = LLMControl.from_settings(
                self.cfg, self.stop_flag, event_sink=self._push_progress
            )
            self.finished = False
            self.final_result = None
            _orchestrators[self.book_id] = self
            live_meta.status = BookStatus.ANALYZING
            live_meta.analysis_progress.reconcile_done = False
            await asyncio.to_thread(
                self.filestore.write_meta, self.book_id, live_meta
            )
            await self._persist_task()

            staged: Filestore | None = None
            txn_root = None
            txn_id = ""
            published = False
            result: AgentResult | None = None
            try:
                staged, txn_root, txn_id = await asyncio.to_thread(
                    create_staging_filestore, self.filestore, self.book_id
                )
                await self._set_phase("rerun_prepare", chapter_id=chapter_id)

                # Remove prior auto-reconcile effects from the staging working state.
                await asyncio.to_thread(
                    staged.restore_pre_reconcile_state, self.book_id
                )
                reservation_cast = await asyncio.to_thread(
                    staged.read_cast, self.book_id
                )
                await asyncio.to_thread(apply_human_edits, staged, self.book_id)
                cast_snapshot = await asyncio.to_thread(staged.read_cast, self.book_id)
                valid_before = sorted(set(previous_meta.analysis_progress.chapters_done))
                old_relations = await asyncio.to_thread(
                    capture_relations_by_id, staged, self.book_id, valid_before
                )

                await self._set_chapter_state(
                    chapter_id, "running", increment_attempt=True
                )
                await self._set_phase("rerun_extracting", chapter_id=chapter_id)
                result = await run_chapter_agent(
                    self.book_id,
                    chapter_id,
                    cast_snapshot,
                    staged,
                    self.cfg,
                    self.stop_flag,
                    self.llm_control,
                )
                if self.stop_flag.is_set():
                    raise LLMStopped(
                        self.llm_control.stop_reason if self.llm_control else "rerun stopped"
                    )
                if not result.success or result.ledger is None:
                    raise RuntimeError(result.warning or "chapter extraction failed")

                await asyncio.to_thread(
                    staged.write_extraction_result,
                    self.book_id,
                    chapter_id,
                    result.ledger,
                    result.cast_buffer,
                )
                valid_chapters = sorted(set(valid_before + [chapter_id]))

                await self._set_phase("rerun_rebuild", chapter_id=chapter_id)
                await asyncio.to_thread(
                    rebuild_cast_from_extractions,
                    staged,
                    self.book_id,
                    valid_chapters,
                    raw_ledger_ids={chapter_id},
                    reservation_cast=reservation_cast,
                )

                await self._set_phase("relations_running", chapter_id=chapter_id)
                await enrich_ledger(
                    self.book_id,
                    result,
                    staged,
                    self.cfg,
                    control=self.llm_control,
                    stop_event=self.stop_flag,
                    progress=self._push_progress,
                )
                if self.stop_flag.is_set():
                    raise LLMStopped(
                        self.llm_control.stop_reason if self.llm_control else "rerun stopped"
                    )

                # Preserve manual remove intent when this chapter generated new relation ids.
                await asyncio.to_thread(
                    remap_manual_relation_removals,
                    staged,
                    self.book_id,
                    old_relations,
                    valid_chapters,
                )

                stage_meta = await asyncio.to_thread(staged.read_meta, self.book_id)
                done = set(stage_meta.analysis_progress.chapters_done)
                done.add(chapter_id)
                failed = set(stage_meta.analysis_progress.chapters_failed)
                failed.discard(chapter_id)
                pending = set(stage_meta.analysis_progress.chapters_pending)
                pending.discard(chapter_id)
                partial = set(stage_meta.analysis_progress.chapters_partial)
                partial.discard(chapter_id)
                if result.partial:
                    partial.add(chapter_id)
                stage_meta.analysis_progress.chapters_done = sorted(done)
                stage_meta.analysis_progress.chapters_failed = sorted(failed)
                stage_meta.analysis_progress.chapters_pending = sorted(pending)
                stage_meta.analysis_progress.chapters_partial = sorted(partial)
                stage_meta.analysis_progress.reconcile_done = False
                stage_meta.status = BookStatus.ANALYZING
                stage_meta.factions_stale = True
                await asyncio.to_thread(staged.write_meta, self.book_id, stage_meta)

                # New stable rollback point includes the rerun chapter and replayed human edits.
                await asyncio.to_thread(
                    staged.save_pre_reconcile_state,
                    self.book_id,
                    stage_meta.analysis_progress.chapters_done,
                )
                reconcile_outcome = await reconcile_book(
                    stage_meta,
                    staged,
                    self.cfg,
                    stop_event=self.stop_flag,
                    control=self.llm_control,
                    progress=self._push_progress,
                )
                stage_meta = await asyncio.to_thread(staged.read_meta, self.book_id)
                if (
                    stage_meta.status == BookStatus.ANALYZED
                    and (
                        stage_meta.analysis_progress.chapters_partial
                        or stage_meta.analysis_progress.chapters_failed
                    )
                ):
                    stage_meta.status = BookStatus.PARTIAL
                stage_meta.factions_stale = True
                await asyncio.to_thread(staged.write_meta, self.book_id, stage_meta)

                faction_count = 0
                if self.cfg.auto_extract_factions and not self.stop_flag.is_set():
                    await self._set_phase("factions_running")
                    faction_result = await extract_factions(
                        self.book_id,
                        staged,
                        self.cfg,
                        stop_event=self.stop_flag,
                        control=self.llm_control,
                        progress=self._push_progress,
                    )
                    if faction_result.success and faction_result.book is not None:
                        faction_count = len(faction_result.book.factions)
                    else:
                        stage_meta = await asyncio.to_thread(staged.read_meta, self.book_id)
                        stage_meta.factions_stale = True
                        await asyncio.to_thread(staged.write_meta, self.book_id, stage_meta)

                if self.stop_flag.is_set():
                    raise LLMStopped(
                        self.llm_control.stop_reason if self.llm_control else "rerun stopped"
                    )

                await self._set_phase("rerun_publish", chapter_id=chapter_id)
                await asyncio.to_thread(
                    publish_staging_book,
                    self.filestore,
                    staged,
                    self.book_id,
                    txn_id=txn_id,
                )
                published = True
                final_meta = await asyncio.to_thread(
                    self.filestore.read_meta, self.book_id
                )
                await self._set_chapter_state(
                    chapter_id, "partial" if result.partial else "done"
                )
                payload = {
                    "status": final_meta.status.value,
                    "phase": final_meta.status.value,
                    "chapter_id": chapter_id,
                    "success": True,
                    "partial": result.partial,
                    "steps_used": result.steps_used,
                    "reconcile_done": final_meta.analysis_progress.reconcile_done,
                    "reconcile_degraded": reconcile_outcome.degraded,
                    "reconcile_warning": reconcile_outcome.warning,
                    "factions": faction_count,
                    "factions_stale": final_meta.factions_stale,
                    "warnings": result.ledger.warnings if result.ledger else [],
                }
                await self._emit("done", payload)
                await self._finish_task(payload)
                self.finished = True
                self.final_result = payload
                logger.info(
                    "Chapter rerun published: book=%s ch=%d status=%s reconcile_done=%s",
                    self.book_id,
                    chapter_id,
                    final_meta.status.value,
                    final_meta.analysis_progress.reconcile_done,
                )
                return payload
            except Exception as exc:
                logger.exception(
                    "Chapter rerun transaction failed: book=%s ch=%d", self.book_id, chapter_id
                )
                if txn_root is not None:
                    await asyncio.to_thread(discard_staging, txn_root)
                if not published:
                    await asyncio.to_thread(
                        self.filestore.write_meta,
                        self.book_id,
                        previous_meta,
                    )
                await self._set_chapter_state(chapter_id, "failed", error=str(exc)[:1000])
                payload = {
                    "status": previous_meta.status.value,
                    "phase": "rerun_failed",
                    "chapter_id": chapter_id,
                    "success": False,
                    "error": str(exc),
                }
                await self._emit("done", payload)
                await self._finish_task(payload)
                self.finished = True
                self.final_result = payload
                if isinstance(exc, AppError):
                    raise
                if isinstance(exc, LLMStopped):
                    raise AppError(
                        ErrorCode.LLM_PROVIDER_ERROR,
                        f"Chapter rerun stopped: {exc}",
                        status_code=409,
                    )
                raise AppError(
                    ErrorCode.LLM_PROVIDER_ERROR,
                    f"Chapter rerun failed without changing published results: {exc}",
                    status_code=502,
                ) from exc

    async def _run_guarded(self) -> None:
        """Never leave a task permanently analyzing if the background coroutine crashes."""
        try:
            await self._run()
        except Exception as exc:
            logger.exception("Unhandled analysis task failure: book=%s", self.book_id)
            try:
                meta = await asyncio.to_thread(self.filestore.read_meta, self.book_id)
                meta.status = BookStatus.FAILED
                meta.analysis_progress.reconcile_done = False
                await asyncio.to_thread(self.filestore.write_meta, self.book_id, meta)
                self._meta = meta
                done = list(meta.analysis_progress.chapters_done)
                failed = list(meta.analysis_progress.chapters_failed)
                payload = {
                    "status": BookStatus.FAILED.value,
                    "phase": "failed",
                    "chapters_done": len(done),
                    "chapters_failed": len(failed),
                    "chapters_done_ids": done,
                    "chapters_failed_ids": failed,
                    "stopped": self.stop_flag.is_set(),
                    "reconcile_done": False,
                    "errors": [{"chapter_id": 0, "error": str(exc)[:1000]}],
                    "total": self._total_chapters,
                }
                await self._emit("done", payload)
                await self._finish_task(payload)
                self.finished = True
                self.final_result = payload
            except Exception:
                logger.exception("Failed to persist terminal state after task crash")

    async def _run(self) -> None:
        """并行执行 Chapter Agent → barrier → CastWriter → 更新 meta。"""
        assert self._meta is not None  # start() sets this before launching _run
        sem = asyncio.Semaphore(self.cfg.max_parallel_chapters)
        results: Dict[int, AgentResult] = dict(self._preloaded_results)

        async def process_chapter(brief: ChapterBrief, *, retry: bool = False) -> None:
            """
            提取单章：运行 Chapter Agent、落盘抽取快照并推送逐章进度。

            成功/失败都只更新该章状态与计数；失败章留在结果中等待重试，不中断其他章。
            """
            # ── stop flag 检查 ──
            if self.stop_flag.is_set():
                logger.info("Chapter %d skipped (stop flag set)", brief.chapter_id)
                return

            async with sem:
                # 再次检查（可能在等 semaphore 时被 stop）
                if self.stop_flag.is_set():
                    logger.info("Chapter %d skipped (stop flag set after sem)", brief.chapter_id)
                    return

                try:
                    # ── 运行章 Agent 并落盘抽取结果 ──
                    await self._set_chapter_state(brief.chapter_id, "running", increment_attempt=True)
                    await self._push_progress({
                        "phase": "extracting",
                        "chapter_id": brief.chapter_id,
                        "total": self._total_chapters,
                        **self._chapter_counts(),
                    })
                    result = await run_chapter_agent(
                        self.book_id,
                        brief.chapter_id,
                        self._cast_snapshot,
                        self.filestore,
                        self.cfg,
                        self.stop_flag,
                        self.llm_control,
                    )
                    # 记录结果：成功章写抽取快照，首次执行才计入 done 计数
                    first_attempt = brief.chapter_id not in results
                    results[brief.chapter_id] = result
                    if result.success and result.ledger is not None:
                        await asyncio.to_thread(
                            self.filestore.write_extraction_result,
                            self.book_id, brief.chapter_id, result.ledger, result.cast_buffer,
                        )
                    if first_attempt:
                        self._done_count += 1
                    self._retry_queued.discard(brief.chapter_id)

                    # ── push SSE progress ──
                    event_data = {
                        "chapter_id": brief.chapter_id,
                        "done": self._done_count,
                        "total": self._total_chapters,
                        "status": ("partial" if result.partial else "done") if result.success else "failed",
                        "retry": retry,
                    }
                    if result.success:
                        self._chapter_errors = [
                            item for item in self._chapter_errors
                            if item.get("chapter_id") != brief.chapter_id
                        ]
                    if not result.success:
                        err = result.warning or "chapter agent failed without detail"
                        event_data["error"] = err
                        self._chapter_errors.append({
                            "chapter_id": brief.chapter_id,
                            "error": err,
                        })

                    await self._set_chapter_state(
                        brief.chapter_id,
                        ("partial" if result.partial else "done") if result.success else "failed",
                        error=event_data.get("error", ""),
                    )
                    event_data.update(self._chapter_counts())
                    await self._emit("progress", event_data)

                    logger.info(
                        "Chapter %d done: success=%s steps=%d",
                        brief.chapter_id,
                        result.success,
                        result.steps_used,
                    )

                except Exception as e:
                    # 异常兜底：记为失败章，保持计数与状态一致并推送失败进度
                    first_attempt = brief.chapter_id not in results
                    if first_attempt:
                        self._done_count += 1
                    self._retry_queued.discard(brief.chapter_id)
                    err_msg = str(e)
                    logger.error(
                        "Chapter %d failed with exception: %s", brief.chapter_id, e
                    )
                    results[brief.chapter_id] = AgentResult(
                        chapter_id=brief.chapter_id,
                        success=False,
                        warning=err_msg,
                    )
                    self._chapter_errors.append({
                        "chapter_id": brief.chapter_id,
                        "error": err_msg,
                    })
                    await self._set_chapter_state(brief.chapter_id, "failed", error=err_msg)
                    await self._push_progress({
                        "chapter_id": brief.chapter_id,
                        "done": self._done_count,
                        "total": self._total_chapters,
                        "status": "failed",
                        "error": err_msg,
                        **self._chapter_counts(),
                    })

        # ── 并行启动所有章 ──
        tasks = [
            process_chapter(b) for b in self._chapter_queue
            if b.chapter_id not in self._preloaded_results
        ]
        await asyncio.gather(*tasks, return_exceptions=True)

        # Failed chapters stay inside this task. Successful chapters are kept and
        # never re-extracted; the task waits for retry or an explicit skip.
        brief_by_id = {b.chapter_id: b for b in self._chapter_queue}
        while not self.stop_flag.is_set():
            failed_ids = sorted(cid for cid, result in results.items() if not result.success)
            if not failed_ids:
                break
            self._retry_wakeup.clear()
            await self._set_phase(
                "waiting_failed", failed_chapters=failed_ids,
                done=self._done_count, total=self._total_chapters,
            )
            if self._skip_failed.is_set():
                break
            # A retry request may arrive while the phase event is being persisted.
            # If the queue is already non-empty, do not clear/lose that wakeup.
            if self._retry_queue.empty():
                stop_wait = asyncio.create_task(self.stop_flag.wait())
                retry_wait = asyncio.create_task(self._retry_wakeup.wait())
                done_wait, pending_wait = await asyncio.wait(
                    {stop_wait, retry_wait}, return_when=asyncio.FIRST_COMPLETED
                )
                for wait_task in pending_wait:
                    wait_task.cancel()
            if self.stop_flag.is_set() or self._skip_failed.is_set():
                break
            retry_ids: list[int] = []
            while not self._retry_queue.empty():
                cid = self._retry_queue.get_nowait()
                if cid in failed_ids and cid not in retry_ids:
                    retry_ids.append(cid)
            if not retry_ids:
                continue
            await self._set_phase("retrying_failed", retry_chapters=retry_ids)
            await asyncio.gather(
                *(process_chapter(brief_by_id[cid], retry=True) for cid in retry_ids),
                return_exceptions=True,
            )

        self._extraction_open = False

        # ── barrier 后: CastWriter 顺序 apply ──
        successful_results = {
            cid: r for cid, r in results.items() if r.success and r.ledger is not None
        }

        was_stopped = self.stop_flag.is_set()

        if successful_results:
            if self._resume_from_snapshots:
                await self._set_phase(
                    "rebuilding_after_resume",
                    reused_chapters=sorted(self._preloaded_results),
                )
                await asyncio.to_thread(
                    rebuild_cast_from_extractions,
                    self.filestore,
                    self.book_id,
                    sorted(successful_results),
                    raw_ledger_ids=set(successful_results),
                    reservation_cast=self._resume_reservation_cast,
                )
                # Refresh result ledgers because CastWriter rewrites temp ids on disk.
                for cid, result in successful_results.items():
                    result.ledger = await asyncio.to_thread(
                        self.filestore.read_ledger, self.book_id, cid
                    )
            else:
                cast_writer = CastWriter(self.book_id, self.filestore)
                for cid in sorted(successful_results.keys()):
                    cast_writer.apply(cid, successful_results[cid].cast_buffer)
                await asyncio.to_thread(cast_writer.finalize)
            await self._set_phase("relations_running")
            try:
                failures = await enrich_ledgers(
                    self.book_id, successful_results, self.filestore, self.cfg,
                    control=self.llm_control, stop_event=self.stop_flag,
                    progress=self._push_progress,
                )
            except Exception as exc:
                logger.exception("Book relation pipeline failed")
                failures = {cid: str(exc) for cid in successful_results}
            for cid, error in failures.items():
                logger.error("Relation pipeline failed: chapter=%s err=%s", cid, error)
                results[cid].success = False
                results[cid].warning = f"关系处理失败: {error}"
                self._chapter_errors.append({"chapter_id": cid, "error": results[cid].warning})
                successful_results.pop(cid, None)

        was_stopped = self.stop_flag.is_set()

        # ── 更新 meta status ──
        chapters_done = sorted(successful_results.keys())
        chapters_failed = sorted(
            cid for cid, r in results.items() if not r.success
        )

        # #2: 被停掉时，未启动的章不假装跑完
        all_chapter_ids = {b.chapter_id for b in self._chapter_queue}
        processed_ids = set(results.keys())
        skipped_ids = sorted(all_chapter_ids - processed_ids)

        # skipped 章也记入 failed（明确标注未跑）
        chapters_failed = sorted(set(chapters_failed + skipped_ids))

        # ── 确定 chapters_done / chapters_failed ──
        self._meta.analysis_progress.chapters_done = chapters_done
        self._meta.analysis_progress.chapters_failed = chapters_failed
        self._meta.analysis_progress.chapters_partial = sorted(
            cid for cid, r in successful_results.items() if r.partial
        )
        self._meta.analysis_progress.chapters_pending = []

        if was_stopped:
            # 被中断 → failed，不管是否有部分成功
            self._meta.status = BookStatus.FAILED
            self._meta.analysis_progress.chapters_pending = skipped_ids
            await asyncio.to_thread(self.filestore.write_meta, self.book_id, self._meta)
            await self._push_done(chapters_done, chapters_failed, was_stopped)
            return

        if not chapters_done:
            self._meta.status = BookStatus.FAILED
            await asyncio.to_thread(self.filestore.write_meta, self.book_id, self._meta)
            await self._push_done(chapters_done, chapters_failed, was_stopped)
            return

        self._meta.factions_stale = True
        await asyncio.to_thread(self.filestore.write_meta, self.book_id, self._meta)

        # Stable postprocessed baseline before any automatic reconcile mutation.
        # Reruns restore/rebuild from this checkpoint instead of stacking auto patches.
        await asyncio.to_thread(
            self.filestore.save_pre_reconcile_state, self.book_id, chapters_done
        )

        # ── Reconcile 流程：full analysis / chapter rerun 共用同一服务 ──
        reconcile_outcome = await reconcile_book(
            self._meta,
            self.filestore,
            self.cfg,
            stop_event=self.stop_flag,
            control=self.llm_control,
            progress=self._push_progress,
        )
        self._meta = await asyncio.to_thread(
            self.filestore.read_meta, self.book_id
        )
        reconcile_degraded = reconcile_outcome.degraded

        if self._meta.status == BookStatus.ANALYZED and (
            self._meta.analysis_progress.chapters_partial or chapters_failed
        ):
            self._meta.status = BookStatus.PARTIAL
        await asyncio.to_thread(self.filestore.write_meta, self.book_id, self._meta)

        # ── 势力归纳（PRD §5.7.5 大图默认骨架）──
        # 加性步骤：失败只是没有势力块，不影响 analysis status
        faction_count = 0
        if (
            self.cfg.auto_extract_factions
            and chapters_done
            and not self.stop_flag.is_set()
        ):
            try:
                await self._set_phase("factions_running")
                faction_result = await extract_factions(
                    self.book_id, self.filestore, self.cfg,
                    stop_event=self.stop_flag, control=self.llm_control,
                    progress=self._push_progress,
                )
                if faction_result.success and faction_result.book is not None:
                    faction_count = len(faction_result.book.factions)
                else:
                    logger.warning(
                        "Faction extraction failed: %s", faction_result.warning
                    )
            except Exception as e:
                logger.error("Faction extraction exception: %s", e)

        # ── push done event ──
        done_data = self._build_done_payload(
            chapters_done=chapters_done,
            chapters_failed=chapters_failed,
            was_stopped=was_stopped,
            phase=self._meta.status.value,
            degraded=reconcile_degraded or self._meta.status == BookStatus.PARTIAL,
        )
        done_data["factions"] = faction_count
        final_meta = await asyncio.to_thread(self.filestore.read_meta, self.book_id)
        self._meta = final_meta
        done_data["factions_stale"] = final_meta.factions_stale

        await self._emit("done", done_data)
        await self._finish_task(done_data)

        # #1: 标记完成 + 存结果摘要
        self.finished = True
        self.final_result = done_data

        logger.info(
            "Analysis complete: book=%s done=%d failed=%d skipped=%d stopped=%s reconcile_done=%s",
            self.book_id,
            len(chapters_done),
            len(chapters_failed),
            len(skipped_ids),
            was_stopped,
            self._meta.analysis_progress.reconcile_done,
        )

    def _build_done_payload(
        self,
        *,
        chapters_done: list[int],
        chapters_failed: list[int],
        was_stopped: bool,
        phase: str,
        degraded: bool = False,
    ) -> dict:
        """组装 SSE done 事件，含失败明细与最终 status。"""
        status = self._meta.status.value if self._meta else "failed"
        payload: dict[str, Any] = {
            "chapters_done": len(chapters_done),
            "chapters_failed": len(chapters_failed),
            "chapters_done_ids": list(chapters_done),
            "chapters_failed_ids": list(chapters_failed),
            "chapters_partial_ids": list(self._meta.analysis_progress.chapters_partial) if self._meta else [],
            "stopped": was_stopped,
            "reconcile_done": (
                self._meta.analysis_progress.reconcile_done if self._meta else False
            ),
            "phase": phase,
            "status": status,
            "errors": list(self._chapter_errors),
            "total": self._total_chapters,
        }
        if degraded:
            payload["degraded"] = True
        if phase == "failed" and not payload["errors"] and chapters_failed:
            payload["errors"] = [
                {"chapter_id": cid, "error": "chapter analysis failed (no detail)"}
                for cid in chapters_failed
            ]
        return payload

    async def _push_done(
        self,
        chapters_done: list[int],
        chapters_failed: list[int],
        was_stopped: bool,
    ) -> None:
        """推送 done 事件（用于提早退出的路径：章阶段 stop / 零章成功）。"""
        done_data = self._build_done_payload(
            chapters_done=chapters_done,
            chapters_failed=chapters_failed,
            was_stopped=was_stopped,
            phase="failed",
        )
        await self._emit("done", done_data)
        await self._finish_task(done_data)
        self.finished = True
        self.final_result = done_data


async def recover_interrupted_tasks(filestore: Filestore) -> int:
    """Mark tasks left active across a backend restart as interrupted/recoverable."""
    recovered = 0
    books = await asyncio.to_thread(filestore.list_books)
    for meta in books:
        if meta.status not in (BookStatus.ANALYZING, BookStatus.RECONCILING):
            continue
        running = get_orchestrator(meta.book_id)
        if (
            running is not None
            and not running.finished
            and (running._task_snapshot is None or running._task_snapshot.active)
        ):
            continue
        task = await asyncio.to_thread(filestore.read_analysis_task, meta.book_id)
        done_ids: list[int] = []
        failed_ids: list[int] = []
        pending_ids: list[int] = []
        partial_ids: list[int] = []
        if task is not None:
            for ch in task.chapters:
                if ch.status == "done": done_ids.append(ch.chapter_id)
                elif ch.status == "partial":
                    done_ids.append(ch.chapter_id); partial_ids.append(ch.chapter_id)
                elif ch.status == "failed": failed_ids.append(ch.chapter_id)
                else: pending_ids.append(ch.chapter_id)
            task.active = False
            task.status = "interrupted"
            task.phase = "interrupted"
            task.stop_reason = task.stop_reason or "backend restarted while task was active"
            task.finished_at = datetime.now()
            task.updated_at = datetime.now()
            task.result = {
                "status": "interrupted", "phase": "interrupted",
                "chapters_done_ids": sorted(done_ids),
                "chapters_failed_ids": sorted(failed_ids),
                "chapters_pending_ids": sorted(pending_ids),
            }
            await asyncio.to_thread(filestore.write_analysis_task, meta.book_id, task)
        else:
            pending_ids = list(meta.analysis_progress.chapters_pending)
            done_ids = list(meta.analysis_progress.chapters_done)
            failed_ids = list(meta.analysis_progress.chapters_failed)
            partial_ids = list(meta.analysis_progress.chapters_partial)
        meta.analysis_progress.chapters_done = sorted(set(done_ids))
        meta.analysis_progress.chapters_failed = sorted(set(failed_ids))
        meta.analysis_progress.chapters_pending = sorted(set(pending_ids))
        meta.analysis_progress.chapters_partial = sorted(set(partial_ids))
        meta.analysis_progress.reconcile_done = False
        meta.status = BookStatus.PARTIAL if done_ids else BookStatus.FAILED
        await asyncio.to_thread(filestore.write_meta, meta.book_id, meta)
        recovered += 1
        logger.warning("Recovered interrupted task: book=%s done=%d pending=%d", meta.book_id, len(done_ids), len(pending_ids))
    return recovered
