"""Safe rerun / reconcile transaction tests. All model paths are mocked."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from app.agent.chapter_agent import AgentResult
from app.agent.reconcile_agent import ReconcileResult
from app.config import Settings
from app.core.orchestrator import Orchestrator
from app.core.rebuild import record_human_cast_update
from app.core.reconcile_service import ReconcileOutcome, reconcile_book
from app.errors import AppError
from app.models.book import AnalysisProgress, BookMeta, BookStatus, Chapter
from app.models.cast import Cast, Person
from app.models.ledger import ChapterLedger, ChapterPerson, Evidence, Relation
from app.models.reconcile import PatchApplyResult, ReconcilePatch
from app.storage.filestore import Filestore


def _relation(relation_id: str | None = None, *, label: str = "朋友", quote: str = "甲和乙是朋友。") -> Relation:
    kwargs = {}
    if relation_id is not None:
        kwargs["relation_id"] = relation_id
    return Relation(
        person_a="p001", person_b="p002", label=label, category="社交",
        definition="双方具有稳定友好往来", directed=False,
        subject_role="朋友", object_role="朋友", raw_relation=label,
        status="confirmed", evidence=Evidence(chapter_id=1, quote=quote, quote_verified=True),
        **kwargs,
    )


def _setup(tmp_path) -> Filestore:
    fs = Filestore(tmp_path)
    fs.create_book_dir("b")
    meta = BookMeta(
        book_id="b", title="T", total_chapters=1, status=BookStatus.ANALYZED,
        analysis_progress=AnalysisProgress(chapters_done=[1], reconcile_done=True),
    )
    fs.write_meta("b", meta)
    cast = Cast(persons=[
        Person(person_id="p001", canonical_name="甲"),
        Person(person_id="p002", canonical_name="乙"),
    ])
    fs.write_cast("b", cast)
    fs.write_chapter("b", Chapter(chapter_id=1, order=1, content="甲和乙是朋友。"))
    ledger = ChapterLedger(
        chapter_id=1, analysis_status="complete", summary="old",
        persons=[ChapterPerson(person_id="p001"), ChapterPerson(person_id="p002")],
        relations=[_relation("old-r")],
    )
    fs.write_ledger("b", ledger)
    fs.write_extraction_base_cast("b", cast)
    fs.write_extraction_result("b", 1, ledger, {})
    fs.save_pre_reconcile_state("b", [1])
    return fs


def test_rerun_extraction_failure_keeps_published_data(tmp_path):
    async def run():
        fs = _setup(tmp_path)
        old_cast = fs.read_cast("b").model_dump()
        old_ledger = fs.read_ledger("b", 1).model_dump()
        fs.write_relation_overrides("b", {"add": [_relation("human-r", label="同伴").model_dump(mode="json")], "remove": []})
        fs.write_reconcile_overrides("b", {"add": [_relation("auto-r", label="熟人").model_dump(mode="json")], "remove": []})
        old_manual = fs.read_relation_overrides("b")
        old_auto = fs.read_reconcile_overrides("b")

        async def fail_agent(*args, **kwargs):
            return AgentResult(chapter_id=1, success=False, warning="mock extraction failure")

        orch = Orchestrator("b", fs, Settings(auto_extract_factions=False, llm_api_key=""))
        with patch("app.core.orchestrator.run_chapter_agent", new=fail_agent):
            with pytest.raises(AppError):
                await orch.rerun_chapter(1)

        assert fs.read_cast("b").model_dump() == old_cast
        assert fs.read_ledger("b", 1).model_dump() == old_ledger
        assert fs.read_relation_overrides("b") == old_manual
        assert fs.read_reconcile_overrides("b") == old_auto
        assert fs.read_meta("b").status == BookStatus.ANALYZED
        assert not (fs.root / ".staging").exists() or not any((fs.root / ".staging").iterdir())
    asyncio.run(run())


def test_reconcile_apply_exception_restores_baseline(tmp_path):
    async def run():
        fs = _setup(tmp_path)
        baseline_cast = fs.read_cast("b").model_dump()
        meta = fs.read_meta("b")
        cfg = Settings(force_reconcile=True, auto_extract_factions=False, llm_api_key="")

        async def fake_reconcile_agent(*args, **kwargs):
            return ReconcileResult(success=True, patch=ReconcilePatch(), steps_used=1)

        def explode_after_mutation(self, patch):
            cast = self.filestore.read_cast(self.book_id)
            cast.persons[0].canonical_name = "BROKEN"
            self.filestore.write_cast(self.book_id, cast)
            raise RuntimeError("apply exploded")

        with patch("app.core.reconcile_service.run_reconcile_agent", new=fake_reconcile_agent), \
             patch("app.core.reconcile_service.PatchApplier.apply", new=explode_after_mutation):
            outcome = await reconcile_book(meta, fs, cfg)

        assert outcome.status == BookStatus.RECONCILE_FAILED
        assert fs.read_cast("b").model_dump() == baseline_cast
        assert fs.read_reconcile_overrides("b") == {"add": [], "remove": []}
    asyncio.run(run())


def test_rerun_preserves_human_cast_and_relation_overrides_replaces_auto(tmp_path):
    async def run():
        fs = _setup(tmp_path)
        # Human cast edit is made after the pre-reconcile baseline was saved.
        cast = fs.read_cast("b")
        edited = cast.get_person("p001").model_copy(deep=True)
        edited.canonical_name = "甲（人工名）"
        cast.get_person("p001").canonical_name = edited.canonical_name
        fs.write_cast("b", cast)
        record_human_cast_update(fs, "b", [edited])
        manual = {"add": [_relation("human-r", label="同伴").model_dump(mode="json")], "remove": []}
        old_auto = {"add": [_relation("auto-old", label="熟人").model_dump(mode="json")], "remove": []}
        fs.write_relation_overrides("b", manual)
        fs.write_reconcile_overrides("b", old_auto)

        new_ledger = ChapterLedger(
            chapter_id=1, analysis_status="complete", summary="new",
            persons=[ChapterPerson(person_id="p001"), ChapterPerson(person_id="p002")],
            relations=[],
        )

        async def fake_agent(book_id, cid, cast_snapshot, store, cfg, stop_event=None, control=None):
            assert cast_snapshot.get_person("p001").canonical_name == "甲（人工名）"
            store.write_ledger(book_id, new_ledger)
            return AgentResult(chapter_id=cid, ledger=new_ledger, success=True, steps_used=1)

        async def fake_reconcile(meta, store, cfg, **kwargs):
            store.write_reconcile_overrides(
                meta.book_id,
                {"add": [_relation("auto-new", label="新自动关系").model_dump(mode="json")], "remove": []},
            )
            meta.status = BookStatus.ANALYZED
            meta.analysis_progress.reconcile_done = True
            store.write_meta(meta.book_id, meta)
            return ReconcileOutcome(BookStatus.ANALYZED, True)

        orch = Orchestrator("b", fs, Settings(auto_extract_factions=False, llm_api_key=""))
        with patch("app.core.orchestrator.run_chapter_agent", new=fake_agent), \
             patch("app.core.orchestrator.enrich_ledger", new=AsyncMock(return_value=None)), \
             patch("app.core.orchestrator.reconcile_book", new=fake_reconcile):
            response = await orch.rerun_chapter(1)

        assert response["success"] is True
        assert fs.read_cast("b").get_person("p001").canonical_name == "甲（人工名）"
        assert fs.read_relation_overrides("b") == manual
        auto = fs.read_reconcile_overrides("b")
        assert [item["relation_id"] for item in auto["add"]] == ["auto-new"]
        assert fs.read_meta("b").factions_stale is True
    asyncio.run(run())
