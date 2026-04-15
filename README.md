# LLM Wiki — a Claude Code Plugin

Build and maintain an LLM-curated personal knowledge base in your project. An implementation of [Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) as a Claude Code plugin, designed to scale to thousands of pages without becoming a context bottleneck.

## What is this?

Most ways of using LLMs with documents look like RAG: you upload files, the LLM retrieves chunks at query time, generates an answer, and nothing accumulates. Every question re-derives knowledge from raw fragments. Karpathy's LLM Wiki pattern flips this — when a new source arrives, the LLM compiles it once into a persistent, structured wiki of markdown pages, and subsequent queries read the pre-synthesized wiki rather than the raw sources. Knowledge compounds.

This plugin packages the pattern as a Claude Code skill plus four slash commands (`/wiki:init`, `/wiki:ingest`, `/wiki:query`, `/wiki:lint`, `/wiki:stats`) and a small set of bundled Python scripts (BM25 search, structural lint, stats with scaling thresholds). You curate sources and ask questions; Claude does the bookkeeping.

## Why use it

The maintenance burden is what kills personal wikis. Updating cross-references, keeping summaries current, noting when new data contradicts old claims, maintaining consistency across dozens of pages — humans abandon this work. LLMs don't get bored, don't forget to update a backlink, and can touch fifteen files in one pass. The wiki stays alive because the cost of maintenance is near zero.

The pattern shines for accumulating textual research over weeks or months — papers, articles, transcripts, meeting notes, book chapters, customer calls — and degrades for highly relational data where a real database would serve better.

## Installation

Install with the Claude Code `/plugin` command. From any project:

```
/plugin marketplace add praneybehl/llm-wiki-plugin
/plugin install llm-wiki@llm-wiki
```

Once installed, the plugin works in any project — the wiki itself lives in the project's working directory, not in the plugin.

## Quick start

In a project where you want to keep a wiki:

```
/wiki:init
```

This bootstraps `wiki/` and `raw/` directories with a `SCHEMA.md`, `index.md`, `log.md`, and a page template. Walk through the schema and customize it for your domain — page types, tag taxonomy, any conventions specific to what you're tracking.

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
| `/wiki:init` | Bootstrap a new wiki structure in the current project. |
| `/wiki:ingest <source>` | Process a new source into the wiki. |
| `/wiki:query <question>` | Answer a question from the wiki with citations. |
| `/wiki:lint` | Structural and semantic health check. |
| `/wiki:stats` | Show wiki size, link density, and which scaling threshold the wiki is at. |

You don't have to use the commands — Claude triggers the underlying skill on natural-language requests too ("add this paper to my wiki", "what does the wiki say about diffusion", "lint the wiki"). The commands are there when you want explicit invocation.

## Architecture

The wiki has three layers and three operations.

**The three layers** are *raw sources* (your immutable source material in `raw/`), *the wiki* (LLM-owned markdown pages in `wiki/`, organized into `sources/`, `entities/`, `concepts/`, `synthesis/`), and *the schema* (`wiki/SCHEMA.md`, the configuration file that documents the conventions for this specific wiki and that you co-evolve with Claude over time).

**The three operations** are *ingest* (compile a new source into the wiki, touching ten or fifteen pages in one pass), *query* (navigate the wiki to answer a question, with the option to file the answer back as a new synthesis page), and *lint* (periodic health check on structural and semantic integrity).

For the full architecture write-up including page types, frontmatter conventions, the rationale behind each design choice, and the workflow procedures, see the reference docs inside the skill at `skills/llm-wiki/references/`.

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

The bundled scripts (`init_wiki.py`, `wiki_search.py`, `wiki_lint.py`, `wiki_stats.py`) are pure stdlib Python 3.10+, no dependencies. They live in `skills/llm-wiki/scripts/` after install.

## Credits

The pattern is from Andrej Karpathy's [llm-wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), April 2026. This plugin is one implementation of the pattern; others worth looking at include [vanillaflava/llm-wiki-claude-skills](https://github.com/vanillaflava/llm-wiki-claude-skills), [skyllwt/OmegaWiki](https://github.com/skyllwt/OmegaWiki), and [axoviq-ai/synthadoc](https://github.com/axoviq-ai/synthadoc).

## License

MIT — see [LICENSE](./LICENSE).

## Contributing

Issues and PRs welcome. The skill itself is at `skills/llm-wiki/`; the slash commands at `commands/wiki/`. Before opening a PR, please run the bundled scripts against a small test wiki to verify nothing broke.
