"""
Chapter Agent 工具层 -- 5 个 LangChain @tool 工具。

工具通过 ChapterToolContext 闭包注入上下文（book_id、chapter_id、cast_snapshot 等），
模型不需要传递这些参数。

D1: 临时 person_id 格式 = ch{cid}_p{n}
D3: person_id 存在性闸门在工具层（submit_result）
D4: read_chapter_window 固定返回格式 + 强制 limit
D5: propose_persons 只缓冲，不直接写 cast.json
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
from app.models.faction import (
    FORBIDDEN_FACTION_NAMES,
    Faction,
    FactionBook,
    FactionKind,
    Membership,
)
from app.models.ledger import (
    CastPropose,
    ChapterLedger,
    ChapterPerson,
    Evidence,
    Relation,
)
from app.models.reconcile import (
    AliasSuggestion,
    MergeSuggestion,
    ReconcilePatch,
    RelationChange,
    TodoItem,
)
from app.models.reconcile import SuspectList
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
    relations_buffer: List[Relation] = field(default_factory=list)  # submit_relations 累积
    filestore: Optional[Filestore] = None
    submit_ledger: Optional[ChapterLedger] = None  # submit_result 写入此
    _temp_id_counter: int = 0                # 临时 id 分配计数器
    _cached_content: Optional[str] = None    # 本章正文缓存（惰性加载）

    def next_temp_id(self) -> str:
        """分配下一个临时 person_id: ch{cid}_p{n}"""
        self._temp_id_counter += 1
        return f"ch{self.chapter_id}_p{self._temp_id_counter}"

    def all_known_person_ids(self) -> set[str]:
        """cast 快照 + cast_buffer 中的全部 person_id。"""
        snapshot_ids = {p.person_id for p in self.cast_snapshot.persons}
        buffer_ids = set(self.cast_buffer.keys())
        return snapshot_ids | buffer_ids

    def get_chapter_content(self) -> str:
        """获取本章正文（带缓存，避免每次工具调用都读盘 + 反序列化）。"""
        if self._cached_content is None:
            fs = self.filestore or _get_default_filestore()
            self._cached_content = fs.read_chapter_content(self.book_id, self.chapter_id)
        return self._cached_content

    def has_accumulated_work(self) -> bool:
        """本章是否已 propose 人物或提交过关系。"""
        return bool(self.cast_buffer) or bool(self.relations_buffer)

    def finalize_submit(self, summary: str = "") -> ChapterLedger:
        """与 submit_result 同一落账路径；漏调 submit_result 时由 chapter_agent 收尾。"""
        person_ids_in_chapter: set[str] = set(self.cast_buffer.keys())
        for rel in self.relations_buffer:
            person_ids_in_chapter.add(rel.person_a)
            person_ids_in_chapter.add(rel.person_b)

        ledger_persons = [
            ChapterPerson(person_id=pid, aliases_in_chapter=[])
            for pid in sorted(person_ids_in_chapter)
        ]

        self.submit_ledger = ChapterLedger(
            chapter_id=self.chapter_id,
            persons=ledger_persons,
            relations=list(self.relations_buffer),
            events=[],
            summary=summary or "",
        )
        return self.submit_ledger


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
            content = ctx.get_chapter_content()
        except Exception as e:
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
            content = ctx.get_chapter_content()
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

    # ── 4. propose_persons (batch) ──

    @tool
    def propose_persons(
        persons: List[Dict],
    ) -> str:
        """
        Propose one or more named characters for the cast registry in a single call.
        Returns a mapping from canonical_name to person_id for every person.

        Only named characters (proper names). Do not propose unnamed extras,
        occupational types, or groups (e.g. "洗衣少女", "沙门").

        For each person:
        - If canonical_name already exists in the frozen cast snapshot, returns the existing person_id.
        - If canonical_name already exists in this chapter's buffer, returns the existing temp id.
        - Otherwise, creates a new temp id (format: ch{chapter_id}_p{n}).

        Args:
            persons: List of person objects, each with:
                - canonical_name (str, required): The primary name.
                - aliases (list[str], optional): Alternative names.
                - bio (str, optional): Brief description.
                - gender (str, optional): "male", "female", or "unknown".
                - importance (str, optional): "main", "supporting", or "minor".

        Returns:
            JSON string: {results: [{canonical_name, person_id, status}]}
        """
        results = []
        for p in persons:
            canonical_name = p.get("canonical_name", "")
            aliases = p.get("aliases") or []
            bio = p.get("bio", "")
            gender = p.get("gender", "unknown")
            importance = p.get("importance", "minor")

            if not canonical_name:
                results.append({
                    "canonical_name": "",
                    "person_id": None,
                    "status": "error: canonical_name is required",
                })
                continue

            # #6: 先查冻结快照——正式名或别名精确匹配 → 直接返回已有 id
            existing = ctx.cast_snapshot.find_by_name(canonical_name)
            if existing is not None:
                results.append({
                    "canonical_name": existing.canonical_name,
                    "person_id": existing.person_id,
                    "status": "exists_in_cast",
                })
                continue

            # 检查重复 canonical_name（在同一章的 buffer 中）
            found_in_buffer = False
            for pid, propose in ctx.cast_buffer.items():
                if propose.canonical_name == canonical_name:
                    results.append({
                        "canonical_name": canonical_name,
                        "person_id": pid,
                        "status": "exists",
                    })
                    found_in_buffer = True
                    break
            if found_in_buffer:
                continue

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
            results.append({
                "canonical_name": canonical_name,
                "person_id": temp_id,
                "status": "proposed",
            })

        logger.info(
            "propose_persons batch: ch=%d count=%d new=%d",
            ctx.chapter_id,
            len(results),
            sum(1 for r in results if r["status"] == "proposed"),
        )
        return json.dumps({"results": results}, ensure_ascii=False)

    # ── 5. submit_relations ──

    @tool
    def submit_relations(
        relations: List[Dict],
    ) -> str:
        """
        Submit relations for this chapter. Can be called multiple times to
        accumulate relations in batches (e.g. after reading each text window).

        Each relation will be validated. If any relation fails validation,
        the entire batch is rejected and you must fix and resubmit.

        Args:
            relations: List of relation objects, each with:
                - person_a (str): person_id of the first person
                - person_b (str): person_id of the second person
                - type (str): relationship type (must be in the enum)
                - evidence (object, optional): {quote: str, note: str}

        Returns:
            JSON string: {status: "ok", accepted: N, total: M} on success,
            or {status: "error", message: "..."} on validation failure.
        """
        known_ids = ctx.all_known_person_ids()
        new_relations: list[Relation] = []

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
            for pid_value in [person_a, person_b]:
                if pid_value not in known_ids:
                    return json.dumps(
                        {
                            "status": "error",
                            "message": (
                                f"INVALID_PERSON_ID: '{pid_value}' not found. "
                                f"Use propose_persons first or query_cast to check existing ids."
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
                new_relations.append(rel)
            except Exception as e:
                return json.dumps(
                    {
                        "status": "error",
                        "message": f"RELATION_VALIDATION_ERROR: {e}",
                    },
                    ensure_ascii=False,
                )

        ctx.relations_buffer.extend(new_relations)
        logger.info(
            "submit_relations: ch=%d batch=%d total=%d",
            ctx.chapter_id,
            len(new_relations),
            len(ctx.relations_buffer),
        )
        return json.dumps(
            {
                "status": "ok",
                "accepted": len(new_relations),
                "total": len(ctx.relations_buffer),
            },
            ensure_ascii=False,
        )

    # ── 6. submit_result ──

    @tool
    def submit_result(
        summary: str = "",
    ) -> str:
        """
        Finalize the chapter analysis. This is the last step — call it after
        all relations have been submitted via submit_relations.

        Args:
            summary: Chapter summary (1-3 sentences).

        Returns:
            JSON string: {status: "submitted"} on success,
            or {status: "error", message: "..."} on validation failure.
        """
        ctx.finalize_submit(summary=summary)

        logger.info(
            "submit_result success: ch=%d, persons=%d, relations=%d",
            ctx.chapter_id,
            len(ctx.submit_ledger.persons) if ctx.submit_ledger else 0,
            len(ctx.relations_buffer),
        )
        return json.dumps({"status": "submitted"}, ensure_ascii=False)

    return [
        read_chapter_window,
        grep_in_chapter,
        query_cast,
        propose_persons,
        submit_relations,
        submit_result,
    ]


def _get_default_filestore() -> Filestore:
    """惰性获取 Filestore 单例。"""
    from app.storage.filestore import get_filestore
    return get_filestore()


# ── Reconcile Agent 工具 ──


@dataclass
class ReconcileToolContext:
    """Reconcile Agent 运行时上下文。"""

    book_id: str
    cast: Cast                          # 合并后的最终 cast（只读）
    suspects: SuspectList               # 可疑清单
    chapter_summaries: Dict[int, str]   # {chapter_id: summary}
    filestore: Optional[Filestore] = None
    submit_patch: Optional[ReconcilePatch] = None  # submit_reconciliation 写入
    _content_cache: Dict[int, str] = field(default_factory=dict)  # chapter_id → content

    def all_person_ids(self) -> set[str]:
        """cast 中所有 person_id。"""
        return {p.person_id for p in self.cast.persons}

    def get_chapter_content(self, chapter_id: int) -> str:
        """获取指定章节正文（带缓存，多章回查时避免重复读盘）。"""
        if chapter_id not in self._content_cache:
            fs = self.filestore or _get_default_filestore()
            self._content_cache[chapter_id] = fs.read_chapter_content(self.book_id, chapter_id)
        return self._content_cache[chapter_id]


def make_reconcile_tools(ctx: ReconcileToolContext) -> List[BaseTool]:
    """
    注册 5 个 Reconcile Agent 工具，返回 LangChain BaseTool 列表。

    工具通过闭包引用 ctx（ReconcileToolContext）。
    """

    max_limit = settings.read_window_chars
    max_matches = 50

    # ── 1. search_in_chapter ──

    @tool
    def search_in_chapter(chapter_id: int, keyword: str) -> str:
        """
        Search for a keyword in a specific chapter's text.
        Returns matching lines with line numbers. Max 50 matches.

        Args:
            chapter_id: The chapter ID to search in.
            keyword: The keyword to search for.

        Returns:
            JSON string: list of {line_number, text}, or {error: "..."} on failure.
        """
        if not keyword or not str(keyword).strip():
            return json.dumps(
                {"error": "keyword must not be empty"},
                ensure_ascii=False,
            )
        keyword = str(keyword).strip()

        try:
            content = ctx.get_chapter_content(chapter_id)
        except Exception as e:
            return json.dumps(
                {"error": f"Cannot read chapter {chapter_id}: {e}"},
                ensure_ascii=False,
            )

        lines = content.split("\n")
        matches = []
        for i, line in enumerate(lines, 1):
            if keyword in line:
                matches.append({"line_number": i, "text": line.strip()})
                if len(matches) >= max_matches:
                    matches.append({"truncated": True, "max_matches": max_matches})
                    break

        return json.dumps(matches, ensure_ascii=False)

    # ── 2. read_chapter_text ──

    @tool
    def read_chapter_text(chapter_id: int, offset: int, limit: int) -> str:
        """
        Read a window of text from a specific chapter by character offset.

        Args:
            chapter_id: The chapter ID to read from.
            offset: Character offset to start reading from (0-based, must be >= 0).
            limit: Maximum characters to read. Capped at internal max. Must be > 0.

        Returns:
            JSON string: {chapter_id, segment_index, offset, limit, total_chars, has_more, text}
        """
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

        actual_limit = min(limit, max_limit)

        try:
            content = ctx.get_chapter_content(chapter_id)
        except Exception as e:
            return json.dumps(
                {"error": f"Cannot read chapter {chapter_id}: {e}"},
                ensure_ascii=False,
            )

        total_chars = len(content)
        end = min(offset + actual_limit, total_chars)
        text = content[offset:end] if offset < total_chars else ""
        actual_returned = len(text)
        has_more = end < total_chars
        segment_index = offset // max_limit if max_limit > 0 else 0

        result = {
            "chapter_id": chapter_id,
            "segment_index": segment_index,
            "offset": offset,
            "limit": actual_returned,
            "total_chars": total_chars,
            "has_more": has_more,
            "text": text,
        }
        return json.dumps(result, ensure_ascii=False)

    # ── 3. get_chapter_result ──

    @tool
    def get_chapter_result(chapter_id: int) -> str:
        """
        Get the analysis result (ledger) for a specific chapter.
        Returns persons, relations, events, and summary as JSON. Read-only.

        Args:
            chapter_id: The chapter ID to query.

        Returns:
            JSON string of the chapter ledger, or {error: "..."} if not found.
        """
        try:
            fs = ctx.filestore or _get_default_filestore()
            ledger = fs.read_ledger(ctx.book_id, chapter_id)
            return ledger.model_dump_json(indent=2)
        except Exception as e:
            return json.dumps(
                {"error": f"Chapter result not found: {chapter_id}"},
                ensure_ascii=False,
            )

    # ── 4. query_cast ──

    @tool
    def query_cast() -> str:
        """
        Return the final merged cast (read-only) for the entire book.

        Returns:
            JSON string: {version, persons: [...]}
        """
        persons_data = []
        for p in ctx.cast.persons:
            persons_data.append({
                "person_id": p.person_id,
                "canonical_name": p.canonical_name,
                "aliases": [a.name for a in p.aliases],
                "bio": p.bio,
                "gender": p.gender.value,
                "importance": p.importance.value,
            })

        result = {
            "version": ctx.cast.version,
            "persons": persons_data,
        }
        return json.dumps(result, ensure_ascii=False)

    # ── 5. submit_reconciliation ──

    @tool
    def submit_reconciliation(
        merges: Optional[List[Dict]] = None,
        aliases: Optional[List[Dict]] = None,
        relation_changes: Optional[List[Dict]] = None,
        todos: Optional[List[Dict]] = None,
    ) -> str:
        """
        Submit the reconciliation patch. This is the final step.
        All entries are validated before being stored.

        Args:
            merges: List of {keep_id, drop_id, reason, evidence?}
            aliases: List of {person_id, new_aliases, reason?}
            relation_changes: List of {action: "add"|"remove", person_a, person_b, type, chapter_id, quote?, note?}
            todos: List of {description, person_ids?, chapter_ids?}

        Returns:
            JSON string: {status: "submitted"} on success,
            or {status: "error", message: "..."} on validation failure.
        """
        if merges is None:
            merges = []
        if aliases is None:
            aliases = []
        if relation_changes is None:
            relation_changes = []
        if todos is None:
            todos = []

        cast_ids = ctx.all_person_ids()

        # ── 校验 merges ──
        validated_merges: list[MergeSuggestion] = []
        # 先构建 raw merge map 以检测环和重复 drop
        raw_merge_map: dict[str, str] = {}  # {drop_id: keep_id}
        for m in merges:
            keep_id = m.get("keep_id", "")
            drop_id = m.get("drop_id", "")
            if not keep_id or not drop_id:
                return _validation_error("merge: keep_id and drop_id are required")
            if keep_id == drop_id:
                return _validation_error(f"merge: keep_id and drop_id must be different (both '{keep_id}')")
            if keep_id not in cast_ids:
                return _validation_error(f"INVALID_PERSON_ID: '{keep_id}' not found in cast")
            if drop_id not in cast_ids:
                return _validation_error(f"INVALID_PERSON_ID: '{drop_id}' not found in cast")
            if drop_id in raw_merge_map:
                return _validation_error(
                    f"merge: drop_id '{drop_id}' appears multiple times — each person can only be merged once"
                )
            raw_merge_map[drop_id] = keep_id

        # 检测环：沿 drop→keep 链走，若回到已访问节点则成环
        for start_drop in raw_merge_map:
            visited: set[str] = set()
            current = start_drop
            while current in raw_merge_map:
                if current in visited:
                    return _validation_error(
                        f"merge: cycle detected involving '{start_drop}' — circular merges are not allowed"
                    )
                visited.add(current)
                current = raw_merge_map[current]

        # 全部通过，构建 validated_merges
        for m in merges:
            validated_merges.append(MergeSuggestion(
                keep_id=m.get("keep_id", ""),
                drop_id=m.get("drop_id", ""),
                reason=m.get("reason", ""),
                evidence=m.get("evidence", ""),
            ))

        # ── 校验 aliases ──
        validated_aliases: list[AliasSuggestion] = []
        for a in aliases:
            person_id = a.get("person_id", "")
            if not person_id:
                return _validation_error("alias: person_id is required")
            if person_id not in cast_ids:
                return _validation_error(f"INVALID_PERSON_ID: '{person_id}' not found in cast")
            new_aliases = a.get("new_aliases", [])
            if not new_aliases:
                return _validation_error("alias: new_aliases must not be empty")
            validated_aliases.append(AliasSuggestion(
                person_id=person_id,
                new_aliases=new_aliases,
                reason=a.get("reason", ""),
            ))

        # ── 校验 relation_changes ──
        validated_relation_changes: list[RelationChange] = []
        for r in relation_changes:
            action = r.get("action", "")
            if action not in ("add", "remove"):
                return _validation_error(
                    f"relation_change: action must be 'add' or 'remove', got '{action}'"
                )
            person_a = r.get("person_a", "")
            person_b = r.get("person_b", "")
            rtype = r.get("type", "")
            if person_a not in cast_ids:
                return _validation_error(f"INVALID_PERSON_ID: '{person_a}' not found in cast")
            if person_b not in cast_ids:
                return _validation_error(f"INVALID_PERSON_ID: '{person_b}' not found in cast")
            if not is_valid_type(rtype):
                return _validation_error(
                    f"INVALID_RELATION_TYPE: '{rtype}'. Valid types: {', '.join(ALL_TYPE_NAMES)}"
                )
            chapter_id = r.get("chapter_id", 0)
            validated_relation_changes.append(RelationChange(
                action=action,
                person_a=person_a,
                person_b=person_b,
                type=rtype,
                chapter_id=chapter_id,
                quote=r.get("quote", ""),
                note=r.get("note", ""),
            ))

        # ── 校验 todos ──
        validated_todos: list[TodoItem] = []
        for t in todos:
            description = t.get("description", "")
            if not description:
                return _validation_error("todo: description must not be empty")
            validated_todos.append(TodoItem(
                description=description,
                person_ids=t.get("person_ids", []),
                chapter_ids=t.get("chapter_ids", []),
            ))

        # ── 校验通过，写入 ctx.submit_patch ──
        ctx.submit_patch = ReconcilePatch(
            merges=validated_merges,
            aliases=validated_aliases,
            relation_changes=validated_relation_changes,
            todos=validated_todos,
        )

        logger.info(
            "submit_reconciliation success: merges=%d aliases=%d relation_changes=%d todos=%d",
            len(validated_merges),
            len(validated_aliases),
            len(validated_relation_changes),
            len(validated_todos),
        )
        return json.dumps({"status": "submitted"}, ensure_ascii=False)

    return [
        search_in_chapter,
        read_chapter_text,
        get_chapter_result,
        query_cast,
        submit_reconciliation,
    ]


def _validation_error(message: str) -> str:
    """格式化校验错误返回。"""
    return json.dumps(
        {"status": "error", "message": message},
        ensure_ascii=False,
    )


# ── FactionWriter 工具 ──


@dataclass
class FactionToolContext:
    """FactionWriter 运行时上下文。"""

    book_id: str
    cast: Cast                          # 全书人名册（只读）
    chapter_summaries: Dict[int, str]   # {chapter_id: summary}
    filestore: Optional[Filestore] = None
    submit_book: Optional[FactionBook] = None  # submit_factions 写入
    _content_cache: Dict[int, str] = field(default_factory=dict)

    def all_person_ids(self) -> set[str]:
        return {p.person_id for p in self.cast.persons}

    def get_chapter_content(self, chapter_id: int) -> str:
        if chapter_id not in self._content_cache:
            fs = self.filestore or _get_default_filestore()
            self._content_cache[chapter_id] = fs.read_chapter_content(
                self.book_id, chapter_id
            )
        return self._content_cache[chapter_id]


def make_faction_tools(ctx: FactionToolContext) -> List[BaseTool]:
    """注册 3 个 FactionWriter 工具（查原文 / 查章结果 / 提交势力册）。"""

    max_matches = 50

    # ── 1. search_in_chapter ──

    @tool
    def search_in_chapter(chapter_id: int, keyword: str) -> str:
        """
        Search for a keyword in a specific chapter's text. Use it to confirm that
        an institution / group name really appears in the book.

        Args:
            chapter_id: The chapter ID to search in.
            keyword: The keyword to search for.

        Returns:
            JSON string: list of {line_number, text}, or {error: "..."} on failure.
        """
        if not keyword or not str(keyword).strip():
            return json.dumps({"error": "keyword must not be empty"}, ensure_ascii=False)
        keyword = str(keyword).strip()

        try:
            content = ctx.get_chapter_content(chapter_id)
        except Exception as e:
            return json.dumps(
                {"error": f"Cannot read chapter {chapter_id}: {e}"},
                ensure_ascii=False,
            )

        matches: list[dict] = []
        for i, line in enumerate(content.split("\n"), 1):
            if keyword in line:
                matches.append({"line_number": i, "text": line.strip()})
                if len(matches) >= max_matches:
                    matches.append({"truncated": True, "max_matches": max_matches})
                    break

        return json.dumps(matches, ensure_ascii=False)

    # ── 2. get_chapter_result ──

    @tool
    def get_chapter_result(chapter_id: int) -> str:
        """
        Get the analysis result (ledger) for a specific chapter: persons,
        relations, events and summary. Read-only.

        Args:
            chapter_id: The chapter ID to query.

        Returns:
            JSON string of the chapter ledger, or {error: "..."} if not found.
        """
        try:
            fs = ctx.filestore or _get_default_filestore()
            return fs.read_ledger(ctx.book_id, chapter_id).model_dump_json(indent=2)
        except Exception:
            return json.dumps(
                {"error": f"Chapter result not found: {chapter_id}"},
                ensure_ascii=False,
            )

    # ── 3. submit_factions ──

    @tool
    def submit_factions(factions: List[Dict]) -> str:
        """
        Submit the faction book. This is the final step.

        Args:
            factions: List of {name, kind, aliases?, note?, members: [
                {person_id, role?, chapter_ids?, confidence?, quote?}
            ]}

        Returns:
            JSON string: {status: "submitted", factions: N, members: M} on success,
            or {status: "error", message: "..."} on validation failure.
        """
        if not factions:
            return _validation_error("factions must not be empty")

        cast_ids = ctx.all_person_ids()
        known_chapters = set(ctx.chapter_summaries.keys())

        validated: list[Faction] = []
        seen_names: set[str] = set()
        total_members = 0

        for i, raw in enumerate(factions):
            if not isinstance(raw, dict):
                return _validation_error(f"faction[{i}] must be an object")

            name = str(raw.get("name", "")).strip()
            if not name:
                return _validation_error(f"faction[{i}]: name is required")
            if name in FORBIDDEN_FACTION_NAMES:
                return _validation_error(
                    f"faction[{i}]: '{name}' 是关系类型，不能当势力名。"
                    f"势力名要用学校/教会/家族/组织等专有名词。"
                )
            if name in seen_names:
                return _validation_error(f"faction[{i}]: duplicate name '{name}'")
            seen_names.add(name)

            try:
                kind = FactionKind(str(raw.get("kind", "other")).strip().lower())
            except ValueError:
                logger.warning(
                    "submit_factions: unknown kind %r for %s → other",
                    raw.get("kind"),
                    name,
                )
                kind = FactionKind.OTHER

            aliases = [
                str(a).strip()
                for a in (raw.get("aliases") or [])
                if str(a).strip() and str(a).strip() != name
            ]

            raw_members = raw.get("members") or []
            if not isinstance(raw_members, list) or not raw_members:
                return _validation_error(f"faction[{i}] '{name}': members must not be empty")

            members: list[Membership] = []
            seen_pids: set[str] = set()
            for m in raw_members:
                if not isinstance(m, dict):
                    return _validation_error(
                        f"faction '{name}': each member must be an object"
                    )
                pid = str(m.get("person_id", "")).strip()
                if not pid:
                    return _validation_error(f"faction '{name}': member person_id required")
                if pid not in cast_ids:
                    return _validation_error(
                        f"INVALID_PERSON_ID: '{pid}' not found in cast (faction '{name}')"
                    )
                if pid in seen_pids:
                    continue  # 同块重复成员：静默去重
                seen_pids.add(pid)

                # 只保留已分析章号，防止编造章
                chapter_ids = sorted(
                    {
                        int(c)
                        for c in (m.get("chapter_ids") or [])
                        if isinstance(c, (int, float, str))
                        and str(c).strip().lstrip("-").isdigit()
                        and int(c) in known_chapters
                    }
                )

                try:
                    confidence = float(m.get("confidence", 0.8))
                except (TypeError, ValueError):
                    confidence = 0.8
                confidence = min(1.0, max(0.0, confidence))

                quote = str(m.get("quote", "") or "").strip()
                evidence: list[Evidence] = []
                if quote:
                    evidence.append(
                        Evidence(
                            chapter_id=chapter_ids[0] if chapter_ids else 0,
                            quote=quote,
                        )
                    )

                members.append(
                    Membership(
                        person_id=pid,
                        role=str(m.get("role", "") or "").strip(),
                        chapter_ids=chapter_ids,
                        confidence=confidence,
                        evidence=evidence,
                    )
                )

            total_members += len(members)
            validated.append(
                Faction(
                    faction_id=f"f{len(validated) + 1:03d}",
                    canonical_name=name,
                    aliases=aliases,
                    kind=kind,
                    note=str(raw.get("note", "") or "").strip(),
                    members=members,
                )
            )

        ctx.submit_book = FactionBook(version=0, factions=validated)

        logger.info(
            "submit_factions success: factions=%d members=%d",
            len(validated),
            total_members,
        )
        return json.dumps(
            {
                "status": "submitted",
                "factions": len(validated),
                "members": total_members,
            },
            ensure_ascii=False,
        )

    return [search_in_chapter, get_chapter_result, submit_factions]
