"""
Graph（汇总出图）模型 — 前端消费。

对应 ARCHITECTURE §3.2 Aggregated Edge 和 §5.2 GET /api/books/{id}/graph Response。
"""
from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field


class GraphEvidence(BaseModel):
    """汇总后的证据条目。"""
    chapter_id: int
    quote: str = ""


class GraphTag(BaseModel):
    """
    一对人物的一种关系标签（汇总后）。

    多个 tag 可附在同一对人物的 edge 上（多标签）。
    """
    type: str                       # 关系类型（来自短枚举）
    tier: str                       # hard / mid / soft
    directed: bool
    chapter_ids: List[int] = Field(default_factory=list)
    evidences: List[GraphEvidence] = Field(default_factory=list)
    display_score: float = 0.0
    # 软关系在有硬关系时被压制（default 折进「更多」）
    suppressed: bool = False


class GraphEdge(BaseModel):
    """一对人物的边（含多个标签）。"""
    person_a: str
    person_b: str
    tags: List[GraphTag] = Field(default_factory=list)


class GraphNode(BaseModel):
    """图谱节点。"""
    person_id: str
    name: str                       # canonical_name
    aliases: List[str] = Field(default_factory=list)
    gender: str = "unknown"
    importance: str = "minor"
    appearance_count: int = 0       # 出现章数（按章计）
    bio: str = ""
    # ── 势力归属（与关系边正交，PRD §5.7.5）──
    faction_ids: List[str] = Field(default_factory=list)
    # 布局落块用的主势力；无归属时为 None（前端归入「未归属」块）
    primary_faction_id: Optional[str] = None
    # 该归属由算法邻居传播兜底推断，而非 LLM 显式抽取
    faction_inferred: bool = False


class GraphFaction(BaseModel):
    """出图用的势力块（已按切片过滤 + 环形排序）。"""
    faction_id: str
    name: str
    kind: str = "other"
    # 环形排列序：相邻块共享桥接人物更多，减少跨图长边
    order: int = 0
    # 主势力落在此块的可见成员（布局按此列表装填）
    member_ids: List[str] = Field(default_factory=list)
    # 含次要归属在内的全部可见成员
    all_member_ids: List[str] = Field(default_factory=list)
    inferred: bool = False
    # 与关系结构不一致（块内无任何同伴连线）的成员，供人工复核
    needs_review: List[str] = Field(default_factory=list)


class FilteredPerson(BaseModel):
    """被过滤的路人（供前端展开查看）。"""
    person_id: str
    name: str


class GraphData(BaseModel):
    """
    GET /api/books/{id}/graph 的完整响应体。
    """
    book_id: str
    chapter_range: List[int]        # [1, N]
    total_chapters: int
    nodes: List[GraphNode] = Field(default_factory=list)
    edges: List[GraphEdge] = Field(default_factory=list)
    factions: List[GraphFaction] = Field(default_factory=list)
    filtered_count: int = 0
    filtered_persons: List[FilteredPerson] = Field(default_factory=list)