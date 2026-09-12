"""
单元测试：Aggregator 汇总出图（docs/aggregator-design.md §8）。
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from relation_fixtures import relation_fields
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
                **relation_fields(t),
                status="confirmed",  # 聚合测试的输入是已经验证的事实
                evidence=Evidence(chapter_id=chapter_id, quote=q),
            )
        )
    return ChapterLedger(
        chapter_id=chapter_id,
        persons=[ChapterPerson(person_id=p) for p in persons],
        relations=rels,
        summary=f"ch{chapter_id}",
    )


def setup_relations():
    fs, book_id = _fs()
    _write_cast(fs, book_id, [_person("p001", "A"), _person("p002", "B"), _person("p003", "C")])
    fs.write_ledger(book_id, _ledger(1, ["p001", "p002"], [("p001", "p002", "朋友", "q1")]))
    fs.write_ledger(book_id, _ledger(2, ["p001", "p002", "p003"], [("p001", "p002", "朋友", "q2")]))
    return fs, book_id


def test_merge_same_predicate_across_chapters():
    fs, book_id = setup_relations()
    tag = Aggregator(book_id, fs).compile(GraphQuery(min_appearance=1)).edges[0].tags[0]
    assert tag.predicate == "friend_of"
    assert tag.chapter_ids == [1, 2]
    assert len(tag.relation_ids) == 2
    assert {e.quote for e in tag.evidences} == {"q1", "q2"}
    assert tag.display_score == 2.0  # 展示优先级 + 章数，不使用类型等级或引用存在性当可信度


def test_different_relations_coexist_without_suppression():
    fs, book_id = setup_relations()
    fs.write_ledger(book_id, _ledger(1, ["p001", "p002"], [
        ("p001", "p002", "夫妻", "q"), ("p001", "p002", "朋友", "q")]))
    graph = Aggregator(book_id, fs).compile(GraphQuery(min_appearance=1))
    assert {t.label for e in graph.edges for t in e.tags} == {"夫妻", "朋友"}


def test_directed_reverse_not_merged():
    fs, book_id = setup_relations()
    fs.write_ledger(book_id, _ledger(1, ["p001", "p002"], [
        ("p001", "p002", "亲子", "q"), ("p002", "p001", "亲子", "q")]))
    graph = Aggregator(book_id, fs).compile(GraphQuery(to_chapter=1))
    assert {(e.person_a, e.person_b) for e in graph.edges} == {("p001", "p002"), ("p002", "p001")}


def test_single_chapter_slice():
    fs, book_id = setup_relations()
    graph = Aggregator(book_id, fs).compile(GraphQuery(to_chapter=2, single_chapter=True))
    assert graph.chapter_range == [2, 2]
    assert graph.edges[0].tags[0].chapter_ids == [2]


def test_remove_exact_id_does_not_remove_other_chapter():
    fs, book_id = setup_relations()
    rid = fs.read_ledger(book_id, 1).relations[0].relation_id
    fs.write_relation_overrides(book_id, {"add": [], "remove": [{"relation_id": rid}]})
    graph = Aggregator(book_id, fs).compile(GraphQuery())
    assert graph.edges[0].tags[0].chapter_ids == [2]


def test_add_override_respects_chapter_slice_and_can_be_removed():
    fs, book_id = setup_relations()
    rel = _ledger(2, [], [("p001", "p002", "夫妻", "q")]).relations[0]
    fs.write_relation_overrides(book_id, {"add": [rel.model_dump()], "remove": []})
    graph = Aggregator(book_id, fs).compile(GraphQuery(to_chapter=1))
    assert {t.label for e in graph.edges for t in e.tags} == {"朋友"}
    fs.write_relation_overrides(book_id, {"add": [rel.model_dump()], "remove": [{"relation_id": rel.relation_id}]})
    assert {t.label for e in Aggregator(book_id, fs).compile().edges for t in e.tags} == {"朋友"}


def test_filter_by_predicate_and_category():
    fs, book_id = setup_relations()
    assert Aggregator(book_id, fs).compile(GraphQuery(predicate_filter=["friend_of"])).edges
    assert not Aggregator(book_id, fs).compile(GraphQuery(predicate_filter=["unknown"])).edges
    assert Aggregator(book_id, fs).compile(GraphQuery(category_filter=["社交"])).edges
    assert not Aggregator(book_id, fs).compile(GraphQuery(category_filter=["亲属"])).edges


def test_confirmed_unclassified_relation_is_preserved():
    fs, book_id = setup_relations()
    rel = Relation(person_a="p001", person_b="p002", label="意识共生", category="超自然",
                   definition="双方共享意识但保留独立人格", directed=False,
                   subject_role="共生者", object_role="共生者", raw_relation="甲乙共享意识",
                   status="confirmed", evidence=Evidence(chapter_id=1, quote="甲乙共享意识"))
    fs.write_ledger(book_id, ChapterLedger(chapter_id=1, relations=[rel]))
    graph = Aggregator(book_id, fs).compile(GraphQuery(to_chapter=1))
    assert graph.edges[0].tags[0].label == "意识共生"
    assert graph.edges[0].tags[0].predicate is None
    assert graph.unclassified_relation_count == 1


def test_pending_relation_does_not_keep_low_appearance_person():
    fs, book_id = setup_relations()
    ledger = fs.read_ledger(book_id, 1)
    ledger.relations[0].status = "pending"
    fs.write_ledger(book_id, ledger)
    graph = Aggregator(book_id, fs).compile(GraphQuery(to_chapter=1, min_appearance=2))
    assert not graph.edges
    assert graph.pending_relation_count == 1
    assert graph.filtered_count == 2


def test_empty_graph():
    fs, book_id = _fs()
    graph = Aggregator(book_id, fs).compile()
    assert graph.edges == [] and graph.chapter_range == []
