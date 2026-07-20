import { describe, it, expect } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";

/**
 * Contract: manifest must be accepted by the SDK's validator AND must satisfy
 * the slot↔capability gating rules in
 * server/src/services/plugin-capability-validator.ts (verified verbatim in
 * integrations/paperclip/FEASIBILITY.md §3).
 *
 * The UI_SLOT_CAPABILITIES table below is copied verbatim from the validator.
 * If the validator changes upstream, regenerate FEASIBILITY.md and update
 * this table in lockstep.
 */

const UI_SLOT_CAPABILITIES = {
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
} as const satisfies Record<string, string>;

type SlotProps = Record<string, unknown> & {
  type: string;
  id: string;
  displayName: string;
  exportName: string;
  entityTypes?: string[];
  routePath?: string;
};

describe("manifest — identity", () => {
  it("uses the Paperclip plugin id format (lowercase + dots/hyphens)", () => {
    expect(manifest.id).toBe("io.praneybehl.llm-wiki");
    expect(manifest.id).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
  });

  it("apiVersion is the literal 1 the validator accepts", () => {
    expect(manifest.apiVersion).toBe(1);
  });

  it("matches the published package version", () => {
    expect(manifest.version).toBe("0.5.1");
  });

  it("displayName, description, author respect validator length caps", () => {
    expect(manifest.displayName.length).toBeGreaterThan(0);
    expect(manifest.displayName.length).toBeLessThanOrEqual(100);
    expect(manifest.description.length).toBeGreaterThan(0);
    expect(manifest.description.length).toBeLessThanOrEqual(500);
    expect(manifest.author.length).toBeGreaterThan(0);
    expect(manifest.author.length).toBeLessThanOrEqual(200);
  });

  it("categories is a plural array containing 'workspace'", () => {
    expect(Array.isArray(manifest.categories)).toBe(true);
    expect(manifest.categories).toContain("workspace");
  });

  it("does NOT declare a top-level sdkVersion (the validator does not accept it)", () => {
    expect((manifest as { sdkVersion?: unknown }).sdkVersion).toBeUndefined();
  });
});

describe("manifest — entrypoints", () => {
  it("worker entry points at the built ./dist/worker.js", () => {
    expect(manifest.entrypoints.worker).toBe("./dist/worker.js");
  });

  it("ui entry points at the built ./dist/ui/ directory", () => {
    expect(manifest.entrypoints.ui).toBe("./dist/ui/");
  });
});

describe("manifest — capabilities (v0.1 final list)", () => {
  it("declares the four UI capabilities our slots need", () => {
    for (const cap of [
      "ui.sidebar.register",
      "ui.page.register",
      "ui.detailTab.register",
      "ui.dashboardWidget.register",
    ]) {
      expect(manifest.capabilities).toContain(cap);
    }
  });

  it("declares agent.tools.register for the wiki.query tool", () => {
    expect(manifest.capabilities).toContain("agent.tools.register");
  });

  it("declares projects.read AND project.workspaces.read (the FS gate)", () => {
    expect(manifest.capabilities).toContain("projects.read");
    expect(manifest.capabilities).toContain("project.workspaces.read");
  });

  it("declares issues.read for relevantForIssue context lookup", () => {
    expect(manifest.capabilities).toContain("issues.read");
  });

  it("does NOT declare events.subscribe in v0.1 (no event subscriptions)", () => {
    expect(manifest.capabilities).not.toContain("events.subscribe");
  });

  it("does NOT declare http.outbound (plugin makes no external calls)", () => {
    expect(manifest.capabilities).not.toContain("http.outbound");
  });

  it("does NOT declare any write capability (plugin is read-only)", () => {
    const writeCaps = [
      "issues.create", "issues.update",
      "issue.comments.create", "issue.documents.write",
      "plugin.state.write", "database.namespace.write",
    ];
    for (const cap of writeCaps) {
      expect(manifest.capabilities).not.toContain(cap);
    }
  });
});

describe("manifest — UI slots", () => {
  const slots = (manifest.ui?.slots ?? []) as SlotProps[];

  it("declares all four v0.1 surfaces", () => {
    const types = slots.map((s) => s.type).sort();
    expect(types).toEqual(["dashboardWidget", "detailTab", "page", "sidebar"]);
  });

  it("each slot has a unique id (validator rejects duplicates)", () => {
    const ids = slots.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every declared slot.type has its required capability in capabilities[]", () => {
    for (const slot of slots) {
      const required =
        UI_SLOT_CAPABILITIES[slot.type as keyof typeof UI_SLOT_CAPABILITIES];
      expect(required).toBeDefined();
      expect(manifest.capabilities).toContain(required);
    }
  });

  it("issue detail tab is scoped to entityTypes: ['issue']", () => {
    const tab = slots.find((s) => s.id === "wiki-context-tab");
    expect(tab?.entityTypes).toEqual(["issue"]);
  });

  it("page slot declares the public route path llm-wiki", () => {
    const page = slots.find((s) => s.id === "wiki-page");
    expect(page?.routePath).toBe("llm-wiki");
  });

  it("slot exportNames match the named exports the UI bundle ships (Phase 5 contract)", () => {
    const expected: Record<string, string> = {
      "wiki-sidebar": "WikiSidebar",
      "wiki-page": "WikiPage",
      "wiki-context-tab": "WikiContextTab",
      "wiki-health": "WikiHealthIndicator",
    };
    for (const slot of slots) {
      expect(slot.exportName).toBe(expected[slot.id]);
    }
  });
});

describe("manifest — tools", () => {
  it("declares exactly one tool: wiki.query", () => {
    const names = (manifest.tools ?? []).map((t) => t.name);
    expect(names).toEqual(["wiki.query"]);
  });

  it("wiki.query has displayName, description, and parametersSchema", () => {
    const tool = manifest.tools?.find((t) => t.name === "wiki.query");
    expect(tool?.displayName).toBeTruthy();
    expect(tool?.description).toBeTruthy();
    expect(tool?.parametersSchema).toBeTruthy();
  });

  it("wiki.query description is self-instructive (when-to-call signal for agents)", () => {
    const tool = manifest.tools?.find((t) => t.name === "wiki.query");
    const desc = (tool?.description ?? "").toLowerCase();
    // Agents reading the toolbelt should see when to use this tool, not
    // just what the algorithm is.
    expect(desc).toContain("source of truth");
    expect(desc).toContain("before answering");
  });

  it("wiki.query parametersSchema requires a 'query' field", () => {
    const tool = manifest.tools?.find((t) => t.name === "wiki.query");
    const schema = tool?.parametersSchema as {
      type: string;
      properties: Record<string, { type: string; default?: unknown }>;
      required: string[];
    };
    expect(schema.type).toBe("object");
    expect(schema.required).toContain("query");
    expect(schema.properties.query?.type).toBe("string");
    expect(schema.properties.topK?.type).toBe("number");
  });
});

describe("manifest — instanceConfigSchema (auto-generated settings form)", () => {
  const schema = manifest.instanceConfigSchema as {
    type: string;
    properties: Record<
      string,
      {
        type: string;
        default?: unknown;
        minimum?: number;
        maximum?: number;
        description?: string;
      }
    >;
  };

  it("is an object schema with our three operator-tunable properties", () => {
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties).sort()).toEqual([
      "lint_check_interval_minutes",
      "search_top_k",
      "wiki_path",
    ]);
  });

  it("wiki_path defaults to 'wiki' (matches Phase 0 / SPEC)", () => {
    expect(schema.properties.wiki_path?.type).toBe("string");
    expect(schema.properties.wiki_path?.default).toBe("wiki");
  });

  it("lint_check_interval_minutes defaults to 60, minimum 5", () => {
    expect(schema.properties.lint_check_interval_minutes?.default).toBe(60);
    expect(schema.properties.lint_check_interval_minutes?.minimum).toBe(5);
  });

  it("search_top_k defaults to 5, bounded [1, 20]", () => {
    expect(schema.properties.search_top_k?.default).toBe(5);
    expect(schema.properties.search_top_k?.minimum).toBe(1);
    expect(schema.properties.search_top_k?.maximum).toBe(20);
  });
});

describe("manifest — runs through the SDK validator", () => {
  it("createTestHarness accepts the full manifest (validator-equivalent check)", () => {
    expect(() => createTestHarness({ manifest })).not.toThrow();
  });

  it("harness exposes a fully-formed ctx after construction", () => {
    const harness = createTestHarness({ manifest });
    expect(harness.ctx).toBeDefined();
    expect(harness.ctx.manifest.id).toBe(manifest.id);
  });
});
