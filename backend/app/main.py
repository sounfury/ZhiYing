"""
ZhiYing 后端入口。

FastAPI app + CORS + 全局异常处理 + 日志初始化。
路由暂为 501 骨架，后续逐步实现。
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.domain.relation_types import ALL_TYPE_NAMES, relation_summary_for_prompt
from app.errors import register_exception_handlers
from app.logging_config import get_logger, setup_logging
from app.api.books import router as books_router
from app.api.analysis import router as analysis_router

logger = get_logger("main")


def create_app() -> FastAPI:
    """工厂函数——可被 uvicorn 引用：uvicorn app.main:create_app --factory"""
    setup_logging(debug=settings.debug)

    app = FastAPI(
        title="ZhiYing API",
        version="0.1.0",
        description="把电子书变成可导航的人物关系图",
    )

    # ── CORS：本机 Vite 开发需要 ──
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],       # 本机个人项目，放心开
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ── 异常处理 ──
    register_exception_handlers(app)

    # ── 路由注册 ──
    app.include_router(books_router)
    app.include_router(analysis_router)

    _register_remaining_routes(app)

    # ── 启动事件 ──
    @app.on_event("startup")
    async def _on_startup() -> None:
        settings.ensure_workspace()
        logger.info(
            "ZhiYing started — workspace=%s debug=%s",
            settings.workspace_root,
            settings.debug,
        )

    logger.info("FastAPI app created")
    return app


def _register_remaining_routes(app: FastAPI) -> None:
    """
    其余 P0 路由骨架（尚未实现的端点）。

    books 相关路由已拆到 app/api/books.py。
    """

    @app.get("/api/health")
    async def health() -> dict:
        """轻量健康检查（§2.2.3 标注 P2，但本机调试方便先放一个最简版）。"""
        return {"status": "ok"}

    @app.get("/api/meta/relation-types")
    async def get_relation_types() -> dict:
        """关系类型枚举投影（§4.5 SSOT）。"""
        from app.domain.relation_types import RELATION_TYPES, Tier

        result = []
        for name, meta in RELATION_TYPES.items():
            result.append({
                "type": name,
                "tier": meta.tier.value,
                "directed": meta.directed,
            })
        return {"relation_types": result}

    # ── 以下路由返回 501，待实现 ──

    @app.post("/api/books/{book_id}/chapters/{cid}/rerun")
    async def rerun_chapter(book_id: str, cid: int) -> dict:
        from app.errors import AppError, ErrorCode
        raise AppError(
            ErrorCode.INTERNAL_ERROR,
            "Not implemented yet",
            status_code=501,
        )

    @app.put("/api/books/{book_id}/cast")
    async def update_cast(book_id: str) -> dict:
        from app.errors import AppError, ErrorCode
        raise AppError(
            ErrorCode.INTERNAL_ERROR,
            "Not implemented yet",
            status_code=501,
        )

    # GET /api/books/{book_id}/graph → analysis router (Aggregator)

    @app.put("/api/books/{book_id}/relations")
    async def update_relations(book_id: str) -> dict:
        from app.errors import AppError, ErrorCode
        raise AppError(
            ErrorCode.INTERNAL_ERROR,
            "Not implemented yet",
            status_code=501,
        )

    @app.post("/api/books/{book_id}/cast/merge")
    async def merge_persons(book_id: str) -> dict:
        from app.errors import AppError, ErrorCode
        raise AppError(
            ErrorCode.INTERNAL_ERROR,
            "Not implemented yet",
            status_code=501,
        )

    @app.get("/api/books/{book_id}/export")
    async def export_book(book_id: str) -> dict:
        from app.errors import AppError, ErrorCode
        raise AppError(
            ErrorCode.INTERNAL_ERROR,
            "Not implemented yet",
            status_code=501,
        )


# ── uvicorn entry ──
app = create_app()