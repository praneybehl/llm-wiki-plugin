import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTestHarness,
  type TestHarness,
} from "@paperclipai/plugin-sdk/testing";
import type {
  PaperclipPluginManifestV1,
  PluginContext,
  PluginWorkspace,
  Project,
} from "@paperclipai/plugin-sdk";
import plugin from "../../src/worker.js";
import manifestSrc from "../../src/manifest.js";
import { collectPages } from "../../src/lib/bm25.js";
import { lintWiki } from "../../src/lib/lint.js";
import { computeStats } from "../../src/lib/stats.js";

/**
 * Symlink containment — defense beyond the path.relative() check that
 * resolveWikiRoot already does. Workers used statSync (which follows
 * symlinks); a symlink under the wiki tree could escape the workspace
 * and read anything on disk. The fix is to lstat + realpath every
 * traversed entry and reject when the realpath escapes the wiki root.
 *
 * Fixture layout (built per test):
 *   <root>/workspace/wiki/innocent.md       — real file with searchable content
 *   <root>/workspace/wiki/inside-link.md    — symlink to innocent.md (allowed)
 *   <root>/external/secret.txt              — real file outside the workspace
 *   <root>/workspace/wiki/escape.md         — symlink to ../../external/secret.txt
 *   <root>/workspace/wiki/escape-dir        — symlink to ../../external (a dir)
 */

const COMPANY_ID = "test-co";
const PROJECT_ID = "test-proj";

let tmpRoot: string;
let workspaceRoot: string;
let wikiRoot: string;
let externalDir: string;

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

const SECRET_MARKER = "ZZZSEC-canary-string-only-in-secret-txt-ZZZSEC";

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "symlink-test-"));
  workspaceRoot = join(tmpRoot, "workspace");
  wikiRoot = join(workspaceRoot, "wiki");
  externalDir = join(tmpRoot, "external");

  mkdirSync(wikiRoot, { recursive: true });
  mkdirSync(externalDir, { recursive: true });

  writeFileSync(
    join(wikiRoot, "innocent.md"),
    `---
type: concept
title: Innocent
tags: [x]
created: 2026-05-05
updated: 2026-05-05
---

just an innocent page about Innocent
`,
    "utf-8",
  );

  // Within-tree symlink — allowed.
  symlinkSync("./innocent.md", join(wikiRoot, "inside-link.md"));

  writeFileSync(
    join(externalDir, "secret.txt"),
    `the ${SECRET_MARKER} that must not leak through the wiki reader\n`,
    "utf-8",
  );

  // Escape via file-targeting symlink.
  symlinkSync(
    "../../external/secret.txt",
    join(wikiRoot, "escape.md"),
  );

  // Escape via directory-targeting symlink.
  symlinkSync("../../external", join(wikiRoot, "escape-dir"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function makeWorker(): Promise<TestHarness> {
  const harness = createTestHarness({
    manifest: manifestSrc as PaperclipPluginManifestV1,
    capabilities: manifestSrc.capabilities,
    config: { wiki_path: "wiki" },
  });
  harness.seed({ projects: [project] });

  const ctx = harness.ctx as PluginContext & {
    projects: Record<string, unknown>;
  };
  const ws: PluginWorkspace = {
    id: "ws-1",
    projectId: PROJECT_ID,
    name: "primary",
    path: workspaceRoot,
    isPrimary: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  ctx.projects.getPrimaryWorkspace = async () => ws;
  ctx.projects.getWorkspaceForIssue = async () => ws;
  ctx.projects.list = async () => [project];

  await plugin.definition.setup(harness.ctx);
  return harness;
}

describe("symlink containment — worker readPage", () => {
  it("reads an in-tree symlink (inside-link → innocent.md)", async () => {
    const harness = await makeWorker();
    const result = await harness.getData<{
      slug?: string;
      body?: string;
      error?: string;
    }>("readPage", {
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      slug: "inside-link",
    });
    // Within-tree symlinks are legitimate and should resolve.
    expect(result.error).toBeUndefined();
    expect(result.body ?? "").toContain("innocent");
  });

  it("rejects a symlink that escapes the wiki root (escape → ../../external/secret.txt)", async () => {
    const harness = await makeWorker();
    const result = await harness.getData<{
      body?: string;
      error?: string;
    }>("readPage", {
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      slug: "escape",
    });
    expect(result.error).toBeTruthy();
    // Critical: we must NOT have read the secret file even partially.
    expect(JSON.stringify(result)).not.toContain(SECRET_MARKER);
  });
});

describe("symlink containment — worker searchWiki", () => {
  it("does not surface content from files outside the wiki root", async () => {
    const harness = await makeWorker();
    const result = await harness.getData<{
      results: { slug: string; title: string }[];
    }>("searchWiki", {
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      query: SECRET_MARKER.toLowerCase(),
    });
    // The marker exists only in the escaped file; no result should match.
    expect(result.results).toEqual([]);
  });
});

describe("symlink containment — worker loadIndex", () => {
  it("does not list pages whose realpath escapes the wiki root", async () => {
    const harness = await makeWorker();
    const result = await harness.getData<{
      pages: { slug: string }[];
    }>("loadIndex", { companyId: COMPANY_ID, projectId: PROJECT_ID });
    const slugs = result.pages.map((p) => p.slug);
    // innocent and inside-link are valid; escape and escape-dir/* must be excluded.
    expect(slugs).toContain("innocent");
    expect(slugs).not.toContain("escape");
    for (const s of slugs) expect(s).not.toMatch(/escape/);
  });
});

describe("symlink containment — lib walkers", () => {
  it("collectPages excludes files whose realpath escapes the wiki root", () => {
    const pages = collectPages(wikiRoot);
    const slugs = pages.map((p) => p.slug);
    expect(slugs).toContain("innocent");
    // inside-link is fine — realpath stays inside wiki.
    expect(slugs).toContain("inside-link");
    // escape and anything under escape-dir must be excluded.
    expect(slugs).not.toContain("escape");
    expect(slugs).not.toContain("secret");
  });

  it("lintWiki page count reflects only contained files", () => {
    const findings = lintWiki(wikiRoot);
    // 2 contained pages: innocent + inside-link. The escapes should not
    // contribute to totalPages.
    expect(findings.summary.totalPages).toBe(2);
  });

  it("computeStats page count reflects only contained files", () => {
    const stats = computeStats(wikiRoot);
    expect(stats.totalPages).toBe(2);
    // The link density / link counts must not include any link from the
    // escaped file.
    // (No extra assertion needed — totalPages is the canary.)
  });
});
