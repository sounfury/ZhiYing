"""
Book / 元数据 模型。

对应 ARCHITECTURE §3.2:
  - Book / Meta (meta.json)
  - Chapter (chapters/chapter_*.json)
"""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field


class BookStatus(str, Enum):
    """书籍分析状态。对应 meta.json 中的 status 字段。"""
    UPLOADED = "uploaded"             # 已上传，尚未分析
    CAST_PASS = "cast_pass"           # Cast Pass 完成（P1 才有）
    ANALYZING = "analyzing"           # 分析中
    RECONCILING = "reconciling"       # 全书总校对 Agent 运行中
    ANALYZED = "analyzed"             # 分析完成
    RECONCILE_FAILED = "reconcile_failed"  # 总校对失败（降级，仍可出图）
    FAILED = "failed"                 # 分析失败


class AnalysisMode(str, Enum):
    """分析模式。§4.6 双模式调度。"""
    FEW_LONG = "few_long"             # 章少、单章量大 → 全章并行 + 终局归纳
    MANY_CHAPTERS = "many_chapters"   # 章多 → 波次并行 + 记忆（P1）


class AnalysisProgress(BaseModel):
    """分析进度。"""
    cast_pass_done: bool = False
    chapters_done: List[int] = Field(default_factory=list)
    chapters_pending: List[int] = Field(default_factory=list)
    chapters_failed: List[int] = Field(default_factory=list)
    mode: Optional[AnalysisMode] = None
    # few_long 专用：是否进入/完成 reconcile
    reconcile_done: bool = False


class BookMeta(BaseModel):
    """
    书籍元数据。对应 workspace/{book_id}/meta.json
    """
    book_id: str = ""
    title: str = ""
    author: str = ""
    source_file: str = ""
    total_chapters: int = 0
    status: BookStatus = BookStatus.UPLOADED
    created_at: datetime = Field(default_factory=datetime.now)
    analysis_progress: AnalysisProgress = Field(default_factory=AnalysisProgress)

    # profiling 信息（EPUB 解析后填充）
    total_words: int = 0
    max_chapter_words: int = 0
    median_chapter_words: int = 0
    # include_in_analysis=true 的章数（分析默认队列大小）
    analysis_chapter_count: int = 0


class Chapter(BaseModel):
    """
    章节数据。对应 workspace/{book_id}/chapters/chapter_{id:03d}.json

    注意：chapter_id 为 int（与 order 一致）；文件名零填充仅为存储细节。
    include_in_analysis：解析后打标；false 仍落盘/列表可见，默认不进 AI 分析。
    """
    chapter_id: int
    title: str = ""
    order: int = 0
    content: str = ""
    word_count: int = 0
    source_href: str = ""
    include_in_analysis: bool = True


class ChapterBrief(BaseModel):
    """章节摘要（列表用，不含正文）。"""
    chapter_id: int
    title: str
    order: int
    word_count: int = 0
    include_in_analysis: bool = True
