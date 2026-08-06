"""Business rules for the shared Markdown layer.

Two contracts are under test, and they are the reason the module exists:

* a ``[[wikilink]]`` becomes a backlink and a graph edge only when a Markdown
  reader would see it as prose, never when it is code or raw HTML;
* every tool agrees on which files are wiki pages at all.

Both used to be decided per script, and both had already drifted.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
import sys  # noqa: E402

sys.path.insert(0, str(SCRIPTS))

import wiki_graph_extract  # noqa: E402
import wiki_graph_lint  # noqa: E402
import wiki_lint  # noqa: E402
import wiki_markdown  # noqa: E402
import wiki_search  # noqa: E402
import wiki_stats  # noqa: E402


class NavigableLinkContractTests(unittest.TestCase):
    """A link is navigable only when a Markdown reader would see it as prose."""

    def test_extracts_aliases_and_escaped_table_aliases(self):
        body = "[[plain]] [[shown|Alias]] [[table\\|Table alias]] [[#local]]"
        self.assertEqual(
            ["plain", "shown", "table"],
            wiki_markdown.extract_wikilinks(body),
        )

    def test_escaped_wikilink_is_literal_but_even_backslashes_leave_it_visible(self):
        body = r"\[[escaped]] \\[[visible]] [[ordinary]]"
        self.assertEqual(
            ["visible", "ordinary"],
            wiki_markdown.extract_wikilinks(body),
        )

    def test_blank_target_and_local_anchor_do_not_create_graph_nodes(self):
        body = "[[   ]] [[#installation]] [[guide#installation|Install]]"
        self.assertEqual(["guide"], wiki_markdown.extract_wikilinks(body))

    def test_cross_page_anchor_resolves_to_page_and_multiline_link_is_rejected(self):
        body = "[[page#section|Section]] [[broken\nlink]] [[real]]"
        self.assertEqual(["page", "real"], wiki_markdown.extract_wikilinks(body))

    def test_ignores_inline_code(self):
        body = "`[[one]]` ``code ` [[two]]`` [[real]]"
        self.assertEqual(["real"], wiki_markdown.extract_wikilinks(body))

    def test_unmatched_backtick_is_prose_not_an_open_ended_code_span(self):
        body = "An unmatched ` delimiter leaves [[the-link]] visible."
        self.assertEqual(["the-link"], wiki_markdown.extract_wikilinks(body))

    def test_code_span_delimiters_must_have_equal_length(self):
        body = "``code ` [[hidden]] `` [[visible]]"
        self.assertEqual(["visible"], wiki_markdown.extract_wikilinks(body))

    def test_escaped_backticks_do_not_create_code_spans(self):
        body = r"\`[[visible]]\` [[real]]"
        self.assertEqual(["visible", "real"], wiki_markdown.extract_wikilinks(body))

    def test_code_spans_do_not_cross_paragraph_boundaries(self):
        body = "`open\n\n[[visible]]\n\nclose` [[also-visible]]"
        self.assertEqual(
            ["visible", "also-visible"],
            wiki_markdown.extract_wikilinks(body),
        )

    def test_code_span_does_not_cross_heading_or_thematic_break_blocks(self):
        body = "`open\n# [[heading]]\n\n`open\n---\n[[after-break]]"
        self.assertEqual(
            ["heading", "after-break"],
            wiki_markdown.extract_wikilinks(body),
        )

    def test_code_span_does_not_cross_setext_heading_boundary(self):
        body = "`heading\n===\n[[visible]]`"
        self.assertEqual(["visible"], wiki_markdown.extract_wikilinks(body))

    def test_ordered_marker_other_than_one_does_not_interrupt_paragraph(self):
        body = "paragraph\n2.     [[visible-continuation]]"
        self.assertEqual(
            ["visible-continuation"],
            wiki_markdown.extract_wikilinks(body),
        )

    def test_indentation_does_not_interrupt_a_paragraph(self):
        body = "paragraph\n    [[continuation]]\n"
        self.assertEqual(["continuation"], wiki_markdown.extract_wikilinks(body))


class LiteralBlockContractTests(unittest.TestCase):
    """Examples and raw code must never become backlinks or graph edges."""

    def test_ignores_four_character_fence_containing_triple_fence(self):
        body = "````md\n[[fake]]\n```\n````\n[[real]]\n"
        self.assertEqual(["real"], wiki_markdown.extract_wikilinks(body))

    def test_accepts_longer_closing_fence(self):
        body = "```md\n[[fake]]\n`````\n[[real]]\n"
        self.assertEqual(["real"], wiki_markdown.extract_wikilinks(body))

    def test_ignores_tilde_fence(self):
        body = "~~~~\n[[fake]]\n~~~~\n[[real]]\n"
        self.assertEqual(["real"], wiki_markdown.extract_wikilinks(body))

    def test_wrong_fence_character_and_short_fence_do_not_close_block(self):
        body = (
            "````\n[[hidden-a]]\n~~~\n[[hidden-b]]\n```\n[[hidden-c]]\n"
            "````\n[[visible]]"
        )
        self.assertEqual(["visible"], wiki_markdown.extract_wikilinks(body))

    def test_closing_fence_with_trailing_text_is_not_a_closer(self):
        body = "```\n[[hidden-a]]\n``` trailing\n[[hidden-b]]\n```\n[[visible]]"
        self.assertEqual(["visible"], wiki_markdown.extract_wikilinks(body))

    def test_backtick_in_backtick_fence_info_invalidates_the_opener(self):
        body = "```language`option\n[[visible]]"
        self.assertEqual(["visible"], wiki_markdown.extract_wikilinks(body))

    def test_unclosed_fence_consumes_rest_of_document(self):
        body = "[[before]]\n```\n[[inside]]\n"
        self.assertEqual(["before"], wiki_markdown.extract_wikilinks(body))

    def test_indented_code_and_tab_indented_code_are_ignored(self):
        body = "    [[space-code]]\n\n\t[[tab-code]]\n\n[[real]]"
        self.assertEqual(["real"], wiki_markdown.extract_wikilinks(body))

    def test_excess_list_padding_creates_indented_code(self):
        body = "-     [[indented-code]]\n\n- [[visible-item]]"
        self.assertEqual(["visible-item"], wiki_markdown.extract_wikilinks(body))

    def test_tab_padded_list_continuation_keeps_code_in_the_list(self):
        # The blank line is significant: indented code cannot interrupt the
        # preceding paragraph, even inside a list item.
        body = "- item\n\n\t    [[hidden]]\n\n[[visible]]"
        self.assertEqual(["visible"], wiki_markdown.extract_wikilinks(body))

    def test_fences_inside_blockquotes_and_lists_are_ignored(self):
        body = (
            "> ~~~~\n> [[quoted]]\n> ~~~~~\n\n"
            "10. item\n    ```\n    [[listed]]\n    ````\n\n"
            "[[real]]"
        )
        self.assertEqual(["real"], wiki_markdown.extract_wikilinks(body))

    def test_fences_in_mixed_list_and_blockquote_containers_are_ignored(self):
        body = (
            "- > ```\n  > [[list-quote]]\n  > ```\n\n"
            "> - ~~~\n>   [[quote-list]]\n>   ~~~\n\n"
            "[[real]]"
        )
        self.assertEqual(["real"], wiki_markdown.extract_wikilinks(body))

    def test_block_markers_inside_open_fences_are_literal_code(self):
        bodies = (
            "```\n- [[hidden-list]]\n> [[hidden-quote]]\n```\n[[visible]]",
            "- ```\n  - [[hidden-list]]\n  > [[hidden-quote]]\n  ```\n[[visible]]",
            "> ```\n> - [[hidden-list]]\n> > [[hidden-quote]]\n> ```\n[[visible]]",
        )
        for body in bodies:
            with self.subTest(body=body):
                self.assertEqual(["visible"], wiki_markdown.extract_wikilinks(body))

    def test_unclosed_container_fence_ends_with_its_container(self):
        body = "> ```\n> [[quoted]]\n\n[[outside]]"
        self.assertEqual(["outside"], wiki_markdown.extract_wikilinks(body))

    def test_unclosed_fence_ends_when_nested_list_item_ends(self):
        body = (
            "- outer\n"
            "  - inner\n"
            "    ```\n"
            "    [[hidden]]\n"
            "  [[outer-visible]]\n"
        )
        self.assertEqual(["outer-visible"], wiki_markdown.extract_wikilinks(body))

    def test_empty_list_item_still_owns_its_indented_fence(self):
        body = "-\n  ```\n  [[hidden]]\n[[outside]]\n"
        self.assertEqual(["outside"], wiki_markdown.extract_wikilinks(body))

    def test_root_and_blockquote_fence_matrix(self):
        for prefix in ("", "> ", "> > "):
            for character in ("`", "~"):
                for opening_length in range(3, 7):
                    for extra_closing in range(3):
                        with self.subTest(prefix=prefix, character=character,
                                          opening=opening_length, extra=extra_closing):
                            body = (
                                f"{prefix}{character * opening_length}\n"
                                f"{prefix}[[fake]]\n"
                                f"{prefix}{character * (opening_length + extra_closing)}\n\n"
                                "[[real]]"
                            )
                            self.assertEqual(["real"], wiki_markdown.extract_wikilinks(body))

    def test_pre_and_comment_blocks_are_ignored(self):
        body = (
            "<pre>\n[[pre-code]]\n</pre>\n\n"
            "<!--\n[[comment]]\n-->\n\n"
            "[[real]]"
        )
        self.assertEqual(["real"], wiki_markdown.extract_wikilinks(body))

    def test_inline_html_comments_are_ignored(self):
        body = "before <!-- [[comment]] --> [[real]]"
        self.assertEqual(["real"], wiki_markdown.extract_wikilinks(body))

    def test_single_line_html_blocks_and_comments_hide_only_their_own_line(self):
        body = (
            "<pre>[[pre-hidden]]</pre>\n"
            "<!-- [[comment-hidden]] -->\n"
            "[[visible]]"
        )
        self.assertEqual(["visible"], wiki_markdown.extract_wikilinks(body))

    def test_all_pre_like_html_blocks_hide_wikilinks_until_their_close(self):
        for tag in ("pre", "script", "style", "textarea"):
            with self.subTest(tag=tag):
                body = f"<{tag}>\n[[hidden]]\n</{tag.upper()}>\n[[visible]]"
                self.assertEqual(["visible"], wiki_markdown.extract_wikilinks(body))

    def test_block_markers_inside_pre_like_html_are_literal(self):
        body = "<pre>\n- [[hidden-list]]\n> [[hidden-quote]]\n</pre>\n[[visible]]"
        self.assertEqual(["visible"], wiki_markdown.extract_wikilinks(body))

    def test_unclosed_html_block_ends_when_its_blockquote_container_ends(self):
        body = "> <script>\n> [[script-hidden]]\n\n[[outside]]"
        self.assertEqual(["outside"], wiki_markdown.extract_wikilinks(body))

    def test_blank_terminated_commonmark_html_blocks_hide_wikilinks(self):
        bodies = (
            "<div>\n[[hidden]]\n</div>\n\n[[visible]]",
            "<custom-element data-value='x'>\n[[hidden]]\n\n[[visible]]",
        )
        for body in bodies:
            with self.subTest(body=body):
                self.assertEqual(["visible"], wiki_markdown.extract_wikilinks(body))

    def test_processing_instruction_declaration_and_cdata_blocks_are_literal(self):
        bodies = (
            "<?target\n[[hidden]]\n?>\n[[visible]]",
            "<!DECLARATION\n[[hidden]]\n>\n[[visible]]",
            "<![CDATA[\n[[hidden]]\n]]>\n[[visible]]",
        )
        for body in bodies:
            with self.subTest(body=body):
                self.assertEqual(["visible"], wiki_markdown.extract_wikilinks(body))

    def test_crlf_input_preserves_links_outside_code(self):
        body = "[[before]]\r\n~~~\r\n[[hidden]]\r\n~~~\r\n[[after]]\r\n"
        self.assertEqual(
            ["before", "after"],
            wiki_markdown.extract_wikilinks(body),
        )


class SharedImplementationTests(unittest.TestCase):
    """One parser and one corpus definition, imported rather than re-declared."""

    TOOLS = (wiki_lint, wiki_search, wiki_graph_extract, wiki_graph_lint, wiki_stats)

    def test_all_tools_share_the_same_extractor(self):
        # Each script used to carry its own WIKILINK_RE, so a fix to one left
        # the other four reporting different links for the same page.
        for module in self.TOOLS:
            with self.subTest(module=module.__name__):
                self.assertIs(wiki_markdown.extract_wikilinks, module.extract_wikilinks)

    def test_all_tools_share_one_exclusion_set(self):
        # The five copies had already diverged: only wiki_search.py knew about
        # .wiki-cache. A page one tool indexes and another ignores is a silent
        # inconsistency, and it surfaces far from its cause.
        for module in self.TOOLS:
            with self.subTest(module=module.__name__):
                self.assertIs(wiki_markdown.SKIP_TOP_LEVEL_DIRS, module.SKIP_TOP_LEVEL_DIRS)

    def test_excluded_directories_are_named_not_guessed(self):
        self.assertEqual(
            {"indexes", "graph", "raw", "Clippings", ".wiki-cache"},
            set(wiki_markdown.SKIP_TOP_LEVEL_DIRS))

    def test_clippings_are_scratch_input_not_pages(self):
        # Saved web material lands in wiki/Clippings/ as raw input for ingest.
        # Left in the corpus it is indexed and embedded like a curated page.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            (root / "concepts").mkdir(parents=True)
            (root / "concepts" / "alpha.md").write_text(
                "---\ntype: concept\ntitle: Alpha\n---\n\n# Alpha\n\nGamma.\n",
                encoding="utf-8")
            (root / "Clippings").mkdir(parents=True)
            (root / "Clippings" / "saved.md").write_text(
                "---\ntitle: Saved page\n---\n\n# Saved\n\nGamma delta epsilon.\n",
                encoding="utf-8")

            pages = wiki_search.collect_pages(root)

            self.assertEqual(1, len(pages))
            self.assertTrue(pages[0]["rel_path"].endswith("alpha.md"))


if __name__ == "__main__":
    unittest.main()
