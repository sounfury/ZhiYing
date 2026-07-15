"""
Cast（人名册）模型。

对应 ARCHITECTURE §3.2 Cast:
  workspace/{book_id}/cast.json
"""
from __future__ import annotations

from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field


class Gender(str, Enum):
    MALE = "male"
    FEMALE = "female"
    UNKNOWN = "unknown"


class Importance(str, Enum):
    MAIN = "main"              # 主角
    SUPPORTING = "supporting"  # 配角
    MINOR = "minor"            # 龙套


class AliasFrequency(str, Enum):
    """别名出现频率粗标（NLP Cast Pass 用，P1）。"""
    HIGH = "high"
    MID = "mid"
    LOW = "low"


class Alias(BaseModel):
    """别名条目。"""
    name: str
    frequency: AliasFrequency = AliasFrequency.LOW


class Person(BaseModel):
    """人名册中的人物条目。"""
    person_id: str
    canonical_name: str
    aliases: List[Alias] = Field(default_factory=list)
    bio: str = ""
    gender: Gender = Gender.UNKNOWN
    importance: Importance = Importance.MINOR
    # 疑似同人的 person_id 列表（待人工/Reconcile 合并）
    merge_candidates: List[str] = Field(default_factory=list)


class Cast(BaseModel):
    """
    人名册。对应 workspace/{book_id}/cast.json

    version 每次 CastWriter / 人工编辑 bump；供快照引用。
    """
    version: int = 0
    persons: List[Person] = Field(default_factory=list)

    def get_person(self, person_id: str) -> Optional[Person]:
        """按 person_id 查找人物。"""
        for p in self.persons:
            if p.person_id == person_id:
                return p
        return None

    def find_by_name(self, name: str) -> Optional[Person]:
        """
        按正式名或别名查找人物。
        返回第一个匹配；若多人匹配则返回第一个（调用方应处理歧义）。
        """
        for p in self.persons:
            if p.canonical_name == name:
                return p
            for a in p.aliases:
                if a.name == name:
                    return p
        return None

    def all_names(self) -> List[str]:
        """所有人名（正式名 + 别名），去重。"""
        names: list[str] = []
        seen: set[str] = set()
        for p in self.persons:
            if p.canonical_name and p.canonical_name not in seen:
                names.append(p.canonical_name)
                seen.add(p.canonical_name)
            for a in p.aliases:
                if a.name not in seen:
                    names.append(a.name)
                    seen.add(a.name)
        return names