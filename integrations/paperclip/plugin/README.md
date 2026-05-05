# `paperclip-plugin-llm-wiki`

A [Paperclip](https://github.com/paperclipai/paperclip) plugin that surfaces the [LLM Wiki](https://github.com/praneybehl/llm-wiki-plugin) inside Paperclip's UI as a read-only context lens — **search, browse, and read company knowledge in context**.

This is the **human-side** companion to the [`llm-wiki` skill](https://github.com/praneybehl/llm-wiki-plugin), which makes Paperclip's agents wiki-aware on heartbeat. The plugin doesn't replace the skill — it surfaces what the skill already maintains, where the operator already works.

## Status

**Pre-release (npm v0.0.1).** The Paperclip plugin runtime and SDK are themselves described by their maintainers as *"still early"* — pin the SDK version exactly (calver, e.g. `2026.428.0`) rather than a range. Expect breaking changes between SDK releases and re-validate against the live SDK source on each upgrade.

## Contents

- [What you get](#what-you-get)
- [Quick start](#quick-start)
- [How to use it](#how-to-use-it)
  - [Wiki sidebar](#wiki-sidebar)
  - [Full-page wiki view](#full-page-wiki-view)
  - [Wiki context on issues](#wiki-context-on-issues)
  - [Wiki health on the dashboard](#wiki-health-on-the-dashboard)
  - [`wiki.query` agent tool](#wikiquery-agent-tool)
- [Configuration](#configuration)
- [Pairing with the agent-side skill](#pairing-with-the-agent-side-skill)
- [Security and privacy](#security-and-privacy)
- [Versioning and upgrades](#versioning-and-upgrades)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Capability reference](#capability-reference)
- [Architecture (brief)](#architecture-brief)
- [License](#license)

## What you get

Five surfaces, all read-only:

| Surface | Where | What it does |
|---|---|---|
| **Wiki sidebar** | Company sidebar, alongside Issues / Agents / Goals | Browse the wiki by type, drill into pages, search across the whole wiki |
| **Full-page wiki view** | `/companies/:company/plugins/llm-wiki` | The same browser at full width — useful when you want to read multiple linked pages without losing focus |
| **Wiki context tab** | Inside any open issue, alongside Comments / Documents | Top wiki pages relevant to the issue's title and description, ranked by BM25 |
| **Wiki health widget** | Company dashboard | Page count, lint status (pass / warn / fail), link density, sharding-threshold messages |
| **`wiki.query` agent tool** | Available to any agent in the Company | BM25 search via tool call, for adapters that don't run the skill directly |

What it doesn't do — and won't, by design:

- **No editing.** No markdown editor, no graph view, no inline comments on wiki pages.
- **No write access.** The plugin never modifies files on disk. Edits happen through agents on heartbeat (via the skill) or your editor of choice (Obsidian, Claude Code, direct SSH).
- **No external network calls.** The plugin reads local filesystem only. It does not declare `http.outbound`.
- **No background work.** The plugin doesn't run scheduled jobs, doesn't subscribe to Paperclip events, doesn't ingest sources. The skill handles all of that.

## Quick start

### 1. Install the agent-side skill first

The wiki is created and maintained by agents, not by this plugin. Before installing the plugin, install the [`llm-wiki` skill](https://github.com/praneybehl/llm-wiki-plugin) for whichever adapter your Company uses (Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Pi, Hermes). See the [main repo README](https://github.com/praneybehl/llm-wiki-plugin#installation) for per-adapter install commands.

Then bootstrap a wiki in the Company's primary workspace:

```
/wiki:init
```

This creates `wiki/` and `raw/` in the workspace, seeds `wiki/SCHEMA.md`, `wiki/index.md`, and a starter page. (Equivalent natural-language invocations work in adapters that don't expose slash commands.)

If a wiki already exists, you can skip this step.

### 2. Install the Paperclip plugin

```bash
pnpm paperclipai plugin install paperclip-plugin-llm-wiki
```

What happens:

1. The host downloads the package from npm.
2. The host validates the manifest. If the validator rejects it, no surface is mounted.
3. The host displays the **eight capabilities** the plugin requests (full table in [Capability reference](#capability-reference)). All are read or registration capabilities — none allow writes, network calls, or secret access. Approve them.
4. The host persists the install record in Postgres and starts the worker child process.
5. The four UI surfaces become available without a server restart.

For local development against an unpublished build, point the host at the local path:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/absolute/path/to/integrations/paperclip/plugin","isLocalPath":true}'
```

### 3. Verify

Open any Company in Paperclip. You should see:

- A **Wiki** entry in the company sidebar.
- A **Wiki health** card on the dashboard with a real page count.
- Inside any open issue, a **Wiki context** tab.

If the dashboard widget shows *"Wiki path not configured"*, jump to [Troubleshooting](#troubleshooting).

## How to use it

### Wiki sidebar

The sidebar is the smallest surface and the one you'll touch most. Click the **Wiki** entry in the company sidebar to open it.

Three modes, controlled by a single state machine:

1. **Index view (default).** Lists every wiki page grouped by frontmatter `type` (source / entity / concept / synthesis / your custom types). Click any entry to drill in.
2. **Search view.** Type in the search box at the top. As you type, the worker runs BM25 search across all pages and the panel shows ranked results. The same algorithm the agent uses on heartbeat — results are byte-for-byte identical to `python skills/llm-wiki/scripts/wiki_search.py "<query>"` for the same corpus.
3. **Page view.** Once you click a result or an index entry, the page renders as markdown — including GFM tables, task lists, and `[[wikilink]]` resolution. Wikilinks are rendered as clickable internal links; clicking one navigates to that page within the sidebar without leaving Paperclip. Use the back button to return.

The sidebar is read-only. The "open in editor" link in the corner of the page view (if present in your Paperclip build) handles the handoff to your local editor.

### Full-page wiki view

The full-page view at `/companies/:company/plugins/llm-wiki` reuses the exact same browser as the sidebar, just at full width. Useful when you're reading multiple linked pages and the sidebar feels cramped — for instance, walking a chain of `[[wikilink]]` references between concept pages.

You can bookmark this URL or link to specific Companies' wikis from elsewhere in Paperclip.

### Wiki context on issues

Open any issue. Alongside the standard tabs (Comments, Documents, etc.), you'll see a **Wiki context** tab.

When you click it, the worker:

1. Reads `issue.title` and `issue.description` via `ctx.issues.get`.
2. Resolves the wiki path via `ctx.projects.getWorkspaceForIssue` (falls back to the Company's primary workspace if the issue isn't pinned to a specific workspace).
3. Runs BM25 over the issue's title + description against the full wiki.
4. Returns the top N results (default 5; configurable via `search_top_k`).

Each result shows the page title, frontmatter `type`, and a click-through link. Click any result to read the page (rendered the same way as the sidebar).

This is the surface that earns the plugin its keep — it's the difference between *"I should look up what we know about this competitor"* (and then forgetting) and *"the relevant pages are right there next to the issue"*.

If no relevant pages are found, the tab shows an empty state — not an error.

### Wiki health on the dashboard

The dashboard widget shows a small card summarizing wiki state:

| Field | Meaning |
|---|---|
| **Pages** | Count of wiki pages, excluding `SCHEMA.md`, `index.md`, `log.md`, `README.md`, and the `indexes/` and `graph/` directories |
| **Lint** | Badge: `pass` / `warn` / `fail`. See below for what triggers each |
| **Link density** | Average `[[wikilinks]]` per page (a rough proxy for how interconnected the wiki is) |
| **Scaling messages** | Threshold-aware nudges from the stats engine: *"Below first threshold"*, *"AT SHARD THRESHOLD"*, *"Past 300 pages"*, *"Past 500 pages — run lint weekly"* |

Lint badge logic (matches `wiki_lint.py` semantics):

- **`fail`** — at least one of: oversized-hard pages (over 800 lines), malformed frontmatter, duplicate slugs.
- **`warn`** — at least one of: broken `[[wikilinks]]`, orphan pages, missing required frontmatter fields, oversized-soft pages, stale hub pages (>90 days, ≥3 inbound).
- **`pass`** — none of the above.

The widget re-checks wiki health periodically (default every 60 minutes; configurable via `lint_check_interval_minutes`).

The widget is a **nudge surface, not a control surface** — it tells you the wiki needs attention, but you fix it through agents (`/wiki:lint`) or your editor.

### `wiki.query` agent tool

`wiki.query` is an agent-callable tool registered on the worker side. Any agent in the Company can invoke it during a heartbeat run.

**When to use it:** for HTTP-only adapters (Hermes Agent, custom HTTP/webhook agents) that don't run the `llm-wiki` skill directly. Agents that already run the skill should keep doing what they do — direct script invocation is faster and avoids the tool-call round trip.

**Tool descriptor (manifest):**

```json
{
  "name": "wiki.query",
  "displayName": "Query the LLM Wiki",
  "description": "BM25 search over the active Company's wiki. Returns top N pages with one-line summaries.",
  "parametersSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string" },
      "topK":  { "type": "number", "default": 5, "minimum": 1, "maximum": 20 },
      "type":  { "type": "string" },
      "tag":   { "type": "string" }
    },
    "required": ["query"]
  }
}
```

**Result shape (`ToolResult`):**

```json
{
  "content": "Top 5 wiki pages for \"transformer attention\":\n\n- [[transformer]] (entity) — Transformer\n- [[attention-mechanism]] (concept) — Attention Mechanism\n…",
  "data": {
    "results": [
      { "slug": "transformer", "title": "Transformer", "type": "entity", "score": 1.73 },
      { "slug": "attention-mechanism", "title": "Attention Mechanism", "type": "concept", "score": 1.58 }
    ]
  }
}
```

`content` is a markdown summary suitable for direct injection into an agent's context. `data.results` is the structured rank — preferred when the calling agent will format it themselves.

If the wiki path can't be resolved (capability declined, no project, missing directory), the tool returns `{ content: "Wiki not configured for this Company.", error: "wiki path not accessible" }` — never throws.

## Configuration

Per-Company config, settable in the auto-generated form at `/settings/plugins/io.praneybehl.llm-wiki`:

| Key | Type | Default | Bounds | Description |
|---|---|---|---|---|
| `wiki_path` | string | `wiki` | — | Path to the wiki directory, **relative to the Company's primary workspace**. Most operators won't change this. |
| `lint_check_interval_minutes` | number | `60` | min 5 | How often the dashboard widget re-runs lint. Lower values give a fresher signal at the cost of more filesystem reads. |
| `search_top_k` | number | `5` | 1–20 | Number of results returned by the issue context tab and the search box. |

The form is generated from the manifest's `instanceConfigSchema` at install time — no custom settings page.

**Per-Company isolation.** Each Company has its own config. If you run multiple Companies on the same Paperclip instance (e.g., an HQ Company plus business Companies), each has an independent wiki, an independent config, and the plugin scopes everything to the active Company via `ctx.projects` / `ctx.issues`.

## Pairing with the agent-side skill

This plugin **assumes the [`llm-wiki` skill](https://github.com/praneybehl/llm-wiki-plugin) is installed for the agents that run in this Company**. The skill creates and maintains the wiki; the plugin only reads it.

For agents to read and write the wiki on heartbeat, add the canonical agent-memory stanza from [`skills/llm-wiki/references/agent-memory-integration.md`](https://github.com/praneybehl/llm-wiki-plugin/blob/main/skills/llm-wiki/references/agent-memory-integration.md) to:

- `CLAUDE.md` — Claude Code adapters
- `AGENTS.md` — Codex / Cursor / OpenCode / Pi
- `GEMINI.md` — Gemini CLI
- `AGENTS.md` (with `CLAUDE.md` symlinked to it) — mixed adapter Companies

The stanza is short — three lines for the minimal variant, ~15 lines for the canonical variant — and tells the agent: *"there's a wiki at `wiki/`, read its index when you start a task, write back to it when you produce durable knowledge, and follow the conventions in `wiki/SCHEMA.md`."*

The plugin doesn't read or modify these memory files. They're entirely an agent-side concern.

## Security and privacy

Read-only by contract, with no external network access:

| Concern | Plugin behavior |
|---|---|
| **Filesystem writes** | None. The worker uses `node:fs.readFileSync`, `readdirSync`, `existsSync`, `statSync`. There is no `writeFileSync` call anywhere in the worker. |
| **External network** | None. The plugin does not declare `http.outbound`. The only network the worker speaks is JSON-RPC over stdin/stdout to its parent Paperclip host. |
| **Path traversal** | Blocked at every read. The worker computes `path.relative(workspaceRoot, target)` and rejects anything that starts with `..` or is absolute — slugs like `../../../etc/passwd` resolve to `{ error: "page not found" }`, never read. |
| **Credentials / secrets** | None requested. The plugin does not declare `secrets.read-ref` and never calls `ctx.secrets.resolve`. |
| **Issue data** | The worker reads `issue.title` and `issue.description` for the **Wiki context** tab only. These values are used to construct a BM25 query against the local wiki and never leave the Paperclip host. |
| **Wiki contents** | Read-only. The plugin reads `.md` files under the configured `wiki_path`, parses frontmatter and body, and renders them in the UI. Wiki contents never leave the Paperclip host. |
| **UI bundle** | Loaded as same-origin JavaScript inside the main Paperclip app (per the SDK's current trust model). No `eval`, no dynamic `import()` of external URLs. The bundle is statically analyzable. |

If the operator declines `project.workspaces.read` (or any other capability) at install, every surface degrades to *"wiki not accessible"* — the plugin never crashes, never throws to the host, and never silently loses data.

## Versioning and upgrades

**The plugin uses semver** (`0.0.1`, `0.1.0`, `1.0.0`, …). The Paperclip plugin SDK uses **calver** (`2026.428.0`). The plugin's `peerDependencies` pin the SDK to an exact calver release.

**Upgrading the plugin:**

```bash
pnpm paperclipai plugin upgrade io.praneybehl.llm-wiki
```

The host fetches the latest version, re-validates the manifest, displays any new capabilities the upgrade requests, and hot-restarts the worker. No Paperclip server restart required.

**Upgrading the Paperclip SDK that the plugin pins:**

This is a deliberate maintainer action — bumping `peerDependencies."@paperclipai/plugin-sdk"` requires re-running [Phase 0 validation](../FEASIBILITY.md) against the new SDK source to catch any contract drift. We do not auto-bump on patch releases.

**Wiki schema evolution.** The plugin's BM25 / lint / stats logic is locked to the wiki schema version it was built against. If the skill ships a breaking change to the schema (e.g., a new required frontmatter field), the plugin falls back to a permissive read mode and surfaces a warning to the operator on startup. Both ship from the same repo, so a single release tag covers both — there's no scenario where the skill is ahead of the plugin in the wild.

## Troubleshooting

### Sidebar / page slot shows "Wiki path not configured"

The configured `wiki_path` doesn't resolve under any project's primary workspace. Two likely causes:

- **The wiki hasn't been bootstrapped yet.** Run `/wiki:init` (or the equivalent natural-language invocation in your adapter) from any agent in the Company. The skill creates `wiki/` in the Company's primary workspace.
- **The wiki lives at a non-default path.** Set `wiki_path` to point at it via `/settings/plugins/io.praneybehl.llm-wiki`. The path is resolved relative to the workspace root (e.g. `wiki`, `docs/wiki`, `knowledge`).

### Plugin install fails with "Missing required capabilities for declared features: ui.dashboardWidget.register"

Known upstream bug — [`paperclipai/paperclip` issue #2276](https://github.com/paperclipai/paperclip/issues/2276). The validator has a duplicate-key entry in `UI_SLOT_CAPABILITIES` that triggers a false-positive rejection for plugins declaring `dashboardWidget`.

**Workaround until upstream fix lands:** comment out the duplicate `dashboardWidget` entry in your local Paperclip's `server/src/services/plugin-capability-validator.ts` and restart the host. See the linked issue for the exact lines.

If you'd rather avoid the workaround, ship a manifest variant without the `dashboardWidget` slot and lose only the dashboard health card — the other four surfaces (sidebar, page, issue tab, agent tool) still work.

### `wiki.query` returns `"wiki not configured for this Company"`

Same root cause as the sidebar message — the worker can't resolve the workspace path. Check the `wiki_path` config and confirm the operator approved `project.workspaces.read` at install. If the capability was declined, re-approve it via the plugin settings.

### Issue context tab is empty for issues that should have relevant wiki pages

The tab runs BM25 over `issue.title + issue.description`. Empty results usually mean one of:

- The issue title/description is too short for any term to match. Try adding context to the issue.
- No wiki pages match the issue's vocabulary. The wiki may genuinely lack coverage — surface this to the team or run `/wiki:ingest` against a relevant source.
- The wiki path isn't resolving (see *"Wiki path not configured"* above). Check the dashboard widget — if it shows pages, the path resolves.

### Search results from the plugin differ from agent heartbeat output

They shouldn't. Both implementations are tested for byte-for-byte parity against the canonical Python reference (`skills/llm-wiki/scripts/wiki_search.py`) on a fixed corpus — same BM25 constants (k1=1.5, b=0.75), same IDF formula (`log(1 + (N - df + 0.5) / (df + 0.5))`), same skip rules.

If they diverge, file an issue with:

- The exact query.
- A minimal corpus that reproduces the divergence.
- The two ranked outputs.

The fix is mechanical — regenerate the parity snapshot via `python3 integrations/paperclip/plugin/tests/fixtures/_gen_bm25_expectations.py` and update the TS port until the tests go green.

### Plugin worker crashes on startup

Check the Paperclip host's plugin log (location depends on your deployment — typically `/var/log/paperclipai/plugins/io.praneybehl.llm-wiki.log` or stderr of the worker child process).

The worker is wrapped to convert all expected error classes (capability denial, missing wiki path, malformed page) into graceful `{ error: "..." }` responses. A genuine crash usually means an unexpected SDK contract drift — open an issue with the log tail and the SDK version you're running.

### "I want to clear the plugin's cached state"

The plugin holds **no persistent state**. Every data provider re-reads the filesystem on call. Uninstall + reinstall is a no-op for cached state because there is no cache to clear.

The host may cache plugin install records and config. Use `pnpm paperclipai plugin uninstall io.praneybehl.llm-wiki` followed by a fresh install to reset that.

## FAQ

**Does this work without the agent-side skill?**

Sort of. The plugin will install and the surfaces will mount, but every page you see was written by an agent or a human. Without the skill, no agent maintains the wiki. Operators who want a static read-only wiki they manually edit could use the plugin alone, but that's not the intended workflow.

**Does this work with very large wikis?**

Yes — up to a point. The skill is designed to scale to thousands of pages via sharded indexes and BM25 fallback. The plugin's data providers re-read the wiki on every slot mount, so cold-start latency on the issue context tab grows linearly with wiki size. For a 1000-page wiki this is around 200–400ms; for 5000+ pages you may want pre-warming (deferred to v0.2 — see [`SPEC.md` §Open questions #4](../SPEC.md)).

**Can I customize the look?**

The plugin reads CSS variables the host exposes (`--paperclip-color-bg`, `--paperclip-color-text`, etc.) so it inherits your Paperclip theme automatically. There is no shipped component kit from the host yet (per the SDK README), so the plugin renders with plain semantic HTML + minimal class hooks. You can override styles via your Paperclip instance's global CSS if you need to.

**Can I edit the wiki from inside Paperclip?**

No — by design. The plugin is read-only. Editing happens through:

1. Agents on heartbeat (the skill's ingest workflow).
2. Your local editor (Obsidian, VS Code, Claude Code, direct SSH into the Paperclip host).
3. A future "Capture to wiki" toolbar action — deferred to v0.2 and not committed.

**Why not ship a wiki editor?**

The skill is the canonical author. Agents that maintain the wiki on heartbeat also maintain `[[wikilink]]` consistency, frontmatter, sharded indexes, the log, and the optional graph layer. A human-driven editor inside Paperclip would either duplicate that logic or fall out of sync with it. Single-author wins.

**What about Obsidian's graph view?**

If your wiki has the [optional typed graph layer](https://github.com/praneybehl/llm-wiki-plugin#architecture) (`wiki/graph/ontology.yaml` plus typed edges in page frontmatter), the agent-side `/wiki:graph` slash command answers structural queries (`neighbors`, `path`, `facts`) against `graph.sqlite`. This plugin doesn't surface graph data in the UI in v0.1 — focus is on the markdown read path. v0.2 may add a graph panel.

**Does this work with Obsidian Sync / Syncthing / git for wiki files?**

Yes. The wiki is just a directory of markdown files. The plugin reads whatever is on disk at slot-mount time, so any sync mechanism works as long as the synced directory is reachable from the Paperclip host.

If two writers (an agent and a human in Obsidian) modify the same page at the same time, you'll get the sync-tool's standard conflict resolution — `*.sync-conflict-*.md` for Syncthing, merge markers for git. The plugin doesn't participate in conflict resolution.

**Does the plugin send my wiki contents anywhere?**

No. The plugin makes zero external network calls. It reads local files via `node:fs` and renders them in the UI. The UI bundle runs same-origin in your Paperclip app and uses only the SDK's bridge (`usePluginData`, `useHostContext`) — no direct HTTP requests.

**Can I run the plugin without the dashboard widget?**

Yes — the [Issue #2276 workaround section](#plugin-install-fails-with-missing-required-capabilities-for-declared-features-uidashboardwidgetregister) above describes shipping a manifest variant without the widget. You'd lose the wiki health card; the other four surfaces (sidebar, page, issue context, agent tool) work unchanged.

**What happens when I uninstall?**

`pnpm paperclipai plugin uninstall io.praneybehl.llm-wiki` removes the install record from Postgres, kills the worker, and unmounts the four UI surfaces. **The wiki on disk is untouched** — read-only contract. You can reinstall later without losing anything.

**How do I report bugs or request features?**

[Open an issue](https://github.com/praneybehl/llm-wiki-plugin/issues) on the main repo. The plugin's source lives under `integrations/paperclip/plugin/` so issues for the plugin and for the skill share one tracker.

## Capability reference

The plugin requests **eight** capabilities at install. All are read or registration; none allow writes, network, or secret access.

| Capability | Required by | Why |
|---|---|---|
| `ui.sidebar.register` | sidebar slot | Mount the company-sidebar nav item |
| `ui.page.register` | page slot | Register the full-width `/companies/:c/plugins/llm-wiki` route |
| `ui.detailTab.register` | detailTab slot | Mount the issue-detail "Wiki context" tab |
| `ui.dashboardWidget.register` | dashboardWidget slot | Mount the dashboard health card |
| `agent.tools.register` | `tools[]` (`wiki.query`) | Expose the agent-callable search tool |
| `projects.read` | worker | List the Company's projects to find the workspace where the wiki lives |
| `project.workspaces.read` | worker | Resolve the absolute filesystem path of the workspace (the de-facto FS gate per [`plugin-file-browser-example`](https://github.com/paperclipai/paperclip/tree/master/packages/plugins/examples/plugin-file-browser-example)) |
| `issues.read` | worker (`relevantForIssue`) | Read `issue.title` + `issue.description` for context-relevance ranking |

The plugin **does not** request:

- Any write capability (`issues.create`, `issue.comments.create`, `plugin.state.write`, `database.namespace.write`, …).
- `events.subscribe` — the plugin doesn't subscribe to host events in v0.1 (computed-on-mount everywhere).
- `events.emit` — the plugin doesn't emit custom events.
- `http.outbound` — no external network calls.
- `secrets.read-ref` — no secrets needed; the wiki is local files.
- `instance.settings.register` — the auto-generated settings form from `instanceConfigSchema` is sufficient.

## Architecture (brief)

```
                       ┌─────────────────────────────────────────┐
                       │          Paperclip host (UI)            │
                       │                                         │
   Company sidebar  ──▶│ <WikiSidebar />                         │
   Page route       ──▶│ <WikiPage />                            │
   Issue detail     ──▶│ <WikiContextTab />                      │
   Dashboard        ──▶│ <WikiHealthIndicator />                 │
                       │                                         │
                       │   usePluginData / useHostContext        │
                       └────────────────┬────────────────────────┘
                                        │ JSON-RPC over bridge
                       ┌────────────────▼────────────────────────┐
                       │     Plugin worker (Node child process)  │
                       │                                         │
                       │  data providers:                        │
                       │    readPage / searchWiki / loadIndex    │
                       │    lintWiki / wikiHealth                │
                       │    relevantForIssue                     │
                       │  tool: wiki.query                       │
                       │                                         │
                       │  ctx.projects.getPrimaryWorkspace ─┐    │
                       │                                    │    │
                       └────────────────────────────────────┼────┘
                                                            │
                                                  node:fs   ▼
                                              ┌─────────────────────┐
                                              │  wiki/  (markdown)  │
                                              │   ↑↓ skill on       │
                                              │      heartbeat      │
                                              └─────────────────────┘
```

For the full design with verbatim SDK-source references, see [`SPEC.md`](../SPEC.md). For the Phase 0 validation report against the live Paperclip plugin SDK, see [`FEASIBILITY.md`](../FEASIBILITY.md).

## Repo layout

This package lives at `integrations/paperclip/plugin/` in [`praneybehl/llm-wiki-plugin`](https://github.com/praneybehl/llm-wiki-plugin). Sources, tests, fixtures, and the build configuration travel with the canonical skill so a single release tag covers both.

```
integrations/paperclip/
├── README.md          ← operator-facing: when to install plugin vs skill
├── SPEC.md            ← v0.1 design proposal with SDK source citations
├── FEASIBILITY.md     ← Phase 0 validation against the live SDK
└── plugin/
    ├── README.md      ← this file (npm + installer audience)
    ├── package.json
    ├── src/
    │   ├── manifest.ts
    │   ├── worker.ts
    │   ├── lib/{frontmatter,bm25,lint,stats}.ts
    │   └── ui/*.tsx
    ├── tests/         ← parity + harness + UI rendering
    ├── scripts/prepublish-checks.mjs
    └── esbuild.config.mjs
```

## License

MIT — see [LICENSE](https://github.com/praneybehl/llm-wiki-plugin/blob/main/LICENSE) at the repo root.
