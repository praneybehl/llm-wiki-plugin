# Spec: `paperclip-plugin-llm-wiki`

A Paperclip plugin that exposes the LLM Wiki to the Paperclip board where work already happens. Sub-deliverable of [`praneybehl/llm-wiki-plugin`](https://github.com/praneybehl/llm-wiki-plugin); lives at `integrations/paperclip/plugin/` in the repo and publishes to npm as `paperclip-plugin-llm-wiki`.

Status: proposal. v0.1 target.

> **Verification status**: Every API name, capability string, slot type, manifest field, and architectural claim in this spec is grounded in cited Paperclip plugin documentation as of May 2026. Where two sources conflict or where a detail is documented but not source-confirmed, this spec calls that out explicitly. The implementing agent should treat the [Validation Resources](#validation-resources) section below as the authoritative cross-reference and verify any uncertain spelling against the SDK source at code time.

## Validation resources

The implementing agent should keep these tabs open and re-check the spec against them before writing code. They are listed in priority order — the closer to the top, the more likely it is to be the source of truth on any disagreement.

**Authoritative source code (verify exact API spellings here):**

- [`packages/plugins/sdk/src/types.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/types.ts) — `PaperclipPluginManifestV1`, `PluginContext`, all canonical type definitions.
- [`packages/plugins/sdk/src/protocol.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/protocol.ts) — JSON-RPC method names and shapes between host and worker.
- [`packages/plugins/sdk/src/worker-rpc-host.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/worker-rpc-host.ts) — `definePlugin`, `runWorker`, lifecycle hooks.
- [`packages/plugins/sdk/src/ui/hooks.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/ui/hooks.ts) — `usePluginData`, `usePluginAction`, `usePluginStream`, `useHostContext`.
- [`server/src/services/plugin-capability-validator.ts`](https://github.com/paperclipai/paperclip/blob/master/server/src/services/plugin-capability-validator.ts) — the `UI_SLOT_CAPABILITIES` map and capability enforcement logic. **Issue [#2276](https://github.com/paperclipai/paperclip/issues/2276) shows a verbatim source snippet of the slot→capability map.**
- [`server/src/services/plugin-manifest-validator.ts`](https://github.com/paperclipai/paperclip/blob/master/server/src/services/plugin-manifest-validator.ts) — manifest field validation rules.
- [`server/src/services/plugin-host-services.ts`](https://github.com/paperclipai/paperclip/blob/master/server/src/services/plugin-host-services.ts) — host-side RPC handlers; `ctx.http` SSRF protections.

**Reference example plugins (compare against these structures):**

- [`plugin-hello-world-example`](https://github.com/paperclipai/paperclip/tree/master/packages/plugins/examples/plugin-hello-world-example) — minimal worker.
- [`plugin-authoring-smoke-example`](https://github.com/paperclipai/paperclip/tree/master/packages/plugins/examples/plugin-authoring-smoke-example) — manifest + worker + UI bundle reference.
- [`plugin-kitchen-sink-example`](https://github.com/paperclipai/paperclip/tree/master/packages/plugins/examples/plugin-kitchen-sink-example) — every slot type, every capability, full surface.
- [`plugin-file-browser-example`](https://github.com/paperclipai/paperclip/tree/master/packages/plugins/examples/plugin-file-browser-example) — **the canonical reference for the workspace-plugin filesystem pattern this plugin follows.** If anything in the architecture section conflicts with this example, the example wins.

**Plugin specs and authoring guide:**

- [`doc/plugins/PLUGIN_SPEC.md`](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md) — normative spec for the plugin system.
- [`doc/plugins/PLUGIN_AUTHORING_GUIDE.md`](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_AUTHORING_GUIDE.md) — author-facing how-to.
- [`doc/plugins/ideas-from-opencode.md`](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/ideas-from-opencode.md) — design rationale from opencode comparison.

**SDK package and scaffold:**

- [`@paperclipai/plugin-sdk` on npm](https://www.npmjs.com/package/@paperclipai/plugin-sdk) — published API surface, slot props (`PluginPageProps`, `PluginSidebarProps`, `PluginWidgetProps`, `PluginDetailTabProps`).
- [`packages/plugins/sdk/README.md`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/README.md) — runtime expectations, trust model.
- [`@paperclipai/create-paperclip-plugin` on npm](https://www.npmjs.com/package/@paperclipai/create-paperclip-plugin) — scaffold tool.
- [`packages/plugins/create-paperclip-plugin`](https://github.com/paperclipai/paperclip/tree/master/packages/plugins/create-paperclip-plugin) — scaffold source.

**Curated documentation:**

- [DeepWiki — Plugin System](https://deepwiki.com/paperclipai/paperclip/9-plugin-system) (overview).
- [DeepWiki — Plugin Architecture and Runtime](https://deepwiki.com/paperclipai/paperclip/9.1-plugin-architecture-and-runtime).
- [DeepWiki — Plugin SDK](https://deepwiki.com/paperclipai/paperclip/9.2-plugin-sdk).
- [DeepWiki — Plugin UI Slots and Launchers](https://deepwiki.com/paperclipai/paperclip/9.3-plugin-ui-slots-and-launchers).
- [DeepWiki — Plugin Authoring Guide](https://deepwiki.com/paperclipai/paperclip/9.4-plugin-authoring-guide).

**Third-party skills with grounded source references** (these point back to the same files but include build/publish lessons learned):

- [ClawNet `paperclip-plugin-dev` skill](https://clawnet.sh/skills/paperclip-plugin-dev) — explicit sandbox constraints, all 37 capabilities, 5 hooks, npm publishing pitfalls.
- [LobeHub `paperclip-create-plugin` skill](https://lobehub.com/skills/comeonoliver-skillshub-paperclip-create-plugin) — scaffold workflow.

**Discussions and issues that surface design intent or known gaps:**

- [Discussion #258 — Plugin System RFC](https://github.com/paperclipai/paperclip/discussions/258) — the original design conversation; useful for understanding why the system is shaped the way it is.
- [Issue #2276 — `UI_SLOT_CAPABILITIES` validator bug](https://github.com/paperclipai/paperclip/issues/2276) — contains the verbatim source map of slot→capability gating.
- [Issue #2678 — Plugin discovery UI is invisible](https://github.com/paperclipai/paperclip/issues/2678) — explains why CLI install is currently the only path.

## TL;DR

The agent-side integration is already solved by the existing skill — Paperclip's adapters (Claude Code, Codex, Gemini CLI, Cursor, OpenCode, Pi, Hermes) all install the skill via the `agentskills.io` standard, and the agent-memory integration writes the wiki into each agent's `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` so heartbeat work uses it automatically.

This plugin is the **human-side** piece. It surfaces relevant wiki pages inside Paperclip's existing UI surfaces — the company sidebar, issue detail tabs, the dashboard, and the global toolbar — so operators don't have to context-switch out of Paperclip to look up what the wiki knows about a lead, a competitor, or a recurring objection. It is deliberately **not** a wiki editor inside Paperclip. Editing happens in Obsidian, Claude Code, or any other markdown environment the operator already uses; the plugin is a read-mostly context lens.

The plugin is a thin worker (TypeScript, runs in the Paperclip plugin sandbox) plus a small React UI bundle. The worker exposes typed data providers (`ctx.data.register`) and one agent-callable tool (`ctx.tools.register`); the UI consumes them through the standard plugin bridge hooks. No new database tables. No background workers maintaining the wiki. No persistent plugin state beyond per-Company config (which workspace path the wiki lives at).

## Why a plugin at all

The existing skill makes agents wiki-aware on heartbeat. Operators who curate the wiki, however, still flip between Paperclip and Obsidian (or any markdown viewer) to read pages relevant to whatever they're approving, deciding, or scheduling. That context-switch is the friction this plugin eliminates.

There is also a class of question the agents can't usefully answer for the operator: "while I'm looking at this issue right now, what does the wiki already know about the underlying entity?" The agent ran on heartbeat earlier and may have read the wiki then; by the time the human is looking at the resulting issue, that context isn't visible. The plugin's job is to bring it into view at decision time.

## Non-goals

- **Not a wiki editor.** No markdown editor inside Paperclip. No graph view. No backlinks panel beyond what naturally appears in rendered markdown. Editing routes the operator to their existing markdown environment.
- **Not a replacement for the skill.** The skill remains the canonical artifact. This plugin assumes the skill is already installed for the agents and that `wiki/` exists on the Paperclip host's filesystem.
- **Not a sync layer.** Wiki files live on the Paperclip host. If the operator wants Obsidian or another local editor, they handle sync themselves (Syncthing, git, Obsidian Sync, or `paperclip-mcp` with their preferred editor).
- **Not a search-engine substitute.** BM25 is the same algorithm the skill's `wiki_search.py` uses. If the operator outgrows it, they outgrow it in both surfaces simultaneously and the upgrade path is shared.
- **Not multi-wiki.** v0.1 assumes one wiki per Company, located at a configurable path. Multi-wiki per Company is deferred unless real demand emerges.

## What v0.1 ships

Five UI surfaces, all read-only, all backed by the worker's typed data providers. The slot types and exact capability strings are taken directly from the `UI_SLOT_CAPABILITIES` map in [`plugin-capability-validator.ts`](https://github.com/paperclipai/paperclip/blob/master/server/src/services/plugin-capability-validator.ts), as confirmed by [issue #2276](https://github.com/paperclipai/paperclip/issues/2276):

```ts
// from server/src/services/plugin-capability-validator.ts (verbatim, per issue #2276)
const UI_SLOT_CAPABILITIES: Record<PluginUiSlotType, PluginCapability> = {
  sidebar: "ui.sidebar.register",
  sidebarPanel: "ui.sidebar.register",
  projectSidebarItem: "ui.sidebar.register",
  page: "ui.page.register",
  detailTab: "ui.detailTab.register",
  dashboardWidget: "ui.dashboardWidget.register",
};
```

The five surfaces:

1. **Company sidebar — "Wiki".** A `sidebar` slot that adds a navigation item to the company sidebar. Opens a thin index browser: reads `wiki/index.md` (or sharded `wiki/indexes/*.md` files when present), renders as a tree, lets the operator click through to view any page rendered as markdown. Search box at the top calls into the worker's BM25 implementation. The page view is read-only; an "open in editor" link sits in the corner. Capability: `ui.sidebar.register`. Receives `PluginSidebarProps` with `context.companyId`.

2. **Issue detail tab — "Wiki context".** A `detailTab` slot scoped to issues via `entityTypes: ["issue"]`. When the issue opens, the worker runs BM25 against the issue's title + description, returns the top N candidate wiki pages with one-line summaries pulled from frontmatter, and the UI renders them as a list with click-through to full-page view. This is the highest-value surface — it's where humans most need wiki context inline. Capability: `ui.detailTab.register`. Receives `PluginDetailTabProps` with `context.companyId`, `context.entityId` (the issue ID), and `context.entityType` (always `"issue"` here, guaranteed non-null per the SDK docs).

3. **Dashboard widget — "Wiki health".** A `dashboardWidget` slot that shows a small card on the company dashboard with: page count, last-ingested source date, lint status (pass/warn/fail), days since last lint. Calls into the worker's lint implementation periodically (interval configurable, default hourly). If the wiki is stale or has structural issues, the card nudges the operator to run `/wiki:lint` from their agent of choice. Capability: `ui.dashboardWidget.register`. Receives `PluginWidgetProps` with `context.companyId`.

4. **Full-page wiki view — `/companies/:company/plugins/llm-wiki`.** A `page` slot that gives the operator a focused full-screen wiki experience when the sidebar's small surface isn't enough — useful for browsing a long entity page or reading multiple linked pages without the rest of the Paperclip chrome. Reuses the same components as the sidebar, just at full width. Capability: `ui.page.register`. Receives `PluginPageProps` with `context.companyId` (company-context route per the SDK docs).

5. **Agent-callable tool — `wiki.query`.** Not a UI slot — registered via `ctx.tools.register("wiki.query", ...)` on the worker side. Capability: `agent.tools.register`. Any agent in the Company can invoke this tool during a heartbeat run; it returns ranked BM25 results with one-line summaries. This is what the skill already does on heartbeat via direct script invocation, exposed here as a Paperclip tool so agents that don't run the skill directly (HTTP-only adapters, etc.) can still query the wiki by tool call.

What none of these do: write to the wiki. The plugin is a window, not a hand. Writes happen through the agent (on heartbeat) or through the operator's editor of choice (Obsidian, Claude Code, etc.). This is a deliberate boundary; it's the simplest contract that delivers the integration value without forcing the plugin to take responsibility for wiki integrity.

**A note on slots not used in v0.1.** The DeepWiki [Plugin UI Slots](https://deepwiki.com/paperclipai/paperclip/9.3-plugin-ui-slots-and-launchers) page lists additional slot types (`toolbarButton`, `globalToolbarButton`, `commentAnnotation`, `settingsPage`) that don't appear in the verbatim `UI_SLOT_CAPABILITIES` snippet from issue #2276. Either the validator has been updated since that snippet, the slots are documented but unshipped, or they use different capability strings. The implementing agent should check the current state of [`plugin-capability-validator.ts`](https://github.com/paperclipai/paperclip/blob/master/server/src/services/plugin-capability-validator.ts) to know which is which. v0.1 deliberately uses only slots that are confirmed in source. A `globalToolbarButton` "Ask the wiki" launcher and a `commentAnnotation` for inline `[[wikilink]]` resolution would be natural v0.2 additions if those slots prove available.

## Architecture

### Worker (server-side)

The worker is a Node.js child process spawned by the Paperclip host, communicating via newline-delimited JSON-RPC 2.0 over `stdin`/`stdout` (per [`worker-rpc-host.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/worker-rpc-host.ts)). It uses `definePlugin({ setup })` and `runWorker(plugin, import.meta.url)` from `@paperclipai/plugin-sdk`. The canonical worker shape, taken from the [ClawNet skill's reference implementation](https://clawnet.sh/skills/paperclip-plugin-dev) which is itself grounded in the SDK source:

```ts
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    // Data providers consumed by the UI bundle via usePluginData.
    ctx.data.register("readPage",         async ({ companyId, slug }) => { /* ... */ });
    ctx.data.register("searchWiki",       async ({ companyId, query, topK, filters }) => { /* ... */ });
    ctx.data.register("loadIndex",        async ({ companyId }) => { /* ... */ });
    ctx.data.register("lintWiki",         async ({ companyId }) => { /* ... */ });
    ctx.data.register("wikiHealth",       async ({ companyId }) => { /* ... */ });
    ctx.data.register("relevantForIssue", async ({ companyId, issueId, topK }) => { /* ... */ });

    // Agent-callable tool — exposed to agents in any Company via the host's tool registry.
    ctx.tools.register(
      "wiki.query",
      {
        displayName: "Query the LLM Wiki",
        description: "BM25 search over the active Company's wiki. Returns top N pages with summaries.",
        parametersSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            topK: { type: "number", default: 5 },
            type: { type: "string", description: "Optional frontmatter type filter" },
            tag:  { type: "string", description: "Optional frontmatter tag filter" },
          },
          required: ["query"],
        },
      },
      async (params, runCtx) => {
        // returns { content: <markdown summary>, structured: <ranked results> }
      }
    );
  },

  async onHealth() {
    return { status: "ok" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

The handler signature `(params, runCtx)` and the tool result shape `{ content, ... }` are taken from the canonical example. Verify both against [`packages/plugins/sdk/src/types.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/types.ts) at implementation time.

Worker responsibilities, by domain:

- **Resolve the wiki path per Company.** The worker reads the per-Company `wiki_path` config, defaulting to `wiki`. Resolution to an absolute path uses `ctx.projects` (the SDK's typed projects client; capability `projects.read`) to look up the Company's primary workspace cwd. Per the [PLUGIN_SPEC](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md): *"Workspace plugins resolve workspace paths through `ctx.projects` and handle filesystem operations directly using Node APIs."*
- **Read markdown files for rendering and search.** See the [filesystem access](#filesystem-access-the-key-architectural-question) section below — this is the most important architectural question and is explicitly resolved against the [`plugin-file-browser-example`](https://github.com/paperclipai/paperclip/tree/master/packages/plugins/examples/plugin-file-browser-example) reference rather than inferred from documentation.
- **Run BM25 search.** TypeScript implementation; parity with `wiki_search.py` (BM25 ranking, frontmatter filtering on `type`/`tag`/`since`, top-N, backlinks, top-linked) is a v0.1 requirement so search results match what the skill produces. Pure stdlib equivalent — no external dependencies beyond what the SDK pulls in.
- **Run structural lint.** TypeScript implementation mirroring the structural checks of `wiki_lint.py`: orphan detection, broken `[[wikilinks]]`, oversized pages, frontmatter validation, stale `updated` dates. Returns pass/warn/fail plus a list of findings.
- **Compute health stats.** TypeScript implementation mirroring `wiki_stats.py`: page count by type, link density, last-ingested source date, scaling threshold the wiki is at.
- **Subscribe to host events** (optional pre-warming). `ctx.events.on("issue.created", ...)` and similar — the canonical event name `issue.created` is confirmed in the SDK reference. Other event names (`issue.commentCreated`, etc.) follow the `<entity>.<verb>` pattern but should be verified against the SDK source. Capability: `events.subscribe`.

What the worker explicitly does not do:

- Write to the wiki. There is no `writePage` action.
- Run lint with auto-repair. Lint is read-only here; fixes happen through the agent.
- Spawn subprocesses. Per the [ClawNet skill](https://clawnet.sh/skills/paperclip-plugin-dev): *"Plugin workers run in a `vm.createContext()` sandbox. No access to `process`, `require`, `fs`, `net`, `child_process`."* This rules out shelling out to the existing Python scripts. (See [filesystem access](#filesystem-access-the-key-architectural-question) below for how this reconciles with the workspace-plugin pattern.)
- Use `ctx.http.fetch` for internal Paperclip API calls. Per ClawNet: *"Plugin workers cannot call the internal Paperclip API via `ctx.http.fetch` — it blocks private IPs and requires absolute URLs. Use the typed SDK clients instead: `ctx.issues.list`, `ctx.agents.list`, etc."* The plugin uses `ctx.issues.list`/`ctx.projects.list` instead.
- Use `ctx.assets`. Per the [SDK README](https://www.npmjs.com/package/@paperclipai/plugin-sdk): *"`ctx.assets` is not part of the supported runtime in this build. Do not depend on asset upload/read APIs yet."*

### Filesystem access: the key architectural question

There is an apparent contradiction in the docs that the implementing agent must resolve before writing the worker:

- **PLUGIN_SPEC** says workspace plugins handle filesystem operations directly via Node APIs.
- **ClawNet's skill** says workers run in `vm.createContext()` with no `fs`/`require`/`process`/`net`/`child_process` access.
- **The repo ships [`plugin-file-browser-example`](https://github.com/paperclipai/paperclip/tree/master/packages/plugins/examples/plugin-file-browser-example)**, an example plugin whose entire purpose is filesystem operations.

These three statements cannot all be true in the same runtime mode. The most likely reconciliation, in priority order:

1. **The sandbox is per-category.** Plugins declared with `category: "workspace"` (one of the supported categories: `connector | workspace | automation | ui`) get filesystem access through some mechanism the file-browser example demonstrates. Other categories don't.
2. **The sandbox restriction is aspirational/partial.** ClawNet's skill describes a hardened mode that exists in some configurations but not the default `local_trusted` mode that solo operators run in. The file-browser example works in default mode.
3. **There is a host-mediated filesystem API the spec hasn't surfaced** — perhaps `ctx.workspace.readFile` or similar — that the file-browser example uses but the public docs underdocument.

**Resolution rule for this plugin:** the implementing agent reads the [`plugin-file-browser-example` source](https://github.com/paperclipai/paperclip/tree/master/packages/plugins/examples/plugin-file-browser-example) **before writing any worker code** and uses whatever pattern that example uses. This is non-negotiable; that example is the canonical reference for workspace-pattern filesystem access. If the example shows raw `fs/promises` working, the plugin uses raw `fs/promises`. If the example uses a host-provided API, the plugin uses the same API. If neither path is open, the plugin is not feasible in v0.1 and the implementer surfaces this discovery before writing any further code.

The plugin is declared with `category: "workspace"` per the scaffold's category list, which matches the canonical workspace-plugin pattern.

### UI bundle (browser-side)

Pre-built ESM bundle at `dist/ui/`. Per the SDK docs ([npm](https://www.npmjs.com/package/@paperclipai/plugin-sdk) and [DeepWiki Plugin SDK](https://deepwiki.com/paperclipai/paperclip/9.2-plugin-sdk)), Paperclip's host treats `react`, `react-dom`, and `@paperclipai/plugin-sdk/ui` as **externals provided by the host** at runtime via a global bridge — bundles must not include their own copies of these. The build (esbuild presets from [`@paperclipai/plugin-sdk/bundlers`](https://github.com/paperclipai/paperclip/tree/master/packages/plugins/sdk/src/bundlers)) marks them external automatically.

Imported types (all from `@paperclipai/plugin-sdk/ui`):

- `usePluginData<T>(key, params)` — fetches data from a `ctx.data.register` handler in the worker.
- `usePluginAction<T>(key)` — returns a mutation function bound to a `ctx.actions.register` handler.
- `usePluginStream<T>(channel, onMessage)` — subscribes to worker-emitted events.
- `useHostContext()` — returns `{ companyId, entityId?, entityType?, ... }` for the current slot.
- Slot prop types: `PluginPageProps`, `PluginSidebarProps`, `PluginWidgetProps`, `PluginDetailTabProps` — all guaranteed-shape props for their respective slots.
- `ErrorBoundary` — per the [PLUGIN_SPEC](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md), the SDK's `ui` subpath should export an `ErrorBoundary` component for plugin authors to catch render errors without crashing the host. Wrap each top-level slot component in this.

Components, each exported by name to match the manifest's `exportName`:

- `WikiSidebar` — index browser + search box. Mounted into `sidebar`. Calls `usePluginData("loadIndex", { companyId })` and renders the result tree.
- `WikiPage` — full-page experience. Mounted into `page` at route `/companies/:company/plugins/llm-wiki`. Same component tree as the sidebar but at full width.
- `WikiContextTab` — issue detail tab. Mounted into `detailTab` (entityTypes: `["issue"]`). Calls `usePluginData("relevantForIssue", { companyId, issueId, topK })`.
- `WikiPageView` — rendered markdown viewer; props: `pageSlug`. Used inside the sidebar drill-down, the issue detail tab, and the page slot when the operator drills into a result.
- `WikiHealthIndicator` — dashboard widget. Mounted into `dashboardWidget`. Calls `usePluginData("wikiHealth", { companyId })` periodically.

Markdown rendering uses `react-markdown` with `remark-gfm` (tables, task lists, strikethrough), `remark-wiki-link` (so `[[wikilinks]]` in pages render as clickable links that navigate within the plugin's surfaces), and a small custom plugin to render frontmatter as a collapsible header block. No code-execution renderers, no MathJax in v0.1 — keep the bundle small.

Per the [Plugin SDK docs](https://www.npmjs.com/package/@paperclipai/plugin-sdk), plugin UI bundles run as same-origin JavaScript inside the main Paperclip app today and *can* call ordinary Paperclip HTTP APIs with the board session; manifest capabilities currently gate worker-side host RPC calls, not frontend network access. iframe isolation is "Phase 3" deferred work. The plugin treats this as a trust boundary and keeps UI code self-contained: no dynamic `import()` of external URLs, statically-analyzable bundle, no bridge-bypassing direct API calls. All UI→backend traffic goes through `usePluginData`/`usePluginAction`.

The UI does not import a host-provided component kit. The host does not currently ship a stable shared component library (per the SDK README). Design tokens are read from CSS variables the host already exposes, so the plugin matches the host's theme automatically.

### Manifest

The manifest is exported from a TypeScript source file (typically `src/manifest.ts`) and conforms to `PaperclipPluginManifestV1` (defined in [`packages/plugins/sdk/src/types.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/types.ts)). Build outputs are wired through `package.json`'s `paperclipPlugin` key (manifest path, worker entry, UI directory). Plugin package names follow the `paperclip-plugin-*` naming convention.

Both `apiVersion` and `sdkVersion` are required manifest fields per the [PLUGIN_SPEC](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md): *"Plugin author updates `apiVersion` and `sdkVersion` in the manifest."* The exact `apiVersion` value to declare is whatever the host's manifest validator currently accepts; check [`plugin-manifest-validator.ts`](https://github.com/paperclipai/paperclip/blob/master/server/src/services/plugin-manifest-validator.ts).

```ts
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "io.praneybehl.llm-wiki",
  name: "paperclip-plugin-llm-wiki",
  displayName: "LLM Wiki",
  version: "0.0.1", // start at 0.0.1, not 0.1.0 — see Build & Release section
  apiVersion: 1,    // verify current value against plugin-manifest-validator.ts
  sdkVersion: 1,    // matches @paperclipai/plugin-sdk major
  description:
    "Surface the LLM Wiki inside Paperclip — search, browse, and read company knowledge in context.",
  category: "workspace",

  capabilities: [
    "ui.sidebar.register",
    "ui.page.register",
    "ui.detailTab.register",
    "ui.dashboardWidget.register",
    "agent.tools.register",
    "events.subscribe",
    "projects.read",
    "issues.read",
  ],

  ui: {
    slots: [
      {
        type: "sidebar",
        id: "wiki-sidebar",
        displayName: "Wiki",
        exportName: "WikiSidebar",
      },
      {
        type: "page",
        id: "wiki-page",
        displayName: "Wiki",
        exportName: "WikiPage",
        routePath: "llm-wiki",
      },
      {
        type: "detailTab",
        id: "wiki-context-tab",
        displayName: "Wiki context",
        exportName: "WikiContextTab",
        entityTypes: ["issue"],
      },
      {
        type: "dashboardWidget",
        id: "wiki-health",
        displayName: "Wiki health",
        exportName: "WikiHealthIndicator",
      },
    ],
  },

  tools: [
    {
      name: "wiki.query",
      displayName: "Query the LLM Wiki",
      description:
        "BM25 search over the active Company's wiki. Returns top N pages with summaries.",
      // parametersSchema declared in worker via ctx.tools.register
    },
  ],

  // instanceConfigSchema renders an auto-generated settings form at /settings/plugins/:pluginId.
  // Per PLUGIN_SPEC, JSON Schema; supports format: "secret-ref" for secret picker fields.
  instanceConfigSchema: {
    type: "object",
    properties: {
      wiki_path: {
        type: "string",
        default: "wiki",
        description: "Path to the wiki directory, relative to the Company's primary workspace.",
      },
      lint_check_interval_minutes: {
        type: "number",
        default: 60,
        minimum: 5,
        description: "How often the dashboard widget re-checks wiki health.",
      },
      search_top_k: {
        type: "number",
        default: 5,
        minimum: 1,
        maximum: 20,
        description: "Number of results returned by issue-detail-tab and search.",
      },
    },
  },
};

export default manifest;
```

**Capability strings.** The slot capabilities (`ui.sidebar.register`, `ui.page.register`, `ui.detailTab.register`, `ui.dashboardWidget.register`) are taken verbatim from the `UI_SLOT_CAPABILITIES` map in [issue #2276](https://github.com/paperclipai/paperclip/issues/2276). The non-UI capabilities follow patterns documented in the [ClawNet skill](https://clawnet.sh/skills/paperclip-plugin-dev): `tools[]` requires `agent.tools.register`, `events.subscribe` for `ctx.events.on`, `projects.read` and `issues.read` follow the `<resource>.<verb>` pattern (with `issues.read` named explicitly as a canonical capability example in the [DeepWiki overview](https://deepwiki.com/paperclipai/paperclip/9-plugin-system)). `projects.read` is inferred from the same pattern; verify in [`plugin-capability-validator.ts`](https://github.com/paperclipai/paperclip/blob/master/server/src/services/plugin-capability-validator.ts).

The validator rejects manifests where features lack matching capabilities (per the ClawNet skill: *"declaring a `dashboardWidget` slot without `ui.dashboardWidget.register` in capabilities causes install failure"*). The implementing agent should walk through the slots/tools/jobs declared in the manifest and confirm a corresponding capability is declared for each before publishing.

**No filesystem capability is requested or required as a manifest capability** — see the [filesystem access](#filesystem-access-the-key-architectural-question) section. If the file-browser example shows that filesystem reads happen through a host-mediated API behind a capability, that capability gets added to this list.

**No `http.fetch` capability is requested.** The plugin makes no external network calls in v0.1. Internal Paperclip API access uses typed SDK clients, not `ctx.http.fetch`.

**No `instance.settings.register` capability** because the plugin doesn't ship a custom settings page; the auto-generated form from `instanceConfigSchema` is sufficient.

### Data model

No plugin-owned tables in v0.1. All state is either:

- **Filesystem** (the wiki itself, owned by the operator and the agents, untouched by this plugin).
- **Plugin config** (`wiki_path` and friends, stored by the host's existing plugin config mechanism, declared via `instanceConfigSchema`).
- **Plugin state via `ctx.state`** (small things like "last lint check timestamp per Company" — the SDK exposes `state.get/set/delete` keyed at instance/company/project scope, sufficient for everything v0.1 needs).

When operator demand makes per-Company structured plugin storage necessary (saved searches, pinned pages, browsing history), those move to `ctx.state` first and only graduate to plugin-owned tables if the data model genuinely warrants it. The Paperclip plugin spec is explicit about this preference and we honor it.

### Security and capability gating

The plugin's capability list reads tightly:

- `projects.read` is the highest privilege the plugin needs in normal operation — it resolves the Company's primary workspace cwd to find the wiki.
- `issues.read` is scoped to surfacing context for the issue-detail tab; the plugin never mutates issues.
- `ui.*.register` capabilities are required by each slot type per the validator's `UI_SLOT_CAPABILITIES` map.
- `agent.tools.register` is required for the `wiki.query` tool.
- `events.subscribe` is required for the worker's `ctx.events.on(...)` subscriptions.

The plugin never asks for `http.fetch`, `secrets.read`, write access to issues/projects/agents, or any network capability. The wiki is local files; the plugin needs no network access at all in v0.1.

The host enforces these capabilities at the JSON-RPC layer: any worker call to a host RPC method whose capability isn't in the manifest returns `CAPABILITY_DENIED` (code -32001), per [`host-client-factory.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/host-client-factory.ts) (lines 65-74, cited in DeepWiki).

The host's broader trust model is worth surfacing in the plugin's npm README: per the [SDK README](https://www.npmjs.com/package/@paperclipai/plugin-sdk), *"Plugin workers and plugin UI should both be treated as trusted code today."* Workers run in `vm.createContext()` sandbox per ClawNet, but the sandbox is not yet the iron wall of an iframe — operators install plugins they trust.

If `ctx.secrets` becomes relevant (it isn't for v0.1; the wiki has no secrets), the pattern per ClawNet is: declare `format: "secret-ref"` in `instanceConfigSchema`, the operator picks a secret in the auto-generated settings form, the worker calls `await ctx.secrets.resolve(config.secretField)` at runtime, and the resolved value is never cached.

## How agents and humans share the wiki

The agent path is unchanged from the existing skill: agents read the wiki on heartbeat (via the `agent-memory-integration` stanza in `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`), and write to the wiki when their work produces durable knowledge. This plugin doesn't touch that path.

Additionally, agents can call the `wiki.query` tool registered by this plugin during heartbeat runs. This is useful for adapters where direct script invocation isn't available (HTTP/webhook agents, Hermes when not running the skill directly). Agents that already run the skill can ignore the tool; it's a no-op duplicate of work they're doing anyway.

The human path is what this plugin builds on the UI side. Humans read the wiki through Paperclip's UI when context is needed where Paperclip already shows them work. Humans edit the wiki through whichever markdown environment they prefer (Obsidian on a synced copy, a Claude Code session via `paperclip-mcp`, direct SSH into the Paperclip host, etc.).

The two paths converge on the same files. There is no double-bookkeeping. If an agent ingests a paper at 03:00 and creates a new entity page, the human sees it the next time they open the Wiki sidebar in Paperclip — no plugin event, no cache invalidation, just a fresh filesystem read on slot mount.

The one race-condition class worth flagging: an agent and a human writing to the same page at the same time. The plugin doesn't address this in v0.1 because the plugin doesn't write. If the operator uses Obsidian via Syncthing, conflicts surface as `*.sync-conflict-*.md` files (Syncthing's standard behavior); if the operator uses git, conflicts surface as merge markers. Either way, the plugin's read view will eventually show the resolved file.

## Multi-Company behavior

Paperclip plugins are instance-wide today (per-Company activation has been discussed in [Discussion #258](https://github.com/paperclipai/paperclip/discussions/258) but is not currently shipped). The plugin handles multi-Company correctly through configuration:

- Each Company has its own `wiki_path` config, defaulting to `wiki/` under that Company's primary workspace.
- All slot context is Company-scoped (the host passes `companyId` in the slot context, accessible via `useHostContext()`); the worker derives the right wiki path per call.
- Multiple Companies on the same Paperclip instance get independent wikis with no cross-contamination.

If the operator runs an HQ Company that aggregates context across business Companies, the HQ Company has its own wiki, and cross-Company queries either go through the existing per-Company plugin instances (one Company at a time in the HQ Wiki sidebar) or the operator runs an HQ-scoped agent that reads multiple Companies' wikis directly via filesystem. The plugin doesn't try to model "wiki federation" — that's a different product.

## Distribution and installation

Published to npm as `paperclip-plugin-llm-wiki`. The naming matches the host's `paperclip-plugin-*` loader convention. Source lives at `integrations/paperclip/plugin/` in the `praneybehl/llm-wiki-plugin` repo so it travels with the canonical skill and shares the version tag.

Installation, per the documented Paperclip plugin install flow:

```
pnpm paperclipai plugin install paperclip-plugin-llm-wiki
```

This resolves the npm package, validates the manifest, displays the requested capabilities to the operator, persists the install record in Postgres, and starts the worker. The plugin is hot-installable and hot-uninstallable; no Paperclip restart required.

Post-install, the operator configures `wiki_path` per Company in the auto-generated settings form at `/settings/plugins/io.praneybehl.llm-wiki`. If the wiki doesn't exist yet at that path, the plugin shows a one-time setup card prompting the operator to run `/wiki:init` (or the equivalent skill invocation in their adapter) from any agent in the Company. The plugin doesn't bootstrap the wiki itself — that's the skill's job.

Local development:

```
npx @paperclipai/create-paperclip-plugin paperclip-plugin-llm-wiki \
  --template default \
  --category workspace \
  --display-name "LLM Wiki" \
  --description "Surface the LLM Wiki inside Paperclip" \
  --author "praneybehl"
```

The scaffold produces a working manifest, worker, UI bundle, and bundler config. Inside the `praneybehl/llm-wiki-plugin` repo, the plugin uses `@paperclipai/plugin-sdk` directly. Outside the repo, the scaffold snapshots the SDK into a local `.paperclip-sdk/` directory until the SDK's npm publication is fully stable. Hot reload via the host's plugin dev watcher (debounced 500ms) restarts the worker on `dist/` changes.

## Listing in the awesome-paperclip directory

Once v0.1 ships and is tested against at least one real Company, submit a PR to [`gsxdsm/awesome-paperclip`](https://github.com/gsxdsm/awesome-paperclip) to list the plugin under "Extensions and integrations." Description: *"Surfaces the LLM Wiki inside Paperclip — search, browse, and read company knowledge in context. Pairs with the [llm-wiki Claude Code plugin](https://github.com/praneybehl/llm-wiki-plugin) for the agent-side install."*

## Compatibility and dependencies

- **Paperclip plugin SDK:** `@paperclipai/plugin-sdk` at the version current when v0.1 ships. The SDK README explicitly notes *"the runtime deployment model is still early"* and *"Plugin workers and plugin UI should both be treated as trusted code today"* — pin the SDK version in `package.json` peerDependencies and watch the SDK changelog for breaking changes.
- **Manifest version:** `PaperclipPluginManifestV1`. Both `apiVersion` and `sdkVersion` declared; verify exact values against [`plugin-manifest-validator.ts`](https://github.com/paperclipai/paperclip/blob/master/server/src/services/plugin-manifest-validator.ts) at implementation time.
- **Paperclip server:** v2026.318.0 or later (the release that shipped the full plugin framework). For the broader ecosystem context, current Paperclip releases at the time of writing are around v2026.428.0.
- **Node.js:** matches Paperclip's runtime requirement (currently Node 20+).
- **Python:** not required. The plugin is pure TypeScript.

The plugin must not import from host internals; it imports only from `@paperclipai/plugin-sdk` (worker-side) and `@paperclipai/plugin-sdk/ui` (UI-side). UI bundles must externalize `react`, `react-dom`, and `@paperclipai/plugin-sdk/ui` — the host provides these at runtime through the global plugin bridge. Per the SDK docs, plugin UI bundles must be statically-analyzable ESM with no dynamic `import()` of external URLs.

## Migration path with the skill

The skill remains the canonical home for all wiki logic — page conventions, ingest workflow, query workflow, lint workflow, scaling playbook, scripts. The plugin is a presentation layer over those.

When the skill ships a breaking change (e.g., a new frontmatter field becomes required, or the index format shards differently), the plugin's read paths must be updated in lockstep. Both ship from the same repo, so the same release tag covers both, and the CHANGELOG entry covers both. The plugin's TS BM25/lint implementations declare the wiki schema version they expect; a version mismatch surfaces to the operator on plugin startup as a warning and the plugin falls back to a permissive read mode rather than failing closed.

If a future Paperclip release ships first-class wiki support that subsumes this plugin, the plugin retires gracefully — the skill keeps working agent-side, the canonical wiki files are unchanged, and the operator's only loss is the in-Paperclip read surface, which the host now provides natively. This is a feature of the architecture, not a risk.

## Roadmap beyond v0.1

These are deferred until v0.1 is in real use and friction has been observed:

- **`globalToolbarButton` / `commentAnnotation` slots**, once they're confirmed available in the validator's `UI_SLOT_CAPABILITIES` map. A "Ask the wiki" launcher in the breadcrumb bar and inline `[[wikilink]]` resolution in comment threads are both natural fits for those slots.
- **Per-Company plugin activation**, once Paperclip's plugin system supports it.
- **Agent-backed query.** The current `wiki.query` tool returns ranked search results. The next iteration delegates to a configured agent in the Company and returns a synthesized answer with citations.
- **Wiki freshness annotations.** When a wiki page is referenced in a Paperclip comment via `[[wikilink]]` and the page has changed since the comment was posted, surface that visually.
- **Read-marker syncing.** A small "last visited" indicator per page would help the operator notice what's new since they last looked.
- **A "Capture to wiki" toolbar action** that takes the current Paperclip context and routes it as a draft source into `raw/` for the next agent ingest. Worth considering carefully because it's the first surface in the plugin that crosses the read-only boundary.
- **Multi-wiki per Company.**
- **Plugin-side BM25 index pre-warming** if cold-start latency on the issue-detail tab becomes a friction point.
- **`settingsPage` slot** if multi-Company patterns make the auto-generated config form tedious.

None of these are committed; all are hypotheses to validate against real usage.

## Repo layout change to support this

Current `praneybehl/llm-wiki-plugin` repo:

```
llm-wiki-plugin/
├── .claude-plugin/
├── commands/wiki/
├── skills/llm-wiki/
├── README.md
├── CHANGELOG.md
├── CONTRIBUTING.md
└── LICENSE
```

Proposed addition:

```
llm-wiki-plugin/
├── .claude-plugin/
├── commands/wiki/
├── skills/llm-wiki/
├── integrations/
│   └── paperclip/
│       ├── README.md          ← "Using llm-wiki inside a Paperclip Company"
│       │                        installation, AGENTS.md stanza, heartbeat pattern,
│       │                        when to install the plugin vs. just the skill
│       └── plugin/            ← npm package: paperclip-plugin-llm-wiki
│           ├── package.json   ← includes paperclipPlugin key with manifest/worker/ui paths
│           │                    AND `"files": ["dist", "package.json"]` to ensure dist/
│           │                    is published (npm uses .gitignore by default)
│           ├── src/
│           │   ├── manifest.ts
│           │   ├── worker.ts
│           │   ├── lib/
│           │   │   ├── frontmatter.ts
│           │   │   ├── bm25.ts
│           │   │   ├── lint.ts
│           │   │   └── stats.ts
│           │   └── ui/
│           │       ├── index.tsx
│           │       ├── WikiSidebar.tsx
│           │       ├── WikiPage.tsx
│           │       ├── WikiPageView.tsx
│           │       ├── WikiContextTab.tsx
│           │       └── WikiHealthIndicator.tsx
│           ├── tests/
│           │   ├── worker.spec.ts        ← uses createTestHarness from @paperclipai/plugin-sdk/testing
│           │   ├── bm25.spec.ts
│           │   └── lint.spec.ts
│           ├── esbuild.config.mjs        ← uses @paperclipai/plugin-sdk/bundlers presets
│           └── README.md      ← npm-facing readme; install instructions, capability list,
│                                config reference, troubleshooting
├── README.md                  ← updated to mention the Paperclip integration
├── CHANGELOG.md
├── CONTRIBUTING.md
└── LICENSE
```

The repo's top-level README adds a short "Integrations" section with a paragraph each on the agent-side install (existing) and the Paperclip plugin (new). Nothing that exists today gets reorganized. CI gains a build-and-typecheck job for the plugin package, gated to changes under `integrations/paperclip/`.

## Build and release

The plugin is scaffolded with `@paperclipai/create-paperclip-plugin` using the `default` template and `workspace` category. The scaffold produces a working manifest, worker, UI bundle, and bundler config; the plugin's actual code drops in on top of that.

Local development uses the scaffold's recommended path: a local Paperclip checkout, the plugin installed from a local path via `pnpm paperclipai plugin install <local-absolute-path>`. Hot-reload via `pnpm dev` rebuilds and restarts the worker on save, debounced by the host's 500ms watcher.

Testing uses `createTestHarness` from `@paperclipai/plugin-sdk/testing`. The harness simulates host services in memory, enforces capability checks, supports event simulation, lets us drive jobs and tools, and exposes state inspection. Tests cover: BM25 result parity against the Python reference for a fixed test corpus, lint detection of orphans/broken links/oversized pages, frontmatter parsing edge cases, and capability denial behavior (verify the plugin handles `CAPABILITY_DENIED` gracefully if an operator declines a capability).

**Pre-publish checklist** (lessons learned from the [ClawNet skill's documented publishing failures](https://clawnet.sh/skills/paperclip-plugin-dev) — these have cost real time for other plugin authors and are worth following exactly):

- `pnpm run build` (or `bun run build`) — required, since `dist/` is gitignored.
- In `package.json`, set `"files": ["dist", "package.json"]` — npm uses `.gitignore` to exclude files by default; without `files` the published tarball will be missing `dist/`.
- Confirm `paperclipPlugin` fields in `package.json` point to `./dist/manifest.js`, `./dist/worker.js`, `./dist/ui/`.
- Set version to `0.0.1` for first publish (the scaffold generates `0.1.0`; that's a non-trivial first-release version that's harder to roll back from).
- Every declared slot type has a matching capability in the manifest.
- Every `tools[]` entry corresponds to a `ctx.tools.register` call and is gated by `agent.tools.register`.
- Every `jobs[]` entry corresponds to a `ctx.jobs.register` call and is gated by `jobs.schedule`.
- Every `webhooks[]` entry is gated by `webhooks.receive`.
- `npm pack --dry-run` to verify `dist/` appears in the packed tarball before publishing.
- `pnpm test` (or equivalent) passes.
- Smoke-tested against a real Paperclip instance with a populated wiki.

Release is gated by:

1. The skill's existing CI passing.
2. The plugin's typecheck and tests passing, including BM25 parity tests against the Python reference.
3. A manual smoke test against a real Paperclip instance with at least one Company that has a populated wiki — verify each slot renders, search returns results, the dashboard widget shows real numbers, the `wiki.query` tool is callable from an agent.
4. CHANGELOG entry covering both skill and plugin changes for the release.

Publish flow: `pnpm publish` from `integrations/paperclip/plugin/`. The skill itself is not on npm (it's installed via the Claude Code plugin marketplace path or `npx skills add`), so the publication is plugin-only. Version numbers stay in sync with the repo's overall release tag — when the skill ships v0.3.0, the plugin ships v0.3.0, even if one of them has no functional changes that release.

## Open questions

These are the questions that need answers before v0.1 is locked. None of them block writing this spec; all of them get answered during implementation.

The first and most important is **the filesystem access mechanism.** Per the [filesystem access](#filesystem-access-the-key-architectural-question) section, three sources disagree on whether a worker can read files via `node:fs/promises` directly. The implementing agent **must** read [`plugin-file-browser-example`](https://github.com/paperclipai/paperclip/tree/master/packages/plugins/examples/plugin-file-browser-example) before writing worker code and use whatever pattern that example uses. If the pattern doesn't allow reading wiki files for a `category: workspace` plugin, this v0.1 design is not feasible and the implementer surfaces that finding before further work.

The second is **exact capability strings for `projects.read` and the precise shape of `apiVersion`/`sdkVersion`.** The DeepWiki overview names `issues.read` as a canonical capability example, and `projects.read` follows the same `<resource>.<verb>` pattern, but the exact spelling should be verified against [`plugin-capability-validator.ts`](https://github.com/paperclipai/paperclip/blob/master/server/src/services/plugin-capability-validator.ts) at implementation time. Same for the `apiVersion` value the current host accepts.

The third is **whether `globalToolbarButton`, `commentAnnotation`, and `settingsPage` slot types are currently shipped and gated.** They appear in [DeepWiki's slot table](https://deepwiki.com/paperclipai/paperclip/9.3-plugin-ui-slots-and-launchers) but not in the verbatim `UI_SLOT_CAPABILITIES` snippet in [issue #2276](https://github.com/paperclipai/paperclip/issues/2276). Re-check the validator's current state before proposing a v0.2 that uses any of them.

The fourth is **how aggressively to pre-warm the issue-detail tab.** Computing relevant pages on tab mount is simple and adds ~50-200ms of latency depending on wiki size. Subscribing to `issue.created` / `issue.opened` events and pre-warming feels nice but adds plugin complexity and a cache invalidation question. v0.1 default: compute on mount. Revisit if mount-time latency is annoying.

The fifth is **whether to ship the Capture-to-wiki action in v0.1** or hold it for v0.2. It's the single most-requested capability beyond pure read. Lean: hold for v0.2; preserve the spec's read-only architectural simplicity.

## Definition of done for v0.1

- Plugin package scaffolded with `@paperclipai/create-paperclip-plugin`, manifest validated, worker and UI build and typecheck.
- Filesystem access mechanism resolved against `plugin-file-browser-example`.
- Five surfaces functional in a real Paperclip instance: Wiki sidebar, Wiki page, issue-detail tab, dashboard health widget, `wiki.query` agent tool.
- TS BM25, lint, and stats implementations parity-tested against the Python reference scripts on a fixed corpus.
- Plugin installs hot from npm with `pnpm paperclipai plugin install paperclip-plugin-llm-wiki` against a stock Paperclip instance.
- Per-Company `wiki_path` configuration via the auto-generated settings form (driven by `instanceConfigSchema`).
- README at `integrations/paperclip/README.md` covering: when to install just the skill, when to also install the plugin, troubleshooting (missing wiki, wrong path, capability declined).
- README at `integrations/paperclip/plugin/README.md` covering the npm-facing surface.
- Top-level repo README updated with an Integrations section.
- CHANGELOG entry under the next release version.
- Pre-publish checklist (above) passes.
- `createTestHarness`-based unit tests passing for worker handlers, BM25, lint, and capability-denial behavior.
- One real Company smoke-tested end to end before npm publish.
- Listing PR opened against `gsxdsm/awesome-paperclip` after publish.

## Definition of done for the broader proposal (this spec itself)

- This file lives at `integrations/paperclip/SPEC.md` in the repo, or wherever the maintainer prefers.
- A GitHub issue or discussion is opened against `praneybehl/llm-wiki-plugin` with a link to this spec inviting comment before implementation begins.
- A second discussion is opened in `paperclipai/paperclip` Discussions to surface the plugin's intent to the wider Paperclip community before publication. This creates a feedback channel for capability concerns, naming concerns, and overlap with anything Paperclip core may be planning to build natively.

---

## Appendix: claim-by-claim source map

For traceability, every architectural and API claim in this spec is mapped to its source. Verify against the live SDK at implementation time — the plugin runtime is described by its maintainers as "still early" and details may shift.

| Claim | Source |
|---|---|
| Host-Worker model with newline-delimited JSON-RPC 2.0 over stdin/stdout | [DeepWiki 9.1](https://deepwiki.com/paperclipai/paperclip/9.1-plugin-architecture-and-runtime); [`worker-rpc-host.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/worker-rpc-host.ts) |
| `definePlugin({ setup, onHealth, onShutdown })` and `runWorker(plugin, import.meta.url)` | [DeepWiki 9.2](https://deepwiki.com/paperclipai/paperclip/9.2-plugin-sdk); [ClawNet skill canonical example](https://clawnet.sh/skills/paperclip-plugin-dev) |
| `ctx` modules: `events`, `jobs`, `state`, `data`, `actions`, `tools`, `agents`, `http`, `secrets`, `issues`, `projects` | [DeepWiki 9.2 / Context Modules](https://deepwiki.com/paperclipai/paperclip/9.2-plugin-sdk); ClawNet skill |
| `ctx.assets` is **NOT** supported in current build | [npm @paperclipai/plugin-sdk README](https://www.npmjs.com/package/@paperclipai/plugin-sdk) |
| UI hooks: `usePluginData`, `usePluginAction`, `usePluginStream`, `useHostContext` | [DeepWiki 9.2](https://deepwiki.com/paperclipai/paperclip/9.2-plugin-sdk); [`packages/plugins/sdk/src/ui/hooks.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/ui/hooks.ts) |
| Slot prop types: `PluginPageProps`, `PluginSidebarProps`, `PluginWidgetProps`, `PluginDetailTabProps` | [npm @paperclipai/plugin-sdk page](https://www.npmjs.com/package/@paperclipai/plugin-sdk) |
| Slot types and capability map (verbatim source): `sidebar`, `sidebarPanel`, `projectSidebarItem`, `page`, `detailTab`, `dashboardWidget` | [Issue #2276](https://github.com/paperclipai/paperclip/issues/2276); [`plugin-capability-validator.ts`](https://github.com/paperclipai/paperclip/blob/master/server/src/services/plugin-capability-validator.ts) |
| Additional documented slot types (`toolbarButton`, `globalToolbarButton`, `commentAnnotation`, `settingsPage`) — **documented but not source-confirmed in current validator** | [DeepWiki 9.3](https://deepwiki.com/paperclipai/paperclip/9.3-plugin-ui-slots-and-launchers) |
| Entity types for `entityTypes`: `project | issue | agent | goal | run | comment` | [npm @paperclipai/plugin-sdk page](https://www.npmjs.com/package/@paperclipai/plugin-sdk) — `PLUGIN_UI_SLOT_TYPES` and `PLUGIN_UI_SLOT_ENTITY_TYPES` exports |
| Capability denial returns `CAPABILITY_DENIED` (code -32001) | [DeepWiki 9.1](https://deepwiki.com/paperclipai/paperclip/9.1-plugin-architecture-and-runtime); [`host-client-factory.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/host-client-factory.ts) |
| Workers run in `vm.createContext()` sandbox; no direct `process`/`require`/`fs`/`net`/`child_process` | [ClawNet skill](https://clawnet.sh/skills/paperclip-plugin-dev) |
| Workspace plugins resolve workspace paths through `ctx.projects` and handle filesystem operations directly via Node APIs | [PLUGIN_SPEC](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md); [Discussion #258](https://github.com/paperclipai/paperclip/discussions/258) |
| **The reconciliation between the previous two rows is the single most important implementation question** | This spec, [filesystem access](#filesystem-access-the-key-architectural-question) section |
| Canonical `definePlugin` example with `ctx.events.on("issue.created", ...)`, `ctx.tools.register(name, descriptor, handler)` | [ClawNet skill](https://clawnet.sh/skills/paperclip-plugin-dev) |
| Tool capability is `agent.tools.register`; jobs `jobs.schedule`; webhooks `webhooks.receive` | [ClawNet skill](https://clawnet.sh/skills/paperclip-plugin-dev) checklist |
| `ctx.http.fetch` is SSRF-protected, blocks private IPs, requires absolute URLs; **cannot be used for internal Paperclip API** | [DeepWiki 9.2 / SSRF](https://deepwiki.com/paperclipai/paperclip/9.2-plugin-sdk); [ClawNet skill](https://clawnet.sh/skills/paperclip-plugin-dev) |
| `ctx.secrets.resolve(secretRef)` for secret resolution; declare via `format: "secret-ref"` in `instanceConfigSchema` | [ClawNet skill](https://clawnet.sh/skills/paperclip-plugin-dev); [PLUGIN_SPEC](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md) |
| Plugin UI must externalize `react`, `react-dom`, `@paperclipai/plugin-sdk/ui` | [DeepWiki 9.2 / External Dependencies](https://deepwiki.com/paperclipai/paperclip/9.2-plugin-sdk); [`ui/src/plugins/slots.tsx`](https://github.com/paperclipai/paperclip/blob/master/ui/src/plugins/slots.tsx) |
| `paperclipPlugin` field in `package.json` declares manifest/worker/ui paths | [DeepWiki 9.2 / Bundler Presets](https://deepwiki.com/paperclipai/paperclip/9.2-plugin-sdk); [`plugin-authoring-smoke-example/package.json`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/examples/plugin-authoring-smoke-example/package.json) |
| Plugin packages follow `paperclip-plugin-*` naming; loader scans for that pattern | [DeepWiki 9](https://deepwiki.com/paperclipai/paperclip/9-plugin-system) |
| Manifest uses `PaperclipPluginManifestV1` shape with both `apiVersion` and `sdkVersion` | [DeepWiki 9.2 / Bundler Presets](https://deepwiki.com/paperclipai/paperclip/9.2-plugin-sdk); [PLUGIN_SPEC](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md) |
| `instanceConfigSchema` (JSON Schema) renders auto-generated form at `/settings/plugins/:pluginId` | [PLUGIN_SPEC](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md) |
| `instanceConfigSchema` supports `format: "secret-ref"` for secret picker fields | [PLUGIN_SPEC](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md) |
| `createTestHarness` available; supports seeding, event simulation, job execution, state inspection | [DeepWiki 9.2 / Testing Harness](https://deepwiki.com/paperclipai/paperclip/9.2-plugin-sdk); [`packages/plugins/sdk/src/testing.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/testing.ts) |
| Hot install/uninstall/upgrade with no host restart; dev-watcher debounce 500ms | [DeepWiki 9.1](https://deepwiki.com/paperclipai/paperclip/9.1-plugin-architecture-and-runtime); [`plugin-dev-watcher.ts`](https://github.com/paperclipai/paperclip/blob/master/server/src/services/plugin-dev-watcher.ts) |
| Plugin UI runs same-origin with board session today; iframe isolation deferred to Phase 3 | [PLUGIN_SPEC](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md); [Discussion #258](https://github.com/paperclipai/paperclip/discussions/258) |
| Workers and UI are trusted code today | [@paperclipai/plugin-sdk README](https://www.npmjs.com/package/@paperclipai/plugin-sdk) |
| `ctx.state` has instance/company/project scope | [DeepWiki 9.2 / Context Modules](https://deepwiki.com/paperclipai/paperclip/9.2-plugin-sdk) |
| Plugins are instance-wide; per-Company activation proposed in Discussion #258 but unshipped | [PLUGIN_SPEC](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md); [Discussion #258](https://github.com/paperclipai/paperclip/discussions/258) |
| Plugin install flow: `pnpm paperclipai plugin install <pkg>`; resolves npm, validates manifest, displays capabilities to operator, persists in Postgres, starts worker | [PLUGIN_SPEC](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md) |
| `@paperclipai/create-paperclip-plugin` scaffolds plugins with templates `default`/`connector`/`workspace` and 4 supported categories | [npm @paperclipai/create-paperclip-plugin](https://www.npmjs.com/package/@paperclipai/create-paperclip-plugin) |
| Validator rejects manifests where features lack matching capabilities (e.g., `dashboardWidget` slot needs `ui.dashboardWidget.register` declared) | [ClawNet skill](https://clawnet.sh/skills/paperclip-plugin-dev); [Issue #2276](https://github.com/paperclipai/paperclip/issues/2276) |
| Pre-publish failure modes: `dist/` excluded by `.gitignore`, scaffold version `0.1.0` should become `0.0.1`, `paperclipPlugin` paths point to `./dist/`, must run build before publish, verify with `npm pack --dry-run` | [ClawNet skill](https://clawnet.sh/skills/paperclip-plugin-dev) — documented from real publishing failures |
| Plugin discovery UI is currently invisible; install is via CLI/API only | [Issue #2678](https://github.com/paperclipai/paperclip/issues/2678) |

The two specific identifier classes most likely to need adjustment at implementation time are (1) the `projects.read` capability string and (2) the canonical `apiVersion` value the current host accepts. Both follow documented patterns but are not directly named in the public docs. Verify against the live SDK source listed in [Validation resources](#validation-resources) above.
