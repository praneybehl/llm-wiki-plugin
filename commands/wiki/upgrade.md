---
description: Upgrade an existing global or project LLM Wiki to the current plugin version.
argument-hint: "[--global] [--wiki-dir <name>] [--raw-dir <name>]"
---

Upgrade the selected wiki to the current plugin version. Use the `llm-wiki` skill.

Arguments (if any): $ARGUMENTS

1. Resolve `<WIKI_ROOT>` and `<RAW_ROOT>` from `--global`, explicit paths, the nearest project instructions, global agent instructions, or finally the current project's `wiki/` and `raw/`. Confirm the wiki exists. If it is missing, suggest the matching `/wiki:init --global` or `/wiki:init` instead.
2. Run `init_wiki.py` against the base directory and relative wiki/raw paths that resolve to those exact roots. For the standard global layout, use `python "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/init_wiki.py" "<absolute-home-directory>" --wiki-dir wiki --raw-dir wiki/raw --upgrade`. For the project default, use the absolute project root with `--upgrade`. Never run it against the plugin directory. Do not report the upgrade complete unless its runtime JSON says `"status": "ready"`.
3. Read the script's "Upgrade required: <SCHEMA.md>" output. For each missing SCHEMA.md section it lists:
   - Open `skills/llm-wiki/assets/SCHEMA.md.template` and locate the section with the matching heading.
   - Show me the section content and propose appending it to my SCHEMA.md via `str_replace`. Wait for my approval per section. Never modify SCHEMA.md silently — it is co-evolved with me.
   - If my SCHEMA.md has been customized in a way that would conflict, surface the conflict and ask me how to resolve it (skip, append at end, or hand-merge).
4. After all sections are merged or skipped, mention that:
   - The graph layer is opt-in. Existing pages without `graph:` frontmatter remain valid; nothing breaks.
   - To start using it on a page, add typed `graph.relationships[]` only when an explicit source supports them — see `skills/llm-wiki/references/graph-workflow.md`.
   - Graph lint and extraction carry pinned PyYAML metadata and run through `uv run --script`; no manual `pip install` is needed.

   **v3.0.0 notes** (mention these too):
   - Existing pages and frontmatter need no migration. The old provider-backed `embeddings.jsonl` cache is ignored; it is safe to delete because all vectors are derived.
   - The default section search is now local hybrid retrieval: FastEmbed `BAAI/bge-small-en-v1.5` + sqlite-vec, fused with BM25 through RRF. No API keys, remote endpoints, provider consent, or per-query charges remain.
   - `wiki/.wiki-cache/embeddings.sqlite` stores section locators, content hashes, and vectors. New or changed sections are embedded incrementally; deleted sections are removed; schema/model changes rebuild automatically.
   - Initial setup and every upgrade run `setup_wiki.py` automatically through `uv`, installing the complete pinned runtime and synchronizing all vectors. Model artifacts live under `~/.cache/llm-wiki/fastembed/`.
   - `python "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_search.py" "<query>" --wiki "<WIKI_ROOT>" --no-embed` forces dependency-free lexical BM25. Missing packages, model initialization errors, and sqlite-vec load failures also fall back to lexical mode without breaking query output.
   - Search remains section-level and shows section headings (a `§` line). Pass `--granularity page` to restore whole-page lexical ranking.
   - Merge the `[3.0.0] Local semantic retrieval` marker from the current template into an existing `## Retrieval` section after showing it for approval.
5. If the selected wiki's global or project agent-memory stanza was set up by an older `/wiki:init` and does not mention the graph layer, ask me whether to add a one-line pointer like:

   > Relational queries can also consult `wiki/graph/graph.sqlite` via `wiki_graph_query.py` from the `llm-wiki` skill.

   Show the proposed addition, get approval, then `str_replace` it in. Honour a "skip" without pushing.
6. Do not run `wiki_graph_extract.py` automatically — it does nothing useful until at least one page has `graph:` metadata. Mention it as the next step when I'm ready.
