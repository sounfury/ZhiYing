"""
SuspectsGenerator -- 可疑清单生成。

从 CastWriter._detect_conflicts 抽出人名冲突检测，新增关系冲突检测和缺证据检测。
输出结构化 SuspectList 供 Reconcile Agent 使用。

对应 design.md \u00a73 SuspectsGenerator。
"""
from __future__ import annotations

from collections import defaultdict
from typing import List

from app.domain.relation_types import is_directed, is_valid_type, normalize_undirected_pair
from app.logging_config import get_logger
from app.models.cast import Cast
from app.models.ledger import ChapterLedger
from app.models.reconcile import (
    CastConflict,
    MissingEvidence,
    RelationConflict,
    SuspectList,
)

logger = get_logger("core.suspects")


# ── 模块级检测函数 ──


def detect_cast_conflicts(cast: Cast) -> list[CastConflict]:
    """
    检测人名册中可能需合并的人物对。

    检测规则（canonical_name 不同才报）：
      - alias_overlap: 两人的别名集合有交集
      - name_alias_cross: A 的正式名 = B 的某个别名（或反之）
    """
    conflicts: list[CastConflict] = []
    persons = cast.persons

    for i in range(len(persons)):
        for j in range(i + 1, len(persons)):
            a = persons[i]
            b = persons[j]

            if a.canonical_name == b.canonical_name:
                continue  # 同名已被 CastWriter 合并

            a_aliases = {x.name for x in a.aliases}
            b_aliases = {x.name for x in b.aliases}

            reasons: list[str] = []
            names: set[str] = set()

            # 规则 1: 别名集合交集
            overlap = a_aliases & b_aliases
            if overlap:
                reasons.append("alias_overlap")
                names |= overlap

            # 规则 2: 正式名 = 对方别名（交叉匹配）
            if a.canonical_name in b_aliases:
                reasons.append("name_alias_cross")
                names.add(a.canonical_name)
            if b.canonical_name in a_aliases:
                if "name_alias_cross" not in reasons:
                    reasons.append("name_alias_cross")
                names.add(b.canonical_name)

            # 同一对只报一条，多规则用 + 连接
            if reasons:
                conflicts.append(CastConflict(
                    person_a_id=a.person_id,
                    person_b_id=b.person_id,
                    reason="+".join(reasons),
                    aliases_overlap=sorted(names),
                ))

    return conflicts


def detect_relation_conflicts(
    ledgers: list[ChapterLedger],
) -> list[RelationConflict]:
    """
    扫描全部 ledger，检测同一对人之间的关系冲突。

    冲突类型：
      1. type_clash: 同一无向对在不同章给了不同 hard type
      2. direction_clash: 同一有向关系对同一 type 方向相反
    """
    conflicts: list[RelationConflict] = []

    # 按 pair 分组：(pair_key, type) → [(chapter_id, directed, a, b)]
    # 用 (min_id, max_id) 作为无向 pair key
    undirected_map: dict[tuple[str, str], dict[str, list[tuple[int, str, str]]]] = defaultdict(lambda: defaultdict(list))
    # 有向: (from_id, to_id, type) → [(chapter_id, ...)]
    directed_map: dict[tuple[str, str, str], list[tuple[int, str, str]]] = defaultdict(list)

    for ledger in ledgers:
        cid = ledger.chapter_id
        for r in ledger.relations:
            if not is_valid_type(r.type):
                continue

            if r.directed:
                # 有向：(person_a→person_b, type)
                directed_map[(r.person_a, r.person_b, r.type)].append((cid, r.person_a, r.person_b))
            else:
                # 无向：(min_id, max_id, type)
                pair = tuple(sorted([r.person_a, r.person_b]))
                undirected_map[pair][r.type].append((cid, r.person_a, r.person_b))

    # 检测无向 type_clash: 同一对人有多个不同的 hard type
    for pair, type_map in undirected_map.items():
        # 只看 hard 类型
        hard_types = {
            rtype: entries
            for rtype, entries in type_map.items()
            if _is_hard_type(rtype)
        }
        if len(hard_types) > 1:
            all_chapters = sorted({
                cid
                for entries in hard_types.values()
                for cid, _, _ in entries
            })
            types_str = " vs ".join(hard_types.keys())
            conflicts.append(RelationConflict(
                person_a=pair[0],
                person_b=pair[1],
                conflict_type="type_clash",
                details=f"同一对人在不同章有不同 hard 关系类型: {types_str}",
                chapters=all_chapters,
            ))

    # 检测有向 direction_clash: 同一 type，方向相反
    for (a, b, rtype), entries in directed_map.items():
        # 检查是否存在反向 (b, a, rtype)
        reverse_key = (b, a, rtype)
        if reverse_key in directed_map:
            forward_chs = sorted({cid for cid, _, _ in entries})
            reverse_chs = sorted({cid for cid, _, _ in directed_map[reverse_key]})
            # 避免重复报告（forward+reverse 只报一次）
            if (a, b) <= (b, a):
                conflicts.append(RelationConflict(
                    person_a=a,
                    person_b=b,
                    conflict_type="direction_clash",
                    details=f"有向关系 {rtype} 方向冲突: {a}→{b} (ch {forward_chs}) vs {b}→{a} (ch {reverse_chs})",
                    chapters=sorted(set(forward_chs + reverse_chs)),
                ))

    return conflicts


def detect_missing_evidence(
    ledgers: list[ChapterLedger],
) -> list[MissingEvidence]:
    """
    检测 hard 关系但 evidence.quote 为空的条目。
    仅作"去查一下"提示，不阻塞主流程。
    """
    results: list[MissingEvidence] = []

    for ledger in ledgers:
        for r in ledger.relations:
            if not is_valid_type(r.type):
                continue
            if not _is_hard_type(r.type):
                continue
            if r.evidence.quote:
                continue
            results.append(MissingEvidence(
                person_a=r.person_a,
                person_b=r.person_b,
                type=r.type,
                chapter_id=ledger.chapter_id,
            ))

    return results


# ── SuspectsGenerator ──


class SuspectsGenerator:
    """组合三个检测函数，生成 SuspectList。"""

    def generate(
        self,
        cast: Cast,
        ledgers: list[ChapterLedger],
    ) -> SuspectList:
        cast_conflicts = detect_cast_conflicts(cast)
        relation_conflicts = detect_relation_conflicts(ledgers)
        missing_evidence = detect_missing_evidence(ledgers)

        logger.info(
            "Suspects generated: cast_conflicts=%d relation_conflicts=%d missing_evidence=%d",
            len(cast_conflicts),
            len(relation_conflicts),
            len(missing_evidence),
        )

        return SuspectList(
            cast_conflicts=cast_conflicts,
            relation_conflicts=relation_conflicts,
            missing_evidence=missing_evidence,
        )


# ── 辅助 ──


def _is_hard_type(type_name: str) -> bool:
    """判断关系类型是否为 hard tier。"""
    from app.domain.relation_types import get_tier, Tier
    tier = get_tier(type_name)
    return tier == Tier.HARD if tier else False