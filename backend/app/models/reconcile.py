"""
Reconcile Agent 数据模型。

定义可疑清单（SuspectList）与校对补丁（ReconcilePatch）的完整结构。
对应 design.md \u00a73 SuspectList / \u00a76 ReconcilePatch。
"""
from __future__ import annotations

from typing import List, Literal

from pydantic import BaseModel, Field, model_validator, ConfigDict
from app.models.ledger import Relation


# ── 可疑清单条目 ──


class CastConflict(BaseModel):
    """人名合并候选（alias_overlap / name_alias_cross；同时命中时用 + 连接）。"""
    person_a_id: str
    person_b_id: str
    reason: str               # "alias_overlap" | "name_alias_cross" | "alias_overlap+name_alias_cross"
    aliases_overlap: List[str] = Field(default_factory=list)


class RelationConflict(BaseModel):
    """关系冲突（type_clash / direction_clash）。"""
    person_a: str
    person_b: str
    conflict_type: str        # "type_clash" | "direction_clash"
    details: str = ""
    chapters: List[int] = Field(default_factory=list)


class MissingEvidence(BaseModel):
    """证据缺失、未命中或无法唯一定位时的复查提示。"""
    person_a: str
    person_b: str
    label: str
    chapter_id: int
    reason: str = "缺少原文证据"


class SuspectList(BaseModel):
    """可疑清单——SuspectsGenerator 的输出。"""
    cast_conflicts: List[CastConflict] = Field(default_factory=list)
    relation_conflicts: List[RelationConflict] = Field(default_factory=list)
    missing_evidence: List[MissingEvidence] = Field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        """三类可疑项全为空时为 True，表示无需进入 Reconcile 校对。"""
        return (
            not self.cast_conflicts
            and not self.relation_conflicts
            and not self.missing_evidence
        )


# ── 校对补丁条目 ──


class MergeSuggestion(BaseModel):
    """合并建议：保留 keep_id，删除 drop_id。"""
    keep_id: str
    drop_id: str
    reason: str
    evidence: str = ""        # 章号 + 原句


class AliasSuggestion(BaseModel):
    """别名建议：给 person_id 添加 new_aliases。"""
    person_id: str
    new_aliases: List[str] = Field(default_factory=list)
    reason: str = ""


class RelationChange(BaseModel):
    """新增完整关系，或按 relation_id 精确删除，避免同名标签误删。"""
    action: Literal["add", "remove"]
    model_config = ConfigDict(extra="forbid")
    relation: Relation | None = None
    relation_id: str | None = None

    @model_validator(mode="after")
    def validate_action(self):
        """
        校验 add/remove 两种动作的字段契约。

        - add：必须携带完整 relation，禁止带 relation_id；
        - remove：必须按 relation_id 精确删除，禁止带 relation。
        """
        if self.action == "add" and (self.relation is None or self.relation_id is not None):
            raise ValueError("add 需要 relation，不能携带 relation_id")
        if self.action == "remove" and (not self.relation_id or self.relation is not None):
            raise ValueError("remove 需要 relation_id，不能携带 relation")
        return self


class TodoItem(BaseModel):
    """待办条目：没把握的留给人工。"""
    description: str
    person_ids: List[str] = Field(default_factory=list)
    chapter_ids: List[int] = Field(default_factory=list)


class ReconcilePatch(BaseModel):
    """Reconcile Agent 提交的结构化校对补丁。"""
    merges: List[MergeSuggestion] = Field(default_factory=list)
    aliases: List[AliasSuggestion] = Field(default_factory=list)
    relation_changes: List[RelationChange] = Field(default_factory=list)
    todos: List[TodoItem] = Field(default_factory=list)


class PatchApplyResult(BaseModel):
    """PatchApplier.apply() 返回值。"""
    merges_applied: int = 0
    aliases_applied: int = 0
    relation_changes_applied: int = 0
    todos_written: int = 0
    errors: List[str] = Field(default_factory=list)
