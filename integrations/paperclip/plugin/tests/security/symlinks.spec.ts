import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  unlinkSync,
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

// ────────────────────────────────────────────────────────────────────────
// Fix 1b — wiki root and direct loadIndex reads
// ────────────────────────────────────────────────────────────────────────

describe("symlink containment — wiki root itself", () => {
  // The recursive walkers anchor on the wiki root's realpath, but if the
  // wiki root itself is a symlink that escapes the workspace, the walkers
  // happily walk the escape destination — every entry under it has a
  // realpath under the escape destination, which IS the wiki root. We
  // need an additional check that the resolved wiki root is contained
  // within the workspace's realpath.

  let evilTmp: string;
  let evilWorkspace: string;
  let evilExternal: string;

  beforeAll(() => {
    evilTmp = mkdtempSync(join(tmpdir(), "symlink-root-"));
    evilWorkspace = join(evilTmp, "workspace");
    evilExternal = join(evilTmp, "external");
    mkdirSync(evilWorkspace, { recursive: true });
    mkdirSync(evilExternal, { recursive: true });
    writeFileSync(
      join(evilExternal, "exposed.md"),
      `---
type: concept
title: Exposed
tags: [x]
created: 2026-05-05
updated: 2026-05-05
---

content with the ${SECRET_MARKER} marker
`,
      "utf-8",
    );
    // The wiki "directory" is actually a symlink to a directory outside
    // the workspace. From a lexical path.relative() standpoint, "wiki"
    // is under workspace; only realpath catches the escape.
    symlinkSync(evilExternal, join(evilWorkspace, "wiki"));
  });

  afterAll(() => {
    rmSync(evilTmp, { recursive: true, force: true });
  });

  async function evilHarness(): Promise<TestHarness> {
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
      path: evilWorkspace,
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

  it("readPage returns error when the wiki root is a symlink escape", async () => {
    const harness = await evilHarness();
    const result = await harness.getData<{ body?: string; error?: string }>(
      "readPage",
      { companyId: COMPANY_ID, projectId: PROJECT_ID, slug: "exposed" },
    );
    expect(result.error).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain(SECRET_MARKER);
  });

  it("searchWiki returns nothing when the wiki root is a symlink escape", async () => {
    const harness = await evilHarness();
    const result = await harness.getData<{
      results: { slug: string }[];
    }>("searchWiki", {
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      query: SECRET_MARKER.toLowerCase(),
    });
    expect(result.results).toEqual([]);
  });

  it("loadIndex returns no pages when the wiki root is a symlink escape", async () => {
    const harness = await evilHarness();
    const result = await harness.getData<{
      index: string;
      shards: unknown[];
      pages: unknown[];
    }>("loadIndex", { companyId: COMPANY_ID, projectId: PROJECT_ID });
    expect(result.pages).toEqual([]);
    expect(result.index).toBe("");
    expect(result.shards).toEqual([]);
  });

  it("wikiHealth reports wikiPathMissing when the wiki root is a symlink escape", async () => {
    const harness = await evilHarness();
    const result = await harness.getData<{
      wikiPathMissing: boolean;
      pageCount: number;
    }>("wikiHealth", { companyId: COMPANY_ID, projectId: PROJECT_ID });
    expect(result.wikiPathMissing).toBe(true);
    expect(result.pageCount).toBe(0);
  });
});

describe("symlink containment — direct index.md and indexes/*.md reads", () => {
  // loadIndex reads index.md and indexes/*.md without going through the
  // contained walker. Symlinks at those paths must be checked separately.

  let escapeTmp: string;
  let escapeWorkspace: string;
  let escapeWiki: string;
  let escapeExternal: string;

  beforeAll(() => {
    escapeTmp = mkdtempSync(join(tmpdir(), "symlink-index-"));
    escapeWorkspace = join(escapeTmp, "workspace");
    escapeWiki = join(escapeWorkspace, "wiki");
    escapeExternal = join(escapeTmp, "external");
    mkdirSync(escapeWiki, { recursive: true });
    mkdirSync(escapeExternal, { recursive: true });
    mkdirSync(join(escapeWiki, "indexes"));

    writeFileSync(
      join(escapeWiki, "innocent.md"),
      `---
type: concept
title: Innocent
tags: [x]
created: 2026-05-05
updated: 2026-05-05
---

innocent body
`,
      "utf-8",
    );

    // Create a real index.md so loadIndex's read is exercised on a
    // contained file too (positive case).
    writeFileSync(join(escapeWiki, "index.md"), "# real index\n", "utf-8");

    // Now stage the escape: a normal index.md exists, but ALSO replace
    // it with a symlink to a file outside the workspace. We need a
    // separate fixture without a real index.md so the symlink scenario
    // is unambiguous — see the per-test setup below.

    writeFileSync(
      join(escapeExternal, "secret-index.md"),
      `the ${SECRET_MARKER} (in the external secret-index file)\n`,
      "utf-8",
    );
    writeFileSync(
      join(escapeExternal, "shard-secret.md"),
      `the ${SECRET_MARKER} (in the external shard file)\n`,
      "utf-8",
    );
  });

  afterAll(() => {
    rmSync(escapeTmp, { recursive: true, force: true });
  });

  async function escapeHarness(): Promise<TestHarness> {
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
      path: escapeWorkspace,
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

  it("reads the real index.md in the happy path", async () => {
    const harness = await escapeHarness();
    const result = await harness.getData<{
      index: string;
      pages: { slug: string }[];
    }>("loadIndex", { companyId: COMPANY_ID, projectId: PROJECT_ID });
    expect(result.index).toBe("# real index\n");
    expect(result.pages.map((p) => p.slug)).toContain("innocent");
  });

  it("does not return content from a symlinked index.md that escapes the wiki", async () => {
    // Use unlinkSync (works for files and symlinks) and a try/finally so
    // a failed assertion still restores the fixture for downstream tests.
    unlinkSync(join(escapeWiki, "index.md"));
    symlinkSync(
      join(escapeExternal, "secret-index.md"),
      join(escapeWiki, "index.md"),
    );
    let result: { index: string } | undefined;
    try {
      const harness = await escapeHarness();
      result = await harness.getData<{ index: string }>(
        "loadIndex",
        { companyId: COMPANY_ID, projectId: PROJECT_ID },
      );
    } finally {
      // unlinkSync removes the symlink itself (never follows). rmSync on
      // a symlink works for files but is fragile cross-platform; prefer
      // unlinkSync for any path that could be a symlink.
      unlinkSync(join(escapeWiki, "index.md"));
      writeFileSync(join(escapeWiki, "index.md"), "# real index\n", "utf-8");
    }
    expect(result?.index).toBe("");
    expect(result?.index ?? "").not.toContain(SECRET_MARKER);
  });

  it("does not return content from symlinked indexes/foo.md shards that escape the wiki", async () => {
    symlinkSync(
      join(escapeExternal, "shard-secret.md"),
      join(escapeWiki, "indexes", "by-secret.md"),
    );
    writeFileSync(
      join(escapeWiki, "indexes", "by-type.md"),
      "# real shard\n",
      "utf-8",
    );
    let result:
      | { shards: { name: string; text: string }[] }
      | undefined;
    try {
      const harness = await escapeHarness();
      result = await harness.getData<{
        shards: { name: string; text: string }[];
      }>("loadIndex", { companyId: COMPANY_ID, projectId: PROJECT_ID });
    } finally {
      unlinkSync(join(escapeWiki, "indexes", "by-secret.md"));
      unlinkSync(join(escapeWiki, "indexes", "by-type.md"));
    }
    expect(result?.shards).toHaveLength(1);
    expect(result?.shards[0]?.name).toBe("by-type");
    for (const s of result?.shards ?? []) {
      expect(s.text).not.toContain(SECRET_MARKER);
    }
  });

  it("does not return shards when the indexes/ directory itself is a symlink escape", async () => {
    // The original `indexes/` is a real (empty) directory created in
    // beforeAll. Replace it with a symlink to a directory outside the
    // wiki, run the assertion, then restore via unlinkSync (rmSync on a
    // symlink-to-directory throws EISDIR on Linux without
    // {recursive, force} flags).
    rmSync(join(escapeWiki, "indexes"), { recursive: true, force: true });
    symlinkSync(escapeExternal, join(escapeWiki, "indexes"));
    let result:
      | { shards: { name: string; text: string }[] }
      | undefined;
    try {
      const harness = await escapeHarness();
      result = await harness.getData<{
        shards: { name: string; text: string }[];
      }>("loadIndex", { companyId: COMPANY_ID, projectId: PROJECT_ID });
    } finally {
      unlinkSync(join(escapeWiki, "indexes"));
      mkdirSync(join(escapeWiki, "indexes"));
    }
    expect(result?.shards).toEqual([]);
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
