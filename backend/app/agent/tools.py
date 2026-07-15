"""
Chapter Agent 工具层 -- 5 个 LangChain @tool 工具。

工具通过 ChapterToolContext 闭包注入上下文（book_id、chapter_id、cast_snapshot 等），
模型不需要传递这些参数。

D1: 临时 person_id 格式 = ch{cid}_p{n}
D3: person_id 存在性闸门在工具层（submit_result）
D4: read_chapter_window 固定返回格式 + 强制 limit
D5: propose_cast_update 只缓冲，不直接写 cast.json
D10: LangChain @tool 装饰器 + 闭包上下文注入
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from langchain_core.tools import BaseTool, tool

from app.config import settings
from app.domain.relation_types import ALL_TYPE_NAMES, is_valid_type
from app.logging_config import get_logger
from app.models.cast import Cast
from app.models.ledger import (
    CastPropose,
    ChapterEvent,
    ChapterLedger,
    ChapterPerson,
    Relation,
)
from app.storage.filestore import Filestore

logger = get_logger("agent.tools")


# ── 上下文容器 ──


@dataclass
class ChapterToolContext:
    """
    每章 Agent 运行时的共享上下文。

    工具函数通过闭包引用此对象的字段，模型不需要传递 book_id / chapter_id 等。
    """

    book_id: str
    chapter_id: int
    cast_snapshot: Cast                      # 启动时冻结的只读快照
    cast_buffer: Dict[str, CastPropose] = field(default_factory=dict)
    filestore: Optional[Filestore] = None
    submit_ledger: Optional[ChapterLedger] = None  # submit_result 写入此
    _temp_id_counter: int = 0                # 临时 id 分配计数器

    def next_temp_id(self) -> str:
        """分配下一个临时 person_id: ch{cid}_p{n}"""
        self._temp_id_counter += 1
        return f"ch{self.chapter_id}_p{self._temp_id_counter}"

    def all_known_person_ids(self) -> set[str]:
        """cast 快照 + cast_buffer 中的全部 person_id。"""
        snapshot_ids = {p.person_id for p in self.cast_snapshot.persons}
        buffer_ids = set(self.cast_buffer.keys())
        return snapshot_ids | buffer_ids


# ── 工具工厂 ──


def make_tools(ctx: ChapterToolContext) -> List[BaseTool]:
    """
    用 @tool 装饰器注册 5 个工具，返回 LangChain BaseTool 列表。

    每个工具通过闭包引用 ctx，模型不需传 book_id / chapter_id。
    """

    max_limit = settings.read_window_chars
    max_matches = 50  # #5: grep 结果上限

    # ── 1. read_chapter_window ──

    @tool
    def read_chapter_window(offset: int, limit: int) -> str:
        """
        Read a window of the current chapter's text by character offset.

        Args:
            offset: Character offset to start reading from (0-based, must be >= 0).
            limit: Maximum characters to read. Capped at internal max. Must be > 0.

        Returns:
            JSON string: {chapter_id, segment_index, offset, limit, total_chars, has_more, text}
            On invalid params: {error: "..."}
        """
        # #3: 参数校验
        if offset < 0:
            return json.dumps(
                {"error": f"offset must be >= 0, got {offset}"},
                ensure_ascii=False,
            )
        if limit <= 0:
            return json.dumps(
                {"error": f"limit must be > 0, got {limit}"},
                ensure_ascii=False,
            )

        # 强制 limit 上限
        actual_limit = min(limit, max_limit)

        try:
            # 读取当前章正文
            fs = ctx.filestore or _get_default_filestore()
            content = fs.read_chapter_content(ctx.book_id, ctx.chapter_id)
        except Exception as e:
            # #11: 工具内部异常不砸穿，返回错误 JSON
            return json.dumps(
                {"error": f"read_chapter_content failed: {e}"},
                ensure_ascii=False,
            )

        total_chars = len(content)

        # 切片
        end = min(offset + actual_limit, total_chars)
        text = content[offset:end] if offset < total_chars else ""
        actual_returned = len(text)
        has_more = end < total_chars

        # segment_index = offset // max_limit
        segment_index = offset // max_limit if max_limit > 0 else 0

        result = {
            "chapter_id": ctx.chapter_id,
            "segment_index": segment_index,
            "offset": offset,
            "limit": actual_returned,
            "total_chars": total_chars,
            "has_more": has_more,
            "text": text,
        }
        return json.dumps(result, ensure_ascii=False)

    # ── 2. grep_in_chapter ──

    @tool
    def grep_in_chapter(keyword: str) -> str:
        """
        Search for a keyword in the current chapter's text.
        Returns matching lines with line numbers. Max 50 matches.

        Args:
            keyword: The keyword to search for.

        Returns:
            JSON string: list of {line_number, text}, possibly with {truncated: true}
        """
        try:
            fs = ctx.filestore or _get_default_filestore()
            content = fs.read_chapter_content(ctx.book_id, ctx.chapter_id)
        except Exception as e:
            return json.dumps(
                {"error": f"read_chapter_content failed: {e}"},
                ensure_ascii=False,
            )

        lines = content.split("\n")
        matches = []
        for i, line in enumerate(lines, 1):
            if keyword in line:
                matches.append({"line_number": i, "text": line.strip()})
                # #5: 超限截断
                if len(matches) >= max_matches:
                    matches.append({"truncated": True, "max_matches": max_matches})
                    break

        return json.dumps(matches, ensure_ascii=False)

    # ── 3. query_cast ──

    @tool
    def query_cast() -> str:
        """
        Return the frozen cast snapshot (read-only) plus any pending
        proposals made in this chapter.

        Returns:
            JSON string: {version, persons: [...], pending_proposals: [{person_id, canonical_name, aliases}]}
        """
        persons_data = []
        for p in ctx.cast_snapshot.persons:
            persons_data.append({
                "person_id": p.person_id,
                "canonical_name": p.canonical_name,
                "aliases": [a.name for a in p.aliases],
                "bio": p.bio,
                "gender": p.gender.value,
                "importance": p.importance.value,
            })

        # #7: 附带本章已 propose 的人物
        pending_proposals = []
        for pid, propose in ctx.cast_buffer.items():
            pending_proposals.append({
                "person_id": pid,
                "canonical_name": propose.canonical_name,
                "aliases": propose.aliases,
            })

        result = {
            "version": ctx.cast_snapshot.version,
            "persons": persons_data,
            "pending_proposals": pending_proposals,
        }
        return json.dumps(result, ensure_ascii=False)

    # ── 4. propose_cast_update ──

    @tool
    def propose_cast_update(
        canonical_name: str,
        aliases: Optional[List[str]] = None,
        bio: str = "",
        gender: str = "unknown",
        importance: str = "minor",
    ) -> str:
        """
        Propose a new person for the cast registry.
        Returns a temporary person_id (format: ch{chapter_id}_p{n}).

        If the canonical_name already exists in the frozen cast snapshot,
        returns the existing person_id (no new proposal created).
        If the canonical_name already exists in this chapter's buffer,
        returns the existing temp id.

        Args:
            canonical_name: The primary name of the person.
            aliases: Alternative names for this person.
            bio: Brief biography or description.
            gender: "male", "female", or "unknown".
            importance: "main", "supporting", or "minor".

        Returns:
            JSON string: {person_id, status}
        """
        if aliases is None:
            aliases = []

        # #6: 先查冻结快照——正式名或别名精确匹配 → 直接返回已有 id
        existing = ctx.cast_snapshot.find_by_name(canonical_name)
        if existing is not None:
            return json.dumps(
                {
                    "person_id": existing.person_id,
                    "status": "exists_in_cast",
                    "canonical_name": existing.canonical_name,
                },
                ensure_ascii=False,
            )

        # 检查重复 canonical_name（在同一章的 buffer 中）
        for pid, propose in ctx.cast_buffer.items():
            if propose.canonical_name == canonical_name:
                return json.dumps(
                    {"person_id": pid, "status": "exists"},
                    ensure_ascii=False,
                )

        # 分配临时 id
        temp_id = ctx.next_temp_id()
        ctx.cast_buffer[temp_id] = CastPropose(
            canonical_name=canonical_name,
            aliases=aliases,
            bio=bio,
            gender=gender,
            importance=importance,
            source_chapter_id=ctx.chapter_id,
        )

        logger.debug(
            "Proposed person: %s -> %s (ch=%d)",
            canonical_name,
            temp_id,
            ctx.chapter_id,
        )
        return json.dumps(
            {"person_id": temp_id, "status": "proposed"},
            ensure_ascii=False,
        )

    # ── 5. submit_result ──

    @tool
    def submit_result(
        persons: Optional[List[Dict]] = None,
        relations: Optional[List[Dict]] = None,
        events: Optional[List[Dict]] = None,
        summary: str = "",
    ) -> str:
        """
        Submit the analysis result for this chapter. This is the final step.

        Args:
            persons: List of {person_id, aliases_in_chapter: [str]}
            relations: List of {person_a, person_b, type, evidence: {quote, note}}
            events: List of {description, persons: [str]}
            summary: Chapter summary (1-3 sentences).

        Returns:
            JSON string: {status: "submitted"} on success,
            or {status: "error", message: "..."} on validation failure.
        """
        if persons is None:
            persons = []
        if relations is None:
            relations = []
        if events is None:
            events = []

        known_ids = ctx.all_known_person_ids()

        # #4: 校验 persons[] 中的 person_id
        for p in persons:
            pid = p.get("person_id", "")
            if not pid:
                return json.dumps(
                    {
                        "status": "error",
                        "message": "INVALID_PERSON_ID: empty person_id in persons list",
                    },
                    ensure_ascii=False,
                )
            if pid not in known_ids:
                return json.dumps(
                    {
                        "status": "error",
                        "message": (
                            f"INVALID_PERSON_ID: '{pid}' not found in cast or buffer. "
                            f"Use propose_cast_update first or query_cast to check existing ids."
                        ),
                    },
                    ensure_ascii=False,
                )

        # ── 校验 events[].persons 中的 person_id ──
        for e in events:
            for ep_id in e.get("persons", []):
                if ep_id not in known_ids:
                    return json.dumps(
                        {
                            "status": "error",
                            "message": (
                                f"INVALID_PERSON_ID: '{ep_id}' in event persons not found. "
                                f"Use propose_cast_update first or query_cast to check existing ids."
                            ),
                        },
                        ensure_ascii=False,
                    )

        # ── 校验 relations ──
        validated_relations: list[Relation] = []
        for r in relations:
            person_a = r.get("person_a", "")
            person_b = r.get("person_b", "")
            rtype = r.get("type", "")

            # (1) type 枚举闸门
            if not is_valid_type(rtype):
                return json.dumps(
                    {
                        "status": "error",
                        "message": (
                            f"INVALID_RELATION_TYPE: '{rtype}'. "
                            f"Valid types: {', '.join(ALL_TYPE_NAMES)}"
                        ),
                    },
                    ensure_ascii=False,
                )

            # (2) person_id 存在性闸门
            for pid_label, pid_value in [("person_a", person_a), ("person_b", person_b)]:
                if pid_value not in known_ids:
                    return json.dumps(
                        {
                            "status": "error",
                            "message": (
                                f"INVALID_PERSON_ID: '{pid_value}' not found. "
                                f"Use propose_cast_update first or query_cast to check existing ids."
                            ),
                        },
                        ensure_ascii=False,
                    )

            # (3) 自环检查
            if person_a == person_b:
                return json.dumps(
                    {
                        "status": "error",
                        "message": "SELF_LOOP: person_a and person_b must be different",
                    },
                    ensure_ascii=False,
                )

            # 构造 Relation（model_validator 做二级兜底）
            try:
                evidence_data = r.get("evidence", {})
                rel = Relation(
                    person_a=person_a,
                    person_b=person_b,
                    type=rtype,
                    evidence={
                        "chapter_id": ctx.chapter_id,
                        "quote": evidence_data.get("quote", ""),
                        "note": evidence_data.get("note", ""),
                    },
                )
                validated_relations.append(rel)
            except Exception as e:
                return json.dumps(
                    {
                        "status": "error",
                        "message": f"RELATION_VALIDATION_ERROR: {e}",
                    },
                    ensure_ascii=False,
                )

        # ── 构造 ChapterLedger ──
        ledger_persons = [
            ChapterPerson(
                person_id=p.get("person_id", ""),
                aliases_in_chapter=p.get("aliases_in_chapter", []),
            )
            for p in persons
        ]

        ledger_events = [
            ChapterEvent(
                description=e.get("description", ""),
                persons=e.get("persons", []),
            )
            for e in events
        ]

        ctx.submit_ledger = ChapterLedger(
            chapter_id=ctx.chapter_id,
            persons=ledger_persons,
            relations=validated_relations,
            events=ledger_events,
            summary=summary,
        )

        logger.info(
            "submit_result success: ch=%d, persons=%d, relations=%d, events=%d",
            ctx.chapter_id,
            len(ledger_persons),
            len(validated_relations),
            len(ledger_events),
        )
        return json.dumps({"status": "submitted"}, ensure_ascii=False)

    return [
        read_chapter_window,
        grep_in_chapter,
        query_cast,
        propose_cast_update,
        submit_result,
    ]


def _get_default_filestore() -> Filestore:
    """惰性获取 Filestore 单例。"""
    from app.storage.filestore import get_filestore
    return get_filestore()
