#!/usr/bin/env python3
"""Regression tests for wikilink resolution.

Stdlib only, no test framework — run it directly:

    python3 skills/llm-wiki/scripts/test_link_resolution.py

Exits 0 on success, 1 on any failure.

Why this file exists
--------------------
`wiki_lint.py`, `wiki_graph_extract.py`, and `wiki_search.py` all compared raw
wikilink text against page slugs, where a slug is the bare filename stem. Every
path-qualified link — `[[entities/kalman-filter]]`, a very common form in real
wikis — therefore matched nothing. The linter reported them all as broken, the
graph extractor silently emitted no `mentions` edge for them, and `--backlinks`
missed them. In one wiki of 55 pages that was 142 false "broken link" reports
out of 153, plus 15 pages misreported as orphans.

The fix normalizes before comparing. The subtle part, and the reason for the
guard cases below, is that a directory prefix must be treated as a CONSTRAINT
rather than stripped: naively reducing to the stem would make `[[raw/foo]]`
resolve to `sources/foo.md`. That collision is not hypothetical — source pages
are conventionally named after the raw file they summarize, so stem-stripping
turns a genuinely broken out-of-tree link into a false pass.
"""

import contextlib
import io
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))

import wiki_graph_extract  # noqa: E402
import wiki_lint  # noqa: E402
import wiki_search  # noqa: E402
import wiki_stats  # noqa: E402


# A wiki containing BOTH sources/<stem>.md and (out of tree) raw/<stem>.md,
# which is the collision the path constraint exists to handle.
BY_PATH = {
    "sources/2024-01-15-field-notes": "2024-01-15-field-notes",
    "entities/kalman-filter": "kalman-filter",
    "concepts/battery-runtime": "battery-runtime",
}
BY_SLUG = {
    "2024-01-15-field-notes",
    "kalman-filter",
    "battery-runtime",
    "shannon-entropy",
}

RESOLVE_CASES = [
    # (link, expected, why)
    ("entities/kalman-filter", "kalman-filter", "path-qualified, path exists"),
    ("shannon-entropy", "shannon-entropy", "bare stem, page exists"),
    ("entities/kalman-filter#History", "kalman-filter", "heading anchor stripped"),
    ("entities/kalman-filter.md", "kalman-filter", "explicit .md stripped"),
    ("entities/kalman-filter|Kalman", "kalman-filter", "display alias stripped"),
    ("  entities/kalman-filter  ", "kalman-filter", "surrounding whitespace"),
    ("/entities/kalman-filter/", "kalman-filter", "stray leading/trailing slashes"),
    ("Entities/Kalman-Filter", None,
     "matching is case-SENSITIVE, symmetric with bare-slug matching"),
    # --- guards: these must NOT resolve ---
    ("raw/2024-01-15-field-notes", None,
     "GUARD: out-of-tree path must not bind to the same-stem sources page"),
    ("personas/kalman-filter", None,
     "GUARD: wrong directory must not bind to entities/kalman-filter"),
    ("nonexistent-page", None, "unknown bare stem"),
    ("", None, "empty link"),
    ("#anchor-only", None, "anchor with no page"),
]

STEM_CASES = [
    ("entities/kalman-filter", "kalman-filter", "prefix dropped"),
    ("kalman-filter", "kalman-filter", "bare stem unchanged"),
    ("entities/kalman-filter#History", "kalman-filter", "anchor dropped"),
    ("raw/whatever", "whatever", "out-of-tree link still counted by stem"),
]

KEY_CASES = [
    ("entities/kalman-filter", "kalman-filter", "resolved path collapses to its slug"),
    ("missing-page", "missing-page", "unresolved bare link remains reportable"),
    ("raw/2024-01-15-field-notes", "raw/2024-01-15-field-notes",
     "unresolved qualified link keeps its path constraint"),
]


def check(label, got, expected, why, failures):
    ok = got == expected
    if not ok:
        failures.append(f"{label}: {why} -> got {got!r}, expected {expected!r}")
    print(f"  {'PASS' if ok else 'FAIL'}  {label:<7} {str(got):<22} {why}")
    return ok


def main():
    failures = []

    resolvers = [
        ("lint", wiki_lint.resolve_link),
        ("graph", wiki_graph_extract.resolve_link_slug),
        ("search", wiki_search.resolve_link),
    ]
    for label, fn in resolvers:
        print(f"{label}: path-constrained resolution")
        for link, expected, why in RESOLVE_CASES:
            check(label, fn(link, BY_PATH, BY_SLUG), expected,
                  f"[[{link}]] — {why}", failures)
        print()

    print("search: report keys preserve unresolved links")
    for link, expected, why in KEY_CASES:
        check("key", wiki_search.link_key(link, BY_PATH, BY_SLUG), expected,
              f"[[{link}]] — {why}", failures)

    pages = [
        {"slug": "kalman-filter", "rel_path": "entities/kalman-filter.md",
         "meta": {"title": "Kalman Filter"}, "links": []},
        {"slug": "source", "rel_path": "concepts/source.md",
         "meta": {"title": "Source"},
         "links": ["entities/kalman-filter", "missing-page"]},
    ]
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        wiki_search.cmd_top_linked(SimpleNamespace(top_linked=10), pages)
    check("top", "missing-page  (missing-page)  [BROKEN LINK]" in output.getvalue(),
          True, "--top-linked retains broken-link reports", failures)

    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        wiki_search.cmd_backlinks(SimpleNamespace(backlinks="missing-page"), pages)
    check("backlink", "Source  (concepts/source.md)" in output.getvalue(), True,
          "--backlinks can inspect a missing target", failures)
    print()

    # wiki_stats counts popularity and deliberately does NOT verify resolution,
    # so it reduces to the stem. Pin that documented difference so nobody
    # "fixes" it into a correctness check by accident.
    print("stats: stem-only counting (resolution deliberately NOT verified)")
    for link, expected, why in STEM_CASES:
        check("stats", wiki_stats.link_stem(link), expected,
              f"[[{link}]] — {why}", failures)

    total = len(RESOLVE_CASES) * len(resolvers) + len(KEY_CASES) + len(STEM_CASES) + 2
    print(f"\n{total - len(failures)}/{total} passed")
    if failures:
        print("\nFAILURES:")
        for f in failures:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
