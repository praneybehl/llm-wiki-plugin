---
description: Initialize a new LLM Wiki structure in this project (creates wiki/ and raw/ directories with templates).
argument-hint: "[--wiki-dir <name>] [--raw-dir <name>]"
---

Initialize a new LLM Wiki in the current project. Use the `llm-wiki` skill to:

1. Open `skills/llm-wiki/references/retrieval-setup.md` and ask its setup questions in one grouped interaction: wiki/raw paths, model-cache location, graph usage, and agent-memory integration.
2. Explain that initialization installs and verifies the complete local runtime through `uv`: pinned FastEmbed, sqlite-vec, PyYAML, the `BAAI/bge-small-en-v1.5` model, the parse cache, and vectors for every existing section. No API key, provider consent, per-query fee, or outbound wiki/query text is involved.
3. After I answer, resolve the current project's absolute root, then run `python "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/init_wiki.py" "<absolute-project-root>"` with my selected paths. The script path and project-root argument must remain separate; never run it against the plugin directory. Do not report setup complete unless its runtime JSON says `"status": "ready"`.
4. Walk me through the bootstrapped `SCHEMA.md` and ask whether I want to customize page types, tags, or workflow conventions.
5. Propose the approved agent-memory integration using `references/agent-memory-integration.md`. Show the exact addition and ask whether to append, create, or skip. Never write without approval.
6. Do not ingest a source yet. This command only completes an informed setup.

Arguments (if any): $ARGUMENTS
