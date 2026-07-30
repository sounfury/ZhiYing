"""
FactionResolver — 势力册 → 出图势力块（确定性，无 LLM）。

Aggregator 的势力侧后处理。四段确定性算法：

1. 切片 + 可见性过滤：只留当前章范围内活跃、且节点可见的成员（防剧透）
2. 主势力打分：一人多属时选一个落块
       score = kind_weight(kind) * confidence + 0.3 * |活跃章 ∩ 当前切片|
3. 邻居传播兜底：无显式归属者按邻居多数票归块（两轮），仍无则「未归属」
4. 环形排序：块间连线越多越相邻，减少跨图长边（贪心链）

附带一条便宜的 QA：块内成员若与同块任何人都无连线 → needs_review。
"""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

from app.logging_config import get_logger
from app.models.faction import Faction, FactionBook, kind_weight
from app.models.graph import GraphEdge, GraphFaction

logger = get_logger("core.faction_resolver")

# 未归属伪势力 id（前端识别为兜底块，排在环尾）
UNASSIGNED_ID = "__unassigned"
UNASSIGNED_NAME = "未归属"

# 活跃章命中一章的加分
_CHAPTER_BONUS = 0.3

# 邻居传播轮数
_PROPAGATE_ROUNDS = 2

# 块内无同伴连线才判 needs_review 的最小块规模（2 人块无连线是常态）
_REVIEW_MIN_SIZE = 3


@dataclass
class ResolvedFactions:
    """resolve_factions 的输出。"""

    factions: List[GraphFaction] = field(default_factory=list)
    # person_id → 显式归属的 faction_id 列表（不含传播推断与未归属）
    node_factions: Dict[str, List[str]] = field(default_factory=dict)
    # person_id → 落块用的主势力 id
    primary: Dict[str, str] = field(default_factory=dict)
    # 主势力来自邻居传播的人
    inferred: Set[str] = field(default_factory=set)


def _normalize_name(name: str) -> str:
    """势力名归一：去空白/标点，用于合并 LLM 跨批次造出的近重名块。"""
    return re.sub(r"[\s·・,，.。、\-—_（）()《》「」\"']+", "", name).lower()


def resolve_factions(
    book: FactionBook,
    visible: Set[str],
    chapter_slice: Set[int],
    edges: List[GraphEdge],
) -> ResolvedFactions:
    """
    势力册 → 出图势力块。

    Args:
        book: factions.json 内容
        visible: 本次出图可见的 person_id 集合
        chapter_slice: 本次出图覆盖的章号集合（防剧透切片）
        edges: 已过滤后的边，用于传播兜底 / 环形排序 / QA

    Returns:
        ResolvedFactions；势力册为空且无可传播来源时返回单个「未归属」块或空。
    """
    merged = _merge_duplicate_factions(book.factions)
    sliced = _slice_and_filter(merged, visible, chapter_slice)

    # person_id → [(faction_id, score)]
    scores: Dict[str, List[Tuple[str, float]]] = defaultdict(list)
    node_factions: Dict[str, List[str]] = defaultdict(list)
    for f in sliced:
        for m in f.members:
            active = len(set(m.chapter_ids) & chapter_slice) if m.chapter_ids else 1
            score = kind_weight(f.kind) * m.confidence + _CHAPTER_BONUS * active
            scores[m.person_id].append((f.faction_id, score))
            node_factions[m.person_id].append(f.faction_id)

    size_of = {f.faction_id: len(f.members) for f in sliced}

    primary: Dict[str, str] = {}
    for pid, cands in scores.items():
        # 打分并列时：大块优先（小块多为噪声），再按 id 稳定
        cands.sort(key=lambda c: (-c[1], -size_of.get(c[0], 0), c[0]))
        primary[pid] = cands[0][0]

    inferred = _propagate(primary, visible, edges, set(size_of.keys()))

    ordered = _ring_order(sliced, primary, edges)
    graph_factions = _build_graph_factions(
        ordered, primary, node_factions, inferred, edges
    )

    # 剩余无归属者 → 未归属块（排环尾）
    orphans = sorted(pid for pid in visible if pid not in primary)
    assigned = len(primary)
    if orphans:
        graph_factions.append(
            GraphFaction(
                faction_id=UNASSIGNED_ID,
                name=UNASSIGNED_NAME,
                kind="other",
                order=len(graph_factions),
                member_ids=orphans,
                all_member_ids=orphans,
                inferred=True,
            )
        )
        # 节点的 primary 要和块对齐，否则「只看未归属」这类按块筛选会筛出空图。
        # node_factions（显式归属）仍保持为空——他们确实没有被抽出来的归属。
        for pid in orphans:
            primary[pid] = UNASSIGNED_ID

    logger.info(
        "Factions resolved: raw=%d sliced=%d blocks=%d assigned=%d inferred=%d orphans=%d",
        len(book.factions),
        len(sliced),
        len(graph_factions),
        assigned,
        len(inferred),
        len(orphans),
    )

    return ResolvedFactions(
        factions=graph_factions,
        node_factions=dict(node_factions),
        primary=primary,
        inferred=inferred,
    )


# ── 1. 近重名合并 ──


def _merge_duplicate_factions(factions: List[Faction]) -> List[Faction]:
    """
    按归一名 + 别名合并近重复块（「克朗戈斯」vs「克朗戈斯伍德公学」）。

    保留首个出现的块作为主体，成员按 person_id 去重（confidence 取高）。
    """
    by_key: Dict[str, Faction] = {}
    order: List[str] = []

    for f in factions:
        keys = {_normalize_name(f.canonical_name)} | {
            _normalize_name(a) for a in f.aliases if a.strip()
        }
        keys.discard("")
        hit: Optional[str] = None
        for k in keys:
            if k in by_key:
                hit = k
                break
        if hit is None:
            # 名字互为前缀也算同一块（克朗戈斯 ⊂ 克朗戈斯伍德公学）
            # 要求 ≥3 字，避免「家」这类短名把不相关的块并掉
            base = _normalize_name(f.canonical_name)
            if len(base) >= 3:
                for k in order:
                    if len(k) >= 3 and (base.startswith(k) or k.startswith(base)):
                        hit = k
                        break

        if hit is None:
            key = _normalize_name(f.canonical_name) or f.faction_id
            by_key[key] = f.model_copy(deep=True)
            order.append(key)
            # 让别名也能命中同一块
            for k in keys:
                by_key.setdefault(k, by_key[key])
            continue

        target = by_key[hit]
        if target is f:
            continue
        existing = {m.person_id for m in target.members}
        for m in f.members:
            if m.person_id in existing:
                cur = target.get_member(m.person_id)
                if cur is not None:
                    cur.confidence = max(cur.confidence, m.confidence)
                    cur.chapter_ids = sorted(set(cur.chapter_ids) | set(m.chapter_ids))
                continue
            target.members.append(m.model_copy(deep=True))
            existing.add(m.person_id)
        for a in [f.canonical_name, *f.aliases]:
            if a and a != target.canonical_name and a not in target.aliases:
                target.aliases.append(a)

    # order 保序去重（by_key 里别名键指向同一对象）
    result: List[Faction] = []
    seen_ids: Set[int] = set()
    for k in order:
        f = by_key[k]
        if id(f) in seen_ids:
            continue
        seen_ids.add(id(f))
        result.append(f)
    return result


# ── 2. 切片 + 可见性过滤 ──


def _slice_and_filter(
    factions: List[Faction],
    visible: Set[str],
    chapter_slice: Set[int],
) -> List[Faction]:
    """
    丢掉不可见成员与切片外成员；空块整块消失（防剧透：第 5 章的大学块在前 2 章不存在）。

    Membership.chapter_ids 为空视为「全程活跃」，不参与切片过滤。
    """
    result: List[Faction] = []
    for f in factions:
        kept = [
            m
            for m in f.members
            if m.person_id in visible
            and (not m.chapter_ids or (set(m.chapter_ids) & chapter_slice))
        ]
        if not kept:
            continue
        clone = f.model_copy(deep=True)
        clone.members = kept
        result.append(clone)
    return result


# ── 3. 邻居传播兜底 ──


def _neighbor_weights(edges: List[GraphEdge]) -> Dict[str, List[Tuple[str, float]]]:
    """邻接表：person_id → [(neighbor, weight)]，weight = 该边最高 display_score。"""
    adj: Dict[str, List[Tuple[str, float]]] = defaultdict(list)
    for e in edges:
        w = max((t.display_score for t in e.tags), default=1.0)
        adj[e.person_a].append((e.person_b, w))
        adj[e.person_b].append((e.person_a, w))
    return adj


def _propagate(
    primary: Dict[str, str],
    visible: Set[str],
    edges: List[GraphEdge],
    known_faction_ids: Set[str],
) -> Set[str]:
    """
    无显式归属者按邻居加权多数票归块（就地写入 primary），返回被推断的人。

    只从「已有归属的邻居」传播，不做社区发现——名字是语义的，
    结构算法给不出「圣母圣心会」，只能借已知块的归属外扩一层。
    """
    if not known_faction_ids:
        return set()

    adj = _neighbor_weights(edges)
    inferred: Set[str] = set()

    for _ in range(_PROPAGATE_ROUNDS):
        pending: Dict[str, str] = {}
        for pid in sorted(visible):
            if pid in primary:
                continue
            votes: Dict[str, float] = defaultdict(float)
            for nb, w in adj.get(pid, ()):
                fid = primary.get(nb)
                if fid:
                    votes[fid] += w
            if not votes:
                continue
            best = max(sorted(votes.items()), key=lambda kv: kv[1])[0]
            pending[pid] = best
        if not pending:
            break
        primary.update(pending)
        inferred |= set(pending)

    return inferred


# ── 4. 环形排序 ──


def _ring_order(
    factions: List[Faction],
    primary: Dict[str, str],
    edges: List[GraphEdge],
) -> List[Faction]:
    """
    贪心链排序：从最大块起，每次接上与队尾共享连线最多的未排块。

    目的是让联系紧密的势力块在圆周上相邻，跨块长边不横穿整张图。
    """
    if len(factions) <= 2:
        return list(factions)

    ids = [f.faction_id for f in factions]
    id_set = set(ids)
    cross: Dict[Tuple[str, str], int] = defaultdict(int)
    for e in edges:
        fa = primary.get(e.person_a)
        fb = primary.get(e.person_b)
        if not fa or not fb or fa == fb:
            continue
        if fa not in id_set or fb not in id_set:
            continue
        key = (fa, fb) if fa < fb else (fb, fa)
        cross[key] += 1

    def link(a: str, b: str) -> int:
        return cross[(a, b) if a < b else (b, a)]

    size = {f.faction_id: len(f.members) for f in factions}
    total_link = {fid: sum(link(fid, o) for o in ids if o != fid) for fid in ids}

    remaining = set(ids)
    start = max(sorted(ids), key=lambda f: (size[f], total_link[f]))
    chain = [start]
    remaining.discard(start)

    while remaining:
        tail = chain[-1]
        nxt = max(
            sorted(remaining),
            key=lambda f: (link(tail, f), total_link[f], size[f]),
        )
        chain.append(nxt)
        remaining.discard(nxt)

    by_id = {f.faction_id: f for f in factions}
    return [by_id[fid] for fid in chain]


# ── 组装 + QA ──


def _build_graph_factions(
    ordered: List[Faction],
    primary: Dict[str, str],
    node_factions: Dict[str, List[str]],
    inferred: Set[str],
    edges: List[GraphEdge],
) -> List[GraphFaction]:
    """按环序组装 GraphFaction，并标出块内孤立成员（needs_review）。"""
    # 传播推断的人也要计入所属块的 member_ids
    extra_members: Dict[str, List[str]] = defaultdict(list)
    for pid in sorted(inferred):
        fid = primary.get(pid)
        if fid:
            extra_members[fid].append(pid)

    adj: Dict[str, Set[str]] = defaultdict(set)
    for e in edges:
        adj[e.person_a].add(e.person_b)
        adj[e.person_b].add(e.person_a)

    result: List[GraphFaction] = []
    for idx, f in enumerate(ordered):
        explicit = [m.person_id for m in f.members]
        # member_ids = 主势力落在本块的人（含传播推断）
        members = [pid for pid in explicit if primary.get(pid) == f.faction_id]
        members += extra_members.get(f.faction_id, [])
        all_members = sorted(set(explicit) | set(members))

        peer = set(all_members)
        review = []
        if len(all_members) >= _REVIEW_MIN_SIZE:
            review = [
                pid for pid in all_members if not (adj.get(pid, set()) & (peer - {pid}))
            ]

        result.append(
            GraphFaction(
                faction_id=f.faction_id,
                name=f.canonical_name,
                kind=f.kind.value if hasattr(f.kind, "value") else str(f.kind),
                order=idx,
                member_ids=sorted(set(members)),
                all_member_ids=all_members,
                inferred=f.inferred,
                needs_review=sorted(review),
            )
        )
    return result
