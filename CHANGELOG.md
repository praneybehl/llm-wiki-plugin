# Changelog

All notable changes to this plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Documented multi-agent installation. The `llm-wiki` skill is agentskills.io-format and installs into Codex, Cursor, Gemini CLI, OpenCode, OpenClaw, Pi Agent, and Hermes Agent via `npx skills add` (or manual symlink for runtimes outside the `skills` CLI registry). README now includes a per-agent install table with the exact `--agent` flag, invocation pattern, and script-execution caveats. OpenCode reads `.claude/skills/` directly, so Claude Code users don't need a second install. The `/wiki:*` slash commands and marketplace manifest remain Claude Code-only.
- Agent-memory integration during init. `/wiki:init` now proposes adding a canonical LLM Wiki stanza to the project's agent-memory file so the running agent remembers the wiki in future sessions without being re-told. The target file is agent-aware: `CLAUDE.md` for Claude Code, `AGENTS.md` for Codex / Cursor / OpenCode / Pi / OpenClaw, `GEMINI.md` for Gemini CLI, with `AGENTS.md` as the safe default for multi-agent projects. Full workflow, canonical stanza, three-line short variant, and the "never write without consent" protocol are in the new `references/agent-memory-integration.md`.

## [0.1.0] — 2026-04-15

Initial release.

### Added

- `llm-wiki` skill implementing Andrej Karpathy's LLM Wiki pattern as a Claude Code skill, with progressive-disclosure references for architecture, ingest workflow, query workflow, lint workflow, page conventions, and the scaling playbook.
- Five slash commands: `/wiki:init` (bootstrap a wiki in the current project), `/wiki:ingest` (process a new source), `/wiki:query` (answer a question with citations), `/wiki:lint` (structural and semantic health check), `/wiki:stats` (size, link density, and scaling thresholds).
- Four bundled Python scripts (stdlib only, Python 3.10+): `init_wiki.py`, `wiki_search.py` (BM25 with frontmatter filters, backlinks, and hub finding), `wiki_lint.py` (orphans, broken links, oversized pages, frontmatter validation, stale pages, page suggestions), `wiki_stats.py` (size and shape report with scaling-threshold recommendations).
- Templates for `SCHEMA.md`, `index.md`, `log.md`, and a generic page — copied into the user's wiki on bootstrap and then evolved under their editing.
- Marketplace manifest (`.claude-plugin/marketplace.json`) so the repo doubles as a single-plugin marketplace, installable via `/plugin marketplace add praneybehl/llm-wiki-plugin`.

### Scalability design

- Atomic page sizing enforced by lint (400-line soft cap, 800-line hard cap).
- Sharded indexes pattern documented and supported by `wiki_stats.py` threshold detection (triggers at ~150 pages or 300 index lines).
- YAML frontmatter required on every page so `wiki_search.py` can filter without reading bodies.
- Index-first navigation discipline documented in the query workflow; BM25 search as explicit fallback.
- Surgical `str_replace` edits over rewrites to keep ingest token-cheap and diffs clean.
- Chunked source ingestion guidance for large PDFs, transcripts, and long articles.

[Unreleased]: https://github.com/praneybehl/llm-wiki-plugin/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/praneybehl/llm-wiki-plugin/releases/tag/v0.1.0
