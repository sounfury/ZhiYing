"""LLM provider and task-scoped request control."""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from langchain_openai import ChatOpenAI

from app.config import Settings, settings
from app.errors import AppError, llm_provider_error
from app.logging_config import get_logger

logger = get_logger("agent.llm")


class LLMStopped(RuntimeError):
    """No new provider request may be scheduled for this task."""


class LLMBudgetExceeded(RuntimeError):
    """Task or phase budget has been exhausted."""


def _usage_from_response(response: Any) -> tuple[int, int, int]:
    """Best-effort extraction for LangChain/OpenAI-compatible usage metadata."""
    if isinstance(response, dict) and response.get("raw") is not None:
        return _usage_from_response(response["raw"])
    usage = getattr(response, "usage_metadata", None) or {}
    if not usage:
        meta = getattr(response, "response_metadata", None) or {}
        usage = meta.get("token_usage") or meta.get("usage") or {}
    input_tokens = int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0)
    output_tokens = int(usage.get("output_tokens") or usage.get("completion_tokens") or 0)
    total_tokens = int(usage.get("total_tokens") or (input_tokens + output_tokens) or 0)
    return input_tokens, output_tokens, total_tokens


def structured_parsed(response: Any) -> Any:
    """Return parsed structured output while retaining raw usage for accounting."""
    if isinstance(response, dict) and "parsed" in response and "raw" in response:
        parsed = response.get("parsed")
        if parsed is None:
            error = response.get("parsing_error")
            raise ValueError(f"structured output parsing failed: {error}")
        return parsed
    return response


def _message_chars(messages: Any) -> int:
    """Best-effort character count for the explicit message payload sent by callers."""
    items = messages if isinstance(messages, (list, tuple)) else [messages]
    total = 0
    for item in items:
        content = getattr(item, "content", item)
        if isinstance(content, str):
            total += len(content)
            continue
        try:
            total += len(json.dumps(content, ensure_ascii=False, default=str))
        except Exception:
            total += len(str(content))
    return total


def is_quota_or_budget_error(exc: BaseException) -> bool:
    """Match provider quota / billing / balance failures by error-text markers."""
    text = str(exc).lower()
    markers = (
        "insufficient_quota", "quota", "credit balance", "balance", "billing",
        "payment required", "402", "exceeded your current quota", "额度", "余额",
    )
    return any(marker in text for marker in markers)


def is_retryable_llm_error(exc: BaseException) -> bool:
    """Decide whether an LLM error is transient; quota/billing errors never retry."""
    if is_quota_or_budget_error(exc):
        return False
    text = str(exc).lower()
    markers = (
        "timeout", "timed out", "rate limit", "429", "too many requests",
        "connection reset", "connection error", "temporarily unavailable",
        "service unavailable", "502", "503", "504",
    )
    return any(marker in text for marker in markers)


EventSink = Callable[[dict[str, Any]], Awaitable[None]]


@dataclass
class LLMControl:
    """Shared request/token/time budget for one analysis task."""

    stop_event: asyncio.Event
    max_requests: int = 0
    max_tokens: int = 0
    max_seconds: int = 0
    request_retries: int = 0
    heartbeat_seconds: int = 5
    phase_request_limits: dict[str, int] = field(default_factory=dict)
    event_sink: Optional[EventSink] = None
    started_at: float = field(default_factory=time.monotonic)
    request_count: int = 0
    message_chars: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    phase_requests: dict[str, int] = field(default_factory=dict)
    phase_message_chars: dict[str, int] = field(default_factory=dict)
    relation_cache: dict[str, dict[str, Any]] = field(default_factory=dict)
    stop_reason: str = ""
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)

    @classmethod
    def from_settings(
        cls,
        cfg: Settings,
        stop_event: asyncio.Event,
        *,
        event_sink: Optional[EventSink] = None,
    ) -> "LLMControl":
        """Build task-scoped budgets from settings, including per-phase request limits."""
        return cls(
            stop_event=stop_event,
            max_requests=cfg.analysis_max_llm_requests,
            max_tokens=cfg.analysis_max_llm_tokens,
            max_seconds=cfg.analysis_max_seconds,
            request_retries=cfg.llm_request_retries,
            heartbeat_seconds=cfg.llm_heartbeat_seconds,
            phase_request_limits={
                "chapter": cfg.chapter_max_llm_requests,
                "relation_normalize": cfg.relation_max_llm_requests,
                "relation_verify": cfg.relation_max_llm_requests,
                "reconcile": cfg.reconcile_max_llm_requests,
                "faction": cfg.faction_max_llm_requests,
            },
            event_sink=event_sink,
        )

    async def emit(self, data: dict[str, Any]) -> None:
        """Forward an event dict to the configured sink, if any."""
        if self.event_sink is not None:
            await self.event_sink(data)

    async def stop(self, reason: str) -> None:
        """Record the first stop reason, set the stop event, and broadcast the stop."""
        async with self._lock:
            if not self.stop_reason:
                self.stop_reason = reason
            self.stop_event.set()
        await self.emit({"kind": "llm_budget_stop", "reason": reason, **self.snapshot()})

    def snapshot(self) -> dict[str, Any]:
        """Current usage counters and stop reason, for tagging progress events."""
        return {
            "llm_requests": self.request_count,
            "message_chars": self.message_chars,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "total_tokens": self.total_tokens,
            "stop_reason": self.stop_reason,
        }

    async def reserve(self, phase: str, context: str, *, message_chars: int = 0) -> int:
        """Gate and account one request; returns its sequence number.

        Raises LLMStopped when the task is already stopped, LLMBudgetExceeded
        when the wall-clock, global-request or per-phase budget is exhausted.
        """
        async with self._lock:
            # Already stopped: refuse any further provider request.
            if self.stop_event.is_set():
                raise LLMStopped(self.stop_reason or "analysis stopped")
            # Whole-task wall-clock budget.
            elapsed = time.monotonic() - self.started_at
            if self.max_seconds > 0 and elapsed >= self.max_seconds:
                self.stop_reason = f"task time budget exceeded ({self.max_seconds}s)"
                self.stop_event.set()
                raise LLMBudgetExceeded(self.stop_reason)
            # Global request budget.
            if self.max_requests > 0 and self.request_count >= self.max_requests:
                self.stop_reason = f"task request budget exceeded ({self.max_requests})"
                self.stop_event.set()
                raise LLMBudgetExceeded(self.stop_reason)
            # Per-phase request budget.
            phase_count = self.phase_requests.get(phase, 0)
            phase_limit = self.phase_request_limits.get(phase, 0)
            if phase_limit > 0 and phase_count >= phase_limit:
                self.stop_reason = f"{phase} request budget exceeded ({phase_limit})"
                self.stop_event.set()
                raise LLMBudgetExceeded(self.stop_reason)
            # All gates passed: account this request while holding the lock.
            request_message_chars = max(0, int(message_chars))
            self.request_count += 1
            self.message_chars += request_message_chars
            self.phase_requests[phase] = phase_count + 1
            self.phase_message_chars[phase] = self.phase_message_chars.get(phase, 0) + request_message_chars
            request_no = self.request_count
        # Emitted outside the lock so sinks may await freely.
        await self.emit({
            "kind": "llm_request_start", "phase": phase, "context": context,
            "request_no": request_no, "request_message_chars": request_message_chars,
            **self.snapshot(),
        })
        return request_no

    async def record_response(self, response: Any, *, phase: str, context: str, elapsed_ms: float) -> None:
        """Accumulate token usage and emit llm_request_end; raises on token overrun."""
        inp, out, total = _usage_from_response(response)
        over = False
        async with self._lock:
            self.input_tokens += inp
            self.output_tokens += out
            self.total_tokens += total
            if self.max_tokens > 0 and self.total_tokens >= self.max_tokens:
                self.stop_reason = f"task token budget reached ({self.total_tokens}/{self.max_tokens})"
                self.stop_event.set()
                over = True
        await self.emit({
            "kind": "llm_request_end", "phase": phase, "context": context,
            "elapsed_ms": round(elapsed_ms, 1), "usage": {
                "input_tokens": inp, "output_tokens": out, "total_tokens": total,
            }, **self.snapshot(),
        })
        if over:
            raise LLMBudgetExceeded(self.stop_reason)


async def invoke_controlled(
    model: Any,
    messages: Any,
    *,
    control: Optional[LLMControl] = None,
    phase: str,
    context: str = "",
    retries: Optional[int] = None,
) -> Any:
    """Invoke a model without hidden provider retries and with task stop/budget checks."""
    retry_limit = retries if retries is not None else (control.request_retries if control else 0)
    attempt = 0
    message_chars = _message_chars(messages)
    while True:
        if control is not None:
            await control.reserve(phase, context, message_chars=message_chars)
        started = time.perf_counter()
        try:
            invoke_task = asyncio.create_task(asyncio.to_thread(model.invoke, messages))
            if control is None or control.heartbeat_seconds <= 0:
                response = await invoke_task
            else:
                while True:
                    try:
                        response = await asyncio.wait_for(
                            asyncio.shield(invoke_task), timeout=control.heartbeat_seconds
                        )
                        break
                    except asyncio.TimeoutError:
                        await control.emit({
                            "kind": "llm_request_heartbeat",
                            "phase": phase,
                            "context": context,
                            "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
                            "stop_requested": control.stop_event.is_set(),
                            **control.snapshot(),
                        })
        except Exception as exc:
            elapsed_ms = (time.perf_counter() - started) * 1000
            logger.warning(
                "LLM request failed phase=%s context=%s attempt=%d elapsed_ms=%.0f err=%s",
                phase, context, attempt + 1, elapsed_ms, exc,
            )
            if control is not None:
                await control.emit({
                    "kind": "llm_request_error", "phase": phase, "context": context,
                    "elapsed_ms": round(elapsed_ms, 1), "attempt": attempt + 1,
                    "error": str(exc)[:500], **control.snapshot(),
                })
                if is_quota_or_budget_error(exc):
                    await control.stop(f"provider quota/balance error: {str(exc)[:240]}")
                    raise
                if control.stop_event.is_set():
                    raise LLMStopped(control.stop_reason or "analysis stopped") from exc
            if attempt >= retry_limit or not is_retryable_llm_error(exc):
                raise
            attempt += 1
            delay = min(8.0, 0.5 * (2 ** (attempt - 1)))
            if control is not None:
                await control.emit({
                    "kind": "llm_retry_wait", "phase": phase, "context": context,
                    "attempt": attempt + 1, "delay_seconds": delay,
                })
                try:
                    await asyncio.wait_for(control.stop_event.wait(), timeout=delay)
                    raise LLMStopped(control.stop_reason or "analysis stopped")
                except asyncio.TimeoutError:
                    pass
            else:
                await asyncio.sleep(delay)
            continue

        elapsed_ms = (time.perf_counter() - started) * 1000
        if control is not None:
            await control.record_response(response, phase=phase, context=context, elapsed_ms=elapsed_ms)
            if control.stop_event.is_set() and control.stop_reason:
                raise LLMStopped(control.stop_reason)
        return response


def create_chat_model(
    model: Optional[str] = None,
    *,
    temperature: float = 0.0,
    timeout: Optional[int] = None,
    max_retries: int = 0,
    cfg: Optional[Settings] = None,
    thinking: Optional[bool] = None,
) -> ChatOpenAI:
    """Create ChatOpenAI; retries are handled explicitly by ``invoke_controlled``."""
    cfg = cfg or settings
    if not cfg.llm_api_key:
        raise llm_provider_error("LLM_API_KEY not configured. Set it in .env or environment.")
    resolved_model = model or cfg.llm_model
    resolved_timeout = timeout if timeout is not None else cfg.llm_timeout_seconds
    logger.info(
        "Creating ChatOpenAI: base_url=%s model=%s temp=%.1f timeout=%ss retries=%d",
        cfg.llm_base_url, resolved_model, temperature, resolved_timeout, max_retries,
    )
    extra_body = None
    if thinking is not None and "api.deepseek.com" in cfg.llm_base_url.lower():
        extra_body = {"thinking": {"type": "enabled" if thinking else "disabled"}}
    return ChatOpenAI(
        base_url=cfg.llm_base_url,
        api_key=cfg.llm_api_key,
        model=resolved_model,
        temperature=temperature,
        timeout=resolved_timeout,
        max_retries=max_retries,
        extra_body=extra_body,
    )


def get_chapter_llm(cfg: Optional[Settings] = None) -> ChatOpenAI:
    """Chapter Agent chat model at temperature 0 with provider-default thinking."""
    cfg = cfg or settings
    return create_chat_model(cfg.llm_model, temperature=0.0, cfg=cfg)


def get_reconcile_llm(cfg: Optional[Settings] = None) -> ChatOpenAI:
    """Reconcile/normalize chat model with thinking disabled for structured output."""
    cfg = cfg or settings
    # DeepSeek V4 defaults to thinking mode, but LangChain's function-calling
    # structured output forces a named tool_choice that DeepSeek rejects while
    # thinking is enabled. Keep Chapter Agent on provider-default thinking and
    # disable it only for the legacy postprocess/reconcile path.
    return create_chat_model(cfg.reconcile_model, temperature=0.0, cfg=cfg, thinking=False)


def check_connectivity(cfg: Optional[Settings] = None) -> bool:
    """Probe the provider with a fixed prompt; True only if the reply contains "OK".

    AppError propagates to the caller; any other failure returns False.
    """
    cfg = cfg or settings
    try:
        llm = create_chat_model(cfg=cfg)
        resp = llm.invoke("Reply with exactly: OK")
        ok = "OK" in str(resp.content).upper()
        logger.info("LLM connectivity check: %s", "OK" if ok else "FAIL")
        return ok
    except AppError:
        raise
    except Exception as exc:
        logger.warning("LLM connectivity check failed: %s", exc)
        return False
