"""
人工校对 / 导出 API。

PUT  /api/books/{book_id}/cast              -- 编辑人名册（不改 ledger person_id）
PUT  /api/books/{book_id}/relations         -- 人工改关系（整份替换 relation_overrides.json）
POST /api/books/{book_id}/cast/merge        -- 合并两人 + rewrite ledger person_id
GET  /api/books/{book_id}/export            -- 导出 JSON bundle（PNG 由前端画布负责）
POST /api/books/{book_id}/chapters/{cid}/rerun -- 重跑单章（覆盖该章 ledger，不级联）
"""
from __future__ import annotations

import asyncio
import re
from typing import List, Optional

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.config import settings
from app.core.aggregator import BLOCKING_STATUSES, Aggregator, GraphQuery
from app.core.orchestrator import Orchestrator
from app.core.patch_applier import PatchApplier
from app.domain.relation_types import ALL_TYPE_NAMES, is_valid_type
from app.errors import AppError, ErrorCode, analysis_already_running
from app.logging_config import get_logger
from app.models.book import BookMeta
from app.models.cast import Cast, Person
from app.storage.filestore import Filestore, get_filestore

logger = get_logger("api.edits")

router = APIRouter(prefix="/api/books", tags=["edits"])


# ── request bodies ──


class RelationOverrideEntry(BaseModel):
    """一条 add / remove 补丁。格式对齐 aggregator-design §4.2。"""

    person_a: str
    person_b: str
    type: str
    chapter_id: Optional[int] = None
    quote: Optional[str] = None
    note: Optional[str] = None


class RelationOverridesDoc(BaseModel):
    """
    PUT /relations 请求体。

    **整份替换** `overrides/relation_overrides.json`（不与旧文件 merge）。
    客户端应 GET 当前 overrides（含在 GET /export 里）再改完整份回写。
    """

    add: List[RelationOverrideEntry] = Field(default_factory=list)
    remove: List[RelationOverrideEntry] = Field(default_factory=list)


class MergeRequest(BaseModel):
    keep_id: str
    drop_id: str


# ── helpers ──


def _refuse_if_blocking(meta: BookMeta) -> None:
    if meta.status in BLOCKING_STATUSES:
        raise analysis_already_running(meta.book_id)


def _bad_request(message: str, *, code: ErrorCode = ErrorCode.VALIDATION_ERROR) -> None:
    raise AppError(code, message, status_code=400)


def _entry_to_dict(entry: RelationOverrideEntry) -> dict:
    data: dict = {
        "person_a": entry.person_a,
        "person_b": entry.person_b,
        "type": entry.type,
    }
    if entry.chapter_id is not None:
        data["chapter_id"] = entry.chapter_id
    if entry.quote:
        data["quote"] = entry.quote
    if entry.note:
        data["note"] = entry.note
    return data


def _validate_override_entries(
    entries: List[RelationOverrideEntry],
    cast_ids: set[str],
    *,
    kind: str,
) -> None:
    for i, e in enumerate(entries):
        if not is_valid_type(e.type):
            raise AppError(
                ErrorCode.INVALID_RELATION_TYPE,
                f"Invalid relation type in {kind}[{i}]: '{e.type}'. "
                f"Valid types: {', '.join(ALL_TYPE_NAMES)}",
                details={"valid_types": ALL_TYPE_NAMES},
                status_code=400,
            )
        if e.person_a not in cast_ids:
            _bad_request(f"Unknown person_id in {kind}[{i}]: {e.person_a}")
        if e.person_b not in cast_ids:
            _bad_request(f"Unknown person_id in {kind}[{i}]: {e.person_b}")
        if e.person_a == e.person_b:
            _bad_request(f"Self-loop not allowed in {kind}[{i}]: {e.person_a}")


def _apply_cast_update(existing: Cast, incoming: Cast) -> Cast:
    """
    按 person_id 合并更新人名册。

    - 已有 id：只改 canonical_name / aliases / gender / importance / bio / merge_candidates
    - 新 id：追加（不改已有 ledger person_id）
    - 请求里没出现的已有人物：保留（删除请走 POST /cast/merge）
    - version 由服务端 bump，忽略客户端传入值
    """
    existing_map = {p.person_id: p for p in existing.persons}
    incoming_ids: set[str] = set()
    merged: list[Person] = []

    for p in incoming.persons:
        incoming_ids.add(p.person_id)
        old = existing_map.get(p.person_id)
        if old is None:
            merged.append(p)
            continue
        merged.append(
            Person(
                person_id=old.person_id,  # never rewrite
                canonical_name=p.canonical_name,
                aliases=p.aliases,
                bio=p.bio,
                gender=p.gender,
                importance=p.importance,
                merge_candidates=p.merge_candidates,
            )
        )

    for pid, person in existing_map.items():
        if pid not in incoming_ids:
            merged.append(person)

    return Cast(version=existing.version + 1, persons=merged)


# ── PUT /cast ──


@router.put("/{book_id}/cast")
async def update_cast(
    book_id: str,
    body: Cast,
    fs: Filestore = Depends(get_filestore),
) -> dict:
    """
    编辑人名册。

    Body 为 Cast JSON（与 GET /cast 同形）。按 person_id 合并更新
    canonical_name / aliases / gender / importance / bio；**不改 ledger person_id**。
    未出现在 body.persons 里的已有人物保留。version 服务端 +1。
    """
    meta = await asyncio.to_thread(fs.read_meta, book_id)
    _refuse_if_blocking(meta)

    existing = await asyncio.to_thread(fs.read_cast, book_id)
    updated = _apply_cast_update(existing, body)
    await asyncio.to_thread(fs.write_cast, book_id, updated)
    logger.info(
        "Cast updated: book=%s version=%d persons=%d",
        book_id,
        updated.version,
        len(updated.persons),
    )
    return updated.model_dump(mode="json")


# ── PUT /relations ──


@router.put("/{book_id}/relations")
async def update_relations(
    book_id: str,
    body: RelationOverridesDoc,
    fs: Filestore = Depends(get_filestore),
) -> dict:
    """
    人工改关系：整份替换 `workspace/{book_id}/overrides/relation_overrides.json`。

    不改 ledger。Body 为 `{add: [...], remove: [...]}`（aggregator-design §4.2）。
    非法 type / 未知 person_id → 400。PUT 是整份替换，不与旧文件 merge。
    """
    meta = await asyncio.to_thread(fs.read_meta, book_id)
    _refuse_if_blocking(meta)

    cast = await asyncio.to_thread(fs.read_cast, book_id)
    cast_ids = {p.person_id for p in cast.persons}
    _validate_override_entries(body.add, cast_ids, kind="add")
    _validate_override_entries(body.remove, cast_ids, kind="remove")

    saved = {
        "add": [_entry_to_dict(e) for e in body.add],
        "remove": [_entry_to_dict(e) for e in body.remove],
    }
    await asyncio.to_thread(fs.write_relation_overrides, book_id, saved)
    logger.info(
        "Relation overrides replaced: book=%s add=%d remove=%d",
        book_id,
        len(saved["add"]),
        len(saved["remove"]),
    )
    return saved


# ── POST /cast/merge ──


@router.post("/{book_id}/cast/merge")
async def merge_persons(
    book_id: str,
    body: MergeRequest,
    fs: Filestore = Depends(get_filestore),
) -> dict:
    """
    合并两人（ARCHITECTURE §8.2）。

    Body: `{keep_id, drop_id}`。keep 吸收 drop 别名；全库 ledger + overrides
    rewrite person_id；自环丢弃。不默认重跑 LLM。
    """
    meta = await asyncio.to_thread(fs.read_meta, book_id)
    _refuse_if_blocking(meta)

    if body.keep_id == body.drop_id:
        _bad_request("keep_id and drop_id must differ")

    cast = await asyncio.to_thread(fs.read_cast, book_id)
    if cast.get_person(body.keep_id) is None:
        _bad_request(f"Unknown keep_id: {body.keep_id}")
    if cast.get_person(body.drop_id) is None:
        _bad_request(f"Unknown drop_id: {body.drop_id}")

    applier = PatchApplier(book_id, fs)
    updated = await asyncio.to_thread(applier.merge_persons, body.keep_id, body.drop_id)
    logger.info(
        "Persons merged: book=%s keep=%s drop=%s version=%d",
        book_id,
        body.keep_id,
        body.drop_id,
        updated.version,
    )
    return updated.model_dump(mode="json")


# ── GET /export ──


@router.get("/{book_id}/export")
async def export_book(
    book_id: str,
    fs: Filestore = Depends(get_filestore),
) -> JSONResponse:
    """
    导出 JSON bundle：meta / cast / factions / relation_overrides / graph / ledgers。

    分析中 → 409（与 GET /graph 一致，避免半成品快照）。PNG 由前端画布导出。
    """
    meta = await asyncio.to_thread(fs.read_meta, book_id)
    if meta.status in BLOCKING_STATUSES:
        raise AppError(
            ErrorCode.ANALYSIS_ALREADY_RUNNING,
            f"Export unavailable while status is {meta.status.value} (book={book_id})",
            status_code=409,
        )

    def _build() -> dict:
        cast = fs.read_cast(book_id)
        factions = fs.read_factions(book_id)
        overrides = fs.read_relation_overrides(book_id)
        graph = Aggregator(book_id, fs).compile(GraphQuery())
        ledger_dir = fs.ledger_dir(book_id)
        ledgers: list[dict] = []
        if ledger_dir.exists():
            ids: list[int] = []
            for f in ledger_dir.glob("chapter_*.json"):
                try:
                    ids.append(int(f.stem.split("_", 1)[1]))
                except (IndexError, ValueError):
                    continue
            for cid in sorted(ids):
                ledgers.append(fs.read_ledger(book_id, cid).model_dump(mode="json"))
        return {
            "meta": meta.model_dump(mode="json"),
            "cast": cast.model_dump(mode="json"),
            "factions": factions.model_dump(mode="json"),
            "relation_overrides": overrides,
            "graph": graph.model_dump(mode="json"),
            "ledgers": ledgers,
        }

    bundle = await asyncio.to_thread(_build)
    safe_id = re.sub(r"[^A-Za-z0-9._-]+", "_", book_id)[:64] or "book"
    filename = f"zhiying-{safe_id}.json"
    return JSONResponse(
        content=bundle,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── POST /chapters/{cid}/rerun ──


@router.post("/{book_id}/chapters/{cid}/rerun")
async def rerun_chapter(
    book_id: str,
    cid: int,
    fs: Filestore = Depends(get_filestore),
) -> dict:
    """
    重跑单章：覆盖该章 ledger，不级联后续章，不跑 Reconcile。

    - book / chapter 不存在 → 404
    - analyzing / reconciling → 409
    - Agent 失败 → 502（旧 ledger 保留）
    """
    meta = await asyncio.to_thread(fs.read_meta, book_id)
    _refuse_if_blocking(meta)

    if cid < 1:
        _bad_request(f"chapter id must be >= 1, got {cid}")

    if not fs.chapter_path(book_id, cid).exists():
        raise AppError(
            ErrorCode.BOOK_NOT_FOUND,
            f"Chapter not found: chapter {cid} (book={book_id})",
            status_code=404,
        )

    orch = Orchestrator(book_id, fs, settings)
    return await orch.rerun_chapter(cid)
