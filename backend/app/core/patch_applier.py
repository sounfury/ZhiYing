"""
PatchApplier -- 应用 ReconcilePatch 到存储层。

应用顺序（design.md \u00a77）：
  1. merges → rewrite person_id 全库（cast + ledger + overrides）
  2. aliases → 更新 cast
  3. relation_changes → 写 overrides/relation_overrides.json
  4. todos → 写 todo_list.json
  5. 写 reconcile_report.json

异常策略：任一步骤异常 SHALL 记录错误并继续后续步骤（尽力应用）。
"""
from __future__ import annotations

from datetime import datetime
from typing import Dict, List

from app.domain.relation_types import is_valid_type
from app.logging_config import get_logger
from app.models.cast import Alias, AliasFrequency, Cast, Person
from app.models.ledger import ChapterLedger
from app.models.reconcile import (
    AliasSuggestion,
    MergeSuggestion,
    PatchApplyResult,
    ReconcilePatch,
    RelationChange,
    TodoItem,
)
from app.storage.filestore import Filestore

logger = get_logger("core.patch_applier")


class PatchApplier:
    """应用 ReconcilePatch 到存储层。"""

    def __init__(self, book_id: str, filestore: Filestore) -> None:
        self.book_id = book_id
        self.filestore = filestore

    def apply(self, patch: ReconcilePatch) -> PatchApplyResult:
        """
        应用 patch，返回结果摘要。

        顺序：merges → aliases → relation_changes → todos → report
        每步独立 try/except，尽力应用。
        """
        result = PatchApplyResult()
        id_remap: Dict[str, str] = {}

        # 1. merges
        try:
            id_remap = self._apply_merges(patch.merges)
            result.merges_applied = len(id_remap)
        except Exception as e:
            logger.error("apply_merges failed: %s", e)
            result.errors.append(f"merges: {e}")

        # 2. aliases（在 merge 之后，因为 merge 可能改了 person_id）
        try:
            result.aliases_applied = self._apply_aliases(patch.aliases, id_remap)
        except Exception as e:
            logger.error("apply_aliases failed: %s", e)
            result.errors.append(f"aliases: {e}")

        # 3. relation_changes
        try:
            result.relation_changes_applied = self._apply_relation_changes(patch.relation_changes, id_remap)
        except Exception as e:
            logger.error("apply_relation_changes failed: %s", e)
            result.errors.append(f"relation_changes: {e}")

        # 4. todos
        try:
            self._apply_todos(patch.todos)
            result.todos_written = len(patch.todos)
        except Exception as e:
            logger.error("apply_todos failed: %s", e)
            result.errors.append(f"todos: {e}")

        # 5. 写 reconcile_report.json
        try:
            self._write_report(patch, result)
        except Exception as e:
            logger.error("write_report failed: %s", e)
            result.errors.append(f"report: {e}")

        logger.info(
            "Patch applied: merges=%d aliases=%d relation_changes=%d todos=%d errors=%d",
            result.merges_applied,
            result.aliases_applied,
            result.relation_changes_applied,
            result.todos_written,
            len(result.errors),
        )

        return result

    def merge_persons(self, keep_id: str, drop_id: str) -> Cast:
        """
        人工合并两人（ARCHITECTURE §8.2）。

        复用 _apply_merges：keep 吸收 drop 的别名，删 drop；
        全库 ledger + relation_overrides 确定性 rewrite person_id；
        自环边丢弃。返回更新后的 Cast。
        """
        remap = self._apply_merges(
            [MergeSuggestion(keep_id=keep_id, drop_id=drop_id, reason="manual")]
        )
        if not remap:
            logger.warning(
                "merge_persons applied nothing: keep=%s drop=%s", keep_id, drop_id
            )
        return self.filestore.read_cast(self.book_id)

    # ── 1. 合并 ──

    def _apply_merges(self, merges: List[MergeSuggestion]) -> Dict[str, str]:
        """
        处理 merges：解析传递闭包，将每个 drop_id 映射到最终 keep_id，
        然后一次性改 cast + ledger + overrides。

        链式合并（B→A, C→B）会被解析为 C→A（B 也→A）。

        Returns:
            id_remap: {drop_id: final_keep_id} 映射，供后续步骤使用。
        """
        if not merges:
            return {}

        cast = self.filestore.read_cast(self.book_id)
        person_map: Dict[str, Person] = {p.person_id: p for p in cast.persons}

        # 构建 raw merge map
        raw_map: Dict[str, str] = {}  # {drop_id: keep_id}
        for merge in merges:
            keep = person_map.get(merge.keep_id)
            drop = person_map.get(merge.drop_id)
            if keep is None or drop is None:
                logger.warning(
                    "Merge skip: keep_id=%s drop_id=%s (not found in cast)",
                    merge.keep_id,
                    merge.drop_id,
                )
                continue
            raw_map[merge.drop_id] = merge.keep_id

        # 解析传递闭包：每个 drop → 最终 keep（不在 raw_map 中的 id）
        def _resolve(pid: str, seen: set[str] | None = None) -> str:
            if seen is None:
                seen = set()
            if pid not in raw_map:
                return pid
            if pid in seen:
                # 环（不应到达，submit 已校验），防御性截断
                logger.warning("Cycle detected in merge resolution at %s, truncating", pid)
                return pid
            seen.add(pid)
            return _resolve(raw_map[pid], seen)

        id_remap: Dict[str, str] = {}
        for drop_id, keep_id in raw_map.items():
            final_keep = _resolve(keep_id)
            id_remap[drop_id] = final_keep
            logger.info("Merge: %s → %s (resolved)", drop_id, final_keep)

        # 将被合并者的别名逐层并入最终 keep
        # 例：C→B→A：先把 B 的别名并入 A，再把 C 的别名并入 A
        for drop_id, final_keep_id in id_remap.items():
            drop_person = person_map.get(drop_id)
            keep_person = person_map.get(final_keep_id)
            if drop_person is None or keep_person is None:
                continue
            keep_alias_names = {a.name for a in keep_person.aliases}
            for a in drop_person.aliases:
                if a.name not in keep_alias_names:
                    keep_person.aliases.append(a)
                    keep_alias_names.add(a.name)

        # 从 cast 中删除被合并的 person
        drop_ids = set(id_remap.keys())
        cast.persons = [p for p in cast.persons if p.person_id not in drop_ids]

        # bump version
        cast.version += 1
        self.filestore.write_cast(self.book_id, cast)

        # rewrite ledger 中的 person_id
        self._rewrite_ledgers_for_merge(id_remap)

        # rewrite relation_overrides 中的 person_id
        self._rewrite_overrides_for_merge(id_remap)

        return id_remap

    def _rewrite_ledgers_for_merge(self, id_remap: Dict[str, str]) -> None:
        """扫全部 ledger，将 drop_id → keep_id。自环边丢弃，重复边合并证据。"""
        ledger_dir = self.filestore.ledger_dir(self.book_id)
        if not ledger_dir.exists():
            return

        for ledger_file in sorted(ledger_dir.glob("chapter_*.json")):
            raw = ledger_file.read_text(encoding="utf-8")
            ledger = ChapterLedger.model_validate_json(raw)
            modified = False

            # 替换 persons[].person_id
            for p in ledger.persons:
                if p.person_id in id_remap:
                    p.person_id = id_remap[p.person_id]
                    modified = True

            # 替换 relations[].person_a / person_b + 丢弃自环
            new_relations = []
            for r in ledger.relations:
                a = id_remap.get(r.person_a, r.person_a)
                b = id_remap.get(r.person_b, r.person_b)
                if a == b:
                    logger.info("Self-loop discarded: %s→%s after merge", r.person_a, r.person_b)
                    modified = True
                    continue

                # 检查重复 (a, b, type) — 合并证据
                key = (a, b, r.type)
                existing = next(
                    (rr for rr in new_relations if rr.person_a == a and rr.person_b == b and rr.type == r.type),
                    None,
                )
                if existing:
                    # 合并证据（已有 quote 时不覆盖）
                    if not existing.evidence.quote and r.evidence.quote:
                        existing.evidence.quote = r.evidence.quote
                    modified = True
                    continue

                # 确保端点更新
                if r.person_a != a or r.person_b != b:
                    r.person_a = a
                    r.person_b = b
                    modified = True
                new_relations.append(r)

            # 去重 persons（合并后可能出现重复 ChapterPerson）
            seen_pids: set[str] = set()
            deduped_persons = []
            for p in ledger.persons:
                if p.person_id not in seen_pids:
                    seen_pids.add(p.person_id)
                    deduped_persons.append(p)
                else:
                    # 合并 aliases_in_chapter
                    existing = next(
                        pp for pp in deduped_persons if pp.person_id == p.person_id
                    )
                    existing.aliases_in_chapter = list(
                        set(existing.aliases_in_chapter) | set(p.aliases_in_chapter)
                    )
                    modified = True
            ledger.persons = deduped_persons
            ledger.relations = new_relations

            # 替换 events[].persons 中的 id
            for e in ledger.events:
                new_persons = [id_remap.get(pid, pid) for pid in e.persons]
                # 去重
                seen: set[str] = set()
                deduped: list[str] = []
                for pid in new_persons:
                    if pid not in seen:
                        seen.add(pid)
                        deduped.append(pid)
                if deduped != e.persons:
                    e.persons = deduped
                    modified = True

            if modified:
                self.filestore.write_ledger(self.book_id, ledger)
                logger.debug("Ledger rewritten for merge: %s", ledger_file.name)

    def _rewrite_overrides_for_merge(self, id_remap: Dict[str, str]) -> None:
        """扫 relation_overrides，将 drop_id → keep_id；合并后自环丢弃。"""
        overrides = self.filestore.read_relation_overrides(self.book_id)
        modified = False

        for action in ("add", "remove"):
            kept: list[dict] = []
            for entry in overrides.get(action, []):
                a = id_remap.get(entry.get("person_a", ""), entry.get("person_a", ""))
                b = id_remap.get(entry.get("person_b", ""), entry.get("person_b", ""))
                if a == b:
                    logger.info(
                        "Override self-loop discarded (%s): %s↔%s",
                        action,
                        entry.get("person_a"),
                        entry.get("person_b"),
                    )
                    modified = True
                    continue
                if a != entry.get("person_a") or b != entry.get("person_b"):
                    entry["person_a"] = a
                    entry["person_b"] = b
                    modified = True
                kept.append(entry)
            if kept != overrides.get(action, []):
                overrides[action] = kept
                modified = True

        if modified:
            self.filestore.write_relation_overrides(self.book_id, overrides)

    # ── 2. 别名 ──

    def _apply_aliases(
        self, aliases: List[AliasSuggestion], id_remap: Dict[str, str]
    ) -> int:
        """给 person 添加新别名（跳过已存在的）。返回实际生效条数。"""
        if not aliases:
            return 0

        cast = self.filestore.read_cast(self.book_id)
        person_map: Dict[str, Person] = {p.person_id: p for p in cast.persons}
        applied = 0

        for alias_sug in aliases:
            # 先 remap（如果 person_id 被 merge 了）
            pid = id_remap.get(alias_sug.person_id, alias_sug.person_id)
            person = person_map.get(pid)
            if person is None:
                logger.warning("Alias skip: person_id=%s not found", pid)
                continue

            existing_names = {a.name for a in person.aliases}
            added = False
            for name in alias_sug.new_aliases:
                if name not in existing_names:
                    person.aliases.append(
                        Alias(name=name, frequency=AliasFrequency.LOW)
                    )
                    existing_names.add(name)
                    added = True
            if added:
                applied += 1

        if applied:
            cast.version += 1
            self.filestore.write_cast(self.book_id, cast)
        return applied

    # ── 3. 关系修改 ──

    def _apply_relation_changes(
        self, changes: List[RelationChange], id_remap: Dict[str, str]
    ) -> int:
        """将 relation_changes 写入 overrides/relation_overrides.json。返回实际写入条数。"""
        if not changes:
            return 0

        overrides = self.filestore.read_relation_overrides(self.book_id)
        applied = 0

        for change in changes:
            # 校验 type
            if not is_valid_type(change.type):
                logger.warning(
                    "Relation change skip: invalid type '%s' for %s↔%s",
                    change.type,
                    change.person_a,
                    change.person_b,
                )
                continue

            # 先 remap
            a = id_remap.get(change.person_a, change.person_a)
            b = id_remap.get(change.person_b, change.person_b)

            entry = {
                "person_a": a,
                "person_b": b,
                "type": change.type,
                "chapter_id": change.chapter_id,
                "quote": change.quote,
                "note": change.note,
            }

            if change.action == "add":
                overrides.setdefault("add", []).append(entry)
                logger.info("Relation override ADD: %s↔%s [%s] ch=%d", a, b, change.type, change.chapter_id)
                applied += 1
            elif change.action == "remove":
                overrides.setdefault("remove", []).append(entry)
                logger.info("Relation override REMOVE: %s↔%s [%s] ch=%d", a, b, change.type, change.chapter_id)
                applied += 1

        self.filestore.write_relation_overrides(self.book_id, overrides)
        return applied

    # ── 4. 待办 ──

    def _apply_todos(self, todos: List[TodoItem]) -> None:
        """将 todos 写入 todo_list.json。"""
        if not todos:
            return

        todo_data = [
            {
                "description": t.description,
                "person_ids": t.person_ids,
                "chapter_ids": t.chapter_ids,
            }
            for t in todos
        ]
        self.filestore.write_todo_list(self.book_id, todo_data)

    # ── 5. 报告 ──

    def _write_report(self, patch: ReconcilePatch, result: PatchApplyResult) -> None:
        """写 reconcile_report.json。"""
        report = {
            "timestamp": datetime.now().isoformat(),
            # patch 提交条数（非 suspects 生成数）
            "patch_counts": {
                "merges": len(patch.merges),
                "aliases": len(patch.aliases),
                "relation_changes": len(patch.relation_changes),
                "todos": len(patch.todos),
            },
            "patch": patch.model_dump(),
            "apply_result": result.model_dump(),
        }
        self.filestore.write_reconcile_report(self.book_id, report)