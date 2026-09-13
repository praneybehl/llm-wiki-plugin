import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectPages } from "../../src/lib/bm25.js";
import { computeStats } from "../../src/lib/stats.js";
import { lintWiki } from "../../src/lib/lint.js";

it("keeps staged skill snapshots out of search, stats and lint", () => {
  const root = mkdtempSync(join(tmpdir(), "wiki-evolution-"));
  try {
    mkdirSync(join(root, ".evolution", "trial", "candidate"), { recursive: true });
    const before = { pages: collectPages(root), stats: computeStats(root), lint: lintWiki(root) };
    writeFileSync(join(root, ".evolution", "trial", "candidate", "SKILL.md"),
      "No frontmatter and [[broken]] internal links: never a wiki page.");
    expect(collectPages(root)).toEqual(before.pages);
    expect(computeStats(root)).toEqual(before.stats);
    expect(lintWiki(root)).toEqual(before.lint);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
