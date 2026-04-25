---
description: Initialize a new LLM Wiki structure in this project (creates wiki/ and raw/ directories with templates).
argument-hint: "[--wiki-dir <name>] [--raw-dir <name>]"
---

Initialize a new LLM Wiki in the current project. Use the `llm-wiki` skill to:

1. Confirm with me where the wiki should live (default: `wiki/` and `raw/` at the project root).
2. Run `python skills/llm-wiki/scripts/init_wiki.py .` from the plugin's skill directory (or with the appropriate arguments if I specified non-default directory names).
3. Walk me through the bootstrapped `SCHEMA.md` and ask whether I want to customize anything — page types, tag taxonomy, custom workflow conventions — before the first ingest. Mention that the optional graph layer was seeded under `wiki/graph/` (with `ontology.yaml`, a `README.md` explaining canonical-vs-generated artifacts, and a `.gitignore`) and offer to walk through `ontology.yaml` if I want to add domain-specific predicates.
4. Propose an agent-memory integration. Ask me which agent(s) I run in this project (Claude Code → `CLAUDE.md`; Codex / Cursor / OpenCode / Pi / OpenClaw → `AGENTS.md`; Gemini CLI → `GEMINI.md`; if unsure or multi-agent, default to `AGENTS.md`). Show me the canonical wiki stanza from `references/agent-memory-integration.md`, ask whether to append it to an existing memory file, create a new one, or skip. Never write without my approval. If the file already contains an LLM Wiki stanza, show me the diff before changing anything.
5. Don't proceed to ingest anything yet; this command only sets up the structure.

Arguments (if any): $ARGUMENTS
