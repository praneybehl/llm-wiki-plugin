// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  usePluginData: vi.fn(),
  useHostContext: vi.fn(),
}));

import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import { Reader } from "../../src/ui/page/Reader.js";
import type { WikiLocation } from "../../src/ui/href.js";

const baseContext = {
  companyId: "c1",
  companyPrefix: "SEE",
  projectId: "p1",
  entityId: null,
  entityType: null,
  parentEntityId: null,
  userId: "u1",
};

function dataResult<T>(data: T) {
  return { data, loading: false, error: null, refresh: vi.fn() };
}

beforeEach(() => {
  vi.mocked(usePluginData).mockReset();
});

function setupIndexAndPage() {
  vi.mocked(usePluginData).mockImplementation((provider: string) => {
    if (provider === "loadIndex") {
      return dataResult({
        index: "# Wiki index\n\nWelcome.",
        shards: [],
        pages: [
          {
            slug: "concepts/transformer",
            title: "Transformer",
            type: "concept",
            relPath: "concepts/transformer.md",
          },
          {
            slug: "concepts/attention",
            title: "Attention",
            type: "concept",
            relPath: "concepts/attention.md",
          },
        ],
      }) as never;
    }
    if (provider === "readPage") {
      return dataResult({
        slug: "concepts/transformer",
        meta: { title: "Transformer", type: "concept" },
        body: "## Overview\n\nThe transformer …",
      }) as never;
    }
    if (provider === "searchWiki") {
      return dataResult({
        results: [
          {
            slug: "concepts/transformer",
            title: "Transformer",
            type: "concept",
            score: 1.5,
            heading: "Transformer > Architecture",
          },
        ],
      }) as never;
    }
    return dataResult(null) as never;
  });
}

describe("Reader dispatch", () => {
  it("renders the index.md body for the landing view", () => {
    setupIndexAndPage();
    const location: WikiLocation = { kind: "landing" };
    const { container, getByText } = render(
      <Reader context={baseContext} location={location} onPageLoaded={() => {}} />,
    );
    expect(container.querySelector(".llm-wiki-landing")).not.toBeNull();
    expect(getByText("Welcome.")).toBeDefined();
  });

  it("renders a folder view listing matching pages", () => {
    setupIndexAndPage();
    const location: WikiLocation = { kind: "folder", folder: "concepts" };
    const { container, getByText } = render(
      <Reader context={baseContext} location={location} onPageLoaded={() => {}} />,
    );
    expect(container.querySelector(".llm-wiki-folder-view")).not.toBeNull();
    expect(getByText("Transformer")).toBeDefined();
    expect(getByText("Attention")).toBeDefined();
    const link = container.querySelector(
      "a[data-wiki-slug='concepts/transformer']",
    );
    expect(link?.getAttribute("href")).toBe(
      "/SEE/llm-wiki#concepts%2Ftransformer",
    );
  });

  it("renders the WikiPageView for a page view", () => {
    setupIndexAndPage();
    const location: WikiLocation = {
      kind: "page",
      slug: "concepts/transformer",
    };
    const { container, getByRole } = render(
      <Reader context={baseContext} location={location} onPageLoaded={() => {}} />,
    );
    expect(container.querySelector("article.llm-wiki-page")).not.toBeNull();
    expect(getByRole("heading", { name: /Transformer/i })).toBeDefined();
  });

  it("renders ranked search results for a search view", () => {
    setupIndexAndPage();
    const location: WikiLocation = {
      kind: "search",
      query: "transformer",
      slug: null,
    };
    const { container, getByText } = render(
      <Reader context={baseContext} location={location} onPageLoaded={() => {}} />,
    );
    expect(container.querySelector(".llm-wiki-search-view")).not.toBeNull();
    expect(getByText("Transformer")).toBeDefined();
    expect(getByText("Transformer > Architecture")).toBeDefined();
    const link = container.querySelector(
      "a[data-wiki-slug='concepts/transformer']",
    );
    expect(link?.getAttribute("href")).toBe(
      "/SEE/llm-wiki#concepts%2Ftransformer",
    );
  });

  it("renders a Setup placeholder for the setup view (full impl in Phase H)", () => {
    setupIndexAndPage();
    const location: WikiLocation = { kind: "setup" };
    const { container } = render(
      <Reader context={baseContext} location={location} onPageLoaded={() => {}} />,
    );
    expect(container.querySelector(".llm-wiki-setup")).not.toBeNull();
  });

  it("invokes onPageLoaded with meta + extracted headings when a page renders", async () => {
    setupIndexAndPage();
    const onPageLoaded = vi.fn();
    const location: WikiLocation = {
      kind: "page",
      slug: "concepts/transformer",
    };
    render(
      <Reader
        context={baseContext}
        location={location}
        onPageLoaded={onPageLoaded}
      />,
    );
    // The Reader extracts headings via a useEffect after the article mounts;
    // wait one microtask tick.
    await Promise.resolve();
    await Promise.resolve();
    expect(onPageLoaded).toHaveBeenCalled();
    const lastCall = onPageLoaded.mock.calls[onPageLoaded.mock.calls.length - 1];
    expect(lastCall?.[0]).toEqual(
      expect.objectContaining({
        meta: expect.objectContaining({ title: "Transformer" }),
        headings: expect.arrayContaining([
          expect.objectContaining({ text: "Overview", level: 2 }),
        ]),
      }),
    );
  });
});
