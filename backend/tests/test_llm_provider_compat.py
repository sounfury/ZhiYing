from unittest.mock import patch

from app.agent.llm import get_chapter_llm, get_reconcile_llm
from app.config import Settings


def _deepseek_settings() -> Settings:
    return Settings(
        _env_file=None,
        llm_api_key="test-only",
        llm_base_url="https://api.deepseek.com",
        llm_model="deepseek-flash",
        llm_reconcile_model="deepseek-flash",
    )


def test_deepseek_reconcile_disables_thinking_for_forced_tool_choice_compat():
    cfg = _deepseek_settings()

    with patch("app.agent.llm.ChatOpenAI") as chat_openai:
        get_reconcile_llm(cfg)

    assert chat_openai.call_args.kwargs["extra_body"] == {
        "thinking": {"type": "disabled"}
    }


def test_deepseek_chapter_keeps_provider_default_thinking_mode():
    cfg = _deepseek_settings()

    with patch("app.agent.llm.ChatOpenAI") as chat_openai:
        get_chapter_llm(cfg)

    assert chat_openai.call_args.kwargs["extra_body"] is None


def test_non_deepseek_reconcile_does_not_send_deepseek_thinking_parameter():
    cfg = Settings(
        _env_file=None,
        llm_api_key="test-only",
        llm_base_url="https://api.openai.com/v1",
        llm_model="gpt-4o-mini",
        llm_reconcile_model="gpt-4o-mini",
    )

    with patch("app.agent.llm.ChatOpenAI") as chat_openai:
        get_reconcile_llm(cfg)

    assert chat_openai.call_args.kwargs["extra_body"] is None
