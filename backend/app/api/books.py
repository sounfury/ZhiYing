"""
书籍相关 API 路由。

POST /api/books/upload — 上传 EPUB，解析后落盘
GET  /api/books          — 书目列表
GET  /api/books/{book_id} — 书籍详情
GET  /api/books/{book_id}/chapters — 章节列表
"""
from __future__ import annotations

import asyncio
import shutil
import uuid

from fastapi import APIRouter, Depends, UploadFile, File
from fastapi.responses import JSONResponse

from app.errors import AppError, ErrorCode, validation_error
from app.storage.filestore import Filestore, get_filestore

router = APIRouter(prefix="/api/books", tags=["books"])


# ── Upload ──


@router.post("/upload")
async def upload_book(
    file: UploadFile = File(...),
    fs: Filestore = Depends(get_filestore),
) -> JSONResponse:
    """
    上传 EPUB 文件，解析后落盘到 workspace。

    流程：
      1. 校验 .epub 后缀
      2. 读文件内容 → asyncio.to_thread 调 parse_epub（纯内存）
      3. 成功 → create_book_dir + 批量 write
      4. 落盘失败 → shutil.rmtree 清理后重抛
    """
    # ── 校验后缀 ──
    filename = file.filename or ""
    if not filename.lower().endswith(".epub"):
        raise validation_error("只接受 .epub 文件")

    # ── 读取文件内容 ──
    raw_bytes = await file.read()

    # ── 先完整 parse（纯内存，不写盘）──
    import tempfile
    import os

    # 写临时文件供 ebooklib 读取
    tmp_path: str
    with tempfile.NamedTemporaryFile(suffix=".epub", delete=False) as tmp:
        tmp.write(raw_bytes)
        tmp_path = tmp.name

    try:
        from app.core.parser import parse_epub

        meta, chapters = await asyncio.to_thread(parse_epub, tmp_path)
    finally:
        os.unlink(tmp_path)

    # ── 生成 book_id ──
    book_id = str(uuid.uuid4())
    meta.book_id = book_id
    meta.source_file = filename  # 覆盖临时文件名，保留原始文件名

    # ── 落盘 ──
    def _persist() -> None:
        fs.create_book_dir(book_id)
        try:
            fs.write_meta(book_id, meta)
            for ch in chapters:
                fs.write_chapter(book_id, ch)
        except Exception:
            fs.remove_book_dir(book_id)
            raise

    try:
        await asyncio.to_thread(_persist)
    except Exception:
        raise

    return JSONResponse(
        status_code=201,
        content={
            "book_id": book_id,
            "title": meta.title or meta.source_file,
            "total_chapters": meta.total_chapters,
        },
    )


# ── List books ──


@router.get("")
async def list_books(
    fs: Filestore = Depends(get_filestore),
) -> dict:
    """返回所有已上传的书目列表。"""
    books = await asyncio.to_thread(fs.list_books)
    return {
        "books": [
            {
                "book_id": b.book_id,
                "title": b.title,
                "author": b.author,
                "status": b.status.value,
                "total_chapters": b.total_chapters,
            }
            for b in books
        ]
    }


# ── Get book detail ──


@router.get("/{book_id}")
async def get_book(
    book_id: str,
    fs: Filestore = Depends(get_filestore),
) -> dict:
    """返回单本书的详细信息。"""
    meta = await asyncio.to_thread(fs.read_meta, book_id)
    return meta.model_dump(mode="json")


# ── List chapters ──


@router.get("/{book_id}/chapters")
async def list_chapters(
    book_id: str,
    fs: Filestore = Depends(get_filestore),
) -> dict:
    """返回章节列表（不含正文）。"""
    briefs = await asyncio.to_thread(fs.list_chapter_briefs, book_id)
    return {
        "chapters": [
            {
                "chapter_id": b.chapter_id,
                "title": b.title,
                "order": b.order,
                "word_count": b.word_count,
                "include_in_analysis": b.include_in_analysis,
            }
            for b in briefs
        ]
    }
