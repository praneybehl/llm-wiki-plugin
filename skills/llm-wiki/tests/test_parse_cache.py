"""The parse cache and the vector index are shared artifacts, so their keys
and hashes must not encode the machine that built them.

Both halves are load-bearing once ``embeddings.sqlite`` is committed: a section
is addressed by ``<rel_path>\x1f<index>`` and validated by a content hash, so a
native path separator or a CRLF checkout makes every section of a fresh clone
look new and triggers a full re-embed of the corpus.
"""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import wiki_search  # noqa: E402


PAGE = "---\ntype: concept\ntitle: Alpha\n---\n\n# Alpha\n\nGamma delta.\n\n## Beta\n\nEpsilon.\n"


def build_wiki(root: Path, text: str = PAGE, newline: str = "\n") -> Path:
    page = root / "concepts" / "alpha.md"
    page.parent.mkdir(parents=True, exist_ok=True)
    page.write_bytes(text.replace("\n", newline).encode("utf-8"))
    return page


class PortableLocatorTests(unittest.TestCase):
    """The committed vector index is keyed by locator, so it must be OS-neutral."""

    def test_rel_path_is_posix_on_every_platform(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root)

            page = wiki_search.collect_pages(root)[0]

            self.assertEqual("concepts/alpha.md", page["rel_path"])
            self.assertNotIn("\\", page["rel_path"])

    def test_section_locator_has_no_native_separators(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root)

            sections = wiki_search.collect_sections(wiki_search.collect_pages(root))

            for section in sections:
                with self.subTest(section=section["heading_path"]):
                    self.assertTrue(
                        wiki_search.section_locator(section).startswith("concepts/alpha.md"))
                    self.assertNotIn("\\", wiki_search.section_locator(section))


class NewlineNeutralIdentityTests(unittest.TestCase):
    """A CRLF checkout and an LF checkout of one commit are the same corpus."""

    def test_crlf_and_lf_checkouts_agree_on_every_content_hash(self):
        with tempfile.TemporaryDirectory() as lf_dir, tempfile.TemporaryDirectory() as crlf_dir:
            lf_root, crlf_root = Path(lf_dir) / "wiki", Path(crlf_dir) / "wiki"
            build_wiki(lf_root, newline="\n")
            build_wiki(crlf_root, newline="\r\n")

            def hashes(root: Path) -> list[str]:
                pages = wiki_search.collect_pages(root)
                return [wiki_search.section_content_hash(section)
                        for section in wiki_search.collect_sections(pages)]

            self.assertEqual(hashes(lf_root), hashes(crlf_root))

    def test_a_crlf_page_survives_the_cache_round_trip(self):
        # The cache rebuilds a body by joining sections on "\n". Without
        # normalization the reconstruction differs from the cold parse, so a
        # warm run and a cold run disagree about the page they just indexed.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root, newline="\r\n")
            cache = root / ".wiki-cache" / "search-index.json"

            cold = wiki_search.collect_pages(root)
            wiki_search.collect_pages(root, cache)
            warm = wiki_search.collect_pages(root, cache)

            self.assertEqual(cold[0]["body"].strip(), warm[0]["body"].strip())
            self.assertNotIn("\r", warm[0]["body"])


class ParseCacheRoundTripTests(unittest.TestCase):
    @staticmethod
    def state(pages: list[dict]) -> list[tuple]:
        # Everything retrieval consumes must survive the round trip. `body` is a
        # reconstruction, not a byte-exact copy, so it is compared stripped; the
        # section text it is rebuilt from is compared verbatim. The leading
        # newline it can gain comes from the empty preamble section the splitter
        # emits for a page opening with a heading -- a separate defect, fixed
        # where sections are split rather than papered over here.
        return [
            (p["slug"], p["rel_path"], p["meta"], p["links"],
             [(s["heading_path"], s["level"], s["text"]) for s in p["sections"]],
             p["body"].strip())
            for p in pages
        ]

    def test_cached_run_matches_a_cold_run(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root)
            cache = root / ".wiki-cache" / "search-index.json"

            cold = wiki_search.collect_pages(root)
            built = wiki_search.collect_pages(root, cache)
            self.assertTrue(cache.exists())
            warm = wiki_search.collect_pages(root, cache)

            self.assertEqual(self.state(cold), self.state(built))
            self.assertEqual(self.state(cold), self.state(warm))

    def test_cache_keys_are_posix_so_another_os_can_reuse_them(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root)
            cache = root / ".wiki-cache" / "search-index.json"
            wiki_search.collect_pages(root, cache)

            payload = json.loads(cache.read_text(encoding="utf-8"))

            self.assertEqual(["concepts/alpha.md"], sorted(payload["files"]))

    def test_cached_digest_is_of_the_normalized_text_not_the_raw_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root, newline="\r\n")
            cache = root / ".wiki-cache" / "search-index.json"
            wiki_search.collect_pages(root, cache)

            payload = json.loads(cache.read_text(encoding="utf-8"))

            self.assertEqual(
                hashlib.sha256(PAGE.encode("utf-8")).hexdigest(),
                payload["files"]["concepts/alpha.md"]["sha256"],
            )

    def test_current_schema_cache_is_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root)
            cache = root / ".wiki-cache" / "search-index.json"
            wiki_search.collect_pages(root, cache)

            payload = json.loads(cache.read_text(encoding="utf-8"))

            self.assertEqual(wiki_search.PARSE_CACHE_SCHEMA, payload["schema"])
            self.assertEqual(
                [s["heading_path"] for s in wiki_search.collect_pages(root)[0]["sections"]],
                [s["heading_path"] for s in wiki_search.collect_pages(root, cache)[0]["sections"]],
            )

    def test_cache_from_an_older_parser_is_discarded(self):
        # Entries are keyed by file hash, so an unchanged page would keep
        # serving output built by the previous parser. Only the schema version
        # can catch that, which is why it must move with the representation.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            page = build_wiki(root)
            cache = root / ".wiki-cache" / "search-index.json"
            digest = hashlib.sha256(page.read_bytes()).hexdigest()
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps({
                "schema": wiki_search.PARSE_CACHE_SCHEMA - 1,
                "files": {"concepts/alpha.md": {
                    "sha256": digest,
                    "meta": {"type": "concept", "title": "Alpha"},
                    "links": [],
                    "sections": [{"heading_path": ["STALE"], "level": 1,
                                  "text": "cached old parser output"}],
                }},
            }), encoding="utf-8")

            pages = wiki_search.collect_pages(root, cache)

            self.assertNotIn(
                ["STALE"], [s["heading_path"] for s in pages[0]["sections"]])
            self.assertNotIn("cached old parser output", pages[0]["body"])
            self.assertEqual(
                wiki_search.PARSE_CACHE_SCHEMA,
                json.loads(cache.read_text(encoding="utf-8"))["schema"],
            )

    def test_edited_page_invalidates_its_cache_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "wiki"
            build_wiki(root)
            cache = root / ".wiki-cache" / "search-index.json"
            wiki_search.collect_pages(root, cache)

            build_wiki(root, "---\ntype: concept\ntitle: Alpha\n---\n\n# Alpha\n\nRewritten omega.\n")
            reparsed = wiki_search.collect_pages(root, cache)

            self.assertIn("Rewritten omega.", reparsed[0]["body"])


if __name__ == "__main__":
    unittest.main()
