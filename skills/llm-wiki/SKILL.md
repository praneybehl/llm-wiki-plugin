---
name: llm-wiki
description: |
  Build and maintain an LLM-curated personal knowledge base — the "LLM Wiki" pattern from Andrej Karpathy's April 2026 gist. Use this skill whenever the user wants to ingest a source (paper, article, transcript, PDF, notes) into a persistent compounding knowledge base, ask a question against accumulated notes, lint or audit such a base, or initialize a new one. Trigger on phrases like "add this to my wiki", "ingest this paper", "compile this into the knowledge base", "what does my wiki say about X", "lint the wiki", "build a knowledge base from these documents", "research notes", "second brain", "personal knowledge base", or any reference to LLM Wiki / OmegaWiki. Trigger even when the user does not say "wiki" — if they are accumulating sources over time and want them organized, this applies. The skill scales — sharded indexes, atomic pages, YAML frontmatter, and a bundled search script keep the wiki from becoming a context bottleneck at hundreds or thousands of pages.
---

# LLM Wiki

A skill for building and maintaining an LLM-curated knowledge base at any user-chosen filesystem location, following the pattern Andrej Karpathy described in his April 2026 gist. One personal wiki can compound knowledge across projects, or a wiki can be isolated inside one project. The user curates sources and asks questions; the LLM does the bookkeeping.

## The pattern in one paragraph

Conventional RAG re-derives knowledge from raw chunks on every query; nothing accumulates. The LLM Wiki pattern flips this: when a new source arrives, the LLM compiles it once into a persistent, structured wiki — extracting concepts, writing entity pages, updating cross-references, flagging contradictions. Subsequent queries read the pre-synthesized wiki rather than the raw sources. Knowledge compounds. The user is in charge of sourcing and asking good questions; the LLM handles the summarizing, linking, and consistency work that humans abandon wikis over.

## When to use this skill

The trigger surface is broad. Any time the user is accumulating textual material over time — research papers, articles, transcripts, meeting notes, book chapters, customer calls, code repos, journal entries — and would benefit from having that material organized rather than dumped into a chat each session, this skill applies. It is equally useful for one source ("ingest this paper") and for the steady-state operations against an existing wiki ("what does my wiki say about diffusion models", "lint the wiki", "what's missing").

Resolve the wiki before doing anything else. Prefer, in order: a path named by the user, a path in the nearest project instructions, a path in global agent instructions, then `wiki/` in the current project. Read the resolved wiki's `SCHEMA.md`; it may override defaults documented here. Never silently combine two wikis. If no wiki exists, run the bootstrap step below.

All relative `wiki/` and `raw/` paths in this skill refer to the resolved wiki and raw-source roots, not necessarily the current working directory.

## Architecture: three layers, three operations

The wiki has three layers and three operations. Internalize this vocabulary because the rest of the skill assumes it.

The three layers are **raw sources** (the user's curated source material — articles, papers, PDFs, transcripts; immutable, the LLM reads but never modifies them), **the wiki** (a directory of LLM-generated markdown pages — entity pages, concept pages, comparisons, summaries; the LLM owns this layer entirely), and **the schema** (a `SCHEMA.md` file at the wiki root that documents the conventions for this particular wiki — page types, naming rules, tag taxonomy, ingest workflow customizations; co-evolved with the user).

The three operations are **ingest** (a new source arrives; the LLM reads it, writes a summary page, updates relevant entity and concept pages, appends to the log), **query** (the user asks a question; the LLM navigates the wiki via the index, reads the relevant pages, and synthesizes an answer — often filing the answer back as a new page so the exploration compounds), and **lint** (a periodic health check; the LLM scans for contradictions, stale claims, orphan pages, missing concepts, broken links).

For the canonical write-up of these operations, read `references/architecture.md`. For the step-by-step procedures, read `references/ingest-workflow.md`, `references/query-workflow.md`, and `references/lint-workflow.md` as needed.

## Graph layer (compiled, optional)

Pages can carry typed `graph:` metadata in frontmatter. A bundled extractor compiles every page into `wiki/graph/`: `nodes.jsonl`, `edges.jsonl`, `graph.sqlite`, `graph.graphml`. **Markdown is canonical**; the graph is a regenerable index. Pages without `graph:` still appear as nodes (derived from their `type`/`kind`) and contribute low-confidence `mentions` edges from body wikilinks. Typed semantic edges (e.g. `founded`, `proposed`, `depends_on`) require an explicit source and evidence quote — never emit one inferred from training data.

The conventions for the graph layer (predicate vocabulary, node id format, required fields) live in `wiki/graph/ontology.yaml`. The full reference is `references/graph-workflow.md`. Run the bundled scripts after substantive ingests:

```bash
uv run --script scripts/wiki_graph_lint.py wiki/      # check ontology + evidence + alias collisions
uv run --script scripts/wiki_graph_extract.py wiki/   # rebuild nodes.jsonl, edges.jsonl, graph.sqlite, graph.graphml
python scripts/wiki_graph_query.py wiki/ neighbors --node product:konvy
```

If `wiki/graph/ontology.yaml` does not exist, the wiki is pre-graph and you should treat the graph step as a no-op — don't fabricate it.

## Storage scope and layout

Wiki storage scope is independent of skill installation scope. Installing the skill globally only makes it available across projects; it does not create or select a global wiki.

Use one of two layouts:

- **Personal global wiki:** a stable root such as `~/wiki/`, with raw sources at `~/wiki/raw/`. Point the agent's global instructions to that user-level path. This lets work from any project be deliberately ingested into one compounding knowledge base.
- **Project wiki:** `wiki/` and `raw/` live in the project and are referenced by that project's agent-memory file. Use this when knowledge needs repository-level isolation or versioning.

A global wiki does not crawl or ingest projects automatically. Add project sources and durable findings when the user requests ingestion or their global instructions require those findings to be preserved.

The project-local default is:

```
<project-root>/
├── wiki/
│   ├── SCHEMA.md              ← conventions, the "config file" — read this FIRST
│   ├── index.md               ← entry point: catalog of all pages with one-line summaries
│   ├── log.md                 ← append-only chronological log of ingests/queries/lints
│   ├── indexes/               ← (appears once index.md shards) per-category indexes
│   ├── entities/              ← pages about specific things (people, products, papers, places)
│   ├── concepts/              ← pages about ideas, methods, frameworks
│   ├── sources/               ← per-source summary pages (one per ingested source)
│   └── synthesis/             ← cross-cutting analyses, comparisons, query results filed back
├── raw/                       ← the user's source material (PDFs, .md clippings, images)
│   └── assets/                ← downloaded images referenced by raw clippings
└── ...
```

This layout is a default, not a requirement. A global wiki can put `raw/` inside the wiki root, and either scope can use another name such as `kb/`, `notes/`, or `vault/`. Follow `SCHEMA.md`.

## The scalability discipline

The single biggest failure mode of the LLM Wiki pattern is the wiki itself becoming a context bottleneck. Naive implementations break around a few hundred pages: the LLM either reads too many pages per query or starts hallucinating because it skipped the relevant ones. This skill's design is shaped almost entirely by avoiding that failure. The principles below are non-negotiable; ignoring them is what makes the pattern collapse at scale.

**Atomic pages.** Every wiki page is about one concept and stays small — soft cap 400 lines or roughly 2,000 words, hard cap 800 lines. When a page outgrows this, split it: extract sub-concepts into their own pages and have the parent link to them. A page that takes up 30% of the context window on its own is a design smell.

**Index-first navigation.** Never grep or glob the wiki blindly when answering a query. Always read `index.md` (or the relevant sharded index under `indexes/`) first to identify candidate pages, then drill into only those. The index is engineered to be cheap to read — one line per page, no bodies — and it is the cache that makes the whole pattern scalable.

**Sharded indexes.** When `index.md` itself exceeds ~300 lines or the wiki passes ~150 pages, shard it: move category-specific entries into `indexes/<category>.md` files (e.g. `indexes/entities.md`, `indexes/concepts.md`, `indexes/sources.md`, or finer domain shards), and have the top-level `index.md` become a directory of those shards. Now reading the index is a two-step lookup but each step is bounded.

**YAML frontmatter on every page.** Every wiki page begins with frontmatter that includes at minimum `type`, `tags`, `sources`, and `updated`. The bundled `wiki_search.py` script can filter on these without reading page bodies. See `references/page-conventions.md`.

**Surgical edits, not rewrites.** When updating a page (e.g. adding a new cross-reference because a freshly ingested source mentions an existing entity), use `str_replace` to touch only the relevant section. Rewriting whole pages is slow, expensive in tokens, and risks losing prior nuance.

**Backlink discovery via grep.** To find every page that references a given entity, run `grep -rl "\[\[entity-name\]\]" wiki/` rather than reading pages to look for mentions. The bundled scripts make this easy.

**Chunked source ingestion.** Large raw sources (long PDFs, book chapters, lengthy transcripts) should be read in chunks during ingest, not loaded whole. The ingest workflow handles this — see `references/ingest-workflow.md`.

**Search script for large wikis.** Once the wiki passes ~300 pages, plain index lookup may not surface the right pages for fuzzy queries. Use `scripts/wiki_search.py` for section-level hybrid retrieval with optional frontmatter filters and structured `--json` evidence rows. The default path runs the local `BAAI/bge-small-en-v1.5` FastEmbed model, stores derived vectors in `wiki/.wiki-cache/embeddings.sqlite` through sqlite-vec, and fuses semantic and BM25 ranks with RRF. Initialization and upgrade run `scripts/setup_wiki.py` through `uv`, installing pinned FastEmbed, sqlite-vec, and PyYAML, caching the model, and synchronizing every section before setup is reported ready. No wiki or query text leaves the machine. For dependency-free BM25, bypass PEP 723 resolution with `python scripts/wiki_search.py "query" --no-embed`.

For the full scaling playbook including thresholds and migration steps, read `references/scaling-playbook.md`.

## Initializing a new wiki

Ask whether the user wants one global personal wiki or a project wiki. Then run the bootstrap script against the selected base directory:

```bash
# Project wiki: <project-root>/wiki and <project-root>/raw
python scripts/init_wiki.py <project-root> [--wiki-dir wiki] [--raw-dir raw]

# Personal global wiki: ~/wiki with raw sources at ~/wiki/raw
python scripts/init_wiki.py <home-directory> --wiki-dir wiki --raw-dir wiki/raw
```

This creates the directory structure, drops in templates for `SCHEMA.md`, `index.md`, and `log.md`, then runs mandatory local runtime setup. Setup installs the pinned dependencies through `uv`, downloads `BAAI/bge-small-en-v1.5` when absent, builds the parse cache, and embeds every current section. Do not treat initialization or upgrade as complete unless setup emits `"status": "ready"`.

Before running the bootstrap, use the grouped interview in `references/retrieval-setup.md` to confirm paths, model-cache location, graph usage, and agent-memory integration. Do not ask for API keys or provider consent: there is no remote embedding path. `--no-embed` remains the deterministic lexical escape hatch for later searches, not a way to skip mandatory setup.

Then propose wiring the wiki into agent memory so future sessions can find it: global instructions with a stable user-level path for a personal global wiki, or the project's memory file with a relative path for a project wiki. The filename depends on the agent: `CLAUDE.md` for Claude Code, `AGENTS.md` for Codex / Cursor / OpenCode / Pi / OpenClaw, and `GEMINI.md` for Gemini CLI. Full workflow and both stanza variants are in `references/agent-memory-integration.md`. Never write to a memory file without the user's approval.

## The ingest workflow (summary)

The full workflow is in `references/ingest-workflow.md`; what follows is the shape of it. When a new source arrives, first write the source itself into `raw/` (verbatim; if it's a web article, use the markdown form). Then read the source — chunked if large — and write a single source-summary page in `wiki/sources/`, named after the source slug, with full frontmatter and citations back to the raw file. Then identify which existing entity and concept pages this source touches; for each, surgically update the relevant section using `str_replace` rather than rewriting. Identify any new entities or concepts the source introduces and create new pages for them, linking from related existing pages so they don't become orphans. Update `index.md` (or the relevant shard) with the new pages. Append a single line to `log.md` with the date, operation type, and source title. Discuss the takeaways with the user as a final step — what surprised them, what's worth following up on — and offer to file that discussion back as a synthesis page.

## The query workflow (summary)

Full version in `references/query-workflow.md`. To answer a query against the wiki: read `index.md` (or the relevant shard) first; identify candidate pages from one-line summaries; read those pages (and any backlinks they list that look relevant); synthesize the answer with `[[wikilink]]` citations to the pages you used; offer to file the synthesized answer back into `synthesis/` so future queries benefit. If the index doesn't surface good candidates, run `uv run --script <skill-root>/scripts/wiki_search.py "query terms" --wiki <absolute-wiki-root>` for ranked local hybrid retrieval; add `--no-embed` only for dependency-free lexical BM25. Keep the installed skill path and target wiki path explicit. If the wiki appears to lack coverage of the topic, say so plainly rather than confabulating — flag it as a candidate ingest target.

## The lint workflow (summary)

Full version in `references/lint-workflow.md`. Lint is best run on a cadence (after every N ingests or weekly), not on every operation. The bundled `python scripts/wiki_lint.py` finds the structural issues automatically — orphan pages, broken `[[wikilinks]]`, oversized pages, missing or malformed frontmatter, stale `updated` dates. Then for the semantic checks that need an LLM: read recently-updated pages and look for contradictions with older claims, identify concepts mentioned but lacking their own page, and suggest gaps the user might want to fill via web search or new sources. Always present lint findings as proposed edits for the user to approve, not as faits accomplis — the wiki is the user's, and silent rewrites erode trust.

## Failure modes to guard against

The community discussion around the gist surfaced several failure modes worth internalizing because they are how this pattern goes wrong. Read them so you know what to actively avoid.

The first is **silent corruption** — a misreading of one source becomes an authoritative-looking wiki page, which then influences how subsequent sources are interpreted, and the error compounds invisibly. Mitigation: every wiki claim must carry a `sources:` frontmatter entry pointing back to the raw file, and the lint pass should surface any claim whose source can't be located. When in doubt during ingest, hedge in the wiki text ("the source claims X, though this is not yet corroborated by other sources") rather than asserting.

The second is **wiki-reads-its-own-output drift** — the LLM begins treating prior wiki pages as ground truth and stops checking them against raw sources. Mitigation: during ingest, when updating an existing page, re-read the relevant raw source for the existing claim before merging the new one. Don't take the wiki's word for what the source said.

The third is **the maintenance ratchet** — a critic in the gist comments noted that LLM-Wikis can require more human work over time, not less, because the LLM's output needs increasing supervision as the wiki grows. The mitigation is the scalability discipline above (sharded indexes, atomic pages, frontmatter, lint scripts) plus a strong cadence of lint passes. If lint reports start exceeding what the user can review, the wiki has outgrown its conventions and the schema needs revision.

The fourth is **scope creep into bad fits** — the pattern shines for accumulating textual research and degrades for highly relational data (org charts, financial ledgers, structured datasets) where a real database would serve better. If the user's domain is fundamentally relational, say so and suggest a better tool rather than forcing markdown to do the wrong job.

## Reference files

The reference files are the source of truth for the detailed procedures. Read them when the relevant operation is happening, not preemptively.

- `references/architecture.md` — the three layers and three operations explained in depth, with examples of page formats and the rationale behind each design choice
- `references/ingest-workflow.md` — the step-by-step ingest procedure including chunked reading for large sources and the per-page-type templates
- `references/query-workflow.md` — navigation patterns from index → page → backlinks, when to fall back to the search script, and how to file answers back as synthesis pages
- `references/lint-workflow.md` — what to check, how to present findings, and the cadence
- `references/page-conventions.md` — frontmatter schema, page naming, link syntax, page-type definitions, sizing rules
- `references/scaling-playbook.md` — thresholds at which to shard the index, when to introduce the search script, signals that the wiki has outgrown its current conventions
- `references/agent-memory-integration.md` — how to wire a global or project wiki into agent instructions, with stanza variants and the bootstrap conversation script
- `references/retrieval-setup.md` — mandatory init/upgrade setup: paths, model cache, pinned local dependencies, full-corpus vector synchronization, readiness checks, and non-secret `SCHEMA.md` state
- `references/graph-workflow.md` — the optional graph layer: ontology, frontmatter schema, when to add typed edges vs plain wikilinks, and the extract/lint/query flow

## Bundled scripts

The scripts are intentionally minimal — they exist so the LLM doesn't reinvent the same helpers on every invocation. Each is documented in its own `--help` output and at the top of the file.

- `scripts/init_wiki.py` — bootstrap or upgrade a wiki, then require verified runtime/index setup
- `scripts/setup_wiki.py` — install pinned FastEmbed/sqlite-vec/PyYAML through `uv`, cache the local model, and synchronize parse/vector indexes
- `scripts/wiki_search.py` — section-level local hybrid retrieval with JSON evidence, filters, incremental caches, and dependency-free lexical fallback
- `scripts/wiki_lint.py` — structural health check (orphans, broken links, oversized pages, frontmatter validation, stale dates)
- `scripts/wiki_stats.py` — quick summary of wiki size, page count by type, link density; useful for deciding when to shard the index
- `scripts/wiki_graph_extract.py` — compile graph metadata and wikilinks into JSONL, SQLite, and GraphML through pinned PyYAML
- `scripts/wiki_graph_lint.py` — validate typed edges against the ontology through pinned PyYAML
- `scripts/wiki_graph_query.py` — neighbors / edges / facts / shortest-path queries over `graph.sqlite`

## Templates

The templates in `assets/` are starting points — they get copied into the user's wiki on bootstrap and then evolve under the user's editing.

- `assets/SCHEMA.md.template` — the canonical schema document for a new wiki
- `assets/index.md.template` — the empty index file
- `assets/log.md.template` — the empty log file
- `assets/page.md.template` — a generic wiki page with the frontmatter scaffold
- `assets/ontology.yaml.template` — starter graph ontology copied to `wiki/graph/ontology.yaml`
- `assets/graph_README.md.template` — explainer for `wiki/graph/` (canonical vs generated files)
- `assets/graph_gitignore.template` — `.gitignore` for `wiki/graph/` (ignores `graph.sqlite` and `graph.graphml` by default)
