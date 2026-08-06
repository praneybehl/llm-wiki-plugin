"""A `sources:` entry must produce an edge whatever kind of thing it cites.

Entries used to be resolved against wiki slugs alone, and whatever missed was
dropped. In a wiki whose pages cite repo-relative paths or URLs that empties
the entire provenance layer while every tool reports success: the extractor
prints a summary line, lint is clean, and `sourced_from` has zero edges.

These tests therefore pin the resolution rules, not edge counts on any
particular corpus.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import wiki_graph_extract  # noqa: E402
import wiki_graph_lint  # noqa: E402


ONTOLOGY = SCRIPTS.parent / "assets" / "ontology.yaml.template"


def write_page(root: Path, name: str, page_type: str, sources: list[str],
               body: str = "Body.") -> None:
    listed = "".join(f"  - {entry}\n" for entry in sources)
    (root / name).write_text(
        f"---\ntype: {page_type}\ntitle: {name}\nsources:\n{listed}---\n\n# {name}\n\n{body}\n",
        encoding="utf-8",
    )


class DocumentNodeTests(unittest.TestCase):
    def build(self, root: Path):
        pages = wiki_graph_extract.collect_pages(root)
        ontology = wiki_graph_extract.load_ontology(ONTOLOGY)
        nodes, slug_to_id, _aliases = wiki_graph_extract.build_nodes(pages, ontology)
        documents, document_ids = wiki_graph_extract.build_document_nodes(pages, slug_to_id)
        edges = wiki_graph_extract.build_edges(pages, slug_to_id, document_ids)
        return nodes + documents, edges

    def test_cited_document_becomes_a_node_and_a_sourced_from_edge(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_page(root, "concept-a.md", "concept", ["docs/algorithms/aligner.md"])

            nodes, edges = self.build(root)

            documents = [n for n in nodes if n["node_type"] == "document"]
            self.assertEqual(["document:docs/algorithms/aligner.md"],
                             [n["id"] for n in documents])
            self.assertEqual("aligner.md", documents[0]["title"])

            provenance = [e for e in edges if e["predicate"] == "sourced_from"]
            self.assertEqual(1, len(provenance))
            self.assertEqual("document:docs/algorithms/aligner.md", provenance[0]["object"])
            self.assertEqual("frontmatter_sources", provenance[0]["extraction_method"])
            self.assertEqual("docs/algorithms/aligner.md", provenance[0]["source"])

    def test_source_page_keeps_the_document_it_summarizes(self):
        # The guard that skipped source pages exists so a source page does not
        # claim another wiki page as its provenance. It must not also discard
        # the edge to the external file the page summarizes -- that is the most
        # load-bearing provenance edge in the graph.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_page(root, "src-a.md", "source", ["docs/api/parsers.md"])

            _nodes, edges = self.build(root)

            provenance = [e for e in edges if e["predicate"] == "sourced_from"]
            self.assertEqual(1, len(provenance))
            self.assertEqual("document:docs/api/parsers.md", provenance[0]["object"])

    def test_source_page_still_refuses_another_wiki_page_as_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_page(root, "src-a.md", "source", [])
            write_page(root, "src-b.md", "source", ["src-a"])

            _nodes, edges = self.build(root)

            self.assertEqual([], [e for e in edges if e["predicate"] == "sourced_from"])

    def test_wiki_slug_citation_resolves_to_the_page_not_to_a_document(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_page(root, "src-a.md", "source", [])
            write_page(root, "concept-a.md", "concept", ["src-a"])

            nodes, edges = self.build(root)

            self.assertEqual([], [n for n in nodes if n["node_type"] == "document"])
            self.assertEqual(["source:src-a"],
                             [e["object"] for e in edges if e["predicate"] == "sourced_from"])

    def test_every_edge_object_resolves_to_a_node(self):
        # A closed graph is the point of minting document nodes at all.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_page(root, "src-a.md", "source", ["docs/one.md"])
            write_page(root, "concept-a.md", "concept", ["docs/one.md", "docs/two.md"],
                       body="Links to [[src-a]].")

            nodes, edges = self.build(root)

            known = {n["id"] for n in nodes}
            self.assertEqual([], [e for e in edges if e["object"] not in known])

    def test_one_document_node_is_shared_by_every_page_citing_it(self):
        # "Which pages derive from this doc" is the query this makes possible.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_page(root, "concept-a.md", "concept", ["docs/shared.md"])
            write_page(root, "concept-b.md", "concept", ["docs/shared.md"])

            nodes, edges = self.build(root)

            self.assertEqual(1, len([n for n in nodes if n["node_type"] == "document"]))
            self.assertEqual(2, len([e for e in edges if e["predicate"] == "sourced_from"]))

    def test_a_page_does_not_cite_itself_into_a_self_edge(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_page(root, "concept-a.md", "concept", ["concept-a"])

            _nodes, edges = self.build(root)

            self.assertEqual([], [e for e in edges if e["predicate"] == "sourced_from"])


class UnresolvedSourceLintTests(unittest.TestCase):
    """The linter, not the compiler, decides whether a citation is real.

    The extractor mints a node for any cited entry so the graph stays closed;
    that is exactly why something else has to notice a citation pointing at
    nothing, or the silent-provenance failure just moves one step downstream.
    """

    def lint(self, wiki: Path, repo_root: Path | None):
        pages = wiki_graph_lint.collect_pages(wiki)
        ontology = wiki_graph_extract.load_ontology(ONTOLOGY)
        return wiki_graph_lint.lint(pages, ontology, repo_root=repo_root)

    @staticmethod
    def wiki_with(root: Path, sources: list[str]) -> Path:
        wiki = root / "wiki"
        wiki.mkdir()
        write_page(wiki, "concept-a.md", "concept", sources)
        return wiki

    def test_citation_naming_nothing_is_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wiki = self.wiki_with(root, ["docs/does-not-exist.md"])

            findings = self.lint(wiki, repo_root=root)

            self.assertEqual(1, len(findings["unresolved_sources"]))
            self.assertEqual("docs/does-not-exist.md",
                             findings["unresolved_sources"][0]["source"])
            self.assertEqual(0, findings["unresolved_sources"][0]["index"])

    def test_existing_repo_file_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wiki = self.wiki_with(root, ["docs/real.md"])
            (root / "docs").mkdir()
            (root / "docs" / "real.md").write_text("# Real\n", encoding="utf-8")

            self.assertEqual([], self.lint(wiki, repo_root=root)["unresolved_sources"])

    def test_a_wiki_slug_is_not_a_missing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wiki = root / "wiki"
            wiki.mkdir()
            write_page(wiki, "src-a.md", "source", [])
            write_page(wiki, "concept-a.md", "concept", ["src-a"])

            self.assertEqual([], self.lint(wiki, repo_root=root)["unresolved_sources"])

    def test_check_is_skipped_when_the_repo_root_is_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wiki = self.wiki_with(root, ["docs/does-not-exist.md"])

            self.assertEqual([], self.lint(wiki, repo_root=None)["unresolved_sources"])


if __name__ == "__main__":
    unittest.main()
