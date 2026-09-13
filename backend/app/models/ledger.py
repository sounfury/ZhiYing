"""
Chapter Ledger（章账本 — 事实数据源）模型。

对应 ARCHITECTURE §3.2 Chapter Ledger:
  workspace/{book_id}/ledger/chapter_{id:03d}.json

约定：
  - chapter_id 为 int（与 order 一致）
  - 无向边 person_a / person_b 按字典序排序后写入（a < b）
  - 有向边 person_a = from, person_b = to
  - 关系使用开放描述，predicate 由归一化阶段分配
"""
from __future__ import annotations

from typing import List, Optional, Literal
from uuid import uuid4

from pydantic import BaseModel, Field, model_validator

from app.domain.relation_types import RelationDescriptor, normalize_undirected_pair


class Evidence(BaseModel):
    """关系证据。"""
    chapter_id: int
    quote: str = ""
    note: str = ""
    # quote_verified: true=正文匹配到, false=未匹配, null=未校验
    quote_verified: Optional[bool] = None
    start: Optional[int] = None  # 正文字符位置，含 start，不含 end
    end: Optional[int] = None


class Relation(RelationDescriptor):
    """原文事实与归一化状态分离；不要求类型已在注册表中。"""
    relation_id: str = Field(default_factory=lambda: uuid4().hex)
    person_a: str = Field(min_length=1)
    person_b: str = Field(min_length=1)
    raw_relation: str = Field(min_length=1, max_length=1000)
    predicate: Optional[str] = None
    normalization_status: Literal["pending", "resolved"] = "pending"
    normalization_reason: str = "尚未归一化"
    evidence: Evidence
    status: Literal["pending", "confirmed", "rejected"] = "pending"
    verification_reason: str = "尚未验证"

    @model_validator(mode="after")
    def validate_relation(self):
        """
        落账前校验与归一：
        - 禁止自环（person_a == person_b）；
        - 无向边按字典序统一 person_a/person_b 顺序；
        - 已归一化（resolved）的关系必须已有 predicate。
        """
        if self.person_a == self.person_b:
            raise ValueError("Self-loop relation")
        if not self.directed:
            self.person_a, self.person_b = normalize_undirected_pair(self.person_a, self.person_b)
        if self.normalization_status == "resolved" and not self.predicate:
            raise ValueError("已归一化关系必须有 predicate")
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
    analysis_status: Literal["complete", "partial"] = "partial"
    warnings: List[str] = Field(default_factory=list)


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
