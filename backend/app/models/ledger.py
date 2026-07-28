"""
Chapter Ledger（章账本 — 事实数据源）模型。

对应 ARCHITECTURE §3.2 Chapter Ledger:
  workspace/{book_id}/ledger/chapter_{id:03d}.json

约定：
  - chapter_id 为 int（与 order 一致）
  - 无向边 person_a / person_b 按字典序排序后写入（a < b）
  - 有向边 person_a = from, person_b = to
  - type 必须属于系统短枚举（relation_types.py）
"""
from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field, model_validator

from app.domain.relation_types import (
    RELATION_TYPES,
    is_directed,
    is_valid_type,
    normalize_undirected_pair,
)


class Evidence(BaseModel):
    """关系证据。"""
    chapter_id: int
    quote: str = ""
    note: str = ""
    # quote_verified: true=正文匹配到, false=未匹配, null=未校验
    quote_verified: Optional[bool] = None


class Relation(BaseModel):
    """
    章级关系记录。

    校验规则（出口紧，§4.5）:
      - type 必须在 RELATION_TYPES 枚举内
      - directed 以枚举定义为准，不得自相矛盾
      - 无向边 person_a < person_b（字典序）
      - 有向边 person_a = from, person_b = to
    """
    person_a: str
    person_b: str
    type: str
    tier: str = ""           # hard/mid/soft — 由 type 决定，可留空自动填
    directed: bool = False   # 由 type 决定，可留空自动填
    evidence: Evidence = Field(default_factory=lambda: Evidence(chapter_id=0))

    @model_validator(mode="after")
    def _validate_and_normalize(self) -> "Relation":
        # 1. type 必须在枚举内
        if not is_valid_type(self.type):
            raise ValueError(
                f"Invalid relation type: '{self.type}'. "
                f"Valid types: {', '.join(RELATION_TYPES.keys())}"
            )

        meta = RELATION_TYPES[self.type]

        # 2. directed / tier 以枚举为准
        self.directed = meta.directed
        self.tier = meta.tier.value

        # 3. 无向边端点规范化
        if not self.directed:
            self.person_a, self.person_b = normalize_undirected_pair(
                self.person_a, self.person_b
            )

        # 4. 防止自环
        if self.person_a == self.person_b:
            raise ValueError(
                f"Self-loop relation: person_a == person_b ('{self.person_a}')"
            )

        return self


class ChapterPerson(BaseModel):
    """章级人物条目。"""
    person_id: str
    aliases_in_chapter: List[str] = Field(default_factory=list)


class ChapterEvent(BaseModel):
    """章级事件（可选，便于解释关系）。"""
    description: str
    persons: List[str] = Field(default_factory=list)


class ChapterLedger(BaseModel):
    """
    章级分析结果（账本 — 事实数据源）。
    对应 workspace/{book_id}/ledger/chapter_{id:03d}.json
    """
    chapter_id: int
    persons: List[ChapterPerson] = Field(default_factory=list)
    relations: List[Relation] = Field(default_factory=list)
    events: List[ChapterEvent] = Field(default_factory=list)
    summary: str = ""  # 章总结（记忆用）


# ── Cast Propose（Agent 工具用）──

class CastPropose(BaseModel):
    """
    Agent 通过 propose_persons 工具提议的新人/新别名。
    经 CastWriter 串行合并后写入 cast.json。
    """
    canonical_name: str
    aliases: List[str] = Field(default_factory=list)
    bio: str = ""
    gender: str = "unknown"
    importance: str = "minor"
    # Agent 可附注来源章节
    source_chapter_id: Optional[int] = None