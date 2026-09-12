"""证据闸门的功能回归；模型响应使用替身，不调用外部服务。"""
import asyncio
import json
import sys
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from relation_fixtures import relation_fields
from app.agent.relation_verifier import verify_relations
from app.agent.tools import ChapterToolContext, make_tools
from app.core.aggregator import Aggregator, GraphQuery
from app.core.evidence import locate_evidence
from app.agent.relation_pipeline import enrich_ledger
from app.models.book import BookMeta, BookStatus, Chapter
from app.models.cast import Cast, Person
from app.models.ledger import ChapterLedger, ChapterPerson, Evidence, Relation
from app.storage.filestore import Filestore


def relation(quote="甲是乙的父亲。", **kwargs):
    return Relation(person_a="p1", person_b="p2", **relation_fields("亲子"),
                    evidence=Evidence(chapter_id=1, quote=quote), **kwargs)


@pytest.mark.parametrize("quote,content", [("", "正文"), ("不存在", "正文"),
                                         ("父亲", "父亲说父亲")])
def test_unlocatable_evidence_remains_pending(quote, content):
    rel = relation(quote, status="confirmed")
    assert not locate_evidence(rel, content)
    assert rel.status == "pending"
    assert rel.evidence.start is None


def test_exact_quote_is_not_semantic_confirmation():
    rel = relation("甲不是乙的父亲。")
    text = "前言。甲不是乙的父亲。后记。"
    assert locate_evidence(rel, text)
    assert text[rel.evidence.start:rel.evidence.end] == rel.evidence.quote
    assert rel.evidence.quote_verified is True
    assert rel.status == "pending"


@pytest.mark.parametrize("status", ["confirmed", "pending", "rejected"])
def test_semantic_verdict_controls_status(status):
    rel = relation()
    model = Mock()
    model.with_structured_output.return_value.invoke.return_value = {
        "verdicts": [{"index": 0, "status": status, "reason": "原文审核理由"}]}
    with patch("app.agent.relation_verifier.get_reconcile_llm", return_value=model):
        warnings = asyncio.run(verify_relations([rel], rel.evidence.quote,
                                               {"p1": "甲", "p2": "乙"}, None))
    assert not warnings
    assert rel.status == status


@pytest.mark.parametrize("verdicts", [[],
    [{"index": 9, "status": "confirmed", "reason": "错误索引"}],
    [{"index": 0, "status": "confirmed", "reason": "重复"}] * 2,
    [{"index": 0, "status": "confirmed", "reason": ""}]])
def test_malformed_verifier_output_fails_closed(verdicts):
    rel = relation()
    model = Mock()
    model.with_structured_output.return_value.invoke.return_value = {"verdicts": verdicts}
    with patch("app.agent.relation_verifier.get_reconcile_llm", return_value=model):
        assert asyncio.run(verify_relations([rel], rel.evidence.quote, {}, None))
    assert rel.status == "pending"


def test_provider_failure_keeps_candidate():
    rel = relation()
    with patch("app.agent.relation_verifier.get_reconcile_llm", side_effect=RuntimeError()):
        assert asyncio.run(verify_relations([rel], rel.evidence.quote, {}, None))
    assert rel.status == "pending"


def test_missing_quote_does_not_call_model():
    with patch("app.agent.relation_verifier.get_reconcile_llm") as factory:
        asyncio.run(verify_relations([relation("捏造的引用")], "正文", {}, None))
        factory.assert_not_called()


def setup_book(tmp_path):
    fs = Filestore(tmp_path)
    fs.create_book_dir("book")
    fs.write_meta("book", BookMeta(book_id="book", total_chapters=2, status=BookStatus.ANALYZED))
    cast = Cast(persons=[Person(person_id="p1", canonical_name="甲"),
                         Person(person_id="p2", canonical_name="乙")])
    fs.write_cast("book", cast)
    fs.write_chapter("book", Chapter(chapter_id=1, content="甲是乙的父亲。"))
    return fs, cast


def test_tool_cannot_self_confirm(tmp_path):
    fs, cast = setup_book(tmp_path)
    ctx = ChapterToolContext(book_id="book", chapter_id=1, cast_snapshot=cast, filestore=fs)
    submit = next(t for t in make_tools(ctx) if t.name == "submit_relations")
    result = json.loads(submit.invoke({"relations": [relation(status="confirmed").model_dump()]}))
    assert result["status"] == "ok"
    assert ctx.relations_buffer[0].status == "pending"
    assert ctx.relations_buffer[0].evidence.quote_verified


def test_graph_hides_unconfirmed_candidates(tmp_path):
    fs, _ = setup_book(tmp_path)
    fs.write_ledger("book", ChapterLedger(chapter_id=1,
        persons=[ChapterPerson(person_id="p1"), ChapterPerson(person_id="p2")],
        relations=[relation(), relation(status="rejected")]))
    graph = Aggregator("book", fs).compile(GraphQuery(to_chapter=1, min_appearance=1))
    assert not graph.edges
    assert graph.pending_relation_count == 1
    assert graph.rejected_relation_count == 1


def test_old_schema_is_rejected():
    with pytest.raises(ValueError):
        ChapterLedger.model_validate({"chapter_id": 1, "relations": [
            {"person_a": "p1", "person_b": "p2", "type": "亲子"}]})


def test_read_coverage_detects_gaps():
    ctx = ChapterToolContext(book_id="b", chapter_id=1, cast_snapshot=Cast())
    ctx.read_ranges = [(0, 10), (11, 20)]
    assert not ctx.has_read_all(20)
    ctx.read_ranges.append((9, 12))
    assert ctx.has_read_all(20)


def test_rerun_preserves_partial_quality(tmp_path):
    from app.agent.chapter_agent import AgentResult
    from app.config import Settings
    from app.core.orchestrator import Orchestrator
    from unittest.mock import AsyncMock
    fs, _ = setup_book(tmp_path)
    ledger = ChapterLedger(chapter_id=1, analysis_status="partial")
    fs.write_ledger("book", ledger)
    meta = fs.read_meta("book")
    meta.analysis_progress.chapters_done = [1]
    fs.write_meta("book", meta)
    fs.write_extraction_base_cast("book", fs.read_cast("book"))
    fs.write_extraction_result("book", 1, ledger, {})
    fs.save_pre_reconcile_state("book", [1])
    result = AgentResult(chapter_id=1, ledger=ledger, success=True, partial=True)
    with patch("app.core.orchestrator.run_chapter_agent", new=AsyncMock(return_value=result)):
        response = asyncio.run(
            Orchestrator("book", fs, Settings(auto_extract_factions=False, llm_api_key="")).rerun_chapter(1)
        )
    assert response["partial"] is True
    meta = fs.read_meta("book")
    assert meta.status == BookStatus.PARTIAL
    assert meta.analysis_progress.chapters_partial == [1]


def test_chapter_to_graph_verification_pipeline(tmp_path):
    from langchain_core.messages import AIMessage
    from app.agent.chapter_agent import run_chapter_agent
    from app.config import Settings
    fs, cast = setup_book(tmp_path)
    cfg = Settings(llm_api_key="test-only")
    extractor = Mock()
    extractor.bind_tools.return_value.invoke.side_effect = [
        AIMessage(content="", tool_calls=[{"name": "submit_relations", "id": "r",
            "args": {"relations": [relation().model_dump()]}}]),
        AIMessage(content="", tool_calls=[{"name": "submit_result", "id": "s",
            "args": {"summary": "父子关系"}}]),
    ]
    verifier = Mock()
    verifier.with_structured_output.return_value.invoke.return_value = {
        "verdicts": [{"index": 0, "status": "confirmed", "reason": "明确父子，方向正确"}]}
    with patch("app.agent.chapter_agent.get_chapter_llm", return_value=extractor), \
         patch("app.agent.relation_verifier.get_reconcile_llm", return_value=verifier):
        result = asyncio.run(run_chapter_agent("book", 1, cast, fs, cfg))
        asyncio.run(enrich_ledger("book", result, fs, cfg))
    assert result.success and not result.partial
    assert fs.read_ledger("book", 1).relations[0].status == "confirmed"
    graph = Aggregator("book", fs).compile(GraphQuery(min_appearance=1))
    assert graph.edges[0].tags[0].label == "亲子"


def test_long_chapter_explicit_submit_without_reading_is_partial(tmp_path):
    from langchain_core.messages import AIMessage
    from app.agent.chapter_agent import run_chapter_agent
    from app.config import Settings
    fs, cast = setup_book(tmp_path)
    model = Mock()
    model.bind_tools.return_value.invoke.return_value = AIMessage(content="", tool_calls=[
        {"name": "submit_result", "id": "s", "args": {"summary": "未读就提交"}}])
    with patch("app.agent.chapter_agent.get_chapter_llm", return_value=model):
        result = asyncio.run(run_chapter_agent("book", 1, cast, fs,
                             Settings(inject_max_chars=1, read_window_chars=2)))
    assert result.partial
    assert any("完整读取" in w for w in result.ledger.warnings)


def test_reconcile_addition_cannot_bypass_verification(tmp_path):
    from langchain_core.messages import AIMessage
    from app.agent.reconcile_agent import run_reconcile_agent
    from app.config import Settings
    from app.models.reconcile import SuspectList
    fs, cast = setup_book(tmp_path)
    model = Mock()
    model.bind_tools.return_value.invoke.return_value = AIMessage(content="", tool_calls=[
        {"name": "submit_reconciliation", "id": "s", "args": {"relation_changes": [
            {"action": "add", "relation": relation("伪造引用", status="confirmed").model_dump()}]}}])
    with patch("app.agent.reconcile_agent.get_reconcile_llm", return_value=model), \
         patch("app.agent.relation_verifier.get_reconcile_llm") as verifier:
        result = asyncio.run(run_reconcile_agent(fs.read_meta("book"), cast, SuspectList(),
                             {1: "摘要"}, fs, Settings()))
    assert result.success
    assert result.patch.relation_changes[0].relation.status == "pending"
    verifier.assert_not_called()
