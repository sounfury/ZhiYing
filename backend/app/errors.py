"""
薄错误处理。

一个 AppError + 少量 code + FastAPI 全局 handler。
P0 约定：不做分域大码表，用到再加。
"""
from __future__ import annotations

from enum import Enum
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


class ErrorCode(str, Enum):
    """P0 错误码——够用就停，别先做大表。"""

    BOOK_NOT_FOUND = "BOOK_NOT_FOUND"
    EPUB_PARSE_ERROR = "EPUB_PARSE_ERROR"
    ANALYSIS_ALREADY_RUNNING = "ANALYSIS_ALREADY_RUNNING"
    INVALID_RELATION_TYPE = "INVALID_RELATION_TYPE"
    LLM_PROVIDER_ERROR = "LLM_PROVIDER_ERROR"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    INTERNAL_ERROR = "INTERNAL_ERROR"


# ── 默认 HTTP status 映射 ──
_STATUS_MAP: dict[ErrorCode, int] = {
    ErrorCode.BOOK_NOT_FOUND: 404,
    ErrorCode.EPUB_PARSE_ERROR: 422,
    ErrorCode.ANALYSIS_ALREADY_RUNNING: 409,
    ErrorCode.INVALID_RELATION_TYPE: 422,
    ErrorCode.LLM_PROVIDER_ERROR: 502,
    ErrorCode.VALIDATION_ERROR: 422,
    ErrorCode.INTERNAL_ERROR: 500,
}


class AppError(Exception):
    """
    业务异常基类。

    用法：
        raise AppError(ErrorCode.BOOK_NOT_FOUND, "book xxx not found")
    或
        raise AppError(ErrorCode.INVALID_RELATION_TYPE,
                       "type 'XX' not in enum", details={"valid_types": [...]})
    """

    def __init__(
        self,
        code: ErrorCode,
        message: str = "",
        *,
        details: Optional[dict[str, Any]] = None,
        status_code: Optional[int] = None,  # 覆盖默认 status
    ) -> None:
        """初始化业务异常：message 缺省取 code 名，status 缺省查 _STATUS_MAP。"""
        self.code = code
        self.message = message or code.value
        self.details = details or {}
        self.status_code = status_code or _STATUS_MAP.get(code, 500)
        super().__init__(self.message)


# ── 快捷构造 ──

def book_not_found(book_id: str) -> AppError:
    """构造 404 BOOK_NOT_FOUND 错误。"""
    return AppError(ErrorCode.BOOK_NOT_FOUND, f"Book not found: {book_id}")


def epub_parse_error(detail: str) -> AppError:
    """构造 422 EPUB_PARSE_ERROR 错误。"""
    return AppError(ErrorCode.EPUB_PARSE_ERROR, f"EPUB parse error: {detail}")


def analysis_already_running(book_id: str) -> AppError:
    """构造 409 ANALYSIS_ALREADY_RUNNING 错误。"""
    return AppError(
        ErrorCode.ANALYSIS_ALREADY_RUNNING,
        f"Analysis already running for book: {book_id}",
    )


def invalid_relation_type(invalid: str, valid: list[str]) -> AppError:
    """构造 422 INVALID_RELATION_TYPE 错误，details 携带合法类型列表。"""
    return AppError(
        ErrorCode.INVALID_RELATION_TYPE,
        f"Invalid relation type: '{invalid}'. Valid types: {', '.join(valid)}",
        details={"valid_types": valid},
    )


def llm_provider_error(detail: str) -> AppError:
    """构造 502 LLM_PROVIDER_ERROR 错误。"""
    return AppError(ErrorCode.LLM_PROVIDER_ERROR, f"LLM provider error: {detail}")


def validation_error(detail: str, **extra: Any) -> AppError:
    """构造 422 VALIDATION_ERROR 错误，额外关键字参数并入 details。"""
    return AppError(ErrorCode.VALIDATION_ERROR, detail, details=extra)


def internal_error(detail: str = "Unexpected error") -> AppError:
    """构造 500 INTERNAL_ERROR 错误。"""
    return AppError(ErrorCode.INTERNAL_ERROR, detail)


# ── FastAPI 注册 ──

def _error_response(err: AppError) -> JSONResponse:
    """把 AppError 统一序列化为 {code, message, details} JSON 响应。"""
    return JSONResponse(
        status_code=err.status_code,
        content={
            "code": err.code.value,
            "message": err.message,
            "details": err.details,
        },
    )


def register_exception_handlers(app: FastAPI) -> None:
    """在 FastAPI app 上注册全局异常处理器。在 main.py 中调用一次。"""

    @app.exception_handler(AppError)
    async def _handle_app_error(request: Request, exc: AppError) -> JSONResponse:
        """业务异常按 code 映射的 status 返回结构化错误体。"""
        return _error_response(exc)

    @app.exception_handler(Exception)
    async def _handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        """兜底：任何未捕获异常记日志后返回 INTERNAL_ERROR。"""
        import logging
        logging.getLogger("zhiying").exception("Unhandled exception: %s", exc)
        fallback = internal_error(str(exc))
        return _error_response(fallback)