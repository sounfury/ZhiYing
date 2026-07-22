"""
Reconcile Agent 数据模型。

定义可疑清单（SuspectList）与校对补丁（ReconcilePatch）的完整结构。
对应 design.md \u00a73 SuspectList / \u00a76 ReconcilePatch。
"""
from __future__ import annotations

from typing import List

from pydantic import BaseModel, Field


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
    """hard 关系缺原句提示。"""
    person_a: str
    person_b: str
    type: str
    chapter_id: int


class SuspectList(BaseModel):
    """可疑清单——SuspectsGenerator 的输出。"""
    cast_conflicts: List[CastConflict] = Field(default_factory=list)
    relation_conflicts: List[RelationConflict] = Field(default_factory=list)
    missing_evidence: List[MissingEvidence] = Field(default_factory=list)

    @property
    def is_empty(self) -> bool:
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
    """关系修改：add 追加到 overrides，remove 从 overrides 移除。"""
    action: str               # "add" | "remove"
    person_a: str
    person_b: str
    type: str
    chapter_id: int
    quote: str = ""
    note: str = ""


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