"""
Faction（势力册 — 团体聚合）模型。

对应 PRD §3.1「势力 = 团体聚合（affiliation group）」与 §5.7.5 布局模式：
  workspace/{book_id}/factions.json

与 cast.json 平级的第二个 SSOT：
  cast     → 人是谁（认人、别名）
  factions → 人属于哪个团体（节点归属，可多归属）
  ledger   → 人与人之间是什么（关系边）

约定：
  - 势力与关系边正交：「朋友」是边，不是势力名（校验层拒绝关系类型当势力名）
  - 一人可属多个势力；布局取「主势力」落块，由 Aggregator 打分决定
  - Membership.chapter_ids 记录该人在此团体的活跃章 → 支撑防剧透切片
"""
from __future__ import annotations

from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field

from app.domain.relation_types import ALL_TYPE_NAMES
from app.models.ledger import Evidence


class FactionKind(str, Enum):
    """势力类型。用于主势力打分权重与配色。"""

    SCHOOL = "school"            # 学校 / 年级阶段：克朗戈斯学院、都柏林大学
    RELIGIOUS = "religious"      # 宗教 / 教会 / 修会：圣母圣心会
    FAMILY = "family"            # 家族作团体：代达勒斯家、克兰利家
    ORGANIZATION = "organization"  # 公司 / 军队 / 门派 / 机构
    MOVEMENT = "movement"        # 政治 / 意识形态圈：爱尔兰民族主义圈
    STAGE = "stage"              # 兜底：叙事阶段世界（「第 N 阶段」）
    OTHER = "other"


# 主势力打分权重：归属越稳定越高（家族/机构 > 意识形态圈 > 阶段兜底）
KIND_WEIGHT: dict[FactionKind, float] = {
    FactionKind.FAMILY: 1.0,
    FactionKind.SCHOOL: 0.95,
    FactionKind.RELIGIOUS: 0.9,
    FactionKind.ORGANIZATION: 0.9,
    FactionKind.MOVEMENT: 0.7,
    FactionKind.STAGE: 0.6,
    FactionKind.OTHER: 0.5,
}

# 禁止用关系类型当势力名（PRD §5.7.5 A：朋友是边，学校/教会才是块）
FORBIDDEN_FACTION_NAMES: frozenset[str] = frozenset(ALL_TYPE_NAMES)


def kind_weight(kind: FactionKind | str) -> float:
    """取 kind 的打分权重；未知 kind 回退 OTHER。"""
    try:
        k = kind if isinstance(kind, FactionKind) else FactionKind(kind)
    except ValueError:
        k = FactionKind.OTHER
    return KIND_WEIGHT[k]


class Membership(BaseModel):
    """一个人在一个势力中的归属条目。"""

    person_id: str
    role: str = ""                                  # 学生 / 神父 / 家长 / 同人…
    chapter_ids: List[int] = Field(default_factory=list)  # 活跃章；空 = 视为全程
    confidence: float = 0.8                         # 0-1，主势力打分输入
    evidence: List[Evidence] = Field(default_factory=list)


class Faction(BaseModel):
    """势力册中的一个团体块。"""

    faction_id: str
    canonical_name: str
    aliases: List[str] = Field(default_factory=list)   # 克朗戈斯 / 克朗戈斯伍德公学
    kind: FactionKind = FactionKind.OTHER
    note: str = ""
    members: List[Membership] = Field(default_factory=list)
    # 由算法兜底推断（非 LLM 显式抽取），UI 需标注
    inferred: bool = False

    def member_ids(self) -> List[str]:
        return [m.person_id for m in self.members]

    def get_member(self, person_id: str) -> Optional[Membership]:
        for m in self.members:
            if m.person_id == person_id:
                return m
        return None


class FactionBook(BaseModel):
    """
    势力册。对应 workspace/{book_id}/factions.json

    version 每次 FactionWriter / 人工编辑 bump。
    """

    version: int = 0
    factions: List[Faction] = Field(default_factory=list)

    def get_faction(self, faction_id: str) -> Optional[Faction]:
        for f in self.factions:
            if f.faction_id == faction_id:
                return f
        return None

    def find_by_name(self, name: str) -> Optional[Faction]:
        """按正式名或别名查找势力。"""
        for f in self.factions:
            if f.canonical_name == name or name in f.aliases:
                return f
        return None

    def factions_of(self, person_id: str) -> List[Faction]:
        """某人所属的全部势力。"""
        return [f for f in self.factions if f.get_member(person_id) is not None]
