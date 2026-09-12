"""已验证事实按 predicate 和方向汇总；展示分类不限制抽取，也不覆盖其他关系。"""
from __future__ import annotations
from collections import defaultdict
from dataclasses import dataclass
from typing import Dict, List, Optional, Set

from app.core.faction_resolver import ResolvedFactions, resolve_factions
from app.core.relation_registry import descriptor
from app.logging_config import get_logger
from app.models.book import BookMeta, BookStatus
from app.models.cast import Cast, Importance
from app.models.ledger import Relation
from app.models.graph import GraphData, GraphEdge, GraphTag, GraphEvidence, GraphNode, FilteredPerson
from app.storage.filestore import Filestore

logger = get_logger("core.aggregator")
BLOCKING_STATUSES = frozenset({BookStatus.ANALYZING, BookStatus.RECONCILING})

@dataclass
class GraphQuery:
    to_chapter: Optional[int] = None
    single_chapter: bool = False
    min_appearance: int = 2
    predicate_filter: Optional[List[str]] = None
    category_filter: Optional[List[str]] = None

class Aggregator:
    def __init__(self, book_id: str, filestore: Filestore):
        self.book_id = book_id
        self.filestore = filestore

    def compile(self, query: GraphQuery | None = None) -> GraphData:
        query = query or GraphQuery()
        meta = self.filestore.read_meta(self.book_id)
        cast = self.filestore.read_cast(self.book_id)
        cast_ids = {p.person_id for p in cast.persons}
        ids = self._resolve_chapter_ids(query, meta, self._list_ledger_chapter_ids())
        if not ids:
            return GraphData(book_id=self.book_id, chapter_range=[], total_chapters=meta.total_chapters)
        registry = self.filestore.read_relation_registry(self.book_id)
        appearance = defaultdict(set)
        relations = []
        for ledger in self.filestore.read_ledgers(self.book_id, ids):
            for person in ledger.persons:
                appearance[person.person_id].add(ledger.chapter_id)
            relations.extend(ledger.relations)
        manual_overrides = self.filestore.read_relation_overrides(self.book_id)
        auto_overrides = self.filestore.read_reconcile_overrides(self.book_id)
        override_docs = (manual_overrides, auto_overrides)
        removed = {
            item["relation_id"]
            for doc in override_docs
            for item in doc.get("remove", [])
            if item.get("relation_id")
        }
        # Human overrides and the latest automatic reconcile generation are additive;
        # removals remain exact relation_id tombstones.
        for doc in override_docs:
            relations.extend(
                Relation.model_validate(r) for r in doc.get("add", [])
                if r.get("evidence", {}).get("chapter_id") in ids
            )
        relations = [r for r in relations if r.relation_id not in removed
                     and r.person_a in cast_ids and r.person_b in cast_ids]
        counts = {status: sum(r.status == status for r in relations) for status in ("pending", "rejected")}
        confirmed = [r for r in relations if r.status == "confirmed"]
        participants = {pid for r in confirmed for pid in (r.person_a, r.person_b)}
        grouped = defaultdict(dict)
        for rel in confirmed:
            key = rel.predicate if rel.normalization_status == "resolved" else "raw_" + rel.relation_id
            if query.predicate_filter and rel.predicate not in query.predicate_filter:
                continue
            if query.category_filter and rel.category not in query.category_filter:
                continue
            # 不合并有向与无向语义，也不将反向有向边当成同一条。
            pair = (rel.person_a, rel.person_b, rel.directed)
            tags = grouped[pair]
            if key not in tags:
                tags[key] = GraphTag(**descriptor(rel), key=key, predicate=rel.predicate,
                                     normalization_status=rel.normalization_status)
            tag = tags[key]
            tag.relation_ids.append(rel.relation_id)
            if rel.raw_relation not in tag.raw_relations:
                tag.raw_relations.append(rel.raw_relation)
            cid = rel.evidence.chapter_id
            if cid not in tag.chapter_ids:
                tag.chapter_ids.append(cid)
            ev = GraphEvidence(chapter_id=cid, quote=rel.evidence.quote)
            if ev not in tag.evidences:
                tag.evidences.append(ev)
        visible, filtered = set(), []
        for person in cast.persons:
            pid = person.person_id
            count = len(appearance[pid])
            if count >= query.min_appearance or pid in participants or person.importance == Importance.MAIN:
                visible.add(pid)
            elif count:
                filtered.append(FilteredPerson(person_id=pid, name=person.canonical_name))
        edges = []
        for (a, b, directed), tags in sorted(grouped.items()):
            if a not in visible or b not in visible:
                continue
            for tag in tags.values():
                definition = registry.get(tag.predicate)
                tag.display_score = (definition.display_priority if definition else 1) + 0.5 * len(tag.chapter_ids)
                tag.chapter_ids.sort()
                tag.evidences.sort(key=lambda e: (e.chapter_id, e.quote))
                tag.evidences = tag.evidences[:5]
            edges.append(GraphEdge(person_a=a, person_b=b,
                         tags=sorted(tags.values(), key=lambda t: (-t.display_score, t.key))))
        nodes = self._build_nodes(cast, appearance, visible)
        nodes.sort(key=lambda n: n.person_id)
        resolved = resolve_factions(book=self.filestore.read_factions(self.book_id),
                                    visible=visible, chapter_slice=set(ids), edges=edges)
        self._attach_factions(nodes, resolved)
        return GraphData(book_id=self.book_id, chapter_range=[ids[0] if query.single_chapter else 1, ids[-1]],
                         total_chapters=meta.total_chapters, nodes=nodes, edges=edges, factions=resolved.factions,
                         filtered_count=len(filtered), filtered_persons=sorted(filtered, key=lambda p:p.person_id),
                         pending_relation_count=counts["pending"], rejected_relation_count=counts["rejected"],
                         unclassified_relation_count=sum(r.normalization_status == "pending" for r in confirmed))

    @staticmethod
    def _attach_factions(nodes: List[GraphNode], resolved: ResolvedFactions):
        for n in nodes:
            n.faction_ids = list(resolved.node_factions.get(n.person_id, ()))
            n.primary_faction_id = resolved.primary.get(n.person_id)
            n.faction_inferred = n.person_id in resolved.inferred

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
