# Phase 0 — Feasibility report for `paperclip-plugin-llm-wiki`

**Date:** 2026-05-05
**Scope:** Validate every assumption SPEC.md makes against live `paperclipai/paperclip` source on `master` and the published `@paperclipai/plugin-sdk` and `@paperclipai/create-paperclip-plugin` packages on npm. Output corrections needed before Phase 1.

## TL;DR

**GO on v0.1.** The Paperclip plugin SDK supports everything the SPEC needs:

- Workers run with raw `node:fs` access — the file-browser-example uses `fs.readFileSync` directly.
- All UI slots SPEC needs (`sidebar`, `page`, `detailTab`, `dashboardWidget`) are shipped and gated by capabilities present in the validator.
- `agent.tools.register` works as documented; `wiki.query` is implementable.
- `createTestHarness` exists with a rich surface (`seed`, `getData`, `executeTool`, `emit`, etc.) — TDD per the approved plan is straightforward.

**However, SPEC.md has ~12 specific factual errors that must be corrected before code lands.** They're enumerated in §8 below. None are blocking; all change the manifest shape, capability list, or import paths in mechanical ways.

**Open caveat (not blocking):** Paperclip [issue #2276](https://github.com/paperclipai/paperclip/issues/2276) is OPEN. Re-read the live issue body and current master `plugin-capability-validator.ts` shows the bug actually affects **worker-only plugins without UI slots** — the validator iterates `manifest.ui?.slots ?? []` and now (current master) gates the slot-capability check on `uiSlots.length > 0`, but pre-fix builds required slot capabilities even when the plugin had no `ui` field. **Our plugin declares `dashboardWidget` AND its matching `ui.dashboardWidget.register` capability, so we never trip this.** The bug is irrelevant to us; details preserved in §7 only because the issue is OPEN until the fix tags a release.

## 1. Filesystem access — GO

**Source:** [`packages/plugins/examples/plugin-file-browser-example/src/worker.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/examples/plugin-file-browser-example/src/worker.ts), [`src/manifest.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/examples/plugin-file-browser-example/src/manifest.ts).

The worker's filesystem imports (verbatim, lines 1-3):

```ts
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
```

The pattern is:

1. Resolve workspace path: `await ctx.projects.listWorkspaces({ projectId, companyId })` returns `{ cwd, ... }[]`.
2. Resolve user-config path against workspace cwd with `path.resolve(cwd, configPath)`.
3. Containment guard: `const rel = path.relative(cwd, target); if (rel.startsWith("..") || path.isAbsolute(rel)) throw …;`
4. Use `fs.existsSync`, `fs.statSync`, `fs.readdirSync`, `fs.readFileSync` directly.

There is no `ctx.workspace` API and no host-mediated filesystem RPC. Workers run in a Node sandbox with raw `node:fs` access. The capability gate is **`project.workspaces.read`** (which gives access to `ctx.projects.listWorkspaces`) — not a separate filesystem capability. The wiki plugin will use the same pattern.

The corresponding spec language is in [`doc/plugins/PLUGIN_SPEC.md`](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md) §14: *"Plugins that need filesystem, git, terminal, or process operations handle those directly using standard Node APIs … the host does not proxy low-level OS operations."* The "contradiction" the SPEC.md flagged is resolved: ClawNet's claim that workers have no `fs` access was simply wrong.

## 2. Manifest validator — what's actually accepted

**Source:** [`packages/shared/src/validators/plugin.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/shared/src/validators/plugin.ts) (Zod schema, lines 440-475), [`packages/shared/src/constants.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/shared/src/constants.ts) (`PLUGIN_API_VERSION = 1`).

| Field | Validation |
|---|---|
| `apiVersion` | `z.literal(1)`. **Only `1` accepted.** |
| `sdkVersion` | **NOT a field on the schema.** The spec doc §29.2 mentions a future `sdkVersion` semver-range; no example manifest declares it; the validator does not check it. **Do not declare `sdkVersion` in our manifest.** |
| `id` | `/^[a-z0-9][a-z0-9._-]*$/`, required. `io.praneybehl.llm-wiki` is valid. |
| `version` | Strict semver regex. `0.0.1` is valid. |
| `displayName` | min 1, **max 100** chars. |
| `description` | min 1, **max 500** chars. |
| `author` | min 1, **max 200** chars. |
| `categories` | **Plural array**, values from `["connector", "workspace", "automation", "ui"]`, min 1. **NOT `category` singular.** |
| `capabilities` | Array, min 1. Each must be in the canonical capability list (see §3). |
| `entrypoints` | Required object. `entrypoints.worker: string` required; `entrypoints.ui?: string` optional. |
| `instanceConfigSchema` | Optional JSON Schema; auto-renders form at `/settings/plugins/:pluginId`. |
| `tools` | Optional array of `{ name, displayName, description, parametersSchema }`. |
| `ui` | Optional `{ slots: [...] }`; each slot has `id`, `displayName`, `exportName`, `type`. Duplicate slot `id`s are rejected. |
| `minimumHostVersion` | Optional, semver regex. (`minimumPaperclipVersion` is the legacy alias.) |

Real example manifests ([hello-world](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/examples/plugin-hello-world-example/src/manifest.ts), [authoring-smoke](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/examples/plugin-authoring-smoke-example/src/manifest.ts), [kitchen-sink](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/examples/plugin-kitchen-sink-example/src/manifest.ts)) confirm: `apiVersion: 1`, `categories: [...]`, no `sdkVersion`.

## 3. Capability map and full capability list — verbatim

**Source:** [`server/src/services/plugin-capability-validator.ts`](https://github.com/paperclipai/paperclip/blob/master/server/src/services/plugin-capability-validator.ts), [`packages/shared/src/constants.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/shared/src/constants.ts) (lines 610-740).

### `UI_SLOT_CAPABILITIES` (verbatim, current)

```ts
const UI_SLOT_CAPABILITIES: Record<PluginUiSlotType, PluginCapability> = {
  sidebar: "ui.sidebar.register",
  sidebarPanel: "ui.sidebar.register",
  projectSidebarItem: "ui.sidebar.register",
  page: "ui.page.register",
  detailTab: "ui.detailTab.register",
  taskDetailView: "ui.detailTab.register",
  dashboardWidget: "ui.dashboardWidget.register",
  globalToolbarButton: "ui.action.register",
  toolbarButton: "ui.action.register",
  contextMenuItem: "ui.action.register",
  commentAnnotation: "ui.commentAnnotation.register",
  commentContextMenuItem: "ui.action.register",
  settingsPage: "instance.settings.register",
};
```

Notes:

- Many slot types share one capability — `ui.action.register` covers all four toolbar/menu kinds, `ui.sidebar.register` covers all three sidebar kinds, `ui.detailTab.register` covers `detailTab` + `taskDetailView`.
- `commentAnnotation` and `settingsPage` are shipped — SPEC speculated they might be deferred. They're not.
- A separate `LAUNCHER_PLACEMENT_CAPABILITIES` map applies the same mapping to `manifest.launchers[].placementZone`.

### Full capability list (`PLUGIN_CAPABILITIES`, grouped as in source)

- **Data Read**: `companies.read`, `projects.read`, `project.workspaces.read`, `issues.read`, `issue.relations.read`, `issue.subtree.read`, `issue.comments.read`, `issue.documents.read`, `agents.read`, `goals.read`, `goals.create`, `goals.update`, `activity.read`, `costs.read`, `issues.orchestration.read`, `database.namespace.read`.
- **Data Write**: `issues.create`, `issues.update`, `issue.relations.write`, `issues.checkout`, `issues.wakeup`, `issue.comments.create`, `issue.interactions.create`, `issue.documents.write`, `agents.pause`, `agents.resume`, `agents.invoke`, `agent.sessions.create`, `agent.sessions.list`, `agent.sessions.send`, `agent.sessions.close`, `activity.log.write`, `metrics.write`, `telemetry.track`, `database.namespace.migrate`, `database.namespace.write`.
- **Plugin State**: `plugin.state.read`, `plugin.state.write`.
- **Runtime/Integration**: `events.subscribe`, `events.emit`, `jobs.schedule`, `webhooks.receive`, `api.routes.register`, `http.outbound`, `secrets.read-ref`, `environment.drivers.register`.
- **Agent Tools**: `agent.tools.register`.
- **UI**: `instance.settings.register`, `ui.sidebar.register`, `ui.page.register`, `ui.detailTab.register`, `ui.dashboardWidget.register`, `ui.commentAnnotation.register`, `ui.action.register`.

### Capabilities our plugin needs (final list for v0.1)

```ts
capabilities: [
  // UI slots:
  "ui.sidebar.register",      // WikiSidebar (sidebar slot)
  "ui.page.register",         // WikiPage (page slot)
  "ui.detailTab.register",    // WikiContextTab (detailTab slot)
  "ui.dashboardWidget.register", // WikiHealthIndicator (dashboardWidget slot)

  // Worker:
  "agent.tools.register",     // wiki.query tool
  "projects.read",            // ctx.projects.* — list projects, find Company workspace
  "project.workspaces.read",  // ctx.projects.listWorkspaces — get cwd to resolve wiki_path
  "issues.read",              // ctx.issues.get — for relevantForIssue

  // Optional (deferred but cheap to include now for v0.2 pre-warming):
  // "events.subscribe",      // hold for v0.2 — SPEC §Open questions #4
],
```

**Drop from SPEC's draft list:** `events.subscribe` (we don't subscribe in v0.1; safer to omit and not ask the operator for permissions we don't use).

## 4. SDK runtime surface — what `ctx`, hooks, and harness actually look like

**Sources:** [`packages/plugins/sdk/src/types.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/types.ts), [`worker-rpc-host.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/worker-rpc-host.ts), [`define-plugin.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/define-plugin.ts), [`protocol.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/protocol.ts), [`ui/hooks.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/ui/hooks.ts), [`ui/types.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/ui/types.ts), [`ui/components.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/ui/components.ts), [`testing.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/testing.ts), [`bundlers.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/bundlers.ts).

### `definePlugin` and `runWorker`

```ts
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

export function definePlugin(definition: PluginDefinition): PaperclipPlugin
// PluginDefinition fields: setup (required), onHealth?, onConfigChanged?, onShutdown?,
//   onValidateConfig?, onWebhook?, onApiRequest?, plus 8 onEnvironment* hooks.

export function runWorker(
  plugin: PaperclipPlugin,
  moduleUrl: string,
  options?: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream },
): WorkerRpcHost | void
```

`PluginContext` (`ctx`) exposes: `manifest`, `config`, `events`, `jobs`, `launchers`, `db`, `http`, `secrets`, `activity`, `state`, `entities`, `projects`, `companies`, `issues`, `agents`, `goals`, `data`, `actions`, `streams`, `tools`, `metrics`, `telemetry`, `logger`. **No top-level `ctx.workspace`** and **no `ctx.assets`** (per SDK README: *"`ctx.assets` is not part of the supported runtime in this build"*).

### Tool registration

```ts
ctx.tools.register(
  name: string,
  declaration: Pick<PluginToolDeclaration, "displayName" | "description" | "parametersSchema">,
  fn: (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult>,
): void
```

`ToolResult` is `{ content?: string; data?: unknown; error?: string }`. **There is no `structured` field** — structured output goes in `data`. The SPEC said `{ content, structured }`; that's wrong.

The corresponding manifest entry shape (in `tools[]`):

```ts
{ name: string; displayName: string; description: string; parametersSchema: JsonSchema }
```

`parametersSchema` is **declared in both the manifest and the worker's `register` call** (same schema, the worker pulls from `Pick<…>`).

### UI hooks

```ts
import { usePluginData, usePluginAction, usePluginStream, useHostContext, usePluginToast }
  from "@paperclipai/plugin-sdk/ui";

usePluginData<T>(key, params?): { data, error, loading }
useHostContext(): PluginHostContext
//   { companyId: string|null, companyPrefix: string|null, projectId: string|null,
//     entityId: string|null, entityType: string|null, parentEntityId?, userId: string|null,
//     renderEnvironment? }
```

**`companyId` is `string | null`**, not guaranteed-string. UI code must handle null (e.g., render an empty state). SPEC implied it was always present in slot context; that's wrong.

Slot prop types: `PluginPageProps`, `PluginSidebarProps`, `PluginWidgetProps` (NOT `PluginDashboardWidgetProps`), `PluginDetailTabProps` — the last guarantees non-null `entityId` and `entityType`.

### `ErrorBoundary` — gotcha

`ErrorBoundary` is **defined in `ui/components.ts` but NOT re-exported from `ui/index.ts`**. The package.json subpath exports include `./ui` and `./ui/hooks` but not `./ui/components`. Two options:

1. Roll our own React error boundary in `src/ui/ErrorBoundary.tsx` (10 LOC, no risk).
2. Try to deep-import via `@paperclipai/plugin-sdk/ui/components` and accept that may fail if it's not in the export map.

**Decision:** roll our own. It's trivial and removes a brittle dependency.

### Test harness

```ts
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

createTestHarness({
  manifest: PaperclipPluginManifestV1,
  capabilities?: PluginCapability[],   // override; defaults to manifest.capabilities
  config?: Record<string, unknown>,
}): TestHarness
```

`TestHarness` exposes `ctx`, `seed({...})`, `setConfig`, `emit(eventType, payload)`, `runJob`, `getData<T>(key, params?)`, `performAction<T>`, `executeTool<T>(name, params, runCtx?)`, `getState`, plus inspection arrays (`logs`, `activity`, `metrics`, `telemetry`, `dbQueries`, `dbExecutes`).

**Capability denial behavior:** when an `options.capabilities` list is missing a needed capability, the harness **throws a plain `Error`** with message `Plugin '${manifest.id}' is missing required capability '${capability}' in test harness`. It does **not** simulate the production wire-level `CAPABILITY_DENIED` (-32001). For unit-testing graceful denial behavior, expect `Error` and assert the message.

The wire-level constant is in [`protocol.ts`](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/protocol.ts):

```ts
export const PLUGIN_RPC_ERROR_CODES = {
  WORKER_UNAVAILABLE: -32000,
  CAPABILITY_DENIED: -32001,
  WORKER_ERROR:       -32002,
  TIMEOUT:            -32003,
  METHOD_NOT_IMPLEMENTED: -32004,
  UNKNOWN:            -32099,
} as const;
```

### Bundler presets

```ts
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

createPluginBundlerPresets({
  pluginRoot?: string,
  manifestEntry?: string,        // default "src/manifest.ts"
  workerEntry?:   string,        // default "src/worker.ts"
  uiEntry?:       string,        // optional; if absent, ui preset omitted
  outdir?:        string,        // default "dist"
  sourcemap?: boolean, minify?: boolean,
}): {
  esbuild: { worker, ui?, manifest },
  rollup:  { worker, ui?, manifest },
}
```

**Default externals (verbatim):**

- Worker: `["react", "react-dom"]` (worker bundles the SDK; only React is external because some shared utilities reference React types).
- UI: `["@paperclipai/plugin-sdk/ui", "@paperclipai/plugin-sdk/ui/hooks", "react", "react-dom", "react/jsx-runtime"]`.
- Manifest: no externals; `bundle: false`.

Worker `target: "node20"`, format `esm`, platform `node`. UI `target: "es2022"`, format `esm`, platform `browser`. Both honor `sourcemap`/`minify` opts.

### Event names

The host event union ([`constants.ts:906`](https://github.com/paperclipai/paperclip/blob/master/packages/shared/src/constants.ts) `PluginEventType`) includes `issue.created`, `issue.updated`, `issue.comment.created`, `issue.relations.updated`, `issue.checked_out`, plus `agent.run.*`, `goal.*`, `approval.*`. **No `issue.opened` event** — if v0.2 adds pre-warming, use `issue.created`.

## 5. Reference plugin patterns

**[plugin-authoring-smoke-example](https://github.com/paperclipai/paperclip/tree/master/packages/plugins/examples/plugin-authoring-smoke-example)** is the closest reference for a worker + UI + tests + `createPluginBundlerPresets`-driven build:

- File tree: `src/{manifest.ts, worker.ts, ui/index.tsx}`, `tests/`, `esbuild.config.mjs`, `rollup.config.mjs`, `vitest.config.ts`.
- `package.json#paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js", ui: "./dist/ui/" }`.
- `peerDependencies: { "react": ">=18" }`.
- esbuild config imports `createPluginBundlerPresets` from `@paperclipai/plugin-sdk/bundlers` and runs the `worker`, `manifest`, and `ui` contexts in parallel with `--watch` support.
- `categories: ["connector"]` in its manifest. We'll use `["workspace"]`.

**[plugin-kitchen-sink-example](https://github.com/paperclipai/paperclip/tree/master/packages/plugins/examples/plugin-kitchen-sink-example)** is the cross-reference for slot/capability completeness — declares 12 distinct slot types and 33 capabilities. Useful as a reverse-lookup ("what capability do I need for slot X?").

**[plugin-file-browser-example](https://github.com/paperclipai/paperclip/tree/master/packages/plugins/examples/plugin-file-browser-example)** is our filesystem-pattern source — the only example that does workspace path resolution + `node:fs` reads.

## 6. SDK + scaffold — current versions

- **`@paperclipai/plugin-sdk`** latest: `2026.428.0` (calver, published 2026-04-28). Active development; canary tags as recent as `2026.504.0-canary.6`. The package uses **calver, not semver** — pin the exact version in `peerDependencies` rather than a range. Subpath exports: `.`, `/ui`, `/ui/hooks`, `/ui/types`, `/types`, `/testing`, `/bundlers`, `/protocol`, `/dev-server`. Peer deps: `react >=18`. Runtime deps: `zod ^3.24.2`, `@paperclipai/shared 2026.428.0`.
- **`@paperclipai/create-paperclip-plugin`** latest: `2026.428.0`. Templates: `default`, `connector`, `workspace` (and an undocumented `environment`). CLI flags: `--template`, `--output`, `--display-name`, `--description`, `--author`, `--category`, `--sdk-path`. Note: the flag is `--category` (singular), but the manifest field is `categories` (array) — the scaffold writes the chosen value into the array.

Pin in plugin's `package.json`:
```json
{
  "peerDependencies": {
    "@paperclipai/plugin-sdk": "2026.428.0",
    "react": ">=18",
    "react-dom": ">=18"
  }
}
```

## 7. Known issues affecting us

### [Issue #2276](https://github.com/paperclipai/paperclip/issues/2276) — `UI_SLOT_CAPABILITIES` validator bug (OPEN; fixed on master, not yet released)

**Re-read 2026-05-05 — earlier framing was wrong.** The live issue body describes the bug as: the validator iterates `UI_SLOT_CAPABILITIES` and requires matching capabilities even when `manifest.ui` is undefined (i.e., **worker-only plugins with no UI slots**). The reported failure mode is a worker-only plugin getting rejected with `Missing required capabilities for declared features: ui.dashboardWidget.register` despite having declared no UI slots at all.

Current master [`plugin-capability-validator.ts`](https://github.com/paperclipai/paperclip/blob/master/server/src/services/plugin-capability-validator.ts) gates the slot iteration on `uiSlots.length > 0`:

```ts
const uiSlots = manifest.ui?.slots ?? [];
if (uiSlots.length > 0) {
  for (const slot of uiSlots) {
    const requiredCap = UI_SLOT_CAPABILITIES[slot.type];
    if (requiredCap && !declared.has(requiredCap)) {
      if (!allMissing.includes(requiredCap)) allMissing.push(requiredCap);
    }
  }
}
```

So master is fixed; the issue is OPEN waiting for the fix to land in a tagged release.

**Impact on us:** none. Our plugin declares a `dashboardWidget` slot AND `ui.dashboardWidget.register` in capabilities. The validator's slot loop runs, finds the required capability declared, and passes. We never trip this. The earlier framing in this section incorrectly described the bug as affecting plugins that declare `dashboardWidget`; the opposite is true.

**No mitigation needed.** No workaround to document. Smoke-test confirms install succeeds; if it doesn't, the cause is something else.

### [Issue #2678](https://github.com/paperclipai/paperclip/issues/2678) — Plugin discovery UI invisible (OPEN; PR #2702 closed/probably merged)

CLI install is the only path until the discovery UI ships. SPEC already accounted for this. No action.

### [Discussion #258](https://github.com/paperclipai/paperclip/discussions/258) — Plugin System RFC (open)

Background reading; no action.

## 8. SPEC errata (to fix during Phase 1)

These are concrete corrections to `SPEC.md`:

1. **Manifest field is `categories` (plural array), not `category`.** Use `categories: ["workspace"]`.
2. **Drop `sdkVersion` from the manifest.** Only `apiVersion: 1`. Spec doc §29.2 mentions a future `sdkVersion` semver-range; the validator does not currently check it; no example declares it.
3. **Tool result shape is `{ content?, data?, error? }`, not `{ content, structured }`.** Move structured search results into `data`.
4. **`ErrorBoundary` is not exported from `@paperclipai/plugin-sdk/ui`.** Roll our own in `src/ui/ErrorBoundary.tsx`.
5. **`PluginWidgetProps` is the slot prop name** (not `PluginDashboardWidgetProps`).
6. **`PluginHostContext.companyId` is `string | null`**, not always a string. UI must handle null.
7. **Worker bundle externals are `["react", "react-dom"]` only.** The worker bundles `@paperclipai/plugin-sdk`. SPEC implied SDK was external on the worker side — that's wrong.
8. **UI bundle externals also include `react/jsx-runtime` and `@paperclipai/plugin-sdk/ui/hooks`.** SPEC's external list was incomplete.
9. **Use `createPluginBundlerPresets` from `@paperclipai/plugin-sdk/bundlers`** (subpath export). Don't hand-roll esbuild config; use the preset's `esbuild.worker/manifest/ui` outputs.
10. **Capability list correction:** `events.subscribe` is unnecessary in v0.1. Add `project.workspaces.read` (it's required for `ctx.projects.listWorkspaces` and is the de-facto FS gate).
11. **No `issue.opened` event.** If pre-warming lands in v0.2, subscribe to `issue.created`.
12. **No `ctx.workspace`, no `ctx.assets`** — SPEC was right that `ctx.assets` is unsupported; reaffirmed here. There's also no `ctx.workspace`, so don't reach for one.
13. **Test-harness capability denial throws a plain `Error`** with a known message — not a `JsonRpcCallError` with code `-32001`. Tests should assert on `Error.message`.
14. **`@paperclipai/plugin-sdk` uses calver (`2026.428.0`).** Pin the exact version in `peerDependencies`; don't write a semver range.

## 9. Required Phase 1 plan adjustments

Before starting Phase 1, the approved plan's Phases 3–5 need these one-line edits (no structural changes):

- **Phase 3 (Manifest):** drop `sdkVersion`, rename `category` → `categories: ["workspace"]`, add `project.workspaces.read` and drop `events.subscribe`, change tool result expectation in tests from `{ content, structured }` to `{ content?, data?, error? }`.
- **Phase 4 (Worker):** the `wiki.query` handler returns `{ content, data }` (`data` holds the ranked-results array). Worker uses `ctx.projects.listWorkspaces` (not just `ctx.projects` in some abstract sense). Capability-denial test asserts `Error.message`, not `-32001`.
- **Phase 5 (UI):** roll our own `ErrorBoundary`. Slot prop type for the dashboard widget is `PluginWidgetProps`. UI must guard `companyId === null`. UI bundle externals updated per §8.
- **Phase 7 (Pre-publish):** smoke-install against a clean Paperclip before publish. (Earlier text in this section flagged Issue #2276 as a publish risk; the corrected reading in §7 above shows the bug doesn't apply to our plugin — it affects worker-only plugins without UI slots, and our manifest declares a full `ui.slots[]` plus all matching capabilities.)

These edits are mechanical — no design changes, no scope changes. **Recommend: proceed to Phase 1.**

## Source map

| File / endpoint | URL |
|---|---|
| Filesystem-access pattern | https://github.com/paperclipai/paperclip/tree/master/packages/plugins/examples/plugin-file-browser-example |
| Capability validator | https://github.com/paperclipai/paperclip/blob/master/server/src/services/plugin-capability-validator.ts |
| Capability + slot constants | https://github.com/paperclipai/paperclip/blob/master/packages/shared/src/constants.ts |
| Manifest validator (Zod) | https://github.com/paperclipai/paperclip/blob/master/packages/shared/src/validators/plugin.ts |
| Manifest type | https://github.com/paperclipai/paperclip/blob/master/packages/shared/src/types/plugin.ts |
| Plugin runtime types | https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/types.ts |
| `definePlugin` | https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/define-plugin.ts |
| `runWorker` | https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/worker-rpc-host.ts |
| JSON-RPC protocol + error codes | https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/protocol.ts |
| UI hooks | https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/ui/hooks.ts |
| UI types (slot props, host context) | https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/ui/types.ts |
| `ErrorBoundary` (not re-exported) | https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/ui/components.ts |
| Test harness | https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/testing.ts |
| Bundler presets | https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/bundlers.ts |
| Plugin spec (normative) | https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md |
| Authoring guide | https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_AUTHORING_GUIDE.md |
| Reference: hello-world | https://github.com/paperclipai/paperclip/tree/master/packages/plugins/examples/plugin-hello-world-example |
| Reference: authoring-smoke | https://github.com/paperclipai/paperclip/tree/master/packages/plugins/examples/plugin-authoring-smoke-example |
| Reference: kitchen-sink | https://github.com/paperclipai/paperclip/tree/master/packages/plugins/examples/plugin-kitchen-sink-example |
| `@paperclipai/plugin-sdk` on npm | https://www.npmjs.com/package/@paperclipai/plugin-sdk |
| `@paperclipai/create-paperclip-plugin` on npm | https://www.npmjs.com/package/@paperclipai/create-paperclip-plugin |
| Issue #2276 — validator bug | https://github.com/paperclipai/paperclip/issues/2276 |
| Issue #2678 — discovery UI | https://github.com/paperclipai/paperclip/issues/2678 |
| Discussion #258 — RFC | https://github.com/paperclipai/paperclip/discussions/258 |
