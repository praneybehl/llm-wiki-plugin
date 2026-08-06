"""Several curated pages may legitimately derive from one source document.

The rule is therefore not "one result per source". It is narrower: a `source`
page is worth showing only when nothing derived from the same source matched.
Collapsing further would hide distinct concepts that happen to share a
citation, which is the common case in a wiki built from one document set.

Page and section granularity implement the same rule differently, and both are
tested here: a page-level score can be transferred to the page that replaces
it, while a section's fused score cannot be handed to a different page's
section, so section granularity only suppresses.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import wiki_search  # noqa: E402


def page(slug: str, page_type: str, source: str = "docs/shared.md") -> dict:
    return {"slug": slug, "meta": {"type": page_type, "sources": [source]}}


class ProvenanceKeyTests(unittest.TestCase):
    def test_pages_citing_one_document_share_a_key(self):
        self.assertEqual(
            wiki_search.primary_provenance(page("a", "concept")),
            wiki_search.primary_provenance(page("b", "concept")),
        )

    def test_the_key_is_separator_and_case_insensitive(self):
        self.assertEqual(
            wiki_search.primary_provenance(page("a", "concept", "Docs\\Shared.md")),
            wiki_search.primary_provenance(page("b", "concept", "docs/shared.md")),
        )

    def test_a_page_citing_nothing_is_its_own_group(self):
        uncited = {"slug": "lonely", "meta": {"type": "concept"}}

        self.assertEqual("page:lonely", wiki_search.primary_provenance(uncited))


class PageGranularityCollapseTests(unittest.TestCase):
    def test_distinct_concepts_with_same_source_are_preserved(self):
        scored = [(10.0, page("concept-a", "concept")), (9.0, page("concept-b", "concept"))]

        result = wiki_search.collapse_by_provenance(scored, "concept")

        self.assertEqual(["concept-a", "concept-b"], [p["slug"] for _, p in result])

    def test_source_variant_is_hidden_when_derived_page_exists(self):
        scored = [(10.0, page("raw-source", "source")), (8.0, page("derived", "concept"))]

        result = wiki_search.collapse_by_provenance(scored, "concept")

        self.assertEqual(["derived"], [p["slug"] for _, p in result])
        self.assertEqual(10.0, result[0][0])

    def test_source_score_is_transferred_without_collapsing_derived_pages(self):
        # Only the hidden source's score moves, and only to one representative.
        scored = [
            (100.0, page("raw-source", "source")),
            (2.0, page("concept-a", "concept")),
            (1.0, page("concept-b", "concept")),
        ]

        result = wiki_search.collapse_by_provenance(scored, "concept")

        self.assertEqual([(100.0, "concept-a"), (1.0, "concept-b")],
                         [(score, p["slug"]) for score, p in result])

    def test_preferred_type_becomes_provenance_representative(self):
        scored = [
            (20.0, page("raw-source", "source")),
            (8.0, page("api-page", "api")),
            (3.0, page("concept-page", "concept")),
        ]

        result = wiki_search.collapse_by_provenance(scored, "concept")

        self.assertEqual([(20.0, "concept-page"), (8.0, "api-page")],
                         [(score, p["slug"]) for score, p in result])

    def test_best_source_is_kept_when_group_has_only_sources(self):
        scored = [(7.0, page("source-a", "source")), (9.0, page("source-b", "source"))]

        result = wiki_search.collapse_by_provenance(scored, None)

        self.assertEqual(["source-b"], [p["slug"] for _, p in result])

    def test_preference_does_not_copy_score_between_derived_pages(self):
        # With no source in the group there is nothing to transfer; preference
        # reorders, it does not invent a score.
        scored = [(9.0, page("api-page", "api")), (1.0, page("concept-page", "concept"))]

        result = wiki_search.collapse_by_provenance(scored, "concept")

        self.assertEqual([(9.0, "api-page"), (1.0, "concept-page")],
                         [(score, p["slug"]) for score, p in result])

    def test_lower_scoring_source_does_not_inflate_preferred_page(self):
        scored = [
            (9.0, page("api-page", "api")),
            (2.0, page("raw-source", "source")),
            (1.0, page("concept-page", "concept")),
        ]

        result = wiki_search.collapse_by_provenance(scored, "concept")

        self.assertEqual([(9.0, "api-page"), (2.0, "concept-page")],
                         [(score, p["slug"]) for score, p in result])


class SectionGranularitySuppressionTests(unittest.TestCase):
    @staticmethod
    def located(*pages: dict) -> list[dict]:
        return [{**p, "rel_path": f"{p['slug']}.md"} for p in pages]

    def test_a_lone_source_page_is_kept(self):
        # Nothing derived from this document matched, so the source page is the
        # only evidence there is.
        matched = self.located(page("raw", "source"))

        self.assertEqual(set(), wiki_search.suppressed_source_pages(matched))

    def test_a_source_page_is_suppressed_once_something_derived_matched(self):
        matched = self.located(page("raw", "source"), page("derived", "concept"))

        self.assertEqual({"raw.md"}, wiki_search.suppressed_source_pages(matched))

    def test_suppression_does_not_cross_provenance_groups(self):
        pages = [
            {**page("raw-x", "source", "docs/x.md"), "rel_path": "sources/raw-x.md"},
            {**page("derived-x", "concept", "docs/x.md"), "rel_path": "concepts/derived-x.md"},
            {**page("raw-y", "source", "docs/y.md"), "rel_path": "sources/raw-y.md"},
        ]

        self.assertEqual({"sources/raw-x.md"}, wiki_search.suppressed_source_pages(pages))


class DedupCliTests(unittest.TestCase):
    def build_wiki(self, root: Path) -> None:
        for kind, slug, body in (
            ("sources", "raw-alpha", "Gamma delta epsilon."),
            ("concepts", "alpha-idea", "Gamma delta epsilon."),
        ):
            directory = root / kind
            directory.mkdir(parents=True, exist_ok=True)
            page_type = "source" if kind == "sources" else "concept"
            (directory / f"{slug}.md").write_text(
                f"---\ntype: {page_type}\ntitle: {slug}\nsources: [docs/alpha.md]\n---\n\n"
                f"# {slug}\n\n{body}\n",
                encoding="utf-8",
            )

    def search(self, root: Path, *extra: str) -> list[dict]:
        result = subprocess.run(
            [sys.executable, str(SCRIPTS / "wiki_search.py"), "gamma", *extra,
             "--wiki", str(root), "--json", "--no-embed"],
            capture_output=True, text=True, encoding="utf-8",
        )
        self.assertEqual(0, result.returncode, result.stderr)
        return json.loads(result.stdout)["results"]

    def test_the_source_page_is_hidden_behind_its_derived_concept(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            self.build_wiki(root)

            self.assertEqual({"raw-alpha", "alpha-idea"},
                             {row["slug"] for row in self.search(root)})
            self.assertEqual({"alpha-idea"},
                             {row["slug"] for row in self.search(root, "--dedup-provenance")})

    def test_page_granularity_applies_the_same_rule(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            self.build_wiki(root)

            rows = self.search(root, "--dedup-provenance", "--granularity", "page")

            self.assertEqual(["alpha-idea"], [row["slug"] for row in rows])


if __name__ == "__main__":
    unittest.main()
