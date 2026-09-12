"""Regression tests for task control, retry flow, and postprocess performance. No real provider calls."""
from __future__ import annotations

import asyncio
import json
import threading
import time
from unittest.mock import patch

import pytest

from app.agent.chapter_agent import AgentResult
from app.agent.llm import LLMControl, LLMBudgetExceeded, LLMStopped, invoke_controlled
from app.agent.relation_normalizer import normalize_relations
from app.agent.relation_verifier import verify_relations
from app.config import Settings
from app.core.orchestrator import Orchestrator, recover_interrupted_tasks
from app.domain.relation_types import seed_registry
from app.models.book import AnalysisTaskSnapshot, BookMeta, BookStatus, Chapter, ChapterTaskState
from app.models.ledger import ChapterLedger, Evidence, Relation
from app.storage.filestore import Filestore


class _Response:
    def __init__(self, total: int = 0):
        self.usage_metadata = {
            "input_tokens": total // 2,
            "output_tokens": total - total // 2,
            "total_tokens": total,
        }


class _Model:
    def __init__(self, fn):
        self.fn = fn
        self.calls = 0

    def invoke(self, messages):
        self.calls += 1
        return self.fn(messages)


def test_quota_error_stops_without_retry():
    async def run():
        stop = asyncio.Event()
        control = LLMControl(stop_event=stop, max_requests=10, request_retries=3, heartbeat_seconds=0)
        model = _Model(lambda _: (_ for _ in ()).throw(RuntimeError("insufficient_quota: balance exhausted")))
        with pytest.raises(RuntimeError):
            await invoke_controlled(model, [], control=control, phase="chapter", context="q")
        assert model.calls == 1
        assert stop.is_set()
        assert "quota" in control.stop_reason
    asyncio.run(run())


def test_stop_during_retry_wait_prevents_next_request():
    async def run():
        stop = asyncio.Event()
        control = LLMControl(stop_event=stop, max_requests=10, request_retries=3, heartbeat_seconds=0)
        model = _Model(lambda _: (_ for _ in ()).throw(RuntimeError("timeout")))
        task = asyncio.create_task(
            invoke_controlled(model, [], control=control, phase="chapter", context="retry")
        )
        await asyncio.sleep(0.02)
        stop.set()
        with pytest.raises(LLMStopped):
            await task
        assert model.calls == 1
    asyncio.run(run())


def test_token_budget_stops_after_accounted_response():
    async def run():
        stop = asyncio.Event()
        control = LLMControl(stop_event=stop, max_requests=10, max_tokens=10, heartbeat_seconds=0)
        model = _Model(lambda _: _Response(total=11))
        with pytest.raises(LLMBudgetExceeded):
            await invoke_controlled(model, [], control=control, phase="chapter")
        assert model.calls == 1
        assert control.total_tokens == 11
        assert stop.is_set()
    asyncio.run(run())


def test_long_request_emits_heartbeat():
    async def run():
        events = []
        async def sink(data):
            events.append(data)
        control = LLMControl(
            stop_event=asyncio.Event(), max_requests=10, heartbeat_seconds=0.01, event_sink=sink
        )
        model = _Model(lambda _: (time.sleep(0.045), _Response(total=2))[1])
        response = await invoke_controlled(model, [], control=control, phase="chapter", context="slow")
        assert response.usage_metadata["total_tokens"] == 2
        assert any(e.get("kind") == "llm_request_heartbeat" for e in events)
        assert any(e.get("kind") == "llm_request_end" for e in events)
    asyncio.run(run())


def _make_book(tmp_path, chapters: int) -> Filestore:
    fs = Filestore(tmp_path)
    fs.create_book_dir("b")
    fs.write_meta("b", BookMeta(book_id="b", total_chapters=chapters))
    for cid in range(1, chapters + 1):
        fs.write_chapter("b", Chapter(chapter_id=cid, order=cid, content=f"chapter {cid}"))
    return fs


def test_multiple_subscribers_receive_same_event(tmp_path):
    async def run():
        fs = _make_book(tmp_path, 1)
        orch = Orchestrator("b", fs, Settings(auto_extract_factions=False, llm_api_key=""))
        _, q1 = orch.subscribe()
        _, q2 = orch.subscribe()
        await orch._push_progress({"phase": "extracting", "done": 0, "total": 1})
        e1 = await asyncio.wait_for(q1.get(), 0.5)
        e2 = await asyncio.wait_for(q2.get(), 0.5)
        assert e1 == e2
        orch.unsubscribe(q1)
        orch.unsubscribe(q2)
    asyncio.run(run())


def test_failed_chapter_retry_is_deduplicated_and_finishes(tmp_path):
    async def run():
        fs = _make_book(tmp_path, 1)
        calls = 0

        async def fake_agent(book_id, cid, cast, store, cfg, stop_event=None, control=None):
            nonlocal calls
            calls += 1
            if calls == 1:
                return AgentResult(chapter_id=cid, success=False, warning="transient")
            ledger = ChapterLedger(chapter_id=cid, analysis_status="complete", summary="ok")
            store.write_ledger(book_id, ledger)
            return AgentResult(chapter_id=cid, ledger=ledger, success=True)

        orch = Orchestrator("b", fs, Settings(auto_extract_factions=False, llm_api_key=""))
        with patch("app.core.orchestrator.run_chapter_agent", new=fake_agent):
            await orch.start()
            while True:
                event = await asyncio.wait_for(orch.progress_queue.get(), 2)
                if event["type"] == "progress" and event["data"].get("phase") == "waiting_failed":
                    break
            assert event["data"]["success_count"] == 0
            assert event["data"]["failure_count"] == 1
            assert event["data"]["running_count"] == 0
            assert event["data"]["queued_count"] == 0
            first = await orch.retry_failed([1])
            second = await orch.retry_failed([1])
            assert first["queued"] == [1]
            assert second["queued"] == []
            assert second["ignored"] == [1]
            while True:
                event = await asyncio.wait_for(orch.progress_queue.get(), 2)
                if event["type"] == "done":
                    break
        assert calls == 2
        assert event["data"]["chapters_done"] == 1
        assert event["data"]["chapters_failed"] == 0
        task = fs.read_analysis_task("b")
        assert task is not None and not task.active
        assert task.chapter_state(1).attempts == 2
    asyncio.run(run())


def test_skip_failed_produces_partial_result(tmp_path):
    async def run():
        fs = _make_book(tmp_path, 2)

        async def fake_agent(book_id, cid, cast, store, cfg, stop_event=None, control=None):
            if cid == 2:
                return AgentResult(chapter_id=cid, success=False, warning="content rejected")
            ledger = ChapterLedger(chapter_id=cid, analysis_status="complete", summary="ok")
            store.write_ledger(book_id, ledger)
            return AgentResult(chapter_id=cid, ledger=ledger, success=True)

        orch = Orchestrator("b", fs, Settings(auto_extract_factions=False, llm_api_key=""))
        with patch("app.core.orchestrator.run_chapter_agent", new=fake_agent):
            await orch.start()
            while True:
                event = await asyncio.wait_for(orch.progress_queue.get(), 2)
                if event["type"] == "progress" and event["data"].get("phase") == "waiting_failed":
                    break
            await orch.skip_failed_chapters()
            while True:
                event = await asyncio.wait_for(orch.progress_queue.get(), 2)
                if event["type"] == "done":
                    break
        assert event["data"]["status"] == "partial"
        assert event["data"]["chapters_done"] == 1
        assert event["data"]["chapters_failed"] == 1
    asyncio.run(run())


def test_backend_restart_marks_stale_task_interrupted(tmp_path):
    async def run():
        fs = _make_book(tmp_path, 2)
        meta = fs.read_meta("b")
        meta.status = BookStatus.ANALYZING
        fs.write_meta("b", meta)
        task = AnalysisTaskSnapshot(
            task_id="t", book_id="b", active=True, phase="extracting", total_chapters=2,
            chapters=[
                ChapterTaskState(chapter_id=1, status="done"),
                ChapterTaskState(chapter_id=2, status="running"),
            ],
        )
        fs.write_analysis_task("b", task)
        assert await recover_interrupted_tasks(fs) == 1
        meta = fs.read_meta("b")
        task = fs.read_analysis_task("b")
        assert meta.status == BookStatus.PARTIAL
        assert meta.analysis_progress.chapters_done == [1]
        assert meta.analysis_progress.chapters_pending == [2]
        assert task is not None and task.status == "interrupted" and not task.active
    asyncio.run(run())


def _novel_relation(i: int = 0, quote: str = "甲守护乙。") -> Relation:
    return Relation(
        person_a="p1", person_b="p2", label="守护人", category="其他",
        definition="甲承担持续保护乙的责任", directed=True,
        subject_role="守护者", object_role="被守护者", raw_relation="甲守护乙",
        evidence=Evidence(chapter_id=1, quote=quote),
    )


def test_identical_relation_descriptions_use_one_normalization_candidate():
    class Structured:
        def __init__(self):
            self.calls = 0
        def invoke(self, messages):
            self.calls += 1
            return {"action": "new", "reason": "new semantic"}
    class Base:
        def __init__(self, structured): self.structured = structured
        def with_structured_output(self, *args, **kwargs): return self.structured

    relations = [_novel_relation(i) for i in range(20)]
    structured = Structured()
    with patch("app.agent.relation_normalizer.get_reconcile_llm", return_value=Base(structured)):
        warnings = asyncio.run(
            normalize_relations(relations, seed_registry(), "甲守护乙。", Settings(llm_api_key=""))
        )
    assert not warnings
    assert structured.calls == 1
    assert len({r.predicate for r in relations}) == 1


def test_verification_batches_have_global_concurrency_limit():
    active = 0
    max_active = 0
    calls = 0
    lock = threading.Lock()

    class Structured:
        def invoke(self, messages):
            nonlocal active, max_active, calls
            payload = json.loads(messages[1].content)
            with lock:
                calls += 1
                active += 1
                max_active = max(max_active, active)
            time.sleep(0.08)
            with lock:
                active -= 1
            return {
                "verdicts": [
                    {"index": item["index"], "status": "confirmed", "reason": "explicit"}
                    for item in payload
                ]
            }
    class Base:
        def __init__(self): self.structured = Structured()
        def with_structured_output(self, *args, **kwargs): return self.structured

    relations = []
    content_parts = []
    for i in range(8):
        quote = f"甲守护乙{i}。"
        content_parts.append(quote)
        relations.append(_novel_relation(i, quote=quote))
    cfg = Settings(llm_api_key="", relation_verify_batch_size=2, relation_verify_concurrency=2)
    started = time.perf_counter()
    with patch("app.agent.relation_verifier.get_reconcile_llm", return_value=Base()):
        warnings = asyncio.run(verify_relations(relations, "\n".join(content_parts), {}, cfg))
    elapsed = time.perf_counter() - started
    assert not warnings
    assert calls == 4
    assert max_active == 2
    assert elapsed < 0.29  # serial would be ~0.32s plus overhead


def _write_interrupted_resume_fixture(fs: Filestore) -> None:
    cast = fs.read_cast("b")
    fs.write_extraction_base_cast("b", cast)
    ledger = ChapterLedger(chapter_id=1, analysis_status="complete", summary="cached")
    fs.write_ledger("b", ledger)
    fs.write_extraction_result("b", 1, ledger, {})
    meta = fs.read_meta("b")
    meta.status = BookStatus.PARTIAL
    meta.analysis_progress.chapters_done = [1]
    meta.analysis_progress.chapters_pending = [2]
    fs.write_meta("b", meta)
    fs.write_analysis_task(
        "b",
        AnalysisTaskSnapshot(
            task_id="old", book_id="b", kind="full", active=False,
            status="interrupted", phase="interrupted", total_chapters=2,
            chapters=[
                ChapterTaskState(chapter_id=1, status="done", attempts=1),
                ChapterTaskState(chapter_id=2, status="running", attempts=1),
            ],
        ),
    )


def test_restart_resume_reuses_unchanged_finished_extraction(tmp_path):
    async def run():
        fs = _make_book(tmp_path, 2)
        _write_interrupted_resume_fixture(fs)
        calls: list[int] = []

        async def fake_agent(book_id, cid, cast, store, cfg, stop_event=None, control=None):
            calls.append(cid)
            ledger = ChapterLedger(chapter_id=cid, analysis_status="complete", summary=f"new-{cid}")
            store.write_ledger(book_id, ledger)
            return AgentResult(chapter_id=cid, ledger=ledger, success=True)

        orch = Orchestrator("b", fs, Settings(auto_extract_factions=False, llm_api_key=""))
        with patch("app.core.orchestrator.run_chapter_agent", new=fake_agent):
            started = await orch.start()
            while True:
                event = await asyncio.wait_for(orch.progress_queue.get(), 2)
                if event["type"] == "done":
                    break
        assert started["resumed"] is True
        assert started["reused_chapters"] == [1]
        assert calls == [2]
        assert event["data"]["chapters_done"] == 2
        assert fs.read_ledger("b", 1).summary == "cached"
    asyncio.run(run())


def test_restart_resume_invalidates_changed_chapter_input(tmp_path):
    async def run():
        fs = _make_book(tmp_path, 2)
        _write_interrupted_resume_fixture(fs)
        chapter = fs.read_chapter("b", 1)
        chapter.content += " changed"
        fs.write_chapter("b", chapter)
        calls: list[int] = []

        async def fake_agent(book_id, cid, cast, store, cfg, stop_event=None, control=None):
            calls.append(cid)
            ledger = ChapterLedger(chapter_id=cid, analysis_status="complete", summary=f"new-{cid}")
            store.write_ledger(book_id, ledger)
            return AgentResult(chapter_id=cid, ledger=ledger, success=True)

        orch = Orchestrator("b", fs, Settings(auto_extract_factions=False, llm_api_key=""))
        with patch("app.core.orchestrator.run_chapter_agent", new=fake_agent):
            started = await orch.start()
            while True:
                event = await asyncio.wait_for(orch.progress_queue.get(), 2)
                if event["type"] == "done":
                    break
        assert started["resumed"] is False
        assert started["reused_chapters"] == []
        assert sorted(calls) == [1, 2]
    asyncio.run(run())
