"""
关系类型枚举 — 唯一权威源（SSOT）。

prompt / submit_result 校验 / Aggregator / meta API 全部引用这一份。
§4.5 规格定死，不做 GEN 式厚映射。

-- 用法 --
    from app.domain.relation_types import RELATION_TYPES, is_valid_type, get_relation_meta

    if not is_valid_type(rel_type):
        raise invalid_relation_type(rel_type, ALL_TYPE_NAMES)
"""
from __future__ import annotations

from enum import Enum
from typing import Optional


class Tier(str, Enum):
    HARD = "hard"
    MID = "mid"
    SOFT = "soft"


class RelationTypeMeta:
    """关系类型的元数据。"""

    __slots__ = ("type", "tier", "directed")

    def __init__(self, type_name: str, tier: Tier, directed: bool) -> None:
        self.type = type_name
        self.tier = tier
        self.directed = directed

    def __repr__(self) -> str:
        arrow = "→" if self.directed else "↔"
        return f"RelationTypeMeta({self.type} [{self.tier.value}] {arrow})"


# ── §4.5 唯一权威源 ──
# hard — 互不覆盖；展示优先
# mid  — 可并存；展示次于 hard
# soft — 易泛滥；有 hard 时默认折叠

_RELATION_DEFINITIONS: list[tuple[str, Tier, bool]] = [
    # type_name, tier, directed
    # ── hard ──
    ("夫妻", Tier.HARD, False),
    ("亲子", Tier.HARD, True),    # a→b：a 是 b 的父母
    ("兄妹", Tier.HARD, False),   # 含兄弟姐妹
    ("表亲", Tier.HARD, False),   # 表/堂等旁系亲缘
    ("师徒", Tier.HARD, True),    # a→b：a 是师傅
    # ── mid ──
    ("主仆", Tier.MID, True),     # a→b：a 是主人
    ("上下级", Tier.MID, True),   # a→b：a 是上级
    ("同门", Tier.MID, False),
    ("结盟", Tier.MID, False),
    ("敌对", Tier.MID, False),
    # ── soft ──
    ("朋友", Tier.SOFT, False),
    ("相识", Tier.SOFT, False),
    ("同场", Tier.SOFT, False),
]

# type_name → meta 的快速查找
RELATION_TYPES: dict[str, RelationTypeMeta] = {
    name: RelationTypeMeta(name, tier, directed)
    for name, tier, directed in _RELATION_DEFINITIONS
}

ALL_TYPE_NAMES: list[str] = [d[0] for d in _RELATION_DEFINITIONS]


# ── 展示分基础值（Aggregator 用）──
_TIER_BASE_SCORE: dict[Tier, float] = {
    Tier.HARD: 5.0,
    Tier.MID: 3.0,
    Tier.SOFT: 1.0,
}


# ── 查询函数 ──

def is_valid_type(type_name: str) -> bool:
    """检查关系类型是否在枚举内。"""
    return type_name in RELATION_TYPES


def get_relation_meta(type_name: str) -> Optional[RelationTypeMeta]:
    """获取关系类型的元数据；不存在返回 None。"""
    return RELATION_TYPES.get(type_name)


def get_tier(type_name: str) -> Optional[Tier]:
    """获取关系的 tier（hard/mid/soft）。"""
    meta = RELATION_TYPES.get(type_name)
    return meta.tier if meta else None


def is_directed(type_name: str) -> bool:
    """该关系类型是否有向。未知类型假设无向。"""
    meta = RELATION_TYPES.get(type_name)
    return meta.directed if meta else False


def tier_base_score(type_name: str) -> float:
    """获取该关系类型的展示基础分。未知类型返回 0。"""
    tier = get_tier(type_name)
    return _TIER_BASE_SCORE.get(tier, 0.0) if tier else 0.0


def normalize_undirected_pair(person_a: str, person_b: str) -> tuple[str, str]:
    """
    无向边端点规范化：按字典序排序（a < b）。

    调用方需先确认 directed=False 再调用。
    """
    if person_a <= person_b:
        return person_a, person_b
    return person_b, person_a


def relation_summary_for_prompt() -> str:
    """
    生成给 LLM prompt 用的关系枚举文本。

    格式示例：
        夫妻 (hard, 无向)
        亲子 (hard, 有向: a是b的父母)
        ...
    """
    lines: list[str] = []
    for name, tier, directed in _RELATION_DEFINITIONS:
        direction = "有向" if directed else "无向"
        suffix = ""
        if directed:
            # 打个简注
            _HINTS = {
                "亲子": "a是b的父母",
                "师徒": "a是师傅",
                "主仆": "a是主人",
                "上下级": "a是上级",
            }
            suffix = f": {_HINTS.get(name, '')}".rstrip(": ")
        lines.append(f"  - {name} ({tier.value}, {direction}{suffix})")
    return "\n".join(lines)