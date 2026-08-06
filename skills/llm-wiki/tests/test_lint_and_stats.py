"""Lint and stats are the tools a hook or a CI job runs, so they owe an
exit code and an honest line count.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import wiki_lint  # noqa: E402


ONTOLOGY = SCRIPTS.parent / "assets" / "ontology.yaml.template"


class IndexShardCapTests(unittest.TestCase):
    """Index shards keep discovery bounded, so they are capped like any page."""

    def lint_index(self, line_count: int, trailing_newline: bool = True) -> dict:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            indexes = root / "indexes" / "nested"
            indexes.mkdir(parents=True)
            text = "\n".join(["entry"] * line_count)
            if trailing_newline:
                text += "\n"
            (indexes / "concepts.md").write_text(text, encoding="utf-8")
            return wiki_lint.lint([], 400, 800, [], False, 5, wiki_root=root)

    def test_exactly_the_cap_is_allowed_even_with_a_trailing_newline(self):
        self.assertEqual([], self.lint_index(wiki_lint.INDEX_SHARD_LINE_CAP)["oversized_indexes"])

    def test_one_line_over_the_cap_is_reported(self):
        over = wiki_lint.INDEX_SHARD_LINE_CAP + 1
        findings = self.lint_index(over)["oversized_indexes"]

        self.assertEqual(1, len(findings))
        self.assertEqual(over, findings[0]["lines"])
        self.assertEqual("indexes/nested/concepts.md", findings[0]["path"].replace("\\", "/"))

    def test_the_root_index_is_subject_to_the_same_limit(self):
        # Otherwise a wiki can silently outgrow the entry point whose whole job
        # is to keep discovery bounded.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "index.md").write_text(
                "\n".join(["entry"] * (wiki_lint.INDEX_SHARD_LINE_CAP + 1)) + "\n",
                encoding="utf-8")

            findings = wiki_lint.lint([], 400, 800, [], False, 5, wiki_root=root)

            self.assertEqual(
                [("index.md", wiki_lint.INDEX_SHARD_LINE_CAP + 1)],
                [(item["path"].replace("\\", "/"), item["lines"])
                 for item in findings["oversized_indexes"]],
            )


class IndexOrphanExemptionTests(unittest.TestCase):
    def test_an_index_page_is_never_an_orphan(self):
        # Index pages are navigational roots reached from index.md, and index.md
        # is excluded as a link source -- so every index shard looked orphaned.
        def page(slug: str, rel_path: str, page_type: str) -> dict:
            return {"slug": slug, "rel_path": rel_path, "meta": {"type": page_type},
                    "links": [], "line_count": 10, "malformed_fm": False, "body": ""}

        pages = [
            page("concepts-index", "indexes/concepts.md", "index"),
            page("lonely", "concepts/lonely.md", "concept"),
        ]

        findings = wiki_lint.lint(pages, 400, 800, [], False, 5)

        self.assertEqual(["lonely"], [item["slug"] for item in findings["orphans"]])


class LintExitCodeTests(unittest.TestCase):
    def test_the_cli_fails_for_an_oversized_index(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "indexes").mkdir()
            (root / "indexes" / "concepts.md").write_text(
                "\n".join(["entry"] * (wiki_lint.INDEX_SHARD_LINE_CAP + 1)) + "\n",
                encoding="utf-8")

            result = subprocess.run(
                [sys.executable, str(SCRIPTS / "wiki_lint.py"), str(root)],
                text=True, capture_output=True, encoding="utf-8", check=False)

            self.assertEqual(1, result.returncode)
            self.assertIn("Index over cap", result.stdout)

    def test_a_clean_wiki_still_exits_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "concepts").mkdir()
            (root / "concepts" / "a.md").write_text(
                "---\ntype: concept\ntitle: A\n---\n\n# A\n\n[[b]]\n", encoding="utf-8")
            (root / "concepts" / "b.md").write_text(
                "---\ntype: concept\ntitle: B\n---\n\n# B\n\n[[a]]\n", encoding="utf-8")

            result = subprocess.run(
                [sys.executable, str(SCRIPTS / "wiki_lint.py"), str(root),
                 "--required-fm", "type,title"],
                text=True, capture_output=True, encoding="utf-8", check=False)

            self.assertEqual(0, result.returncode, result.stdout)


class GraphLintTests(unittest.TestCase):
    def build(self, root: Path, source: str) -> None:
        (root / "graph").mkdir()
        (root / "graph" / "ontology.yaml").write_text(
            ONTOLOGY.read_text(encoding="utf-8"), encoding="utf-8")
        (root / "subject.md").write_text(
            "---\n"
            "type: concept\n"
            "title: Subject\n"
            "graph:\n"
            "  relationships:\n"
            "    - predicate: depends_on\n"
            "      object: concept:other\n"
            f"      source: {source}\n"
            "      evidence: deliberate test fixture\n"
            "      confidence: high\n"
            "      status: current\n"
            "---\n"
            "\n# Subject\n",
            encoding="utf-8")
        (root / "other.md").write_text(
            "---\ntype: concept\ntitle: Other\n---\n\n# Other\n", encoding="utf-8")

    def run_lint(self, root: Path) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(SCRIPTS / "wiki_graph_lint.py"), str(root)],
            text=True, capture_output=True, encoding="utf-8", check=False)

    def test_a_page_may_cite_itself_as_the_source_of_an_edge_it_declares(self):
        # SCHEMA calls the field a "source/derived page slug". Requiring a
        # `source`-type page left a derived page no correct way to record the
        # provenance of an edge it is itself the evidence for.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.build(root, "subject")

            result = self.run_lint(root)

            self.assertEqual(0, result.returncode, result.stdout)

    def test_a_source_naming_nothing_is_still_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.build(root, "no-such-page")

            result = self.run_lint(root)

            self.assertEqual(1, result.returncode)
            self.assertIn("source: does not match any source page", result.stdout)
            # Windows: the report carries em dashes, and a redirected stdout
            # defaults to cp1252 there.
            self.assertNotIn("UnicodeEncodeError", result.stderr)


class WikiStatsContractTests(unittest.TestCase):
    def test_a_trailing_newline_does_not_inflate_reported_line_counts(self):
        # `text.count("\n") + 1` counts a phantom last line on every file that
        # ends with a newline -- which is every well-formed file.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "index.md").write_text("# Index\n\nSecond line\n", encoding="utf-8")
            (root / "page.md").write_text(
                "---\ntype: concept\ntitle: Page\n---\n\n# Page\n", encoding="utf-8")

            result = subprocess.run(
                [sys.executable, str(SCRIPTS / "wiki_stats.py"), str(root)],
                text=True, capture_output=True, encoding="utf-8", check=False)

            self.assertEqual(0, result.returncode)
            self.assertRegex(result.stdout, r"Total lines:\s+6\b")
            self.assertRegex(result.stdout, r"index\.md:\s+3 lines\b")


if __name__ == "__main__":
    unittest.main()
