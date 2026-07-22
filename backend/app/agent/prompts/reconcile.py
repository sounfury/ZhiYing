"""
Reconcile Agent 提示词模板。

System prompt: 总校对角色描述 + 纪律约束 + 工具列表 + 关系枚举 + 出口约定
User prompt: 书籍信息 + cast 摘要 + 可疑清单全文 + 各章 summary

对应 design.md \u00a75 Reconcile Prompt。
"""
from __future__ import annotations

from app.domain.relation_types import relation_summary_for_prompt
from app.logging_config import get_logger
from app.models.book import BookMeta
from app.models.cast import Cast
from app.models.reconcile import SuspectList

logger = get_logger("agent.prompts.reconcile")

# ── System Prompt ──

_SYSTEM_TEMPLATE = """\
你是一名全书总校对 Agent。你的任务是根据可疑清单，利用工具回查原文， \
做出合并 / 修正 / 待办决策，以结构化 patch 提交结果。

## 纪律

- 不重做全书分析，只处理可疑点与有据修正
- 没把握的写入待办(todos)，不要硬改
- 合并与改关系尽量带章号 + 原句
- 禁止无证据重写整本人名册或关系网

## 可用工具

1. **search_in_chapter(chapter_id, keyword)** — 在指定章搜关键词，返回命中行（上限 50 条）。
2. **read_chapter_text(chapter_id, offset, limit)** — 读指定章的字符窗口（limit 上限 {read_window_chars} 字符）。
3. **get_chapter_result(chapter_id)** — 查看该章分析结果（persons + relations + events + summary），只读。
4. **query_cast()** — 查询合并后的最终人名册，只读。
5. **submit_reconciliation(merges, aliases, relation_changes, todos)** — 提交校对结果，唯一出口。

## 关系类型枚举（唯一权威源）

只能使用以下关系类型，不在枚举内的 type 会被拒绝：

{relation_summary}

## 出口约定（submit_reconciliation 的 patch 格式）

  merges: [{{keep_id, drop_id, reason, evidence?}}]
    - keep_id / drop_id 必须在 cast 中存在且不相等
    - evidence 建议为 "章号 + 原句"

  aliases: [{{person_id, new_aliases: [str], reason?}}]
    - person_id 必须在 cast 中存在
    - new_aliases 不为空

  relation_changes: [{{action: "add"|"remove", person_a, person_b, type, chapter_id, quote?, note?}}]
    - action 必须为 "add" 或 "remove"
    - person_a / person_b 必须在 cast 中存在
    - type 必须在上述枚举内

  todos: [{{description, person_ids?, chapter_ids?}}]
    - description 不为空

校验失败会返回错误字符串，修正后重新提交。
"""


def build_system_prompt(read_window_chars: int) -> str:
    """构建 Reconcile system prompt。"""
    return _SYSTEM_TEMPLATE.format(
        relation_summary=relation_summary_for_prompt(),
        read_window_chars=read_window_chars,
    )


# ── User Prompt ──


def _build_cast_summary(cast: Cast) -> str:
    """构建 cast 的文字摘要。"""
    if not cast.persons:
        return "（空人名册）"

    lines = [f"人名册（合并后，共 {len(cast.persons)} 人）："]
    for p in cast.persons:
        aliases_str = ", ".join(a.name for a in p.aliases) if p.aliases else "无"
        lines.append(f"  - {p.person_id}: {p.canonical_name} (别名: {aliases_str})")

    return "\n".join(lines)


def _build_suspects_text(suspects: SuspectList) -> str:
    """构建可疑清单的文字描述。"""
    sections: list[str] = []

    # 人名冲突
    if suspects.cast_conflicts:
        sections.append(f"### 可能是同一个人（{len(suspects.cast_conflicts)} 项）")
        for c in suspects.cast_conflicts:
            sections.append(
                f"  - {c.person_a_id} ↔ {c.person_b_id} "
                f"[{c.reason}] 重叠别名: {', '.join(c.aliases_overlap)}"
            )
    else:
        sections.append("### 可能是同一个人（0 项）\n  无")

    # 关系冲突
    if suspects.relation_conflicts:
        sections.append(f"\n### 关系冲突（{len(suspects.relation_conflicts)} 项）")
        for r in suspects.relation_conflicts:
            chs = ", ".join(str(ch) for ch in r.chapters)
            sections.append(
                f"  - {r.person_a} ↔ {r.person_b} "
                f"[{r.conflict_type}] chapters: {chs} — {r.details}"
            )
    else:
        sections.append("\n### 关系冲突（0 项）\n  无")

    # 缺证据
    if suspects.missing_evidence:
        sections.append(f"\n### 缺少证据（{len(suspects.missing_evidence)} 项）")
        for m in suspects.missing_evidence:
            sections.append(
                f"  - {m.person_a} ↔ {m.person_b} [{m.type}] chapter_{m.chapter_id}"
            )
    else:
        sections.append("\n### 缺少证据（0 项）\n  无")

    return "\n".join(sections)


def _build_chapter_summaries(chapter_summaries: dict[int, str]) -> str:
    """构建各章摘要文本。"""
    if not chapter_summaries:
        return "（无章摘要）"

    lines = []
    for cid in sorted(chapter_summaries.keys()):
        lines.append(f"  - 第 {cid} 章: {chapter_summaries[cid]}")

    return "\n".join(lines)


def build_user_prompt(
    meta: BookMeta,
    cast: Cast,
    suspects: SuspectList,
    chapter_summaries: dict[int, str],
) -> str:
    """
    构建 Reconcile user prompt。

    Args:
        meta: 书籍元数据（取 title + chapters_done）
        cast: 合并后的最终 cast
        suspects: 可疑清单
        chapter_summaries: {chapter_id: summary} 字典
    """
    chapters_done = meta.analysis_progress.chapters_done
    if chapters_done:
        ch_range = f"第 {min(chapters_done)}-{max(chapters_done)} 章（共 {len(chapters_done)} 章）"
    else:
        ch_range = "无"

    cast_summary = _build_cast_summary(cast)
    suspects_text = _build_suspects_text(suspects)
    summaries_text = _build_chapter_summaries(chapter_summaries)

    return (
        f"## 书籍信息\n"
        f"- 书名: {meta.title}\n"
        f"- 分析章范围: {ch_range}\n\n"
        f"## 人名册（合并后，共 {len(cast.persons)} 人）\n{cast_summary}\n\n"
        f"## 可疑清单\n{suspects_text}\n\n"
        f"## 各章摘要\n{summaries_text}\n\n"
        f"## 任务\n"
        f"请逐项处理可疑清单。对每项：\n"
        f"1. 先用工具回查原文（search_in_chapter / read_chapter_text / get_chapter_result）\n"
        f"2. 做出决策：合并 / 改别名 / 改关系 / 写待办\n"
        f"3. 全部处理完后，用 submit_reconciliation 一次性提交。\n"
    )