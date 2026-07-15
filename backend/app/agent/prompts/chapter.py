"""
Chapter Agent 提示词模板。

System prompt: 角色描述 + 关系枚举 + 工具纪律 + 出口约定
User prompt: 章节元信息 + cast 快照摘要 + (短章)全文 / (长章)分窗纪律
"""
from __future__ import annotations

from langchain_core.prompts import ChatPromptTemplate

from app.domain.relation_types import relation_summary_for_prompt
from app.logging_config import get_logger
from app.models.book import Chapter
from app.models.cast import Cast

logger = get_logger("agent.prompts.chapter")

# ── System Prompt ──

_SYSTEM_TEMPLATE = """\
你是一名专业的章级人物关系分析 Agent。你的任务是分析给定章节中的出场人物及其相互关系，并以结构化格式提交结果。

## 可用工具

你有以下工具可以调用：

1. **read_chapter_window(offset, limit)** — 按字符偏移读取章节正文窗口（limit 上限 {read_window_chars} 字符）。
2. **grep_in_chapter(keyword)** — 在本章正文中搜索关键词，返回命中行。
3. **query_cast()** — 查询当前冻结的人名册快照（只读）。
4. **propose_cast_update(canonical_name, aliases, bio, gender, importance)** — 提议新人物加入人名册，返回临时 person_id（格式 ch{{章号}}_p{{序号}}）。
5. **submit_result(persons, relations, events, summary)** — 提交本章分析结果。这是最终步骤。

## 工具使用纪律

- **先读文再分析**：如果正文未注入 prompt，必须先调用 read_chapter_window 逐窗读取全文后再分析。
- **同一人物不重复 propose**：同一 canonical_name 再次 propose 会返回已有 id，不会创建新人物。
- **章末一次 submit**：分析完成后调用一次 submit_result 提交全部结果。

## 关系类型枚举（唯一权威源）

只能使用以下关系类型，不在枚举内的 type 会被拒绝：

{relation_summary}

## 出口约定（submit_result 校验规则）

1. 每条 relation 的 type 必须在上述枚举内。
2. person_a / person_b 必须在 cast 快照或本章 propose 的新人中存在（先 propose 再 submit）。
3. 不允许自环（person_a == person_b）。
4. 校验失败会返回错误字符串，修正后重新 submit。

## 输出语言

- canonical_name、aliases、bio、summary 等文本字段：使用书中出现的原文语言（通常为中文）。
- 关系 type：必须使用上述枚举中的中文类型名。
"""


def _build_cast_summary(cast: Cast) -> str:
    """构建 cast 快照的文字摘要。"""
    if not cast.persons:
        return "（空人名册——无预设人物，需通过 propose_cast_update 提议本章出场人物）"

    lines = ["当前人名册快照（只读，分析期间不更新）："]
    for p in cast.persons:
        aliases_str = ", ".join(a.name for a in p.aliases) if p.aliases else "无"
        lines.append(f"  - {p.person_id}: {p.canonical_name} (别名: {aliases_str})")

    return "\n".join(lines)


def _build_short_chapter_prompt(chapter: Chapter, cast_summary: str) -> str:
    """短章模式：注入全文。"""
    return (
        f"## 章节信息\n"
        f"- chapter_id: {chapter.chapter_id}\n"
        f"- title: {chapter.title}\n"
        f"- order: {chapter.order}\n"
        f"- char_count: {len(chapter.content)}\n\n"
        f"## 人名册快照\n{cast_summary}\n\n"
        f"## 本章正文（全文注入）\n\n"
        f"{chapter.content}\n\n"
        f"## 任务\n"
        f"请分析本章出场的人物及其关系。\n"
        f"1. 对每个出场人物，用 propose_cast_update 提议（如果已在 cast 快照中则直接引用其 person_id）。\n"
        f"2. 提取人物之间的关系（使用枚举内的 type）。\n"
        f"3. 记录本章重要事件（可选）。\n"
        f"4. 写一句话章总结。\n"
        f"5. 用 submit_result 提交全部结果。\n"
    )


def _build_long_chapter_prompt(
    chapter: Chapter,
    cast_summary: str,
    num_windows: int,
    read_window_chars: int,
) -> str:
    """长章模式：不注入正文，给出分窗纪律。"""
    return (
        f"## 章节信息\n"
        f"- chapter_id: {chapter.chapter_id}\n"
        f"- title: {chapter.title}\n"
        f"- order: {chapter.order}\n"
        f"- char_count: {len(chapter.content)}\n\n"
        f"## 人名册快照\n{cast_summary}\n\n"
        f"## 阅读指令\n"
        f"本章共 {len(chapter.content)} 字符，已超出直接注入上限。\n"
        f"建议分 {num_windows} 窗读取（每窗 {read_window_chars} 字符）。\n"
        f"请使用 read_chapter_window(offset, limit) 逐窗读取全文后再分析。\n"
        f"从 offset=0 开始，每次推进 offset += {read_window_chars}，直到 has_more=false。\n"
        f"如需精确查找某人名，可使用 grep_in_chapter(keyword) 快速定位。\n\n"
        f"## 任务\n"
        f"读完正文后：对每个出场人物 propose、提取关系、记录事件、写章总结，最后 submit_result。\n"
    )


def build_user_prompt(
    chapter: Chapter,
    cast_snapshot: Cast,
    inject_max_chars: int,
    read_window_chars: int,
) -> tuple[str, bool]:
    """
    构建 user prompt。

    Returns:
        (prompt_text, is_short_chapter)
        is_short_chapter=True 表示短章（全文已注入）
        is_short_chapter=False 表示长章（需分窗读取）
    """
    cast_summary = _build_cast_summary(cast_snapshot)
    char_count = len(chapter.content)

    if char_count <= inject_max_chars:
        return _build_short_chapter_prompt(chapter, cast_summary), True

    num_windows = -(-char_count // read_window_chars)  # ceil division
    return (
        _build_long_chapter_prompt(chapter, cast_summary, num_windows, read_window_chars),
        False,
    )


def build_system_prompt(read_window_chars: int) -> str:
    """构建 system prompt，填充关系枚举和阅读窗参数。"""
    return _SYSTEM_TEMPLATE.format(
        relation_summary=relation_summary_for_prompt(),
        read_window_chars=read_window_chars,
    )


def get_chapter_prompt_template(read_window_chars: int) -> ChatPromptTemplate:
    """
    获取章节分析用的 ChatPromptTemplate。

    变量：
      - system: system prompt 字符串
      - user: user prompt 字符串
    """
    return ChatPromptTemplate.from_messages(
        [
            ("system", "{system}"),
            ("human", "{user}"),
        ]
    )
