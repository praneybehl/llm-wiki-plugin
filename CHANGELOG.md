# Changelog

All notable changes to this plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Paperclip integration: `paperclip-plugin-llm-wiki` (npm v0.0.1).** A new sub-deliverable under `integrations/paperclip/plugin/` that surfaces the LLM Wiki inside Paperclip's UI as a read-only context lens. Five surfaces: a Company sidebar, a full-page view at `/companies/:c/plugins/llm-wiki`, an issue-detail tab that auto-surfaces relevant wiki pages by BM25 over title + description, a dashboard health widget (page count, lint status, link density, scaling-threshold messages), and a `wiki.query` agent-callable tool for HTTP/webhook adapters that don't run the skill directly. The plugin is strictly read-only — writes still happen through agents on heartbeat (via the skill) or through the operator's existing markdown environment.
- **Algorithmic parity between the plugin and the canonical Python scripts.** The plugin's TypeScript ports of `wiki_search.py`, `wiki_lint.py`, and `wiki_stats.py` are mechanically tested for byte-for-byte parity against a fixed fixture corpus — same BM25 constants (k1=1.5, b=0.75), same IDF formula, same skip rules. Snapshot regeneration script: `python3 integrations/paperclip/plugin/tests/fixtures/_gen_bm25_expectations.py`. Search results from the plugin and from agent heartbeat will not drift.
- **`integrations/paperclip/SPEC.md`** — v0.1 plugin design proposal with verbatim references to the live Paperclip plugin SDK.
- **`integrations/paperclip/FEASIBILITY.md`** — Phase 0 validation report against `paperclipai/paperclip@master`. Documents the 14 SPEC errata that surfaced during validation (e.g., manifest field is `categories` not `category`; tool result is `{ content?, data?, error? }` not `{ content, structured }`; `ErrorBoundary` is not re-exported from `@paperclipai/plugin-sdk/ui`).
- **CI job** for the plugin package gated to changes under `integrations/paperclip/**`. Runs `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm run build`, and verifies that `dist/` is included in the publish tarball (the most-cited Paperclip plugin publishing failure mode).

### Changed

- Top-level README and the repo layout now document the Paperclip integration. The `SPEC.md` proposal that was at the repo root in pre-release work has moved to `integrations/paperclip/SPEC.md` for co-location with the package it describes.
- The skill itself, the seven slash commands, the Python scripts, and the wiki schema are unchanged in this release. Existing wikis and existing skill installs are unaffected — the plugin is purely additive.

### Notes

- The Paperclip plugin SDK uses calver, not semver. The plugin pins `@paperclipai/plugin-sdk` at exactly `2026.428.0` as a peer dependency (per the SDK's own published versioning convention). Updating to a newer SDK should be a deliberate bump that re-runs Phase 0 validation against the new SDK source.
- Plugin discovery UI in Paperclip is currently invisible — install via the CLI or the local-path HTTP endpoint until the upstream discovery surface ships ([`paperclipai/paperclip` issue #2678](https://github.com/paperclipai/paperclip/issues/2678)).
- [`paperclipai/paperclip` issue #2276](https://github.com/paperclipai/paperclip/issues/2276) is OPEN but already fixed on master — the bug affects worker-only plugins with no UI slots, not plugins that declare `dashboardWidget`. The plugin's manifest declares a full `ui.slots[]` and matches every slot to its capability, so this issue does not apply to us. Recorded here for traceability against the FEASIBILITY report's earlier (incorrect) framing.

## [0.3.0] — 2026-04-25

### Added

- **Optional graph layer.** Pages can now declare typed `graph:` metadata in frontmatter (`node_id`, `node_type`, `aliases`, `relationships[]` with `predicate`, `object`, `source`, `evidence`, `confidence`, `status`). A bundled extractor compiles the wiki into `wiki/graph/`: `nodes.jsonl`, `edges.jsonl`, `graph.sqlite`, `graph.graphml`. Markdown remains canonical — the graph can be deleted and rebuilt at any time. Typed semantic edges require an explicit source-page slug and evidence quote; the extractor never invents them.
- **Three new scripts** (require PyYAML; existing scripts remain stdlib-only):
  - `wiki_graph_extract.py` — compile pages → `nodes.jsonl`, `edges.jsonl`, `graph.sqlite`, `graph.graphml`. Emits typed edges from frontmatter, low-confidence `mentions` edges from body wikilinks, `sourced_from` edges from frontmatter `sources:` lists, and `summarizes_raw` edges from source-page `raw:` fields. Output is deterministic and sorted.
  - `wiki_graph_lint.py` — validate typed edges against `wiki/graph/ontology.yaml`: unknown predicates, missing evidence, broken object refs, alias collisions, invalid `confidence`/`status`, broken `contradicts`/`supersedes`.
  - `wiki_graph_query.py` — `neighbors`, `edges`, `path`, `facts` queries against `graph.sqlite`. Returns structured rows with source slug, confidence/status, evidence snippet, and page path.
- **Graph templates.** `init_wiki.py` now seeds `wiki/graph/ontology.yaml` (starter ontology with implicit + typed predicates), `wiki/graph/README.md` (canonical-vs-generated explainer), and `wiki/graph/.gitignore` (ignores `graph.sqlite` and `graph.graphml` by default). The wiki's top-level `SCHEMA.md` template now documents the optional `graph:` frontmatter, lint cadence for the graph layer, and the generated-artifact tracking policy.
- **`/wiki:graph <action>` slash command.** Dispatches to `extract`, `lint`, `neighbors`, `edges`, `path`, or `facts`. The `/wiki:ingest`, `/wiki:lint`, and `/wiki:query` commands now wire the graph step in conditionally — only when `wiki/graph/ontology.yaml` exists.
- **`/wiki:upgrade` slash command and `init_wiki.py --upgrade` flag.** Brings a wiki bootstrapped under v0.2.0 up to v0.3.0 conventions. Adds the missing `wiki/graph/` files idempotently and surfaces SCHEMA.md sections that need to be merged by hand. Never overwrites SCHEMA.md — the schema is co-evolved with the user; the slash command walks them through each addition with `str_replace` and per-section approval.
- **`references/graph-workflow.md`.** Full reference for the graph layer: ontology format, frontmatter schema, when to add a typed edge vs a plain wikilink, the extract/lint/query loop, the generated-artifact policy, and anti-patterns.

### Changed

- `wiki_lint.py`, `wiki_search.py`, and `wiki_stats.py` now skip the `wiki/graph/` directory the same way they skip `wiki/indexes/` — generated artifacts and the ontology don't pollute structural lint or search ranking.
- `references/architecture.md`, `references/ingest-workflow.md`, `references/query-workflow.md`, and `references/lint-workflow.md` now document the optional graph layer alongside the original three layers/operations.

### Notes for upgraders

- **From an older Claude Code install:** run `/plugin marketplace update` then `/plugin install llm-wiki@llm-wiki` to pull v0.3.0.
- **Upgrading an existing wiki:** the easiest path is `/wiki:upgrade` — it runs `python skills/llm-wiki/scripts/init_wiki.py . --upgrade`, idempotently adds the `wiki/graph/` files, and walks you through the SCHEMA.md additions interactively (one section at a time, per-edit approval; SCHEMA.md is never overwritten silently). The CLI version of the same: `python skills/llm-wiki/scripts/init_wiki.py . --upgrade`.
- **Pre-graph wikis remain fully valid.** The graph layer is opt-in. The new lint/extract/query scripts no-op when `wiki/graph/ontology.yaml` is absent; the existing scripts and slash commands behave identically when no page carries `graph:` metadata.
- **Refreshing other-agent installs:** `npx skills update llm-wiki`, or re-run the original `npx skills add praneybehl/llm-wiki-plugin -a <agent>` command.
- The graph scripts require PyYAML (`pip install pyyaml`). The existing four scripts are still stdlib-only.

## [0.2.0] — 2026-04-15

### Added

- Documented multi-agent installation. The `llm-wiki` skill is agentskills.io-format and installs into Codex, Cursor, Gemini CLI, OpenCode, OpenClaw, Pi Agent, and Hermes Agent via `npx skills add` (or manual symlink for runtimes outside the `skills` CLI registry). README now includes a per-agent install table with the exact `--agent` flag, invocation pattern, and script-execution caveats. OpenCode reads `.claude/skills/` directly, so Claude Code users don't need a second install. The `/wiki:*` slash commands and marketplace manifest remain Claude Code-only.
- Agent-memory integration during init. `/wiki:init` now proposes adding a canonical LLM Wiki stanza to the project's agent-memory file so the running agent remembers the wiki in future sessions without being re-told. The target file is agent-aware: `CLAUDE.md` for Claude Code, `AGENTS.md` for Codex / Cursor / OpenCode / Pi / OpenClaw, `GEMINI.md` for Gemini CLI, with `AGENTS.md` as the safe default for multi-agent projects. Full workflow, canonical stanza, three-line short variant, and the "never write without consent" protocol are in the new `references/agent-memory-integration.md`.

### Notes for upgraders

- Existing Claude Code installs pick up this release via `/plugin marketplace update` followed by `/plugin install llm-wiki@llm-wiki` (Claude Code detects the new version in the marketplace entry).
- Existing `npx skills add` installs for other agents can be refreshed with `npx skills update llm-wiki` or by running the same `npx skills add praneybehl/llm-wiki-plugin -a <agent>` command again.
- No wiki-format or schema changes; existing wikis keep working unchanged.

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

[Unreleased]: https://github.com/praneybehl/llm-wiki-plugin/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/praneybehl/llm-wiki-plugin/releases/tag/v0.3.0
[0.2.0]: https://github.com/praneybehl/llm-wiki-plugin/releases/tag/v0.2.0
[0.1.0]: https://github.com/praneybehl/llm-wiki-plugin/releases/tag/v0.1.0
