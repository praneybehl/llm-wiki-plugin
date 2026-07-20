#!/usr/bin/env python3
"""Regression tests for persisted embedding consent."""

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from unittest import mock
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
SEARCH = REPO / "skills" / "llm-wiki" / "scripts" / "wiki_search.py"
SPEC = importlib.util.spec_from_file_location("wiki_search", SEARCH)
WIKI_SEARCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WIKI_SEARCH)


class EmbeddingModeTests(unittest.TestCase):
    def run_search(
        self,
        mode: str | None,
        *,
        no_embed: bool = False,
        endpoint: bool = True,
        endpoint_url: str | None = None,
        approve_build: bool = False,
    ):
        with tempfile.TemporaryDirectory() as tmp:
            wiki = Path(tmp)
            (wiki / "concepts").mkdir()
            (wiki / "concepts" / "retrieval.md").write_text(
                "---\ntype: concept\ntitle: Retrieval\ntags: [search]\n"
                "created: 2026-07-20\nupdated: 2026-07-20\n---\n\n"
                "# Retrieval\n\nLexical retrieval finds exact words.\n",
                encoding="utf-8",
            )
            if mode is not None:
                (wiki / "SCHEMA.md").write_text(
                    f"# Schema\n\n## Retrieval\n\n- Embedding mode: `{mode}`.\n",
                    encoding="utf-8",
                )

            env = os.environ.copy()
            for name in ("OPENAI_API_KEY", "LLM_WIKI_EMBED_URL", "LLM_WIKI_EMBED_KEY", "LLM_WIKI_EMBED_MODEL"):
                env.pop(name, None)
            if endpoint:
                env["LLM_WIKI_EMBED_URL"] = endpoint_url or "http://127.0.0.1:9/embeddings"
                env["LLM_WIKI_EMBED_MODEL"] = "test-model"

            command = ["python3", str(SEARCH), "lexical retrieval", "--wiki", str(wiki), "--json"]
            if no_embed:
                command.append("--no-embed")
            if approve_build:
                command.append("--approve-embedding-build")
            result = subprocess.run(command, env=env, capture_output=True, text=True, check=True)
            return json.loads(result.stdout), result.stderr

    def test_lexical_mode_ignores_configured_endpoint(self):
        payload, stderr = self.run_search("lexical")
        self.assertEqual(payload["mode"], "lexical")
        self.assertEqual(stderr, "")

    def test_missing_mode_defaults_to_local_only(self):
        payload, stderr = self.run_search(None)
        self.assertEqual(payload["mode"], "lexical")
        self.assertEqual(stderr, "")

    def test_hybrid_mode_without_backend_falls_back_cleanly(self):
        payload, stderr = self.run_search("openai", endpoint=False)
        self.assertEqual(payload["mode"], "lexical")
        self.assertIn("provider is not configured", stderr)

    def test_no_embed_overrides_hybrid_mode(self):
        payload, stderr = self.run_search("custom", no_embed=True)
        self.assertEqual(payload["mode"], "lexical")
        self.assertEqual(stderr, "")

    @mock.patch.dict(
        os.environ,
        {
            "OPENAI_API_KEY": "openai-approved-key",
            "LLM_WIKI_EMBED_URL": "https://custom.invalid/embeddings",
            "LLM_WIKI_EMBED_KEY": "custom-key",
            "LLM_WIKI_EMBED_MODEL": "approved-model",
        },
        clear=True,
    )
    def test_openai_mode_ignores_custom_provider_config(self):
        config = WIKI_SEARCH.embed_config("openai")
        self.assertEqual(config["url"], "https://api.openai.com/v1/embeddings")
        self.assertEqual(config["key"], "openai-approved-key")

    @mock.patch.dict(
        os.environ,
        {
            "OPENAI_API_KEY": "must-not-be-reused",
            "LLM_WIKI_EMBED_URL": "https://custom.example/embeddings",
            "LLM_WIKI_EMBED_MODEL": "custom-model",
        },
        clear=True,
    )
    def test_custom_mode_never_falls_back_to_openai_key(self):
        config = WIKI_SEARCH.embed_config("custom")
        self.assertEqual(config["url"], "https://custom.example/embeddings")
        self.assertIsNone(config["key"])

    @mock.patch.dict(
        os.environ,
        {
            "OPENAI_API_KEY": "must-not-enable-custom",
            "LLM_WIKI_EMBED_MODEL": "custom-model",
        },
        clear=True,
    )
    def test_custom_mode_requires_custom_endpoint(self):
        self.assertIsNone(WIKI_SEARCH.embed_config("custom"))

    @mock.patch.dict(
        os.environ,
        {
            "LLM_WIKI_EMBED_URL": "https://custom.example/embeddings",
            "LLM_WIKI_EMBED_KEY": "must-not-enable-openai",
            "LLM_WIKI_EMBED_MODEL": "custom-model",
        },
        clear=True,
    )
    def test_openai_mode_requires_openai_key(self):
        self.assertIsNone(WIKI_SEARCH.embed_config("openai"))

    def test_embedding_cache_isolated_by_provider(self):
        sections = [{"searchable_text": "same model and text"}]
        openai = {
            "provider": "openai",
            "url": "https://api.openai.com/v1/embeddings",
            "key": "openai-key",
            "model": "shared-model",
        }
        custom = {
            "provider": "custom",
            "url": "https://custom.example/embeddings",
            "key": "custom-key",
            "model": "shared-model",
        }
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(
                WIKI_SEARCH,
                "embed_texts",
                side_effect=[[[1.0, 0.0]], [[0.0, 1.0]]],
            ) as embed:
                self.assertEqual(
                    WIKI_SEARCH.section_vectors(sections, Path(tmp), openai, approve_build=True),
                    [[1.0, 0.0]],
                )
                self.assertEqual(
                    WIKI_SEARCH.section_vectors(sections, Path(tmp), custom, approve_build=True),
                    [[0.0, 1.0]],
                )
                self.assertEqual(embed.call_count, 2)

    def test_provider_switch_requires_build_approval(self):
        sections = [{"searchable_text": "same model and text"}]
        openai = {
            "provider": "openai",
            "url": "https://api.openai.com/v1/embeddings",
            "key": "openai-key",
            "model": "shared-model",
        }
        custom = {
            "provider": "custom",
            "url": "https://custom.example/embeddings",
            "key": "custom-key",
            "model": "shared-model",
        }
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(
                WIKI_SEARCH,
                "embed_texts",
                return_value=[[1.0, 0.0]],
            ) as embed:
                WIKI_SEARCH.section_vectors(
                    sections,
                    Path(tmp),
                    openai,
                    approve_build=True,
                )
                with self.assertRaises(WIKI_SEARCH.EmbeddingBuildApprovalError):
                    WIKI_SEARCH.section_vectors(sections, Path(tmp), custom)
                self.assertEqual(embed.call_count, 1)

    def test_approved_provider_embeds_only_changed_sections(self):
        original = [{"searchable_text": "original section"}]
        expanded = [*original, {"searchable_text": "new section"}]
        config = {
            "provider": "custom",
            "url": "https://custom.example/embeddings",
            "key": None,
            "model": "shared-model",
        }
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(
                WIKI_SEARCH,
                "embed_texts",
                side_effect=[[[1.0, 0.0]], [[0.0, 1.0]]],
            ) as embed:
                WIKI_SEARCH.section_vectors(
                    original,
                    Path(tmp),
                    config,
                    approve_build=True,
                )
                vectors = WIKI_SEARCH.section_vectors(expanded, Path(tmp), config)
                self.assertEqual(vectors, [[1.0, 0.0], [0.0, 1.0]])
                self.assertEqual(embed.call_count, 2)

    def test_approved_one_section_wiki_can_reembed_after_edit(self):
        original = [{"searchable_text": "original section"}]
        edited = [{"searchable_text": "edited section"}]
        config = {
            "provider": "custom",
            "url": "https://custom.example/embeddings",
            "key": None,
            "model": "shared-model",
        }
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(
                WIKI_SEARCH,
                "embed_texts",
                side_effect=[[[1.0, 0.0]], [[0.0, 1.0]]],
            ) as embed:
                WIKI_SEARCH.section_vectors(
                    original,
                    Path(tmp),
                    config,
                    approve_build=True,
                )
                vectors = WIKI_SEARCH.section_vectors(edited, Path(tmp), config)
                self.assertEqual(vectors, [[0.0, 1.0]])
                self.assertEqual(embed.call_count, 2)

    def test_new_cache_requires_cli_build_approval(self):
        with tempfile.TemporaryDirectory() as tmp:
            wiki = Path(tmp)
            (wiki / "concepts").mkdir()
            (wiki / "SCHEMA.md").write_text(
                "# Schema\n\n## Retrieval\n\n- Embedding mode: `custom`.\n",
                encoding="utf-8",
            )
            (wiki / "concepts" / "retrieval.md").write_text(
                "---\ntype: concept\ntitle: Retrieval\ntags: [search]\n"
                "created: 2026-07-20\nupdated: 2026-07-20\n---\n\n"
                "# Retrieval\n\nLexical retrieval finds exact words.\n",
                encoding="utf-8",
            )
            env = os.environ.copy()
            for name in ("OPENAI_API_KEY", "LLM_WIKI_EMBED_KEY"):
                env.pop(name, None)
            env["LLM_WIKI_EMBED_URL"] = "http://127.0.0.1:9/embeddings"
            env["LLM_WIKI_EMBED_MODEL"] = "shared-model"

            result = subprocess.run(
                ["python3", str(SEARCH), "lexical retrieval", "--wiki", str(wiki), "--json"],
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )

            self.assertEqual(json.loads(result.stdout)["mode"], "lexical")
            self.assertIn("requires explicit approval", result.stderr)
            self.assertIn("--approve-embedding-build", result.stderr)
            self.assertNotIn("embedding 1 new sections", result.stderr)
            self.assertFalse((wiki / ".wiki-cache" / "embeddings.jsonl").exists())

    def test_embedding_cache_normalizes_trailing_url_slash(self):
        base = {
            "provider": "custom",
            "url": "https://custom.example/embeddings",
            "key": None,
            "model": "shared-model",
        }
        trailing = {**base, "url": f"{base['url']}/"}
        self.assertEqual(
            WIKI_SEARCH.section_embedding_key(base, "text"),
            WIKI_SEARCH.section_embedding_key(trailing, "text"),
        )

    def test_cache_never_persists_custom_endpoint_or_credentials(self):
        config = {
            "provider": "custom",
            "url": "https://user:secret@custom.example/embeddings?token=signed",
            "key": "secret-key",
            "model": "shared-model",
        }
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(
                WIKI_SEARCH,
                "embed_texts",
                return_value=[[1.0, 0.0]],
            ):
                WIKI_SEARCH.section_vectors(
                    [{"searchable_text": "section"}],
                    Path(tmp),
                    config,
                    approve_build=True,
                )
            cache = (
                Path(tmp) / ".wiki-cache" / "embeddings.jsonl"
            ).read_text(encoding="utf-8")
            self.assertNotIn(config["url"], cache)
            self.assertNotIn("user:secret", cache)
            self.assertNotIn("signed", cache)
            self.assertIn("provider_fingerprint", cache)

    def test_backend_failure_never_echoes_endpoint_credentials(self):
        payload, stderr = self.run_search(
            "custom",
            endpoint_url=(
                "https://user:secret@custom.example/embeddings?token=signed"
            ),
            approve_build=True,
        )
        self.assertEqual(payload["mode"], "lexical")
        self.assertIn("embedding backend failed", stderr)
        self.assertNotIn("user:secret", stderr)
        self.assertNotIn("signed", stderr)

    def test_legacy_cache_requires_approved_rebuild(self):
        with tempfile.TemporaryDirectory() as tmp:
            wiki = Path(tmp)
            (wiki / "concepts").mkdir()
            (wiki / ".wiki-cache").mkdir()
            (wiki / "SCHEMA.md").write_text(
                "# Schema\n\n## Retrieval\n\n- Embedding mode: `custom`.\n",
                encoding="utf-8",
            )
            (wiki / "concepts" / "retrieval.md").write_text(
                "---\ntype: concept\ntitle: Retrieval\ntags: [search]\n"
                "created: 2026-07-20\nupdated: 2026-07-20\n---\n\n"
                "# Retrieval\n\nLexical retrieval finds exact words.\n",
                encoding="utf-8",
            )
            cache = wiki / ".wiki-cache" / "embeddings.jsonl"
            legacy = '{"key":"legacy","model":"shared-model","vec":[1.0,0.0]}\n'
            cache.write_text(legacy, encoding="utf-8")
            env = os.environ.copy()
            for name in ("OPENAI_API_KEY", "LLM_WIKI_EMBED_KEY"):
                env.pop(name, None)
            env["LLM_WIKI_EMBED_URL"] = "http://127.0.0.1:9/embeddings"
            env["LLM_WIKI_EMBED_MODEL"] = "shared-model"

            result = subprocess.run(
                ["python3", str(SEARCH), "lexical retrieval", "--wiki", str(wiki), "--json"],
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )

            self.assertEqual(json.loads(result.stdout)["mode"], "lexical")
            self.assertIn("legacy embedding cache detected", result.stderr)
            self.assertIn("approve a full rebuild", result.stderr)
            self.assertNotIn("embedding 1 new sections", result.stderr)
            self.assertEqual(cache.read_text(encoding="utf-8"), legacy)

    def test_v2_cache_with_raw_endpoint_is_legacy(self):
        config = {
            "provider": "custom",
            "url": "https://user:secret@custom.example/embeddings?token=signed",
            "key": "secret-key",
            "model": "shared-model",
        }
        legacy = (
            '{"cache_version":2,"provider":"custom",'
            '"endpoint":"https://user:secret@custom.example/embeddings?token=signed",'
            '"key":"legacy","model":"shared-model","vec":[1.0,0.0]}\n'
            '{"cache_version":2,"kind":"provider_marker","provider":"custom",'
            '"endpoint":"https://user:secret@custom.example/embeddings?token=signed",'
            '"model":"shared-model","provider_identity":"raw-identity"}\n'
        )
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "embeddings.jsonl"
            cache.write_text(legacy, encoding="utf-8")
            vectors, legacy_only, provider_approved = (
                WIKI_SEARCH.load_embedding_cache(cache, config)
            )
            self.assertEqual(vectors, {})
            self.assertTrue(legacy_only)
            self.assertFalse(provider_approved)
            self.assertEqual(cache.read_text(encoding="utf-8"), legacy)

    def test_mixed_v2_v3_cache_stays_blocked_until_rebuild(self):
        config = {
            "provider": "custom",
            "url": "https://custom.example/embeddings",
            "key": None,
            "model": "shared-model",
        }
        sections = [{"searchable_text": "section"}]
        fingerprint = WIKI_SEARCH.embedding_provider_fingerprint(config)
        key = WIKI_SEARCH.section_embedding_key(config, "section")
        rows = (
            '{"cache_version":2,"endpoint":"https://user:secret@example.test",'
            '"key":"legacy","vec":[1.0,0.0]}\n'
            f'{{"cache_version":3,"kind":"provider_marker",'
            f'"provider_fingerprint":"{fingerprint}"}}\n'
            f'{{"cache_version":3,"key":"{key}","vec":[1.0,0.0]}}\n'
        )
        with tempfile.TemporaryDirectory() as tmp:
            wiki = Path(tmp)
            cache = wiki / ".wiki-cache" / "embeddings.jsonl"
            cache.parent.mkdir()
            cache.write_text(rows, encoding="utf-8")
            with mock.patch.object(WIKI_SEARCH, "embed_texts") as embed:
                with self.assertRaises(WIKI_SEARCH.LegacyEmbeddingCacheError):
                    WIKI_SEARCH.section_vectors(
                        sections,
                        wiki,
                        config,
                        approve_build=True,
                    )
            embed.assert_not_called()
            self.assertEqual(cache.read_text(encoding="utf-8"), rows)


if __name__ == "__main__":
    unittest.main()
