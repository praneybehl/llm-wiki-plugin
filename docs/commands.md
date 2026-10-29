---
title: Commands
description: Reference for all ten /wiki:* slash commands (init, ingest, query, lint, stats, graph, migrate, upgrade, learn, evolve).
---

<!-- Adapted from: docs/commands.html (source: README.md "Commands" table, commands/wiki/{init,ingest,query,lint,stats,graph,migrate,upgrade}.md). -->

# Commands

Ten `/wiki:*` slash commands ship with the Claude Code plugin. In other agents, phrase the same requests in natural language. The underlying skill triggers either way.

Every command works with a local wiki and with a [hosted wiki](/hosted). For a hosted wiki, the agent uses the MCP tools (or `wiki_remote.py`) instead of local files and scripts.

| Command | What it does |
| --- | --- |
| [`/wiki:init [--global]`](#init), [`/wiki:init --hosted <url>`](#init) | Bootstrap a personal global wiki or a wiki in the current project, or connect this agent to a hosted wiki. |
| [`/wiki:ingest <source>`](#ingest) | Process a new source into the wiki; refreshes the graph layer when present. |
| [`/wiki:query <question>`](#query) | Answer a question from the wiki with citations. |
| [`/wiki:lint`](#lint) | Structural and semantic health check. |
| [`/wiki:stats`](#stats) | Show size, link density, and which scaling threshold the wiki is at. |
| [`/wiki:graph <action>`](#graph) | Compile, lint, or query the typed graph layer. |
| [`/wiki:learn <task artifacts>`](#learn) | Capture verified experience and consolidate reusable patterns. |
| [`/wiki:evolve <goal or action>`](#evolve) | Stage, evaluate, inspect, apply or roll back a skill improvement. |
| [`/wiki:migrate [<wiki-dir>]`](#migrate) | Move a local wiki to a hosted wiki, verify every file, and keep a read-only mirror. |
| [`/wiki:upgrade`](#upgrade) | Upgrade an existing wiki to the current plugin version. |

## `/wiki:init` {#init}

Bootstrap a new LLM Wiki. Use `--global` for `~/wiki/` with raw sources under `~/wiki/raw/`; omit it for `wiki/` and `raw/` in the current project. Optional `--wiki-dir` / `--raw-dir` arguments override those defaults.

```bash
/wiki:init
/wiki:init --global
```

The command confirms the storage scope and paths, bootstraps the wiki, then installs and verifies pinned FastEmbed, sqlite-vec, and PyYAML dependencies through `uv`, caches the local embedding model, builds the parse cache, and embeds every current section. It walks through `SCHEMA.md` and proposes the matching global or project agent-memory integration only after runtime JSON reports `"status": "ready"`. It does not ingest a source or crawl projects automatically.

```bash
/wiki:init --hosted https://llm-wiki.example.workers.dev
```

With `--hosted <url>`, the command connects this agent to a deployed [hosted wiki](/hosted) instead. It asks for an agent token (or offers OAuth), stores the connection with `wiki_remote.py login`, checks it with `status`, prints the MCP configuration for your client, and proposes the hosted-wiki memory stanza. It writes the client configuration and the stanza only after your approval. It never stores the token in a project file or memory file.

## `/wiki:ingest <source>` {#ingest}

Ingest a source (paper, article, transcript, PDF, notes) into the wiki using the skill's ingest workflow.

```bash
/wiki:ingest raw/attention-is-all-you-need.pdf
```

The agent reads `SCHEMA.md`, places the raw source under `raw/`, chunk-reads if it is large, discusses key takeaways, surveys the wiki for touched pages, writes the source-summary page, makes surgical `str_replace` updates, creates new pages for new entities and concepts (each with an inbound link), updates the index, and appends one line to `log.md`. If the graph layer is present and the source supports typed edges, it lints and re-extracts the graph. On a hosted wiki, the agent uploads the raw file with `wiki_remote.py raw put` and sends all page changes in one `wiki_commit` (`create`, `edit`, `append`); the server updates the graph. Full detail in [Workflows: Ingest](/workflows#ingest).

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

FastEmbed + sqlite-vec semantic ranking is fused with BM25; no API key or outbound wiki/query text is involved. For dependency-free lexical search, bypass PEP 723 resolution with `python skills/llm-wiki/scripts/wiki_search.py "<query>" --no-embed`; use `--granularity page` for whole-page ranking. See [Search & retrieval](/search). Relational questions can also consult `graph.sqlite`; substantive answers can be filed back into `wiki/synthesis/`. On a hosted wiki, the agent calls `wiki_search`, `wiki_read` and `wiki_graph`. With the optional [decision layer](/decisions), `--decide` removes rows that do not help answer the query.

## `/wiki:lint` {#lint}

Run a structural and semantic health check. Add `--suggest-pages` to surface concepts that should be promoted to their own page.

```bash
/wiki:lint
```

The structural pass runs `wiki_lint.py` to catch orphans, broken wikilinks, oversized pages, missing frontmatter, stale pages, and duplicate slugs. The semantic pass reads recently-updated pages and hub pages for contradictions and gaps. Every finding is presented as a proposed edit: nothing is applied silently. On a hosted wiki, `wiki_lint` returns structural findings, graph findings and open review flags in one call. Full detail in [Workflows: Lint](/workflows#lint).

## `/wiki:stats` {#stats}

Show wiki size, shape, and link density, and which scaling threshold the wiki is at.

```bash
/wiki:stats
```

Runs `wiki_stats.py` and interprets the output: whether you are approaching a sharding threshold (150 pages / 300-line index), the routine-search threshold (300 pages), or a weekly-lint cadence (500 pages); whether any pages exceed the 400-line soft cap or 800-line hard cap; and whether link density looks low. On a hosted wiki, the numbers come from `wiki_remote.py stats`.

## `/wiki:graph <action>` {#graph}

Compile, lint, or query the wiki's typed graph layer. The graph is optional and requires `wiki/graph/ontology.yaml`.

```bash
/wiki:graph extract
/wiki:graph neighbors --node product:konvy
/wiki:graph edges --subject person:stephanie-emmanouel
/wiki:graph path --from person:praney-behl --to product:konvy
/wiki:graph facts --about product:konvy
```

`extract` compiles the markdown into `nodes.jsonl`, `edges.jsonl`, `graph.sqlite`, and `graph.graphml`; `lint` validates typed edges; the query subcommands navigate the compiled graph. Markdown stays canonical: the graph can be deleted and rebuilt at any time. See the [Graph layer guide](/graph). On a hosted wiki, the server keeps the graph current on each commit, so `extract` is not necessary; the query actions use `wiki_graph`.

## `/wiki:migrate` {#migrate}

Move a local wiki to a [hosted wiki](/hosted).

```bash
/wiki:migrate ~/wiki --raw ~/wiki/raw
```

The command checks the connection, runs local lint, runs `wiki_remote.py import --dry-run` and shows the report. After your approval it runs the import. The import uploads in small batches, skips identical files and continues after an interruption. It then compares the SHA-256 of every page and raw file that it selected with the server manifest. Exit code 0 does not prove that every file was selected, so the command also reads the `skipped` and `raw.skipped` lists. It separates expected exclusions (generated graph files) from missing source content (too large, not UTF-8 text, symbolic links, refused paths) and asks you to fix or accept each missing file. See [Migrate a local wiki](/hosted#migrate-a-local-wiki). The command compares lint counts and a few searches, then offers to turn the local folder into a read-only `pull` mirror and to replace the memory stanza. Your local wiki and agent instructions do not change until the verification passes and you approve.

## `/wiki:upgrade` {#upgrade}

Upgrade an existing wiki with idempotent file operations, mandatory runtime installation/index synchronization, and a walked `SCHEMA.md` merge.

```bash
/wiki:upgrade
```

Resolves the installed `init_wiki.py` separately from the configured global or project wiki, then runs it with `--upgrade`. Existing content stays untouched while the complete pinned local runtime is installed and verified, parse/vector indexes synchronize, and missing `SCHEMA.md` sections are walked one at a time. See [Upgrade](/upgrade).

## `/wiki:learn <task artifacts>` {#learn}

Capture verified successes or failures as immutable raw experience, ingest a source page and consolidate a reusable pattern with evidence, applicability and counterexamples. No skill is changed and no paid model evaluation is launched. See [Learning and skill evolution](/evolution).

## `/wiki:evolve <goal or action>` {#evolve}

Run bounded training, consolidate observed evidence, propose one complete skill change, select on validation, and test the frozen result independently. `history` and `show <id>` inspect past attempts; `apply <id>` installs an authorized, reviewed passing candidate; `rollback <id>` restores its baseline if no intervening edits occurred. See [Learning and skill evolution](/evolution) for runner setup, the demonstration suites, budget controls and recovery.
