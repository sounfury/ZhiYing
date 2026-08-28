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
from app.agent.prompts.chapter import build_system_prompt
from app.models.book import BookMeta, Chapter
from app.models.cast import Cast
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


def _setup_chapter(content: str = "Siddhartha left the grove. Govinda stayed behind.") -> tuple[Filestore, str]:
    tmp = tempfile.mkdtemp()
    fs = Filestore(Path(tmp))
    book_id = "ch-agent"
    fs.create_book_dir(book_id)
    fs.write_meta(book_id, BookMeta(book_id=book_id, title="t", total_chapters=1))
    fs.write_chapter(
        book_id,
        Chapter(chapter_id=4, title="AWAKENING", order=4, content=content, word_count=20),
    )
    return fs, book_id


def _cfg() -> SimpleNamespace:
    return SimpleNamespace(
        inject_max_chars=100_000,
        read_window_chars=5_000,
        max_agent_steps=8,
    )


def test_no_tool_calls_after_propose_still_succeeds():
    """propose_persons 之后模型只回纯文本 → 自动 finalize，短章仍有 ledger。"""
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
                                    "aliases": ["Siddhartha"],
                                    "importance": "main",
                                },
                                {
                                    "canonical_name": "戈文达",
                                    "aliases": ["Govinda"],
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
    assert result.cast_buffer
    names = {p.canonical_name for p in result.cast_buffer.values()}
    assert "悉达多" in names
    assert "戈文达" in names
    assert result.summary  # 用了纯文本当 summary
    # 不应再多打一轮 LLM（propose + 纯文本即收尾）
    assert fake.calls == 2
    # 落盘
    disk = fs.read_ledger(book_id, 4)
    assert len(disk.persons) == 2


def test_prompt_covers_shitu_tongchang():
    prompt = build_system_prompt(5000)
    assert "仅当" in prompt and "拜师" in prompt
    assert "洗衣少女" in prompt
    assert "同场" in prompt
    assert "submit_result 必须调用" in prompt
    assert "Govinda" not in prompt
