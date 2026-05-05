// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { wikiHref, parseWikiLocation } from "../../src/ui/href.js";

function setLocation(pathname: string, search: string, hash: string): void {
  // jsdom requires same-origin for history mutation; use a relative URL,
  // which jsdom resolves against the test document's origin (http://localhost/).
  window.history.replaceState({}, "", `${pathname}${search}${hash}`);
}

describe("wikiHref", () => {
  it("returns '#' when companyPrefix is null (sidebar before company resolves)", () => {
    expect(wikiHref(null, { kind: "landing" })).toBe("#");
    expect(wikiHref(null, { kind: "page", slug: "x" })).toBe("#");
  });

  it("builds the landing URL", () => {
    expect(wikiHref("SEE", { kind: "landing" })).toBe("/SEE/llm-wiki");
  });

  it("builds a page URL with hash-encoded slug", () => {
    expect(wikiHref("SEE", { kind: "page", slug: "concepts/transformer" })).toBe(
      "/SEE/llm-wiki#concepts%2Ftransformer",
    );
  });

  it("builds a folder URL with the @ sentinel", () => {
    expect(wikiHref("SEE", { kind: "folder", folder: "concepts" })).toBe(
      "/SEE/llm-wiki#@concepts",
    );
  });

  it("builds a search URL with q query param", () => {
    expect(wikiHref("SEE", { kind: "search", query: "attention is all" })).toBe(
      "/SEE/llm-wiki?q=attention%20is%20all",
    );
  });

  it("builds the setup URL", () => {
    expect(wikiHref("SEE", { kind: "setup" })).toBe(
      "/SEE/llm-wiki?view=setup",
    );
  });

  it("encodes unicode and special characters in slugs and folders and queries", () => {
    expect(wikiHref("SEE", { kind: "page", slug: "café/münster" })).toBe(
      "/SEE/llm-wiki#caf%C3%A9%2Fm%C3%BCnster",
    );
    expect(wikiHref("SEE", { kind: "folder", folder: "a b" })).toBe(
      "/SEE/llm-wiki#@a%20b",
    );
    expect(wikiHref("SEE", { kind: "search", query: "a&b=c" })).toBe(
      "/SEE/llm-wiki?q=a%26b%3Dc",
    );
  });
});

describe("parseWikiLocation", () => {
  beforeEach(() => {
    setLocation("/SEE/llm-wiki", "", "");
  });

  it("returns landing for empty hash and no query", () => {
    setLocation("/SEE/llm-wiki", "", "");
    expect(parseWikiLocation()).toEqual({ kind: "landing" });
  });

  it("returns setup when ?view=setup is present, regardless of hash", () => {
    setLocation("/SEE/llm-wiki", "?view=setup", "");
    expect(parseWikiLocation()).toEqual({ kind: "setup" });
    setLocation("/SEE/llm-wiki", "?view=setup", "#concepts/transformer");
    expect(parseWikiLocation()).toEqual({ kind: "setup" });
  });

  it("returns folder for hash starting with @", () => {
    setLocation("/SEE/llm-wiki", "", "#@concepts");
    expect(parseWikiLocation()).toEqual({ kind: "folder", folder: "concepts" });
  });

  it("decodes folder names with %-encoding", () => {
    setLocation("/SEE/llm-wiki", "", "#@a%20b");
    expect(parseWikiLocation()).toEqual({ kind: "folder", folder: "a b" });
  });

  it("returns page for non-empty, non-@ hash", () => {
    setLocation("/SEE/llm-wiki", "", "#concepts%2Ftransformer");
    expect(parseWikiLocation()).toEqual({
      kind: "page",
      slug: "concepts/transformer",
    });
  });

  it("returns search when q is present, with optional slug for split-pane", () => {
    setLocation("/SEE/llm-wiki", "?q=attention", "");
    expect(parseWikiLocation()).toEqual({
      kind: "search",
      query: "attention",
      slug: null,
    });
    setLocation(
      "/SEE/llm-wiki",
      "?q=attention",
      "#concepts%2Ftransformer",
    );
    expect(parseWikiLocation()).toEqual({
      kind: "search",
      query: "attention",
      slug: "concepts/transformer",
    });
  });

  it("ignores the @ folder hash when in search mode (query takes precedence)", () => {
    setLocation("/SEE/llm-wiki", "?q=x", "#@concepts");
    expect(parseWikiLocation()).toEqual({
      kind: "search",
      query: "x",
      slug: null,
    });
  });

  it("treats empty q as no search", () => {
    setLocation("/SEE/llm-wiki", "?q=", "#concepts");
    expect(parseWikiLocation()).toEqual({ kind: "page", slug: "concepts" });
  });

  it("ignores unrelated query params", () => {
    setLocation("/SEE/llm-wiki", "?utm=x", "#concepts");
    expect(parseWikiLocation()).toEqual({ kind: "page", slug: "concepts" });
  });
});
