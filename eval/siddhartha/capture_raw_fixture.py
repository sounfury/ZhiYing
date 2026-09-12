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

from app.agent.chapter_agent import AgentResult, run_chapter_agent
from app.agent.llm import LLMControl
from app.config import Settings
from app.models.book import AnalysisProgress, BookStatus
from app.models.cast import Cast
from app.storage.filestore import Filestore

DEFAULT_FIXTURE = HERE / "fixtures" / "raw_legacy_v1"
DEFAULT_CAPTURE_BOOK_ID = "p0-siddhartha-raw-capture"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _default_source_book_dir() -> Path:
    manifest = json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))
    return ROOT / "workspace" / manifest["book_id"]


def _prepare_capture_book(
    source_book_dir: Path,
    capture_book_id: str,
    *,
    reset: bool,
    resume: bool,
) -> tuple[Filestore, str, list[int]]:
    source_book_dir = source_book_dir.resolve()
    source_root = source_book_dir.parent
    source_book_id = source_book_dir.name
    source_fs = Filestore(source_root)
    source_meta = source_fs.read_meta(source_book_id)
    source_chapters = [
        source_fs.read_chapter(source_book_id, brief.chapter_id)
        for brief in source_fs.list_chapter_briefs(source_book_id)
    ]
    chapter_ids = sorted(ch.chapter_id for ch in source_chapters if ch.include_in_analysis)

    capture_root = ROOT / "workspace"
    capture_fs = Filestore(capture_root)
    if capture_book_id == source_book_id:
        raise ValueError("capture book id must differ from source book id")
    capture_dir = capture_fs.book_dir(capture_book_id)
    if capture_dir.exists():
        if reset:
            capture_fs.remove_book_dir(capture_book_id)
        elif resume:
            for chapter in source_chapters:
                existing = capture_fs.read_chapter(capture_book_id, chapter.chapter_id)
                if hashlib.sha256(existing.content.encode("utf-8")).hexdigest() != hashlib.sha256(chapter.content.encode("utf-8")).hexdigest():
                    raise ValueError(f"capture/source chapter mismatch for {chapter.chapter_id}")
            if capture_fs.read_extraction_base_cast(capture_book_id) is None:
                raise FileNotFoundError("resume capture is missing extraction/base_cast.json")
            return capture_fs, source_book_id, chapter_ids
        else:
            raise FileExistsError(
                f"capture workspace already exists: {capture_dir}; pass --resume or --reset"
            )

    capture_fs.create_book_dir(capture_book_id)
    meta = source_meta.model_copy(deep=True)
    meta.book_id = capture_book_id
    meta.source_file = f"P0 raw capture from {source_book_id}"
    meta.status = BookStatus.UPLOADED
    meta.created_at = datetime.now()
    meta.analysis_progress = AnalysisProgress()
    meta.factions_stale = False
    capture_fs.write_meta(capture_book_id, meta)
    capture_fs.write_cast(capture_book_id, Cast())

    for chapter in source_chapters:
        capture_fs.write_chapter(capture_book_id, chapter)

    capture_fs.write_extraction_base_cast(capture_book_id, Cast())
    return capture_fs, source_book_id, chapter_ids


async def _capture(
    fs: Filestore,
    book_id: str,
    chapter_ids: list[int],
    cfg: Settings,
    *,
    max_attempts: int,
    only_chapters: set[int] | None = None,
) -> tuple[dict[int, AgentResult], dict[str, Any]]:
    stop_event = asyncio.Event()
    phase_stats: dict[str, dict[str, int]] = defaultdict(lambda: {
        "requests": 0,
        "errors": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
    })

    async def sink(event: dict[str, Any]) -> None:
        phase = str(event.get("phase") or "unknown")
        stats = phase_stats[phase]
        kind = event.get("kind")
        if kind == "llm_request_start":
            stats["requests"] += 1
        elif kind == "llm_request_error":
            stats["errors"] += 1
        elif kind == "llm_request_end":
            usage = event.get("usage") or {}
            stats["input_tokens"] += int(usage.get("input_tokens") or 0)
            stats["output_tokens"] += int(usage.get("output_tokens") or 0)
            stats["total_tokens"] += int(usage.get("total_tokens") or 0)

    control = LLMControl.from_settings(cfg, stop_event, event_sink=sink)
    base_cast = Cast()
    sem = asyncio.Semaphore(max(1, cfg.max_parallel_chapters))
    results: dict[int, AgentResult] = {}
    attempt_counts: dict[int, int] = {}
    started = time.perf_counter()

    async def run_one(chapter_id: int) -> None:
        async with sem:
            last: AgentResult | None = None
            for attempt in range(1, max_attempts + 1):
                attempt_counts[chapter_id] = attempt
                if stop_event.is_set():
                    break
                last = await run_chapter_agent(
                    book_id,
                    chapter_id,
                    base_cast,
                    fs,
                    cfg,
                    stop_event,
                    control,
                )
                if last.success and last.ledger is not None:
                    fs.write_extraction_result(book_id, chapter_id, last.ledger, last.cast_buffer)
                    results[chapter_id] = last
                    print(
                        f"chapter {chapter_id:03d}: success attempt={attempt} "
                        f"steps={last.steps_used} partial={last.partial}",
                        flush=True,
                    )
                    return
                print(
                    f"chapter {chapter_id:03d}: failed attempt={attempt} warning={last.warning[:240] if last else ''}",
                    flush=True,
                )
            if last is not None:
                results[chapter_id] = last

    requested = set(chapter_ids) if only_chapters is None else set(only_chapters)
    unknown = sorted(requested - set(chapter_ids))
    if unknown:
        raise ValueError(f"unknown chapter ids requested: {unknown}")
    reusable = [cid for cid in chapter_ids if fs.extraction_result_is_current(book_id, cid)]
    target_ids = [cid for cid in chapter_ids if cid in requested and cid not in reusable]
    if reusable:
        print(f"reusing raw snapshots: {reusable}", flush=True)
    if target_ids:
        await asyncio.gather(*(run_one(cid) for cid in target_ids))

    missing = [cid for cid in chapter_ids if not fs.extraction_result_is_current(book_id, cid)]
    if missing:
        detail = {
            cid: (results[cid].warning if cid in results else "not captured in this invocation")
            for cid in missing
        }
        raise RuntimeError(f"raw capture incomplete chapters={missing}: {detail}")

    metrics = {
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "requested_chapters": sorted(requested),
        "attempted_chapters": target_ids,
        "reused_chapters": reusable,
        "attempt_counts": {str(k): v for k, v in sorted(attempt_counts.items())},
        "usage": control.snapshot(),
        "phase_stats": {k: dict(v) for k, v in sorted(phase_stats.items())},
    }
    return results, metrics


def _freeze_fixture(
    fs: Filestore,
    capture_book_id: str,
    source_book_id: str,
    chapter_ids: list[int],
    fixture_dir: Path,
    cfg: Settings,
    metrics: dict[str, Any],
    *,
    overwrite: bool,
) -> dict[str, Any]:
    fixture_dir = fixture_dir.resolve()
    if fixture_dir.exists():
        if not overwrite:
            raise FileExistsError(f"fixture already exists: {fixture_dir}; pass --overwrite-fixture")
        shutil.rmtree(fixture_dir)
    fixture_dir.mkdir(parents=True, exist_ok=True)

    source_extraction = fs.extraction_dir(capture_book_id)
    filenames = ["base_cast.json"] + [f"chapter_{cid:03d}.json" for cid in chapter_ids]
    file_hashes: dict[str, str] = {}
    content_hashes: dict[str, str] = {}
    for name in filenames:
        src = source_extraction / name
        if not src.exists():
            raise FileNotFoundError(src)
        dst = fixture_dir / name
        shutil.copy2(src, dst)
        file_hashes[name] = _sha256(dst)
        if name.startswith("chapter_"):
            payload = json.loads(dst.read_text(encoding="utf-8"))
            content_hashes[str(payload["chapter_id"])] = str(payload["content_sha256"])

    aggregate = hashlib.sha256()
    for name in sorted(file_hashes):
        aggregate.update(f"{name}:{file_hashes[name]}\n".encode("utf-8"))

    manifest = {
        "fixture_version": 1,
        "name": "siddhartha-raw-legacy-v1",
        "created_at": datetime.now().isoformat(),
        "source_book_id": source_book_id,
        "capture_book_id": capture_book_id,
        "chapter_ids": chapter_ids,
        "chapter_content_sha256": content_hashes,
        "files": file_hashes,
        "fixture_sha256": aggregate.hexdigest(),
        "capture_model": cfg.llm_model,
        "capture_metrics": metrics,
    }
    (fixture_dir / "fixture_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return manifest


async def _main(args: argparse.Namespace) -> None:
    source_book_dir = Path(args.source_book_dir).resolve()
    fixture_dir = Path(args.fixture_dir).resolve()
    fs, source_book_id, chapter_ids = _prepare_capture_book(
        source_book_dir,
        args.capture_book_id,
        reset=args.reset,
        resume=args.resume,
    )
    if len(chapter_ids) != 12:
        raise RuntimeError(f"expected 12 analysis chapters for Siddhartha, got {chapter_ids}")

    cfg_kwargs: dict[str, Any] = {
        "workspace_root": str(fs.root),
        "auto_extract_factions": False,
    }
    if args.analysis_max_llm_tokens is not None:
        cfg_kwargs["analysis_max_llm_tokens"] = args.analysis_max_llm_tokens
    if args.inject_max_chars is not None:
        cfg_kwargs["inject_max_chars"] = args.inject_max_chars
    if args.llm_model:
        cfg_kwargs["llm_model"] = args.llm_model
    cfg = Settings(**cfg_kwargs)
    if not cfg.llm_api_key:
        raise RuntimeError("LLM_API_KEY is not configured")

    only_chapters = None
    if args.only_chapters:
        only_chapters = {int(item.strip()) for item in args.only_chapters.split(",") if item.strip()}
    _, metrics = await _capture(
        fs,
        args.capture_book_id,
        chapter_ids,
        cfg,
        max_attempts=args.max_attempts,
        only_chapters=only_chapters,
    )
    manifest = _freeze_fixture(
        fs,
        args.capture_book_id,
        source_book_id,
        chapter_ids,
        fixture_dir,
        cfg,
        metrics,
        overwrite=args.overwrite_fixture,
    )
    print(json.dumps({
        "fixture_dir": str(fixture_dir),
        "fixture_sha256": manifest["fixture_sha256"],
        "chapter_ids": chapter_ids,
        "capture_usage": metrics["usage"],
        "capture_elapsed_seconds": metrics["elapsed_seconds"],
    }, ensure_ascii=False, indent=2))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Capture a fixed raw extraction fixture for Siddhartha.")
    parser.add_argument("--source-book-dir", default=str(_default_source_book_dir()))
    parser.add_argument("--capture-book-id", default=DEFAULT_CAPTURE_BOOK_ID)
    parser.add_argument("--fixture-dir", default=str(DEFAULT_FIXTURE))
    parser.add_argument("--max-attempts", type=int, default=3)
    parser.add_argument("--only-chapters", default="", help="Comma-separated analysis chapter ids to capture on this invocation.")
    parser.add_argument("--analysis-max-llm-tokens", type=int, default=None)
    parser.add_argument("--inject-max-chars", type=int, default=None)
    parser.add_argument("--llm-model", default="")
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--overwrite-fixture", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    asyncio.run(_main(parse_args()))
