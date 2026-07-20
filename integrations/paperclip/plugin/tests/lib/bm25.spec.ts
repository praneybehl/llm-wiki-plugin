import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  collectPages,
  pageFromText,
  searchPages,
  searchSections,
  splitSections,
  backlinks,
  topLinked,
} from "../../src/lib/bm25.js";

/**
 * Contract: byte-for-byte parity with skills/llm-wiki/scripts/wiki_search.py.
 *
 * Ground-truth ranks are captured by tests/fixtures/_gen_bm25_expectations.py
 * (run when fixtures or query coverage change). This test loads that snapshot
 * and asserts our TS implementation produces the same ordered slug list.
 *
 * Constants from the Python reference (verbatim):
 *   k1 = 1.5, b = 0.75
 *   tokenizer:    [a-z0-9]+
 *   IDF formula:  log(1 + (N - df + 0.5) / (df + 0.5))
 *   Skip rules:   SCHEMA.md, index.md, log.md at top level; indexes/ + graph/ dirs; dotfiles
 */

const FIXTURES_ROOT = resolve(process.cwd(), "tests/fixtures/wiki");
const EXPECTATIONS_PATH = resolve(
  process.cwd(),
  "tests/fixtures/bm25-expectations.json",
);

interface Snapshot {
  queries: { query: string; slugs: string[] }[];
  sections: {
    query: string;
    results: { slug: string; headingPath: string[] }[];
  }[];
  filters: { label: string; args: string[]; slugs: string[] }[];
  backlinks: { target: string; slugs: string[] }[];
  topLinked: { slug: string; count: number; broken: boolean }[];
}

const snapshot = JSON.parse(
  readFileSync(EXPECTATIONS_PATH, "utf-8"),
) as Snapshot;

const pages = collectPages(FIXTURES_ROOT);

describe("collectPages", () => {
  it("walks the fixture wiki and returns 8 pages", () => {
    expect(pages).toHaveLength(8);
  });

  it("skips top-level SCHEMA.md / index.md / log.md and indexes/, graph/ dirs", () => {
    // Fixture wiki has none of those, but the rule must hold — assert no
    // page slug equals one of the skipped names.
    const slugs = pages.map((p) => p.slug);
    for (const skipped of ["SCHEMA", "index", "log"]) {
      expect(slugs).not.toContain(skipped);
    }
  });

  it("extracts links from the body, not the frontmatter", () => {
    const transformer = pages.find((p) => p.slug === "transformer");
    expect(transformer).toBeDefined();
    // Body has [[attention-paper]], [[gpt-3]], [[attention-mechanism]].
    expect(transformer!.links.sort()).toEqual(
      ["attention-mechanism", "attention-paper", "gpt-3"].sort(),
    );
  });

  it("populates frontmatter into meta", () => {
    const sl = pages.find((p) => p.slug === "scaling-laws");
    expect(sl?.meta.type).toBe("concept");
    expect(sl?.meta.tags).toEqual(["scaling", "training", "safety"]);
    expect(sl?.meta.updated).toBe("2026-02-15");
  });
});

describe("splitSections contract", () => {
  it("retains the empty preface and an empty heading section", () => {
    expect(splitSections("Page", "# Heading\n")).toEqual([
      { headingPath: [], level: 0, text: "", sectionIndex: 0 },
      { headingPath: ["Heading"], level: 1, text: "", sectionIndex: 1 },
    ]);
  });

  it("tracks nested headings and resets at a parent level", () => {
    const sections = splitSections(
      "Page",
      "preface\n# One\nalpha\n## Two\nbeta\n# Reset\ngamma",
    );
    expect(sections.map((section) => section.headingPath)).toEqual([
      [],
      ["One"],
      ["One", "Two"],
      ["Reset"],
    ]);
  });

  it("replaces same-level siblings when heading levels are skipped", () => {
    const sections = splitSections(
      "Page",
      "## Alpha\none\n## Beta\ntwo\n# One\n### X\nx\n### Y\ny",
    );
    expect(sections.map((section) => section.headingPath)).toEqual([
      [],
      ["Alpha"],
      ["Beta"],
      ["One"],
      ["One", "X"],
      ["One", "Y"],
    ]);
  });

  it("ignores headings inside backtick and tilde fences", () => {
    const sections = splitSections(
      "Page",
      "# Real\n```md\n## Backtick\n```\n~~~md\n### Tilde\n~~~\n## Next\nbody",
    );
    expect(sections.map((section) => section.headingPath)).toEqual([
      [],
      ["Real"],
      ["Real", "Next"],
    ]);
    expect(sections[1]?.text).toContain("## Backtick");
    expect(sections[1]?.text).toContain("### Tilde");
  });
  it("matches Python splitlines behavior for lone CR and Unicode separators", () => {
    const sections = splitSections(
      "Page",
      "# Real\rbody\u2028## Next\rfinal",
    );
    expect(sections.map((section) => section.headingPath)).toEqual([
      [],
      ["Real"],
      ["Real", "Next"],
    ]);
  });

  it("falls back to the slug when frontmatter title is an empty string", () => {
    const page = pageFromText(
      "/wiki/zeta-topic.md",
      "concepts/zeta-topic.md",
      "---\ntype: concept\ntitle: \"\"\n---\n# Zeta Topic\nbody",
    );
    const results = searchSections([page], { query: "zeta topic", topK: 10 });
    expect(results.map(({ section }) => section.headingPath)).toEqual([
      ["Zeta Topic"],
      [],
    ]);
  });

});

describe("searchPages — Python parity", () => {
  for (const { query, slugs: expected } of snapshot.queries) {
    it(`query: ${JSON.stringify(query)} ranks identically to wiki_search.py`, () => {
      const results = searchPages(pages, { query, topK: 10 });
      const actualSlugs = results.map((r) => r.page.slug);
      expect(actualSlugs).toEqual(expected);
    });
  }
});

describe("searchSections — Python parity", () => {
  for (const { query, results: expected } of snapshot.sections) {
    it(`query: ${JSON.stringify(query)} ranks sections identically to wiki_search.py`, () => {
      const results = searchSections(pages, { query, topK: 10 });
      const actual = results.map(({ section }) => ({
        slug: section.page.slug,
        headingPath: section.headingPath,
      }));
      expect(actual).toEqual(expected);
    });
  }
});

describe("searchPages — filter parity", () => {
  for (const { label, args, slugs: expected } of snapshot.filters) {
    it(`filter: ${label}`, () => {
      const query = args[0]!;
      const filters: { type?: string; tags?: string[]; since?: string } = {};
      for (let i = 1; i < args.length; i += 2) {
        const flag = args[i];
        const value = args[i + 1];
        if (!value) continue;
        if (flag === "--type") filters.type = value;
        else if (flag === "--tag") {
          filters.tags = filters.tags ?? [];
          filters.tags.push(value);
        } else if (flag === "--since") filters.since = value;
      }
      const results = searchPages(pages, { query, topK: 10, filters });
      const actualSlugs = results.map((r) => r.page.slug);
      expect(actualSlugs).toEqual(expected);
    });
  }
});

describe("backlinks", () => {
  for (const { target, slugs: expected } of snapshot.backlinks) {
    it(`pages linking to ${target}`, () => {
      const inbound = backlinks(pages, target);
      // Python order is collection order (alphabetical relPath).
      expect(inbound.map((p) => p.slug)).toEqual(expected);
    });
  }
});

describe("topLinked", () => {
  it("ranks hub pages by inbound count, ties broken by first-seen", () => {
    const rows = topLinked(pages, 10);
    expect(rows).toEqual(snapshot.topLinked);
  });

  it("flags broken targets (slugs with no matching page)", () => {
    // Add a synthetic page that links to a missing slug.
    const synthetic = [
      ...pages,
      {
        path: "/fake/orphan-link.md",
        relPath: "orphan-link.md",
        slug: "orphan-link",
        meta: {} as Record<string, never>,
        body: "see [[no-such-page]]",
        tokens: [],
        links: ["no-such-page"],
      },
    ];
    const rows = topLinked(synthetic, 20);
    const broken = rows.find((r) => r.slug === "no-such-page");
    expect(broken).toBeDefined();
    expect(broken?.broken).toBe(true);
  });
});

describe("searchPages — additional behavior", () => {
  it("returns at most topK results", () => {
    const results = searchPages(pages, { query: "transformer", topK: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("returns empty for a query with no token overlap", () => {
    const results = searchPages(pages, { query: "xyzzy nothing", topK: 5 });
    expect(results).toEqual([]);
  });

  it("returns empty when filters exclude all pages", () => {
    const results = searchPages(pages, {
      query: "transformer",
      topK: 5,
      filters: { type: "doesnotexist" },
    });
    expect(results).toEqual([]);
  });

  it("score is positive for matching docs", () => {
    const results = searchPages(pages, { query: "transformer", topK: 1 });
    expect(results[0]?.score).toBeGreaterThan(0);
  });
});
