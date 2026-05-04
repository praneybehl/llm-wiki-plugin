import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  extractWikilinks,
  tokenize,
} from "../../src/lib/frontmatter.js";

/**
 * Contract: byte-for-byte parity with skills/llm-wiki/scripts/wiki_lint.py
 * `parse_frontmatter` (lines 46-73) and `wiki_search.py` `tokenize` (line 72)
 * for the YAML subset our schema actually uses. We intentionally match the
 * Python parser's exact behavior — quirks included — rather than pulling in a
 * full YAML library, so search/lint output stays identical across both
 * implementations.
 */

describe("parseFrontmatter", () => {
  it("returns empty meta + full body + malformed=false when no frontmatter", () => {
    const text = "no frontmatter here\nbody body";
    const r = parseFrontmatter(text);
    expect(r.meta).toEqual({});
    expect(r.body).toBe(text);
    expect(r.malformed).toBe(false);
  });

  it("flags malformed when frontmatter opens with --- but never closes", () => {
    const text = "---\nbroken: yes\nbody body";
    const r = parseFrontmatter(text);
    expect(r.malformed).toBe(true);
    expect(r.meta).toEqual({});
    expect(r.body).toBe(text);
  });

  it("parses plain key: value pairs", () => {
    const text = `---
type: concept
title: Attention
---
body content`;
    const r = parseFrontmatter(text);
    expect(r.meta).toEqual({ type: "concept", title: "Attention" });
    expect(r.body).toBe("body content");
    expect(r.malformed).toBe(false);
  });

  it("strips double quotes from scalar values", () => {
    const text = `---
title: "Quoted Title"
---
`;
    const r = parseFrontmatter(text);
    expect(r.meta.title).toBe("Quoted Title");
  });

  it("strips single quotes from scalar values", () => {
    const text = `---
title: 'Single Quoted'
---
`;
    const r = parseFrontmatter(text);
    expect(r.meta.title).toBe("Single Quoted");
  });

  it("parses inline lists", () => {
    const text = `---
tags: [alpha, beta, gamma]
---
`;
    const r = parseFrontmatter(text);
    expect(r.meta.tags).toEqual(["alpha", "beta", "gamma"]);
  });

  it("strips quotes from inline list items", () => {
    const text = `---
tags: ["alpha", 'beta', gamma]
---
`;
    const r = parseFrontmatter(text);
    expect(r.meta.tags).toEqual(["alpha", "beta", "gamma"]);
  });

  it("ignores empty inline list entries", () => {
    const text = `---
tags: [a,, b, ]
---
`;
    const r = parseFrontmatter(text);
    expect(r.meta.tags).toEqual(["a", "b"]);
  });

  it("parses multi-line continuation lists with two-space dash prefix", () => {
    const text = `---
aliases:
  - Praney
  - praney@example.com
type: person
---
body`;
    const r = parseFrontmatter(text);
    expect(r.meta.aliases).toEqual(["Praney", "praney@example.com"]);
    expect(r.meta.type).toBe("person");
  });

  it("multi-line list collects until next key starts", () => {
    const text = `---
tags:
  - alpha
  - beta
title: Mixed
---
`;
    const r = parseFrontmatter(text);
    expect(r.meta.tags).toEqual(["alpha", "beta"]);
    expect(r.meta.title).toBe("Mixed");
  });

  it("ignores blank lines inside frontmatter", () => {
    const text = `---
type: source

title: Paper

tags: [x, y]
---
`;
    const r = parseFrontmatter(text);
    expect(r.meta).toEqual({
      type: "source",
      title: "Paper",
      tags: ["x", "y"],
    });
  });

  it("body is everything after the closing --- line", () => {
    const text = `---
type: concept
---
# Heading

A paragraph with [[wiki-link]].`;
    const r = parseFrontmatter(text);
    expect(r.body).toBe("# Heading\n\nA paragraph with [[wiki-link]].");
  });

  it("only matches keys that are alphanumeric+underscore (Python regex)", () => {
    // The Python regex r"^([a-zA-Z_]+):\s*(.*)$" doesn't accept hyphens or
    // digits in keys. Lines that don't match are silently dropped.
    const text = `---
type: concept
not-a-key: skipped
---
`;
    const r = parseFrontmatter(text);
    expect(r.meta).toEqual({ type: "concept" });
    expect(r.meta["not-a-key"]).toBeUndefined();
  });

  it("a continuation '  - item' before any list-key is dropped", () => {
    // Python only appends to current_key; if no list has been opened, the
    // line is ignored entirely.
    const text = `---
  - orphaned
type: concept
---
`;
    const r = parseFrontmatter(text);
    expect(r.meta).toEqual({ type: "concept" });
  });
});

describe("extractWikilinks", () => {
  it("extracts plain [[slug]] links", () => {
    expect(extractWikilinks("see [[alpha]] and [[beta]]")).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("extracts [[slug|display]] links and returns just the slug", () => {
    expect(extractWikilinks("see [[alpha|Alpha Page]]")).toEqual(["alpha"]);
  });

  it("trims whitespace around the slug", () => {
    expect(extractWikilinks("see [[  spaced  |display]]")).toEqual(["spaced"]);
  });

  it("returns empty for text without links", () => {
    expect(extractWikilinks("plain prose")).toEqual([]);
  });

  it("matches the Python WIKILINK_RE — pipe in the link text doesn't match", () => {
    // Python regex requires the slug part to have no `]` or `|`.
    // [[a|b|c]] — Python matches greedy on first `|`, captures "a", consumes "|b|c".
    expect(extractWikilinks("[[a|b|c]]")).toEqual(["a"]);
  });
});

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumeric runs", () => {
    expect(tokenize("Hello World")).toEqual(["hello", "world"]);
  });

  it("includes digit runs", () => {
    expect(tokenize("GPT-3 paper from 2020")).toEqual([
      "gpt",
      "3",
      "paper",
      "from",
      "2020",
    ]);
  });

  it("collapses punctuation runs into a single split", () => {
    expect(tokenize("foo--bar...baz")).toEqual(["foo", "bar", "baz"]);
  });

  it("returns empty for empty input", () => {
    expect(tokenize("")).toEqual([]);
  });
});
