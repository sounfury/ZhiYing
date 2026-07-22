"""
单元测试：submit_reconciliation 校验逻辑。
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.agent.tools import ReconcileToolContext, make_reconcile_tools
from app.models.cast import Alias, AliasFrequency, Cast, Person, Gender, Importance
from app.models.reconcile import SuspectList


def _make_ctx() -> ReconcileToolContext:
    """创建测试用 ReconcileToolContext。"""
    cast = Cast(version=1, persons=[
        Person(
            person_id="p001",
            canonical_name="黛玉",
            aliases=[Alias(name="林妹妹", frequency=AliasFrequency.LOW)],
            gender=Gender.FEMALE,
            importance=Importance.MAIN,
        ),
        Person(
            person_id="p002",
            canonical_name="宝玉",
            aliases=[Alias(name="宝哥哥", frequency=AliasFrequency.LOW)],
            gender=Gender.MALE,
            importance=Importance.MAIN,
        ),
        Person(
            person_id="p003",
            canonical_name="林黛玉",
            aliases=[Alias(name="林妹妹", frequency=AliasFrequency.LOW)],
            gender=Gender.FEMALE,
            importance=Importance.MAIN,
        ),
    ])
    return ReconcileToolContext(
        book_id="test-book",
        cast=cast,
        suspects=SuspectList(),
        chapter_summaries={},
    )


def _get_tool(ctx: ReconcileToolContext, name: str):
    """从工具列表中按名取工具。"""
    tools = make_reconcile_tools(ctx)
    for t in tools:
        if t.name == name:
            return t
    raise ValueError(f"Tool '{name}' not found")


def test_search_in_chapter_empty_keyword():
    """空 keyword 直接拒绝，不扫正文。"""
    ctx = _make_ctx()
    tool = _get_tool(ctx, "search_in_chapter")
    for kw in ("", "   "):
        data = json.loads(tool.invoke({"chapter_id": 1, "keyword": kw}))
        assert "error" in data
        assert "empty" in data["error"].lower() or "keyword" in data["error"].lower()


def test_submit_success():
    """成功提交 patch。"""
    ctx = _make_ctx()
    tool = _get_tool(ctx, "submit_reconciliation")
    result = tool.invoke({
        "merges": [{"keep_id": "p001", "drop_id": "p003", "reason": "alias_overlap"}],
        "aliases": [{"person_id": "p001", "new_aliases": ["颦儿"]}],
        "relation_changes": [{"action": "add", "person_a": "p001", "person_b": "p002", "type": "朋友", "chapter_id": 1}],
        "todos": [{"description": "检查 p002 的具体关系"}],
    })
    data = json.loads(result)
    assert data["status"] == "submitted"
    assert ctx.submit_patch is not None
    assert len(ctx.submit_patch.merges) == 1
    assert len(ctx.submit_patch.aliases) == 1
    assert len(ctx.submit_patch.relation_changes) == 1
    assert len(ctx.submit_patch.todos) == 1


def test_submit_merge_invalid_id():
    """merge 引用不存在的 id。"""
    ctx = _make_ctx()
    tool = _get_tool(ctx, "submit_reconciliation")
    result = tool.invoke({
        "merges": [{"keep_id": "p001", "drop_id": "p999", "reason": "test"}],
        "aliases": [],
        "relation_changes": [],
        "todos": [],
    })
    data = json.loads(result)
    assert data["status"] == "error"
    assert "p999" in data["message"]
    assert ctx.submit_patch is None


def test_submit_merge_same_id():
    """keep_id == drop_id。"""
    ctx = _make_ctx()
    tool = _get_tool(ctx, "submit_reconciliation")
    result = tool.invoke({
        "merges": [{"keep_id": "p001", "drop_id": "p001", "reason": "test"}],
        "aliases": [],
        "relation_changes": [],
        "todos": [],
    })
    data = json.loads(result)
    assert data["status"] == "error"


def test_submit_invalid_relation_type():
    """relationChanges 中 type 非法。"""
    ctx = _make_ctx()
    tool = _get_tool(ctx, "submit_reconciliation")
    result = tool.invoke({
        "merges": [],
        "aliases": [],
        "relation_changes": [{"action": "add", "person_a": "p001", "person_b": "p002", "type": "恋人", "chapter_id": 1}],
        "todos": [],
    })
    data = json.loads(result)
    assert data["status"] == "error"
    assert "INVALID_RELATION_TYPE" in data["message"]


def test_submit_empty_aliases():
    """aliases 中 new_aliases 为空。"""
    ctx = _make_ctx()
    tool = _get_tool(ctx, "submit_reconciliation")
    result = tool.invoke({
        "merges": [],
        "aliases": [{"person_id": "p001", "new_aliases": []}],
        "relation_changes": [],
        "todos": [],
    })
    data = json.loads(result)
    assert data["status"] == "error"


def test_submit_empty_todo():
    """todos 中 description 为空。"""
    ctx = _make_ctx()
    tool = _get_tool(ctx, "submit_reconciliation")
    result = tool.invoke({
        "merges": [],
        "aliases": [],
        "relation_changes": [],
        "todos": [{"description": ""}],
    })
    data = json.loads(result)
    assert data["status"] == "error"


def test_submit_invalid_action():
    """relationChanges 中 action 非法。"""
    ctx = _make_ctx()
    tool = _get_tool(ctx, "submit_reconciliation")
    result = tool.invoke({
        "merges": [],
        "aliases": [],
        "relation_changes": [{"action": "modify", "person_a": "p001", "person_b": "p002", "type": "朋友", "chapter_id": 1}],
        "todos": [],
    })
    data = json.loads(result)
    assert data["status"] == "error"


def test_query_cast():
    """query_cast 返回 cast 数据。"""
    ctx = _make_ctx()
    tool = _get_tool(ctx, "query_cast")
    result = tool.invoke({})
    data = json.loads(result)
    assert data["version"] == 1
    assert len(data["persons"]) == 3
    assert data["persons"][0]["person_id"] == "p001"