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
import time
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

_SUBMIT_REMINDER = (
    "你刚才没有调用任何工具。纯文本不会写入账本。"
    "若人物/关系已提交完毕，请立即调用 submit_result(summary) 结束本章；"
    "若尚未提交，请先 propose_persons / submit_relations，最后必须调用 submit_result。"
    "即使本章很短、出场很少，也必须调用 submit_result，否则本章没有账本。"
)


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
    长章：min(60, 15 + 2 * num_windows)

    基数 15 = 读窗后非读窗步骤的预算：
      grep 取证 ~7 + propose_persons ~1 + submit_relations ~5 + submit_result ~1 + 余量 ~1
    """
    if char_count <= inject_max_chars:
        return base_max_steps

    num_windows = math.ceil(char_count / read_window_chars) if read_window_chars > 0 else 1
    return min(60, 15 + 2 * num_windows)


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
    t_start = time.perf_counter()

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
    auto_finalized = False
    reminded_submit = False
    total_llm_ms = 0.0
    total_tool_ms = 0.0

    for step in range(max_steps):
        steps_used = step + 1

        # ── LLM 调用 ──
        t_llm = time.perf_counter()
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
        llm_ms = (time.perf_counter() - t_llm) * 1000
        total_llm_ms += llm_ms

        messages.append(ai_response)

        # 检查是否有 tool_calls
        tool_calls = getattr(ai_response, "tool_calls", None)
        if not tool_calls:
            logger.info(
                "Agent emitted no tool calls at step %d (ch=%d) llm_ms=%.0f",
                steps_used,
                chapter_id,
                llm_ms,
            )
            # 已有人物/关系 → 走与 submit_result 相同的路径自动收尾
            if ctx.has_accumulated_work() or ctx.submit_ledger is not None:
                if ctx.submit_ledger is None:
                    summary = _summary_from_ai(ai_response)
                    ctx.finalize_submit(summary=summary)
                    auto_finalized = True
                submitted = True
                logger.info(
                    "Auto-finalized chapter %d at step %d (persons=%d relations=%d)",
                    chapter_id,
                    steps_used,
                    len(ctx.cast_buffer),
                    len(ctx.relations_buffer),
                )
                break
            # 尚未累积：提醒一次继续循环，要求调用 submit_result
            if not reminded_submit and step < max_steps - 1:
                reminded_submit = True
                messages.append(HumanMessage(content=_SUBMIT_REMINDER))
                logger.info("Reminded agent to submit_result (ch=%d step=%d)", chapter_id, steps_used)
                continue
            # 提醒过仍不调工具：空账本也要落盘，避免短章丢失
            ctx.finalize_submit(summary=_summary_from_ai(ai_response))
            auto_finalized = True
            submitted = True
            logger.info("Auto-finalized empty chapter %d after no tool calls", chapter_id)
            break

        # ── 执行工具 ──
        t_tool = time.perf_counter()
        for tc in tool_calls:
            tool_name = tc["name"]
            tool_args = tc["args"]
            tool_call_id = tc["id"]

            logger.debug(
                "Tool call: %s (ch=%d)", tool_name, chapter_id
            )

            tool_fn = tool_map.get(tool_name)
            if tool_fn is None:
                tool_result = json.dumps(
                    {"error": f"Unknown tool: {tool_name}"}, ensure_ascii=False
                )
            else:
                try:
                    tool_result = tool_fn.invoke(tool_args)
                except Exception as e:
                    tool_result = json.dumps(
                        {"error": f"Tool '{tool_name}' failed: {e}"},
                        ensure_ascii=False,
                    )

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
        tool_ms = (time.perf_counter() - t_tool) * 1000
        total_tool_ms += tool_ms

        logger.info(
            "Step %d/%d done (ch=%d): llm_ms=%.0f tool_ms=%.0f tools=[%s]",
            steps_used,
            max_steps,
            chapter_id,
            llm_ms,
            tool_ms,
            ", ".join(tc["name"] for tc in tool_calls),
        )

        if submitted:
            break

    # 步数用尽仍未提交：若已有人物/关系则自动收尾
    if not submitted and (ctx.has_accumulated_work() or ctx.submit_ledger is not None):
        if ctx.submit_ledger is None:
            ctx.finalize_submit(summary="")
            auto_finalized = True
        submitted = True
        logger.info(
            "Auto-finalized chapter %d after %d steps (persons=%d relations=%d)",
            chapter_id,
            steps_used,
            len(ctx.cast_buffer),
            len(ctx.relations_buffer),
        )

    # ── 构建结果 ──
    if not submitted:
        logger.warning(
            "Agent did not submit_result within %d steps (ch=%d)",
            max_steps,
            chapter_id,
        )

    warning = ""
    if not submitted:
        warning = f"Did not submit within {max_steps} steps"
    elif auto_finalized:
        warning = "auto-finalized without submit_result"

    result = AgentResult(
        chapter_id=chapter_id,
        ledger=ctx.submit_ledger,
        cast_buffer=ctx.cast_buffer,
        summary=ctx.submit_ledger.summary if ctx.submit_ledger else "",
        success=submitted,
        warning=warning,
        steps_used=steps_used,
    )

    # ── 落盘含临时 id 的 ledger ──
    if result.ledger is not None:
        await asyncio.to_thread(filestore.write_ledger, book_id, result.ledger)

    total_ms = (time.perf_counter() - t_start) * 1000
    logger.info(
        "Chapter agent done: ch=%d success=%s steps=%d "
        "llm_ms=%.0f tool_ms=%.0f total_ms=%.0f",
        chapter_id,
        submitted,
        steps_used,
        total_llm_ms,
        total_tool_ms,
        total_ms,
    )

    return result


def _summary_from_ai(ai_response: AIMessage) -> str:
    """从模型的非工具文本里摘一句话当 summary（过长截断）。"""
    content = getattr(ai_response, "content", "") or ""
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
        content = "\n".join(parts)
    text = str(content).strip()
    if len(text) > 2000:
        text = text[:2000]
    return text

