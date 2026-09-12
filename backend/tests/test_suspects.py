"""
单元测试：detect_cast_conflicts / detect_relation_conflicts / detect_missing_evidence。
"""
import sys
from pathlib import Path

# 确保 backend 包在 path 中
sys.path.insert(0, str(Path(__file__).parent.parent))

from relation_fixtures import relation_fields
from app.core.suspects import (
    detect_cast_conflicts,
    detect_relation_conflicts,
    detect_missing_evidence,
    SuspectsGenerator,
)
from app.models.cast import Alias, AliasFrequency, Cast, Person, Gender, Importance
from app.models.ledger import ChapterLedger, ChapterPerson, Evidence, Relation
from app.models.reconcile import SuspectList


# ── detect_cast_conflicts ──


def _make_person(pid: str, name: str, aliases: list[str] = None) -> Person:
    return Person(
        person_id=pid,
        canonical_name=name,
        aliases=[Alias(name=a, frequency=AliasFrequency.LOW) for a in (aliases or [])],
    )


def test_cast_conflict_alias_overlap():
    """别名重叠检测（仅别名重叠，无正式名交叉）。"""
    cast = Cast(version=1, persons=[
        _make_person("p001", "黛玉", ["林妹妹", "颦儿"]),
        _make_person("p002", "宝钗", ["林妹妹", "冷美人"]),
    ])
    conflicts = detect_cast_conflicts(cast)
    alias_ovl = [c for c in conflicts if c.reason == "alias_overlap"]
    assert len(alias_ovl) == 1
    assert alias_ovl[0].person_a_id == "p001"
    assert alias_ovl[0].person_b_id == "p002"
    assert "林妹妹" in alias_ovl[0].aliases_overlap


def test_cast_conflict_name_alias_cross():
    """正式名与别名交叉检测。"""
    cast = Cast(version=1, persons=[
        _make_person("p001", "宝玉", []),
        _make_person("p002", "贾宝玉", ["宝玉"]),
    ])
    conflicts = detect_cast_conflicts(cast)
    # p001.canonical_name="宝玉" 是 p002 的别名
    name_cross = [c for c in conflicts if c.reason == "name_alias_cross"]
    assert len(name_cross) == 1
    assert name_cross[0].aliases_overlap == ["宝玉"]


def test_cast_conflict_same_name_skip():
    """同 canonical_name 跳过。"""
    cast = Cast(version=1, persons=[
        _make_person("p001", "宝玉", []),
        _make_person("p002", "宝玉", []),
    ])
    conflicts = detect_cast_conflicts(cast)
    assert len(conflicts) == 0


def test_cast_no_conflicts():
    """无冲突。"""
    cast = Cast(version=1, persons=[
        _make_person("p001", "黛玉", ["林妹妹"]),
        _make_person("p002", "宝玉", ["宝哥哥"]),
    ])
    conflicts = detect_cast_conflicts(cast)
    assert len(conflicts) == 0


def test_cast_conflict_both_rules_single_entry():
    """同一对人同时命中 overlap + cross 时只报一条。"""
    cast = Cast(version=1, persons=[
        _make_person("p001", "黛玉", ["颦儿", "林妹妹"]),
        _make_person("p002", "林黛玉", ["颦儿", "黛玉"]),
    ])
    conflicts = detect_cast_conflicts(cast)
    assert len(conflicts) == 1
    c = conflicts[0]
    assert "alias_overlap" in c.reason
    assert "name_alias_cross" in c.reason
    assert "颦儿" in c.aliases_overlap
    assert "黛玉" in c.aliases_overlap


# ── detect_relation_conflicts ──


def test_different_semantics_can_coexist():
    """类型冲突：同一无向对在不同章给了不同 hard type。"""
    ch3 = ChapterLedger(
        chapter_id=3,
        relations=[Relation(
            person_a="p001", person_b="p005", **relation_fields("表亲"),
            evidence=Evidence(chapter_id=3),
        )],
    )
    ch5 = ChapterLedger(
        chapter_id=5,
        relations=[Relation(
            person_a="p001", person_b="p005", **relation_fields("夫妻"),
            evidence=Evidence(chapter_id=5),
        )],
    )
    conflicts = detect_relation_conflicts([ch3, ch5])
    assert not conflicts


def test_relation_conflict_direction_clash():
    """方向冲突：有向关系方向相反。"""
    ch3 = ChapterLedger(
        chapter_id=3,
        relations=[Relation(
            person_a="p001", person_b="p002", **relation_fields("师徒"),
            evidence=Evidence(chapter_id=3),
        )],
    )
    ch5 = ChapterLedger(
        chapter_id=5,
        relations=[Relation(
            person_a="p002", person_b="p001", **relation_fields("师徒"),
            evidence=Evidence(chapter_id=5),
        )],
    )
    conflicts = detect_relation_conflicts([ch3, ch5])
    assert len(conflicts) == 1
    assert conflicts[0].conflict_type == "direction_review"


def test_relation_no_conflict():
    """无冲突：同一对人同类型。"""
    ch3 = ChapterLedger(
        chapter_id=3,
        relations=[Relation(
            person_a="p001", person_b="p005", **relation_fields("夫妻"),
            evidence=Evidence(chapter_id=3),
        )],
    )
    ch5 = ChapterLedger(
        chapter_id=5,
        relations=[Relation(
            person_a="p001", person_b="p005", **relation_fields("夫妻"),
            evidence=Evidence(chapter_id=5),
        )],
    )
    conflicts = detect_relation_conflicts([ch3, ch5])
    assert len(conflicts) == 0


# ── detect_missing_evidence ──


def test_missing_evidence_hard_no_quote():
    """hard 关系缺原句。"""
    ledger = ChapterLedger(
        chapter_id=3,
        relations=[Relation(
            person_a="p001", person_b="p005", **relation_fields("夫妻"),
            evidence=Evidence(chapter_id=3, quote=""),
        )],
    )
    results = detect_missing_evidence([ledger])
    assert len(results) == 1
    assert results[0].person_a == "p001"
    assert results[0].label == "夫妻"
    assert results[0].chapter_id == 3


def test_missing_evidence_soft_no_quote_reported():
    """Soft relation with a real missing quote is still an evidence case."""
    ledger = ChapterLedger(
        chapter_id=3,
        relations=[Relation(
            person_a="p001", person_b="p005", **relation_fields("朋友"),
            evidence=Evidence(chapter_id=3, quote=""),
        )],
    )
    results = detect_missing_evidence([ledger])
    assert len(results) == 1


def test_semantic_pending_with_located_quote_is_not_missing_evidence():
    """Semantic pending stays in the ledger and must not become a Final case."""
    ledger = ChapterLedger(
        chapter_id=3,
        relations=[Relation(
            person_a="p001", person_b="p005", **relation_fields("朋友"),
            evidence=Evidence(
                chapter_id=3,
                quote="甲与乙仍是朋友。",
                quote_verified=True,
                start=10,
                end=18,
            ),
            status="pending",
            verification_reason="原文已定位，等待语义验证",
        )],
    )
    assert detect_missing_evidence([ledger]) == []


def test_twenty_ordinary_pending_relations_do_not_create_final_cases():
    """Phase 1 acceptance: ordinary pending review state is not a suspect source."""
    relations = []
    for i in range(20):
        relations.append(Relation(
            person_a=f"p{i:03d}",
            person_b=f"p{i + 100:03d}",
            **relation_fields("朋友"),
            evidence=Evidence(
                chapter_id=3,
                quote=f"证据原句{i}",
                quote_verified=True,
                start=i * 10,
                end=i * 10 + 5,
            ),
            status="pending",
            verification_reason="语义证据不足，保持 pending",
        ))
    ledger = ChapterLedger(chapter_id=3, relations=relations)
    assert detect_missing_evidence([ledger]) == []


def test_duplicate_quote_location_failure_is_still_reported():
    """A quote that exists but has no unique span remains a real evidence anomaly."""
    ledger = ChapterLedger(
        chapter_id=3,
        relations=[Relation(
            person_a="p001", person_b="p005", **relation_fields("朋友"),
            evidence=Evidence(
                chapter_id=3,
                quote="重复原句",
                quote_verified=True,
                start=None,
                end=None,
            ),
            status="pending",
            verification_reason="引用出现多次，请补充上下文以唯一定位",
        )],
    )
    results = detect_missing_evidence([ledger])
    assert len(results) == 1
    assert results[0].reason == "引用出现多次，请补充上下文以唯一定位"


def test_rejected_relation_does_not_create_evidence_repair_case():
    ledger = ChapterLedger(
        chapter_id=3,
        relations=[Relation(
            person_a="p001", person_b="p005", **relation_fields("朋友"),
            evidence=Evidence(chapter_id=3, quote="", quote_verified=False),
            status="rejected",
            verification_reason="关系已明确否定",
        )],
    )
    assert detect_missing_evidence([ledger]) == []


# ── SuspectsGenerator ──


def test_suspects_generator_with_conflicts():
    """有可疑项。"""
    cast = Cast(version=1, persons=[
        _make_person("p001", "黛玉", ["林妹妹"]),
        _make_person("p002", "林黛玉", ["林妹妹"]),
    ])
    ledgers = [ChapterLedger(
        chapter_id=1,
        relations=[Relation(
            person_a="p001", person_b="p005", **relation_fields("夫妻"),
            evidence=Evidence(chapter_id=1, quote=""),
        )],
    )]
    suspects = SuspectsGenerator().generate(cast, ledgers)
    assert not suspects.is_empty
    assert len(suspects.cast_conflicts) >= 1
    assert len(suspects.missing_evidence) == 1


def test_suspects_generator_empty():
    """无可疑项。"""
    cast = Cast(version=1, persons=[
        _make_person("p001", "黛玉", []),
        _make_person("p002", "宝玉", []),
    ])
    ledgers = [ChapterLedger(
        chapter_id=1,
        relations=[Relation(
            person_a="p001", person_b="p002", **relation_fields("朋友"),
            evidence=Evidence(chapter_id=1, quote="原文"),
            status="confirmed",
        )],
    )]
    suspects = SuspectsGenerator().generate(cast, ledgers)
    assert suspects.is_empty
