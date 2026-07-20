---
description: Upgrade an existing LLM Wiki to the current plugin version (adds missing files idempotently; walks me through any SCHEMA.md merges by hand).
argument-hint: "[--wiki-dir <name>] [--raw-dir <name>]"
---

Upgrade the wiki in this project to the current plugin version. Use the `llm-wiki` skill.

Arguments (if any): $ARGUMENTS

1. Confirm the wiki exists. If `wiki/` (or whatever the user calls it) is missing, suggest `/wiki:init` instead — there's nothing to upgrade.
2. Run `python skills/llm-wiki/scripts/init_wiki.py . --upgrade` (with `--wiki-dir` / `--raw-dir` if I'm using non-default names). This is idempotent: it adds missing files (`wiki/graph/ontology.yaml`, `wiki/graph/README.md`, `wiki/graph/.gitignore`, `wiki/.wiki-cache/.gitignore`) without touching anything that already exists.
3. Read the script's "Upgrade required: <SCHEMA.md>" output. For each missing SCHEMA.md section it lists:
   - Open `skills/llm-wiki/assets/SCHEMA.md.template` and locate the section with the matching heading.
   - Show me the section content and propose appending it to my SCHEMA.md via `str_replace`. Wait for my approval per section. Never modify SCHEMA.md silently — it is co-evolved with me.
   - If my SCHEMA.md has been customized in a way that would conflict, surface the conflict and ask me how to resolve it (skip, append at end, or hand-merge).
4. After all sections are merged or skipped, mention that:
   - The graph layer is opt-in. Existing pages without `graph:` frontmatter remain valid; nothing breaks.
   - To start using it on a page, add typed `graph.relationships[]` only when an explicit source supports them — see `skills/llm-wiki/references/graph-workflow.md`.
   - The graph scripts require PyYAML (`pip install pyyaml`); the original four scripts remain stdlib-only.

   **v2.0.0 notes** (mention these too):
   - Existing pages need no changes — no page or frontmatter format changed. The entire upgrade is: pull v2.0.0, run `/wiki:upgrade` (or `python skills/llm-wiki/scripts/init_wiki.py . --upgrade`), and approve the one SCHEMA.md `## Retrieval` section merge. There is **no content migration**.
   - The new `## Retrieval` SCHEMA section is walked exactly like the graph sections above — shown to you and appended only on approval, never silently.
   - `wiki/.wiki-cache/` holds regenerable retrieval artifacts (parse cache, embedding vectors). It's gitignored and safe to delete at any time.
   - Embeddings are opt-in: hybrid retrieval activates only when `LLM_WIKI_EMBED_URL` (or `OPENAI_API_KEY`) is set, optionally with `LLM_WIKI_EMBED_KEY` and `LLM_WIKI_EMBED_MODEL` (default `text-embedding-3-small`). Without them search stays lexical BM25 exactly as before; `--no-embed` forces lexical.
   - Search output is now section-level and shows section headings (a `§` line). Pass `--granularity page` to restore the old whole-page ranking.
5. If my project's agent-memory file (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`) was set up by an older `/wiki:init` and does not mention the graph layer, ask me whether to add a one-line pointer like:

   > Relational queries can also consult `wiki/graph/graph.sqlite` via `wiki_graph_query.py` from the `llm-wiki` skill.

   Show the proposed addition, get approval, then `str_replace` it in. Honour a "skip" without pushing.
6. Do not run `wiki_graph_extract.py` automatically — it does nothing useful until at least one page has `graph:` metadata. Mention it as the next step when I'm ready.
