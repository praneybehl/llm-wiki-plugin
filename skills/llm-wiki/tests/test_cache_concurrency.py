"""Persisting the parse cache must never fail a query that already answered.

Two agents on one wiki, or a search running beside a benchmark, are ordinary.
The cache is pure optimization: by the time it is written the results are
computed, so a writer that loses a race has nothing to report but a warning.
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import wiki_search  # noqa: E402


def build_wiki(root: Path, pages: int = 20) -> None:
    (root / "concepts").mkdir(parents=True)
    for index in range(pages):
        (root / "concepts" / f"p{index}.md").write_text(
            f"---\ntype: concept\ntitle: P{index}\n---\n\n# P{index}\n\ngamma delta {index}\n",
            encoding="utf-8",
        )


class ConcurrentCacheTests(unittest.TestCase):
    def test_concurrent_writers_neither_fail_nor_corrupt_the_cache(self):
        # A fixed `<cache>.tmp` name makes writers collide: one writes the
        # scratch file while another renames it. On Windows that raises
        # PermissionError from either operation, and the query exits non-zero
        # with no output at all -- after retrieval had already succeeded.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root)
            cache = root / ".wiki-cache" / "search-index.json"
            failures: list[str] = []
            counts: list[int] = []
            barrier = threading.Barrier(12)

            def worker() -> None:
                barrier.wait()
                try:
                    counts.append(len(wiki_search.collect_pages(root, cache)))
                except Exception as error:  # noqa: BLE001 - the point is that none escape
                    failures.append(f"{type(error).__name__}: {error}")

            threads = [threading.Thread(target=worker) for _ in range(12)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

            self.assertEqual([], failures)
            self.assertEqual({20}, set(counts))
            # Every scratch file is either renamed into place or cleaned up.
            self.assertEqual([], list(cache.parent.glob("*.tmp")))
            payload = json.loads(cache.read_text(encoding="utf-8"))
            self.assertEqual(wiki_search.PARSE_CACHE_SCHEMA, payload["schema"])
            self.assertEqual(20, len(payload["files"]))

    def test_an_unwritable_cache_directory_does_not_fail_the_query(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root, pages=3)
            # A file where the cache directory should be: mkdir and mkstemp both
            # fail, and the query must still answer.
            (root / ".wiki-cache").write_text("not a directory", encoding="utf-8")

            pages = wiki_search.collect_pages(root, root / ".wiki-cache" / "search-index.json")

            self.assertEqual(3, len(pages))

    def test_a_failed_rename_leaves_no_scratch_file_behind(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root, pages=2)
            cache_dir = root / ".wiki-cache"
            cache_dir.mkdir(parents=True)
            # A directory occupying the cache path: the write succeeds and the
            # rename cannot.
            (cache_dir / "search-index.json").mkdir()

            pages = wiki_search.collect_pages(root, cache_dir / "search-index.json")

            self.assertEqual(2, len(pages))
            self.assertEqual([], list(cache_dir.glob("*.tmp")))


if __name__ == "__main__":
    unittest.main()
