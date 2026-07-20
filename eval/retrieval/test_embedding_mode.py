#!/usr/bin/env python3
"""Regression tests for persisted embedding consent."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
SEARCH = REPO / "skills" / "llm-wiki" / "scripts" / "wiki_search.py"


class EmbeddingModeTests(unittest.TestCase):
    def run_search(self, mode: str | None, *, no_embed: bool = False, endpoint: bool = True):
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
                env["LLM_WIKI_EMBED_URL"] = "http://127.0.0.1:9/embeddings"
                env["LLM_WIKI_EMBED_MODEL"] = "test-model"

            command = ["python3", str(SEARCH), "lexical retrieval", "--wiki", str(wiki), "--json"]
            if no_embed:
                command.append("--no-embed")
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
        self.assertIn("no backend is configured", stderr)

    def test_no_embed_overrides_hybrid_mode(self):
        payload, stderr = self.run_search("custom", no_embed=True)
        self.assertEqual(payload["mode"], "lexical")
        self.assertEqual(stderr, "")


if __name__ == "__main__":
    unittest.main()
