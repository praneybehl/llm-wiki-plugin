# LLM Wiki — a Claude Code Plugin

Build and maintain an LLM-curated personal knowledge base in your project. An implementation of [Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) as a Claude Code plugin, designed to scale to thousands of pages without becoming a context bottleneck.

## What is this?

Most ways of using LLMs with documents look like RAG: you upload files, the LLM retrieves chunks at query time, generates an answer, and nothing accumulates. Every question re-derives knowledge from raw fragments. Karpathy's LLM Wiki pattern flips this — when a new source arrives, the LLM compiles it once into a persistent, structured wiki of markdown pages, and subsequent queries read the pre-synthesized wiki rather than the raw sources. Knowledge compounds.

This plugin packages the pattern as a Claude Code skill plus six slash commands (`/wiki:init`, `/wiki:ingest`, `/wiki:query`, `/wiki:lint`, `/wiki:stats`, `/wiki:graph`) and a small set of bundled Python scripts (BM25 search, structural lint, stats with scaling thresholds, plus an optional compiled graph layer). You curate sources and ask questions; Claude does the bookkeeping.

## Why use it

The maintenance burden is what kills personal wikis. Updating cross-references, keeping summaries current, noting when new data contradicts old claims, maintaining consistency across dozens of pages — humans abandon this work. LLMs don't get bored, don't forget to update a backlink, and can touch fifteen files in one pass. The wiki stays alive because the cost of maintenance is near zero.

The pattern shines for accumulating textual research over weeks or months — papers, articles, transcripts, meeting notes, book chapters, customer calls — and degrades for highly relational data where a real database would serve better.

## Installation

### Claude Code — full plugin

The native path: the skill, the five `/wiki:*` slash commands, and the marketplace manifest all ship in one install.

```
/plugin marketplace add praneybehl/llm-wiki-plugin
/plugin install llm-wiki@llm-wiki
```

Once installed, the plugin works in any project — the wiki itself lives in the project's working directory, not in the plugin.

### Other coding agents — skill only

The `llm-wiki` skill uses the standard [agentskills.io](https://agentskills.io) format, so it installs cleanly into any agent supported by the [`skills` CLI](https://github.com/vercel-labs/skills). Pick the `--agent` flag that matches your setup:

```bash
# Install globally so the skill is available across all projects
npx skills add praneybehl/llm-wiki-plugin -a <agent> -g

# Or install into the current project only
npx skills add praneybehl/llm-wiki-plugin -a <agent>
```

| Agent | `--agent` value | Invoke via | Scripts run |
|-------|-----------------|------------|:-----------:|
| Claude Code | `claude-code` | `/wiki:*` slash commands (bundled) or natural language | ✅ |
| Codex (OpenAI) | `codex` | `/skills` or `$llm-wiki` / natural language | ✅ |
| Cursor | `cursor` | `/llm-wiki` or natural language | ✅ |
| Gemini CLI | `gemini-cli` | `/skills` management commands / natural language | ⚠️ unverified |
| OpenCode | `opencode` | natural language (agent invokes the native `skill` tool) | ⚠️ unverified |
| OpenClaw | `openclaw` | auto-exposed as a user command | ⚠️ scripts don't auto-execute |
| Pi Agent | `pi` | `/skill:llm-wiki` or natural language | ✅ |

OpenCode also reads `.claude/skills/` and `~/.claude/skills/`, so if you already installed the skill for Claude Code you can use it in OpenCode without a second install.

**Hermes Agent** (Nous Research) and other agentskills.io-compatible runtimes that aren't yet in the `npx skills` registry can still use this skill — clone the repo and symlink or copy `skills/llm-wiki/` into the agent's skills directory (e.g. `~/.hermes/skills/llm-wiki/`).

```bash
git clone https://github.com/praneybehl/llm-wiki-plugin.git
ln -s "$(pwd)/llm-wiki-plugin/skills/llm-wiki" ~/.hermes/skills/llm-wiki
```

A few things to know when using the skill outside Claude Code:

- **Slash commands are Claude Code-only.** The five `/wiki:*` commands live in `commands/wiki/` as Claude Code plugin manifests. In other agents, invoke the skill by natural language ("add this paper to the wiki", "what does the wiki say about X", "lint the wiki") — the SKILL.md handles the rest.
- **Script execution varies.** OpenClaw doesn't run bundled Python scripts the way Claude Code does, so BM25 search, lint, and stats degrade to model-driven behavior. Gemini CLI and OpenCode don't document their script-execution semantics explicitly — test before relying on the bundled scripts in those environments. For the full feature set, use Claude Code, Codex, Cursor, or Pi.
- **The wiki itself is agent-agnostic.** It's just a directory of markdown files. You can ingest with one agent and query with another; nothing in `wiki/` ties it to a specific runtime.

## Quick start

In a project where you want to keep a wiki:

```
/wiki:init
```

Already have a wiki from an earlier plugin version? Run `/wiki:upgrade` instead — it adds the new files idempotently and walks you through any SCHEMA.md merges by hand.

This bootstraps `wiki/` and `raw/` directories with a `SCHEMA.md`, `index.md`, `log.md`, and a page template. Walk through the schema and customize it for your domain — page types, tag taxonomy, any conventions specific to what you're tracking.

As part of the same step, the skill will propose wiring the wiki into your project's agent-memory file so the agent remembers it in future sessions without being told. The target file depends on which agent you use: `CLAUDE.md` for Claude Code, `AGENTS.md` for Codex / Cursor / OpenCode / Pi / OpenClaw, `GEMINI.md` for Gemini CLI. If you run multiple agents in the same project, use `AGENTS.md` and symlink `CLAUDE.md` to it. The skill never writes to a memory file without your approval — see `skills/llm-wiki/references/agent-memory-integration.md` for the canonical stanza and a three-line short variant.

Drop your first source into `raw/` (a PDF, a markdown clipping from the Obsidian Web Clipper, a transcript, anything textual), then:

```
/wiki:ingest raw/your-source.pdf
```

Claude reads the source (chunk-reading if it's large), discusses the takeaways with you, writes a summary page, identifies which existing entity and concept pages it touches, surgically updates them with `str_replace`, creates new pages for new entities and concepts (each with at least one inbound link), updates the index, and appends to the log.

Once you have a few sources in:

```
/wiki:query What does my wiki say about X?
```

Claude reads the index to find candidate pages, reads them, synthesizes an answer with `[[wikilink]]` citations, and offers to file substantive answers back into `wiki/synthesis/` so the exploration compounds.

Periodically, run a health check:

```
/wiki:lint
```

This catches orphan pages, broken wikilinks, oversized pages, missing frontmatter, and stale claims. Findings are presented as proposed edits — Claude doesn't rewrite your wiki silently.

## Commands

| Command | What it does |
|---------|--------------|
| `/wiki:init` | Bootstrap a new wiki structure in the current project (now includes `wiki/graph/`). |
| `/wiki:ingest <source>` | Process a new source into the wiki; refreshes the graph layer when present. |
| `/wiki:query <question>` | Answer a question from the wiki with citations; consults `graph.sqlite` for relational questions when available. |
| `/wiki:lint` | Structural and semantic health check; also runs graph lint when `wiki/graph/ontology.yaml` exists. |
| `/wiki:stats` | Show wiki size, link density, and which scaling threshold the wiki is at. |
| `/wiki:graph <action>` | `extract` / `lint` / `neighbors` / `edges` / `path` / `facts` against the compiled graph layer. |
| `/wiki:upgrade` | Upgrade an existing wiki to the current plugin version (idempotent file ops + walked SCHEMA.md merge). |

You don't have to use the commands — Claude triggers the underlying skill on natural-language requests too ("add this paper to my wiki", "what does the wiki say about diffusion", "lint the wiki"). The commands are there when you want explicit invocation.

## Architecture

The wiki has three layers and three operations.

**The three layers** are *raw sources* (your immutable source material in `raw/`), *the wiki* (LLM-owned markdown pages in `wiki/`, organized into `sources/`, `entities/`, `concepts/`, `synthesis/`), and *the schema* (`wiki/SCHEMA.md`, the configuration file that documents the conventions for this specific wiki and that you co-evolve with Claude over time).

**The three operations** are *ingest* (compile a new source into the wiki, touching ten or fifteen pages in one pass), *query* (navigate the wiki to answer a question, with the option to file the answer back as a new synthesis page), and *lint* (periodic health check on structural and semantic integrity).

There is also an **optional fourth layer**: the graph at `wiki/graph/`. Pages can declare typed `graph:` metadata in frontmatter (e.g. `founded`, `proposed`, `depends_on`) with an explicit source-page slug and evidence quote. A bundled extractor compiles every page into `nodes.jsonl`, `edges.jsonl`, `graph.sqlite`, and `graph.graphml`. **Markdown stays canonical** — the graph can be deleted and rebuilt at any time. Use `/wiki:graph` for relational queries that the index alone can't answer cheaply ("what's connected to X", "who proposed Y", "shortest path A → B").

For the full architecture write-up including page types, frontmatter conventions, the rationale behind each design choice, and the workflow procedures, see the reference docs inside the skill at `skills/llm-wiki/references/`. The graph layer is documented in `skills/llm-wiki/references/graph-workflow.md`.

## How it scales

The single biggest failure mode of the LLM Wiki pattern is the wiki becoming a context bottleneck as it grows. The plugin's design is shaped largely around avoiding that failure.

**Atomic pages.** Every page is about one concept. Soft cap 400 lines, hard cap 800 lines. The lint script enforces this. Any single page read is bounded, so even at a thousand pages a query that reads five pages stays well within context.

**Sharded indexes.** When `wiki/index.md` exceeds 300 lines or the wiki passes ~150 pages, the index shards into per-type files under `wiki/indexes/`. The top-level index becomes a tiny directory of shards. Reading the index is now a two-step lookup but each step is bounded.

**YAML frontmatter on every page.** The `wiki_search.py` script can filter on `type`, `tags`, and `updated` without reading page bodies, so retrieval scales independently of total wiki size.

**Index-first navigation.** Queries read the index first, identify candidate pages from one-line summaries, and only read those. The index is the cache that makes the whole pattern scalable.

**BM25 search as fallback.** Once the wiki passes ~300 pages or a query uses fuzzy language that doesn't match index summaries, `python skills/llm-wiki/scripts/wiki_search.py "query terms"` provides ranked retrieval with frontmatter filters. Pure stdlib — no install. Use `--type concept`, `--tag <tag>`, `--since YYYY-MM-DD` to narrow further; `--backlinks <slug>` to find inbound links; `--top-linked N` to find the wiki's hub pages.

**Surgical edits.** When updating a page during ingest, Claude uses `str_replace` to touch the relevant section, not rewrite the page. Fast, token-efficient, and preserves diff quality if you keep the wiki in git.

**Chunked source ingestion.** Large raw sources (long PDFs, multi-hour transcripts) are read in chunks during ingest, not loaded whole. The ingest workflow handles this automatically.

The `/wiki:stats` command surfaces which threshold you're at and what migration to do next. The full scaling playbook with thresholds and migration procedures is at `skills/llm-wiki/references/scaling-playbook.md`.

## What it doesn't try to be

This is a markdown-based personal knowledge base, not a database. If your domain is fundamentally relational — tracking 100,000 customer records, complex org structures, financial ledgers with strict referential integrity — a real database serves better. Markdown plus grep plus frontmatter scales further than people expect (Karpathy's own wiki was about 100 articles and 400K words working fine), but at some point the right tool changes.

Failure modes to know about, all discussed in `skills/llm-wiki/SKILL.md`: silent corruption (a misreading of one source becomes an authoritative-looking wiki page that influences subsequent ingests — mitigated by mandatory `sources:` frontmatter and lint), the wiki-reads-its-own-output drift (Claude treating prior wiki pages as ground truth rather than checking against raw sources — mitigated by the ingest workflow's instruction to re-read raw sources when updating claims), and the maintenance ratchet (lint reports growing faster than you can review — mitigated by the scalability discipline, but if it happens, the schema needs revision).

## Tooling

Once the wiki is set up, you can read and edit pages with any markdown viewer. [Obsidian](https://obsidian.md) is a particularly good fit because of its graph view, `[[wikilinks]]` syntax, and Web Clipper extension, but it isn't required — the wiki is just a directory of markdown files in your project.

The bundled scripts (`init_wiki.py`, `wiki_search.py`, `wiki_lint.py`, `wiki_stats.py`) are pure stdlib Python 3.10+, no dependencies. The optional graph-layer scripts (`wiki_graph_extract.py`, `wiki_graph_lint.py`, `wiki_graph_query.py`) require PyYAML — install once with `pip install pyyaml`. All seven live in `skills/llm-wiki/scripts/` after install.

## Credits

The pattern is from Andrej Karpathy's [llm-wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), April 2026. This plugin is one implementation of the pattern; others worth looking at include [vanillaflava/llm-wiki-claude-skills](https://github.com/vanillaflava/llm-wiki-claude-skills), [skyllwt/OmegaWiki](https://github.com/skyllwt/OmegaWiki), and [axoviq-ai/synthadoc](https://github.com/axoviq-ai/synthadoc).

## License

MIT — see [LICENSE](./LICENSE).

## Contributing

Issues and PRs welcome. The skill itself is at `skills/llm-wiki/`; the slash commands at `commands/wiki/`. Before opening a PR, please run the bundled scripts against a small test wiki to verify nothing broke.
