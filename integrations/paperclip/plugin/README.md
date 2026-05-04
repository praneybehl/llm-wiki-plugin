# `paperclip-plugin-llm-wiki`

A [Paperclip](https://github.com/paperclipai/paperclip) plugin that surfaces the [LLM Wiki](https://github.com/praneybehl/llm-wiki-plugin) inside Paperclip's UI as a read-only context lens — search, browse, and read company knowledge in context.

This is the **human-side** companion to the [`llm-wiki` skill](https://github.com/praneybehl/llm-wiki-plugin), which makes Paperclip's agents wiki-aware on heartbeat. The plugin doesn't replace the skill — it surfaces what the skill already maintains, where the operator already works.

## Status

**Pre-release (v0.0.1).** The Paperclip plugin runtime and SDK are themselves described by their maintainers as *"still early"* — pin the exact SDK version (calver, e.g. `2026.428.0`) rather than a range, and expect breaking changes between SDK releases.

## What it does

Five surfaces, all read-only:

| Surface | Slot | What it shows |
|---|---|---|
| Wiki sidebar | `sidebar` | Index browser + search box, scoped to the active Company |
| Wiki page | `page` (route `/companies/:company/plugins/llm-wiki`) | Same browser at full width |
| Issue context tab | `detailTab` (entityTypes: issue) | Top wiki pages relevant to the open issue, by BM25 over title + description |
| Wiki health widget | `dashboardWidget` | Page count, lint status (pass / warn / fail), link density, scaling-threshold messages |
| `wiki.query` agent tool | `tools[]` | BM25 search over the Company's wiki, callable from any agent in the Company |

What it doesn't do: edit. No markdown editor inside Paperclip, no graph view, no backlinks panel. Editing happens in the operator's existing markdown environment (Obsidian, Claude Code, direct SSH) or through agents that run the skill on heartbeat. This is a deliberate read-only boundary.

## Install

Once v0.1 ships, install via the Paperclip CLI:

```bash
pnpm paperclipai plugin install paperclip-plugin-llm-wiki
```

The host validates the manifest, displays the capabilities the plugin requests, persists the install record in Postgres, and starts the worker. Install is hot — no server restart required.

For local development against an unpublished build:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/absolute/path/to/integrations/paperclip/plugin","isLocalPath":true}'
```

## Capabilities

The plugin requests **eight** capabilities — all read or registration; none allow writes, network calls, or secret reads.

| Capability | Required by | Rationale |
|---|---|---|
| `ui.sidebar.register` | sidebar slot | Mount the company-sidebar nav item |
| `ui.page.register` | page slot | Register the full-width `/companies/:c/plugins/llm-wiki` route |
| `ui.detailTab.register` | detailTab slot | Mount the issue-detail "Wiki context" tab |
| `ui.dashboardWidget.register` | dashboardWidget slot | Mount the dashboard health card |
| `agent.tools.register` | `tools[]` (`wiki.query`) | Expose the agent-callable search tool |
| `projects.read` | worker | List the Company's projects to find the workspace where the wiki lives |
| `project.workspaces.read` | worker | Resolve the absolute filesystem path of the workspace (the de-facto FS gate) |
| `issues.read` | worker (`relevantForIssue`) | Read the open issue's title + description for context-relevance ranking |

The plugin **does not** request: any write capability (issues / comments / state / database), `events.subscribe`, `http.outbound`, `secrets.read-ref`, or `instance.settings.register`. The auto-generated settings form from `instanceConfigSchema` is sufficient.

If the operator declines `project.workspaces.read` at install, the plugin reports a graceful *"wiki not accessible"* state on every surface — it never crashes, never throws to the host.

## Configuration

Per-Company config, settable in the auto-generated form at `/settings/plugins/io.praneybehl.llm-wiki`:

| Key | Type | Default | Notes |
|---|---|---|---|
| `wiki_path` | string | `wiki` | Path relative to the Company's primary workspace |
| `lint_check_interval_minutes` | number | `60` | Min: 5. How often the dashboard widget re-checks wiki health |
| `search_top_k` | number | `5` | Bounds: 1–20. Number of results from the issue tab and search |

## Pairing with the agent-side skill

This plugin assumes the [`llm-wiki` Claude Code skill](https://github.com/praneybehl/llm-wiki-plugin) is installed for the agents that run in this Company. The skill is what creates and maintains the wiki — the plugin only reads it.

For the agents to read and write the wiki on heartbeat, add the canonical stanza from `skills/llm-wiki/references/agent-memory-integration.md` to:

- `CLAUDE.md` for Claude Code adapters
- `AGENTS.md` for Codex / Cursor / OpenCode / Pi
- `GEMINI.md` for Gemini CLI

If the operator runs multiple adapters in the same Company, use `AGENTS.md` and symlink `CLAUDE.md`.

The `wiki.query` agent tool exposed by this plugin is also useful for HTTP-only adapters (e.g. Hermes) that don't run the skill directly — agents can still query the wiki by tool call instead of by direct script invocation.

## Troubleshooting

**Sidebar shows "Wiki path not configured".** The configured `wiki_path` doesn't exist under any project's primary workspace. Run `/wiki:init` from any agent in this Company, or set `wiki_path` to point at an existing directory.

**Capabilities prompt shows more capabilities than expected.** The eight capabilities above are the full set; if the host shows fewer, it's the validator [issue #2276](https://github.com/paperclipai/paperclip/issues/2276) — there's a known duplicate-key bug in `UI_SLOT_CAPABILITIES` that can cause some plugins declaring `dashboardWidget` to be rejected with *"Missing required capabilities for declared features: ui.dashboardWidget.register"*. Workaround until upstream fix lands: comment out the duplicate `dashboardWidget` entry in your local Paperclip's `server/src/services/plugin-capability-validator.ts`.

**`wiki.query` returns "wiki not accessible".** Same root cause as the sidebar — check the workspace path resolution and the `wiki_path` config.

**Search results don't match the agent's heartbeat results.** They should. Both use the same BM25 algorithm with the same constants (k1=1.5, b=0.75, IDF formula). If they diverge, the canonical Python reference is at `skills/llm-wiki/scripts/wiki_search.py` — file an issue with the corpus and queries.

## Architecture

- **Worker** (Node.js child process). Runs in `vm.createContext` sandbox per the plugin runtime; reads the wiki directly with `node:fs` after resolving the workspace path through `ctx.projects.getPrimaryWorkspace`. No external network calls.
- **UI bundle**. ESM modules loaded by the Paperclip host. React + react-markdown + remark-gfm; SDK UI hooks (`usePluginData`, `useHostContext`) for the bridge.
- **Algorithmic parity** with `skills/llm-wiki/scripts/wiki_{search,lint,stats}.py` is mechanically enforced by snapshot tests against the Python reference. See [`tests/fixtures/_gen_bm25_expectations.py`](tests/fixtures/_gen_bm25_expectations.py).

For the full design including the SDK contracts each piece is built against, see [`integrations/paperclip/SPEC.md`](../SPEC.md) and [`integrations/paperclip/FEASIBILITY.md`](../FEASIBILITY.md).

## Repo layout

This package lives under `integrations/paperclip/plugin/` in the [praneybehl/llm-wiki-plugin](https://github.com/praneybehl/llm-wiki-plugin) repo. Sources, tests, and the build configuration travel with the canonical skill so a single release tag covers both.

## License

MIT — see [LICENSE](../../LICENSE) at the repo root.
