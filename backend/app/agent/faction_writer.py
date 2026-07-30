"""
FactionWriter 运行时 — 全书势力（团体聚合）归纳的 LangChain tool-calling loop。

在 Chapter Agent + CastWriter + Reconcile 之后跑，不改章级链路：
势力是全书级归属，一次看全量人名册 + 各章摘要 + 硬/中关系骨架来分块，
比逐章猜团体稳（逐章会造出「学校朋友」这类跨章不一致的块名）。

流程：
  1. 收集输入（cast + 各章 summary + Aggregator 关系骨架）
  2. 构建 prompt → make_faction_tools
  3. tool-calling loop（max_faction_steps 控制）
  4. 模型调用 submit_factions 成功 → 写 factions.json
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Dict, List, Optional

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from app.agent.llm import create_chat_model
from app.agent.prompts.faction import build_system_prompt, build_user_prompt
from app.agent.tools import FactionToolContext, make_faction_tools
from app.config import Settings, settings
from app.core.aggregator import Aggregator, GraphQuery
from app.logging_config import get_logger
from app.models.book import BookMeta
from app.models.cast import Cast
from app.models.faction import FactionBook
from app.models.graph import GraphEdge
from app.storage.filestore import Filestore

logger = get_logger("agent.faction_writer")


@dataclass
class FactionResult:
    """FactionWriter 运行结果。"""

    book: Optional[FactionBook] = None
    success: bool = False
    warning: str = ""
    steps_used: int = 0


async def run_faction_agent(
    meta: BookMeta,
    cast: Cast,
    edges: List[GraphEdge],
    chapter_summaries: Dict[int, str],
    filestore: Filestore,
    cfg: Optional[Settings] = None,
) -> FactionResult:
    """
    运行势力归纳 Agent。不写盘——由调用方决定是否落 factions.json。

    Args:
        meta: 书籍元数据（取 title）
        cast: 合并后的最终 cast（只读）
        edges: Aggregator 编译出的边，用于给模型关系骨架
        chapter_summaries: {chapter_id: summary}
        filestore: Filestore 实例
        cfg: Settings 实例（不传则用全局 settings）
    """
    cfg = cfg or settings
    max_steps = cfg.max_faction_steps
    t_start = time.perf_counter()

    if not cast.persons:
        return FactionResult(success=False, warning="empty cast, nothing to group")

    logger.info(
        "Faction agent start: book=%s cast=%d edges=%d chapters=%d steps=%d",
        meta.book_id,
        len(cast.persons),
        len(edges),
        len(chapter_summaries),
        max_steps,
    )

    ctx = FactionToolContext(
        book_id=meta.book_id,
        cast=cast,
        chapter_summaries=chapter_summaries,
        filestore=filestore,
    )
    tools = make_faction_tools(ctx)
    tool_map = {t.name: t for t in tools}

    llm = create_chat_model(cfg.faction_model, temperature=0.0, cfg=cfg)
    llm_with_tools = llm.bind_tools(tools)

    messages: list = [
        SystemMessage(
            content=build_system_prompt(cfg.faction_min_blocks, cfg.faction_max_blocks)
        ),
        HumanMessage(
            content=build_user_prompt(
                meta,
                cast,
                edges,
                chapter_summaries,
                cfg.faction_min_blocks,
                cfg.faction_max_blocks,
            )
        ),
    ]

    steps_used = 0
    submitted = False
    total_llm_ms = 0.0
    total_tool_ms = 0.0

    for step in range(max_steps):
        steps_used = step + 1

        t_llm = time.perf_counter()
        try:
            ai_response: AIMessage = await asyncio.to_thread(
                llm_with_tools.invoke, messages
            )
        except Exception as e:
            logger.error("LLM invoke failed at step %d: %s", steps_used, e)
            return FactionResult(
                success=False,
                warning=f"LLM invoke failed: {e}",
                steps_used=steps_used,
            )
        llm_ms = (time.perf_counter() - t_llm) * 1000
        total_llm_ms += llm_ms
        messages.append(ai_response)

        tool_calls = getattr(ai_response, "tool_calls", None)
        if not tool_calls:
            logger.info(
                "Faction agent exited without tool calls at step %d llm_ms=%.0f",
                steps_used,
                llm_ms,
            )
            break

        t_tool = time.perf_counter()
        for tc in tool_calls:
            tool_name = tc["name"]
            tool_fn = tool_map.get(tool_name)
            if tool_fn is None:
                tool_result = '{"error": "Unknown tool: %s"}' % tool_name
            else:
                try:
                    tool_result = tool_fn.invoke(tc["args"])
                except Exception as e:
                    tool_result = '{"error": "Tool \'%s\' failed: %s"}' % (tool_name, e)

            if tool_name == "submit_factions" and ctx.submit_book is not None:
                submitted = True

            messages.append(ToolMessage(content=tool_result, tool_call_id=tc["id"]))
        total_tool_ms += (time.perf_counter() - t_tool) * 1000

        logger.info(
            "Faction step %d/%d done: llm_ms=%.0f tools=[%s]",
            steps_used,
            max_steps,
            llm_ms,
            ", ".join(tc["name"] for tc in tool_calls),
        )

        if submitted:
            break

    if not submitted or ctx.submit_book is None:
        logger.warning("Faction agent did not submit within %d steps", max_steps)
        return FactionResult(
            success=False,
            warning=f"Did not submit within {max_steps} steps",
            steps_used=steps_used,
        )

    logger.info(
        "Faction agent done: steps=%d factions=%d llm_ms=%.0f tool_ms=%.0f total_ms=%.0f",
        steps_used,
        len(ctx.submit_book.factions),
        total_llm_ms,
        total_tool_ms,
        (time.perf_counter() - t_start) * 1000,
    )

    return FactionResult(book=ctx.submit_book, success=True, steps_used=steps_used)


async def extract_factions(
    book_id: str,
    filestore: Filestore,
    cfg: Optional[Settings] = None,
) -> FactionResult:
    """
    端到端跑一次势力归纳并写 factions.json。

    供 Orchestrator（分析末尾）与 POST /factions（已分析的旧书补跑）共用。
    成功时 bump version 后落盘；失败时保留旧 factions.json 不动。
    """
    cfg = cfg or settings

    meta = await asyncio.to_thread(filestore.read_meta, book_id)
    cast = await asyncio.to_thread(filestore.read_cast, book_id)

    chapters_done = meta.analysis_progress.chapters_done
    ledgers = await asyncio.to_thread(filestore.read_ledgers, book_id, chapters_done)
    chapter_summaries = {l.chapter_id: l.summary for l in ledgers}

    # 关系骨架：min_appearance=1，尽量给全量边，prompt 侧再筛 hard/mid
    graph = await asyncio.to_thread(
        Aggregator(book_id, filestore).compile, GraphQuery(min_appearance=1)
    )

    result = await run_faction_agent(
        meta, cast, graph.edges, chapter_summaries, filestore, cfg
    )

    if result.success and result.book is not None:
        prev = await asyncio.to_thread(filestore.read_factions, book_id)
        result.book.version = prev.version + 1
        await asyncio.to_thread(filestore.write_factions, book_id, result.book)
        logger.info(
            "factions.json written: book=%s version=%d factions=%d",
            book_id,
            result.book.version,
            len(result.book.factions),
        )

    return result
