from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import shutil
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.agent.chapter_agent import AgentResult
from app.agent.llm import LLMControl
from app.agent.relation_pipeline import enrich_ledgers
from app.config import Settings
from app.core.rebuild import rebuild_cast_from_extractions
from app.core.reconcile_service import reconcile_book
from app.models.book import AnalysisMode, AnalysisProgress, BookStatus
from app.models.cast import Cast
from app.storage.filestore import Filestore

DEFAULT_FIXTURE = HERE / "fixtures" / "raw_legacy_v1"
DEFAULT_OUTPUT_BOOK_ID = "p0-siddhartha-postprocess-legacy-v1"
DEFAULT_METRICS = HERE / "reports" / "postprocess_legacy_v1_metrics.json"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _default_source_book_dir() -> Path:
    manifest = json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))
    return ROOT / "workspace" / manifest["book_id"]


def _load_fixture_manifest(fixture_dir: Path) -> dict[str, Any]:
    manifest_path = fixture_dir / "fixture_manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if int(manifest.get("fixture_version", 0)) != 1:
        raise ValueError(f"unsupported fixture version: {manifest.get('fixture_version')}")
    for name, expected in (manifest.get("files") or {}).items():
        path = fixture_dir / name
        if not path.exists():
            raise FileNotFoundError(path)
        actual = _sha256(path)
        if actual != expected:
            raise ValueError(f"fixture hash mismatch: {name}: {actual} != {expected}")
    aggregate = hashlib.sha256()
    for name, digest in sorted((manifest.get("files") or {}).items()):
        aggregate.update(f"{name}:{digest}\n".encode("utf-8"))
    if aggregate.hexdigest() != manifest.get("fixture_sha256"):
        raise ValueError("fixture aggregate hash mismatch")
    return manifest


def _prepare_workspace(
    source_book_dir: Path,
    fixture_dir: Path,
    output_book_id: str,
    *,
    reset: bool,
) -> tuple[Filestore, list[int], dict[str, Any]]:
    fixture = _load_fixture_manifest(fixture_dir)
    source_book_dir = source_book_dir.resolve()
    source_root = source_book_dir.parent
    source_book_id = source_book_dir.name
    source_fs = Filestore(source_root)
    source_meta = source_fs.read_meta(source_book_id)

    output_root = ROOT / "workspace"
    fs = Filestore(output_root)
    if output_book_id == source_book_id:
        raise ValueError("output book id must differ from source book id")
    if fs.book_dir(output_book_id).exists():
        if not reset:
            raise FileExistsError(f"output workspace exists: {fs.book_dir(output_book_id)}; pass --reset")
        fs.remove_book_dir(output_book_id)
    fs.create_book_dir(output_book_id)

    meta = source_meta.model_copy(deep=True)
    meta.book_id = output_book_id
    meta.source_file = f"P0 legacy postprocess from fixture {fixture.get('fixture_sha256', '')[:12]}"
    meta.status = BookStatus.ANALYZING
    meta.created_at = datetime.now()
    meta.analysis_progress = AnalysisProgress(mode=AnalysisMode.FEW_LONG)
    meta.factions_stale = False
    fs.write_meta(output_book_id, meta)
    fs.write_cast(output_book_id, Cast())

    for brief in source_fs.list_chapter_briefs(source_book_id):
        fs.write_chapter(output_book_id, source_fs.read_chapter(source_book_id, brief.chapter_id))

    chapter_ids = [int(cid) for cid in fixture["chapter_ids"]]
    for cid in chapter_ids:
        chapter = fs.read_chapter(output_book_id, cid)
        actual = hashlib.sha256(chapter.content.encode("utf-8")).hexdigest()
        expected = str(fixture["chapter_content_sha256"][str(cid)])
        if actual != expected:
            raise ValueError(f"chapter content hash mismatch for {cid}: {actual} != {expected}")

    extraction_dir = fs.extraction_dir(output_book_id)
    extraction_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(fixture_dir / "base_cast.json", extraction_dir / "base_cast.json")
    for cid in chapter_ids:
        name = f"chapter_{cid:03d}.json"
        shutil.copy2(fixture_dir / name, extraction_dir / name)

    return fs, sorted(chapter_ids), fixture


async def _run(args: argparse.Namespace) -> dict[str, Any]:
    source_book_dir = Path(args.source_book_dir).resolve()
    fixture_dir = Path(args.fixture_dir).resolve()
    metrics_out = Path(args.metrics_out).resolve()
    fs, chapter_ids, fixture = _prepare_workspace(
        source_book_dir,
        fixture_dir,
        args.output_book_id,
        reset=args.reset,
    )

    cfg_kwargs: dict[str, Any] = {
        "workspace_root": str(fs.root),
        "auto_extract_factions": False,
    }
    if args.analysis_max_llm_tokens is not None:
        cfg_kwargs["analysis_max_llm_tokens"] = args.analysis_max_llm_tokens
    cfg = Settings(**cfg_kwargs)
    if not cfg.llm_api_key:
        raise RuntimeError("LLM_API_KEY is not configured")

    stop_event = asyncio.Event()
    phase_stats: dict[str, dict[str, int]] = defaultdict(lambda: {
        "requests": 0,
        "errors": 0,
        "message_chars": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
    })
    normalize_candidates_by_chapter: dict[int, int] = {}
    verify_candidates_by_chapter: dict[int, int] = {}
    reconcile_suspects = 0

    async def sink(event: dict[str, Any]) -> None:
        phase = str(event.get("phase") or "unknown")
        stats = phase_stats[phase]
        kind = event.get("kind")
        if kind == "llm_request_start":
            stats["requests"] += 1
            stats["message_chars"] += int(event.get("request_message_chars") or 0)
        elif kind == "llm_request_error":
            stats["errors"] += 1
        elif kind == "llm_request_end":
            usage = event.get("usage") or {}
            stats["input_tokens"] += int(usage.get("input_tokens") or 0)
            stats["output_tokens"] += int(usage.get("output_tokens") or 0)
            stats["total_tokens"] += int(usage.get("total_tokens") or 0)

    control = LLMControl.from_settings(cfg, stop_event, event_sink=sink)

    async def progress(event: dict[str, Any]) -> None:
        nonlocal reconcile_suspects
        phase = str(event.get("phase") or "")
        chapter_id = event.get("chapter_id")
        if phase == "relation_normalize" and chapter_id is not None and "model_candidates" in event:
            cid = int(chapter_id)
            normalize_candidates_by_chapter[cid] = max(
                normalize_candidates_by_chapter.get(cid, 0), int(event.get("model_candidates") or 0)
            )
        elif phase == "relation_verify" and chapter_id is not None:
            cid = int(chapter_id)
            verify_candidates_by_chapter[cid] = max(
                verify_candidates_by_chapter.get(cid, 0), int(event.get("total") or 0)
            )
        elif phase == "reconcile_prepare":
            reconcile_suspects = int(event.get("suspects") or 0)

        if phase in {
            "relation_normalize",
            "relation_verify",
            "relations_chapter_done",
            "reconcile_prepare",
            "reconcile_running",
            "reconcile_applying_patch",
        }:
            detail = {
                key: event[key]
                for key in ("chapter_id", "batch", "batches", "processed", "total", "model_candidates", "suspects")
                if key in event
            }
            print(
                f"postprocess phase={phase} detail={detail} usage={control.snapshot()}",
                flush=True,
            )

    total_started = time.perf_counter()
    stage_seconds: dict[str, float] = {}

    rebuild_started = time.perf_counter()
    rebuild_cast_from_extractions(
        fs,
        args.output_book_id,
        chapter_ids,
        raw_ledger_ids=set(chapter_ids),
        reservation_cast=Cast(),
    )
    stage_seconds["rebuild"] = time.perf_counter() - rebuild_started

    results: dict[int, AgentResult] = {}
    for cid in chapter_ids:
        item = fs.read_extraction_result(args.output_book_id, cid)
        if item is None:
            raise FileNotFoundError(f"missing extraction snapshot for chapter {cid}")
        ledger = fs.read_ledger(args.output_book_id, cid)
        results[cid] = AgentResult(
            chapter_id=cid,
            ledger=ledger,
            cast_buffer=item["cast_buffer"],
            summary=ledger.summary,
            success=True,
            partial=ledger.analysis_status == "partial",
        )

    relation_started = time.perf_counter()
    failures = await enrich_ledgers(
        args.output_book_id,
        results,
        fs,
        cfg,
        control=control,
        stop_event=stop_event,
        progress=progress,
    )
    stage_seconds["relations"] = time.perf_counter() - relation_started
    if failures:
        raise RuntimeError(f"legacy relation pipeline failures: {failures}")
    if stop_event.is_set():
        raise RuntimeError(f"legacy relation pipeline stopped: {control.stop_reason}")

    meta = fs.read_meta(args.output_book_id)
    meta.analysis_progress.chapters_done = chapter_ids
    meta.analysis_progress.chapters_failed = []
    meta.analysis_progress.chapters_pending = []
    meta.analysis_progress.chapters_partial = sorted(
        cid for cid, result in results.items() if result.partial
    )
    meta.analysis_progress.reconcile_done = False
    meta.status = BookStatus.ANALYZING
    fs.write_meta(args.output_book_id, meta)
    fs.save_pre_reconcile_state(args.output_book_id, chapter_ids)

    reconcile_started = time.perf_counter()
    outcome = await reconcile_book(
        meta,
        fs,
        cfg,
        stop_event=stop_event,
        control=control,
        progress=progress,
    )
    stage_seconds["reconcile"] = time.perf_counter() - reconcile_started

    final_meta = fs.read_meta(args.output_book_id)
    ledgers = fs.read_ledgers(args.output_book_id, chapter_ids)
    registry = fs.read_relation_registry(args.output_book_id)
    relation_count = sum(len(ledger.relations) for ledger in ledgers)
    pending_count = sum(
        1 for ledger in ledgers for relation in ledger.relations if relation.status == "pending"
    )
    confirmed_count = sum(
        1 for ledger in ledgers for relation in ledger.relations if relation.status == "confirmed"
    )

    metrics = {
        "baseline_version": 1,
        "created_at": datetime.now().isoformat(),
        "pipeline": "legacy_postprocess",
        "fixture_sha256": fixture["fixture_sha256"],
        "fixture_name": fixture.get("name"),
        "output_book_id": args.output_book_id,
        "model": cfg.llm_model,
        "reconcile_model": cfg.reconcile_model,
        "analysis_max_llm_tokens": cfg.analysis_max_llm_tokens,
        "final_status": final_meta.status.value,
        "reconcile_done": final_meta.analysis_progress.reconcile_done,
        "reconcile_degraded": outcome.degraded,
        "reconcile_warning": outcome.warning,
        "chapter_ids": chapter_ids,
        "chapter_partial_ids": final_meta.analysis_progress.chapters_partial,
        "relation_count": relation_count,
        "confirmed_count": confirmed_count,
        "pending_count": pending_count,
        "registry_definition_count": len(registry.definitions),
        "case_counts": {
            "relation_normalize_model_candidates": sum(normalize_candidates_by_chapter.values()),
            "relation_verify_candidates": sum(verify_candidates_by_chapter.values()),
            "reconcile_suspects": reconcile_suspects,
        },
        "usage": control.snapshot(),
        "phase_stats": {k: dict(v) for k, v in sorted(phase_stats.items())},
        "stage_seconds": {k: round(v, 3) for k, v in stage_seconds.items()},
        "elapsed_seconds": round(time.perf_counter() - total_started, 3),
    }
    metrics_out.parent.mkdir(parents=True, exist_ok=True)
    metrics_out.write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")

    md = metrics_out.with_suffix(".md")
    phase_lines = []
    for phase, stats in sorted(metrics["phase_stats"].items()):
        phase_lines.append(
            f"| {phase} | {stats['requests']} | {stats['message_chars']} | {stats['input_tokens']} | "
            f"{stats['output_tokens']} | {stats['total_tokens']} | {stats['errors']} |"
        )
    md.write_text(
        "\n".join([
            "# Siddhartha Legacy Postprocess Baseline",
            "",
            f"- Fixture SHA-256: `{metrics['fixture_sha256']}`",
            f"- Model: `{metrics['model']}`",
            f"- Final status: `{metrics['final_status']}`",
            f"- Reconcile done: `{metrics['reconcile_done']}`",
            f"- Total requests: **{metrics['usage']['llm_requests']}**",
            f"- Message characters: **{metrics['usage']['message_chars']}**",
            f"- Input tokens: **{metrics['usage']['input_tokens']}**",
            f"- Output tokens: **{metrics['usage']['output_tokens']}**",
            f"- Total tokens: **{metrics['usage']['total_tokens']}**",
            f"- Wall time: **{metrics['elapsed_seconds']} s**",
            f"- Relations: **{relation_count}** (confirmed {confirmed_count}, pending {pending_count})",
            f"- Registry definitions: **{metrics['registry_definition_count']}**",
            f"- Normalize model candidates: **{metrics['case_counts']['relation_normalize_model_candidates']}**",
            f"- Verify candidates: **{metrics['case_counts']['relation_verify_candidates']}**",
            f"- Reconcile suspects: **{metrics['case_counts']['reconcile_suspects']}**",
            "",
            "| Phase | Requests | Message chars | Input tokens | Output tokens | Total tokens | Errors |",
            "|---|---:|---:|---:|---:|---:|---:|",
            *phase_lines,
            "",
            "## Stage timing",
            "",
            *(f"- {name}: {seconds} s" for name, seconds in metrics["stage_seconds"].items()),
            "",
        ]),
        encoding="utf-8",
    )
    return metrics


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Replay the legacy postprocess pipeline from the fixed Siddhartha raw fixture.")
    parser.add_argument("--source-book-dir", default=str(_default_source_book_dir()))
    parser.add_argument("--fixture-dir", default=str(DEFAULT_FIXTURE))
    parser.add_argument("--output-book-id", default=DEFAULT_OUTPUT_BOOK_ID)
    parser.add_argument("--metrics-out", default=str(DEFAULT_METRICS))
    parser.add_argument("--analysis-max-llm-tokens", type=int, default=None)
    parser.add_argument("--reset", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    result = asyncio.run(_run(parse_args()))
    print(json.dumps(result, ensure_ascii=False, indent=2))
