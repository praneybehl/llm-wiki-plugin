#!/usr/bin/env python3
"""Retrieval-quality eval harness for the llm-wiki section search.

Shells out to ``skills/llm-wiki/scripts/wiki_search.py`` over the fixed
fixture corpus (``corpus/wiki``) and query set (``queries.json``), then
reports retrieval quality per mode:

  * ``page``    -- whole-page BM25 (``--granularity page --no-embed``)
  * ``section`` -- section-level BM25 (``--no-embed``)
  * ``hybrid``  -- RRF fusion of BM25 + embeddings; only evaluated when an
                   embedding endpoint is configured (env vars), detected by
                   running one search and reading the JSON ``mode`` field.

Metrics are computed over the non-negative queries, matching on page slug
(a section hit counts for its page): recall@5, recall@10, and MRR, all
against the raw result rows (no per-page dedup before slicing). Negative
queries are reported separately as a false-positive rate: the fraction
that return at least one result in the top 5.

The harness also verifies the ``--cache`` byte-identical invariant: three
fixed queries produce identical ``--json`` output with no cache, with a
cold cache, and with a warm cache.

Stdlib only. Run from anywhere; paths resolve relative to this file.

  python3 eval/retrieval/run_eval.py          # print the report
  python3 eval/retrieval/run_eval.py --gate   # + regression gate (CI)
"""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SCRIPT = REPO / "skills" / "llm-wiki" / "scripts" / "wiki_search.py"
CORPUS = HERE / "corpus" / "wiki"
QUERIES = HERE / "queries.json"

# Retrieval modes, expressed as flags for wiki_search.py.
MODES = {
    "page": {"granularity": "page", "no_embed": True},
    "section": {"granularity": "section", "no_embed": True},
    "hybrid": {"granularity": "section", "no_embed": False},
}

METRIC_COLUMNS = ["recall@5", "recall@10", "mrr", "fp_rate"]

# Three fixed queries for the cache byte-identical invariant check.
CACHE_QUERIES = [
    "attention mechanism",
    "quantization int8",
    "tensor parallelism",
]


def build_cmd(query, granularity, filters, no_embed, cache=None):
    cmd = [
        sys.executable, str(SCRIPT), query,
        "--wiki", str(CORPUS), "--json", "--top", "10",
    ]
    if granularity == "page":
        cmd += ["--granularity", "page"]
    if no_embed:
        cmd += ["--no-embed"]
    if cache is not None:
        cmd += ["--cache", str(cache)]
    if filters:
        if filters.get("type"):
            cmd += ["--type", filters["type"]]
        tag = filters.get("tag")
        if tag:
            for value in (tag if isinstance(tag, list) else [tag]):
                cmd += ["--tag", value]
    return cmd


def run_search_bytes(query, granularity="section", filters=None, no_embed=True, cache=None):
    """Run one search and return raw stdout bytes (the JSON line)."""
    cmd = build_cmd(query, granularity, filters, no_embed, cache)
    proc = subprocess.run(cmd, capture_output=True, cwd=str(REPO))  # bytes, no decode
    if proc.returncode != 0:
        detail = proc.stderr.decode("utf-8", "replace").strip()
        raise SystemExit(f"search failed for {query!r}: {detail}")
    return proc.stdout


def run_search(query, granularity="section", filters=None, no_embed=True, cache=None):
    """Run one search and return decoded stdout (for JSON parsing)."""
    return run_search_bytes(query, granularity, filters, no_embed, cache).decode("utf-8")


def result_slugs(stdout):
    return [row["slug"] for row in json.loads(stdout)["results"]]


def recall_at(slugs, expected, k):
    """Fraction of expected slugs present in the raw top-k result rows."""
    top = set(slugs[:k])
    return sum(1 for slug in expected if slug in top) / len(expected)


def reciprocal_rank(slugs, expected):
    """1/rank of the first raw result row whose slug is expected (0 if none)."""
    for rank, slug in enumerate(slugs, 1):
        if slug in expected:
            return 1.0 / rank
    return 0.0


def evaluate_mode(mode_opts, queries):
    recall5 = recall10 = mrr = 0.0
    positives = 0
    negatives = 0
    false_positives = 0
    for query in queries:
        slugs = result_slugs(run_search(
            query["query"], filters=query.get("filters"), **mode_opts,
        ))
        if query["kind"] == "negative":
            negatives += 1
            if slugs[:5]:
                false_positives += 1
            continue
        expected = query["expected"]
        positives += 1
        recall5 += recall_at(slugs, expected, 5)
        recall10 += recall_at(slugs, expected, 10)
        mrr += reciprocal_rank(slugs, expected)
    return {
        "recall@5": recall5 / positives if positives else 0.0,
        "recall@10": recall10 / positives if positives else 0.0,
        "mrr": mrr / positives if positives else 0.0,
        "fp_rate": false_positives / negatives if negatives else 0.0,
    }


def hybrid_available():
    """True when a configured embedding backend produces a hybrid search.

    Runs one section search without --no-embed and reads the JSON ``mode``.
    Returns False both when no endpoint is configured and when a configured
    endpoint fails (wiki_search falls back to lexical mode).
    """
    try:
        payload = json.loads(run_search("attention", no_embed=False))
    except SystemExit:
        return False
    return payload.get("mode") == "hybrid"


def cache_invariant():
    """--json stdout must be byte-identical with no cache, cold cache, warm cache.

    Three passes against one temp cache path: all queries uncached, all with a
    cold cache (the first invocation builds the file, later ones reuse it), all
    with a warm cache. Compares raw stdout bytes so the assertion is a genuine
    byte invariant, not a decoded-string comparison.
    """
    with tempfile.TemporaryDirectory() as tmp:
        cache = Path(tmp) / "idx.json"
        uncached = [run_search_bytes(q, no_embed=True, cache=None) for q in CACHE_QUERIES]
        cold = [run_search_bytes(q, no_embed=True, cache=cache) for q in CACHE_QUERIES]
        warm = [run_search_bytes(q, no_embed=True, cache=cache) for q in CACHE_QUERIES]
    return all(u == c == w for u, c, w in zip(uncached, cold, warm))


def print_table(rows):
    header = "| mode    | " + " | ".join(METRIC_COLUMNS) + " |"
    sep = "|" + "|".join(["---------"] + ["----------"] * len(METRIC_COLUMNS)) + "|"
    print(header)
    print(sep)
    for mode, metrics in rows.items():
        cells = " | ".join(f"{metrics[col]:.3f}" for col in METRIC_COLUMNS)
        print(f"| {mode:<7} | {cells} |")


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--gate", action="store_true",
        help="Exit 1 if section-mode recall@10 < page-mode recall@10.",
    )
    args = parser.parse_args()

    if not SCRIPT.exists():
        raise SystemExit(f"wiki_search.py not found at {SCRIPT}")
    queries = json.loads(QUERIES.read_text())

    modes = ["page", "section"]
    if hybrid_available():
        modes.append("hybrid")
    else:
        print("hybrid: skipped (no embedding endpoint configured)", file=sys.stderr)

    rows = {mode: evaluate_mode(MODES[mode], queries) for mode in modes}
    print_table(rows)

    exit_code = 0

    cache_ok = cache_invariant()
    print(f"\ncache: {'OK' if cache_ok else 'MISMATCH'}")
    if not cache_ok:
        exit_code = 1  # mismatch fails regardless of --gate

    if args.gate:
        if rows["section"]["recall@10"] < rows["page"]["recall@10"]:
            print(
                "gate: FAIL (section recall@10 < page recall@10)",
                file=sys.stderr,
            )
            exit_code = 1
        else:
            print("gate: PASS (section recall@10 >= page recall@10)")

    sys.exit(exit_code)


if __name__ == "__main__":
    main()
