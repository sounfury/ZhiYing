"""
单元测试：detect_cast_conflicts / detect_relation_conflicts / detect_missing_evidence。
"""
import sys
from pathlib import Path

# 确保 backend 包在 path 中
sys.path.insert(0, str(Path(__file__).parent.parent))

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


def test_relation_conflict_type_clash():
    """类型冲突：同一无向对在不同章给了不同 hard type。"""
    ch3 = ChapterLedger(
        chapter_id=3,
        relations=[Relation(
            person_a="p001", person_b="p005", type="表亲",
            evidence=Evidence(chapter_id=3),
        )],
    )
    ch5 = ChapterLedger(
        chapter_id=5,
        relations=[Relation(
            person_a="p001", person_b="p005", type="夫妻",
            evidence=Evidence(chapter_id=5),
        )],
    )
    conflicts = detect_relation_conflicts([ch3, ch5])
    assert len(conflicts) == 1
    assert conflicts[0].conflict_type == "type_clash"
    assert 3 in conflicts[0].chapters
    assert 5 in conflicts[0].chapters


def test_relation_conflict_direction_clash():
    """方向冲突：有向关系方向相反。"""
    ch3 = ChapterLedger(
        chapter_id=3,
        relations=[Relation(
            person_a="p001", person_b="p002", type="师徒",
            evidence=Evidence(chapter_id=3),
        )],
    )
    ch5 = ChapterLedger(
        chapter_id=5,
        relations=[Relation(
            person_a="p002", person_b="p001", type="师徒",
            evidence=Evidence(chapter_id=5),
        )],
    )
    conflicts = detect_relation_conflicts([ch3, ch5])
    assert len(conflicts) == 1
    assert conflicts[0].conflict_type == "direction_clash"


def test_relation_no_conflict():
    """无冲突：同一对人同类型。"""
    ch3 = ChapterLedger(
        chapter_id=3,
        relations=[Relation(
            person_a="p001", person_b="p005", type="夫妻",
            evidence=Evidence(chapter_id=3),
        )],
    )
    ch5 = ChapterLedger(
        chapter_id=5,
        relations=[Relation(
            person_a="p001", person_b="p005", type="夫妻",
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
            person_a="p001", person_b="p005", type="夫妻",
            evidence=Evidence(chapter_id=3, quote=""),
        )],
    )
    results = detect_missing_evidence([ledger])
    assert len(results) == 1
    assert results[0].person_a == "p001"
    assert results[0].type == "夫妻"
    assert results[0].chapter_id == 3


def test_missing_evidence_soft_not_reported():
    """soft 关系缺 quote 不报。"""
    ledger = ChapterLedger(
        chapter_id=3,
        relations=[Relation(
            person_a="p001", person_b="p005", type="朋友",
            evidence=Evidence(chapter_id=3, quote=""),
        )],
    )
    results = detect_missing_evidence([ledger])
    assert len(results) == 0


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
            person_a="p001", person_b="p005", type="夫妻",
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
            person_a="p001", person_b="p002", type="朋友",
            evidence=Evidence(chapter_id=1, quote="原文"),
        )],
    )]
    suspects = SuspectsGenerator().generate(cast, ledgers)
    assert suspects.is_empty