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
from app.core.orchestrator import Orchestrator, _get_start_lock
from app.core.patch_applier import PatchApplier
from app.core.rebuild import record_human_cast_update, record_human_merge
from app.domain.relation_types import RelationDescriptor
from app.core.relation_registry import register, apply_definition, descriptor
from app.models.ledger import Relation
from app.errors import AppError, ErrorCode, analysis_already_running
from app.logging_config import get_logger
from app.models.book import BookMeta
from app.models.cast import Cast, Person
from app.storage.filestore import Filestore, get_filestore

logger = get_logger("api.edits")

router = APIRouter(prefix="/api/books", tags=["edits"])


# ── request bodies ──


class RelationOverridesDoc(BaseModel):
    """完整替换补丁。add 为开放关系，remove 为准确的 relation_id。"""
    add: List[Relation] = Field(default_factory=list)
    remove: List[str] = Field(default_factory=list)


class MergeRequest(BaseModel):
    keep_id: str
    drop_id: str


# ── helpers ──


def _refuse_if_blocking(meta: BookMeta) -> None:
    if meta.status in BLOCKING_STATUSES:
        raise analysis_already_running(meta.book_id)


def _bad_request(message: str, *, code: ErrorCode = ErrorCode.VALIDATION_ERROR) -> None:
    raise AppError(code, message, status_code=400)


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
    async with _get_start_lock(book_id):
        meta = await asyncio.to_thread(fs.read_meta, book_id)
        _refuse_if_blocking(meta)

        existing = await asyncio.to_thread(fs.read_cast, book_id)
        updated = _apply_cast_update(existing, body)
        await asyncio.to_thread(fs.write_cast, book_id, updated)
        await asyncio.to_thread(record_human_cast_update, fs, book_id, body.persons)
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
    非法语义结构 / 未知人物会被拒绝。PUT 是整份替换，不与旧文件 merge。
    """
    async with _get_start_lock(book_id):
        meta = await asyncio.to_thread(fs.read_meta, book_id)
        _refuse_if_blocking(meta)

        cast = await asyncio.to_thread(fs.read_cast, book_id)
        cast_ids = {p.person_id for p in cast.persons}
        registry = await asyncio.to_thread(fs.read_relation_registry, book_id)
        additions = []
        for relation in body.add:
            if relation.person_a not in cast_ids or relation.person_b not in cast_ids:
                _bad_request("Unknown person_id in relation")
            cid = relation.evidence.chapter_id
            await asyncio.to_thread(fs.read_chapter, book_id, cid)
            if relation.predicate:
                definition = registry.get(relation.predicate)
                if definition is None or descriptor(definition) != descriptor(relation):
                    _bad_request("predicate 不存在或与提供的关系定义不一致")
            else:
                definition = register(registry, relation, source="human")
            apply_definition(relation, definition)
            relation.status = "confirmed"
            relation.verification_reason = "人工确认"
            relation.normalization_reason = "人工选择或注册关系语义"
            additions.append(relation.model_dump(mode="json"))
        saved = {"add": additions, "remove": [{"relation_id": rid} for rid in body.remove]}
        await asyncio.to_thread(fs.write_relation_registry, book_id, registry)
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
    async with _get_start_lock(book_id):
        meta = await asyncio.to_thread(fs.read_meta, book_id)
        _refuse_if_blocking(meta)

        if body.keep_id == body.drop_id:
            _bad_request("keep_id and drop_id must differ")

        cast = await asyncio.to_thread(fs.read_cast, book_id)
        if cast.get_person(body.keep_id) is None:
            _bad_request(f"Unknown keep_id: {body.keep_id}")
        if cast.get_person(body.drop_id) is None:
            _bad_request(f"Unknown drop_id: {body.drop_id}")

        await asyncio.to_thread(
            record_human_merge, fs, book_id, keep_id=body.keep_id, drop_id=body.drop_id
        )
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
        reconcile_overrides = fs.read_reconcile_overrides(book_id)
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
            "reconcile_overrides": reconcile_overrides,
            "relation_registry": fs.read_relation_registry(book_id).model_dump(mode="json"),
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
    安全重跑单章：在同盘 staging 中重抽该章，随后重建人物合并、关系后处理和全书 Reconcile，最后一致发布。

    - book / chapter 不存在 → 404
    - analyzing / reconciling → 409
    - 缺少可重建基线 → 409（需先完成一次新版全书分析）
    - 章节抽取或后处理失败 → 502（上一份正式结果保持不变）
    - 章节成功但全书校对失败 → 发布一致的章节结果并明确标记 reconcile_failed
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


@router.post("/{book_id}/relation-types")
async def add_relation_definition(book_id: str, body: RelationDescriptor,
                                  fs: Filestore = Depends(get_filestore)) -> dict:
    async with _get_start_lock(book_id):
        meta = await asyncio.to_thread(fs.read_meta, book_id)
        _refuse_if_blocking(meta)
        registry = await asyncio.to_thread(fs.read_relation_registry, book_id)
        definition = register(registry, body, source="human")
        await asyncio.to_thread(fs.write_relation_registry, book_id, registry)
        return definition.model_dump(mode="json")
