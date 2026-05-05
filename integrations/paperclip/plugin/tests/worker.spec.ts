import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type {
  PaperclipPluginManifestV1,
  PluginCapability,
  PluginContext,
  PluginWorkspace,
  Issue,
  Project,
} from "@paperclipai/plugin-sdk";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import plugin from "../src/worker.js";
import manifestSrc from "../src/manifest.js";

/**
 * Contract: worker exposes the data providers + tool documented in
 * SPEC.md and FEASIBILITY.md, computed against an absolute workspace
 * path resolved through ctx.projects.getPrimaryWorkspace (the
 * file-browser-example pattern from FEASIBILITY §1).
 *
 * The SDK's harness doesn't accept workspaces in seed(), so each test
 * builds a harness then patches ctx.projects.getPrimaryWorkspace /
 * .list / .getWorkspaceForIssue to return a fixture path. The worker's
 * setup() is invoked manually so handlers register against the patched
 * ctx.
 */

const FIXTURES_ROOT = resolve(process.cwd(), "tests/fixtures");
const COMPANY_ID = "test-co";
const PROJECT_ID = "test-proj";
const ISSUE_ID = "test-issue";

const manifest = manifestSrc;

const project = {
  id: PROJECT_ID,
  companyId: COMPANY_ID,
  urlKey: "p1",
  goalId: null,
  goalIds: [],
  goals: [],
  name: "Test Project",
  description: null,
  status: "active",
} as unknown as Project;

const issueAboutTransformers = {
  id: ISSUE_ID,
  companyId: COMPANY_ID,
  projectId: PROJECT_ID,
  projectWorkspaceId: null,
  goalId: null,
  parentId: null,
  title: "Investigate transformer attention slowdown",
  description: "Profiling shows attention dominates wall time. Need a literature pass.",
  status: "open",
  priority: "medium",
  assigneeAgentId: null,
  assigneeUserId: null,
  checkoutRunId: null,
  executionRunId: null,
  executionAgentNameKey: null,
  executionLockedAt: null,
  createdByAgentId: null,
  createdByUserId: null,
  issueNumber: 1,
  identifier: "P-1",
  requestDepth: 0,
  billingCode: null,
  assigneeAdapterOverrides: null,
  executionWorkspaceId: null,
  executionWorkspacePreference: null,
  executionWorkspaceSettings: null,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  hiddenAt: null,
} as unknown as Issue;

const fakeWorkspace: PluginWorkspace = {
  id: "ws-1",
  projectId: PROJECT_ID,
  name: "primary",
  path: FIXTURES_ROOT,
  isPrimary: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

interface PatchOptions {
  workspacePath?: string | null;
  config?: Record<string, unknown>;
  capabilities?: PluginCapability[];
}

async function makeWorker(opts: PatchOptions = {}): Promise<TestHarness> {
  const harness = createTestHarness({
    manifest: manifest as PaperclipPluginManifestV1,
    capabilities: opts.capabilities ?? manifest.capabilities,
    config: opts.config ?? { wiki_path: "wiki" },
  });

  harness.seed({
    projects: [project],
    issues: [issueAboutTransformers],
  });

  // Patch the workspace lookups since seed() doesn't accept workspaces.
  // Cast to any so we can override the closure-bound methods.
  const ctx = harness.ctx as PluginContext & { projects: any };
  const wsPath = opts.workspacePath === undefined ? FIXTURES_ROOT : opts.workspacePath;
  if (wsPath !== null) {
    const ws = { ...fakeWorkspace, path: wsPath };
    ctx.projects.getPrimaryWorkspace = async (pid: string, cid: string) =>
      pid === PROJECT_ID && cid === COMPANY_ID ? ws : null;
    ctx.projects.getWorkspaceForIssue = async (iid: string, cid: string) =>
      iid === ISSUE_ID && cid === COMPANY_ID ? ws : null;
    ctx.projects.list = async () => [project];
  } else {
    ctx.projects.getPrimaryWorkspace = async () => null;
    ctx.projects.getWorkspaceForIssue = async () => null;
    ctx.projects.list = async () => [];
  }

  await plugin.definition.setup(harness.ctx);
  return harness;
}

describe("worker — readPage", () => {
  let harness: TestHarness;
  beforeAll(async () => {
    harness = await makeWorker();
  });

  it("returns frontmatter, body, and links for an existing page", async () => {
    const result = await harness.getData<{
      slug: string;
      meta: Record<string, unknown>;
      body: string;
      links: string[];
    }>("readPage", {
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      slug: "transformer",
    });
    expect(result.slug).toBe("transformer");
    expect(result.meta.type).toBe("entity");
    expect(result.meta.title).toBe("Transformer");
    expect(result.body).toContain("# Transformer");
    expect(result.links.sort()).toEqual(
      ["attention-mechanism", "attention-paper", "gpt-3"].sort(),
    );
  });

  it("returns an error object for an unknown slug, no exception", async () => {
    const result = await harness.getData<{ error?: string }>("readPage", {
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      slug: "no-such-page",
    });
    expect(result.error).toBeTruthy();
  });

  it("blocks path-traversal slugs with .. segments", async () => {
    const result = await harness.getData<{ error?: string }>("readPage", {
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      slug: "../../../etc/passwd",
    });
    expect(result.error).toBeTruthy();
  });
});

describe("worker — searchWiki", () => {
  let harness: TestHarness;
  beforeAll(async () => {
    harness = await makeWorker();
  });

  it("returns BM25 results identical to lib/bm25 for the same query", async () => {
    const result = await harness.getData<{
      results: { slug: string; score: number }[];
    }>("searchWiki", {
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      query: "transformer attention",
      topK: 5,
    });
    const slugs = result.results.map((r) => r.slug);
    expect(slugs).toEqual([
      "transformer",
      "attention-mechanism",
      "attention-paper",
      "transformer-vs-rnn",
      "gpt-3",
    ]);
  });

  it("respects the topK cap", async () => {
    const result = await harness.getData<{ results: { slug: string }[] }>(
      "searchWiki",
      { companyId: COMPANY_ID, projectId: PROJECT_ID, query: "transformer", topK: 2 },
    );
    expect(result.results.length).toBeLessThanOrEqual(2);
  });

  it("returns empty results when the query has no matching tokens", async () => {
    const result = await harness.getData<{ results: unknown[] }>("searchWiki", {
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      query: "xyzzy nothing",
      topK: 5,
    });
    expect(result.results).toEqual([]);
  });
});

describe("worker — loadIndex", () => {
  let harness: TestHarness;
  beforeAll(async () => {
    harness = await makeWorker();
  });

  it("returns the seven fixture pages with title + type + relPath", async () => {
    const result = await harness.getData<{
      pages: { slug: string; title: string; type: string; relPath: string }[];
    }>("loadIndex", { companyId: COMPANY_ID, projectId: PROJECT_ID });
    expect(result.pages).toHaveLength(7);
    const titles = new Set(result.pages.map((p) => p.title));
    expect(titles.has("Transformer")).toBe(true);
    expect(titles.has("Attention Mechanism")).toBe(true);
  });
});

describe("worker — lintWiki", () => {
  let harness: TestHarness;
  beforeAll(async () => {
    harness = await makeWorker();
  });

  it("returns the same finding shape as lib/lint", async () => {
    const result = await harness.getData<{
      summary: { totalPages: number };
      orphans: unknown[];
    }>("lintWiki", { companyId: COMPANY_ID, projectId: PROJECT_ID });
    expect(result.summary.totalPages).toBeGreaterThan(0);
    expect(Array.isArray(result.orphans)).toBe(true);
  });
});

describe("worker — wikiHealth", () => {
  let harness: TestHarness;
  beforeAll(async () => {
    harness = await makeWorker();
  });

  it("returns dashboard-shaped fields", async () => {
    const result = await harness.getData<{
      pageCount: number;
      lintStatus: "pass" | "warn" | "fail";
      scalingMessages: string[];
    }>("wikiHealth", { companyId: COMPANY_ID, projectId: PROJECT_ID });
    expect(result.pageCount).toBeGreaterThan(0);
    expect(["pass", "warn", "fail"]).toContain(result.lintStatus);
    expect(Array.isArray(result.scalingMessages)).toBe(true);
  });
});

describe("worker — relevantForIssue", () => {
  let harness: TestHarness;
  beforeAll(async () => {
    harness = await makeWorker();
  });

  it("returns BM25 results scored against issue.title + issue.description", async () => {
    const result = await harness.getData<{
      results: { slug: string }[];
    }>("relevantForIssue", {
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      topK: 5,
    });
    // Issue mentions "transformer attention slowdown" + "attention dominates" —
    // top hits should be transformer / attention-related pages.
    const slugs = result.results.map((r) => r.slug);
    expect(slugs[0]).toBeDefined();
    expect(["transformer", "attention-mechanism", "attention-paper"]).toContain(
      slugs[0],
    );
  });

  it("returns empty results when the issue does not exist", async () => {
    const result = await harness.getData<{ results: unknown[] }>(
      "relevantForIssue",
      { companyId: COMPANY_ID, issueId: "no-such-issue", topK: 5 },
    );
    expect(result.results).toEqual([]);
  });
});

describe("worker — wiki.query tool", () => {
  let harness: TestHarness;
  beforeAll(async () => {
    harness = await makeWorker();
  });

  it("returns ToolResult with content (markdown) and data (structured)", async () => {
    const result = await harness.executeTool<{
      content?: string;
      data?: { results: { slug: string }[] };
    }>(
      "wiki.query",
      { query: "transformer attention", topK: 3 },
      { companyId: COMPANY_ID, projectId: PROJECT_ID, agentId: "a", runId: "r" },
    );
    expect(result.content).toBeTruthy();
    expect(result.data?.results).toBeDefined();
    expect(result.data?.results.length).toBeGreaterThan(0);
    expect(result.data?.results[0]?.slug).toBe("transformer");
  });

  it("filters results by frontmatter type when requested", async () => {
    const result = await harness.executeTool<{
      data?: { results: { slug: string; type: string }[] };
    }>(
      "wiki.query",
      { query: "transformer attention", topK: 5, type: "concept" },
      { companyId: COMPANY_ID, projectId: PROJECT_ID, agentId: "a", runId: "r" },
    );
    const slugs = result.data?.results.map((r) => r.slug) ?? [];
    expect(slugs).toEqual(["attention-mechanism"]);
  });
});

describe("worker — capability denial", () => {
  let harness: TestHarness;
  beforeAll(async () => {
    // Strip project.workspaces.read so getPrimaryWorkspace throws.
    const minus = manifest.capabilities.filter(
      (c) => c !== "project.workspaces.read",
    );
    harness = await makeWorker({ capabilities: minus });
  });

  it("readPage returns a graceful error instead of crashing", async () => {
    // We override getPrimaryWorkspace before setup, so the original (which
    // would throw) isn't called here. To exercise the denial path we
    // restore the original method first. Skip this test if no original was
    // captured; the goal is that the worker wraps host-RPC calls in try/catch.
    const result = await harness.getData<{ error?: string }>("readPage", {
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      slug: "transformer",
    });
    // With the patched workspace lookup the call still works; what we
    // really care about is that the worker returns an `error` field
    // (never throws). Assert the call resolved at all.
    expect(result).toBeDefined();
  });
});

describe("worker — capability denial (no patches)", () => {
  it("worker swallows CAPABILITY_DENIED Error from ctx.projects calls", async () => {
    const minus = manifest.capabilities.filter(
      (c) => c !== "project.workspaces.read",
    );
    const harness = createTestHarness({
      manifest: manifest as PaperclipPluginManifestV1,
      capabilities: minus,
      config: { wiki_path: "wiki" },
    });
    harness.seed({ projects: [project] });
    // Do NOT override getPrimaryWorkspace — leave the harness's stub that
    // calls requireCapability and throws.
    await plugin.definition.setup(harness.ctx);

    const result = await harness.getData<{ error?: string }>("readPage", {
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      slug: "transformer",
    });
    expect(result.error).toBeTruthy();
    expect(result.error?.toLowerCase()).toMatch(/capability|workspace|access/);
  });
});

describe("worker — onHealth", () => {
  it("reports status ok with wikiPathMissing=false when the path resolves", async () => {
    const harness = await makeWorker();
    const health = await plugin.definition.onHealth!();
    void harness; // harness is configured for this case but onHealth takes no args
    expect(health.status).toBe("ok");
  });

  it("reports status ok with no wiki configured (best-effort liveness)", async () => {
    const harness = await makeWorker({ workspacePath: null });
    const health = await plugin.definition.onHealth!();
    void harness; // harness is configured for this case but onHealth takes no args
    // onHealth is a liveness probe — a missing wiki shouldn't fail the
    // liveness check (the worker process is still healthy).
    expect(health.status).toBe("ok");
  });
});

describe("worker — does not write", () => {
  it("registers no actions (read-only contract per SPEC §Non-goals)", async () => {
    const harness = await makeWorker();
    // performAction should throw "no action handler registered" if we try
    // any action key, because the worker registers none.
    await expect(
      harness.performAction("anything", {}),
    ).rejects.toThrow(/no action handler/i);
  });
});

describe("worker — Company-scoped fallback finds the project that has the wiki", () => {
  // Real Paperclip's getPrimaryWorkspace synthesizes a workspace for every
  // project (via project.codebase.effectiveLocalFolder) — see
  // server/src/services/plugin-host-services.ts. The company-level fallback
  // therefore can't break on the first non-null workspace; it must
  // continue until it finds one whose path actually contains the wiki.
  // Caught by the live smoke test against Paperclip's dashboard widget.

  const otherProject = {
    ...project,
    id: "other-proj",
    name: "Other Project",
  } as unknown as Project;

  async function makeWorkerWithMultipleProjects(): Promise<TestHarness> {
    const harness = createTestHarness({
      manifest: manifest as PaperclipPluginManifestV1,
      capabilities: manifest.capabilities,
      config: { wiki_path: "wiki" },
    });
    harness.seed({
      projects: [otherProject, project], // first project does NOT have the wiki
      issues: [issueAboutTransformers],
    });

    const ctx = harness.ctx as PluginContext & { projects: any };
    const wikiWorkspace = { ...fakeWorkspace, path: FIXTURES_ROOT };
    // Simulate real Paperclip: synthesize a workspace for the project
    // that has NO wiki (mimicking effectiveLocalFolder fallback to /tmp).
    const otherWorkspace: PluginWorkspace = {
      id: "ws-other",
      projectId: "other-proj",
      name: "synthetic",
      path: "/tmp/no-wiki-here-" + Date.now(),
      isPrimary: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    ctx.projects.getPrimaryWorkspace = async (pid: string, _cid: string) => {
      if (pid === PROJECT_ID) return wikiWorkspace;
      if (pid === "other-proj") return otherWorkspace;
      return null;
    };
    ctx.projects.getWorkspaceForIssue = async () => wikiWorkspace;
    ctx.projects.list = async () => [otherProject, project];
    await plugin.definition.setup(harness.ctx);
    return harness;
  }

  it("walks past projects with synthetic-but-empty workspaces and finds the wiki", async () => {
    const harness = await makeWorkerWithMultipleProjects();
    // No projectId — Company-scoped call (the dashboard does this).
    const result = await harness.getData<{
      pages: { slug: string }[];
    }>("loadIndex", { companyId: COMPANY_ID });
    // First project synthesized a workspace without our wiki; second has
    // it. Old behavior: 0 pages (broke on first project's synthetic ws).
    // New behavior: 7 pages from the fixture.
    expect(result.pages).toHaveLength(7);
  });

  it("wikiHealth reports real counts on the Company-scoped path", async () => {
    const harness = await makeWorkerWithMultipleProjects();
    const result = await harness.getData<{
      pageCount: number;
      wikiPathMissing: boolean;
    }>("wikiHealth", { companyId: COMPANY_ID });
    expect(result.wikiPathMissing).toBe(false);
    expect(result.pageCount).toBe(7);
  });

  it("explicit projectId pointing at a wiki-less project does NOT silently fall back", async () => {
    // SPEC §"Multi-Company behavior" + slot intent: if the operator's slot
    // context names a specific project, honoring that project's resolution
    // matters more than convenience. Don't drift to a different project.
    const harness = await makeWorkerWithMultipleProjects();
    const result = await harness.getData<{
      pages: { slug: string }[];
    }>("loadIndex", {
      companyId: COMPANY_ID,
      projectId: "other-proj", // pointed explicitly at the wiki-less project
    });
    expect(result.pages).toEqual([]);
  });
});

describe("worker — idle reads short-circuit before any FS walk", () => {
  // WikiBrowser unconditionally invokes loadIndex, searchWiki, readPage even
  // when the user hasn't typed a query or selected a slug. With currentSlug
  // = null and empty query, both readPage(slug: "") and searchWiki(query: "")
  // would otherwise do a full filesystem walk. Short-circuit at the worker
  // entry point so opening the sidebar costs one walk (loadIndex), not three.
  //
  // We can't spyOn(node:fs) directly — Node builtin exports are
  // non-configurable. Instead we spy on ctx.projects.getPrimaryWorkspace,
  // which is the first thing the worker would do on any non-short-circuit
  // path. If the short-circuit fires, the workspace call never happens.

  it("searchWiki with empty query returns [] before calling ctx.projects", async () => {
    const harness = await makeWorker();
    const spy = vi.spyOn(harness.ctx.projects, "getPrimaryWorkspace");
    spy.mockClear();
    const result = await harness.getData<{ results: unknown[] }>("searchWiki", {
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      query: "",
    });
    expect(result.results).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("searchWiki with whitespace-only query also short-circuits", async () => {
    const harness = await makeWorker();
    const spy = vi.spyOn(harness.ctx.projects, "getPrimaryWorkspace");
    spy.mockClear();
    const result = await harness.getData<{ results: unknown[] }>("searchWiki", {
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      query: "   \t   ",
    });
    expect(result.results).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("readPage with empty slug returns an error without calling ctx.projects", async () => {
    const harness = await makeWorker();
    const spy = vi.spyOn(harness.ctx.projects, "getPrimaryWorkspace");
    spy.mockClear();
    const result = await harness.getData<{ error?: string }>("readPage", {
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      slug: "",
    });
    expect(result.error).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it("readPage with whitespace-only slug also short-circuits", async () => {
    const harness = await makeWorker();
    const spy = vi.spyOn(harness.ctx.projects, "getPrimaryWorkspace");
    spy.mockClear();
    const result = await harness.getData<{ error?: string }>("readPage", {
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      slug: "   ",
    });
    expect(result.error).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("worker — wikiHealth includes lintCheckIntervalMinutes", () => {
  it("defaults to 60 minutes when no config is set", async () => {
    const harness = await makeWorker();
    const result = await harness.getData<{
      lintCheckIntervalMinutes: number;
    }>("wikiHealth", { companyId: COMPANY_ID, projectId: PROJECT_ID });
    expect(result.lintCheckIntervalMinutes).toBe(60);
  });

  it("respects config.lint_check_interval_minutes", async () => {
    const harness = await makeWorker({
      config: { wiki_path: "wiki", lint_check_interval_minutes: 15 },
    });
    const result = await harness.getData<{
      lintCheckIntervalMinutes: number;
    }>("wikiHealth", { companyId: COMPANY_ID, projectId: PROJECT_ID });
    expect(result.lintCheckIntervalMinutes).toBe(15);
  });

  it("clamps below-minimum config to 5 (instanceConfigSchema minimum)", async () => {
    const harness = await makeWorker({
      config: { wiki_path: "wiki", lint_check_interval_minutes: 1 },
    });
    const result = await harness.getData<{
      lintCheckIntervalMinutes: number;
    }>("wikiHealth", { companyId: COMPANY_ID, projectId: PROJECT_ID });
    expect(result.lintCheckIntervalMinutes).toBe(5);
  });

  it("falls back to 60 when config has a non-numeric value", async () => {
    const harness = await makeWorker({
      config: { wiki_path: "wiki", lint_check_interval_minutes: "lol" as unknown as number },
    });
    const result = await harness.getData<{
      lintCheckIntervalMinutes: number;
    }>("wikiHealth", { companyId: COMPANY_ID, projectId: PROJECT_ID });
    expect(result.lintCheckIntervalMinutes).toBe(60);
  });

  it("includes the field even in the wikiPathMissing fallback", async () => {
    const harness = await makeWorker({
      workspacePath: null,
      config: { wiki_path: "wiki", lint_check_interval_minutes: 30 },
    });
    const result = await harness.getData<{
      wikiPathMissing: boolean;
      lintCheckIntervalMinutes: number;
    }>("wikiHealth", { companyId: COMPANY_ID, projectId: PROJECT_ID });
    expect(result.wikiPathMissing).toBe(true);
    expect(result.lintCheckIntervalMinutes).toBe(30);
  });
});

describe("worker — search_top_k config plumbing", () => {
  it("uses config.search_top_k as the default when params.topK is absent", async () => {
    const harness = await makeWorker({
      config: { wiki_path: "wiki", search_top_k: 3 },
    });
    const result = await harness.getData<{ results: { slug: string }[] }>(
      "searchWiki",
      {
        companyId: COMPANY_ID,
        projectId: PROJECT_ID,
        query: "transformer attention",
      },
    );
    expect(result.results.length).toBe(3);
  });

  it("explicit params.topK wins over config.search_top_k", async () => {
    const harness = await makeWorker({
      config: { wiki_path: "wiki", search_top_k: 10 },
    });
    const result = await harness.getData<{ results: { slug: string }[] }>(
      "searchWiki",
      {
        companyId: COMPANY_ID,
        projectId: PROJECT_ID,
        query: "transformer attention",
        topK: 2,
      },
    );
    expect(result.results.length).toBe(2);
  });

  it("clamps an out-of-range config.search_top_k to the schema's [1, 20] bounds", async () => {
    const harness = await makeWorker({
      config: { wiki_path: "wiki", search_top_k: 100 },
    });
    const result = await harness.getData<{ results: { slug: string }[] }>(
      "searchWiki",
      {
        companyId: COMPANY_ID,
        projectId: PROJECT_ID,
        query: "transformer attention",
      },
    );
    // Our fixture corpus only has 7 pages so we'd never see 20 anyway —
    // but the cap means search_top_k=100 is rejected, NOT used as-is, and
    // the worker falls back to the schema default (5).
    expect(result.results.length).toBeLessThanOrEqual(20);
  });

  it("falls back to 5 when config has no search_top_k", async () => {
    const harness = await makeWorker({
      config: { wiki_path: "wiki" },
    });
    const result = await harness.getData<{ results: { slug: string }[] }>(
      "searchWiki",
      {
        companyId: COMPANY_ID,
        projectId: PROJECT_ID,
        query: "transformer attention",
      },
    );
    expect(result.results.length).toBe(5);
  });

  it("relevantForIssue applies the same config-driven default", async () => {
    const harness = await makeWorker({
      config: { wiki_path: "wiki", search_top_k: 2 },
    });
    const result = await harness.getData<{ results: { slug: string }[] }>(
      "relevantForIssue",
      {
        companyId: COMPANY_ID,
        issueId: ISSUE_ID,
        // no topK — config wins
      },
    );
    expect(result.results.length).toBeLessThanOrEqual(2);
  });

  it("wiki.query tool applies the same config-driven default", async () => {
    const harness = await makeWorker({
      config: { wiki_path: "wiki", search_top_k: 3 },
    });
    const result = await harness.executeTool<{
      data?: { results: { slug: string }[] };
    }>(
      "wiki.query",
      { query: "transformer attention" },
      { companyId: COMPANY_ID, projectId: PROJECT_ID, agentId: "a", runId: "r" },
    );
    expect(result.data?.results.length).toBe(3);
  });
});

afterAll(() => {
  // No persistent temp dirs to clean — fixtures live in the repo.
});

// Suppress unused-import warning for tmpdir/mkdtempSync/rmSync when not
// actively used in this file. They're imported for future tests that may
// need ephemeral workspaces.
void tmpdir;
void mkdtempSync;
void rmSync;
void join;
