"""
Aggregator — 确定性汇总出图。

读 cast + ledger + relation_overrides → GraphData。
无 LLM、无写盘。设计见 docs/aggregator-design.md。
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

from app.domain.relation_types import (
    Tier,
    get_relation_meta,
    is_valid_type,
    normalize_undirected_pair,
    tier_base_score,
)
from app.logging_config import get_logger
from app.models.book import BookMeta, BookStatus
from app.models.cast import Cast, Importance, Person
from app.models.graph import (
    FilteredPerson,
    GraphData,
    GraphEdge,
    GraphEvidence,
    GraphNode,
    GraphTag,
)
from app.storage.filestore import Filestore

logger = get_logger("core.aggregator")

# 每个 tag 最多保留的证据条数（优先有 quote）
_MAX_EVIDENCES = 5

# 不允许出图的进行中状态 → API 层 409
BLOCKING_STATUSES = frozenset({BookStatus.ANALYZING, BookStatus.RECONCILING})


@dataclass
class GraphQuery:
    """GET /graph 查询参数。"""

    to_chapter: Optional[int] = None
    # True：只汇总 to_chapter 那一章（需同时传 to_chapter）；False：汇总 1..to_chapter
    single_chapter: bool = False
    min_appearance: int = 2
    type_filter: Optional[List[str]] = None
    include_suppressed: bool = False


@dataclass
class _RawEntry:
    """展平后的单条关系（一章一条）。"""

    person_a: str
    person_b: str
    type: str
    directed: bool
    chapter_id: int
    quote: str = ""


@dataclass
class _TagAgg:
    """聚合中的 tag 累积。"""

    type: str
    directed: bool
    tier: str
    chapter_ids: Set[int] = field(default_factory=set)
    evidences: List[GraphEvidence] = field(default_factory=list)
    suppressed: bool = False
    display_score: float = 0.0


class Aggregator:
    """
    按需汇总人物关系图。

    纯同步、可 asyncio.to_thread 包装；无 IO 写。
    """

    def __init__(self, book_id: str, filestore: Filestore) -> None:
        self.book_id = book_id
        self.filestore = filestore

    def compile(self, query: GraphQuery | None = None) -> GraphData:
        """读账本 → 叠补丁 → 过滤打分 → GraphData。"""
        query = query or GraphQuery()
        meta = self.filestore.read_meta(self.book_id)
        cast = self.filestore.read_cast(self.book_id)
        cast_ids = {p.person_id for p in cast.persons}

        ledger_ids = self._list_ledger_chapter_ids()
        chapter_ids = self._resolve_chapter_ids(query, meta, ledger_ids)

        if not chapter_ids:
            return self._empty_graph(meta)

        # 响应 chapter_range：prefix → [1, N]；single → [N, N]
        range_lo = chapter_ids[0] if query.single_chapter else 1
        range_hi = chapter_ids[-1]
        ledgers = self.filestore.read_ledgers(self.book_id, chapter_ids)

        # appearance: person_id → set of chapter_ids
        appearance: Dict[str, Set[int]] = defaultdict(set)
        raw: List[_RawEntry] = []

        for ledger in ledgers:
            for cp in ledger.persons:
                appearance[cp.person_id].add(ledger.chapter_id)
            for rel in ledger.relations:
                entry = self._relation_to_entry(rel.person_a, rel.person_b, rel.type, ledger.chapter_id, rel.evidence.quote)
                if entry is not None:
                    raw.append(entry)

        raw = self._apply_overrides(raw, cast_ids)

        # pair_key for edge display endpoints: (person_a, person_b)
        # tag_key within edge: type (and directed is derived from type)
        # For aggregation of tags: (edge_key, type) where edge_key is endpoints
        edge_tags: Dict[Tuple[str, str], Dict[str, _TagAgg]] = defaultdict(dict)

        for e in raw:
            if e.person_a == e.person_b:
                continue
            edge_key = (e.person_a, e.person_b)
            tags = edge_tags[edge_key]
            if e.type not in tags:
                meta_rt = get_relation_meta(e.type)
                assert meta_rt is not None
                tags[e.type] = _TagAgg(
                    type=e.type,
                    directed=meta_rt.directed,
                    tier=meta_rt.tier.value,
                )
            tag = tags[e.type]
            tag.chapter_ids.add(e.chapter_id)
            tag.evidences.append(
                GraphEvidence(chapter_id=e.chapter_id, quote=e.quote or "")
            )

        # score + soft suppress by unordered pair
        self._score_and_suppress(edge_tags)

        # hard participants (before type_filter / suppressed drop)
        hard_persons = self._hard_participants(edge_tags)

        # type_filter + include_suppressed → final tags per edge
        final_edges = self._finalize_edges(edge_tags, query)

        # visibility
        visible, filtered = self._filter_persons(
            cast=cast,
            appearance=appearance,
            hard_persons=hard_persons,
            min_appearance=query.min_appearance,
            all_mentioned=self._all_person_ids(appearance, edge_tags, cast),
        )

        nodes = self._build_nodes(cast, appearance, visible)
        edges = [
            ge
            for ge in final_edges
            if ge.person_a in visible and ge.person_b in visible and ge.tags
        ]
        # stable sort
        nodes.sort(key=lambda n: n.person_id)
        edges.sort(key=lambda e: (e.person_a, e.person_b))

        return GraphData(
            book_id=self.book_id,
            chapter_range=[range_lo, range_hi],
            total_chapters=meta.total_chapters,
            nodes=nodes,
            edges=edges,
            filtered_count=len(filtered),
            filtered_persons=filtered,
        )

    # ── helpers ──

    def _empty_graph(self, meta: BookMeta) -> GraphData:
        return GraphData(
            book_id=self.book_id,
            chapter_range=[],
            total_chapters=meta.total_chapters,
            nodes=[],
            edges=[],
            filtered_count=0,
            filtered_persons=[],
        )

    def _list_ledger_chapter_ids(self) -> List[int]:
        d = self.filestore.ledger_dir(self.book_id)
        if not d.exists():
            return []
        ids: list[int] = []
        for f in d.glob("chapter_*.json"):
            # chapter_001.json → 1
            try:
                stem = f.stem  # chapter_001
                ids.append(int(stem.split("_", 1)[1]))
            except (IndexError, ValueError):
                logger.warning("Skip unexpected ledger filename: %s", f.name)
        return sorted(ids)

    def _resolve_chapter_ids(
        self,
        query: GraphQuery,
        meta: BookMeta,
        ledger_ids: List[int],
    ) -> List[int]:
        """
        解析要读入的 ledger 章号列表（升序）。

        - single_chapter=True：仅 to_chapter 一章（文件须存在）
        - 否则 prefix：1..effective_n 中实际存在的 ledger
        """
        if query.single_chapter:
            if query.to_chapter is None:
                logger.warning("single_chapter requires to_chapter; empty graph")
                return []
            cid = query.to_chapter
            if cid in ledger_ids:
                return [cid]
            # 文件不存在：空
            return []

        effective_n = self._resolve_effective_n(query.to_chapter, meta, ledger_ids)
        if effective_n < 1:
            return []
        return sorted(cid for cid in ledger_ids if cid <= effective_n)

    def _resolve_effective_n(
        self,
        to_chapter: Optional[int],
        meta: BookMeta,
        ledger_ids: List[int],
    ) -> int:
        ledger_set = set(ledger_ids)
        done = set(meta.analysis_progress.chapters_done)
        available = ledger_set | done

        if to_chapter is None:
            if not available:
                return 0
            upper = max(available)
            if meta.total_chapters > 0:
                return min(meta.total_chapters, upper)
            return upper

        # 传入 N：只用 ≤N 且存在的 ledger；N 大于已有则截到最大已存在章
        leq = [i for i in ledger_ids if i <= to_chapter]
        if leq:
            return max(leq)
        if ledger_ids and to_chapter > max(ledger_ids):
            return max(ledger_ids)
        return 0

    def _relation_to_entry(
        self,
        person_a: str,
        person_b: str,
        type_name: str,
        chapter_id: int,
        quote: str = "",
    ) -> Optional[_RawEntry]:
        if not is_valid_type(type_name):
            logger.warning(
                "Skip invalid relation type %r (chapter %s)", type_name, chapter_id
            )
            return None
        if person_a == person_b:
            return None
        meta_rt = get_relation_meta(type_name)
        assert meta_rt is not None
        a, b = person_a, person_b
        if not meta_rt.directed:
            a, b = normalize_undirected_pair(a, b)
        return _RawEntry(
            person_a=a,
            person_b=b,
            type=type_name,
            directed=meta_rt.directed,
            chapter_id=chapter_id,
            quote=quote or "",
        )

    def _apply_overrides(
        self, raw: List[_RawEntry], cast_ids: Set[str]
    ) -> List[_RawEntry]:
        """ledger 展开 → remove → add。损坏文件当空 overrides。"""
        try:
            overrides = self.filestore.read_relation_overrides(self.book_id)
            if not isinstance(overrides, dict):
                raise ValueError("overrides root must be object")
            remove_list = overrides.get("remove") or []
            add_list = overrides.get("add") or []
            if not isinstance(remove_list, list) or not isinstance(add_list, list):
                raise ValueError("add/remove must be lists")
        except Exception as e:
            logger.error("relation_overrides unreadable, treating as empty: %s", e)
            return raw

        entries = list(raw)

        for rem in remove_list:
            if not isinstance(rem, dict):
                continue
            pa = rem.get("person_a", "")
            pb = rem.get("person_b", "")
            rtype = rem.get("type", "")
            chapter_id = rem.get("chapter_id", 0) or 0
            if not pa or not pb or not rtype:
                continue
            if not is_valid_type(rtype):
                logger.warning("Override remove skip invalid type %r", rtype)
                continue
            meta_rt = get_relation_meta(rtype)
            assert meta_rt is not None
            if meta_rt.directed:
                na, nb = pa, pb
            else:
                na, nb = normalize_undirected_pair(pa, pb)

            def _match(e: _RawEntry, a=na, b=nb, t=rtype, cid=chapter_id) -> bool:
                if e.person_a != a or e.person_b != b or e.type != t:
                    return False
                if cid and cid != 0:
                    return e.chapter_id == cid
                return True

            entries = [e for e in entries if not _match(e)]

        for add in add_list:
            if not isinstance(add, dict):
                continue
            pa = add.get("person_a", "")
            pb = add.get("person_b", "")
            rtype = add.get("type", "")
            chapter_id = int(add.get("chapter_id") or 0)
            quote = add.get("quote") or ""
            if not pa or not pb or not rtype:
                continue
            # person_id 以 cast 为准；未知 id 跳过
            if pa not in cast_ids or pb not in cast_ids:
                logger.warning(
                    "Override add skip unknown person: %s / %s", pa, pb
                )
                continue
            entry = self._relation_to_entry(pa, pb, rtype, chapter_id, quote)
            if entry is not None:
                entries.append(entry)

        return entries

    def _score_and_suppress(
        self, edge_tags: Dict[Tuple[str, str], Dict[str, _TagAgg]]
    ) -> None:
        # score each tag
        for tags in edge_tags.values():
            for tag in tags.values():
                has_quote = any(ev.quote for ev in tag.evidences)
                tag.display_score = (
                    tier_base_score(tag.type)
                    + 0.5 * len(tag.chapter_ids)
                    + (1.0 if has_quote else 0.0)
                )
                # truncate evidences: prefer quote, then chapter_id order
                tag.evidences = self._truncate_evidences(tag.evidences)

        # unordered pair → has hard?
        pair_has_hard: Dict[Tuple[str, str], bool] = defaultdict(bool)
        for (a, b), tags in edge_tags.items():
            upair = normalize_undirected_pair(a, b)
            for tag in tags.values():
                if tag.tier == Tier.HARD.value:
                    pair_has_hard[upair] = True

        for (a, b), tags in edge_tags.items():
            upair = normalize_undirected_pair(a, b)
            if not pair_has_hard[upair]:
                continue
            for tag in tags.values():
                if tag.tier == Tier.SOFT.value:
                    tag.suppressed = True

    @staticmethod
    def _truncate_evidences(evidences: List[GraphEvidence]) -> List[GraphEvidence]:
        # dedupe by (chapter_id, quote) roughly: keep first per chapter preferring quote
        by_chapter: Dict[int, GraphEvidence] = {}
        for ev in evidences:
            prev = by_chapter.get(ev.chapter_id)
            if prev is None or (ev.quote and not prev.quote):
                by_chapter[ev.chapter_id] = ev
        items = list(by_chapter.values())
        items.sort(key=lambda e: (0 if e.quote else 1, e.chapter_id))
        return items[:_MAX_EVIDENCES]

    @staticmethod
    def _hard_participants(
        edge_tags: Dict[Tuple[str, str], Dict[str, _TagAgg]],
    ) -> Set[str]:
        hard: set[str] = set()
        for (a, b), tags in edge_tags.items():
            for tag in tags.values():
                if tag.tier == Tier.HARD.value:
                    hard.add(a)
                    hard.add(b)
                    break
        return hard

    def _finalize_edges(
        self,
        edge_tags: Dict[Tuple[str, str], Dict[str, _TagAgg]],
        query: GraphQuery,
    ) -> List[GraphEdge]:
        type_set: Optional[Set[str]] = None
        if query.type_filter:
            type_set = {t for t in query.type_filter if is_valid_type(t)}
            if not type_set and query.type_filter:
                # all invalid → empty filter means no tags
                type_set = set()

        result: list[GraphEdge] = []
        for (a, b), tags in edge_tags.items():
            graph_tags: list[GraphTag] = []
            for tag in tags.values():
                if type_set is not None and tag.type not in type_set:
                    continue
                if tag.suppressed and not query.include_suppressed:
                    continue
                graph_tags.append(
                    GraphTag(
                        type=tag.type,
                        tier=tag.tier,
                        directed=tag.directed,
                        chapter_ids=sorted(tag.chapter_ids),
                        evidences=list(tag.evidences),
                        display_score=tag.display_score,
                        suppressed=tag.suppressed,
                    )
                )
            if not graph_tags:
                continue
            graph_tags.sort(key=lambda t: (-t.display_score, t.type))
            result.append(GraphEdge(person_a=a, person_b=b, tags=graph_tags))
        return result

    def _all_person_ids(
        self,
        appearance: Dict[str, Set[int]],
        edge_tags: Dict[Tuple[str, str], Dict[str, _TagAgg]],
        cast: Cast,
    ) -> Set[str]:
        ids = set(appearance.keys())
        for a, b in edge_tags.keys():
            ids.add(a)
            ids.add(b)
        for p in cast.persons:
            ids.add(p.person_id)
        return ids

    def _filter_persons(
        self,
        cast: Cast,
        appearance: Dict[str, Set[int]],
        hard_persons: Set[str],
        min_appearance: int,
        all_mentioned: Set[str],
    ) -> Tuple[Set[str], List[FilteredPerson]]:
        cast_map = {p.person_id: p for p in cast.persons}
        visible: set[str] = set()
        filtered: list[FilteredPerson] = []

        for pid in sorted(all_mentioned):
            count = len(appearance.get(pid, ()))
            person = cast_map.get(pid)
            importance = (
                person.importance if person is not None else Importance.MINOR
            )
            if isinstance(importance, Importance):
                is_main = importance == Importance.MAIN
            else:
                is_main = str(importance) == "main"

            if count >= min_appearance or pid in hard_persons or is_main:
                visible.add(pid)
            else:
                name = person.canonical_name if person else pid
                filtered.append(FilteredPerson(person_id=pid, name=name))

        return visible, filtered

    def _build_nodes(
        self,
        cast: Cast,
        appearance: Dict[str, Set[int]],
        visible: Set[str],
    ) -> List[GraphNode]:
        cast_map = {p.person_id: p for p in cast.persons}
        nodes: list[GraphNode] = []
        for pid in visible:
            person = cast_map.get(pid)
            count = len(appearance.get(pid, ()))
            if person is None:
                nodes.append(
                    GraphNode(
                        person_id=pid,
                        name=pid,
                        aliases=[],
                        gender="unknown",
                        importance="minor",
                        appearance_count=count,
                        bio="",
                    )
                )
                continue
            gender = (
                person.gender.value
                if hasattr(person.gender, "value")
                else str(person.gender)
            )
            importance = (
                person.importance.value
                if hasattr(person.importance, "value")
                else str(person.importance)
            )
            nodes.append(
                GraphNode(
                    person_id=pid,
                    name=person.canonical_name,
                    aliases=[a.name for a in person.aliases],
                    gender=gender,
                    importance=importance,
                    appearance_count=count,
                    bio=person.bio or "",
                )
            )
        return nodes
