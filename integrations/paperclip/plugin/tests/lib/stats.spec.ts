import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeStats, type StatsResult } from "../../src/lib/stats.js";

/**
 * Contract: byte-for-byte parity with skills/llm-wiki/scripts/wiki_stats.py:
 *   - Skip rules: SCHEMA.md, log.md, README.md at top level (NOT index.md —
 *     index.md is read for indexLines and excluded from page counts).
 *     indexes/, graph/ directories skipped. Dotfiles skipped.
 *   - Scaling thresholds (lines 140-151 of wiki_stats.py):
 *       totalPages < 50                                → "below first threshold"
 *       50 <= totalPages < 150 AND indexLines < 300    → "below shard threshold"
 *       (totalPages >= 150 OR indexLines >= 300)
 *         AND no `indexes/` directory                  → "AT SHARD THRESHOLD"
 *       totalPages >= 300                              → "past 300"
 *       totalPages >= 500                              → "lint weekly"
 *
 * Tests build fixture wikis dynamically; expected sizes are commented.
 */

function buildWiki(spec: {
  pages: { rel: string; type?: string; tags?: string[]; body?: string; links?: string[] }[];
  indexLines?: number;
  hasIndexesDir?: boolean;
  topLevelExtras?: { name: string; content: string }[];
}): string {
  const root = mkdtempSync(join(tmpdir(), "stats-wiki-"));

  for (const p of spec.pages) {
    const path = join(root, p.rel);
    mkdirSync(join(path, ".."), { recursive: true });
    const fmLines = ["---"];
    if (p.type) fmLines.push(`type: ${p.type}`);
    fmLines.push(`title: ${p.rel}`);
    if (p.tags) fmLines.push(`tags: [${p.tags.join(", ")}]`);
    fmLines.push("---");
    const linkLines = (p.links ?? []).map((l) => `see [[${l}]]`);
    const body = [p.body ?? "stub", ...linkLines].join("\n");
    writeFileSync(path, fmLines.join("\n") + "\n" + body + "\n", "utf-8");
  }

  if (spec.indexLines !== undefined) {
    // Drop the trailing newline so lineCount(text) == spec.indexLines exactly
    // (Python's lineCount = newlines + 1; N entries joined by \n = N-1
    // newlines = N lines).
    const lines = Array.from({ length: spec.indexLines }, (_, i) => `index line ${i + 1}`);
    writeFileSync(join(root, "index.md"), lines.join("\n"), "utf-8");
  }

  if (spec.hasIndexesDir) {
    mkdirSync(join(root, "indexes"), { recursive: true });
    writeFileSync(join(root, "indexes/by-type.md"), "# sharded index\n", "utf-8");
  }

  for (const ex of spec.topLevelExtras ?? []) {
    writeFileSync(join(root, ex.name), ex.content, "utf-8");
  }

  return root;
}

function makePages(n: number, type: string): { rel: string; type: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    rel: `entities/page-${String(i + 1).padStart(4, "0")}.md`,
    type,
  }));
}

describe("computeStats — small wiki (below first threshold)", () => {
  let root: string;
  let stats: StatsResult;

  beforeAll(() => {
    root = buildWiki({
      pages: [
        { rel: "concepts/alpha.md", type: "concept", tags: ["x"], links: ["beta"] },
        { rel: "concepts/beta.md", type: "concept", tags: ["x"], links: ["alpha"] },
        { rel: "entities/widget.md", type: "entity", tags: ["x"], links: ["alpha"] },
      ],
    });
    stats = computeStats(root);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("counts pages, lines, words, links", () => {
    expect(stats.totalPages).toBe(3);
    expect(stats.totalLines).toBeGreaterThan(0);
    expect(stats.totalWords).toBeGreaterThan(0);
    expect(stats.totalLinks).toBe(3);
  });

  it("groups pages by type from frontmatter", () => {
    expect(stats.pagesByType.concept).toBe(2);
    expect(stats.pagesByType.entity).toBe(1);
  });

  it("groups pages by top-level directory", () => {
    expect(stats.pagesByDirectory.concepts).toBe(2);
    expect(stats.pagesByDirectory.entities).toBe(1);
  });

  it("indexLines is 0 when no index.md exists", () => {
    expect(stats.indexLines).toBe(0);
  });

  it("ranks most-linked pages by inbound count", () => {
    const linkedBySlug = new Map(stats.mostLinkedIn.map((r) => [r.slug, r.count]));
    expect(linkedBySlug.get("alpha")).toBe(2);
    expect(linkedBySlug.get("beta")).toBe(1);
  });

  it("emits 'below first threshold' message", () => {
    expect(stats.scalingMessages.join("\n")).toMatch(/below first threshold/i);
  });

  it("does NOT emit shard / past-300 / lint-weekly messages", () => {
    const joined = stats.scalingMessages.join("\n").toLowerCase();
    expect(joined).not.toMatch(/shard threshold/);
    expect(joined).not.toMatch(/past 300/);
    expect(joined).not.toMatch(/lint weekly/);
  });
});

describe("computeStats — skip rules", () => {
  let root: string;
  let stats: StatsResult;

  beforeAll(() => {
    root = buildWiki({
      pages: [{ rel: "concepts/alpha.md", type: "concept" }],
      indexLines: 50,
      hasIndexesDir: true,
      topLevelExtras: [
        { name: "SCHEMA.md", content: "skipped\n" },
        { name: "log.md", content: "skipped\n" },
        { name: "README.md", content: "skipped\n" },
        { name: ".hidden.md", content: "skipped\n" },
      ],
    });
    // Add a graph/ directory file
    mkdirSync(join(root, "graph"), { recursive: true });
    writeFileSync(join(root, "graph/nodes.md"), "graph\n", "utf-8");
    stats = computeStats(root);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("totalPages excludes SCHEMA / log / README / dotfiles / indexes/ / graph/", () => {
    expect(stats.totalPages).toBe(1);
  });

  it("counts index.md lines via indexLines, not as a regular page", () => {
    expect(stats.indexLines).toBe(50);
  });

  it("pagesByDirectory does not include indexes or graph", () => {
    expect(stats.pagesByDirectory.indexes).toBeUndefined();
    expect(stats.pagesByDirectory.graph).toBeUndefined();
  });
});

describe("computeStats — at shard threshold (page count)", () => {
  let root: string;
  let stats: StatsResult;

  beforeAll(() => {
    // 150 pages → AT SHARD THRESHOLD when no indexes/ dir.
    root = buildWiki({ pages: makePages(150, "entity") });
    stats = computeStats(root);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("emits AT SHARD THRESHOLD message", () => {
    expect(stats.scalingMessages.join("\n")).toMatch(/AT SHARD THRESHOLD/);
  });

  it("does not yet emit past-300 message", () => {
    expect(stats.scalingMessages.join("\n").toLowerCase()).not.toMatch(/past 300/);
  });
});

describe("computeStats — index size triggers shard threshold below 150 pages", () => {
  let root: string;
  let stats: StatsResult;

  beforeAll(() => {
    // Need ≥50 pages so the "Below first threshold" branch doesn't capture
    // first; with 100 pages and indexLines=350, the elif chain falls through
    // to AT SHARD THRESHOLD via the indexLines clause.
    root = buildWiki({
      pages: makePages(100, "concept"),
      indexLines: 350,
    });
    stats = computeStats(root);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("indexLines >= 300 triggers shard message even when below 150 pages", () => {
    expect(stats.scalingMessages.join("\n")).toMatch(/AT SHARD THRESHOLD/);
  });
});

describe("computeStats — shard threshold suppressed when indexes/ exists", () => {
  let root: string;
  let stats: StatsResult;

  beforeAll(() => {
    root = buildWiki({
      pages: makePages(150, "concept"),
      hasIndexesDir: true,
    });
    stats = computeStats(root);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("does not emit AT SHARD THRESHOLD when indexes/ dir is present", () => {
    expect(stats.scalingMessages.join("\n")).not.toMatch(/AT SHARD THRESHOLD/);
  });
});

describe("computeStats — past 300 pages (with indexes/ already sharded)", () => {
  let root: string;
  let stats: StatsResult;

  beforeAll(() => {
    // Per Python's elif chain, "Past 300" only fires when AT SHARD THRESHOLD
    // doesn't (i.e. indexes/ already exists). At 300 pages without indexes/,
    // AT SHARD THRESHOLD would fire instead.
    root = buildWiki({ pages: makePages(300, "concept"), hasIndexesDir: true });
    stats = computeStats(root);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("emits past-300 message", () => {
    expect(stats.scalingMessages.join("\n").toLowerCase()).toMatch(/past 300/);
  });

  it("does not emit lint-weekly yet at exactly 300", () => {
    expect(stats.scalingMessages.join("\n").toLowerCase()).not.toMatch(/past 500/);
  });
});

describe("computeStats — 300 pages without indexes/ → AT SHARD takes precedence", () => {
  let root: string;
  let stats: StatsResult;

  beforeAll(() => {
    root = buildWiki({ pages: makePages(300, "concept") });
    stats = computeStats(root);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("emits AT SHARD THRESHOLD, not past-300, when indexes/ is missing", () => {
    const joined = stats.scalingMessages.join("\n");
    expect(joined).toMatch(/AT SHARD THRESHOLD/);
    expect(joined.toLowerCase()).not.toMatch(/past 300/);
  });
});

describe("computeStats — past 500 pages", () => {
  let root: string;
  let stats: StatsResult;

  beforeAll(() => {
    // Past 500 always fires regardless of indexes/ — it's a separate top-level
    // if (Python wiki_stats.py:150-151).
    root = buildWiki({ pages: makePages(500, "concept"), hasIndexesDir: true });
    stats = computeStats(root);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("emits past-500 / lint-weekly message", () => {
    const joined = stats.scalingMessages.join("\n").toLowerCase();
    expect(joined).toMatch(/past 500/);
    expect(joined).toMatch(/lint/);
  });
});

describe("computeStats — derived metrics", () => {
  let root: string;
  let stats: StatsResult;

  beforeAll(() => {
    root = buildWiki({
      pages: [
        { rel: "concepts/alpha.md", type: "concept", links: ["beta", "gamma"] },
        { rel: "concepts/beta.md", type: "concept", links: ["alpha"] },
      ],
    });
    stats = computeStats(root);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("linkDensity = totalLinks / totalPages", () => {
    // 3 links / 2 pages
    expect(stats.linkDensity).toBeCloseTo(1.5, 5);
  });

  it("avgLinesPerPage and avgWordsPerPage are integer divisions like Python", () => {
    expect(Number.isInteger(stats.avgLinesPerPage)).toBe(true);
    expect(Number.isInteger(stats.avgWordsPerPage)).toBe(true);
    expect(stats.avgLinesPerPage).toBe(Math.floor(stats.totalLines / stats.totalPages));
    expect(stats.avgWordsPerPage).toBe(Math.floor(stats.totalWords / stats.totalPages));
  });

  it("largest is sorted by line count descending", () => {
    for (let i = 1; i < stats.largest.length; i++) {
      const prev = stats.largest[i - 1]!;
      const cur = stats.largest[i]!;
      expect(prev.lines).toBeGreaterThanOrEqual(cur.lines);
    }
  });
});
