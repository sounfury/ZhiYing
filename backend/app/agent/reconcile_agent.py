"""
Reconcile Agent 运行时 -- 全书总校对的 LangChain tool-calling loop。

流程：
  1. 构建 system/user prompt（注入 cast 摘要 + 可疑清单 + 各章 summary）
  2. 创建 ReconcileToolContext + make_reconcile_tools
  3. ChatOpenAI.bind_tools → tool-calling loop（max_reconcile_steps 控制）
  4. 模型调用 submit_reconciliation 成功 → 退出循环，返回 ReconcilePatch
  5. 未在步数上限内提交 → success=False

复用现有 llm.py 的 get_reconcile_llm。
对应 design.md \u00a71/\u00a74/\u00a75。
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Dict, List, Optional

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from app.agent.llm import get_reconcile_llm
from app.agent.prompts.reconcile import build_system_prompt, build_user_prompt
from app.agent.tools import ReconcileToolContext, make_reconcile_tools
from app.config import Settings, settings
from app.logging_config import get_logger
from app.models.book import BookMeta
from app.models.cast import Cast
from app.models.reconcile import ReconcilePatch, SuspectList
from app.storage.filestore import Filestore

logger = get_logger("agent.reconcile_agent")


@dataclass
class ReconcileResult:
    """Reconcile Agent 运行结果。"""

    patch: Optional[ReconcilePatch] = None
    success: bool = False
    warning: str = ""
    steps_used: int = 0


async def run_reconcile_agent(
    meta: BookMeta,
    cast: Cast,
    suspects: SuspectList,
    chapter_summaries: Dict[int, str],
    filestore: Filestore,
    cfg: Optional[Settings] = None,
) -> ReconcileResult:
    """
    运行全书总校对 Agent。

    Args:
        meta: 书籍元数据（取 title + chapters_done）
        cast: 合并后的最终 cast（只读）
        suspects: 可疑清单
        chapter_summaries: {chapter_id: summary} 字典
        filestore: Filestore 实例
        cfg: Settings 实例（不传则用全局 settings）

    Returns:
        ReconcileResult: 含 patch（成功时）或 warning（失败时）
    """
    cfg = cfg or settings
    max_steps = cfg.max_reconcile_steps

    logger.info(
        "Reconcile agent start: book=%s cast=%d suspects=%d steps=%d",
        meta.book_id,
        len(cast.persons),
        len(suspects.cast_conflicts) + len(suspects.relation_conflicts) + len(suspects.missing_evidence),
        max_steps,
    )

    # ── 构建 prompt ──
    system_prompt_text = build_system_prompt(cfg.read_window_chars)
    user_prompt_text = build_user_prompt(meta, cast, suspects, chapter_summaries)

    # ── 创建上下文和工具 ──
    ctx = ReconcileToolContext(
        book_id=meta.book_id,
        cast=cast,
        suspects=suspects,
        chapter_summaries=chapter_summaries,
        filestore=filestore,
    )
    tools = make_reconcile_tools(ctx)
    tool_map = {t.name: t for t in tools}

    # ── 创建 LLM 并绑定工具 ──
    llm = get_reconcile_llm(cfg)
    llm_with_tools = llm.bind_tools(tools)

    # ── 构建初始消息 ──
    messages: list = [
        SystemMessage(content=system_prompt_text),
        HumanMessage(content=user_prompt_text),
    ]

    # ── Tool-calling loop ──
    steps_used = 0
    submitted = False

    for step in range(max_steps):
        steps_used = step + 1
        logger.debug("Reconcile step %d/%d", steps_used, max_steps)

        # 调用模型
        try:
            ai_response: AIMessage = await asyncio.to_thread(
                llm_with_tools.invoke, messages
            )
        except Exception as e:
            logger.error("LLM invoke failed at step %d: %s", steps_used, e)
            return ReconcileResult(
                success=False,
                warning=f"LLM invoke failed: {e}",
                steps_used=steps_used,
            )

        messages.append(ai_response)

        # 检查是否有 tool_calls
        tool_calls = getattr(ai_response, "tool_calls", None)
        if not tool_calls:
            logger.info(
                "Reconcile agent exited without tool calls at step %d",
                steps_used,
            )
            break

        # 执行每个工具调用
        for tc in tool_calls:
            tool_name = tc["name"]
            tool_args = tc["args"]
            tool_call_id = tc["id"]

            logger.debug("Tool call: %s args=%s", tool_name, tool_args)

            tool_fn = tool_map.get(tool_name)
            if tool_fn is None:
                tool_result = '{"error": "Unknown tool: %s"}' % tool_name
            else:
                try:
                    tool_result = tool_fn.invoke(tool_args)
                except Exception as e:
                    tool_result = '{"error": "Tool \'%s\' failed: %s"}' % (
                        tool_name,
                        e,
                    )

            # 检查 submit_reconciliation 是否成功
            # 以 ctx.submit_patch 是否被写入为准，与工具写入逻辑直接绑定
            if tool_name == "submit_reconciliation" and ctx.submit_patch is not None:
                submitted = True
                logger.info(
                    "submit_reconciliation success at step %d",
                    steps_used,
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
            "Reconcile agent did not submit within %d steps",
            max_steps,
        )
        return ReconcileResult(
            success=False,
            warning=f"Did not submit within {max_steps} steps",
            steps_used=steps_used,
        )

    return ReconcileResult(
        patch=ctx.submit_patch,
        success=True,
        steps_used=steps_used,
    )