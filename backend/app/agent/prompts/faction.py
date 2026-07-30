"""
FactionWriter 提示词模板。

System prompt: 势力语义（PRD §3.1）+ kind 枚举 + 禁止关系类型当块名 + 出口约定
User prompt: 书名 + 人名册全量 + 各章摘要 + 硬/中关系边摘要

不改章级链路：势力是全书级归属，一次性看全书人名册 + 摘要 + 关系骨架来分块，
比逐章猜团体更稳（逐章会造出「学校朋友」「同学们」这类跨章不一致的块名）。
"""
from __future__ import annotations

from app.logging_config import get_logger
from app.models.book import BookMeta
from app.models.cast import Cast
from app.models.graph import GraphEdge

logger = get_logger("agent.prompts.faction")

# 关系边摘要上限（防 prompt 过长）
_MAX_EDGE_LINES = 220
# bio 截断
_MAX_BIO_CHARS = 60

_SYSTEM_TEMPLATE = """\
你是一名小说人物「势力（团体聚合）」归纳 Agent。你的任务是把全书人物划成若干**可读的团体块**，\
供关系图按块分区布局。

## 什么叫势力

势力 = **人物所属的团体聚合**：一群人因共同机构、场景世界、组织身份或稳定归属而聚在一起。

算势力的例子：学校 / 年级阶段（小学、中学、大学）、宗教与教会、组织机构（公司、门派、军队、学院）、\
家族作为团体块、政治或意识形态阵营、某一阶段的生活世界。

**不算势力（这些是关系边，不是块）**：
- 两人之间的关系类型：朋友、同学、亲子、师徒、相识、同场…
- 亲疏强弱（和主角第几档亲）
- 单次同场

绝对禁止把「朋友」「同学」「相识」「亲人」「主角的朋友们」这类**关系词**当势力名。
「小学朋友」和「大学朋友」线相同、块不同——正确的块名是**学校名**，不是「朋友」。

## kind 枚举（必须取其中之一）

- school       学校 / 年级阶段
- religious    宗教 / 教会 / 修会 / 神职圈
- family       家族作团体块（血缘细节仍由关系边表达）
- organization 公司 / 军队 / 门派 / 机构 / 学院
- movement     政治 / 意识形态 / 民族主义等主张型圈子
- stage        实在抽不出机构时的叙事阶段世界（「第 N 阶段世界」）
- other        以上都不合适

## 分块要求

1. **块数控制在 {min_blocks}-{max_blocks} 个**：太少等于没分区，太多等于没秩序。
2. **块名用书里的专有名词**（学校名、教会名、家族名、圈子名），不要用「一群人」「配角们」。
3. **尽量覆盖**：能归的都归，让「未归属」尽量少。宁可用 stage 型块兜底，也不要留大批人无块。
4. **一人可属多个块**（主角常跨多个阶段）；不要为了唯一归属而漏掉真实归属。
5. **主角不必强行只归一块**——照实列出他属于的所有块。
6. **chapter_ids 要填**：该人在此团体活跃的章号。阶段性团体（某学校）只在对应章活跃，\
这样按前 N 章看图时后期团体不会提前泄露。
7. person_id 只能用给定人名册里的 id，不要编造。

## 可用工具

1. **search_in_chapter(chapter_id, keyword)** — 在指定章搜关键词，确认机构名/团体名确实出现过。
2. **get_chapter_result(chapter_id)** — 查看该章分析结果（人物 + 关系 + 摘要），只读。
3. **submit_factions(factions)** — 提交势力册，唯一出口。

## 出口约定（submit_factions 的格式）

  factions: [
    {{
      name: "克朗戈斯学院",            // 必填，专有名词，不能是关系词
      kind: "school",                  // 必填，上述枚举之一
      aliases: ["克朗戈斯"],           // 可选
      note: "斯蒂芬的寄宿小学",         // 可选，一句话
      members: [
        {{
          person_id: "p001",
          role: "学生",                // 可选
          chapter_ids: [1, 2],         // 该人在此团体活跃的章
          confidence: 0.9,             // 0-1，越确定越高
          quote: "原文短句"             // 可选，有则更好
        }}
      ]
    }}
  ]

校验失败会返回错误信息，修正后重新提交。
"""


def build_system_prompt(min_blocks: int = 5, max_blocks: int = 12) -> str:
    """构建 FactionWriter system prompt。"""
    return _SYSTEM_TEMPLATE.format(min_blocks=min_blocks, max_blocks=max_blocks)


def _build_cast_roster(cast: Cast) -> str:
    """人名册全量清单：id + 名 + 别名 + 重要度 + 截断 bio。"""
    if not cast.persons:
        return "（空人名册）"

    lines: list[str] = []
    for p in cast.persons:
        aliases = "/".join(a.name for a in p.aliases)
        alias_part = f" 别名[{aliases}]" if aliases else ""
        bio = (p.bio or "").strip().replace("\n", " ")
        if len(bio) > _MAX_BIO_CHARS:
            bio = bio[:_MAX_BIO_CHARS] + "…"
        bio_part = f" — {bio}" if bio else ""
        importance = (
            p.importance.value if hasattr(p.importance, "value") else str(p.importance)
        )
        lines.append(
            f"  - {p.person_id}: {p.canonical_name}{alias_part} [{importance}]{bio_part}"
        )
    return "\n".join(lines)


def _build_edge_skeleton(edges: list[GraphEdge]) -> str:
    """
    关系骨架：只给 hard / mid 边（soft 的朋友/相识对分块几乎没有信息量，还占 token）。

    按 display_score 降序取前 N 条。
    """
    rows: list[tuple[float, str]] = []
    for e in edges:
        keep = [t for t in e.tags if t.tier in ("hard", "mid")]
        if not keep:
            continue
        keep.sort(key=lambda t: -t.display_score)
        top = keep[0]
        types = "/".join(t.type for t in keep)
        chs = ",".join(str(c) for c in top.chapter_ids)
        rows.append((top.display_score, f"  - {e.person_a} — {e.person_b}: {types} (ch {chs})"))

    if not rows:
        return "（无硬/中关系边）"

    rows.sort(key=lambda r: -r[0])
    lines = [r[1] for r in rows[:_MAX_EDGE_LINES]]
    if len(rows) > _MAX_EDGE_LINES:
        lines.append(f"  …（另有 {len(rows) - _MAX_EDGE_LINES} 条已省略）")
    return "\n".join(lines)


def _build_chapter_summaries(chapter_summaries: dict[int, str]) -> str:
    if not chapter_summaries:
        return "（无章摘要）"
    return "\n".join(
        f"  - 第 {cid} 章: {chapter_summaries[cid]}"
        for cid in sorted(chapter_summaries.keys())
    )


def build_user_prompt(
    meta: BookMeta,
    cast: Cast,
    edges: list[GraphEdge],
    chapter_summaries: dict[int, str],
    min_blocks: int = 5,
    max_blocks: int = 12,
) -> str:
    """构建 FactionWriter user prompt。"""
    chapters = sorted(chapter_summaries.keys())
    ch_range = (
        f"第 {chapters[0]}-{chapters[-1]} 章（共 {len(chapters)} 章）" if chapters else "无"
    )

    return (
        f"## 书籍信息\n"
        f"- 书名: {meta.title}\n"
        f"- 已分析章范围: {ch_range}\n\n"
        f"## 人名册（共 {len(cast.persons)} 人）\n{_build_cast_roster(cast)}\n\n"
        f"## 各章摘要\n{_build_chapter_summaries(chapter_summaries)}\n\n"
        f"## 关系骨架（硬/中关系边，soft 已省略）\n{_build_edge_skeleton(edges)}\n\n"
        f"## 任务\n"
        f"1. 通读人名册与章摘要，识别书中真实存在的机构 / 教会 / 家族 / 学校 / 圈子。\n"
        f"2. 不确定某个团体名是否在原文出现时，用 search_in_chapter 确认。\n"
        f"3. 把人物分进 {min_blocks}-{max_blocks} 个块，尽量少留未归属；一人可多归属。\n"
        f"4. 用 submit_factions 一次性提交全部块。\n"
    )
