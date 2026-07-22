"""
单元测试：PatchApplier（merges / aliases / relation_changes / todos）。
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.core.patch_applier import PatchApplier
from app.models.cast import Alias, AliasFrequency, Cast, Person, Gender, Importance
from app.models.ledger import ChapterLedger, ChapterPerson, Evidence, Relation
from app.models.reconcile import (
    AliasSuggestion,
    MergeSuggestion,
    ReconcilePatch,
    RelationChange,
    TodoItem,
)
from app.storage.filestore import Filestore


def _setup_workspace() -> tuple[Filestore, str]:
    """创建临时 workspace 并写入测试数据。"""
    tmpdir = tempfile.mkdtemp()
    fs = Filestore(Path(tmpdir))
    book_id = "test-book"
    fs.create_book_dir(book_id)

    # 写入 cast
    cast = Cast(version=1, persons=[
        Person(
            person_id="p001",
            canonical_name="黛玉",
            aliases=[Alias(name="林妹妹", frequency=AliasFrequency.LOW)],
        ),
        Person(
            person_id="p002",
            canonical_name="宝玉",
            aliases=[Alias(name="宝哥哥", frequency=AliasFrequency.LOW)],
        ),
        Person(
            person_id="p003",
            canonical_name="林黛玉",
            aliases=[Alias(name="颦儿", frequency=AliasFrequency.LOW)],
        ),
    ])
    fs.write_cast(book_id, cast)

    # 写入 ledger
    ledger = ChapterLedger(
        chapter_id=1,
        persons=[
            ChapterPerson(person_id="p001", aliases_in_chapter=["林妹妹"]),
            ChapterPerson(person_id="p003", aliases_in_chapter=["颦儿"]),
            ChapterPerson(person_id="p002", aliases_in_chapter=["宝哥哥"]),
        ],
        relations=[
            Relation(
                person_a="p001", person_b="p002", type="朋友",
                evidence=Evidence(chapter_id=1, quote="原文1"),
            ),
            Relation(
                person_a="p003", person_b="p002", type="相识",
                evidence=Evidence(chapter_id=1, quote="原文2"),
            ),
        ],
        summary="第一章",
    )
    fs.write_ledger(book_id, ledger)

    return fs, book_id


def test_apply_merges():
    """合并两人：p003 → p001。"""
    fs, book_id = _setup_workspace()
    applier = PatchApplier(book_id, fs)

    patch = ReconcilePatch(
        merges=[MergeSuggestion(keep_id="p001", drop_id="p003", reason="alias_overlap")],
    )
    result = applier.apply(patch)

    assert result.merges_applied == 1

    # 检查 cast
    cast = fs.read_cast(book_id)
    person_ids = {p.person_id for p in cast.persons}
    assert "p003" not in person_ids
    assert "p001" in person_ids

    # p001 应包含 p003 的别名
    p001 = cast.get_person("p001")
    alias_names = {a.name for a in p001.aliases}
    assert "颦儿" in alias_names

    # 检查 ledger 中 p003 → p001
    ledger = fs.read_ledger(book_id, 1)
    for r in ledger.relations:
        assert r.person_a != "p003"
        assert r.person_b != "p003"
    # 应有一条 p001↔p002 的朋友关系
    friend_rel = [r for r in ledger.relations if r.type == "朋友"]
    assert any(r.person_a == "p001" and r.person_b == "p002" for r in friend_rel)


def test_apply_merges_self_loop_discard():
    """合并导致自环边丢弃。"""
    tmpdir = tempfile.mkdtemp()
    fs = Filestore(Path(tmpdir))
    book_id = "test-book"
    fs.create_book_dir(book_id)

    cast = Cast(version=1, persons=[
        Person(person_id="p001", canonical_name="黛", aliases=[]),
        Person(person_id="p002", canonical_name="玉", aliases=[]),
    ])
    fs.write_cast(book_id, cast)

    # p001 和 p002 之间有关系
    ledger = ChapterLedger(
        chapter_id=1,
        relations=[Relation(
            person_a="p001", person_b="p002", type="朋友",
            evidence=Evidence(chapter_id=1),
        )],
    )
    fs.write_ledger(book_id, ledger)

    applier = PatchApplier(book_id, fs)
    patch = ReconcilePatch(
        merges=[MergeSuggestion(keep_id="p001", drop_id="p002", reason="test")],
    )
    result = applier.apply(patch)
    assert result.merges_applied == 1

    # 自环边应被丢弃
    updated_ledger = fs.read_ledger(book_id, 1)
    assert len(updated_ledger.relations) == 0


def test_apply_aliases():
    """添加新别名，并 bump cast.version。"""
    fs, book_id = _setup_workspace()
    applier = PatchApplier(book_id, fs)
    version_before = fs.read_cast(book_id).version

    patch = ReconcilePatch(
        aliases=[AliasSuggestion(person_id="p001", new_aliases=["颦颦"])],
    )
    applier.apply(patch)

    cast = fs.read_cast(book_id)
    p001 = cast.get_person("p001")
    alias_names = {a.name for a in p001.aliases}
    assert "颦颦" in alias_names
    assert cast.version == version_before + 1


def test_apply_aliases_after_merge():
    """合并后给 remap 的 person 添加别名。"""
    fs, book_id = _setup_workspace()
    applier = PatchApplier(book_id, fs)

    patch = ReconcilePatch(
        merges=[MergeSuggestion(keep_id="p001", drop_id="p003", reason="test")],
        aliases=[AliasSuggestion(person_id="p003", new_aliases=["潇湘"])],
    )
    applier.apply(patch)

    cast = fs.read_cast(book_id)
    p001 = cast.get_person("p001")
    alias_names = {a.name for a in p001.aliases}
    assert "潇湘" in alias_names  # p003 remap 到 p001


def test_apply_relation_changes():
    """关系修改写入 overrides。"""
    fs, book_id = _setup_workspace()
    applier = PatchApplier(book_id, fs)

    patch = ReconcilePatch(
        relation_changes=[
            RelationChange(action="add", person_a="p001", person_b="p002", type="夫妻", chapter_id=1),
            RelationChange(action="remove", person_a="p001", person_b="p002", type="朋友", chapter_id=1, note="误标"),
        ],
    )
    applier.apply(patch)

    overrides = fs.read_relation_overrides(book_id)
    assert "add" in overrides
    assert "remove" in overrides
    assert any(e["type"] == "夫妻" for e in overrides["add"])
    assert any(e["type"] == "朋友" for e in overrides["remove"])


def test_apply_relation_changes_invalid_type():
    """非法 type 被跳过。"""
    fs, book_id = _setup_workspace()
    applier = PatchApplier(book_id, fs)

    patch = ReconcilePatch(
        relation_changes=[
            RelationChange(action="add", person_a="p001", person_b="p002", type="恋人", chapter_id=1),
        ],
    )
    applier.apply(patch)

    overrides = fs.read_relation_overrides(book_id)
    # "恋人" 不在枚举内，不应写入
    assert not any(e.get("type") == "恋人" for e in overrides.get("add", []))


def test_apply_todos():
    """写待办。"""
    fs, book_id = _setup_workspace()
    applier = PatchApplier(book_id, fs)

    patch = ReconcilePatch(
        todos=[
            TodoItem(description="检查 p002 关系", person_ids=["p002"], chapter_ids=[1]),
            TodoItem(description="补全证据"),
        ],
    )
    applier.apply(patch)

    todo_path = fs.todo_list_path(book_id)
    assert todo_path.exists()
    todos = json.loads(todo_path.read_text(encoding="utf-8"))
    assert len(todos) == 2
    assert todos[0]["description"] == "检查 p002 关系"


def test_apply_writes_report():
    """应用后写报告（patch_counts 为提交条数，非 suspects）。"""
    fs, book_id = _setup_workspace()
    applier = PatchApplier(book_id, fs)

    patch = ReconcilePatch(
        merges=[MergeSuggestion(keep_id="p001", drop_id="p003", reason="test")],
        todos=[TodoItem(description="test todo")],
    )
    result = applier.apply(patch)

    report_path = fs.reconcile_report_path(book_id)
    assert report_path.exists()
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert "timestamp" in report
    assert "suspects_count" not in report
    assert report["patch_counts"]["merges"] == 1
    assert report["patch_counts"]["todos"] == 1
    assert report["apply_result"]["merges_applied"] == 1
    assert report["apply_result"]["todos_written"] == 1


def test_merge_discards_override_self_loop():
    """merge 后 overrides 自环被丢弃。"""
    fs, book_id = _setup_workspace()
    fs.write_relation_overrides(book_id, {
        "add": [
            {"person_a": "p001", "person_b": "p003", "type": "朋友", "chapter_id": 1},
            {"person_a": "p001", "person_b": "p002", "type": "相识", "chapter_id": 1},
        ],
        "remove": [],
    })
    applier = PatchApplier(book_id, fs)
    applier.apply(ReconcilePatch(
        merges=[MergeSuggestion(keep_id="p001", drop_id="p003", reason="test")],
    ))
    overrides = fs.read_relation_overrides(book_id)
    # p001↔p003 变成自环应丢；p001↔p002 保留
    assert not any(
        e["person_a"] == e["person_b"] for e in overrides.get("add", [])
    )
    assert any(e["type"] == "相识" for e in overrides["add"])