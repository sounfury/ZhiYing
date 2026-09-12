from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
MANIFEST = json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))
CANON = {x["name"] for x in MANIFEST["canonical_cast"]}

errors: list[str] = []
stats = {"chapters": 0, "required": 0, "optional": 0, "forbidden": 0, "evidence_quotes": 0}


def check_evidence(items, content: str, where: str):
    for idx, item in enumerate(items, 1):
        for ev in item.get("evidence", []):
            q = ev.get("quote", "")
            stats["evidence_quotes"] += 1
            if not q:
                errors.append(f"{where}[{idx}] empty evidence quote")
            elif q not in content:
                errors.append(f"{where}[{idx}] quote not found: {q!r}")


for cid in range(1, 13):
    gold_path = HERE / f"chapter_{cid:03d}.json"
    if not gold_path.exists():
        errors.append(f"missing {gold_path.name}")
        continue
    data = json.loads(gold_path.read_text(encoding="utf-8"))
    stats["chapters"] += 1
    if data.get("chapter_id") != cid:
        errors.append(f"{gold_path.name}: chapter_id mismatch")

    source_path = ROOT / data["source_chapter_file"]
    source = json.loads(source_path.read_text(encoding="utf-8"))
    content = source["content"]
    if source.get("title") != data.get("title"):
        errors.append(f"{gold_path.name}: title mismatch source={source.get('title')!r} gold={data.get('title')!r}")
    if not source.get("include_in_analysis", True):
        errors.append(f"{gold_path.name}: source chapter excluded from analysis")

    for person in data.get("characters", []):
        if person["name"] not in CANON:
            errors.append(f"{gold_path.name}: unknown character {person['name']}")

    req = data.get("required_relations", [])
    opt = data.get("optional_relations", [])
    neg = data.get("forbidden_relations", [])
    stats["required"] += len(req)
    stats["optional"] += len(opt)
    stats["forbidden"] += len(neg)

    for group_name, group in (("required", req), ("optional", opt)):
        for i, r in enumerate(group, 1):
            for key in ("person_a", "person_b"):
                if r[key] not in CANON:
                    errors.append(f"{gold_path.name}:{group_name}[{i}] unknown endpoint {r[key]}")
            if r["person_a"] == r["person_b"]:
                errors.append(f"{gold_path.name}:{group_name}[{i}] self relation")
        check_evidence(group, content, f"{gold_path.name}:{group_name}")

    for i, r in enumerate(neg, 1):
        for key in ("person_a", "person_b"):
            if r[key] not in CANON:
                errors.append(f"{gold_path.name}:forbidden[{i}] unknown endpoint {r[key]}")
    check_evidence(neg, content, f"{gold_path.name}:forbidden")

    identity = data.get("identity_assertions", [])
    check_evidence(identity, content, f"{gold_path.name}:identity")

# Chapter 13 must remain excluded.
ch13 = json.loads((ROOT / "workspace" / MANIFEST["book_id"] / "chapters" / "chapter_013.json").read_text(encoding="utf-8"))
if ch13.get("include_in_analysis", True):
    errors.append("chapter_013 expected include_in_analysis=false")

print(json.dumps(stats, ensure_ascii=False, indent=2))
if errors:
    print("\nVALIDATION ERRORS:")
    for e in errors:
        print("-", e)
    raise SystemExit(1)
print("\nVALIDATION OK")
