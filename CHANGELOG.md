# Changelog

All notable changes to this plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.1.0] - 2026-09-03

### Changed

- Make personal global wikis a first-class setup alongside project wikis, and resolve every command against the configured wiki instead of assuming the current project's `wiki/` directory.
- Publish the Paperclip companion as `paperclip-plugin-llm-wiki` v0.5.2.

## [3.0.0] - 2026-07-20

### Changed

- Replace OpenAI-compatible HTTP embeddings with local FastEmbed `BAAI/bge-small-en-v1.5` embeddings stored in sqlite-vec.
- Make local hybrid section retrieval the default and retain `--no-embed` as the dependency-free BM25 escape hatch.
- Keep the Paperclip worker lexical-only while preserving byte-for-byte parity with Python `--no-embed`; its documentation now distinguishes that surface from the default Python hybrid path.
- Declare pinned FastEmbed and sqlite-vec dependencies through PEP 723 for isolated `uv run --script` execution.
- Add `setup_wiki.py` as the mandatory init/upgrade runtime gate: it installs pinned FastEmbed 0.8.0, sqlite-vec 0.1.9, and PyYAML 6.0.3, caches the local model, builds the parse cache, synchronizes every wiki section, and emits a machine-readable readiness report.
- Give graph lint and extraction their own pinned PyYAML PEP 723 metadata so every dependency-bearing agent tool runs reproducibly through `uv run --script`.
- Bump the Paperclip companion, `paperclip-plugin-llm-wiki` v0.5.1, for its updated v3 local-retrieval agent setup guidance.
- Replace provider consent, credential, endpoint, and cache-marker setup with local model-download and index-build guidance.
- Add an idempotent v3 upgrade marker; existing Markdown needs no migration and legacy `embeddings.jsonl` caches are ignored.
- Make initialization and upgrade fail closed when `uv` or runtime setup is unavailable instead of reporting a partially ready wiki.

### Fixed

- Persist content-hashed section vectors in `wiki/.wiki-cache/embeddings.sqlite`, re-embedding only changed sections and removing deleted sections.
- Rebuild derived vectors automatically when the model, dimension, or vector schema changes.
- Apply the cosine metric consistently to filtered and unfiltered vector queries, and reject low-similarity semantic candidates before RRF to avoid false-positive answers on out-of-domain questions.
- Fall back to valid lexical JSON on missing dependencies, model failures, or sqlite-vec load failures without exposing exception details.
- Cover index reuse, incremental updates, deletions, filter-scoped vector search, dimension rebuilds, and lexical fallback with focused regressions.


## [2.0.7] - 2026-07-20

### Fixed

- Require `--approve-embedding-build` before a new or switched provider can upload canonical sections, then persist a provider-fingerprint approval marker after success.
- Permit later same-provider searches to embed only new or changed sections without repeated approval, including one-section wikis where every current section changed.
- Add regressions for deferred first builds, provider switches, marker persistence, and same-provider incremental updates.
- Persist only a SHA-256 provider fingerprint in cache version 3; custom endpoint URLs, embedded credentials, and signed query tokens are never written to new rows. Version 2 caches are treated as legacy and require an approved delete/rebuild so previously persisted raw endpoints are removed.
- Redact backend failure details from CLI fallback warnings so credential-bearing endpoint URLs and provider response bodies cannot leak to stderr.

## [2.0.6] - 2026-07-20

### Fixed

- Detect legacy embedding caches before hybrid retrieval and fall back to lexical with an explicit approve/delete/rebuild instruction instead of silently resending every canonical section.
- Stamp new vector rows with cache version and provider metadata; add a subprocess regression proving legacy caches remain untouched without approval.

## [2.0.5] - 2026-07-20

### Fixed

- Bind cached section vectors to the approved provider identity, normalized endpoint, model, and text. Switching providers can no longer reuse vectors produced elsewhere under the same model name.
- Add cross-provider cache and URL-normalization regression tests.

## [2.0.4] - 2026-07-20

### Fixed

- Bind embedding consent to the selected provider: `openai` is pinned to the OpenAI endpoint and key, while `custom` requires its own endpoint and model and never inherits OpenAI configuration.
- Add mismatch regression coverage so mixed OpenAI/custom environment variables cannot redirect text or reuse an unapproved credential.

## [2.0.3] - 2026-07-20

### Fixed

- Persisted retrieval consent is now enforced by `wiki_search.py`: only `Embedding mode: openai | custom` can activate provider calls. `undecided`, `lexical`, `deferred`, or a missing mode stay local even when `OPENAI_API_KEY` is present.
- Setup, command, and public documentation now disclose ongoing hybrid data use and cost: every hybrid query sends query text, the first vector build sends canonical sections, and later searches send new or changed sections missing cached vectors.


## [2.0.2] - 2026-07-20

### Changed

- Init, upgrade, and query commands now run an explicit retrieval setup interview covering local BM25, OpenAI hybrid, custom compatible endpoints, first-build timing, graph usage, and agent integration.
- Setup guidance distinguishes environment configuration, successful API validation, and a fully built wiki embedding cache. It never treats a present key as proof of validity and requires approval before the first billable embedding request.
- New wiki schemas record an explicit embedding mode and validation state without storing secrets.

## [2.0.1] - 2026-07-20

### Fixed

- Exclude a top-level `raw/` directory from Python and Paperclip search, lint, stats, and graph compilation. This supports wikis that keep immutable raw sources inside the wiki root without allowing raw documents to pollute canonical page retrieval or graph output.

## [2.0.0] — 2026-07-20

### Added

- **Section-level retrieval with structured evidence.** `wiki_search.py` now ranks ATX-heading sections by default, emits `--json` evidence rows with heading paths, snippets, source metadata, and neighbors, and retains the prior whole-page behavior behind `--granularity page`.
- **Incremental retrieval cache.** `--cache` stores content-hashed parse results under `wiki/.wiki-cache/`; cold, warm, and uncached searches return byte-identical JSON.
- **Opt-in hybrid retrieval.** OpenAI-compatible embedding endpoints activate semantic ranking fused with BM25 through reciprocal rank fusion. Embedding vectors are cached locally; backend failures fall back to lexical search without failing the command.
- **Retrieval evaluation harness.** `eval/retrieval/` ships a 20-page corpus, 32 exact/paraphrase/filter/negative queries, recall/MRR/false-positive metrics, a section-vs-page regression gate, and cache-invariance checks.
- **Documentation website.** A [VitePress](https://vitepress.dev) site under `docs/` — nine guides with fuzzy full-text local search and Mermaid diagrams — builds to `docs/.vitepress/dist` and deploys to GitHub Pages through a dedicated Actions workflow (`.github/workflows/deploy-docs.yml`).
- **SEO and agent discovery.** Every guide ships unique descriptions, canonical URLs, Open Graph/Twitter cards, schema.org JSON-LD, and permissive crawl directives. The Pages artifact includes a sitemap, `robots.txt`, `llms.txt`, and a 1200×630 social preview; natural-language FAQs and tuned fuzzy/prefix search improve human and AI retrieval.
- **Paperclip integration.** `paperclip-plugin-llm-wiki` v0.5.0 provides a three-column wiki workspace, sidebar launcher, setup walkthrough, quick switcher, backlinks panel, issue-context tab, dashboard health, and the agent-callable `wiki.query` tool. The integration remains read-only; agents maintain canonical Markdown through the skill.
- **Paperclip design and verification assets.** `integrations/paperclip/SPEC.md` and `FEASIBILITY.md` document the design and SDK validation. The Paperclip CI job installs pinned dependencies, typechecks, tests, builds, and checks the publish package.

### Changed

- **Paperclip retrieval parity.** The TypeScript port now performs section-level BM25, returns heading/snippet evidence, de-duplicates issue-context results by page, and stays synchronized with Python through generated parity fixtures.
- **Paperclip workspace.** The former single-column browser is now a URL-driven Reader with a folder tree, metadata rail, stable heading links, syntax highlighting, recent pages, and per-page URLs. Setup and `verifySetup` close the loop between plugin install and agent-side skill configuration.
- **Idempotent v2 upgrade.** `/wiki:upgrade` and `init_wiki.py --upgrade` create `wiki/.wiki-cache/.gitignore` and surface the new `## Retrieval` schema section without changing existing page content.
- Agent documentation now records verified bundled-script support across all listed agents, including OMP.

### Notes for upgraders

- Pull v2.0.0 and run `/wiki:upgrade` (or `python skills/llm-wiki/scripts/init_wiki.py . --upgrade`), then approve the `## Retrieval` addition to `wiki/SCHEMA.md`. Existing pages need no content migration.
- Hybrid embeddings remain opt-in. Without embedding environment variables, search stays stdlib-only lexical BM25.
- The Paperclip plugin pins `@paperclipai/plugin-sdk` at `2026.428.0`; its calver SDK should be upgraded deliberately and revalidated against upstream source.

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

[2.0.0]: https://github.com/praneybehl/llm-wiki-plugin/releases/tag/v2.0.0
[Unreleased]: https://github.com/praneybehl/llm-wiki-plugin/compare/v3.1.0...HEAD
[3.1.0]: https://github.com/praneybehl/llm-wiki-plugin/releases/tag/v3.1.0
[3.0.0]: https://github.com/praneybehl/llm-wiki-plugin/releases/tag/v3.0.0
[2.0.7]: https://github.com/praneybehl/llm-wiki-plugin/releases/tag/v2.0.7
[2.0.6]: https://github.com/praneybehl/llm-wiki-plugin/releases/tag/v2.0.6
[2.0.5]: https://github.com/praneybehl/llm-wiki-plugin/releases/tag/v2.0.5
[2.0.4]: https://github.com/praneybehl/llm-wiki-plugin/releases/tag/v2.0.4
[2.0.3]: https://github.com/praneybehl/llm-wiki-plugin/releases/tag/v2.0.3
[2.0.2]: https://github.com/praneybehl/llm-wiki-plugin/releases/tag/v2.0.2
[2.0.1]: https://github.com/praneybehl/llm-wiki-plugin/releases/tag/v2.0.1
[0.3.0]: https://github.com/praneybehl/llm-wiki-plugin/releases/tag/v0.3.0
[0.2.0]: https://github.com/praneybehl/llm-wiki-plugin/releases/tag/v0.2.0
[0.1.0]: https://github.com/praneybehl/llm-wiki-plugin/releases/tag/v0.1.0
