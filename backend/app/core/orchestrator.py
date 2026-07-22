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
from typing import Any, Dict, List, Optional

from app.agent.cast_writer import CastWriter
from app.agent.chapter_agent import AgentResult, run_chapter_agent
from app.agent.reconcile_agent import run_reconcile_agent
from app.config import Settings, settings
from app.core.patch_applier import PatchApplier
from app.core.suspects import SuspectsGenerator
from app.errors import analysis_already_running
from app.logging_config import get_logger
from app.models.book import (
    AnalysisMode,
    BookMeta,
    BookStatus,
    ChapterBrief,
)
from app.models.cast import Cast
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
        self.book_id = book_id
        self.filestore = filestore
        self.cfg = cfg or settings

        # 并发控制
        self.stop_flag: asyncio.Event = asyncio.Event()
        self.progress_queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue()

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

            # ── 冻结 cast 快照 ──
            self._cast_snapshot = await asyncio.to_thread(
                self.filestore.read_cast, self.book_id
            )

            # ── 设 status=analyzing ──
            self._meta.status = BookStatus.ANALYZING
            self._meta.analysis_progress.mode = AnalysisMode.FEW_LONG
            self._meta.analysis_progress.chapters_done = []
            self._meta.analysis_progress.chapters_failed = []
            self._meta.analysis_progress.chapters_pending = [
                b.chapter_id for b in self._chapter_queue
            ]
            self._meta.analysis_progress.reconcile_done = False
            await asyncio.to_thread(self.filestore.write_meta, self.book_id, self._meta)

            # ── 注册 + 重置 ──
            _orchestrators[self.book_id] = self
            self.stop_flag.clear()
            self._done_count = 0
            self._chapter_errors = []
            self.finished = False
            self.final_result = None

        # ── 异步启动 _run（锁外，不阻塞 start 返回）──
        asyncio.create_task(self._run())

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
        }

    async def _run(self) -> None:
        """并行执行 Chapter Agent → barrier → CastWriter → 更新 meta。"""
        assert self._meta is not None  # start() sets this before launching _run
        sem = asyncio.Semaphore(self.cfg.max_parallel_chapters)
        results: Dict[int, AgentResult] = {}

        async def process_chapter(brief: ChapterBrief) -> None:
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
                    result = await run_chapter_agent(
                        self.book_id,
                        brief.chapter_id,
                        self._cast_snapshot,
                        self.filestore,
                        self.cfg,
                    )
                    results[brief.chapter_id] = result
                    self._done_count += 1

                    # ── push SSE progress ──
                    event_data = {
                        "chapter_id": brief.chapter_id,
                        "done": self._done_count,
                        "total": self._total_chapters,
                        "status": "done" if result.success else "failed",
                    }
                    if not result.success:
                        err = result.warning or "chapter agent failed without detail"
                        event_data["error"] = err
                        self._chapter_errors.append({
                            "chapter_id": brief.chapter_id,
                            "error": err,
                        })

                    await self.progress_queue.put({
                        "type": "progress",
                        "data": event_data,
                    })

                    logger.info(
                        "Chapter %d done: success=%s steps=%d",
                        brief.chapter_id,
                        result.success,
                        result.steps_used,
                    )

                except Exception as e:
                    self._done_count += 1
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
                    await self.progress_queue.put({
                        "type": "progress",
                        "data": {
                            "chapter_id": brief.chapter_id,
                            "done": self._done_count,
                            "total": self._total_chapters,
                            "status": "failed",
                            "error": err_msg,
                        },
                    })

        # ── 并行启动所有章 ──
        tasks = [process_chapter(b) for b in self._chapter_queue]
        await asyncio.gather(*tasks, return_exceptions=True)

        # ── barrier 后: CastWriter 顺序 apply ──
        successful_results = {
            cid: r for cid, r in results.items() if r.success and r.ledger is not None
        }

        was_stopped = self.stop_flag.is_set()

        if successful_results:
            cast_writer = CastWriter(self.book_id, self.filestore)
            for cid in sorted(successful_results.keys()):
                cast_writer.apply(cid, successful_results[cid].cast_buffer)
            await asyncio.to_thread(cast_writer.finalize)

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

        # ── Reconcile 流程 ──
        reconcile_failed = False
        reconcile_degraded = False

        if self.stop_flag.is_set():
            # reconcile 阶段前被 stop → RECONCILE_FAILED
            self._meta.status = BookStatus.RECONCILE_FAILED
            self._meta.analysis_progress.reconcile_done = False
            reconcile_failed = True
            reconcile_degraded = True
        else:
            try:
                # ── 生成可疑清单 ──
                cast = await asyncio.to_thread(self.filestore.read_cast, self.book_id)
                ledgers = await asyncio.to_thread(
                    self.filestore.read_ledgers, self.book_id, chapters_done
                )
                suspects = SuspectsGenerator().generate(cast, ledgers)

                # ── 是否跳过 ──
                if suspects.is_empty and not self.cfg.force_reconcile:
                    logger.info("No suspects found, skipping reconcile")
                    self._meta.status = BookStatus.ANALYZED
                    self._meta.analysis_progress.reconcile_done = True
                else:
                    # ── 状态 → RECONCILING ──
                    self._meta.status = BookStatus.RECONCILING
                    await asyncio.to_thread(self.filestore.write_meta, self.book_id, self._meta)
                    await self.progress_queue.put({
                        "type": "progress",
                        "data": {"phase": "reconcile_running"},
                    })

                    # ── 运行 ReconcileAgent ──
                    chapter_summaries = {l.chapter_id: l.summary for l in ledgers}
                    reconcile_result = await run_reconcile_agent(
                        self._meta, cast, suspects, chapter_summaries,
                        self.filestore, self.cfg,
                    )

                    if self.stop_flag.is_set():
                        self._meta.status = BookStatus.RECONCILE_FAILED
                        self._meta.analysis_progress.reconcile_done = False
                        reconcile_failed = True
                        reconcile_degraded = True
                    elif reconcile_result.success and reconcile_result.patch is not None:
                        # ── 应用 patch ──
                        applier = PatchApplier(self.book_id, self.filestore)
                        apply_result = await asyncio.to_thread(applier.apply, reconcile_result.patch)

                        if apply_result.errors:
                            # patch 部分应用异常 → 仍标为 RECONCILE_FAILED
                            logger.warning(
                                "Patch applied with %d errors: %s",
                                len(apply_result.errors),
                                apply_result.errors,
                            )
                            self._meta.status = BookStatus.RECONCILE_FAILED
                            self._meta.analysis_progress.reconcile_done = False
                            reconcile_failed = True
                            reconcile_degraded = True
                        else:
                            self._meta.status = BookStatus.ANALYZED
                            self._meta.analysis_progress.reconcile_done = True
                    else:
                        # Agent 未提交或超时
                        self._meta.status = BookStatus.RECONCILE_FAILED
                        self._meta.analysis_progress.reconcile_done = False
                        reconcile_failed = True
                        reconcile_degraded = True
                        logger.warning("Reconcile failed: %s", reconcile_result.warning)

            except Exception as e:
                logger.error("Reconcile phase exception: %s", e)
                self._meta.status = BookStatus.RECONCILE_FAILED
                self._meta.analysis_progress.reconcile_done = False
                reconcile_failed = True
                reconcile_degraded = True

        await asyncio.to_thread(self.filestore.write_meta, self.book_id, self._meta)

        # ── push done event ──
        done_data = self._build_done_payload(
            chapters_done=chapters_done,
            chapters_failed=chapters_failed,
            was_stopped=was_stopped,
            phase="reconcile_failed" if reconcile_degraded else "analyzed",
            degraded=reconcile_degraded,
        )

        await self.progress_queue.put({
            "type": "done",
            "data": done_data,
        })

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
        await self.progress_queue.put({
            "type": "done",
            "data": done_data,
        })
        self.finished = True
        self.final_result = done_data
