"""
CastWriter -- 人名册单写队列。

在所有 Chapter Agent 完成后（barrier），按章序顺序 apply 各章的 cast_buffer。
分配正式 person_id（p00N），建立临时→正式 id 映射，同 canonical_name 合并别名。
finalize() 后 rewrite 所有 ledger 文件中的临时 id，检测别名冲突写入 merge_queue.json。

D2: ledger 先存临时 id，CastWriter apply 后 rewrite
D6: P0 无 LLM Reconcile——只做程序基本合并
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional

from app.core.suspects import detect_cast_conflicts
from app.logging_config import get_logger
from app.models.cast import (
    Alias,
    AliasFrequency,
    Cast,
    Gender,
    Importance,
    Person,
)
from app.models.ledger import CastPropose, ChapterLedger
from app.storage.filestore import Filestore

logger = get_logger("agent.cast_writer")


class CastWriter:
    """
    人名册顺序写入器。

    用法：
        writer = CastWriter(book_id, filestore)
        for ch_id in sorted(chapter_ids):
            writer.apply(ch_id, cast_buffers[ch_id])
        writer.finalize()
    """

    def __init__(self, book_id: str, filestore: Filestore) -> None:
        self.book_id = book_id
        self.filestore = filestore

        # 从现有 cast.json 起步（支持增量分析）
        self.cast: Cast = filestore.read_cast(book_id)

        # 临时→正式 id 映射
        self.id_map: Dict[str, str] = {}

        # 正式 id 计数器：从已有 cast 最大编号 + 1 开始
        existing_max = 0
        for p in self.cast.persons:
            # person_id 格式 p00N
            num_part = p.person_id.lstrip("p0")
            try:
                num = int(num_part) if num_part else 0
                if num > existing_max:
                    existing_max = num
            except ValueError:
                pass
        self._next_id_num = existing_max

        # 记录处理过的章 id
        self._processed_chapters: List[int] = []

    def _next_formal_id(self) -> str:
        """分配下一个正式 person_id: p001, p002, ..."""
        self._next_id_num += 1
        return f"p{self._next_id_num:03d}"

    def _find_by_canonical_name(self, name: str) -> Optional[Person]:
        """按 canonical_name 精确匹配查找。"""
        for p in self.cast.persons:
            if p.canonical_name == name:
                return p
        return None

    @staticmethod
    def _parse_gender(gender_str: str) -> Gender:
        try:
            return Gender(gender_str)
        except ValueError:
            return Gender.UNKNOWN

    @staticmethod
    def _parse_importance(imp_str: str) -> Importance:
        try:
            return Importance(imp_str)
        except ValueError:
            return Importance.MINOR

    def apply(
        self, chapter_id: int, cast_buffer: Dict[str, CastPropose]
    ) -> None:
        """
        顺序 apply 一章的 cast_buffer。

        - canonical_name 完全一致 → 合并到已有 person（别名取并集）
        - 否则分配新 p00N id

        更新 id_map（临时→正式）。
        """
        self._processed_chapters.append(chapter_id)
        logger.info(
            "CastWriter apply: ch=%d buffer_size=%d", chapter_id, len(cast_buffer)
        )

        for temp_id, propose in cast_buffer.items():
            existing = self._find_by_canonical_name(propose.canonical_name)

            if existing is not None:
                # 合并：别名取并集
                existing_alias_names = {a.name for a in existing.aliases}
                for alias_name in propose.aliases:
                    if alias_name not in existing_alias_names:
                        existing.aliases.append(
                            Alias(name=alias_name, frequency=AliasFrequency.LOW)
                        )
                        existing_alias_names.add(alias_name)

                # 补充 bio（如果原 person 的 bio 为空）
                if not existing.bio and propose.bio:
                    existing.bio = propose.bio

                # importance 就高不就低
                importance_order = {
                    Importance.MINOR: 0,
                    Importance.SUPPORTING: 1,
                    Importance.MAIN: 2,
                }
                propose_imp = self._parse_importance(propose.importance)
                if importance_order.get(propose_imp, 0) > importance_order.get(
                    existing.importance, 0
                ):
                    existing.importance = propose_imp

                self.id_map[temp_id] = existing.person_id
                logger.debug(
                    "Merged: %s -> %s (%s)", temp_id, existing.person_id, propose.canonical_name
                )
            else:
                # 新人物
                formal_id = self._next_formal_id()
                person = Person(
                    person_id=formal_id,
                    canonical_name=propose.canonical_name,
                    aliases=[
                        Alias(name=a, frequency=AliasFrequency.LOW)
                        for a in propose.aliases
                    ],
                    bio=propose.bio,
                    gender=self._parse_gender(propose.gender),
                    importance=self._parse_importance(propose.importance),
                )
                self.cast.persons.append(person)
                self.id_map[temp_id] = formal_id
                logger.debug(
                    "New person: %s -> %s (%s)", temp_id, formal_id, propose.canonical_name
                )

    def finalize(self) -> None:
        """
        写入 cast.json + rewrite 所有 ledger + 检测冲突。

        1. bump cast version → write_cast
        2. rewrite ledger 文件中的临时 person_id
        3. detect_conflicts → merge_queue.json
        """
        # ── 1. 写 cast.json ──
        self.cast.version += 1
        self.filestore.write_cast(self.book_id, self.cast)
        logger.info(
            "Cast written: version=%d persons=%d",
            self.cast.version,
            len(self.cast.persons),
        )

        # ── 2. Rewrite ledger 文件 ──
        self._rewrite_ledgers()

        # ── 3. 检测冲突 ──
        conflicts = self._detect_conflicts()
        if conflicts:
            self._write_merge_queue(conflicts)
            logger.info("Detected %d alias conflict(s), written to merge_queue.json", len(conflicts))

    def _rewrite_ledgers(self) -> None:
        """用 id_map 替换所有 ledger 文件中的临时 person_id。"""
        ledger_dir = self.filestore.ledger_dir(self.book_id)
        if not ledger_dir.exists():
            return

        for ledger_file in sorted(ledger_dir.glob("chapter_*.json")):
            raw = ledger_file.read_text(encoding="utf-8")
            ledger = ChapterLedger.model_validate_json(raw)

            modified = False

            # 替换 persons[].person_id
            for p in ledger.persons:
                if p.person_id in self.id_map:
                    p.person_id = self.id_map[p.person_id]
                    modified = True

            # 替换 relations[].person_a / person_b
            for r in ledger.relations:
                if r.person_a in self.id_map:
                    r.person_a = self.id_map[r.person_a]
                    modified = True
                if r.person_b in self.id_map:
                    r.person_b = self.id_map[r.person_b]
                    modified = True

            # 替换 events[].persons 中的 id
            for e in ledger.events:
                new_persons = []
                for pid in e.persons:
                    new_persons.append(self.id_map.get(pid, pid))
                if new_persons != e.persons:
                    e.persons = new_persons
                    modified = True

            if modified:
                self.filestore.write_ledger(self.book_id, ledger)
                logger.debug("Ledger rewritten: %s", ledger_file.name)

    def _detect_conflicts(self) -> List[dict]:
        """
        #8: 检测可能需人工合并的人物对。

        检测逻辑已抽出到 core/suspects.py 的 detect_cast_conflicts 函数。
        此处调用公共函数并转换为 dict 列表格式（写 merge_queue 用）。
        """
        conflicts = detect_cast_conflicts(self.cast)
        return [c.model_dump() for c in conflicts]

    def _write_merge_queue(self, conflicts: List[dict]) -> None:
        """写入 merge_queue.json。"""
        merge_queue_path = self.filestore.book_dir(self.book_id) / "merge_queue.json"
        merge_queue_path.write_text(
            json.dumps(conflicts, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
