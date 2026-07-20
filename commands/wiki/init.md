---
description: Initialize a new LLM Wiki structure in this project (creates wiki/ and raw/ directories with templates).
argument-hint: "[--wiki-dir <name>] [--raw-dir <name>]"
---

Initialize a new LLM Wiki in the current project. Use the `llm-wiki` skill to:

1. Open `skills/llm-wiki/references/retrieval-setup.md` and ask its setup questions in one grouped interaction: wiki/raw paths, retrieval mode, whether to build embeddings now or later, graph usage, and agent-memory integration. Present local lexical BM25 as the recommended no-key default. Never ask me to paste a secret into chat.
2. Inspect only whether embedding environment variables and `wiki/.wiki-cache/embeddings.jsonl` exist. Report a present key as "configured, not API-validated" unless a real request has succeeded. Report the wiki as "embedded" only when the vector cache exists and a hybrid query has been observed.
3. After I answer, run `python skills/llm-wiki/scripts/init_wiki.py .` from the plugin's skill directory, using my selected paths.
4. Walk me through the bootstrapped `SCHEMA.md` and ask whether I want to customize page types, tags, or workflow conventions. Record my non-secret retrieval choice under `## Retrieval` only with approval.
5. If I selected hybrid retrieval, explain before asking for approval that the first build sends all canonical section text, every hybrid query sends its query text, and new or changed sections are sent when their vectors are missing; these provider requests may be billable. Then ask for explicit approval before the first build. Only after approval, run that first search with `--approve-embedding-build`; later same-provider searches omit the flag and embed only changed sections. Tell me which environment variables to set through my shell or secret manager, but never collect or store their values.
6. Propose the approved agent-memory integration using `references/agent-memory-integration.md`. Show the exact addition and ask whether to append, create, or skip. Never write without approval.
7. Do not ingest a source yet. This command only completes an informed setup.

Arguments (if any): $ARGUMENTS
