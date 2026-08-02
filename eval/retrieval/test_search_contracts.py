#!/usr/bin/env python3
"""Direct contracts for section splitting in the canonical Python retriever."""

import importlib.util
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "skills/llm-wiki/scripts/wiki_search.py"
SPEC = importlib.util.spec_from_file_location("wiki_search", SCRIPT)
WIKI_SEARCH = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(WIKI_SEARCH)


class SplitSectionsContractTest(unittest.TestCase):
    def test_retains_empty_preface_and_empty_heading_section(self):
        sections = WIKI_SEARCH.split_sections("Page", "# Heading\n")
        self.assertEqual(
            sections,
            [
                {"heading_path": [], "level": 0, "text": "", "section_index": 0},
                {"heading_path": ["Heading"], "level": 1, "text": "", "section_index": 1},
            ],
        )

    def test_tracks_nested_paths_and_resets_at_parent_level(self):
        sections = WIKI_SEARCH.split_sections(
            "Page",
            "preface\n# One\nalpha\n## Two\nbeta\n# Reset\ngamma",
        )
        self.assertEqual(
            [section["heading_path"] for section in sections],
            [[], ["One"], ["One", "Two"], ["Reset"]],
        )

    def test_replaces_same_level_siblings_when_levels_are_skipped(self):
        sections = WIKI_SEARCH.split_sections(
            "Page",
            "## Alpha\none\n## Beta\ntwo\n# One\n### X\nx\n### Y\ny",
        )
        self.assertEqual(
            [section["heading_path"] for section in sections],
            [[], ["Alpha"], ["Beta"], ["One"], ["One", "X"], ["One", "Y"]],
        )

    def test_ignores_heading_markers_inside_backtick_and_tilde_fences(self):
        sections = WIKI_SEARCH.split_sections(
            "Page",
            "# Real\n```md\n## Backtick\n```\n~~~md\n### Tilde\n~~~\n## Next\nbody",
        )
        self.assertEqual(
            [section["heading_path"] for section in sections],
            [[], ["Real"], ["Real", "Next"]],
        )
        self.assertIn("## Backtick", sections[1]["text"])
        self.assertIn("### Tilde", sections[1]["text"])


class TokenizeContractTest(unittest.TestCase):
    def test_keeps_accented_latin_letters_whole(self):
        self.assertEqual(
            WIKI_SEARCH.tokenize("Attività e società: perché più caro?"),
            ["attività", "e", "società", "perché", "più", "caro"],
        )

    def test_ascii_tokenization_is_unchanged(self):
        self.assertEqual(
            WIKI_SEARCH.tokenize("Scaling laws for LLM-based agents (2026)"),
            ["scaling", "laws", "for", "llm", "based", "agents", "2026"],
        )

    def test_query_and_document_tokens_agree_on_accents(self):
        document = WIKI_SEARCH.tokenize("La stagionalità dei consumi è marcata")
        self.assertIn("stagionalità", document)
        self.assertEqual(WIKI_SEARCH.tokenize("stagionalità"), ["stagionalità"])


if __name__ == "__main__":
    unittest.main()
