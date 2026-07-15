"""
Orchestrator -- few_long 模式薄编排。

流程：
  1. start(to_chapter): 校验 → 过滤章队列 → 冻结 cast → status=analyzing → 异步 _run()
  2. _run(): Semaphore 并行 run_chapter_agent → 逐章 push SSE progress → barrier
  3. barrier 后: CastWriter 顺序 apply → finalize → 更新 meta status

D7: SSE 逐章推送
D8: to_chapter 简单截断
D9: 防重入 + 粗糙 stop flag
"""
from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional

from app.agent.cast_writer import CastWriter
from app.agent.chapter_agent import AgentResult, run_chapter_agent
from app.config import Settings, settings
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
            if self._meta.status == BookStatus.ANALYZING:
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
                    if not result.success and result.warning:
                        event_data["error"] = result.warning

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
                    logger.error(
                        "Chapter %d failed with exception: %s", brief.chapter_id, e
                    )
                    results[brief.chapter_id] = AgentResult(
                        chapter_id=brief.chapter_id,
                        success=False,
                        warning=str(e),
                    )
                    await self.progress_queue.put({
                        "type": "progress",
                        "data": {
                            "chapter_id": brief.chapter_id,
                            "done": self._done_count,
                            "total": self._total_chapters,
                            "status": "failed",
                            "error": str(e),
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

        if was_stopped:
            # 被中断 → failed，不管是否有部分成功
            self._meta.status = BookStatus.FAILED
            # 保留未跑的章在 pending（不假装跑完）
            self._meta.analysis_progress.chapters_pending = skipped_ids
        elif not chapters_done:
            self._meta.status = BookStatus.FAILED
            self._meta.analysis_progress.chapters_pending = []
        else:
            self._meta.status = BookStatus.ANALYZED
            self._meta.analysis_progress.chapters_pending = []

        self._meta.analysis_progress.chapters_done = chapters_done
        self._meta.analysis_progress.chapters_failed = chapters_failed
        await asyncio.to_thread(self.filestore.write_meta, self.book_id, self._meta)

        # ── push done event ──
        done_data = {
            "chapters_done": len(chapters_done),
            "chapters_failed": len(chapters_failed),
            "stopped": was_stopped,
        }
        await self.progress_queue.put({
            "type": "done",
            "data": done_data,
        })

        # #1: 标记完成 + 存结果摘要（供后连的 SSE 客户端立即拿到 done）
        self.finished = True
        self.final_result = done_data

        logger.info(
            "Analysis complete: book=%s done=%d failed=%d skipped=%d stopped=%s",
            self.book_id,
            len(chapters_done),
            len(chapters_failed),
            len(skipped_ids),
            was_stopped,
        )
