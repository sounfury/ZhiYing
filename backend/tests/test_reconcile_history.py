from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from app.agent.reconcile_agent import _compact_tool_history


def _assistant_with_tool(tool_id: str, name: str = "read_chapter") -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[{"name": name, "args": {}, "id": tool_id, "type": "tool_call"}],
    )


def test_compact_tool_history_keeps_latest_complete_exchange():
    old_ai = _assistant_with_tool("old-call")
    current_ai = AIMessage(
        content="",
        tool_calls=[
            {"name": "read_chapter", "args": {}, "id": "current-1", "type": "tool_call"},
            {"name": "read_ledger", "args": {}, "id": "current-2", "type": "tool_call"},
        ],
    )
    messages = [
        SystemMessage(content="system"),
        HumanMessage(content="user"),
        old_ai,
        ToolMessage(content="old", tool_call_id="old-call"),
        current_ai,
        ToolMessage(content="one", tool_call_id="current-1"),
        ToolMessage(content="two", tool_call_id="current-2"),
    ]

    compacted = _compact_tool_history(messages)

    assert compacted[:2] == messages[:2]
    assert compacted[2] is current_ai
    assert [m.tool_call_id for m in compacted[3:]] == ["current-1", "current-2"]
    assert all(m.tool_call_id != "old-call" for m in compacted[3:])


def test_compact_tool_history_never_returns_orphan_tool_message():
    messages = [
        SystemMessage(content="system"),
        HumanMessage(content="user"),
        ToolMessage(content="orphan", tool_call_id="missing"),
    ]

    assert _compact_tool_history(messages) == messages[:2]
