"""
Filestore — workspace 同步文件 I/O 层。

所有方法使用同步 Path.read_text / Path.write_text。
调用方（FastAPI 路由）应通过 asyncio.to_thread() 包装。

目录结构：
    workspace/{book_id}/
        meta.json
        chapters/chapter_001.json ...
        cast.json
        ledger/chapter_001.json ...
        overrides/
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.config import settings
from app.errors import book_not_found
from app.models.book import BookMeta, Chapter, ChapterBrief
from app.models.cast import Cast
from app.models.ledger import ChapterLedger


def _atomic_write(path: Path, text: str) -> None:
    """临时文件 + rename 原子写入。"""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


class Filestore:
    """workspace 文件读写层。全同步 I/O。"""

    def __init__(self, workspace_root: Path) -> None:
        self.root: Path = workspace_root
        self.root.mkdir(parents=True, exist_ok=True)

    # ── 路径辅助 ──

    def book_dir(self, book_id: str) -> Path:
        return self.root / book_id

    def chapters_dir(self, book_id: str) -> Path:
        return self.book_dir(book_id) / "chapters"

    def ledger_dir(self, book_id: str) -> Path:
        return self.book_dir(book_id) / "ledger"

    def overrides_dir(self, book_id: str) -> Path:
        return self.book_dir(book_id) / "overrides"

    def meta_path(self, book_id: str) -> Path:
        return self.book_dir(book_id) / "meta.json"

    def cast_path(self, book_id: str) -> Path:
        return self.book_dir(book_id) / "cast.json"

    @staticmethod
    def _chapter_filename(chapter_id: int) -> str:
        return f"chapter_{chapter_id:03d}.json"

    def chapter_path(self, book_id: str, chapter_id: int) -> Path:
        return self.chapters_dir(book_id) / self._chapter_filename(chapter_id)

    def ledger_path(self, book_id: str, chapter_id: int) -> Path:
        return self.ledger_dir(book_id) / self._chapter_filename(chapter_id)

    # ── 书籍目录管理 ──

    def create_book_dir(self, book_id: str) -> None:
        """创建书籍目录结构。已存在不报错，确保子目录完整。"""
        for d in (
            self.book_dir(book_id),
            self.chapters_dir(book_id),
            self.ledger_dir(book_id),
            self.overrides_dir(book_id),
        ):
            d.mkdir(parents=True, exist_ok=True)

    def remove_book_dir(self, book_id: str) -> None:
        """递归删除书籍目录（失败清理用）。"""
        d = self.book_dir(book_id)
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)

    # ── BookMeta ──

    def write_meta(self, book_id: str, meta: BookMeta) -> None:
        data = meta.model_dump_json(indent=2)
        _atomic_write(self.meta_path(book_id), data)

    def read_meta(self, book_id: str) -> BookMeta:
        p = self.meta_path(book_id)
        if not p.exists():
            raise book_not_found(book_id)
        return BookMeta.model_validate_json(p.read_text(encoding="utf-8"))

    # ── Chapter ──

    def write_chapter(self, book_id: str, chapter: Chapter) -> None:
        data = chapter.model_dump_json(indent=2)
        _atomic_write(self.chapter_path(book_id, chapter.chapter_id), data)

    def read_chapter(self, book_id: str, chapter_id: int) -> Chapter:
        p = self.chapter_path(book_id, chapter_id)
        if not p.exists():
            raise book_not_found(book_id)
        return Chapter.model_validate_json(p.read_text(encoding="utf-8"))

    def read_chapter_content(self, book_id: str, chapter_id: int) -> str:
        """只返回 Chapter.content 字符串。"""
        return self.read_chapter(book_id, chapter_id).content

    def list_chapter_briefs(self, book_id: str) -> list[ChapterBrief]:
        """扫描 chapters/ 目录，返回 ChapterBrief 列表，按 order 排序。"""
        d = self.chapters_dir(book_id)
        if not d.exists():
            return []
        briefs: list[ChapterBrief] = []
        for f in sorted(d.glob("chapter_*.json")):
            ch = Chapter.model_validate_json(f.read_text(encoding="utf-8"))
            briefs.append(
                ChapterBrief(
                    chapter_id=ch.chapter_id,
                    title=ch.title,
                    order=ch.order,
                    word_count=ch.word_count,
                    include_in_analysis=ch.include_in_analysis,
                )
            )
        briefs.sort(key=lambda b: b.order)
        return briefs

    # ── Cast ──

    def write_cast(self, book_id: str, cast: Cast) -> None:
        data = cast.model_dump_json(indent=2)
        _atomic_write(self.cast_path(book_id), data)

    def read_cast(self, book_id: str) -> Cast:
        p = self.cast_path(book_id)
        if not p.exists():
            return Cast(version=0, persons=[])
        return Cast.model_validate_json(p.read_text(encoding="utf-8"))

    # ── Ledger ──

    def write_ledger(self, book_id: str, ledger: ChapterLedger) -> None:
        data = ledger.model_dump_json(indent=2)
        _atomic_write(self.ledger_path(book_id, ledger.chapter_id), data)

    def read_ledger(self, book_id: str, chapter_id: int) -> ChapterLedger:
        p = self.ledger_path(book_id, chapter_id)
        if not p.exists():
            raise book_not_found(book_id)
        return ChapterLedger.model_validate_json(p.read_text(encoding="utf-8"))

    def read_ledgers(
        self, book_id: str, chapter_ids: list[int]
    ) -> list[ChapterLedger]:
        """批量读取 ledger，跳过不存在的章。"""
        result: list[ChapterLedger] = []
        for cid in chapter_ids:
            p = self.ledger_path(book_id, cid)
            if p.exists():
                result.append(
                    ChapterLedger.model_validate_json(
                        p.read_text(encoding="utf-8")
                    )
                )
        return result

    # ── Overrides ──

    def relation_overrides_path(self, book_id: str) -> Path:
        return self.overrides_dir(book_id) / "relation_overrides.json"

    def read_relation_overrides(self, book_id: str) -> dict[str, list[dict]]:
        """读取 relation_overrides.json，不存在则返回空结构。"""
        p = self.relation_overrides_path(book_id)
        if not p.exists():
            return {"add": [], "remove": []}
        return json.loads(p.read_text(encoding="utf-8"))

    def write_relation_overrides(self, book_id: str, data: dict[str, list[dict]]) -> None:
        """写入 relation_overrides.json。"""
        self.overrides_dir(book_id).mkdir(parents=True, exist_ok=True)
        _atomic_write(
            self.relation_overrides_path(book_id),
            json.dumps(data, indent=2, ensure_ascii=False),
        )

    # ── Todo List ──

    def todo_list_path(self, book_id: str) -> Path:
        return self.book_dir(book_id) / "todo_list.json"

    def write_todo_list(self, book_id: str, todos: list[dict]) -> None:
        """写入 todo_list.json。"""
        _atomic_write(
            self.todo_list_path(book_id),
            json.dumps(todos, indent=2, ensure_ascii=False),
        )

    # ── Reconcile Report ──

    def reconcile_report_path(self, book_id: str) -> Path:
        return self.book_dir(book_id) / "reconcile_report.json"

    def write_reconcile_report(self, book_id: str, report: dict[str, Any]) -> None:
        """写入 reconcile_report.json。"""
        _atomic_write(
            self.reconcile_report_path(book_id),
            json.dumps(report, indent=2, ensure_ascii=False),
        )

    # ── 书目扫描 ──

    def list_books(self) -> list[BookMeta]:
        """扫描 workspace/*/meta.json，返回 BookMeta 列表，忽略无 meta.json 的目录。"""
        if not self.root.exists():
            return []
        books: list[BookMeta] = []
        for d in sorted(self.root.iterdir()):
            if not d.is_dir():
                continue
            meta_file = d / "meta.json"
            if not meta_file.exists():
                continue
            try:
                books.append(
                    BookMeta.model_validate_json(
                        meta_file.read_text(encoding="utf-8")
                    )
                )
            except Exception:
                # 跳过无法解析的 meta.json
                continue
        return books


# ── 懒加载单例 ──

_filestore: Filestore | None = None


def get_filestore() -> Filestore:
    """
    懒加载 Filestore 单例。
    API 层用 Depends(get_filestore) 注入；
    Agent 工具直接 from app.storage.filestore import get_filestore 调用。
    """
    global _filestore
    if _filestore is None:
        _filestore = Filestore(settings.workspace_path)
    return _filestore
