---
description: Initialize a new LLM Wiki structure in this project (creates wiki/ and raw/ directories with templates).
argument-hint: "[--wiki-dir <name>] [--raw-dir <name>]"
---

Initialize a new LLM Wiki in the current project. Use the `llm-wiki` skill to:

1. Confirm with me where the wiki should live (default: `wiki/` and `raw/` at the project root).
2. Run `python skills/llm-wiki/scripts/init_wiki.py .` from the plugin's skill directory (or with the appropriate arguments if I specified non-default directory names).
3. Walk me through the bootstrapped `SCHEMA.md` and ask whether I want to customize anything — page types, tag taxonomy, custom workflow conventions — before the first ingest.
4. Don't proceed to ingest anything yet; this command only sets up the structure.

Arguments (if any): $ARGUMENTS
