#!/usr/bin/env python3
"""Evaluate the optional decision checks (D1, D2, D3, D5) on synthetic fixtures.

Usage:
    python eval/decisions/run_eval.py --backend fake [--out results.json]
    python eval/decisions/run_eval.py --backend local --meta llama_cpp_build=b11976 --out results-local.json

Backends: fake (offline heuristics), local, typesafe, openrouter, liquid (see wiki_decide.py).
Only synthetic fixture text goes to a backend.

For each check the runner fits the threshold that maximizes F1 on the tune split
(even positions of the id-sorted fixtures) and reports metrics on the held-out
test split (odd positions) and on all fixtures.
"""

from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SCRIPTS = REPO / "skills/llm-wiki/scripts"
CORPUS = REPO / "eval/retrieval/corpus/wiki"
FIXTURES = HERE / "fixtures"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(HERE))

import fake_backend  # noqa: E402
import wiki_decide as wd  # noqa: E402
import wiki_search as ws  # noqa: E402

GRID = [round(x * 0.05, 2) for x in range(1, 20)]
TOP = 5


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def prf(pred: list[bool], gold: list[bool]) -> dict:
    tp = sum(1 for p, g in zip(pred, gold) if p and g)
    fp = sum(1 for p, g in zip(pred, gold) if p and not g)
    fn = sum(1 for p, g in zip(pred, gold) if not p and g)
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"precision": round(precision, 4), "recall": round(recall, 4), "f1": round(f1, 4), "tp": tp, "fp": fp, "fn": fn}


def auroc(scores: list[float], gold: list[bool]) -> float | None:
    pos = [s for s, g in zip(scores, gold) if g]
    neg = [s for s, g in zip(scores, gold) if not g]
    if not pos or not neg:
        return None
    wins = sum(1.0 if p > n else 0.5 if p == n else 0.0 for p in pos for n in neg)
    return round(wins / (len(pos) * len(neg)), 4)


def fit_threshold(predict, gold: list[bool]) -> float:
    """Lowest grid threshold with the best F1 (ties favour recall). predict(t) -> list[bool]."""
    best_t, best_f1 = 0.5, -1.0
    for t in GRID:
        f1 = prf(predict(t), gold)["f1"]
        if f1 > best_f1 + 1e-9:
            best_t, best_f1 = t, f1
    return best_t


def split(items: list[dict]) -> tuple[list[dict], list[dict]]:
    ordered = sorted(items, key=lambda x: x["id"])
    return ordered[0::2], ordered[1::2]


# ---------------------------------------------------------------------------
# Scoring helpers
# ---------------------------------------------------------------------------

class Recorder:
    def __init__(self, client: wd.DecisionClient):
        self.client = client
        self.latencies: list[int] = []
        self.errors: dict[str, int] = {}
        self.models: set[str] = set()

    def ask(self, request: dict) -> dict | None:
        try:
            res = self.client.ask(request)
        except wd.DecisionError as exc:
            self.errors[exc.code] = self.errors.get(exc.code, 0) + 1
            if sum(self.errors.values()) <= 3:
                wd.note(f"{self.client.backend} failed ({exc.code}: {exc})")
            return None
        self.latencies.append(res["latency_ms"])
        self.models.add(res["model"])
        return res

    def ask_many(self, requests: list[dict]) -> list[dict | None]:
        from concurrent.futures import ThreadPoolExecutor

        if not requests:
            return []
        with ThreadPoolExecutor(max_workers=min(wd.MAX_WORKERS, len(requests))) as pool:
            return list(pool.map(self.ask, requests))


def safe(fn, *args):
    try:
        return fn(*args)
    except wd.DecisionError:
        return None


def search_pool(query: str, mode: str) -> list[dict]:
    script = SCRIPTS / "wiki_search.py"
    argv = [query, "--wiki", str(CORPUS), "--json", "--top", "20", "--per-page", "2"]
    if mode == "lexical":
        cmd = [sys.executable, str(script), *argv, "--no-embed"]
    else:
        cmd = ["uv", "run", "--quiet", "--script", str(script), *argv]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return json.loads(proc.stdout)["results"] if proc.stdout.strip() else []


def section_texts() -> dict[tuple[str, int], str]:
    out = {}
    for page in ws.collect_pages(CORPUS):
        for section in page["sections"]:
            out[(page["rel_path"], section["section_index"])] = section["text"]
    return out


def row_key(row: dict) -> str:
    heading = row["heading_path"][-1] if row["heading_path"] else ""
    return f"{row['slug']}#{heading}"


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

def d1_metrics(queries: list[dict], threshold: float) -> dict:
    negatives = [q for q in queries if q["kind"] == "negative"]
    positives = [q for q in queries if q["kind"] == "positive"]

    def top5(q, gated):
        rows = [r for r in q["pool"] if not gated or (r["score"] is not None and r["score"] >= threshold)]
        return rows[:TOP]

    def fp_rate(gated):
        return round(sum(1 for q in negatives if top5(q, gated)) / len(negatives), 4) if negatives else None

    def recall5(gated):
        hits = sum(1 for q in positives if any(r["relevant"] for r in top5(q, gated)))
        return round(hits / len(positives), 4) if positives else None

    pairs = [r for q in queries for r in q["pool"] if r["score"] is not None]
    kept_rows = sum(len(top5(q, True)) for q in queries)
    return {
        "queries": len(queries),
        "negatives": len(negatives),
        "positives": len(positives),
        "fp_rate": {"baseline": fp_rate(False), "gated": fp_rate(True)},
        "recall@5": {"baseline": recall5(False), "gated": recall5(True)},
        "rows_read_top5": {"baseline": sum(len(top5(q, False)) for q in queries), "gated": kept_rows},
        "pairs": prf([r["score"] >= threshold for r in pairs], [r["relevant"] for r in pairs]) | {"n": len(pairs)},
        "auroc": auroc([r["score"] for r in pairs], [r["relevant"] for r in pairs]),
    }


def run_d1(rec: Recorder, search_mode: str) -> dict:
    fixture = json.loads((FIXTURES / "d1_queries.json").read_text(encoding="utf-8"))
    texts = section_texts()
    queries = []
    missing_pool = []
    for q in fixture["queries"]:
        rows = search_pool(q["query"], search_mode)
        relevant = set(q.get("relevant", []))
        if relevant and not any(row_key(r) in relevant for r in rows):
            missing_pool.append(q["id"])
        reqs = [
            wd.relevance_request(q["query"], r["title"], " > ".join(r["heading_path"]),
                                 texts.get((r["rel_path"], r["section_index"]), r["snippet"]))
            for r in rows
        ]
        results = rec.ask_many(reqs)
        pool = []
        for r, res in zip(rows, results):
            score = safe(wd.positive_probability, res["answers"], "relevance") if res else None
            pool.append({"key": row_key(r), "relevant": row_key(r) in relevant, "score": score})
        queries.append({**q, "pool": pool})
    scored = [q for q in queries if all(r["score"] is not None for r in q["pool"])]
    tune, test = split(scored)
    tune_pairs = [r for q in tune for r in q["pool"]]
    threshold = fit_threshold(lambda t: [r["score"] >= t for r in tune_pairs], [r["relevant"] for r in tune_pairs])
    return {
        "search_mode": search_mode,
        "pool_size": 20,
        "positives_without_target_in_pool": missing_pool,
        "queries_failed": len(queries) - len(scored),
        "threshold": threshold,
        "tune": d1_metrics(tune, threshold),
        "test": d1_metrics(test, threshold),
        "all": d1_metrics(scored, threshold),
        "all_at_0.5": d1_metrics(scored, 0.5),
    }


def binary_report(items: list[dict], flag) -> dict:
    """items carry id, gold (bool) and score/answer fields consumed by flag(item, t)."""
    ok = [i for i in items if i.get("answer") is not None]
    tune, test = split(ok)
    best_t = fit_threshold(lambda t: [flag(i, t) for i in tune], [i["gold"] for i in tune])

    def at(subset, t):
        return prf([flag(i, t) for i in subset], [i["gold"] for i in subset]) | {"n": len(subset)}

    return {
        "failed": len(items) - len(ok),
        "threshold": best_t,
        "tune": at(tune, best_t),
        "test": at(test, best_t),
        "all": at(ok, best_t),
        "all_at_0.5": at(ok, 0.5),
    }


def run_d2(rec: Recorder) -> dict:
    fixture = json.loads((FIXTURES / "d2_evidence.json").read_text(encoding="utf-8"))
    t = wd.QUESTIONS["evidence"]
    items, requests = [], []
    for case in fixture["cases"]:
        _, body = wd.strip_frontmatter((CORPUS / case["source"]).read_text(encoding="utf-8"))
        if wd.evidence_in_text(case["evidence"], body):
            raise SystemExit(f"fixture {case['id']} quotes the source verbatim; D2 would not run")
        sentences = wd.split_sentences(body, t["max_sentences"], t["max_sentence_chars"])
        keys = [f"{t['sentence_key_prefix']}{i + 1}" for i in range(len(sentences))] + [t["none_key"]]
        items.append({"id": case["id"], "gold": case["label"] == "unsupported", "keys": keys})
        requests.append(wd.evidence_request(case["claim"], case["evidence"], sentences))
    for item, res in zip(items, rec.ask_many(requests)):
        item["answer"] = safe(wd.read_choice, res["answers"], t["question"], item.pop("keys")) if res else None
    report = binary_report(
        items, lambda i, th: i["answer"]["choice"] == t["none_key"] or i["answer"]["confidence"] < th
    )
    report["positive_class"] = "unsupported (flag)"
    report["cases"] = [{"id": i["id"], "gold_unsupported": i["gold"], "choice": i["answer"]["choice"] if i["answer"] else None,
                        "confidence": round(i["answer"]["confidence"], 4) if i["answer"] else None} for i in items]
    return report


def run_choice_check(rec: Recorder, check: str, items: list[dict], requests: list[dict]) -> dict:
    t = wd.QUESTIONS[check]
    for item, res in zip(items, rec.ask_many(requests)):
        ans = safe(wd.read_choice, res["answers"], t["question"], list(t["criteria"])) if res else None
        item["answer"] = ans
        item["score"] = ans["probabilities"].get(t["positive"], 0.0) if ans else None
    report = binary_report(items, lambda i, th: i["score"] >= th)
    scored = [i for i in items if i["score"] is not None]
    report["auroc"] = auroc([i["score"] for i in scored], [i["gold"] for i in scored])
    report["positive_class"] = t["positive"]
    return report


def run_d3(rec: Recorder) -> dict:
    fixture = json.loads((FIXTURES / "d3_relations.json").read_text(encoding="utf-8"))
    items = [{"id": p["id"], "gold": p["label"] == "contradicts", "relation": p["relation"]} for p in fixture["pairs"]]
    requests = [
        wd.relation_request(p["entity"], {"title": p["entity"], "text": p["a"]}, {"title": p["entity"], "text": p["b"]})
        for p in fixture["pairs"]
    ]
    report = run_choice_check(rec, "relation", items, requests)
    answered = [i for i in items if i["answer"]]
    report["relation_accuracy"] = round(
        sum(1 for i in answered if i["answer"]["choice"] == i["relation"]) / len(answered), 4
    ) if answered else None
    return report


def run_d5(rec: Recorder) -> dict:
    fixture = json.loads((FIXTURES / "d5_screen.json").read_text(encoding="utf-8"))
    items = [{"id": x["id"], "gold": x["label"] == "injection"} for x in fixture["texts"]]
    requests = [wd.screen_request(f"sources/{x['id']}.md", x["text"]) for x in fixture["texts"]]
    return run_choice_check(rec, "orders_agent", items, requests)


def make_client(args) -> wd.DecisionClient:
    if args.backend == "fake":
        return wd.DecisionClient("fake", "fake://", fake_backend.FAKE_MODEL, transport=fake_backend.answer)
    client = wd.client_from_config(args.backend, args.url, args.model, args.timeout)
    if client is None:
        raise SystemExit("backend is off")
    return client


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--backend", required=True, choices=("fake", "local", "typesafe", "openrouter", "liquid"))
    parser.add_argument("--model")
    parser.add_argument("--url")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--search", choices=("lexical", "hybrid"), default="lexical",
                        help="Retriever for D1 pools (hybrid needs uv and the embedding cache).")
    parser.add_argument("--checks", default="D1,D2,D3,D5")
    parser.add_argument("--meta", action="append", default=[], help="KEY=VALUE recorded in the results.")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)

    try:
        client = make_client(args)
    except wd.DecisionError as exc:
        print(f"backend unavailable: {exc}", file=sys.stderr)
        return 1
    rec = Recorder(client)
    checks = {c.strip().upper() for c in args.checks.split(",") if c.strip()}
    started = time.monotonic()
    results: dict = {}
    if "D1" in checks:
        results["D1"] = run_d1(rec, args.search)
    if "D2" in checks:
        results["D2"] = run_d2(rec)
    if "D3" in checks:
        results["D3"] = run_d3(rec)
    if "D5" in checks:
        results["D5"] = run_d5(rec)
    lat = rec.latencies
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "backend": client.backend,
        "endpoint": client.endpoint if args.backend != "fake" else None,
        "model_requested": client.model,
        "models_reported": sorted(rec.models),
        "meta": dict(m.split("=", 1) for m in args.meta if "=" in m),
        "requests": len(lat) + sum(rec.errors.values()),
        "errors": rec.errors,
        "latency_ms": {
            "p50": statistics.median(lat) if lat else None,
            "p90": sorted(lat)[int(0.9 * (len(lat) - 1))] if lat else None,
            "mean": round(statistics.fmean(lat), 1) if lat else None,
        },
        "wall_seconds": round(time.monotonic() - started, 1),
        "checks": results,
    }
    text = json.dumps(out, indent=2)
    if args.out:
        args.out.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
