---
description: Show wiki size, shape, and link density, and which scaling threshold the wiki is at.
---

Resolve `<WIKI_ROOT>` from an explicit user path, the nearest project instructions, global agent instructions, or finally the current project's `wiki/`. Then run `python "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_stats.py" "<WIKI_ROOT>"` and present the output to me with a brief interpretation:

- If the wiki is approaching a scaling threshold (150 pages / 300-line index for sharding, 300 pages for routine search-script use, 500 pages for weekly lint cadence), call it out and explain what the migration would involve.
- If any pages are over the soft cap (400 lines) or hard cap (800 lines), recommend splitting them.
- If the link density looks low (< 1.5 links/page on average), the wiki may be under-cross-referenced: suggest a lint pass with `--suggest-pages` to find concepts that should be promoted.

For migration procedures, read `skills/llm-wiki/references/scaling-playbook.md`.

**Hosted wiki.** If the resolved wiki is a hosted URL (or the instructions name one), use hosted mode from `skills/llm-wiki/references/hosted-mode.md`: the MCP tools, or `python3 "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_remote.py"` when MCP is not available. Get the numbers with `python3 "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_remote.py" stats`. Without a shell, use the counts in `wiki_overview`. Also report `vector_lag`, the search mode and the open review flags. Index sharding and page caps apply the same way.
