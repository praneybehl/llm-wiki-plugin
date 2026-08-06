"""`--json` is a consumer contract; it is not a diagnostic.

It reports a rounded fused score, the retriever list, and only what survived
provenance dedup, --per-page and --top. Nothing in it can answer "why did this
section rank here": the raw BM25 score, the per-channel ranks and the cosine
distance exist nowhere else, and candidates cut by the page limit never appear
at all. `--debug-ranking` prints the full fused order and names the limit that
removed each candidate.
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import wiki_search  # noqa: E402


class DebugRankingTests(unittest.TestCase):
    """`--debug-ranking` must explain the ranking, not restate it.

    Its whole reason to exist is that `--json` reports a rounded, already
    limited result set: the raw BM25 score, both channel ranks and the cosine
    distance live nowhere else, and candidates cut by --per-page never appear.
    """

    class _Args:
        query = "q"
        wiki = Path("wiki")
        top = 2
        per_page = 1
        dedup_provenance = False

    def _sections(self, specs):
        sections = []
        for rel_path, index in specs:
            page = {"rel_path": rel_path, "meta": {"type": "concept"}, "slug": rel_path}
            sections.append({"page": page, "section_index": index, "heading_path": ["H"]})
        return sections

    def _emit(self, args, sections, ranked, mode, **kwargs):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            wiki_search.emit_ranking_debug(
                args, sections, ranked, mode,
                kwargs.get("bm25_scores", {}),
                kwargs.get("bm25_ranks", {}),
                kwargs.get("embedding_ranks", {}),
                kwargs.get("cosine_distances", {}),
                kwargs.get("suppressed", set()),
            )
        return json.loads(buffer.getvalue())

    def test_each_limit_is_named_on_the_candidate_it_removed(self):
        sections = self._sections([("a.md", 0), ("a.md", 1), ("b.md", 0), ("c.md", 0)])
        ranked = [(0.9, 0, ["bm25"]), (0.8, 1, ["bm25"]), (0.7, 2, ["bm25"]), (0.6, 3, ["bm25"])]
        payload = self._emit(self._Args(), sections, ranked, "hybrid")

        self.assertEqual(
            [None, "per_page", None, "top"],
            [c["dropped_by"] for c in payload["candidates"]],
        )
        # Nothing is hidden: the limits annotate, they do not truncate.
        self.assertEqual(4, len(payload["candidates"]))

    def test_provenance_dedup_is_named_before_the_page_limit(self):
        sections = self._sections([("a.md", 0), ("a.md", 1)])
        ranked = [(0.9, 0, ["bm25"]), (0.8, 1, ["bm25"])]
        payload = self._emit(self._Args(), sections, ranked, "hybrid", suppressed={"a.md"})

        self.assertEqual(["dedup_provenance", "dedup_provenance"],
                         [c["dropped_by"] for c in payload["candidates"]])

    def test_per_channel_numbers_survive_into_the_payload(self):
        sections = self._sections([("a.md", 0)])
        payload = self._emit(
            self._Args(), sections, [(0.032522, 0, ["bm25", "embedding"])], "hybrid",
            bm25_scores={0: 9.215}, bm25_ranks={0: 1},
            embedding_ranks={0: 2}, cosine_distances={0: 0.287},
        )
        candidate = payload["candidates"][0]

        self.assertEqual("a.md\x1f0", candidate["locator"])
        self.assertEqual(9.215, candidate["bm25_score"])
        self.assertEqual(1, candidate["bm25_rank"])
        self.assertEqual(2, candidate["vector_rank"])
        self.assertEqual(0.287, candidate["cosine_distance"])
        self.assertEqual("rrf", payload["fused_score_is"])
        self.assertEqual(wiki_search.RRF_K, payload["rrf_k"])

    def test_lexical_mode_does_not_pass_the_bm25_score_off_as_a_fused_one(self):
        sections = self._sections([("a.md", 0)])
        payload = self._emit(self._Args(), sections, [(9.215, 0, ["bm25"])], "lexical",
                             bm25_scores={0: 9.215}, bm25_ranks={0: 1})

        self.assertEqual("bm25", payload["fused_score_is"])
        self.assertEqual(0, payload["vector_hits"])
        self.assertIsNone(payload["candidates"][0]["cosine_distance"])


if __name__ == "__main__":
    unittest.main()
