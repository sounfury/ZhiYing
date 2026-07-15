"""
LLM Provider 层 — 通过 LangChain ChatOpenAI 适配任意 OpenAI 兼容端点。

§2.1 约定：LangChain 仅做 Agent 运行时（工具注解、prompt 模板、tool loop、ChatModel）。
本模块只负责创建可配置的 ChatModel 实例，供 chapter_agent / reconcile_agent 使用。

不在此模块：Orchestrator 调度、Memory SSOT、Cast Writer、Aggregator。
"""
from __future__ import annotations

from typing import Optional

from langchain_openai import ChatOpenAI

from app.config import Settings, settings
from app.errors import AppError, ErrorCode, llm_provider_error
from app.logging_config import get_logger

logger = get_logger("agent.llm")


def create_chat_model(
    model: Optional[str] = None,
    *,
    temperature: float = 0.0,
    timeout: int = 120,
    max_retries: int = 2,
    cfg: Optional[Settings] = None,
) -> ChatOpenAI:
    """
    创建 LangChain ChatOpenAI 实例。

    任意 OpenAI 兼容端点（官方 / 中转 / Ollama / vLLM 等），
    只需配 base_url + api_key + model。

    Args:
        model: 模型名；不传则用 settings.llm_model
        temperature: 温度；默认 0（关系提取偏确定性）
        timeout: 请求超时秒
        max_retries: LLM 层重试次数
        cfg: Settings 实例；不传则用全局 settings

    Raises:
        AppError(LLM_PROVIDER_ERROR): 缺 api_key 或其他配置错误
    """
    cfg = cfg or settings

    if not cfg.llm_api_key:
        raise llm_provider_error(
            "LLM_API_KEY not configured. Set it in .env or environment."
        )

    resolved_model = model or cfg.llm_model

    logger.info(
        "Creating ChatOpenAI: base_url=%s model=%s temp=%.1f",
        cfg.llm_base_url,
        resolved_model,
        temperature,
    )

    return ChatOpenAI(
        base_url=cfg.llm_base_url,
        api_key=cfg.llm_api_key,
        model=resolved_model,
        temperature=temperature,
        timeout=timeout,
        max_retries=max_retries,
    )


def get_chapter_llm(cfg: Optional[Settings] = None) -> ChatOpenAI:
    """章级分析用的 ChatModel。"""
    cfg = cfg or settings
    return create_chat_model(cfg.llm_model, temperature=0.0, cfg=cfg)


def get_reconcile_llm(cfg: Optional[Settings] = None) -> ChatOpenAI:
    """
    终局归纳（Reconcile）用的 ChatModel。
    可配不同模型档（LLM_RECONCILE_MODEL），默认回退到主模型。
    """
    cfg = cfg or settings
    return create_chat_model(
        cfg.reconcile_model,
        temperature=0.0,
        cfg=cfg,
    )


def check_connectivity(cfg: Optional[Settings] = None) -> bool:
    """
    轻量连通性检查：发一条 "ping" 消息看是否返回。
    用于启动时或 API 健康路径（非必须，debug 时有用）。

    Returns:
        True 连通，False 不通（异常被吞，详情看日志）
    """
    cfg = cfg or settings
    try:
        llm = create_chat_model(cfg=cfg)
        resp = llm.invoke("Reply with exactly: OK")
        ok = "OK" in str(resp.content).upper()
        logger.info("LLM connectivity check: %s", "OK" if ok else "FAIL")
        return ok
    except AppError:
        raise  # 配置错误直接抛
    except Exception as e:
        logger.warning("LLM connectivity check failed: %s", e)
        return False