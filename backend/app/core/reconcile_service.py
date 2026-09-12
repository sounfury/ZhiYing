"""Shared whole-book reconciliation service used by full analysis and chapter reruns."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

from app.agent.llm import LLMControl
from app.agent.reconcile_agent import run_reconcile_agent
from app.config import Settings
from app.core.patch_applier import PatchApplier
from app.core.suspects import SuspectsGenerator
from app.logging_config import get_logger
from app.models.book import BookMeta, BookStatus
from app.storage.filestore import Filestore

logger = get_logger("core.reconcile_service")
ProgressSink = Callable[[dict[str, Any]], Awaitable[None]]


@dataclass
class ReconcileOutcome:
    status: BookStatus
    reconcile_done: bool
    degraded: bool = False
    warning: str = ""


async def reconcile_book(
    meta: BookMeta,
    filestore: Filestore,
    cfg: Settings,
    *,
    stop_event: Optional[asyncio.Event] = None,
    control: Optional[LLMControl] = None,
    progress: Optional[ProgressSink] = None,
) -> ReconcileOutcome:
    """Reconcile all valid chapters, rolling back any partially applied auto patch."""
    chapter_ids = list(meta.analysis_progress.chapters_done)
    # Old automatic relation patches are never inherited into a new generation.
    await asyncio.to_thread(
        filestore.write_reconcile_overrides, meta.book_id, {"add": [], "remove": []}
    )
    if stop_event is not None and stop_event.is_set():
        meta.status = BookStatus.RECONCILE_FAILED
        meta.analysis_progress.reconcile_done = False
        await asyncio.to_thread(filestore.write_meta, meta.book_id, meta)
        return ReconcileOutcome(meta.status, False, True, "stopped before reconcile")

    cast = await asyncio.to_thread(filestore.read_cast, meta.book_id)
    ledgers = await asyncio.to_thread(filestore.read_ledgers, meta.book_id, chapter_ids)
    suspects = SuspectsGenerator().generate(cast, ledgers)
    if progress is not None:
        await progress({
            "phase": "reconcile_prepare",
            "suspects": (
                len(suspects.cast_conflicts)
                + len(suspects.relation_conflicts)
                + len(suspects.missing_evidence)
            ),
            "chapters": len(ledgers),
        })

    if suspects.is_empty and not cfg.force_reconcile:
        meta.status = BookStatus.ANALYZED
        meta.analysis_progress.reconcile_done = True
        await asyncio.to_thread(filestore.write_meta, meta.book_id, meta)
        return ReconcileOutcome(meta.status, True)

    meta.status = BookStatus.RECONCILING
    meta.analysis_progress.reconcile_done = False
    await asyncio.to_thread(filestore.write_meta, meta.book_id, meta)
    if progress is not None:
        await progress({"phase": "reconcile_running"})

    try:
        chapter_summaries = {ledger.chapter_id: ledger.summary for ledger in ledgers}
        result = await run_reconcile_agent(
            meta,
            cast,
            suspects,
            chapter_summaries,
            filestore,
            cfg,
            stop_event=stop_event,
            control=control,
            progress=progress,
        )
        if stop_event is not None and stop_event.is_set():
            meta.status = BookStatus.RECONCILE_FAILED
            meta.analysis_progress.reconcile_done = False
            await asyncio.to_thread(filestore.write_meta, meta.book_id, meta)
            return ReconcileOutcome(meta.status, False, True, "stopped during reconcile")
        if not result.success or result.patch is None:
            meta.status = BookStatus.RECONCILE_FAILED
            meta.analysis_progress.reconcile_done = False
            await asyncio.to_thread(filestore.write_meta, meta.book_id, meta)
            return ReconcileOutcome(
                meta.status, False, True, result.warning or "reconcile agent did not submit"
            )

        if progress is not None:
            await progress({"phase": "reconcile_applying_patch"})
        apply_result = await asyncio.to_thread(
            PatchApplier(meta.book_id, filestore).apply, result.patch
        )
        if apply_result.errors:
            # Auto merges/aliases rewrite shared data. On any apply error, restore the
            # published pre-reconcile checkpoint so no half-applied state escapes.
            await asyncio.to_thread(filestore.restore_pre_reconcile_state, meta.book_id)
            await asyncio.to_thread(
                filestore.write_reconcile_overrides,
                meta.book_id,
                {"add": [], "remove": []},
            )
            meta = await asyncio.to_thread(filestore.read_meta, meta.book_id)
            meta.status = BookStatus.RECONCILE_FAILED
            meta.analysis_progress.reconcile_done = False
            await asyncio.to_thread(filestore.write_meta, meta.book_id, meta)
            return ReconcileOutcome(
                meta.status, False, True, "; ".join(apply_result.errors)
            )

        meta.status = BookStatus.ANALYZED
        meta.analysis_progress.reconcile_done = True
        await asyncio.to_thread(filestore.write_meta, meta.book_id, meta)
        return ReconcileOutcome(meta.status, True)
    except Exception as exc:
        logger.exception("Reconcile phase failed: book=%s", meta.book_id)
        # Restoring the pre-reconcile checkpoint is safe even when the agent failed
        # before applying anything, and closes the harder case where PatchApplier
        # raised after mutating cast/ledgers.
        try:
            await asyncio.to_thread(filestore.restore_pre_reconcile_state, meta.book_id)
            await asyncio.to_thread(
                filestore.write_reconcile_overrides, meta.book_id, {"add": [], "remove": []}
            )
        except Exception:
            logger.exception("Failed to restore pre-reconcile baseline")
        current = await asyncio.to_thread(filestore.read_meta, meta.book_id)
        current.status = BookStatus.RECONCILE_FAILED
        current.analysis_progress.reconcile_done = False
        await asyncio.to_thread(filestore.write_meta, meta.book_id, current)
        return ReconcileOutcome(current.status, False, True, str(exc))
