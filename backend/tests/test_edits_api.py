"""
API 测试：PUT /cast、PUT /relations、GET /export、POST /cast/merge、POST /rerun。
"""
from __future__ import annotations

import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi.testclient import TestClient

from relation_fixtures import relation_fields
from app.agent.chapter_agent import AgentResult
from app.core.aggregator import Aggregator, GraphQuery
from app.core.reconcile_service import ReconcileOutcome
from app.config import Settings
from app.main import app
from app.models.book import AnalysisProgress, BookMeta, BookStatus, Chapter
from app.models.cast import Alias, AliasFrequency, Cast, Gender, Importance, Person
from app.models.ledger import ChapterLedger, ChapterPerson, Evidence, Relation
from app.storage.filestore import Filestore, get_filestore


def _fs() -> tuple[Filestore, str]:
    tmp = tempfile.mkdtemp()
    fs = Filestore(Path(tmp))
    book_id = "edit-book"
    fs.create_book_dir(book_id)
    meta = BookMeta(
        book_id=book_id,
        title="Test",
        total_chapters=2,
        status=BookStatus.ANALYZED,
        analysis_progress=AnalysisProgress(
            chapters_done=[1, 2],
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
        gender=Gender.UNKNOWN,
        importance=importance,
        bio="",
    )


def _write_cast(fs: Filestore, book_id: str, persons: list[Person], version: int = 1) -> None:
    fs.write_cast(book_id, Cast(version=version, persons=persons))


def _ledger(chapter_id: int, persons: list[str], relations: list[tuple]) -> ChapterLedger:
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
                status="confirmed",  # 测试人工编辑对已确认图谱的覆盖
                evidence=Evidence(chapter_id=chapter_id, quote=q),
            )
        )
    return ChapterLedger(
        chapter_id=chapter_id,
        persons=[ChapterPerson(person_id=p) for p in persons],
        relations=rels,
        summary=f"ch{chapter_id}",
        analysis_status="complete",
    )


def _write_chapter(fs: Filestore, book_id: str, cid: int) -> None:
    fs.write_chapter(
        book_id,
        Chapter(
            chapter_id=cid,
            title=f"第{cid}章",
            order=cid,
            content=f"正文{cid}",
            word_count=10,
        ),
    )


@contextmanager
def api_client(fs: Filestore):
    app.dependency_overrides[get_filestore] = lambda: fs
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


def _seed_two_person_book() -> tuple[Filestore, str]:
    fs, book_id = _fs()
    _write_cast(fs, book_id, [_person("p001", "A"), _person("p002", "B")])
    fs.write_ledger(
        book_id,
        _ledger(1, ["p001", "p002"], [("p001", "p002", "朋友", "q1")]),
    )
    fs.write_ledger(
        book_id,
        _ledger(2, ["p001", "p002"], [("p001", "p002", "相识", "q2")]),
    )
    _write_chapter(fs, book_id, 1)
    _write_chapter(fs, book_id, 2)
    fs.write_extraction_base_cast(book_id, fs.read_cast(book_id))
    for cid in (1, 2):
        fs.write_extraction_result(book_id, cid, fs.read_ledger(book_id, cid), {})
    fs.save_pre_reconcile_state(book_id, [1, 2])
    return fs, book_id


# ── PUT /cast ──


def test_put_cast_updates_fields_bumps_version_keeps_ids():
    fs, book_id = _seed_two_person_book()
    with api_client(fs) as c:
        r = c.put(
            f"/api/books/{book_id}/cast",
            json={
                "version": 99,
                "persons": [
                    {
                        "person_id": "p001",
                        "canonical_name": "贾宝玉",
                        "aliases": [{"name": "宝玉", "frequency": "high"}],
                        "bio": "衔玉而生",
                        "gender": "male",
                        "importance": "main",
                    }
                ],
            },
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["version"] == 2  # bumped from 1; client 99 ignored
    ids = {p["person_id"] for p in body["persons"]}
    assert ids == {"p001", "p002"}  # omitted p002 kept; ids not rewritten
    p001 = next(p for p in body["persons"] if p["person_id"] == "p001")
    assert p001["canonical_name"] == "贾宝玉"
    assert p001["gender"] == "male"
    assert p001["importance"] == "main"
    assert p001["bio"] == "衔玉而生"
    assert p001["aliases"][0]["name"] == "宝玉"
    # disk matches
    saved = fs.read_cast(book_id)
    assert saved.version == 2
    assert saved.get_person("p001").canonical_name == "贾宝玉"
    assert saved.get_person("p002").canonical_name == "B"


def test_put_cast_404_and_409():
    fs, book_id = _seed_two_person_book()
    with api_client(fs) as c:
        r = c.put("/api/books/no-such-book/cast", json={"persons": []})
        assert r.status_code == 404
        assert r.json()["code"] == "BOOK_NOT_FOUND"

        meta = fs.read_meta(book_id)
        meta.status = BookStatus.ANALYZING
        fs.write_meta(book_id, meta)
        r = c.put(
            f"/api/books/{book_id}/cast",
            json={"persons": [{"person_id": "p001", "canonical_name": "X"}]},
        )
        assert r.status_code == 409
        assert r.json()["code"] == "ANALYSIS_ALREADY_RUNNING"


# ── PUT /relations ──


def test_put_relations_replaces_and_graph_reflects_add_remove():
    fs, book_id = _seed_two_person_book()
    rel = _ledger(1, [], [("p001", "p002", "夫妻", "人工补录")]).relations[0]
    removed = fs.read_ledger(book_id, 1).relations[0].relation_id
    with api_client(fs) as c:
        response = c.put(f"/api/books/{book_id}/relations", json={"add": [rel.model_dump()], "remove": [removed]})
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["add"][0]["label"] == "夫妻"
    assert saved["add"][0]["status"] == "confirmed"
    assert saved == fs.read_relation_overrides(book_id)
    labels = {t.label for e in Aggregator(book_id, fs).compile(GraphQuery(min_appearance=1)).edges for t in e.tags}
    assert labels == {"夫妻", "相识"}


def test_put_relations_new_semantics_and_unknown_person():
    fs, book_id = _seed_two_person_book()
    relation = Relation(person_a="p001", person_b="p002", label="同门", category="师承",
        definition="双方有相同师承", directed=False, subject_role="同门", object_role="同门",
        raw_relation="甲乙同出一门", evidence=Evidence(chapter_id=1, quote="人工确认"))
    with api_client(fs) as c:
        response = c.put(f"/api/books/{book_id}/relations", json={"add": [relation.model_dump()], "remove": []})
        assert response.status_code == 200, response.text
        key = response.json()["add"][0]["predicate"]
        assert key.startswith("rel_")
        definitions = c.get(f"/api/books/{book_id}/relation-types").json()["relation_types"]
        assert any(d["predicate"] == key and d["label"] == "同门" for d in definitions)
        graph = c.get(f"/api/books/{book_id}/graph", params={"predicate_filter": key}).json()
        assert [tag["label"] for edge in graph["edges"] for tag in edge["tags"]] == ["同门"]
        graph = c.get(f"/api/books/{book_id}/graph", params={"category_filter": "师承"}).json()
        assert [tag["predicate"] for edge in graph["edges"] for tag in edge["tags"]] == [key]
        relation.person_b = "p999"
        response = c.put(f"/api/books/{book_id}/relations", json={"add": [relation.model_dump()], "remove": []})
        assert response.status_code == 400


def test_put_relations_409_when_analyzing():
    fs, book_id = _seed_two_person_book()
    meta = fs.read_meta(book_id)
    meta.status = BookStatus.RECONCILING
    fs.write_meta(book_id, meta)
    with api_client(fs) as c:
        r = c.put(
            f"/api/books/{book_id}/relations",
            json={"add": [], "remove": []},
        )
    assert r.status_code == 409


# ── GET /export ──


def test_get_export_bundle():
    fs, book_id = _seed_two_person_book()
    rel = _ledger(1, [], [("p001", "p002", "夫妻", "q")]).relations[0]
    fs.write_relation_overrides(book_id, {"add": [rel.model_dump()], "remove": []})
    with api_client(fs) as c:
        r = c.get(f"/api/books/{book_id}/export")
    assert r.status_code == 200, r.text
    assert "attachment" in r.headers.get("content-disposition", "")
    bundle = r.json()
    assert set(bundle.keys()) >= {
        "meta",
        "cast",
        "factions",
        "relation_overrides",
        "graph",
        "ledgers",
    }
    assert bundle["meta"]["book_id"] == book_id
    assert bundle["cast"]["version"] == 1
    assert bundle["relation_overrides"]["add"][0]["label"] == "夫妻"
    assert bundle["graph"]["book_id"] == book_id
    assert len(bundle["ledgers"]) == 2
    types = {t["label"] for e in bundle["graph"]["edges"] for t in e["tags"]}
    assert "夫妻" in types


def test_get_export_404_and_409():
    fs, book_id = _seed_two_person_book()
    with api_client(fs) as c:
        r = c.get("/api/books/missing/export")
        assert r.status_code == 404

        meta = fs.read_meta(book_id)
        meta.status = BookStatus.ANALYZING
        fs.write_meta(book_id, meta)
        r = c.get(f"/api/books/{book_id}/export")
        assert r.status_code == 409


# ── POST /cast/merge ──


def test_merge_persons_rewrites_ledger_and_drops_self_loop():
    fs, book_id = _fs()
    _write_cast(
        fs,
        book_id,
        [
            _person("p001", "黛玉"),
            _person("p002", "宝玉"),
            Person(
                person_id="p003",
                canonical_name="林黛玉",
                aliases=[Alias(name="颦儿", frequency=AliasFrequency.LOW)],
            ),
        ],
    )
    fs.write_ledger(
        book_id,
        _ledger(
            1,
            ["p001", "p002", "p003"],
            [
                ("p001", "p002", "朋友", "a"),
                ("p001", "p003", "相识", "self-loop-after-merge"),
            ],
        ),
    )
    with api_client(fs) as c:
        r = c.post(
            f"/api/books/{book_id}/cast/merge",
            json={"keep_id": "p001", "drop_id": "p003"},
        )
    assert r.status_code == 200, r.text
    body = r.json()
    ids = {p["person_id"] for p in body["persons"]}
    assert "p003" not in ids
    assert "p001" in ids
    p001 = next(p for p in body["persons"] if p["person_id"] == "p001")
    alias_names = {a["name"] for a in p001["aliases"]}
    assert "颦儿" in alias_names

    ledger = fs.read_ledger(book_id, 1)
    for rel in ledger.relations:
        assert rel.person_a != "p003" and rel.person_b != "p003"
        assert rel.person_a != rel.person_b
    # 朋友 p001↔p002 仍在；相识 p001↔p003 变自环已丢
    types = {r.label for r in ledger.relations}
    assert "朋友" in types
    assert "相识" not in types


def test_merge_404_409_and_unknown_id():
    fs, book_id = _seed_two_person_book()
    with api_client(fs) as c:
        r = c.post(
            "/api/books/nope/cast/merge",
            json={"keep_id": "p001", "drop_id": "p002"},
        )
        assert r.status_code == 404

        r = c.post(
            f"/api/books/{book_id}/cast/merge",
            json={"keep_id": "p001", "drop_id": "p999"},
        )
        assert r.status_code == 400

        r = c.post(
            f"/api/books/{book_id}/cast/merge",
            json={"keep_id": "p001", "drop_id": "p001"},
        )
        assert r.status_code == 400

        meta = fs.read_meta(book_id)
        meta.status = BookStatus.ANALYZING
        fs.write_meta(book_id, meta)
        r = c.post(
            f"/api/books/{book_id}/cast/merge",
            json={"keep_id": "p001", "drop_id": "p002"},
        )
        assert r.status_code == 409


# ── POST /rerun ──


def test_rerun_404_and_409():
    fs, book_id = _seed_two_person_book()
    with api_client(fs) as c:
        r = c.post("/api/books/nope/chapters/1/rerun")
        assert r.status_code == 404

        r = c.post(f"/api/books/{book_id}/chapters/99/rerun")
        assert r.status_code == 404

        meta = fs.read_meta(book_id)
        meta.status = BookStatus.ANALYZING
        fs.write_meta(book_id, meta)
        r = c.post(f"/api/books/{book_id}/chapters/1/rerun")
        assert r.status_code == 409
        assert r.json()["code"] == "ANALYSIS_ALREADY_RUNNING"


def test_rerun_overwrites_one_chapter_only():
    fs, book_id = _seed_two_person_book()
    old_ch2 = fs.read_ledger(book_id, 2)

    new_ledger = _ledger(
        1,
        ["p001", "p002"],
        [("p001", "p002", "夫妻", "rerun-quote")],
    )

    async def fake_agent(
        book_id, chapter_id, cast_snapshot, filestore, cfg=None, stop_event=None, control=None
    ):
        filestore.write_ledger(book_id, new_ledger)
        return AgentResult(
            chapter_id=chapter_id,
            ledger=new_ledger,
            success=True,
            steps_used=3,
        )

    async def fake_reconcile(meta, filestore, cfg, **kwargs):
        meta.status = BookStatus.ANALYZED
        meta.analysis_progress.reconcile_done = True
        filestore.write_meta(meta.book_id, meta)
        return ReconcileOutcome(BookStatus.ANALYZED, True)

    test_settings = Settings(auto_extract_factions=False, llm_api_key="")
    with patch("app.core.orchestrator.run_chapter_agent", new=fake_agent), \
         patch("app.core.orchestrator.enrich_ledger", new=AsyncMock(return_value=None)), \
         patch("app.core.orchestrator.reconcile_book", new=fake_reconcile), \
         patch("app.api.edits.settings", test_settings):
        with api_client(fs) as c:
            r = c.post(f"/api/books/{book_id}/chapters/1/rerun")
    assert r.status_code == 200, r.text
    assert r.json()["success"] is True
    assert r.json()["chapter_id"] == 1
    assert r.json()["status"] in {"analyzed", "partial", "reconcile_failed"}

    ch1 = fs.read_ledger(book_id, 1)
    assert ch1.relations[0].label == "夫妻"
    assert ch1.relations[0].evidence.quote == "rerun-quote"
    ch2 = fs.read_ledger(book_id, 2)
    assert ch2.model_dump() == old_ch2.model_dump()
    meta = fs.read_meta(book_id)
    assert meta.status == BookStatus.ANALYZED
    assert 1 in meta.analysis_progress.chapters_done
