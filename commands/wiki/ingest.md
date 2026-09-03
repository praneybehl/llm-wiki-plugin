---
description: Ingest a source (paper, article, transcript, PDF, notes) into the LLM Wiki.
argument-hint: "<source-path-or-url-or-description>"
---

Ingest the source into the wiki using the `llm-wiki` skill's ingest workflow.

Source: $ARGUMENTS

Follow the full ingest procedure documented in the skill:

0. Resolve `<WIKI_ROOT>` and `<RAW_ROOT>` from an explicit user path, the nearest project instructions, global agent instructions, or finally the current project's `wiki/` and `raw/`. Never assume `${PWD}/wiki` when instructions name another wiki, and never combine two wikis silently.
1. Read `<WIKI_ROOT>/SCHEMA.md` first if you haven't this session — it may override default conventions.
2. Place the raw source in `<RAW_ROOT>/` if it isn't already there. Use a slugified filename.
3. Read the source. Chunk-read if it's large (over ~5000 words / a long PDF) — never load the whole thing into context if it would consume more than ~25% of the context window.
4. Briefly discuss the key takeaways with me before writing anything to the wiki — what stands out, what connects to existing pages, what's surprising.
5. Survey the wiki to identify which existing pages this source touches; read each candidate to confirm.
6. Write the source-summary page in `<WIKI_ROOT>/sources/`, surgically update touched entity/concept pages with `str_replace`, create new pages for new entities/concepts (each with at least one inbound link), update the index, append one line to `log.md`.
7. If `<WIKI_ROOT>/graph/ontology.yaml` exists and the ingest added or could add typed `graph.relationships[]`: add typed edges only when the source explicitly supports them (predicate, source-page slug, evidence quote, confidence, status). Then run `uv run --script "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_graph_lint.py" "<WIKI_ROOT>"`, triage findings with me, and run `uv run --script "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_graph_extract.py" "<WIKI_ROOT>"`. Append a `   graph: +N nodes, +M typed edges` sub-line under the ingest entry in `log.md`.
8. Tell me what you did when you're done: pages touched, pages created, contradictions flagged, follow-ups worth investigating.

If the wiki doesn't exist yet, suggest `/wiki:init --global` for one personal cross-project wiki or `/wiki:init` for a project wiki.
