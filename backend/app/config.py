"""
集中式配置管理。

从 .env 文件读取所有运行参数。本机个人项目——不做 secret rotation / 多环境管理。
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """全局配置。通过 .env 注入，也可用环境变量覆盖。"""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── LLM (OpenAI 兼容) ──
    llm_base_url: str = Field("https://api.openai.com/v1", alias="LLM_BASE_URL")
    llm_api_key: str = Field("", alias="LLM_API_KEY")
    llm_model: str = Field("gpt-4o", alias="LLM_MODEL")
    llm_reconcile_model: str = Field("", alias="LLM_RECONCILE_MODEL")
    llm_faction_model: str = Field("", alias="LLM_FACTION_MODEL")

    # ── Workspace ──
    workspace_root: str = Field("", alias="WORKSPACE_ROOT")

    # ── 分析参数 ──
    max_agent_steps: int = Field(20, alias="MAX_AGENT_STEPS")
    max_reconcile_steps: int = Field(15, alias="MAX_RECONCILE_STEPS")
    max_parallel_chapters: int = Field(5, alias="MAX_PARALLEL_CHAPTERS")
    force_reconcile: bool = Field(False, alias="FORCE_RECONCILE")

    # ── 势力分区（PRD §5.7.5）──
    max_faction_steps: int = Field(10, alias="MAX_FACTION_STEPS")
    faction_min_blocks: int = Field(5, alias="FACTION_MIN_BLOCKS")
    faction_max_blocks: int = Field(12, alias="FACTION_MAX_BLOCKS")
    # 分析结束后是否自动跑势力归纳（关掉可用 POST /factions 手动补跑）
    auto_extract_factions: bool = Field(True, alias="AUTO_EXTRACT_FACTIONS")

    # ── 正文注入 / 阅读窗（ARCHITECTURE §4.3.1）──
    inject_max_chars: int = Field(10_000, alias="INJECT_MAX_CHARS")
    read_window_chars: int = Field(5_000, alias="READ_WINDOW_CHARS")
    read_overlap_chars: int = Field(300, alias="READ_OVERLAP_CHARS")

    # ── few_long 阈值 ──
    k_few_chapters: int = Field(8, alias="K_FEW_CHAPTERS")
    w_huge_chapter_words: int = Field(8000, alias="W_HUGE_CHAPTER_WORDS")
    w_large_chapter_words: int = Field(4000, alias="W_LARGE_CHAPTER_WORDS")

    # ── 服务 ──
    host: str = Field("0.0.0.0", alias="HOST")
    port: int = Field(8000, alias="PORT")
    debug: bool = Field(True, alias="DEBUG")

    # ── 记忆参数（P1 用，先定义不阻塞） ──
    memory_recent_chapters: int = Field(5, alias="MEMORY_RECENT_CHAPTERS")
    memory_threshold_chars: int = Field(8000, alias="MEMORY_THRESHOLD_CHARS")

    # ────────────── 派生属性 ──────────────

    @field_validator("workspace_root")
    @classmethod
    def _resolve_workspace(cls, v: str) -> str:
        """空字符串 → 默认项目根目录下的 workspace/。"""
        if not v:
            # backend/app/config.py → 上溯三层到项目根
            root = Path(__file__).resolve().parent.parent.parent
            return str(root / "workspace")
        return str(Path(v).expanduser().resolve())

    @property
    def workspace_path(self) -> Path:
        return Path(self.workspace_root)

    @property
    def reconcile_model(self) -> str:
        """Reconcile 模型：未配置时回退到主模型。"""
        return self.llm_reconcile_model or self.llm_model

    @property
    def faction_model(self) -> str:
        """势力归纳模型：未配置时回退到 Reconcile 档。"""
        return self.llm_faction_model or self.reconcile_model

    def ensure_workspace(self) -> Path:
        """确保 workspace 目录存在，返回 Path。"""
        p = self.workspace_path
        p.mkdir(parents=True, exist_ok=True)
        return p


# ── 单例 ──
settings = Settings()