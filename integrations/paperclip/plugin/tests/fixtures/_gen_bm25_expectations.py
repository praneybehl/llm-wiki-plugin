#!/usr/bin/env python3
"""
Capture BM25 ranks + filter behaviors from the canonical Python reference at
skills/llm-wiki/scripts/wiki_search.py and snapshot them as
tests/fixtures/bm25-expectations.json.

Run from the repo root after editing fixture pages or query coverage:

    python3 integrations/paperclip/plugin/tests/fixtures/_gen_bm25_expectations.py
"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
REPO = HERE.parents[5]
WIKI = HERE.parent / "wiki"
SCRIPT = REPO / "skills/llm-wiki/scripts/wiki_search.py"
OUT = HERE.parent / "bm25-expectations.json"

QUERIES = [
    "transformer attention",
    "scaling laws",
    "language model",
    "GPT",
    "Vaswani",
    "few-shot learning",
    "Chinchilla",
    "encoder decoder",
    "softmax",
    "neural network",
]

FILTER_CASES = [
    {"label": "type=concept transformer attention",
     "args": ["transformer attention", "--top", "10", "--type", "concept"]},
    {"label": "type=source scaling",
     "args": ["scaling", "--top", "10", "--type", "source"]},
    {"label": "tag=safety scaling",
     "args": ["scaling", "--top", "10", "--tag", "safety"]},
    {"label": "tag=transformer attention",
     "args": ["attention", "--top", "10", "--tag", "transformer"]},
    {"label": "since=2026-02-01 transformer",
     "args": ["transformer", "--top", "10", "--since", "2026-02-01"]},
    {"label": "since=2026-03-01 transformer",
     "args": ["transformer", "--top", "10", "--since", "2026-03-01"]},
]

BACKLINK_TARGETS = ["transformer", "attention-paper", "scaling-laws", "gpt-3"]


def parse_search_paths(stdout: str) -> list[str]:
    slugs = []
    for line in stdout.splitlines():
        line = line.strip()
        if line.endswith(".md") and "/" in line:
            slugs.append(line.rsplit("/", 1)[1].removesuffix(".md"))
    return slugs


def parse_backlinks_pairs(stdout: str) -> list[tuple[str, str]]:
    """Returns [(rel_path, slug)] in Python output order."""
    out = []
    for line in stdout.splitlines():
        line = line.strip()
        if line.startswith("- ") and ".md)" in line:
            inner = line[line.find("(") + 1 : line.rfind(")")]
            slug = inner.rsplit("/", 1)[1].removesuffix(".md")
            out.append((inner, slug))
    return out


def parse_top_linked(stdout: str) -> list[dict]:
    rows = []
    for line in stdout.splitlines():
        s = line.strip()
        if not s or "(" not in s or ")" not in s:
            continue
        try:
            count = int(s.split()[0])
        except ValueError:
            continue
        slug = s[s.rfind("(") + 1 : s.rfind(")")]
        rows.append({"slug": slug, "count": count, "broken": "[BROKEN LINK]" in s})
    return rows


def list_pages_sorted() -> list[tuple[str, str, list[str]]]:
    """
    Returns [(rel_path, slug, links)] sorted by rel_path. Used to recompute
    backlinks + top-linked deterministically — Python's Path.rglob returns
    filesystem-iteration order which is non-portable across OSes/filesystems.
    Both implementations agree on alphabetical rel_path order.
    """
    import re
    WIKILINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]")
    FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
    SKIP_FILES = {"SCHEMA.md", "index.md", "log.md"}
    SKIP_DIRS = {"indexes", "graph", ".wiki-cache"}

    pages = []
    paths = sorted(WIKI.rglob("*.md"), key=lambda p: str(p.relative_to(WIKI)))
    for md in paths:
        rel = md.relative_to(WIKI)
        if rel.parts[0] in SKIP_FILES or rel.parts[0] in SKIP_DIRS:
            continue
        if rel.name.startswith("."):
            continue
        text = md.read_text(encoding="utf-8")
        m = FRONTMATTER_RE.match(text)
        body = text[m.end():] if m else text
        links = [x.group(1).strip() for x in WIKILINK_RE.finditer(body)]
        pages.append((str(rel), md.stem, links))
    return pages


def compute_backlinks(target: str, pages) -> list[str]:
    return [slug for (_rel, slug, links) in pages if target in links]


def compute_top_linked(pages, top_n: int) -> list[dict]:
    from collections import Counter
    counts: Counter[str] = Counter()
    for _rel, _slug, links in pages:
        for link in links:
            counts[link] += 1
    slugs = {slug for (_rel, slug, _links) in pages}
    rows = [
        {"slug": s, "count": c, "broken": s not in slugs}
        for s, c in counts.most_common(top_n)
    ]
    return rows


def run(args: list[str]) -> str:
    proc = subprocess.run(
        ["python3", str(SCRIPT), *args, "--wiki", str(WIKI)],
        capture_output=True, text=True, check=False,
    )
    return proc.stdout


def main():
    snapshot = {"queries": [], "sections": [], "filters": [], "backlinks": [], "topLinked": []}

    for q in QUERIES:
        slugs = parse_search_paths(run([q, "--top", "10", "--granularity", "page"]))
        snapshot["queries"].append({"query": q, "slugs": slugs})
        print(f"  query  {q!r:36s} -> {slugs}", file=sys.stderr)
        payload = json.loads(run([
            q, "--top", "10", "--granularity", "section", "--no-embed", "--json",
        ]))
        section_rows = [
            {"slug": row["slug"], "headingPath": row["heading_path"]}
            for row in payload["results"]
        ]
        snapshot["sections"].append({"query": q, "results": section_rows})
        print(f"  section {q!r:34s} -> {section_rows}", file=sys.stderr)

    for case in FILTER_CASES:
        slugs = parse_search_paths(run([*case["args"], "--granularity", "page"]))
        snapshot["filters"].append({
            "label": case["label"], "args": case["args"], "slugs": slugs,
        })
        print(f"  filter {case['label']!r:36s} -> {slugs}", file=sys.stderr)

    # Backlinks and top-linked depend on filesystem iteration order, which
    # Python's Path.rglob leaves unspecified. Recompute over a relPath-sorted
    # page list so the snapshot is portable; the algorithm is identical.
    sorted_pages = list_pages_sorted()
    for target in BACKLINK_TARGETS:
        slugs = compute_backlinks(target, sorted_pages)
        snapshot["backlinks"].append({"target": target, "slugs": slugs})
        print(f"  back   <-[[{target}]]: {slugs}", file=sys.stderr)

    snapshot["topLinked"] = compute_top_linked(sorted_pages, 10)
    print(f"  topLinked -> {snapshot['topLinked']}", file=sys.stderr)

    OUT.write_text(json.dumps(snapshot, indent=2) + "\n")
    print(f"\nWrote {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
