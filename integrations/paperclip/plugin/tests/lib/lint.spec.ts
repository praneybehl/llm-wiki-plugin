import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lintWiki, type LintFindings } from "../../src/lib/lint.js";

/**
 * Contract: byte-for-byte parity with skills/llm-wiki/scripts/wiki_lint.py
 * (lines 119-241). Same finding categories, same thresholds, same skip
 * rules — soft cap 400, hard cap 800, staleness 90d for hubs with ≥3
 * inbound. Skips SCHEMA.md, index.md, log.md, README.md at top level and
 * indexes/, graph/, raw/ directories, plus dotfiles.
 *
 * Fixture wiki is built at test time so the seeded issues are visible in
 * the test source (no large dummy .md files in the repo).
 */

let root: string;
let findings: LintFindings;

const today = new Date();
const isoToday = today.toISOString().slice(0, 10);
const daysAgo = (n: number): string => {
  const d = new Date(today.getTime() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
};

function write(rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function fmPage(opts: {
  type?: string;
  title?: string;
  tags?: string[];
  created?: string;
  updated?: string;
  body: string;
  malformed?: boolean;
}): string {
  if (opts.malformed) {
    // Open frontmatter, never close.
    return `---
type: concept
title: Malformed
tags: [a]
created: ${opts.created ?? isoToday}
updated: ${opts.updated ?? isoToday}
${opts.body}
`;
  }
  const fmLines = ["---"];
  if (opts.type !== undefined) fmLines.push(`type: ${opts.type}`);
  if (opts.title !== undefined) fmLines.push(`title: ${opts.title}`);
  if (opts.tags !== undefined) fmLines.push(`tags: [${opts.tags.join(", ")}]`);
  if (opts.created !== undefined) fmLines.push(`created: ${opts.created}`);
  if (opts.updated !== undefined) fmLines.push(`updated: ${opts.updated}`);
  fmLines.push("---");
  return fmLines.join("\n") + "\n" + opts.body + "\n";
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lint-wiki-"));

  // ── A stale hub: ≥3 inbound, updated > 90 days ago ─────────────────
  write(
    "entities/stale-hub.md",
    fmPage({
      type: "entity",
      title: "Stale Hub",
      tags: ["hub"],
      created: daysAgo(200),
      updated: daysAgo(120),
      body: "A hub page that hasn't been touched in a while.",
    }),
  );

  // ── Three pages linking into the hub (so it has 3 inbound) ─────────
  write(
    "concepts/linker-one.md",
    fmPage({
      type: "concept",
      title: "Linker One",
      tags: ["x"],
      created: isoToday,
      updated: isoToday,
      body: "see [[stale-hub]] for context",
    }),
  );
  write(
    "concepts/linker-two.md",
    fmPage({
      type: "concept",
      title: "Linker Two",
      tags: ["x"],
      created: isoToday,
      updated: isoToday,
      body: "see [[stale-hub]] and [[broken-target-does-not-exist]]", // also seeds a broken link
    }),
  );
  write(
    "concepts/linker-three.md",
    fmPage({
      type: "concept",
      title: "Linker Three",
      tags: ["x"],
      created: isoToday,
      updated: isoToday,
      body: "links to [[stale-hub]]",
    }),
  );

  // ── Orphan: no inbound, no broken refs, valid FM ────────────────────
  write(
    "concepts/orphan-page.md",
    fmPage({
      type: "concept",
      title: "Orphan",
      tags: ["x"],
      created: isoToday,
      updated: isoToday,
      body: "no one links here",
    }),
  );

  // ── Missing frontmatter fields (no tags, no updated) ────────────────
  write(
    "concepts/missing-fields.md",
    fmPage({
      type: "concept",
      title: "Missing fields",
      created: isoToday,
      // tags + updated intentionally absent
      body: "incomplete metadata, but still a valid markdown file",
    }),
  );

  // ── Malformed frontmatter (opens --- without closing) ──────────────
  write(
    "concepts/malformed.md",
    `---
type: concept
title: Malformed (no close)
this frontmatter never ends
`,
  );

  // ── Duplicate slugs across different directories ────────────────────
  write(
    "entities/dupe.md",
    fmPage({
      type: "entity",
      title: "Dupe (entity copy)",
      tags: ["x"],
      created: isoToday,
      updated: isoToday,
      body: "first dupe",
    }),
  );
  write(
    "concepts/dupe.md",
    fmPage({
      type: "concept",
      title: "Dupe (concept copy)",
      tags: ["x"],
      created: isoToday,
      updated: isoToday,
      body: "second dupe",
    }),
  );

  // ── Oversized: hard cap (lines >> 800). Use a small custom cap below ─
  // We also seed a soft-oversize fixture below the hard one.
  write(
    "concepts/oversize-hard.md",
    fmPage({
      type: "concept",
      title: "Oversize hard",
      tags: ["x"],
      created: isoToday,
      updated: isoToday,
      body: Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n"),
    }),
  );
  write(
    "concepts/oversize-soft.md",
    // Frontmatter is ~8 lines on its own; body of 5 lines lands the file
    // between softCap (10) and hardCap (20).
    fmPage({
      type: "concept",
      title: "Oversize soft",
      tags: ["x"],
      created: isoToday,
      updated: isoToday,
      body: Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join("\n"),
    }),
  );

  // ── Files that must be skipped (top-level + special dirs) ──────────
  write("SCHEMA.md", "# wiki schema (must be skipped)");
  write("index.md", "# wiki index (must be skipped)");
  write("log.md", "# wiki log (must be skipped)");
  write("README.md", "# readme (must be skipped per lint rule)");
  write("indexes/by-type.md", "# sharded index (skipped dir)");
  write("graph/nodes.md", "# graph file (skipped dir)");
  write("raw/source.md", "# immutable raw source (skipped dir)");
  write(".hidden.md", "# dotfile, must be skipped");

  // Run lint with small caps so the dummy oversize bodies trip the cap.
  findings = lintWiki(root, { softCap: 10, hardCap: 20 });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("lintWiki — finding categories", () => {
  it("reports the orphan page", () => {
    const slugs = findings.orphans.map((o) => o.slug);
    expect(slugs).toContain("orphan-page");
  });

  it("reports the broken wikilink with from / to fields", () => {
    const broken = findings.brokenLinks.find(
      (b) => b.to === "broken-target-does-not-exist",
    );
    expect(broken).toBeDefined();
    expect(broken?.from).toBe("linker-two");
  });

  it("reports oversized hard pages above hardCap", () => {
    const paths = findings.oversizedHard.map((o) => o.path);
    expect(paths).toContain("concepts/oversize-hard.md");
    const entry = findings.oversizedHard.find(
      (o) => o.path === "concepts/oversize-hard.md",
    );
    expect(entry?.lines).toBeGreaterThan(20);
  });

  it("reports oversized soft pages between softCap and hardCap", () => {
    const paths = findings.oversizedSoft.map((o) => o.path);
    expect(paths).toContain("concepts/oversize-soft.md");
  });

  it("hard-oversize pages do NOT also appear in soft-oversize (mutually exclusive)", () => {
    const hardPaths = new Set(findings.oversizedHard.map((o) => o.path));
    const softPaths = findings.oversizedSoft.map((o) => o.path);
    for (const p of softPaths) expect(hardPaths.has(p)).toBe(false);
  });

  it("reports missing required frontmatter fields", () => {
    const entry = findings.missingFrontmatter.find(
      (m) => m.path === "concepts/missing-fields.md",
    );
    expect(entry).toBeDefined();
    expect(entry?.missing.sort()).toEqual(["tags", "updated"]);
  });

  it("reports malformed frontmatter", () => {
    const paths = findings.malformedFrontmatter.map((m) => m.path);
    expect(paths).toContain("concepts/malformed.md");
  });

  it("malformed pages are NOT also reported as missing-fields", () => {
    // Python: missing-fm is checked only when fm is parseable.
    const missing = findings.missingFrontmatter.map((m) => m.path);
    expect(missing).not.toContain("concepts/malformed.md");
  });

  it("reports duplicate slugs with both paths", () => {
    const dupe = findings.duplicateSlugs.find((d) => d.slug === "dupe");
    expect(dupe).toBeDefined();
    expect(dupe?.paths.sort()).toEqual([
      "concepts/dupe.md",
      "entities/dupe.md",
    ]);
  });

  it("reports the stale hub (≥3 inbound, updated > 90d ago)", () => {
    const stale = findings.stalePages.find((s) => s.path.endsWith("stale-hub.md"));
    expect(stale).toBeDefined();
    expect(stale?.ageDays).toBeGreaterThan(90);
    expect(stale?.inboundCount).toBeGreaterThanOrEqual(3);
  });

  it("does NOT report a fresh page or one with <3 inbound as stale", () => {
    // orphan-page is fresh and has no inbound; missing-fields is fresh too.
    const stalePaths = findings.stalePages.map((s) => s.path);
    expect(stalePaths).not.toContain("concepts/orphan-page.md");
    expect(stalePaths).not.toContain("concepts/missing-fields.md");
  });

  it("skips top-level SCHEMA.md / index.md / log.md / README.md", () => {
    const allPaths = [
      ...findings.orphans.map((o) => o.path),
      ...findings.missingFrontmatter.map((m) => m.path),
      ...findings.malformedFrontmatter.map((m) => m.path),
    ];
    for (const skipped of ["SCHEMA.md", "index.md", "log.md", "README.md"]) {
      expect(allPaths).not.toContain(skipped);
    }
  });

  it("skips indexes/, graph/, and raw/ directories", () => {
    const allPaths = [
      ...findings.orphans.map((o) => o.path),
      ...findings.missingFrontmatter.map((m) => m.path),
    ];
    for (const p of allPaths) {
      expect(p.startsWith("indexes/")).toBe(false);
      expect(p.startsWith("graph/")).toBe(false);
      expect(p.startsWith("raw/")).toBe(false);
    }
  });

  it("skips dotfiles", () => {
    const allPaths = findings.orphans.map((o) => o.path);
    for (const p of allPaths) expect(p).not.toMatch(/(^|\/)\./);
  });
});

describe("lintWiki — summary counts", () => {
  it("summary.totalPages excludes skipped files", () => {
    // Seeded pages: stale-hub, linker-one/two/three, orphan-page,
    // missing-fields, malformed, entities/dupe, concepts/dupe,
    // oversize-hard, oversize-soft = 11 pages.
    expect(findings.summary.totalPages).toBe(11);
  });

  it("summary counts match the per-category arrays", () => {
    expect(findings.summary.orphans).toBe(findings.orphans.length);
    expect(findings.summary.brokenLinks).toBe(findings.brokenLinks.length);
    expect(findings.summary.oversizedHard).toBe(findings.oversizedHard.length);
    expect(findings.summary.oversizedSoft).toBe(findings.oversizedSoft.length);
    expect(findings.summary.missingFrontmatter).toBe(
      findings.missingFrontmatter.length,
    );
    expect(findings.summary.malformedFrontmatter).toBe(
      findings.malformedFrontmatter.length,
    );
    expect(findings.summary.duplicateSlugs).toBe(findings.duplicateSlugs.length);
    expect(findings.summary.stalePages).toBe(findings.stalePages.length);
  });
});

describe("lintWiki — clean wiki", () => {
  it("returns empty findings (modulo summary) for a wiki with no issues", () => {
    const cleanRoot = mkdtempSync(join(tmpdir(), "clean-wiki-"));
    try {
      writeFileSync(
        join(cleanRoot, "page-a.md"),
        fmPage({
          type: "concept",
          title: "A",
          tags: ["x"],
          created: isoToday,
          updated: isoToday,
          body: "links to [[page-b]]",
        }),
      );
      writeFileSync(
        join(cleanRoot, "page-b.md"),
        fmPage({
          type: "concept",
          title: "B",
          tags: ["x"],
          created: isoToday,
          updated: isoToday,
          body: "links to [[page-a]]",
        }),
      );
      const r = lintWiki(cleanRoot);
      expect(r.orphans).toEqual([]);
      expect(r.brokenLinks).toEqual([]);
      expect(r.oversizedHard).toEqual([]);
      expect(r.oversizedSoft).toEqual([]);
      expect(r.missingFrontmatter).toEqual([]);
      expect(r.malformedFrontmatter).toEqual([]);
      expect(r.duplicateSlugs).toEqual([]);
      expect(r.stalePages).toEqual([]);
      expect(r.summary.totalPages).toBe(2);
    } finally {
      rmSync(cleanRoot, { recursive: true, force: true });
    }
  });
});
