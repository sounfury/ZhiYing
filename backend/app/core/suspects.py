"""
SuspectsGenerator -- 可疑清单生成。

从 CastWriter._detect_conflicts 抽出人名冲突检测，新增关系冲突检测和缺证据检测。
输出结构化 SuspectList 供 Reconcile Agent 使用。

对应 design.md \u00a73 SuspectsGenerator。
"""
from __future__ import annotations

from collections import defaultdict
from typing import List

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


def detect_relation_conflicts(ledgers: list[ChapterLedger]) -> list[RelationConflict]:
    """
    检测同一 predicate 的双向断言，生成方向复查清单。

    只统计 directed 且未 rejected 的关系；同一对人物只在 a < b 一侧报一条。
    """
    # 不同类型可并存；只对相同已归一化语义的反向断言提示复查，不自动删除。
    # 先按（起点, 终点, predicate）索引各关系出现的章
    directions = defaultdict(list)
    for ledger in ledgers:
        for r in ledger.relations:
            if r.directed and r.predicate and r.status != "rejected":
                directions[(r.person_a, r.person_b, r.predicate)].append(ledger.chapter_id)
    # 与反向（b, a, 同 predicate）配对，命中即记为 direction_review
    results = []
    for (a, b, predicate), chapters in directions.items():
        reverse = directions.get((b, a, predicate))
        if reverse and a < b:
            results.append(RelationConflict(person_a=a, person_b=b, conflict_type="direction_review",
                details=f"{predicate} 有双向断言，检查是否互为此角色或有方向错误", chapters=sorted(set(chapters + reverse))))
    return results


def _has_evidence_localization_failure(relation) -> bool:
    """Return true only for an explicit evidence-location problem.

    ``pending`` is a semantic review state, not evidence that the quote is bad.
    Final Reconcile should only see evidence cases when deterministic location
    actually failed: the quote is missing, not found, or could not be narrowed
    to one concrete span. Rejected relations no longer need evidence repair.
    """
    if relation.status == "rejected":
        return False

    evidence = relation.evidence
    if not evidence.quote.strip():
        return True
    if evidence.quote_verified is False:
        return True
    if evidence.quote_verified is True and (evidence.start is None or evidence.end is None):
        return True
    return False


def detect_missing_evidence(ledgers: list[ChapterLedger]) -> list[MissingEvidence]:
    """Detect real evidence localization failures, not ordinary semantic pending."""
    return [
        MissingEvidence(
            person_a=r.person_a,
            person_b=r.person_b,
            label=r.label,
            chapter_id=ledger.chapter_id,
            reason=r.verification_reason or "证据无法唯一定位",
        )
        for ledger in ledgers
        for r in ledger.relations
        if _has_evidence_localization_failure(r)
    ]


# ── SuspectsGenerator ──


class SuspectsGenerator:
    """组合三个检测函数，生成 SuspectList。"""

    def generate(
        self,
        cast: Cast,
        ledgers: list[ChapterLedger],
    ) -> SuspectList:
        """依次运行人物冲突 / 关系方向 / 缺证据三类检测，汇总为 SuspectList。"""
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
