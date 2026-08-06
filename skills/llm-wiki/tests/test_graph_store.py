"""`graph.sqlite` is derived and gitignored, so a fresh clone has none.

Before the rebuild existed, every query exited 1 -- and because consulting the
graph is an optional step, the agent quietly moved on without typed
neighbours. The wiki still answered, so a whole retrieval stage could go
missing with nothing to show for it. That is worse than an error, which is why
these tests pin the rebuild and, equally, that it does not fire when it should
not.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import wiki_graph_extract  # noqa: E402
import wiki_graph_query  # noqa: E402
import wiki_graph_store  # noqa: E402


NODES = [
    {"id": "concept:a", "slug": "a", "title": "A", "page_type": "concept",
     "node_type": "concept", "kind": "", "tags": ["t"], "aliases": ["Alpha"],
     "path": "a.md", "created": "", "updated": "", "canonical": True},
    {"id": "document:docs/x.md", "slug": "docs/x.md", "title": "x.md",
     "page_type": "", "node_type": "document", "kind": "", "tags": [],
     "aliases": [], "path": "docs/x.md", "created": "", "updated": "",
     "canonical": False},
]
EDGES = [
    {"id": "e1", "subject": "concept:a", "predicate": "sourced_from",
     "object": "document:docs/x.md", "source": "docs/x.md", "evidence": "",
     "confidence": "high", "status": "current",
     "extraction_method": "frontmatter_sources", "page": "a.md", "extras": {}},
]


def write_exports(root: Path) -> Path:
    graph = root / "graph"
    graph.mkdir(parents=True)
    with (graph / "nodes.jsonl").open("w", encoding="utf-8") as handle:
        for node in NODES:
            handle.write(json.dumps(node, sort_keys=True) + "\n")
    with (graph / "edges.jsonl").open("w", encoding="utf-8") as handle:
        for edge in EDGES:
            handle.write(json.dumps(edge, sort_keys=True) + "\n")
    return graph


class RebuildFromExportsTests(unittest.TestCase):
    def test_missing_database_is_rebuilt_from_the_committed_exports(self):
        with tempfile.TemporaryDirectory() as directory:
            graph = write_exports(Path(directory))
            db = graph / "graph.sqlite"

            buffer = io.StringIO()
            with contextlib.redirect_stderr(buffer):
                conn = wiki_graph_query.open_db(db, graph)
            try:
                self.assertTrue(db.exists())
                self.assertIn("rebuilding", buffer.getvalue())
                self.assertEqual(2, conn.execute("SELECT count(*) FROM nodes").fetchone()[0])
                self.assertEqual(1, conn.execute("SELECT count(*) FROM edges").fetchone()[0])
                # Aliases are derived from the node rows, not a separate export.
                self.assertEqual(
                    ("Alpha", "concept:a"),
                    tuple(conn.execute("SELECT alias, node_id FROM aliases").fetchone()),
                )
            finally:
                conn.close()

    def test_edges_survive_the_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            graph = write_exports(Path(directory))

            with contextlib.redirect_stderr(io.StringIO()):
                conn = wiki_graph_query.open_db(graph / "graph.sqlite", graph)
            try:
                row = conn.execute(
                    "SELECT predicate, object FROM edges WHERE subject = ?",
                    ("concept:a",)).fetchone()
                self.assertEqual(("sourced_from", "document:docs/x.md"), tuple(row))
            finally:
                conn.close()

    def test_database_older_than_the_exports_is_rebuilt(self):
        with tempfile.TemporaryDirectory() as directory:
            graph = write_exports(Path(directory))
            db = graph / "graph.sqlite"
            db.write_bytes(b"")
            stale = (graph / "nodes.jsonl").stat().st_mtime - 60
            os.utime(db, (stale, stale))

            self.assertEqual("older than the exports",
                             wiki_graph_query.rebuild_reason(db, graph))

    def test_current_database_is_left_alone(self):
        with tempfile.TemporaryDirectory() as directory:
            graph = write_exports(Path(directory))
            db = graph / "graph.sqlite"
            db.write_bytes(b"")
            fresh = (graph / "nodes.jsonl").stat().st_mtime + 60
            os.utime(db, (fresh, fresh))

            self.assertIsNone(wiki_graph_query.rebuild_reason(db, graph))

    def test_absent_exports_report_instead_of_pretending_to_rebuild(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            graph = root / "graph"
            graph.mkdir(parents=True)

            self.assertIsNone(wiki_graph_query.rebuild_reason(graph / "graph.sqlite", graph))

            result = subprocess.run(
                [sys.executable, str(SCRIPTS / "wiki_graph_query.py"), str(root),
                 "neighbors", "--node", "concept:a"],
                text=True, capture_output=True, encoding="utf-8", check=False)

            self.assertEqual(1, result.returncode)
            self.assertIn("no exports to rebuild it from", result.stderr)

    def test_a_query_on_a_fresh_clone_answers_instead_of_failing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_exports(root)

            result = subprocess.run(
                [sys.executable, str(SCRIPTS / "wiki_graph_query.py"), str(root),
                 "--json", "facts", "--about", "concept:a"],
                text=True, capture_output=True, encoding="utf-8", check=False)

            self.assertEqual(0, result.returncode, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(["sourced_from"],
                             [edge["predicate"] for edge in payload["outbound"]])


class OneSchemaTwoWritersTests(unittest.TestCase):
    def test_the_rebuilt_schema_matches_the_extractor(self):
        # The reason the DDL lives in wiki_graph_store: two writers share it,
        # and a second copy would diverge exactly as the duplicated corpus
        # exclusion lists did.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            graph = write_exports(root)
            from_query = graph / "graph.sqlite"
            with contextlib.redirect_stderr(io.StringIO()):
                wiki_graph_query.open_db(from_query, graph).close()

            from_extract = root / "extract.sqlite"
            wiki_graph_extract._write_sqlite(from_extract, NODES, [], EDGES)

            def shape(path: Path) -> list[str]:
                conn = sqlite3.connect(path)
                try:
                    return sorted(row[0] for row in conn.execute(
                        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL"))
                finally:
                    conn.close()

            self.assertEqual(shape(from_extract), shape(from_query))

    def test_the_store_reads_only_jsonl_and_needs_no_third_party_import(self):
        # This module must stay stdlib-only: it is what lets a query rebuild the
        # database without PyYAML or `uv`, which the extractor both require.
        source = (SCRIPTS / "wiki_graph_store.py").read_text(encoding="utf-8")

        self.assertNotIn("import yaml", source)
        with tempfile.TemporaryDirectory() as directory:
            graph = write_exports(Path(directory))
            nodes, aliases, edges = wiki_graph_store.read_exports(graph)

            self.assertEqual(2, len(nodes))
            self.assertEqual(1, len(edges))
            self.assertEqual([{"alias": "Alpha", "node_id": "concept:a"}], aliases)


if __name__ == "__main__":
    unittest.main()
