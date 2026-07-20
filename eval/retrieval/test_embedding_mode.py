#!/usr/bin/env python3
"""Regression tests for default local semantic retrieval."""

import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


REPO = Path(__file__).resolve().parents[2]
SEARCH = REPO / "skills" / "llm-wiki" / "scripts" / "wiki_search.py"
SPEC = importlib.util.spec_from_file_location("wiki_search", SEARCH)
WIKI_SEARCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WIKI_SEARCH)

try:
    import sqlite_vec
except ImportError:
    sqlite_vec = None


class FakeModel:
    def __init__(self):
        self.passage_calls = []

    def passage_embed(self, texts, batch_size=64):
        texts = list(texts)
        self.passage_calls.append(texts)
        for text in texts:
            yield [1.0, 0.0] if "attention" in text else [0.0, 1.0]

    def query_embed(self, _query):
        yield [1.0, 0.0]

class MetricModel:
    def passage_embed(self, texts, batch_size=64):
        for text in texts:
            yield [10.0, 0.0] if "long-axis" in text else [1.0, 1.0]

    def query_embed(self, _query):
        yield [1.0, 0.0]

class FilterModel:
    def passage_embed(self, texts, batch_size=64):
        for text in texts:
            yield [1.0, 0.0] if "exact" in text else [0.9, 0.4]

    def query_embed(self, _query):
        yield [1.0, 0.0]




def make_section(rel_path, index, text):
    return {
        "page": {"rel_path": rel_path},
        "section_index": index,
        "searchable_text": text,
    }


@unittest.skipUnless(sqlite_vec, "sqlite-vec is not installed")
class VectorIndexTests(unittest.TestCase):
    def test_index_is_incremental_and_removes_deleted_sections(self):
        model = FakeModel()
        original = [
            make_section("concepts/a.md", 0, "attention tokens"),
            make_section("concepts/b.md", 0, "database storage"),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            connection = WIKI_SEARCH.open_vector_index(root, sqlite_vec, 2)
            try:
                first = WIKI_SEARCH.sync_vector_index(connection, sqlite_vec, model, original)
                second = WIKI_SEARCH.sync_vector_index(connection, sqlite_vec, model, original)
                self.assertEqual(first, second)
                self.assertEqual(len(model.passage_calls), 1)

                changed = [make_section("concepts/a.md", 0, "attention heads")]
                WIKI_SEARCH.sync_vector_index(connection, sqlite_vec, model, changed)
                self.assertEqual(len(model.passage_calls), 2)
                self.assertEqual(
                    connection.execute("SELECT count(*) FROM semantic_sections").fetchone()[0],
                    1,
                )
                self.assertEqual(
                    connection.execute("SELECT count(*) FROM semantic_vectors").fetchone()[0],
                    1,
                )
            finally:
                connection.close()

    def test_dimension_change_rebuilds_derived_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            connection = WIKI_SEARCH.open_vector_index(root, sqlite_vec, 2)
            connection.close()
            connection = WIKI_SEARCH.open_vector_index(root, sqlite_vec, 3)
            try:
                meta = dict(connection.execute("SELECT key, value FROM semantic_meta"))
                self.assertEqual(meta["dimension"], "3")
                self.assertEqual(
                    connection.execute("SELECT count(*) FROM semantic_sections").fetchone()[0],
                    0,
                )
            finally:
                connection.close()

    def test_unfiltered_semantic_search_uses_cosine_distance(self):
        model = MetricModel()
        sections = [
            make_section("concepts/cosine.md", 0, "long-axis"),
            make_section("concepts/l2.md", 0, "near-origin"),
        ]
        allowed = {WIKI_SEARCH.section_locator(section) for section in sections}
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
            WIKI_SEARCH,
            "load_local_embedding_backend",
            return_value=(model, sqlite_vec, 2),
        ):
            order = WIKI_SEARCH.local_semantic_order(
                "axis",
                sections,
                allowed,
                Path(tmp),
            )
        self.assertEqual(order[0], WIKI_SEARCH.section_locator(sections[0]))


    def test_filtered_semantic_search_ranks_only_allowed_sections(self):
        model = FilterModel()
        sections = [
            make_section("concepts/disallowed.md", 0, "exact semantic match"),
            make_section("concepts/allowed.md", 0, "near semantic match"),
        ]
        allowed = {WIKI_SEARCH.section_locator(sections[1])}
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
            WIKI_SEARCH,
            "load_local_embedding_backend",
            return_value=(model, sqlite_vec, 2),
        ):
            order = WIKI_SEARCH.local_semantic_order(
                "semantic match",
                sections,
                allowed,
                Path(tmp),
            )
        self.assertEqual(order, [WIKI_SEARCH.section_locator(sections[1])])

    def test_semantic_search_rejects_low_similarity_results(self):
        model = FakeModel()
        sections = [make_section("concepts/b.md", 0, "database storage")]
        allowed = {WIKI_SEARCH.section_locator(sections[0])}
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
            WIKI_SEARCH,
            "load_local_embedding_backend",
            return_value=(model, sqlite_vec, 2),
        ):
            order = WIKI_SEARCH.local_semantic_order(
                "attention",
                sections,
                allowed,
                Path(tmp),
            )
        self.assertEqual(order, [])


class LocalFallbackTests(unittest.TestCase):
    def make_wiki(self, root):
        concepts = root / "concepts"
        concepts.mkdir()
        (concepts / "retrieval.md").write_text(
            "---\ntype: concept\ntitle: Retrieval\ntags: [search]\n"
            "created: 2026-07-20\nupdated: 2026-07-20\n---\n\n"
            "# Retrieval\n\nLexical retrieval finds exact words.\n",
            encoding="utf-8",
        )

    def search_args(self, wiki, no_embed=False, query="lexical retrieval"):
        return SimpleNamespace(
            query=query,
            wiki=wiki,
            top=10,
            type=None,
            tag=[],
            since=None,
            granularity="section",
            per_page=2,
            json=True,
            no_embed=no_embed,
        )

    def run_cmd(self, wiki, no_embed=False, query="lexical retrieval"):
        args = self.search_args(wiki, no_embed, query)
        pages = WIKI_SEARCH.collect_pages(wiki)
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            WIKI_SEARCH.cmd_search(args, pages)
        return json.loads(stdout.getvalue()), stderr.getvalue()

    def test_no_embed_never_initializes_local_backend(self):
        with tempfile.TemporaryDirectory() as tmp:
            wiki = Path(tmp)
            self.make_wiki(wiki)
            with mock.patch.object(
                WIKI_SEARCH,
                "local_semantic_order",
                side_effect=AssertionError("semantic backend should not run"),
            ):
                payload, stderr = self.run_cmd(wiki, no_embed=True)
        self.assertEqual(payload["mode"], "lexical")
        self.assertEqual(stderr, "")

    def test_local_backend_failure_falls_back_to_valid_lexical_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            wiki = Path(tmp)
            self.make_wiki(wiki)
            with mock.patch.object(
                WIKI_SEARCH,
                "local_semantic_order",
                side_effect=RuntimeError("private path and payload"),
            ):
                payload, stderr = self.run_cmd(wiki)
        self.assertEqual(payload["mode"], "lexical")
        self.assertIn("local semantic search unavailable (RuntimeError)", stderr)
        self.assertNotIn("private path", stderr)
        self.assertTrue(payload["results"])

    def test_empty_hybrid_preserves_json_envelope(self):
        with tempfile.TemporaryDirectory() as tmp:
            wiki = Path(tmp)
            self.make_wiki(wiki)
            with mock.patch.object(
                WIKI_SEARCH,
                "local_semantic_order",
                return_value=[],
            ):
                payload, _stderr = self.run_cmd(wiki, query="sourdough")
        self.assertEqual(payload["mode"], "hybrid")
        self.assertEqual(payload["wiki"], str(wiki))
        self.assertEqual(payload["granularity"], "section")
        self.assertEqual(payload["results"], [])

    def test_empty_fallback_preserves_lexical_envelope(self):
        with tempfile.TemporaryDirectory() as tmp:
            wiki = Path(tmp)
            self.make_wiki(wiki)
            with mock.patch.object(
                WIKI_SEARCH,
                "local_semantic_order",
                side_effect=RuntimeError("backend failed"),
            ):
                payload, _stderr = self.run_cmd(wiki, query="sourdough")
        self.assertEqual(payload["mode"], "lexical")
        self.assertEqual(payload["wiki"], str(wiki))
        self.assertEqual(payload["granularity"], "section")
        self.assertEqual(payload["results"], [])

    def test_extension_load_failure_closes_database(self):
        class BrokenSqliteVec:
            @staticmethod
            def load(_connection):
                raise RuntimeError("cannot load")

        connection = mock.Mock()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
            WIKI_SEARCH.sqlite3,
            "connect",
            return_value=connection,
        ), self.assertRaises(RuntimeError):
            WIKI_SEARCH.open_vector_index(Path(tmp), BrokenSqliteVec, 2)
        connection.close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
