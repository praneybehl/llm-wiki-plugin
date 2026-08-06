"""Sections are the retrieval unit, so their boundaries are a contract.

A wrong boundary is not a cosmetic problem: each section becomes a BM25 unit,
a section locator in the JSON evidence, and one embedded vector. A heading
invented inside a code block, or a heading whose text is silently truncated,
is indexed and retrieved exactly like a real one.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import wiki_markdown  # noqa: E402
import wiki_search  # noqa: E402


class SectionSplitTests(unittest.TestCase):
    def headings(self, body: str) -> list[list[str]]:
        return [section["heading_path"] for section in wiki_search.split_sections("T", body)]

    # -- code blocks are not headings ------------------------------------

    def test_headings_inside_code_fences_do_not_split(self):
        body = "# A\n\n```\n# not a heading\n```\n\ntail\n"
        sections = wiki_search.split_sections("T", body)

        self.assertEqual(1, len(sections))
        self.assertIn("# not a heading", sections[0]["text"])

    def test_a_tilde_run_does_not_close_a_backtick_fence(self):
        body = "# A\n```\ncode\n~~~\n# FAKE\n```\ntail\n"
        self.assertEqual([["A"]], self.headings(body))

    def test_a_shorter_run_does_not_close_a_longer_fence(self):
        body = "# A\n````\ncode\n```\n# FAKE\n````\ntail\n"
        self.assertEqual([["A"]], self.headings(body))

    def test_a_closing_fence_may_not_carry_trailing_text(self):
        body = "# A\n```\ncode\n``` tail\n# FAKE\n"
        self.assertEqual([["A"]], self.headings(body))

    def test_info_string_opens_but_does_not_close(self):
        body = "# A\n```python\n# FAKE\n```\n\n## REAL\n\nx\n"
        self.assertEqual([["A"], ["A", "REAL"]], self.headings(body))

    def test_four_spaces_is_indented_code_not_a_heading(self):
        body = "# A\n\ntext\n\n    ## FAKE\n\nbody\n"
        self.assertEqual([["A"]], self.headings(body))

    def test_splitter_and_link_extractor_agree_on_fences(self):
        # Both must consult the same CommonMark state machine; a local fence
        # toggle in either one drifts from the other, and the drift is invisible
        # until a page indexes differently than it links.
        body = "# A\n````\n[[fake-link]]\n```\n# FAKE\n````\n\n## REAL\n\n[[real-link]]\n"
        self.assertEqual([["A"], ["A", "REAL"]], self.headings(body))
        self.assertEqual(["real-link"], wiki_markdown.extract_wikilinks(body))

    # -- what an ATX heading is ------------------------------------------

    def test_up_to_three_spaces_still_marks_a_heading(self):
        body = "# A\n\ntext\n\n   ## REAL\n\nbody\n"
        self.assertEqual([["A"], ["A", "REAL"]], self.headings(body))

    def test_a_hash_run_with_no_space_is_not_a_heading(self):
        self.assertEqual([[]], self.headings("#no-space\n\nbody\n"))

    def test_a_literal_trailing_hash_is_part_of_the_heading(self):
        # CommonMark reads a hash run as a closing sequence only when whitespace
        # precedes it. `C#` and `F#` are language names, and truncating them to
        # `C` and `F` corrupts the heading path, the searchable text and the
        # embedded vector for that section.
        self.assertEqual([["C#"]], self.headings("# C#\n\nbody\n"))
        self.assertEqual([["F##"]], self.headings("# F##\n\nbody\n"))
        self.assertEqual([["Title###"]], self.headings("# Title###\n\nbody\n"))

    def test_a_spaced_trailing_hash_run_is_a_closing_sequence(self):
        self.assertEqual([["Title"]], self.headings("# Title ###\n\nbody\n"))
        self.assertEqual([["Title"]], self.headings("# Title #\t\n\nbody\n"))

    def test_an_escaped_hash_run_does_not_close_the_heading(self):
        # CommonMark: `### foo \###` keeps the hashes as content. The backslash
        # survives because sections store raw Markdown; tokenization drops it,
        # so only the heading path shows it.
        self.assertEqual([["foo \\###"]], self.headings("# foo \\###\n\nbody\n"))
        self.assertEqual([["foo #\\##"]], self.headings("# foo #\\##\n\nbody\n"))

    def test_an_empty_atx_heading_splits_without_naming_the_section(self):
        # `##` alone is a valid empty heading, so it is a boundary and it holds
        # its level for the headings below it -- but it contributes no name, and
        # padding the path with "" would put an empty token into every child
        # path and every searchable string.
        sections = wiki_search.split_sections("T", "# A\n\nx\n\n##\n\ny\n\n### C\n\nz\n")

        self.assertEqual([["A"], ["A"], ["A", "C"]], [s["heading_path"] for s in sections])
        self.assertEqual([1, 2, 3], [s["level"] for s in sections])
        self.assertIn("y", sections[1]["text"])

    # -- sections that carry nothing are not sections ---------------------

    def test_empty_preamble_before_the_first_heading_is_dropped(self):
        # A page opening with a heading used to emit an empty section ahead of
        # it. Empty sections are scored, embedded, and can take the top slot
        # with an empty snippet while consuming a --per-page slot that a real
        # passage needed.
        sections = wiki_search.split_sections("T", "# Title\n\nBody text.\n")

        self.assertEqual(1, len(sections))
        self.assertEqual(["Title"], sections[0]["heading_path"])
        self.assertEqual(0, sections[0]["section_index"])

    def test_a_real_preamble_is_kept(self):
        sections = wiki_search.split_sections("T", "Lead paragraph.\n\n# Title\n\nBody.\n")

        self.assertEqual(2, len(sections))
        self.assertEqual([], sections[0]["heading_path"])
        self.assertIn("Lead paragraph.", sections[0]["text"])

    def test_an_empty_heading_with_no_body_is_dropped(self):
        # An inherited path is not a name: the section says nothing its parent
        # does not already say, so it is worth neither a slot nor a vector.
        self.assertEqual([["A"]], self.headings("# A\n\nx\n\n##\n"))

    def test_section_indexes_stay_contiguous_after_dropping(self):
        # section_index is half of the vector-index locator, so a gap would
        # address a section that does not exist.
        sections = wiki_search.split_sections("T", "# A\n\nx\n\n## B\n\ny\n")

        self.assertEqual([0, 1], [section["section_index"] for section in sections])


class SectionCacheRoundTripTests(unittest.TestCase):
    """With no empty preamble, a cached body reproduces the cold parse exactly."""

    def test_a_cached_body_no_longer_gains_a_leading_blank_line(self):
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            (root / "concepts").mkdir(parents=True)
            (root / "concepts" / "alpha.md").write_text(
                "---\ntitle: Alpha\n---\n\n# Alpha\n\nGamma delta.\n\n## Beta\n\nEpsilon.\n",
                encoding="utf-8")
            cache = root / ".wiki-cache" / "search-index.json"

            cold = wiki_search.collect_pages(root)
            wiki_search.collect_pages(root, cache)
            warm = wiki_search.collect_pages(root, cache)

            self.assertEqual(cold[0]["body"].rstrip(), warm[0]["body"].rstrip())
            self.assertFalse(warm[0]["body"].startswith("\n"))


if __name__ == "__main__":
    unittest.main()
