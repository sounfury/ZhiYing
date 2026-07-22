"""
单元测试：Aggregator 汇总出图（docs/aggregator-design.md §8）。
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.core.aggregator import Aggregator, GraphQuery
from app.models.book import AnalysisProgress, BookMeta, BookStatus
from app.models.cast import Alias, AliasFrequency, Cast, Importance, Person
from app.models.ledger import ChapterLedger, ChapterPerson, Evidence, Relation
from app.storage.filestore import Filestore


def _fs() -> tuple[Filestore, str]:
    tmp = tempfile.mkdtemp()
    fs = Filestore(Path(tmp))
    book_id = "agg-book"
    fs.create_book_dir(book_id)
    meta = BookMeta(
        book_id=book_id,
        title="Test",
        total_chapters=3,
        status=BookStatus.ANALYZED,
        analysis_progress=AnalysisProgress(
            chapters_done=[1, 2, 3],
            reconcile_done=True,
        ),
    )
    fs.write_meta(book_id, meta)
    return fs, book_id


def _person(pid: str, name: str, importance: Importance = Importance.MINOR) -> Person:
    return Person(
        person_id=pid,
        canonical_name=name,
        aliases=[Alias(name=f"{name}-别名", frequency=AliasFrequency.LOW)],
        importance=importance,
    )


def _write_cast(fs: Filestore, book_id: str, persons: list[Person]) -> None:
    fs.write_cast(book_id, Cast(version=1, persons=persons))


def _ledger(
    chapter_id: int,
    persons: list[str],
    relations: list[tuple],
) -> ChapterLedger:
    """
    relations: (a, b, type, quote?)
    """
    rels = []
    for item in relations:
        if len(item) == 3:
            a, b, t = item
            q = ""
        else:
            a, b, t, q = item
        rels.append(
            Relation(
                person_a=a,
                person_b=b,
                type=t,
                evidence=Evidence(chapter_id=chapter_id, quote=q),
            )
        )
    return ChapterLedger(
        chapter_id=chapter_id,
        persons=[ChapterPerson(person_id=p) for p in persons],
        relations=rels,
        summary=f"ch{chapter_id}",
    )


def test_merge_same_type_across_chapters():
    """两章同 pair 同 type → 一个 tag，chapter_ids 含两章，evidences 合并。"""
    fs, book_id = _fs()
    _write_cast(
        fs,
        book_id,
        [_person("p001", "A"), _person("p002", "B")],
    )
    fs.write_ledger(
        book_id,
        _ledger(1, ["p001", "p002"], [("p001", "p002", "朋友", "q1")]),
    )
    fs.write_ledger(
        book_id,
        _ledger(2, ["p001", "p002"], [("p001", "p002", "朋友", "q2")]),
    )

    data = Aggregator(book_id, fs).compile(GraphQuery(min_appearance=1))
    assert len(data.edges) == 1
    tags = data.edges[0].tags
    assert len(tags) == 1
    assert tags[0].type == "朋友"
    assert tags[0].chapter_ids == [1, 2]
    quotes = {e.quote for e in tags[0].evidences}
    assert "q1" in quotes and "q2" in quotes


def test_multi_type_one_edge():
    """同 pair 不同 type → 一条 edge，两个 tags。"""
    fs, book_id = _fs()
    _write_cast(
        fs,
        book_id,
        [_person("p001", "A"), _person("p002", "B")],
    )
    fs.write_ledger(
        book_id,
        _ledger(
            1,
            ["p001", "p002"],
            [
                ("p001", "p002", "朋友", "f"),
                ("p001", "p002", "结盟", "a"),
            ],
        ),
    )
    data = Aggregator(book_id, fs).compile(GraphQuery(min_appearance=1))
    assert len(data.edges) == 1
    types = {t.type for t in data.edges[0].tags}
    assert types == {"朋友", "结盟"}


def test_directed_not_merged_reverse():
    """有向不合并反边：A→B 亲子 与 B→A 亲子 分离。"""
    fs, book_id = _fs()
    _write_cast(
        fs,
        book_id,
        [_person("p001", "A"), _person("p002", "B")],
    )
    fs.write_ledger(
        book_id,
        _ledger(
            1,
            ["p001", "p002"],
            [
                ("p001", "p002", "亲子", "a is parent"),
                ("p002", "p001", "亲子", "b is parent"),
            ],
        ),
    )
    data = Aggregator(book_id, fs).compile(GraphQuery(min_appearance=1))
    assert len(data.edges) == 2
    keys = {(e.person_a, e.person_b) for e in data.edges}
    assert keys == {("p001", "p002"), ("p002", "p001")}


def test_hard_suppresses_soft_default():
    """hard+soft 同 pair：soft.suppressed；默认响应无 soft tag。"""
    fs, book_id = _fs()
    _write_cast(
        fs,
        book_id,
        [_person("p001", "A"), _person("p002", "B")],
    )
    fs.write_ledger(
        book_id,
        _ledger(
            1,
            ["p001", "p002"],
            [
                ("p001", "p002", "夫妻", "married"),
                ("p001", "p002", "朋友", "friends"),
            ],
        ),
    )
    data = Aggregator(book_id, fs).compile(GraphQuery(min_appearance=1))
    assert len(data.edges) == 1
    types = [t.type for t in data.edges[0].tags]
    assert types == ["夫妻"]

    data2 = Aggregator(book_id, fs).compile(
        GraphQuery(min_appearance=1, include_suppressed=True)
    )
    tags = {t.type: t for t in data2.edges[0].tags}
    assert "朋友" in tags
    assert tags["朋友"].suppressed is True
    assert tags["夫妻"].suppressed is False


def test_min_appearance_and_hard_exception():
    """min_appearance=2：仅 1 章路人进 filtered；有 hard 的 1 章人仍可见。"""
    fs, book_id = _fs()
    _write_cast(
        fs,
        book_id,
        [
            _person("p001", "主角", Importance.MAIN),
            _person("p002", "路人"),
            _person("p003", "硬关系人"),
            _person("p004", "配角"),
        ],
    )
    # ch1: all appear; hard between p001-p003
    fs.write_ledger(
        book_id,
        _ledger(
            1,
            ["p001", "p002", "p003", "p004"],
            [
                ("p001", "p003", "师徒", "master"),
                ("p001", "p002", "相识", "met"),
            ],
        ),
    )
    # ch2: only p001 and p004
    fs.write_ledger(
        book_id,
        _ledger(2, ["p001", "p004"], [("p001", "p004", "朋友", "f")]),
    )

    data = Aggregator(book_id, fs).compile(GraphQuery(min_appearance=2))
    node_ids = {n.person_id for n in data.nodes}
    # p001: main + 2 ch; p003: hard; p004: 2 ch; p002: 1 ch soft only → filtered
    assert "p001" in node_ids
    assert "p003" in node_ids
    assert "p004" in node_ids
    assert "p002" not in node_ids
    filtered_ids = {f.person_id for f in data.filtered_persons}
    assert "p002" in filtered_ids


def test_to_chapter_truncates():
    """to_chapter 截断：只用 ≤N 的章。"""
    fs, book_id = _fs()
    _write_cast(
        fs,
        book_id,
        [_person("p001", "A"), _person("p002", "B"), _person("p003", "C")],
    )
    fs.write_ledger(
        book_id,
        _ledger(1, ["p001", "p002"], [("p001", "p002", "朋友", "1")]),
    )
    fs.write_ledger(
        book_id,
        _ledger(2, ["p001", "p003"], [("p001", "p003", "朋友", "2")]),
    )
    fs.write_ledger(
        book_id,
        _ledger(3, ["p002", "p003"], [("p002", "p003", "夫妻", "3")]),
    )

    data = Aggregator(book_id, fs).compile(
        GraphQuery(to_chapter=1, min_appearance=1)
    )
    assert data.chapter_range == [1, 1]
    node_ids = {n.person_id for n in data.nodes}
    assert "p003" not in node_ids
    assert "p001" in node_ids and "p002" in node_ids
    assert all(
        max(t.chapter_ids) <= 1 for e in data.edges for t in e.tags
    )


def test_single_chapter_only():
    """single_chapter：只出指定章，不含此前累计。"""
    fs, book_id = _fs()
    _write_cast(
        fs,
        book_id,
        [_person("p001", "A"), _person("p002", "B"), _person("p003", "C")],
    )
    fs.write_ledger(
        book_id,
        _ledger(1, ["p001", "p002"], [("p001", "p002", "朋友", "c1")]),
    )
    fs.write_ledger(
        book_id,
        _ledger(2, ["p001", "p003"], [("p001", "p003", "夫妻", "c2")]),
    )
    fs.write_ledger(
        book_id,
        _ledger(3, ["p002", "p003"], [("p002", "p003", "相识", "c3")]),
    )

    data = Aggregator(book_id, fs).compile(
        GraphQuery(to_chapter=2, single_chapter=True, min_appearance=1)
    )
    assert data.chapter_range == [2, 2]
    node_ids = {n.person_id for n in data.nodes}
    assert "p001" in node_ids and "p003" in node_ids
    # 第 1 章的 p002-朋友 不应出现
    assert "p002" not in node_ids
    assert len(data.edges) == 1
    assert data.edges[0].tags[0].type == "夫妻"
    assert data.edges[0].tags[0].chapter_ids == [2]


def test_override_remove_with_chapter():
    """override remove 带 chapter：只掉该章。"""
    fs, book_id = _fs()
    _write_cast(
        fs,
        book_id,
        [_person("p001", "A"), _person("p002", "B")],
    )
    fs.write_ledger(
        book_id,
        _ledger(1, ["p001", "p002"], [("p001", "p002", "朋友", "1")]),
    )
    fs.write_ledger(
        book_id,
        _ledger(2, ["p001", "p002"], [("p001", "p002", "朋友", "2")]),
    )
    fs.write_relation_overrides(
        book_id,
        {
            "add": [],
            "remove": [
                {
                    "person_a": "p001",
                    "person_b": "p002",
                    "type": "朋友",
                    "chapter_id": 1,
                }
            ],
        },
    )
    data = Aggregator(book_id, fs).compile(GraphQuery(min_appearance=1))
    assert len(data.edges) == 1
    assert data.edges[0].tags[0].chapter_ids == [2]


def test_override_remove_all_chapters():
    """override remove 不带 chapter：该 pair+type 全掉。"""
    fs, book_id = _fs()
    _write_cast(
        fs,
        book_id,
        [_person("p001", "A"), _person("p002", "B")],
    )
    fs.write_ledger(
        book_id,
        _ledger(1, ["p001", "p002"], [("p001", "p002", "朋友", "1")]),
    )
    fs.write_ledger(
        book_id,
        _ledger(2, ["p001", "p002"], [("p001", "p002", "朋友", "2")]),
    )
    fs.write_relation_overrides(
        book_id,
        {
            "add": [],
            "remove": [
                {"person_a": "p001", "person_b": "p002", "type": "朋友"}
            ],
        },
    )
    data = Aggregator(book_id, fs).compile(GraphQuery(min_appearance=1))
    assert data.edges == []


def test_override_add():
    """override add：图上出现新 tag。"""
    fs, book_id = _fs()
    _write_cast(
        fs,
        book_id,
        [_person("p001", "A"), _person("p002", "B")],
    )
    fs.write_ledger(
        book_id,
        _ledger(1, ["p001", "p002"], []),
    )
    fs.write_relation_overrides(
        book_id,
        {
            "add": [
                {
                    "person_a": "p001",
                    "person_b": "p002",
                    "type": "夫妻",
                    "chapter_id": 1,
                    "quote": "patch",
                }
            ],
            "remove": [],
        },
    )
    data = Aggregator(book_id, fs).compile(GraphQuery(min_appearance=1))
    assert len(data.edges) == 1
    assert data.edges[0].tags[0].type == "夫妻"
    assert data.edges[0].tags[0].evidences[0].quote == "patch"


def test_invalid_type_and_unknown_person_skipped():
    """非法 type / 未知 person 跳过，其余正常。"""
    fs, book_id = _fs()
    _write_cast(
        fs,
        book_id,
        [_person("p001", "A"), _person("p002", "B")],
    )
    # ledger with valid relation only (invalid type can't construct Relation model)
    fs.write_ledger(
        book_id,
        _ledger(1, ["p001", "p002"], [("p001", "p002", "朋友", "ok")]),
    )
    fs.write_relation_overrides(
        book_id,
        {
            "add": [
                {
                    "person_a": "p001",
                    "person_b": "p002",
                    "type": "不是合法类型",
                    "chapter_id": 1,
                },
                {
                    "person_a": "p001",
                    "person_b": "p999",
                    "type": "夫妻",
                    "chapter_id": 1,
                },
            ],
            "remove": [],
        },
    )
    data = Aggregator(book_id, fs).compile(GraphQuery(min_appearance=1))
    assert len(data.edges) == 1
    assert data.edges[0].tags[0].type == "朋友"


def test_empty_ledger_empty_graph():
    """无 ledger → 空图。"""
    fs, book_id = _fs()
    _write_cast(fs, book_id, [_person("p001", "A")])
    data = Aggregator(book_id, fs).compile(GraphQuery())
    assert data.nodes == []
    assert data.edges == []
    assert data.chapter_range == []


def test_type_filter_does_not_kill_hard_visibility():
    """type_filter 只滤 tag；hard 路人规则仍用全量 hard。"""
    fs, book_id = _fs()
    _write_cast(
        fs,
        book_id,
        [_person("p001", "A"), _person("p002", "B")],
    )
    fs.write_ledger(
        book_id,
        _ledger(
            1,
            ["p001", "p002"],
            [
                ("p001", "p002", "夫妻", "m"),
                ("p001", "p002", "朋友", "f"),
            ],
        ),
    )
    data = Aggregator(book_id, fs).compile(
        GraphQuery(min_appearance=99, type_filter=["朋友"])
    )
    # both visible due to hard even though hard tag filtered out of output
    node_ids = {n.person_id for n in data.nodes}
    assert "p001" in node_ids and "p002" in node_ids
    # only 朋友 tag in output — but soft suppressed by hard → empty tags → no edge
    # with include_suppressed false, 朋友 is suppressed, so no edges
    assert data.edges == []

    data2 = Aggregator(book_id, fs).compile(
        GraphQuery(
            min_appearance=99,
            type_filter=["朋友"],
            include_suppressed=True,
        )
    )
    assert len(data2.edges) == 1
    assert data2.edges[0].tags[0].type == "朋友"
    assert data2.edges[0].tags[0].suppressed is True


def test_main_always_visible():
    """importance=main 即使 0 次出现也可见（cast 中有、无 ledger 出现时 count=0）。"""
    fs, book_id = _fs()
    _write_cast(
        fs,
        book_id,
        [
            _person("p001", "主角", Importance.MAIN),
            _person("p002", "路人"),
        ],
    )
    fs.write_ledger(
        book_id,
        _ledger(1, ["p002"], []),
    )
    data = Aggregator(book_id, fs).compile(GraphQuery(min_appearance=2))
    node_ids = {n.person_id for n in data.nodes}
    assert "p001" in node_ids
    assert "p002" not in node_ids


def test_display_score_formula():
    """score = tier_base + 0.5*chapters + (1 if quote)."""
    fs, book_id = _fs()
    _write_cast(
        fs,
        book_id,
        [_person("p001", "A"), _person("p002", "B")],
    )
    fs.write_ledger(
        book_id,
        _ledger(1, ["p001", "p002"], [("p001", "p002", "夫妻", "q")]),
    )
    fs.write_ledger(
        book_id,
        _ledger(2, ["p001", "p002"], [("p001", "p002", "夫妻", "")]),
    )
    data = Aggregator(book_id, fs).compile(GraphQuery(min_appearance=1))
    # hard base 5 + 0.5*2 + 1 (quote) = 7.0
    assert data.edges[0].tags[0].display_score == 7.0
