---
description: Show wiki size, shape, and link density — and which scaling threshold the wiki is at.
---

Run `python skills/llm-wiki/scripts/wiki_stats.py wiki/` and present the output to me with a brief interpretation:

- If the wiki is approaching a scaling threshold (150 pages / 300-line index for sharding, 300 pages for routine search-script use, 500 pages for weekly lint cadence), call it out and explain what the migration would involve.
- If any pages are over the soft cap (400 lines) or hard cap (800 lines), recommend splitting them.
- If the link density looks low (< 1.5 links/page on average), the wiki may be under-cross-referenced — suggest a lint pass with `--suggest-pages` to find concepts that should be promoted.

For migration procedures, read `skills/llm-wiki/references/scaling-playbook.md`.
