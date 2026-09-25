"""Serve the evaluation viewer and allowlisted local artifacts without modifying them."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[2]
VIEWER = Path(__file__).resolve().parent


def read_json(path):
    """Read a JSON object, rejecting missing, malformed and non-object artifacts."""
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"JSON 必须为对象：{path.name}")
    return value


def contained(path, root):
    """Prevent symlinks from exposing files outside the artifact root."""
    return path.resolve().is_relative_to(root.resolve())


def report_runs(folder):
    """Discover actual evaluator reports, excluding telemetry-only JSON files."""
    runs = []
    for path in sorted((folder / "reports").rglob("*.json")):
        if not contained(path, folder):
            continue
        try:
            report = read_json(path)
            if isinstance(report.get("chapters"), list) and "score" in report:
                runs.append({"id": path.relative_to(folder).as_posix(),
                             "label": path.relative_to(folder).as_posix(),
                             "score": report["score"]})
        except (OSError, ValueError):
            continue
    return sorted(runs, key=lambda r: (r["id"] != "reports/latest.json", r["id"]))


def catalog(root=ROOT):
    """List evaluation datasets and real book workspaces independently."""
    datasets, warnings = [], []
    for path in sorted((root / "eval").glob("*/manifest.json")):
        if not contained(path, root / "eval"):
            continue
        try:
            manifest = read_json(path)
            runs = report_runs(path.parent)
            if runs:
                datasets.append({"id": "eval:" + path.parent.name,
                                 "label": manifest.get("book", path.parent.name) + " · 历史评测",
                                 "runs": runs})
        except (OSError, ValueError) as exc:
            warnings.append(f"{path.name}: {exc}")
    for path in sorted((root / "workspace").glob("*/meta.json")):
        if not contained(path, root / "workspace"):
            continue
        try:
            meta = read_json(path)
            datasets.append({"id": "book:" + path.parent.name,
                             "label": meta.get("title", path.parent.name) + " · 分析产物",
                             "runs": [{"id": "current", "label": "当前本地分析", "score": None}]})
        except (OSError, ValueError) as exc:
            warnings.append(f"{path.name}: {exc}")
    return {"datasets": datasets, "warnings": warnings}


def optional_json(path, boundary, warnings):
    """Represent unavailable artifacts explicitly instead of manufacturing empty success."""
    if not contained(path, boundary):
        warnings.append(f"拒绝读取越界文件：{path.name}")
        return None
    try:
        return read_json(path)
    except (OSError, ValueError):
        warnings.append(f"缺失或无法解析：{path.relative_to(boundary)}")
        return None


def report_bundle(root, dataset, run):
    """Join report decisions to current Gold without substituting another run's ledger."""
    folder = root / "eval" / dataset
    report = read_json(folder / run)
    manifest = read_json(folder / "manifest.json")
    warnings = ["历史评分口径，非当前产品质量门禁；旧评分未区分所有关系状态。",
                "当前 Gold 不是报告生成时的版本快照；未能对应的标注会明确提示。",
                "本视图未载入该运行的原始账本，不能据此推断默认图实际展示了哪些关系。"]
    chapters = []
    for item in report["chapters"]:
        cid = int(item["chapter_id"])
        gold = optional_json(folder / f"chapter_{cid:03d}.json", folder, warnings)
        chapters.append({"chapter_id": cid, "title": item.get("title", ""),
                         "evaluation": item, "gold": gold, "ledger": None, "source": None})
    return {"mode": "report", "title": report.get("book", manifest.get("book")),
            "path": f"eval/{dataset}/{run}", "report": report, "manifest": manifest,
            "cast": None, "chapters": chapters, "warnings": warnings}


def book_bundle(root, book):
    """Load raw local chapter, ledger and cast files, with no inferred quality scores."""
    folder = root / "workspace" / book
    warnings = ["原始分析产物，没有对应评测报告；未登记状态的旧关系不视为已确认。"]
    meta = read_json(folder / "meta.json")
    cast = optional_json(folder / "cast.json", folder, warnings)
    ids = set()
    for sub in ("chapters", "ledger"):
        for path in (folder / sub).glob("chapter_*.json"):
            suffix = path.stem.removeprefix("chapter_")
            if suffix.isdigit():
                ids.add(int(suffix))
    chapters = []
    for cid in sorted(ids):
        source = optional_json(folder / "chapters" / f"chapter_{cid:03d}.json", folder, warnings)
        ledger = optional_json(folder / "ledger" / f"chapter_{cid:03d}.json", folder, warnings)
        chapters.append({"chapter_id": cid, "title": (source or {}).get("title", f"第 {cid} 章"),
                         "source": source, "ledger": ledger, "gold": None, "evaluation": None})
    return {"mode": "analysis", "title": meta.get("title", book), "path": f"workspace/{book}",
            "meta": meta, "report": None, "manifest": None, "cast": cast,
            "chapters": chapters, "warnings": warnings}


def bundle(dataset, run, root=ROOT):
    """Accept only dataset/run IDs discovered by the catalog."""
    selected = next((d for d in catalog(root)["datasets"] if d["id"] == dataset), None)
    if not selected or not any(r["id"] == run for r in selected["runs"]):
        raise ValueError("找不到所选数据集或运行产物，请刷新列表")
    kind, name = dataset.split(":", 1)
    return report_bundle(root, name, run) if kind == "eval" else book_bundle(root, name)


class Handler(BaseHTTPRequestHandler):
    """Expose two JSON endpoints and a fixed static asset allowlist on localhost."""

    def do_GET(self):
        """Dispatch requests without permitting arbitrary filesystem access."""
        url = urlparse(self.path)
        try:
            if url.path == "/api/catalog":
                return self.send_json(catalog())
            if url.path == "/api/data":
                query = parse_qs(url.query)
                return self.send_json(bundle(query.get("dataset", [""])[0], query.get("run", [""])[0]))
            assets = {"/": ("index.html", "text/html"), "/index.html": ("index.html", "text/html"),
                      "/app.js": ("app.js", "text/javascript"), "/viewer.css": ("viewer.css", "text/css")}
            if url.path not in assets:
                return self.send_json({"error": "Not found"}, 404)
            name, mime = assets[url.path]
            self.send_bytes((VIEWER / name).read_bytes(), mime)
        except (OSError, ValueError, KeyError) as exc:
            self.send_json({"error": str(exc)}, 400)

    def send_json(self, value, status=200):
        """Serialize API objects as UTF-8 JSON."""
        self.send_bytes(json.dumps(value, ensure_ascii=False).encode(), "application/json", status)

    def send_bytes(self, data, mime, status=200):
        """Disable caching so refresh reflects actual files."""
        self.send_response(status)
        self.send_header("Content-Type", mime + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)


def main():
    """Start a read-only loopback server; no model invocation or report mutation."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Eval Studio: http://127.0.0.1:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
