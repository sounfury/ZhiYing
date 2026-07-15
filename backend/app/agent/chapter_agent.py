"""
Chapter Agent 运行时 -- 单章分析的 LangChain tool-calling loop。

流程：
  1. 从 Filestore 读取章节
  2. 短章整章注入 / 长章分窗提示
  3. 创建 ChapterToolContext + make_tools
  4. ChatOpenAI.bind_tools → tool-calling loop（max_agent_steps 控制）
  5. 模型调用 submit_result 成功 → 退出循环
  6. 落盘 ChapterLedger（含临时 person_id）

D2: ledger 先存临时 id，CastWriter apply 后 rewrite
"""
from __future__ import annotations

import asyncio
import json
import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from app.agent.llm import get_chapter_llm
from app.agent.prompts.chapter import (
    build_system_prompt,
    build_user_prompt,
    get_chapter_prompt_template,
)
from app.agent.tools import ChapterToolContext, make_tools
from app.config import Settings, settings
from app.logging_config import get_logger
from app.models.cast import Cast
from app.models.ledger import CastPropose, ChapterLedger
from app.storage.filestore import Filestore

logger = get_logger("agent.chapter_agent")


@dataclass
class AgentResult:
    """单章 Agent 运行结果。"""

    chapter_id: int
    ledger: Optional[ChapterLedger] = None
    cast_buffer: Dict[str, CastPropose] = field(default_factory=dict)
    summary: str = ""
    success: bool = False
    warning: str = ""
    steps_used: int = 0


def _calc_max_steps(
    char_count: int,
    inject_max_chars: int,
    read_window_chars: int,
    base_max_steps: int,
) -> int:
    """
    计算本章 Agent 的最大步数。

    短章：使用 base_max_steps
    长章：min(40, 8 + 2 * num_windows)
    """
    if char_count <= inject_max_chars:
        return base_max_steps

    num_windows = math.ceil(char_count / read_window_chars) if read_window_chars > 0 else 1
    return min(40, 8 + 2 * num_windows)


async def run_chapter_agent(
    book_id: str,
    chapter_id: int,
    cast_snapshot: Cast,
    filestore: Filestore,
    cfg: Optional[Settings] = None,
) -> AgentResult:
    """
    运行单章分析 Agent。

    Args:
        book_id: 书籍 ID
        chapter_id: 章节 ID
        cast_snapshot: 冻结的 cast 快照（只读）
        filestore: Filestore 实例
        cfg: Settings 实例（不传则用全局 settings）

    Returns:
        AgentResult: 含 ledger（临时 id）、cast_buffer、summary
    """
    cfg = cfg or settings

    # ── 读取章节 ──
    chapter = await asyncio.to_thread(filestore.read_chapter, book_id, chapter_id)
    char_count = len(chapter.content)
    logger.info(
        "Chapter agent start: book=%s ch=%d chars=%d title=%s",
        book_id,
        chapter_id,
        char_count,
        chapter.title,
    )

    # ── 构建 prompt ──
    user_prompt_text, is_short = build_user_prompt(
        chapter, cast_snapshot, cfg.inject_max_chars, cfg.read_window_chars
    )
    system_prompt_text = build_system_prompt(cfg.read_window_chars)

    # ── 计算步数上限 ──
    max_steps = _calc_max_steps(
        char_count, cfg.inject_max_chars, cfg.read_window_chars, cfg.max_agent_steps
    )
    logger.info("max_agent_steps=%d (short=%s)", max_steps, is_short)

    # ── 创建上下文和工具 ──
    ctx = ChapterToolContext(
        book_id=book_id,
        chapter_id=chapter_id,
        cast_snapshot=cast_snapshot,
        filestore=filestore,
    )
    tools = make_tools(ctx)
    tool_map = {t.name: t for t in tools}

    # ── 创建 LLM 并绑定工具 ──
    llm = get_chapter_llm(cfg)
    llm_with_tools = llm.bind_tools(tools)

    # ── 构建初始消息 ──
    messages = [
        SystemMessage(content=system_prompt_text),
        HumanMessage(content=user_prompt_text),
    ]

    # ── Tool-calling loop ──
    steps_used = 0
    submitted = False

    for step in range(max_steps):
        steps_used = step + 1
        logger.debug("Step %d/%d (ch=%d)", steps_used, max_steps, chapter_id)

        # 调用模型
        try:
            ai_response: AIMessage = await asyncio.to_thread(
                llm_with_tools.invoke, messages
            )
        except Exception as e:
            logger.error("LLM invoke failed at step %d: %s", steps_used, e)
            return AgentResult(
                chapter_id=chapter_id,
                cast_buffer=ctx.cast_buffer,
                success=False,
                warning=f"LLM invoke failed: {e}",
                steps_used=steps_used,
            )

        messages.append(ai_response)

        # 检查是否有 tool_calls
        tool_calls = getattr(ai_response, "tool_calls", None)
        if not tool_calls:
            # 模型没有调用工具 = done（可能直接给了文本回复）
            logger.info(
                "Agent exited without tool calls at step %d (ch=%d)",
                steps_used,
                chapter_id,
            )
            break

        # 执行每个工具调用
        for tc in tool_calls:
            tool_name = tc["name"]
            tool_args = tc["args"]
            tool_call_id = tc["id"]

            logger.debug(
                "Tool call: %s args=%s (ch=%d)", tool_name, tool_args, chapter_id
            )

            tool_fn = tool_map.get(tool_name)
            if tool_fn is None:
                tool_result = json.dumps(
                    {"error": f"Unknown tool: {tool_name}"}, ensure_ascii=False
                )
            else:
                # #11: 工具异常不砸穿整步，返回错误 JSON 让模型改
                try:
                    tool_result = tool_fn.invoke(tool_args)
                except Exception as e:
                    tool_result = json.dumps(
                        {"error": f"Tool '{tool_name}' failed: {e}"},
                        ensure_ascii=False,
                    )

            # 检查 submit_result 是否成功
            if tool_name == "submit_result":
                result_data = json.loads(tool_result)
                if result_data.get("status") == "submitted":
                    submitted = True
                    logger.info(
                        "submit_result success at step %d (ch=%d)",
                        steps_used,
                        chapter_id,
                    )

            messages.append(
                ToolMessage(
                    content=tool_result,
                    tool_call_id=tool_call_id,
                )
            )

        if submitted:
            break

    # ── 构建结果 ──
    if not submitted:
        logger.warning(
            "Agent did not submit_result within %d steps (ch=%d)",
            max_steps,
            chapter_id,
        )

    result = AgentResult(
        chapter_id=chapter_id,
        ledger=ctx.submit_ledger,
        cast_buffer=ctx.cast_buffer,
        summary=ctx.submit_ledger.summary if ctx.submit_ledger else "",
        success=submitted,
        warning="" if submitted else f"Did not submit within {max_steps} steps",
        steps_used=steps_used,
    )

    # ── 落盘含临时 id 的 ledger ──
    if result.ledger is not None:
        await asyncio.to_thread(filestore.write_ledger, book_id, result.ledger)
        logger.info(
            "Ledger persisted (temp ids): book=%s ch=%d",
            book_id,
            chapter_id,
        )

    return result
