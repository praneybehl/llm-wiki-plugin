---
title: Commands
description: Reference for all seven /wiki:* slash commands — init, ingest, query, lint, stats, graph, upgrade.
---

<!-- Adapted from: docs/commands.html (source: README.md "Commands" table, commands/wiki/{init,ingest,query,lint,stats,graph,upgrade}.md). -->

# Commands

Seven `/wiki:*` slash commands ship with the Claude Code plugin. In other agents, phrase the same requests in natural language — the underlying skill triggers either way.

| Command | What it does |
| --- | --- |
| [`/wiki:init [--global]`](#init) | Bootstrap a personal global wiki or a wiki in the current project. |
| [`/wiki:ingest <source>`](#ingest) | Process a new source into the wiki; refreshes the graph layer when present. |
| [`/wiki:query <question>`](#query) | Answer a question from the wiki with citations. |
| [`/wiki:lint`](#lint) | Structural and semantic health check. |
| [`/wiki:stats`](#stats) | Show size, link density, and which scaling threshold the wiki is at. |
| [`/wiki:graph <action>`](#graph) | Compile, lint, or query the typed graph layer. |
| [`/wiki:upgrade`](#upgrade) | Upgrade an existing wiki to the current plugin version. |

## `/wiki:init` {#init}

Bootstrap a new LLM Wiki. Use `--global` for `~/wiki/` with raw sources under `~/wiki/raw/`; omit it for `wiki/` and `raw/` in the current project. Optional `--wiki-dir` / `--raw-dir` arguments override those defaults.

```bash
/wiki:init
/wiki:init --global
```

The command confirms the storage scope and paths, bootstraps the wiki, then installs and verifies pinned FastEmbed, sqlite-vec, and PyYAML dependencies through `uv`, caches the local embedding model, builds the parse cache, and embeds every current section. It walks through `SCHEMA.md` and proposes the matching global or project agent-memory integration only after runtime JSON reports `"status": "ready"`. It does not ingest a source or crawl projects automatically.

## `/wiki:ingest <source>` {#ingest}

Ingest a source (paper, article, transcript, PDF, notes) into the wiki using the skill's ingest workflow.

```bash
/wiki:ingest raw/attention-is-all-you-need.pdf
```

The agent reads `SCHEMA.md`, places the raw source under `raw/`, chunk-reads if it is large, discusses key takeaways, surveys the wiki for touched pages, writes the source-summary page, makes surgical `str_replace` updates, creates new pages for new entities and concepts (each with an inbound link), updates the index, and appends one line to `log.md`. If the graph layer is present and the source supports typed edges, it lints and re-extracts the graph. Full detail in [Workflows → Ingest](/workflows#ingest).

## `/wiki:query <question>` {#query}

Answer a question against the wiki with citations.

```bash
/wiki:query How does attention scale with sequence length?
```

The agent reads the index (or relevant shard), follows selected `[[wikilinks]]`, and synthesizes an answer with citations. If index summaries are insufficient it runs local hybrid search:

```bash
uv run --script skills/llm-wiki/scripts/wiki_search.py \
  "<query terms>" --top 10 --cache --json
```

FastEmbed + sqlite-vec semantic ranking is fused with BM25; no API key or outbound wiki/query text is involved. For dependency-free lexical search, bypass PEP 723 resolution with `python skills/llm-wiki/scripts/wiki_search.py "<query>" --no-embed`; use `--granularity page` for whole-page ranking. See [Search & retrieval](/search). Relational questions can also consult `graph.sqlite`; substantive answers can be filed back into `wiki/synthesis/`.

## `/wiki:lint` {#lint}

Run a structural and semantic health check. Add `--suggest-pages` to surface concepts that should be promoted to their own page.

```bash
/wiki:lint
```

The structural pass runs `wiki_lint.py` to catch orphans, broken wikilinks, oversized pages, missing frontmatter, stale pages, and duplicate slugs. The semantic pass reads recently-updated pages and hub pages for contradictions and gaps. Every finding is presented as a proposed edit — nothing is applied silently. Full detail in [Workflows → Lint](/workflows#lint).

## `/wiki:stats` {#stats}

Show wiki size, shape, and link density — and which scaling threshold the wiki is at.

```bash
/wiki:stats
```

Runs `wiki_stats.py` and interprets the output: whether you are approaching a sharding threshold (150 pages / 300-line index), the routine-search threshold (300 pages), or a weekly-lint cadence (500 pages); whether any pages exceed the 400-line soft cap or 800-line hard cap; and whether link density looks low.

## `/wiki:graph <action>` {#graph}

Compile, lint, or query the wiki's typed graph layer. The graph is optional and requires `wiki/graph/ontology.yaml`.

```bash
/wiki:graph extract
/wiki:graph neighbors --node product:konvy
/wiki:graph edges --subject person:stephanie-emmanouel
/wiki:graph path --from person:praney-behl --to product:konvy
/wiki:graph facts --about product:konvy
```

`extract` compiles the markdown into `nodes.jsonl`, `edges.jsonl`, `graph.sqlite`, and `graph.graphml`; `lint` validates typed edges; the query subcommands navigate the compiled graph. Markdown stays canonical — the graph can be deleted and rebuilt at any time. See the [Graph layer guide](/graph).

## `/wiki:upgrade` {#upgrade}

Upgrade an existing wiki with idempotent file operations, mandatory runtime installation/index synchronization, and a walked `SCHEMA.md` merge.

```bash
/wiki:upgrade
```

Resolves the installed `init_wiki.py` separately from the configured global or project wiki, then runs it with `--upgrade`. Existing content stays untouched while the complete pinned local runtime is installed and verified, parse/vector indexes synchronize, and missing `SCHEMA.md` sections are walked one at a time. See [Upgrade to v3](/upgrade).
