from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def _norm(text: str | None) -> str:
    if not text:
        return ""
    return re.sub(r"[\s\-—_·・,，。.!！?？:：;；()（）\[\]【】'\"“”‘’/\\]+", "", str(text)).lower()


def _f1(precision: float, recall: float) -> float:
    return 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)


def _pct(value: float) -> float:
    return round(value * 100, 2)


@dataclass(frozen=True)
class RelationView:
    chapter_id: int
    source: str  # gold_required | gold_optional | prediction
    index: int
    person_a: str
    person_b: str
    kind: str
    directed: bool
    role_a: str
    role_b: str
    label: str
    category: str
    raw: str
    evidence_quote: str
    evidence_valid: bool | None = None

    @property
    def canonical_key(self) -> tuple[str, str, str]:
        a, b = canonicalize_roles(self)
        if not self.directed and a > b:
            a, b = b, a
        return self.kind, a, b


# V1 uses a deliberately small semantic taxonomy. It is not intended to replace
# the project's open relation labels; it only aligns Gold and predictions for scoring.
def classify_relation(label: str, category: str = "", raw: str = "", role_a: str = "", role_b: str = "") -> str:
    # The explicit label/category/roles are authoritative. Raw relation text is only
    # used to disambiguate generic labels such as “师徒”; otherwise mentions of a
    # third party inside raw text can corrupt the classification (e.g. a friendship
    # sentence that also says one friend皈依佛陀).
    head = _norm(" ".join(x for x in [label, category, role_a, role_b] if x))
    context = _norm(raw)

    if any(k in head for k in ["父子", "父亲儿子", "生父"]):
        return "father_son"
    if any(k in head for k in ["母子", "母亲儿子"]):
        return "mother_son"
    if any(k in head for k in ["布施供养", "施主", "供养"]):
        return "donation"
    if any(k in head for k in ["昔日恋人", "情人", "恋人", "姘夫"]):
        return "lover"
    if any(k in head for k in ["相互吸引", "互生吸引"]):
        return "attraction"
    if any(k in head for k in ["朋友", "挚友", "好友", "友谊"]):
        return "friend"
    if any(k in head for k in ["问法论道", "求教问法", "宣法受问"]):
        return "discourse"
    if any(k in head for k in ["追随", "随从", "结伴同行", "同行"]):
        return "follow"
    if any(k in head for k in ["守候", "陪伴"]):
        return "guard"
    if any(k in head for k in ["施救", "被救", "救助"]):
        return "rescue"
    if any(k in head for k in ["担忧", "关怀", "照料接纳", "照料"]):
        return "care"
    if any(k in head for k in ["倾诉", "倾听"]):
        return "listen_support"
    if any(k in head for k in ["憎恨", "仇视", "反抗"]):
        return "conflict"
    if any(k in head for k in ["冒犯", "偷窃", "偷摘"]):
        return "offense"
    if any(k in head for k in ["使其怀孕", "怀孕"]):
        return "pregnancy"
    if any(k in head for k in ["辞别", "送行", "告别"]):
        return "farewell"
    if any(k in head for k in ["同住", "共居"]):
        return "cohabit"
    if any(k in head for k in ["敬仰", "崇敬", "敬爱", "信念认同", "敬慕"]):
        return "respect"
    if any(k in head for k in ["额吻", "亲吻"]):
        return "kiss"
    if any(k in head for k in ["皈依信徒", "皈依对象", "皈依者", "信徒", "皈依"]):
        return "religious_follower"

    # Specific guidance variants.
    if any(k in head for k in ["欢爱", "爱经", "情爱艺术", "爱的艺术"]):
        return "skill_teacher_love"
    if any(k in head for k in ["商业共事", "生意伙伴", "经商指导", "商业关系"]):
        return "business"
    if any(k in head for k in ["摆渡学艺", "授艺学徒", "学徒", "授艺"]):
        return "craft_guidance"
    if any(k in head for k in ["精神引导", "精神启发", "恩师", "前辈师长", "前辈和师长", "倾听大师"]):
        return "mentor"

    # Generic teacher labels need context to preserve the relation's actual domain.
    if any(k in head for k in ["师徒", "弟子", "师傅", "老师", "宗师", "师长"]):
        if any(k in context for k in ["欢爱", "爱经", "接吻", "情爱艺术", "爱的艺术"]):
            return "skill_teacher_love"
        if any(k in context for k in ["经商", "做生意", "清算账目", "货品", "货栈"]):
            return "business"
        if any(k in context for k in ["撑船", "摇橹", "船桨", "学徒", "授艺"]):
            return "craft_guidance"
        if any(k in context for k in ["精神引导", "精神启发", "前辈", "倾听", "河水"]):
            return "mentor"
        return "formal_teacher"

    # Context-only fallbacks are intentionally narrow.
    if "你的儿子" in context:
        return "father_son"
    if any(k in context for k in ["爱他的声音", "爱他的目光"]):
        return "attraction"
    if "敬献" in context and "园" in context:
        return "donation"

    return f"other:{_norm(label) or _norm(category) or 'unknown'}"


def canonicalize_roles(rel: RelationView) -> tuple[str, str]:
    """Return endpoints in semantic role order when the relation has a natural direction."""
    a, b = rel.person_a, rel.person_b
    ra, rb = _norm(rel.role_a), _norm(rel.role_b)

    def swap_if_b_has(words: Iterable[str]) -> tuple[str, str]:
        if any(w in rb for w in words) and not any(w in ra for w in words):
            return b, a
        return a, b

    if rel.kind in {"formal_teacher", "skill_teacher_love", "mentor", "craft_guidance"}:
        return swap_if_b_has(["师傅", "老师", "导师", "宗师", "引导者", "师长", "授艺者", "前辈"])
    if rel.kind == "father_son":
        return swap_if_b_has(["父亲", "生父"])
    if rel.kind == "mother_son":
        return swap_if_b_has(["母亲"])
    if rel.kind == "religious_follower":
        # canonical order: follower -> object
        return swap_if_b_has(["信徒", "皈依者", "弟子"])
    if rel.kind == "donation":
        return swap_if_b_has(["施主", "捐赠者", "供养者"])
    if rel.kind == "follow":
        return swap_if_b_has(["追随者", "随行者"])
    if rel.kind == "guard":
        return swap_if_b_has(["守候者"])
    if rel.kind == "rescue":
        return swap_if_b_has(["施救者", "救助者"])
    if rel.kind == "care":
        return swap_if_b_has(["担忧", "关心", "照料", "接纳者"])
    if rel.kind == "conflict":
        return swap_if_b_has(["仇视", "反抗者"])
    if rel.kind == "pregnancy":
        return swap_if_b_has(["父", "使女方怀孕"])
    return a, b


def kind_compatible(gold_kind: str, pred_kind: str) -> bool:
    if gold_kind == pred_kind:
        return True
    compatible = {
        "mentor": {"respect"},
        "business": {"other:商业共事", "other:生意伙伴"},
        "friend": {"cohabit"},
    }
    return pred_kind in compatible.get(gold_kind, set())


def relation_matches(gold: RelationView, pred: RelationView) -> bool:
    if not kind_compatible(gold.kind, pred.kind):
        return False
    ga, gb = canonicalize_roles(gold)
    pa, pb = canonicalize_roles(pred)
    if gold.directed:
        return ga == pa and gb == pb
    return {ga, gb} == {pa, pb}


def build_alias_map(manifest: dict[str, Any]) -> tuple[dict[str, str], dict[str, set[str]]]:
    alias_map: dict[str, str] = {}
    allowed: dict[str, set[str]] = defaultdict(set)
    for p in manifest["canonical_cast"]:
        canonical = p["name"]
        for name in [canonical, *p.get("aliases", [])]:
            alias_map[_norm(name)] = canonical
            allowed[canonical].add(_norm(name))
    for assertion in manifest.get("global_identity_assertions", []):
        canonical = assertion["canonical"]
        for name in [canonical, *assertion.get("aliases", [])]:
            alias_map[_norm(name)] = canonical
            allowed[canonical].add(_norm(name))
    return alias_map, allowed


def resolve_name(name: str, alias_map: dict[str, str]) -> str | None:
    return alias_map.get(_norm(name))


def load_prediction_cast(workspace: Path, manifest: dict[str, Any]) -> tuple[dict[str, str | None], dict[str, Any]]:
    cast_path = workspace / "cast.json"
    if not cast_path.exists():
        return {}, {"missing": True, "path": str(cast_path)}
    data = json.loads(cast_path.read_text(encoding="utf-8"))
    alias_map, allowed_aliases = build_alias_map(manifest)
    id_to_canonical: dict[str, str | None] = {}
    groups: dict[str, list[str]] = defaultdict(list)
    unresolved: list[dict[str, str]] = []
    embedded_conflicts: list[dict[str, str]] = []

    gold_canonicals = [p["name"] for p in manifest["canonical_cast"]]
    for p in data.get("persons", []):
        pid = p["person_id"]
        cname = p.get("canonical_name", "")
        canonical = resolve_name(cname, alias_map)
        id_to_canonical[pid] = canonical
        if canonical:
            groups[canonical].append(pid)
        else:
            unresolved.append({"person_id": pid, "canonical_name": cname})

        if canonical:
            for alias_obj in p.get("aliases", []):
                alias = alias_obj.get("name", "") if isinstance(alias_obj, dict) else str(alias_obj)
                na = _norm(alias)
                if na in allowed_aliases.get(canonical, set()):
                    continue
                # Flag only strong cross-entity alias collisions; do not punish ordinary descriptive aliases.
                conflicting = [g for g in gold_canonicals if g != canonical and _norm(g) and _norm(g) in na]
                if conflicting:
                    embedded_conflicts.append({
                        "person_id": pid,
                        "canonical_name": cname,
                        "alias": alias,
                        "conflicts_with": conflicting[0],
                    })

    gold_count = len(manifest["canonical_cast"])
    predicted_count = len(data.get("persons", []))
    covered = sum(1 for g in gold_canonicals if groups.get(g))
    resolved_nodes = sum(len(v) for v in groups.values())
    entity_precision = covered / predicted_count if predicted_count else 0.0
    entity_recall = covered / gold_count if gold_count else 1.0
    duplicate_excess = sum(max(0, len(v) - 1) for v in groups.values())
    merge_accuracy = max(0.0, 1.0 - duplicate_excess / gold_count) if gold_count else 1.0

    metrics = {
        "missing": False,
        "gold_entities": gold_count,
        "predicted_nodes": predicted_count,
        "resolved_nodes": resolved_nodes,
        "covered_gold_entities": covered,
        "entity_precision": entity_precision,
        "entity_recall": entity_recall,
        "entity_f1": _f1(entity_precision, entity_recall),
        "identity_merge_accuracy": merge_accuracy,
        "duplicate_entity_groups": {k: v for k, v in groups.items() if len(v) > 1},
        "unresolved_nodes": unresolved,
        "embedded_alias_conflicts": embedded_conflicts,
    }
    return id_to_canonical, metrics


def gold_relation_view(chapter_id: int, item: dict[str, Any], index: int, source: str) -> RelationView:
    quote = ""
    if item.get("evidence"):
        quote = item["evidence"][0].get("quote", "")
    return RelationView(
        chapter_id=chapter_id,
        source=source,
        index=index,
        person_a=item["person_a"],
        person_b=item["person_b"],
        kind=classify_relation(item.get("label", ""), item.get("category", ""), item.get("note", ""), item.get("subject_role", ""), item.get("object_role", "")),
        directed=bool(item.get("directed", False)),
        role_a=item.get("subject_role", ""),
        role_b=item.get("object_role", ""),
        label=item.get("label", ""),
        category=item.get("category", ""),
        raw=item.get("note", ""),
        evidence_quote=quote,
    )


def pred_relation_view(chapter_id: int, item: dict[str, Any], index: int, id_map: dict[str, str | None], chapter_content: str) -> RelationView | None:
    a = id_map.get(item.get("person_a", ""))
    b = id_map.get(item.get("person_b", ""))
    if not a or not b:
        return None
    evidence = item.get("evidence") or {}
    quote = evidence.get("quote", "") or ""
    evidence_valid = bool(quote and quote in chapter_content)
    return RelationView(
        chapter_id=chapter_id,
        source="prediction",
        index=index,
        person_a=a,
        person_b=b,
        kind=classify_relation(item.get("label", ""), item.get("category", ""), item.get("raw_relation", ""), item.get("subject_role", ""), item.get("object_role", "")),
        directed=bool(item.get("directed", False)),
        role_a=item.get("subject_role", ""),
        role_b=item.get("object_role", ""),
        label=item.get("label", ""),
        category=item.get("category", ""),
        raw=item.get("raw_relation", ""),
        evidence_quote=quote,
        evidence_valid=evidence_valid,
    )


def forbidden_kinds(item: dict[str, Any]) -> set[str]:
    return {classify_relation(label) for label in item.get("forbidden_labels", [])}


def forbidden_violation(item: dict[str, Any], pred: RelationView) -> bool:
    kinds = forbidden_kinds(item)
    if pred.kind not in kinds:
        return False
    a, b = item["person_a"], item["person_b"]
    # Forbidden assertions are pair-level; role direction is not important for detecting the error.
    return {a, b} == {pred.person_a, pred.person_b}


def evaluate(gold_dir: Path, workspace: Path) -> dict[str, Any]:
    manifest = json.loads((gold_dir / "manifest.json").read_text(encoding="utf-8"))
    id_map, cast_metrics = load_prediction_cast(workspace, manifest)

    relation_summary = Counter()
    chapter_results: list[dict[str, Any]] = []
    all_pred_relations: list[RelationView] = []
    matched_pred_ids: set[tuple[int, int]] = set()
    forbidden_pred_ids: set[tuple[int, int]] = set()
    duplicate_count = 0
    duplicate_excess = 0
    evidence_total = 0
    evidence_valid = 0
    invalid_evidence: list[dict[str, Any]] = []
    unresolved_relation_endpoints = 0
    missing_ledgers: list[int] = []

    for cid in range(1, 13):
        gold = json.loads((gold_dir / f"chapter_{cid:03d}.json").read_text(encoding="utf-8"))
        source_path = ROOT / gold["source_chapter_file"]
        source = json.loads(source_path.read_text(encoding="utf-8"))
        content = source.get("content", "")

        ledger_path = workspace / "ledger" / f"chapter_{cid:03d}.json"
        pred_data: dict[str, Any] = {"relations": []}
        if ledger_path.exists():
            pred_data = json.loads(ledger_path.read_text(encoding="utf-8"))
        else:
            missing_ledgers.append(cid)

        preds: list[RelationView] = []
        for i, item in enumerate(pred_data.get("relations", []), 1):
            view = pred_relation_view(cid, item, i, id_map, content)
            if view is None:
                unresolved_relation_endpoints += 1
                continue
            preds.append(view)
            all_pred_relations.append(view)
            evidence_total += 1
            evidence_valid += int(bool(view.evidence_valid))
            if not view.evidence_valid:
                invalid_evidence.append({
                    "chapter_id": cid,
                    "relation_index": view.index,
                    "a": view.person_a,
                    "b": view.person_b,
                    "label": view.label,
                    "quote": view.evidence_quote,
                })

        # Duplicate semantic edges within a chapter.
        counts = Counter(p.canonical_key for p in preds)
        chapter_dups = {str(k): v for k, v in counts.items() if v > 1}
        duplicate_count += len(chapter_dups)
        duplicate_excess += sum(v - 1 for v in counts.values() if v > 1)

        required = [gold_relation_view(cid, x, i, "gold_required") for i, x in enumerate(gold.get("required_relations", []), 1)]
        optional = [gold_relation_view(cid, x, i, "gold_optional") for i, x in enumerate(gold.get("optional_relations", []), 1)]

        req_details = []
        for g in required:
            matches = [p for p in preds if relation_matches(g, p)]
            hit = bool(matches)
            relation_summary["required_total"] += 1
            relation_summary["required_hit"] += int(hit)
            for p in matches:
                matched_pred_ids.add((cid, p.index))
            req_details.append({
                "gold": {"a": g.person_a, "b": g.person_b, "label": g.label, "kind": g.kind},
                "hit": hit,
                "matched_prediction_labels": [p.label for p in matches],
            })

        opt_details = []
        for g in optional:
            matches = [p for p in preds if relation_matches(g, p)]
            hit = bool(matches)
            relation_summary["optional_total"] += 1
            relation_summary["optional_hit"] += int(hit)
            for p in matches:
                matched_pred_ids.add((cid, p.index))
            opt_details.append({
                "gold": {"a": g.person_a, "b": g.person_b, "label": g.label, "kind": g.kind},
                "hit": hit,
                "matched_prediction_labels": [p.label for p in matches],
            })

        forbidden_details = []
        for fi, f in enumerate(gold.get("forbidden_relations", []), 1):
            violations = [p for p in preds if forbidden_violation(f, p)]
            violated = bool(violations)
            relation_summary["forbidden_total"] += 1
            relation_summary["forbidden_violations"] += int(violated)
            for p in violations:
                forbidden_pred_ids.add((cid, p.index))
            forbidden_details.append({
                "pair": [f["person_a"], f["person_b"]],
                "forbidden_labels": f.get("forbidden_labels", []),
                "violated": violated,
                "prediction_labels": [p.label for p in violations],
                "reason": f.get("reason", ""),
            })

        chapter_results.append({
            "chapter_id": cid,
            "title": gold["title"],
            "ledger_present": ledger_path.exists(),
            "prediction_relation_count": len(preds),
            "required": req_details,
            "optional": opt_details,
            "forbidden": forbidden_details,
            "duplicate_groups": chapter_dups,
        })

    required_recall = relation_summary["required_hit"] / relation_summary["required_total"] if relation_summary["required_total"] else 1.0
    optional_coverage = relation_summary["optional_hit"] / relation_summary["optional_total"] if relation_summary["optional_total"] else 1.0
    forbidden_avoidance = 1.0 - (relation_summary["forbidden_violations"] / relation_summary["forbidden_total"] if relation_summary["forbidden_total"] else 0.0)
    evidence_rate = evidence_valid / evidence_total if evidence_total else 0.0
    dedup_quality = 1.0 - duplicate_excess / len(all_pred_relations) if all_pred_relations else 1.0
    chapter_coverage = (12 - len(missing_ledgers)) / 12

    adjudicated_prediction_ids = matched_pred_ids | forbidden_pred_ids
    adjudicated_correct_ids = matched_pred_ids - forbidden_pred_ids
    adjudicated_precision = len(adjudicated_correct_ids) / len(adjudicated_prediction_ids) if adjudicated_prediction_ids else 1.0
    unscored_predictions = [
        {"chapter_id": p.chapter_id, "index": p.index, "a": p.person_a, "b": p.person_b, "label": p.label, "kind": p.kind}
        for p in all_pred_relations
        if (p.chapter_id, p.index) not in adjudicated_prediction_ids
    ]

    # Weighted score deliberately avoids treating unannotated-but-plausible open relations as false positives.
    components = {
        "cast_entity_f1": cast_metrics.get("entity_f1", 0.0),
        "identity_merge_accuracy": cast_metrics.get("identity_merge_accuracy", 0.0),
        "required_relation_recall": required_recall,
        "forbidden_relation_avoidance": forbidden_avoidance,
        "evidence_exact_hit_rate": evidence_rate,
        "relation_dedup_quality": dedup_quality,
        "chapter_output_coverage": chapter_coverage,
    }
    weights = {
        "cast_entity_f1": 0.15,
        "identity_merge_accuracy": 0.10,
        "required_relation_recall": 0.35,
        "forbidden_relation_avoidance": 0.15,
        "evidence_exact_hit_rate": 0.10,
        "relation_dedup_quality": 0.10,
        "chapter_output_coverage": 0.05,
    }
    score = sum(components[k] * weights[k] for k in weights)

    return {
        "schema_version": "1.0",
        "book": manifest["book"],
        "workspace": str(workspace),
        "gold_dir": str(gold_dir),
        "score": round(score * 100, 2),
        "score_components": {k: {"value": _pct(components[k]), "weight": weights[k]} for k in weights},
        "cast": {
            **cast_metrics,
            "entity_precision": _pct(cast_metrics.get("entity_precision", 0.0)),
            "entity_recall": _pct(cast_metrics.get("entity_recall", 0.0)),
            "entity_f1": _pct(cast_metrics.get("entity_f1", 0.0)),
            "identity_merge_accuracy": _pct(cast_metrics.get("identity_merge_accuracy", 0.0)),
        },
        "relations": {
            "required_total": relation_summary["required_total"],
            "required_hit": relation_summary["required_hit"],
            "required_recall": _pct(required_recall),
            "optional_total": relation_summary["optional_total"],
            "optional_hit": relation_summary["optional_hit"],
            "optional_coverage": _pct(optional_coverage),
            "forbidden_total": relation_summary["forbidden_total"],
            "forbidden_violations": relation_summary["forbidden_violations"],
            "forbidden_avoidance": _pct(forbidden_avoidance),
            "adjudicated_precision": _pct(adjudicated_precision),
            "unscored_prediction_count": len(unscored_predictions),
            "unresolved_relation_endpoints": unresolved_relation_endpoints,
        },
        "evidence": {
            "prediction_relations_with_evidence": evidence_total,
            "exact_quote_hits": evidence_valid,
            "exact_hit_rate": _pct(evidence_rate),
            "invalid_quotes": invalid_evidence,
        },
        "dedup": {
            "prediction_relation_count": len(all_pred_relations),
            "duplicate_group_count": duplicate_count,
            "duplicate_excess_edges": duplicate_excess,
            "quality": _pct(dedup_quality),
        },
        "coverage": {
            "expected_chapters": 12,
            "present_ledgers": 12 - len(missing_ledgers),
            "missing_ledgers": missing_ledgers,
            "chapter_coverage": _pct(chapter_coverage),
        },
        "chapters": chapter_results,
        "unscored_predictions": unscored_predictions,
        "scoring_note": "Gold is intentionally not exhaustive for every event-like/open relation. Therefore broad prediction precision is not reported. adjudicated_precision only uses predictions explicitly covered by required/optional/forbidden Gold.",
    }


def to_markdown(report: dict[str, Any]) -> str:
    c = report["cast"]
    r = report["relations"]
    e = report["evidence"]
    d = report["dedup"]
    cv = report["coverage"]
    lines = [
        f"# 《{report['book']}》Evaluator 报告",
        "",
        f"**总分：{report['score']:.2f} / 100**",
        "",
        "## 核心指标",
        "",
        "| 指标 | 结果 |",
        "|---|---:|",
        f"| 人物 Entity F1 | {c['entity_f1']:.2f}% |",
        f"| 同人合并准确率 | {c['identity_merge_accuracy']:.2f}% |",
        f"| Required 关系召回 | {r['required_hit']}/{r['required_total']} = {r['required_recall']:.2f}% |",
        f"| Optional 覆盖 | {r['optional_hit']}/{r['optional_total']} = {r['optional_coverage']:.2f}% |",
        f"| Forbidden 避免率 | {r['forbidden_avoidance']:.2f}% |",
        f"| 证据原文精确命中 | {e['exact_quote_hits']}/{e['prediction_relations_with_evidence']} = {e['exact_hit_rate']:.2f}% |",
        f"| 关系去重质量 | {d['quality']:.2f}% |",
        f"| 章节输出覆盖 | {cv['present_ledgers']}/{cv['expected_chapters']} = {cv['chapter_coverage']:.2f}% |",
        "",
    ]

    if c.get("duplicate_entity_groups"):
        lines += ["## 人物同一性问题", ""]
        for name, ids in c["duplicate_entity_groups"].items():
            lines.append(f"- `{name}` 被拆成 {len(ids)} 个节点：{', '.join(ids)}")
        for item in c.get("embedded_alias_conflicts", []):
            lines.append(f"- `{item['canonical_name']}` 的别名 `{item['alias']}` 混入另一人物 `{item['conflicts_with']}`")
        lines.append("")

    if cv.get("missing_ledgers"):
        lines += ["## 缺失章节", "", "- " + ", ".join(f"CH{x}" for x in cv["missing_ledgers"]), ""]

    misses = []
    violations = []
    dup_chapters = []
    for ch in report["chapters"]:
        for item in ch["required"]:
            if not item["hit"]:
                misses.append((ch["chapter_id"], item["gold"]))
        for item in ch["forbidden"]:
            if item["violated"]:
                violations.append((ch["chapter_id"], item))
        if ch["duplicate_groups"]:
            dup_chapters.append((ch["chapter_id"], ch["duplicate_groups"]))

    if misses:
        lines += ["## Required 漏检", ""]
        for cid, g in misses:
            lines.append(f"- CH{cid}: `{g['a']} — {g['b']}` / `{g['label']}` ({g['kind']})")
        lines.append("")

    if violations:
        lines += ["## Forbidden 违规", ""]
        for cid, item in violations:
            lines.append(f"- CH{cid}: `{item['pair'][0]} — {item['pair'][1]}` 预测为 {', '.join(item['prediction_labels'])}；{item['reason']}")
        lines.append("")

    if dup_chapters:
        lines += ["## 重复关系", ""]
        for cid, groups in dup_chapters:
            excess = sum(v - 1 for v in groups.values())
            lines.append(f"- CH{cid}: {len(groups)} 个重复语义组，额外重复边 {excess} 条")
        lines.append("")

    if e.get("invalid_quotes"):
        lines += ["## 证据原句未精确命中", ""]
        for item in e["invalid_quotes"]:
            q = item.get("quote", "").replace("\n", " ")
            if len(q) > 90:
                q = q[:87] + "..."
            lines.append(f"- CH{item['chapter_id']} #{item['relation_index']} `{item['a']} — {item['b']}` / `{item['label']}`：`{q}`")
        lines.append("")

    lines += [
        "## 说明",
        "",
        "Gold 并未穷举所有一次性行为/开放关系，因此不把未标注关系一律当成 false positive。",
        "`adjudicated_precision` 只统计 Gold 明确覆盖的 required / optional / forbidden 预测；未覆盖预测单独放在 JSON 报告的 `unscored_predictions` 中。",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate ZhiYing output against the Siddhartha Gold set.")
    parser.add_argument("--gold-dir", type=Path, default=HERE)
    parser.add_argument("--workspace", type=Path, default=None, help="Book workspace directory. Defaults to manifest book_id under ROOT/workspace.")
    parser.add_argument("--report-dir", type=Path, default=HERE / "reports")
    args = parser.parse_args()

    manifest = json.loads((args.gold_dir / "manifest.json").read_text(encoding="utf-8"))
    workspace = args.workspace or (ROOT / "workspace" / manifest["book_id"])
    report = evaluate(args.gold_dir, workspace)

    args.report_dir.mkdir(parents=True, exist_ok=True)
    json_path = args.report_dir / "latest.json"
    md_path = args.report_dir / "latest.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    md_path.write_text(to_markdown(report) + "\n", encoding="utf-8")

    print(json.dumps({
        "score": report["score"],
        "required_recall": report["relations"]["required_recall"],
        "forbidden_avoidance": report["relations"]["forbidden_avoidance"],
        "entity_f1": report["cast"]["entity_f1"],
        "evidence_exact_hit_rate": report["evidence"]["exact_hit_rate"],
        "dedup_quality": report["dedup"]["quality"],
        "missing_ledgers": report["coverage"]["missing_ledgers"],
        "report_json": str(json_path),
        "report_md": str(md_path),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
