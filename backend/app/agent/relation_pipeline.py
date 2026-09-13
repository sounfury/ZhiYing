"""Post-extraction relation pipeline with progress and task-scoped LLM control."""
from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any, Optional

from app.agent.llm import LLMControl
from app.agent.relation_normalizer import normalize_relations
from app.agent.relation_verifier import verify_relations

ProgressSink = Callable[[dict[str, Any]], Awaitable[None]]


async def enrich_relations(
    book_id,
    relations,
    chapter_id,
    filestore,
    cfg,
    control: Optional[LLMControl] = None,
    stop_event: Optional[asyncio.Event] = None,
    progress: Optional[ProgressSink] = None,
):
    """
    Postprocess one chapter's relations: normalize, then verify.

    Loads the registry, chapter content and cast, and reports progress tagged
    with the chapter id. Verification is skipped once a stop was requested.
    Persists the registry and returns collected warnings.
    """
    registry = filestore.read_relation_registry(book_id)
    content = filestore.read_chapter_content(book_id, chapter_id)
    cast = filestore.read_cast(book_id)
    names = {
        p.person_id: {"name": p.canonical_name, "aliases": [a.name for a in p.aliases]}
        for p in cast.persons
    }
    started = time.perf_counter()
    async def chapter_progress(data: dict[str, Any]) -> None:
        """Progress sink that tags events with this chapter's id."""
        if progress is not None:
            await progress({**data, "chapter_id": chapter_id})

    if progress is not None:
        await progress({"phase": "relation_normalize", "chapter_id": chapter_id, "processed": 0, "total": len(relations)})
    # Pass 1: semantic normalization (may mutate the shared registry).
    warnings = await normalize_relations(
        relations, registry, content, cfg, control=control, stop_event=stop_event, progress=chapter_progress
    )
    # Pass 2: evidence verification, skipped entirely once a stop was requested.
    if stop_event is None or not stop_event.is_set():
        warnings.extend(await verify_relations(
            relations, content, names, cfg, control=control, stop_event=stop_event, progress=chapter_progress
        ))
    # Persist registry mutations from normalization even when verification was skipped.
    filestore.write_relation_registry(book_id, registry)
    if progress is not None:
        # Chapter completion summary; "pending" = relations neither confirmed nor rejected.
        await progress({
            "phase": "relations_chapter_done",
            "chapter_id": chapter_id,
            "total": len(relations),
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
            "warnings": len(warnings),
            "pending": sum(1 for r in relations if r.status == "pending"),
        })
    return warnings


async def enrich_ledger(
    book_id,
    result,
    filestore,
    cfg,
    control: Optional[LLMControl] = None,
    stop_event: Optional[asyncio.Event] = None,
    progress: Optional[ProgressSink] = None,
):
    """
    Enrich one ledger's relations in place and persist the ledger.

    Warnings are merged deduplicated; any warning marks the ledger partial
    and flags the chapter result accordingly.
    """
    ledger = filestore.read_ledger(book_id, result.chapter_id)
    warnings = await enrich_relations(
        book_id,
        ledger.relations,
        ledger.chapter_id,
        filestore,
        cfg,
        control=control,
        stop_event=stop_event,
        progress=progress,
    )
    ledger.warnings.extend(w for w in warnings if w not in ledger.warnings)
    if warnings:
        ledger.analysis_status = "partial"
    result.ledger = ledger
    result.partial = ledger.analysis_status == "partial"
    filestore.write_ledger(book_id, ledger)


async def enrich_ledgers(
    book_id,
    results: dict[int, Any],
    filestore,
    cfg,
    control: Optional[LLMControl] = None,
    stop_event: Optional[asyncio.Event] = None,
    progress: Optional[ProgressSink] = None,
) -> dict[int, str]:
    """Book-level postprocess: sequential registry commit + globally bounded verification.

    Normalization shares one live registry snapshot so batches cannot overwrite one
    another. Verification is independent of the registry and is therefore scheduled
    across chapters with one semaphore, bounded by RELATION_VERIFY_CONCURRENCY.
    Ledgers are written only after their chapter's verification finishes.
    """
    cfg = cfg or __import__("app.config", fromlist=["settings"]).settings
    registry = filestore.read_relation_registry(book_id)
    cast = filestore.read_cast(book_id)
    names = {
        p.person_id: {"name": p.canonical_name, "aliases": [a.name for a in p.aliases]}
        for p in cast.persons
    }
    contexts: dict[int, tuple[Any, Any, str, list[str], float]] = {}
    failures: dict[int, str] = {}

    # Phase A: one writer owns the relation registry.
    for cid in sorted(results):
        if stop_event is not None and stop_event.is_set():
            break
        result = results[cid]
        started = time.perf_counter()
        try:
            ledger = filestore.read_ledger(book_id, cid)
            content = filestore.read_chapter_content(book_id, cid)
            if progress is not None:
                await progress({
                    "phase": "relation_normalize", "chapter_id": cid,
                    "processed": 0, "total": len(ledger.relations),
                })
            async def normalize_progress(data: dict[str, Any], chapter_id: int = cid) -> None:
                """Progress sink that tags normalization events with the chapter id."""
                if progress is not None:
                    await progress({**data, "chapter_id": chapter_id})
            warnings = await normalize_relations(
                ledger.relations, registry, content, cfg,
                control=control, stop_event=stop_event, progress=normalize_progress,
            )
            contexts[cid] = (result, ledger, content, warnings, started)
        except Exception as exc:
            failures[cid] = str(exc)

    # Commit registry once after all sequential normalization decisions.
    filestore.write_relation_registry(book_id, registry)

    # Phase B: evidence checks across chapters share one global concurrency limit.
    verify_sem = asyncio.Semaphore(max(1, cfg.relation_verify_concurrency))

    async def verify_one(cid: int) -> None:
        """Verify one chapter under the shared semaphore and persist its ledger."""
        result, ledger, content, warnings, started = contexts[cid]
        async def verify_progress(data: dict[str, Any]) -> None:
            """Progress sink that tags verification events with the chapter id."""
            if progress is not None:
                await progress({**data, "chapter_id": cid})
        # Skip verification entirely when a stop was already requested.
        if stop_event is None or not stop_event.is_set():
            try:
                warnings.extend(await verify_relations(
                    ledger.relations, content, names, cfg,
                    control=control, stop_event=stop_event, progress=verify_progress,
                    semaphore=verify_sem,
                ))
            except Exception as exc:
                failures[cid] = str(exc)
                return
        # Merge warnings and mark partial; persist the ledger either way.
        ledger.warnings.extend(w for w in warnings if w not in ledger.warnings)
        if warnings:
            ledger.analysis_status = "partial"
        result.ledger = ledger
        result.partial = ledger.analysis_status == "partial"
        filestore.write_ledger(book_id, ledger)
        if progress is not None:
            # Chapter completion summary for the book-level pipeline.
            await progress({
                "phase": "relations_chapter_done",
                "chapter_id": cid,
                "total": len(ledger.relations),
                "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
                "warnings": len(warnings),
                "pending": sum(1 for r in ledger.relations if r.status == "pending"),
            })

    await asyncio.gather(*(verify_one(cid) for cid in sorted(contexts)))
    return failures
