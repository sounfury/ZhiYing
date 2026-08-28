"""Chapter Agent：漏调 submit_result 时仍应收尾出账本。"""
from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent.parent))

from langchain_core.messages import AIMessage

from app.agent.chapter_agent import run_chapter_agent
from app.agent.prompts.chapter import build_system_prompt, build_user_prompt
from app.agent.prompts.reconcile import build_system_prompt as build_reconcile_system
from app.agent.prompts.reconcile import build_user_prompt as build_reconcile_user
from app.models.book import BookMeta, Chapter
from app.models.cast import Cast
from app.models.reconcile import SuspectList
from app.storage.filestore import Filestore


class _FakeLLM:
    def __init__(self, responses: list[AIMessage]):
        self.responses = list(responses)
        self.calls = 0

    def bind_tools(self, tools):
        return self

    def invoke(self, messages):
        self.calls += 1
        if not self.responses:
            raise AssertionError(f"unexpected extra LLM call #{self.calls}")
        return self.responses.pop(0)


def _setup_chapter(content: str = "悉达多离开林园。戈文达留在原地。") -> tuple[Filestore, str]:
    tmp = tempfile.mkdtemp()
    fs = Filestore(Path(tmp))
    book_id = "ch-agent"
    fs.create_book_dir(book_id)
    fs.write_meta(book_id, BookMeta(book_id=book_id, title="t", total_chapters=1))
    fs.write_chapter(
        book_id,
        Chapter(chapter_id=4, title="觉醒", order=4, content=content, word_count=20),
    )
    return fs, book_id


def _cfg() -> SimpleNamespace:
    return SimpleNamespace(
        inject_max_chars=100_000,
        read_window_chars=5_000,
        max_agent_steps=8,
    )


def test_no_tool_calls_after_propose_still_succeeds():
    """propose_persons 之后模型只回纯文本 → 已有累积则立即自动 finalize。"""
    fs, book_id = _setup_chapter()
    fake = _FakeLLM(
        [
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "propose_persons",
                        "args": {
                            "persons": [
                                {
                                    "canonical_name": "悉达多",
                                    "aliases": [],
                                    "importance": "main",
                                },
                                {
                                    "canonical_name": "戈文达",
                                    "aliases": [],
                                    "importance": "main",
                                },
                            ]
                        },
                        "id": "call_propose",
                    }
                ],
            ),
            AIMessage(content="本章悉达多觉醒离去。", tool_calls=[]),
        ]
    )

    async def _run():
        with patch("app.agent.chapter_agent.get_chapter_llm", return_value=fake):
            return await run_chapter_agent(
                book_id, 4, Cast(), fs, cfg=_cfg()  # type: ignore[arg-type]
            )

    result = asyncio.run(_run())
    assert result.success is True
    assert result.ledger is not None
    assert len(result.ledger.persons) == 2
    names = {p.canonical_name for p in result.cast_buffer.values()}
    assert "悉达多" in names
    assert "戈文达" in names
    assert result.summary
    assert fake.calls == 2
    assert "auto-finalized" in result.warning
    disk = fs.read_ledger(book_id, 4)
    assert len(disk.persons) == 2


def test_empty_no_tools_reminds_then_auto_finalizes():
    """无人物无关系的纯文本：先提醒一次，仍不调工具则空账本落盘。"""
    fs, book_id = _setup_chapter()
    fake = _FakeLLM(
        [
            AIMessage(content="本章很短。", tool_calls=[]),
            AIMessage(content="仍然不调工具。", tool_calls=[]),
        ]
    )

    async def _run():
        with patch("app.agent.chapter_agent.get_chapter_llm", return_value=fake):
            return await run_chapter_agent(
                book_id, 4, Cast(), fs, cfg=_cfg()  # type: ignore[arg-type]
            )

    result = asyncio.run(_run())
    assert result.success is True
    assert result.ledger is not None
    assert result.ledger.persons == []
    assert fake.calls == 2
    assert "auto-finalized" in result.warning


def test_reminder_then_submit_result():
    """提醒后模型调用 submit_result → 正常收尾。"""
    fs, book_id = _setup_chapter()
    fake = _FakeLLM(
        [
            AIMessage(content="分析完毕。", tool_calls=[]),
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "submit_result",
                        "args": {"summary": "短章，无人出场。"},
                        "id": "call_submit",
                    }
                ],
            ),
        ]
    )

    async def _run():
        with patch("app.agent.chapter_agent.get_chapter_llm", return_value=fake):
            return await run_chapter_agent(
                book_id, 4, Cast(), fs, cfg=_cfg()  # type: ignore[arg-type]
            )

    result = asyncio.run(_run())
    assert result.success is True
    assert result.ledger is not None
    assert result.summary == "短章，无人出场。"
    assert result.warning == ""
    assert fake.calls == 2


def _assert_no_transliteration(text: str) -> None:
    assert "译名合一" not in text
    assert "译名合并" not in text
    assert "正式名优先中文" not in text
    assert "Govinda" not in text
    assert "Kamala" not in text
    assert "Gotama" not in text
    assert "拉丁名" not in text


def test_prompt_covers_shitu_tongchang_no_transliteration():
    prompt = build_system_prompt(5000)
    assert "仅当" in prompt and "拜师" in prompt
    assert "洗衣少女" in prompt
    assert "同场" in prompt
    assert "submit_result 必须调用" in prompt
    _assert_no_transliteration(prompt)

    ch = Chapter(chapter_id=1, title="t", order=1, content="甲遇见乙。", word_count=4)
    short, is_short = build_user_prompt(ch, Cast(), inject_max_chars=1000, read_window_chars=500)
    assert is_short
    assert "有姓名的" in short
    assert "师徒仅明确拜师" in short
    _assert_no_transliteration(short)

    long_ch = Chapter(chapter_id=1, title="t", order=1, content="甲" * 80, word_count=80)
    long_p, is_short = build_user_prompt(
        long_ch, Cast(), inject_max_chars=10, read_window_chars=20
    )
    assert not is_short
    _assert_no_transliteration(long_p)

    rec_sys = build_reconcile_system(5000)
    assert "师徒仅用于明确拜师" in rec_sys
    _assert_no_transliteration(rec_sys)

    rec_user = build_reconcile_user(
        BookMeta(book_id="b", title="t", total_chapters=1),
        Cast(),
        SuspectList(),
        {1: "摘要"},
    )
    assert "误标的师徒" in rec_user
    _assert_no_transliteration(rec_user)
