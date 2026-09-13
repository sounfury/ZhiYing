"""开放关系描述与注册表模型。种子是示例，不是合法值枚举。"""
from __future__ import annotations
import json
from pathlib import Path
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

class RelationDescriptor(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    label: str = Field(min_length=1, max_length=80)
    category: str = Field(default="其他", min_length=1, max_length=40)
    definition: str = Field(min_length=1, max_length=600)
    directed: bool
    subject_role: str = Field(min_length=1, max_length=80)
    object_role: str = Field(min_length=1, max_length=80)

    @model_validator(mode="after")
    def symmetric_roles(self):
        """校验无向关系双方角色必须相同，不同则要求改用有向关系。"""
        if not self.directed and self.subject_role != self.object_role:
            raise ValueError("无向关系双方角色应相同；角色不同请使用有向关系")
        return self

class RelationDefinition(RelationDescriptor):
    predicate: str = Field(pattern=r"^[a-z][a-z0-9_]{0,79}$")
    aliases: list[str] = Field(default_factory=list)
    display_priority: int = Field(default=1, ge=0, le=5)
    source: Literal["seed", "learned", "human"] = "learned"

class RelationRegistry(BaseModel):
    version: int = 1
    definitions: list[RelationDefinition] = Field(default_factory=list)

    @model_validator(mode="after")
    def unique_predicates(self):
        """校验注册表内 predicate 全局唯一，重复即拒绝加载。"""
        keys = [d.predicate for d in self.definitions]
        if len(keys) != len(set(keys)):
            raise ValueError("注册表 predicate 重复")
        return self

    def get(self, predicate: str | None) -> RelationDefinition | None:
        """按 predicate 精确查找关系定义，找不到返回 None。"""
        return next((d for d in self.definitions if d.predicate == predicate), None)

def seed_registry() -> RelationRegistry:
    """从同目录 relation_seeds.json 加载种子注册表。"""
    path = Path(__file__).with_name("relation_seeds.json")
    return RelationRegistry.model_validate(json.loads(path.read_text(encoding="utf-8")))

def normalize_undirected_pair(a: str, b: str) -> tuple[str, str]:
    """把无向关系的人物对按字典序排序，保证 (a,b) 与 (b,a) 归一为同一键。"""
    return (a, b) if a <= b else (b, a)
