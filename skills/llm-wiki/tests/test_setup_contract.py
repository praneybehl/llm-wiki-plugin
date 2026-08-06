"""`"status": "ready"` is a promise about the files setup was asked to build,
and `{"status": "error"}` is a promise that holds when it could not.

Setup and search have deliberately different contracts around the parse cache.
A search writes it best-effort -- results are already computed by then, so a
lost race must not fail the query. Setup is asked to *produce* it, so the same
outcome is a failure.
"""

from __future__ import annotations

import contextlib
import io
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import setup_wiki  # noqa: E402
import wiki_search  # noqa: E402


def build_wiki(root: Path) -> None:
    (root / "concepts").mkdir(parents=True)
    (root / "concepts" / "alpha.md").write_text(
        "---\ntype: concept\ntitle: Alpha\n---\n\n# Alpha\n\nGamma delta.\n",
        encoding="utf-8",
    )


class ParseCacheLoaderTests(unittest.TestCase):
    def test_loader_separates_an_unusable_cache_from_an_empty_one(self):
        # `None` means "do not trust this file"; `{}` means "trusted, and it
        # describes zero pages". A caller that cannot tell them apart either
        # reuses entries from an older parser or rejects a brand-new wiki.
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "search-index.json"

            self.assertIsNone(wiki_search.load_parse_cache(cache))

            cache.write_text("{not json", encoding="utf-8")
            self.assertIsNone(wiki_search.load_parse_cache(cache))

            cache.write_text(json.dumps(
                {"schema": wiki_search.PARSE_CACHE_SCHEMA - 1, "files": {}}), encoding="utf-8")
            self.assertIsNone(wiki_search.load_parse_cache(cache))

            cache.write_text(json.dumps(
                {"schema": wiki_search.PARSE_CACHE_SCHEMA,
                 "files": {"a.md": {"sha256": 1}}}), encoding="utf-8")
            self.assertIsNone(wiki_search.load_parse_cache(cache))

            cache.write_text(json.dumps(
                {"schema": wiki_search.PARSE_CACHE_SCHEMA, "files": {}}), encoding="utf-8")
            self.assertEqual({}, wiki_search.load_parse_cache(cache))

    def test_a_search_still_treats_every_unusable_cache_as_no_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root)
            cache = root / ".wiki-cache" / "search-index.json"
            cache.parent.mkdir(parents=True)
            cache.write_text("{not json", encoding="utf-8")

            self.assertEqual(1, len(wiki_search.collect_pages(root, cache)))


class SetupReadinessTests(unittest.TestCase):
    def test_a_cache_that_was_not_written_is_not_ready(self):
        # Reproduced with an unwritable cache path: `cache: not written
        # (WinError 183)` was followed by `"status": "ready"` and exit 0,
        # because readiness only checked the vector count.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root)
            pages = wiki_search.collect_pages(root)

            with self.assertRaises(RuntimeError) as caught:
                setup_wiki.verify_parse_cache(root / ".wiki-cache" / "missing.json", pages)

            self.assertIn("not written", str(caught.exception))

    def test_a_cache_from_an_older_parser_is_not_ready(self):
        # Verification goes through load_parse_cache(), the same loader a search
        # uses, so it checks the schema and the per-entry shape rather than the
        # existence of a file.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root)
            pages = wiki_search.collect_pages(root)
            cache = root / ".wiki-cache" / "search-index.json"
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(
                json.dumps({"schema": wiki_search.PARSE_CACHE_SCHEMA - 1, "files": {}}),
                encoding="utf-8",
            )

            with self.assertRaises(RuntimeError) as caught:
                setup_wiki.verify_parse_cache(cache, pages)

            self.assertIn("unusable", str(caught.exception))

    def test_a_partial_cache_is_not_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root)
            cache = root / ".wiki-cache" / "search-index.json"
            pages = wiki_search.collect_pages(root, cache)
            pages = pages + [{"rel_path": "concepts/beta.md"}]

            with self.assertRaises(RuntimeError) as caught:
                setup_wiki.verify_parse_cache(cache, pages)

            self.assertIn("incomplete", str(caught.exception))

    def test_a_complete_cache_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root)
            cache = root / ".wiki-cache" / "search-index.json"
            pages = wiki_search.collect_pages(root, cache)

            setup_wiki.verify_parse_cache(cache, pages)  # must not raise

    def test_a_freshly_initialized_wiki_has_a_valid_empty_cache(self):
        # The state every `/wiki:init` leaves behind: the scaffold exists, but
        # SCHEMA.md, index.md, log.md and dotfiles are all excluded from the
        # corpus and nothing has been ingested yet. An empty file map is a
        # correct cache here, not a corrupt one -- rejecting it would fail setup
        # for every new wiki before its first ingest.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            root.mkdir(parents=True)
            (root / "SCHEMA.md").write_text("# Schema\n", encoding="utf-8")
            (root / "index.md").write_text("# Index\n", encoding="utf-8")
            (root / "log.md").write_text("# Log\n", encoding="utf-8")
            (root / ".page-template.md").write_text("# Template\n", encoding="utf-8")
            cache = root / ".wiki-cache" / "search-index.json"

            pages = wiki_search.collect_pages(root, cache)

            self.assertEqual([], pages)
            self.assertEqual({}, json.loads(cache.read_text(encoding="utf-8"))["files"])
            setup_wiki.verify_parse_cache(cache, pages)  # must not raise

    def test_setup_cli_on_an_empty_wiki_does_not_blame_the_parse_cache(self):
        # End to end through the CLI: the semantic backend may or may not be
        # installed in the test environment, but neither outcome may be reported
        # as a cache problem, and stdout must stay parseable either way.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            root.mkdir(parents=True)
            (root / "SCHEMA.md").write_text("# Schema\n", encoding="utf-8")

            result = subprocess.run(
                [sys.executable, str(SCRIPTS / "setup_wiki.py"), "--wiki", str(root), "--cache"],
                capture_output=True, text=True, encoding="utf-8",
            )
            payload = json.loads(result.stdout)

            self.assertNotIn("Traceback", result.stderr)
            self.assertNotIn("cache", payload.get("error", ""))
            if payload["status"] == "ready":
                self.assertEqual(0, result.returncode)
                self.assertEqual(0, payload["sections"])


class SetupErrorEnvelopeTests(unittest.TestCase):
    """A failed setup still owes the caller a parseable envelope."""

    def run_main(self, root: Path, failure: BaseException):
        stdout = io.StringIO()
        argv = ["setup_wiki.py", "--wiki", str(root), "--cache"]

        def explode(*_args, **_kwargs):
            raise failure

        with mock.patch.object(wiki_search, "load_local_embedding_backend", explode), \
                mock.patch.object(sys, "argv", argv), \
                contextlib.redirect_stdout(stdout):
            with self.assertRaises(BaseException) as caught:
                setup_wiki.main()
        return caught.exception, stdout.getvalue()

    def test_a_backend_failure_becomes_an_envelope_not_a_traceback(self):
        # Reproduced by occupying the embeddings.sqlite path with a directory.
        # sqlite3.OperationalError is not a RuntimeError, so catching only
        # RuntimeError let it escape as a traceback with no JSON on stdout.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root)

            error, stdout = self.run_main(
                root, sqlite3.OperationalError("unable to open database file"))
            payload = json.loads(stdout)

            self.assertIsInstance(error, SystemExit)
            self.assertEqual(1, error.code)
            self.assertEqual("error", payload["status"])
            self.assertIn("OperationalError", payload["error"])
            self.assertIn("unable to open database file", payload["error"])

    def test_an_os_error_is_also_reported_structurally(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root)

            _, stdout = self.run_main(root, OSError("disk is full"))

            self.assertIn("OSError", json.loads(stdout)["error"])

    def test_a_runtime_error_keeps_its_bare_message(self):
        # The tool's own diagnostics are already written for a human, so they
        # are not prefixed with a type name the way a third-party failure is.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root)

            _, stdout = self.run_main(root, RuntimeError("semantic dependencies are missing"))

            self.assertEqual("semantic dependencies are missing",
                             json.loads(stdout)["error"])

    def test_an_interrupt_is_not_swallowed(self):
        # Ctrl-C and explicit exits are not failures to report; `Exception`
        # deliberately does not cover them.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root)

            error, stdout = self.run_main(root, KeyboardInterrupt())

            self.assertIsInstance(error, KeyboardInterrupt)
            self.assertEqual("", stdout)


if __name__ == "__main__":
    unittest.main()
