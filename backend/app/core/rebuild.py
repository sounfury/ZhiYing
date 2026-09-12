"""Deterministic rebuild and same-volume staging helpers for safe chapter reruns."""
from __future__ import annotations

import shutil
from pathlib import Path
from uuid import uuid4

from app.agent.cast_writer import CastWriter
from app.models.cast import Cast, Person
from app.storage.filestore import Filestore


def record_human_cast_update(filestore: Filestore, book_id: str, persons: list[Person]) -> None:
    edits = filestore.read_human_edits(book_id)
    by_id = {
        item.get("person_id"): item
        for item in edits.get("cast_updates", [])
        if isinstance(item, dict) and item.get("person_id")
    }
    for person in persons:
        by_id[person.person_id] = person.model_dump(mode="json")
    edits["cast_updates"] = list(by_id.values())
    edits.setdefault("merges", [])
    filestore.write_human_edits(book_id, edits)


def record_human_merge(
    filestore: Filestore,
    book_id: str,
    *,
    keep_id: str,
    drop_id: str,
) -> None:
    edits = filestore.read_human_edits(book_id)
    merges = [m for m in edits.get("merges", []) if isinstance(m, dict)]
    item = {"keep_id": keep_id, "drop_id": drop_id}
    if item not in merges:
        merges.append(item)
    edits.setdefault("cast_updates", [])
    edits["merges"] = merges
    filestore.write_human_edits(book_id, edits)


def apply_human_edits(filestore: Filestore, book_id: str) -> None:
    """Replay persisted manual cast edits and manual merges after a rebuild."""
    from app.core.patch_applier import PatchApplier

    edits = filestore.read_human_edits(book_id)
    cast = filestore.read_cast(book_id)
    person_map = {p.person_id: p for p in cast.persons}
    changed = False
    for raw in edits.get("cast_updates", []):
        try:
            incoming = Person.model_validate(raw)
        except Exception:
            continue
        existing = person_map.get(incoming.person_id)
        if existing is None:
            cast.persons.append(incoming)
            person_map[incoming.person_id] = incoming
            changed = True
            continue
        existing.canonical_name = incoming.canonical_name
        existing.aliases = incoming.aliases
        existing.bio = incoming.bio
        existing.gender = incoming.gender
        existing.importance = incoming.importance
        existing.merge_candidates = incoming.merge_candidates
        changed = True
    if changed:
        cast.version += 1
        filestore.write_cast(book_id, cast)

    applier = PatchApplier(book_id, filestore)
    for raw in edits.get("merges", []):
        keep_id = str(raw.get("keep_id") or "")
        drop_id = str(raw.get("drop_id") or "")
        current = filestore.read_cast(book_id)
        if (
            keep_id
            and drop_id
            and keep_id != drop_id
            and current.get_person(keep_id) is not None
            and current.get_person(drop_id) is not None
        ):
            applier.merge_persons(keep_id, drop_id)


def rebuild_cast_from_extractions(
    filestore: Filestore,
    book_id: str,
    chapter_ids: list[int],
    *,
    raw_ledger_ids: set[int] | None = None,
    reservation_cast: Cast | None = None,
) -> Cast:
    """Rebuild cast deterministically from raw extraction snapshots.

    Only ``raw_ledger_ids`` are restored to their pre-CastWriter raw ledger form.
    Other chapter ledgers remain postprocessed and are left intact; CastWriter only
    rewrites temp ids it knows, so formal ids in those ledgers remain stable.
    """
    raw_ledger_ids = set(raw_ledger_ids or set())
    base_cast = filestore.read_extraction_base_cast(book_id)
    if base_cast is None:
        raise FileNotFoundError("extraction/base_cast.json is missing; full analysis rebuild data is unavailable")
    filestore.write_cast(book_id, base_cast.model_copy(deep=True))

    reservations = {
        p.canonical_name: p.person_id for p in (reservation_cast or Cast()).persons
    }
    writer = CastWriter(book_id, filestore, id_reservations=reservations)
    for cid in sorted(chapter_ids):
        item = filestore.read_extraction_result(book_id, cid)
        if item is None:
            raise FileNotFoundError(f"raw extraction snapshot missing for chapter {cid}")
        if cid in raw_ledger_ids:
            filestore.write_ledger(book_id, item["ledger"].model_copy(deep=True))
        writer.apply(cid, item["cast_buffer"])
    writer.finalize()
    apply_human_edits(filestore, book_id)
    return filestore.read_cast(book_id)



def capture_relations_by_id(filestore: Filestore, book_id: str, chapter_ids: list[int]) -> dict[str, dict]:
    captured: dict[str, dict] = {}
    for ledger in filestore.read_ledgers(book_id, chapter_ids):
        for relation in ledger.relations:
            captured[relation.relation_id] = relation.model_dump(mode="json")
    for raw in filestore.read_reconcile_overrides(book_id).get("add", []):
        relation_id = raw.get("relation_id")
        if relation_id:
            captured[relation_id] = raw
    return captured


def remap_manual_relation_removals(
    filestore: Filestore,
    book_id: str,
    old_relations: dict[str, dict],
    chapter_ids: list[int],
) -> None:
    """Preserve manual remove intent when a rerun deterministically changes relation_id."""
    from app.core.relation_registry import descriptor
    from app.models.ledger import Relation

    overrides = filestore.read_relation_overrides(book_id)
    new_relations = [r for ledger in filestore.read_ledgers(book_id, chapter_ids) for r in ledger.relations]
    current_ids = {r.relation_id for r in new_relations}

    def signature(raw: dict) -> tuple:
        try:
            relation = Relation.model_validate(raw)
        except Exception:
            return ()
        desc = descriptor(relation)
        return (
            relation.person_a,
            relation.person_b,
            tuple(sorted(desc.items())),
            relation.raw_relation.strip(),
            relation.evidence.chapter_id,
            relation.evidence.quote.strip(),
        )

    by_signature: dict[tuple, list[str]] = {}
    for relation in new_relations:
        by_signature.setdefault(signature(relation.model_dump(mode="json")), []).append(relation.relation_id)

    changed = False
    rewritten: list[dict] = []
    seen: set[str] = set()
    for item in overrides.get("remove", []):
        old_id = item.get("relation_id") if isinstance(item, dict) else None
        target_id = old_id
        if old_id and old_id not in current_ids and old_id in old_relations:
            matches = by_signature.get(signature(old_relations[old_id]), [])
            if len(matches) == 1:
                target_id = matches[0]
                changed = changed or target_id != old_id
        if target_id and target_id not in seen:
            rewritten.append({"relation_id": target_id})
            seen.add(target_id)
    if changed:
        overrides["remove"] = rewritten
        filestore.write_relation_overrides(book_id, overrides)

def create_staging_filestore(live: Filestore, book_id: str) -> tuple[Filestore, Path, str]:
    """Clone one book to a same-volume transaction root."""
    txn_id = uuid4().hex
    txn_root = live.root / ".staging" / txn_id
    txn_root.mkdir(parents=True, exist_ok=True)
    source = live.book_dir(book_id)
    if not source.exists():
        raise FileNotFoundError(f"book directory not found: {book_id}")
    shutil.copytree(source, txn_root / book_id)
    return Filestore(txn_root), txn_root, txn_id


def discard_staging(txn_root: Path) -> None:
    shutil.rmtree(txn_root, ignore_errors=True)


def publish_staging_book(
    live: Filestore,
    staged: Filestore,
    book_id: str,
    *,
    txn_id: str,
) -> None:
    """Publish a staged book using same-volume rename with rollback."""
    live_dir = live.book_dir(book_id)
    staged_dir = staged.book_dir(book_id)
    if not staged_dir.exists():
        raise FileNotFoundError("staged book directory disappeared")
    backup_root = live.root / ".publish_backup"
    backup_root.mkdir(parents=True, exist_ok=True)
    backup = backup_root / f"{book_id}-{txn_id}"
    if backup.exists():
        shutil.rmtree(backup, ignore_errors=True)
    live_dir.replace(backup)
    try:
        staged_dir.replace(live_dir)
    except Exception:
        if live_dir.exists():
            shutil.rmtree(live_dir, ignore_errors=True)
        backup.replace(live_dir)
        raise
    else:
        shutil.rmtree(backup, ignore_errors=True)
        discard_staging(staged.root)
