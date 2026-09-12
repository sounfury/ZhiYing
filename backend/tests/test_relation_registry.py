"""开放关系注册、同义归一化与完整分析链路的功能回归，不调用真实模型。"""
import asyncio
import json
from unittest.mock import Mock, patch, AsyncMock
from contextlib import nullcontext

import pytest

from app.agent.relation_normalizer import normalize_relations
from app.agent.relation_pipeline import enrich_relations
from app.core.relation_registry import register, descriptor
from app.domain.relation_types import seed_registry, RelationDescriptor
from app.models.ledger import Relation, Evidence
from app.storage.filestore import Filestore


def crush(label="单恋", **updates):
    data = dict(person_a="p1", person_b="p2", label=label, category="情感",
                definition="a 爱慕 b，但未表明 b 有同样感情", directed=True,
                subject_role="爱慕者", object_role="被爱慕者", raw_relation="甲暗恋乙",
                evidence=Evidence(chapter_id=1, quote="甲暗恋乙。"))
    data.update(updates)
    return Relation(**data)


def llm_result(*responses):
    model = Mock()
    model.with_structured_output.return_value.invoke.side_effect = responses
    return model


def test_new_relation_registered_and_reused_with_synonym():
    registry = seed_registry()
    before = len(registry.definitions)
    one = crush()
    with patch("app.agent.relation_normalizer.get_reconcile_llm", return_value=llm_result(
        {"action": "new", "reason": "已有类型没有单向情感"})):
        assert not asyncio.run(normalize_relations([one], registry, "甲暗恋乙。", None))
    assert one.predicate.startswith("rel_")
    assert len(registry.definitions) == before + 1
    two = crush("暗恋")
    with patch("app.agent.relation_normalizer.get_reconcile_llm", return_value=llm_result(
        {"action": "existing", "predicate": one.predicate, "reason": "语义相同"})):
        assert not asyncio.run(normalize_relations([two], registry, "甲暗恋乙。", None))
    assert two.predicate == one.predicate
    assert two.label == "单恋"
    assert two.raw_relation == "甲暗恋乙"
    assert "暗恋" in registry.get(one.predicate).aliases
    assert len(registry.definitions) == before + 1


def test_identical_description_needs_no_model():
    registry = seed_registry()
    rel = crush()
    definition = register(registry, rel)
    with patch("app.agent.relation_normalizer.get_reconcile_llm") as factory:
        assert not asyncio.run(normalize_relations([rel], registry, "甲暗恋乙。", None))
        factory.assert_not_called()
    assert rel.predicate == definition.predicate


def test_reverse_roles_normalized_without_changing_raw_statement():
    registry = seed_registry()
    rel = Relation(person_a="p1", person_b="p2", label="子父", category="亲属",
        definition="a 是 b 的亲生子女", directed=True, subject_role="子女", object_role="父母",
        raw_relation="甲是乙的亲生儿子", evidence=Evidence(chapter_id=1, quote="甲是乙的亲生儿子。"))
    model = llm_result({"action": "existing", "predicate": "parent_of", "reverse": True, "reason": "反向亲子"})
    with patch("app.agent.relation_normalizer.get_reconcile_llm", return_value=model):
        asyncio.run(normalize_relations([rel], registry, rel.evidence.quote, None))
    assert (rel.person_a, rel.person_b) == ("p2", "p1")
    assert (rel.subject_role, rel.object_role) == ("父母", "子女")
    assert rel.raw_relation == "甲是乙的亲生儿子"


@pytest.mark.parametrize("response", [
    {"action": "existing", "predicate": "does_not_exist", "reason": "坏响应"},
    {"action": "existing", "predicate": "spouse_of", "reason": "错误转换为无向"},
    {"action": "new", "predicate": "invented", "reason": "不能自造标识"},
    {"action": "new", "reverse": True, "reason": "非法反转"},
])
def test_invalid_resolution_keeps_raw_candidate(response):
    registry = seed_registry()
    rel = crush()
    with patch("app.agent.relation_normalizer.get_reconcile_llm", return_value=llm_result(response)):
        assert asyncio.run(normalize_relations([rel], registry, rel.evidence.quote, None))
    assert rel.predicate is None
    assert rel.normalization_status == "pending"
    assert rel.label == "单恋"
    assert rel.person_a == "p1"


def test_same_label_different_semantics_not_collapsed_by_registration():
    registry = seed_registry()
    rel = crush()
    one = register(registry, rel)
    two = register(registry, crush(definition="双方互相爱慕", directed=False,
                                   subject_role="恋人", object_role="恋人"))
    assert one.predicate != two.predicate


def test_book_registry_isolated_and_persistent(tmp_path):
    fs = Filestore(tmp_path)
    fs.create_book_dir("a")
    fs.create_book_dir("b")
    registry = fs.read_relation_registry("a")
    definition = register(registry, crush())
    fs.write_relation_registry("a", registry)
    assert fs.read_relation_registry("a").get(definition.predicate).label == "单恋"
    assert fs.read_relation_registry("b").get(definition.predicate) is None


def test_symmetric_relation_requires_symmetric_roles():
    with pytest.raises(ValueError):
        RelationDescriptor(label="养父子", definition="收养关系", directed=False,
                           subject_role="养父", object_role="养子")


def test_unresolved_type_can_have_confirmed_evidence(tmp_path):
    from app.models.book import Chapter
    from app.models.cast import Cast, Person
    fs = Filestore(tmp_path)
    fs.create_book_dir("b")
    fs.write_chapter("b", Chapter(chapter_id=1, content="甲暗恋乙。"))
    fs.write_cast("b", Cast(persons=[Person(person_id="p1", canonical_name="甲"), Person(person_id="p2", canonical_name="乙")]))
    normalizer = llm_result({"action": "unresolved", "reason": "保留原始描述待归一化"})
    verifier = llm_result({"verdicts": [{"index": 0, "status": "confirmed", "reason": "原文明示单向爱慕"}]})
    rel = crush()
    with patch("app.agent.relation_normalizer.get_reconcile_llm", return_value=normalizer), \
         patch("app.agent.relation_verifier.get_reconcile_llm", return_value=verifier):
        assert not asyncio.run(enrich_relations("b", [rel], 1, fs, None))
    assert rel.predicate is None and rel.normalization_status == "pending"
    assert rel.status == "confirmed" and rel.label == "单恋"


@pytest.mark.parametrize("pipeline_failure", [False, True])
def test_full_orchestration_registers_and_aggregates_new_relation(tmp_path, pipeline_failure):
    from app.agent.chapter_agent import AgentResult
    from app.config import Settings
    from app.core.aggregator import Aggregator
    from app.core.orchestrator import Orchestrator
    from app.models.book import BookMeta, Chapter
    from app.models.cast import Cast, Person
    from app.models.ledger import ChapterLedger, ChapterPerson
    fs = Filestore(tmp_path)
    fs.create_book_dir("b")
    fs.write_meta("b", BookMeta(book_id="b", total_chapters=2))
    fs.write_cast("b", Cast(persons=[Person(person_id="p1", canonical_name="甲"), Person(person_id="p2", canonical_name="乙")]))
    for cid in [1, 2]:
        fs.write_chapter("b", Chapter(chapter_id=cid, order=cid, content="甲暗恋乙。"))

    async def extractor(book_id, cid, cast, store, cfg, stop_event=None, control=None):
        rel = crush("单恋" if cid == 1 else "暗恋", evidence=Evidence(chapter_id=cid, quote="甲暗恋乙。"))
        ledger = ChapterLedger(chapter_id=cid, analysis_status="complete", relations=[rel],
                               persons=[ChapterPerson(person_id="p1"), ChapterPerson(person_id="p2")])
        store.write_ledger(book_id, ledger)
        return AgentResult(chapter_id=cid, ledger=ledger, success=True)

    calls = []
    def resolve(messages):
        payload = json.loads(messages[1].content)
        calls.append(payload)
        found = next((d for d in payload["registered"] if d["label"] == "单恋"), None)
        return {"action": "existing", "predicate": found["predicate"], "reason": "同义"} if found else {"action": "new", "reason": "新语义"}
    normalizer = Mock()
    normalizer.with_structured_output.return_value.invoke.side_effect = resolve
    verifier = Mock()
    verifier.with_structured_output.return_value.invoke.return_value = {
        "verdicts": [{"index": 0, "status": "confirmed", "reason": "明确单向爱慕"}]}

    async def run():
        orch = Orchestrator("b", fs, Settings(auto_extract_factions=False, force_reconcile=False))
        await orch.start()
        while True:
            event = await asyncio.wait_for(orch.progress_queue.get(), timeout=5)
            if event["type"] == "done":
                return event
    failure = patch("app.core.orchestrator.enrich_ledgers", new=AsyncMock(side_effect=OSError("test storage failure"))) if pipeline_failure else nullcontext()
    with failure, patch("app.core.orchestrator.run_chapter_agent", new=extractor), \
         patch("app.agent.relation_normalizer.get_reconcile_llm", return_value=normalizer), \
         patch("app.agent.relation_verifier.get_reconcile_llm", return_value=verifier):
        event = asyncio.run(run())
    if pipeline_failure:
        assert event["data"]["status"] == "failed"
        assert event["data"]["chapters_failed"] == 2
        return
    assert event["data"]["status"] == "analyzed"
    assert len(calls) == 2
    graph = Aggregator("b", fs).compile()
    tag = graph.edges[0].tags[0]
    assert tag.label == "单恋" and tag.directed
    assert tag.chapter_ids == [1, 2]
    assert tag.predicate.startswith("rel_")
    assert "甲暗恋乙" in tag.raw_relations
