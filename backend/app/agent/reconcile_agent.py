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
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, Optional

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from app.agent.llm import LLMControl, LLMBudgetExceeded, LLMStopped, get_reconcile_llm, invoke_controlled
from app.agent.relation_pipeline import enrich_relations
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
    stop_event: Optional[asyncio.Event] = None,
    control: Optional[LLMControl] = None,
    progress: Optional[Callable[[dict[str, Any]], Awaitable[None]]] = None,
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
    t_start = time.perf_counter()

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
    total_llm_ms = 0.0
    total_tool_ms = 0.0

    for step in range(max_steps):
        if (stop_event is not None and stop_event.is_set()) or (control is not None and control.stop_event.is_set()):
            return ReconcileResult(success=False, warning="Analysis stopped before reconcile request", steps_used=steps_used)
        steps_used = step + 1
        if progress is not None:
            await progress({"phase": "reconcile_waiting_model", "step": steps_used, "max_steps": max_steps})

        # ── LLM 调用 ──
        t_llm = time.perf_counter()
        try:
            ai_response: AIMessage = await invoke_controlled(
                llm_with_tools,
                messages,
                control=control,
                phase="reconcile",
                context=f"step={steps_used}/{max_steps}",
            )
        except Exception as e:
            logger.error("LLM invoke failed at step %d: %s", steps_used, e)
            return ReconcileResult(
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
                "Reconcile exited without tool calls at step %d llm_ms=%.0f",
                steps_used,
                llm_ms,
            )
            break

        # ── 执行工具 ──
        t_tool = time.perf_counter()
        for tc in tool_calls:
            if (stop_event is not None and stop_event.is_set()) or (control is not None and control.stop_event.is_set()):
                return ReconcileResult(success=False, warning="Analysis stopped during reconcile tools", steps_used=steps_used)
            tool_name = tc["name"]
            tool_args = tc["args"]
            tool_call_id = tc["id"]

            logger.debug("Tool call: %s", tool_name)

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

            if tool_name == "submit_reconciliation" and ctx.submit_patch is not None:
                submitted = True
                logger.info(
                    "submit_reconciliation success at step %d",
                    steps_used,
                )

            if len(tool_result) > cfg.reconcile_tool_result_chars:
                tool_result = tool_result[:cfg.reconcile_tool_result_chars] + "\n...[tool result truncated]"
            messages.append(
                ToolMessage(
                    content=tool_result,
                    tool_call_id=tool_call_id,
                )
            )
        tool_ms = (time.perf_counter() - t_tool) * 1000
        total_tool_ms += tool_ms
        # Keep initial instructions plus only the most recent tool exchange. This
        # prevents multi-step reconcile from carrying an ever-growing transcript.
        keep = max(2, cfg.reconcile_history_messages)
        if len(messages) > keep + 2:
            messages = messages[:2] + messages[-keep:]

        if progress is not None:
            await progress({
                "phase": "reconcile_tools",
                "step": steps_used,
                "max_steps": max_steps,
                "tools": [tc["name"] for tc in tool_calls],
                "llm_ms": round(llm_ms, 1),
                "tool_ms": round(tool_ms, 1),
            })
        logger.info(
            "Reconcile step %d/%d done: llm_ms=%.0f tool_ms=%.0f tools=[%s]",
            steps_used,
            max_steps,
            llm_ms,
            tool_ms,
            ", ".join(tc["name"] for tc in tool_calls),
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

    additions = {}
    for change in ctx.submit_patch.relation_changes:
        if change.action == "add":
            rel = change.relation
            additions.setdefault(rel.evidence.chapter_id, []).append(rel)
    for cid, relations in additions.items():
        if (stop_event is not None and stop_event.is_set()) or (control is not None and control.stop_event.is_set()):
            return ReconcileResult(success=False, warning="Analysis stopped before reconcile additions", steps_used=steps_used)
        await enrich_relations(
            meta.book_id, relations, cid, filestore, cfg,
            control=control, stop_event=stop_event, progress=progress,
        )

    total_ms = (time.perf_counter() - t_start) * 1000
    logger.info(
        "Reconcile agent done: steps=%d llm_ms=%.0f tool_ms=%.0f total_ms=%.0f",
        steps_used,
        total_llm_ms,
        total_tool_ms,
        total_ms,
    )

    return ReconcileResult(
        patch=ctx.submit_patch,
        success=True,
        steps_used=steps_used,
    )
