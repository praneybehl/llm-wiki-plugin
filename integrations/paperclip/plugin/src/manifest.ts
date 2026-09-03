import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Description for the `wiki.query` agent tool. Exported so the worker's
 * runtime tool registration can reference the same string — agents
 * reading the toolbelt see the same when-to-call signal whether they
 * resolve the description through the manifest or the registered tool.
 */
export const WIKI_QUERY_DESCRIPTION =
  "Search the Company's LLM Wiki — the source of truth for accumulated company knowledge (people, products, decisions, prior research, sources). Call this before answering questions about Company-specific context. Returns BM25-ranked pages with title, type, and one-line summary; follow up with another wiki.query for deep dives or read the page directly through the agent's filesystem if available.";

/**
 * Paperclip plugin manifest for paperclip-plugin-llm-wiki.
 *
 * Source contract:
 *   - Type: PaperclipPluginManifestV1 from @paperclipai/plugin-sdk
 *   - Validator: server/src/services/plugin-manifest-validator.ts (Zod, apiVersion = literal 1)
 *   - Slot/capability gating: server/src/services/plugin-capability-validator.ts
 *
 * Corrections applied vs. SPEC.md (see integrations/paperclip/FEASIBILITY.md):
 *   - `categories` is the plural array, not `category`.
 *   - No `sdkVersion` field — the validator does not check it; no example declares it.
 *   - `project.workspaces.read` added (the de-facto FS gate per file-browser-example).
 *   - `events.subscribe` removed for v0.1 (no event subscriptions; reduces operator
 *     prompt noise).
 *   - Tool descriptor requires `name`, `displayName`, `description`, `parametersSchema`
 *     in the manifest entry (the worker re-uses the same shape via Pick<...>).
 */

const manifest: PaperclipPluginManifestV1 = {
  id: "io.praneybehl.llm-wiki",
  apiVersion: 1,
  version: "0.5.2",
  displayName: "LLM Wiki",
  description:
    "Surface the LLM Wiki inside Paperclip — search, browse, and read company knowledge in context.",
  author: "Praney Behl",
  categories: ["workspace"],

  capabilities: [
    "ui.sidebar.register",
    "ui.page.register",
    "ui.detailTab.register",
    "ui.dashboardWidget.register",
    "agent.tools.register",
    "projects.read",
    "project.workspaces.read",
    "issues.read",
  ],

  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui/",
  },

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
      description: WIKI_QUERY_DESCRIPTION,
      parametersSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Free-text search query.",
          },
          topK: {
            type: "number",
            default: 5,
            minimum: 1,
            maximum: 20,
            description: "Number of results to return.",
          },
          type: {
            type: "string",
            description: "Optional frontmatter type filter (e.g. concept, entity, source).",
          },
          tag: {
            type: "string",
            description: "Optional frontmatter tag filter.",
          },
        },
        required: ["query"],
      },
    },
  ],

  instanceConfigSchema: {
    type: "object",
    properties: {
      wiki_path: {
        type: "string",
        default: "wiki",
        description:
          "Path to the wiki directory, relative to the Company's primary workspace.",
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
        description:
          "Number of results returned by the issue-detail tab and the search box.",
      },
    },
  },
};

export default manifest;
