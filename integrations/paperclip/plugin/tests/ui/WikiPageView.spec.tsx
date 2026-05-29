// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { WikiPageView } from "../../src/ui/WikiPageView.js";

/**
 * Renders a single wiki page's body as markdown.
 *
 * v0.4 contract: wikilinks become real `<a href="/{prefix}/llm-wiki#slug">`
 * anchors, headings get stable ids (rehype-slug) and hover anchors
 * (rehype-autolink-headings), and code blocks get hljs classes
 * (rehype-highlight). The `onWikilinkClick` callback path from v0.3 is
 * removed — the URL is the source of truth for navigation.
 */

describe("WikiPageView — markdown rendering", () => {
  it("renders the page title from frontmatter as the document heading", () => {
    render(
      <WikiPageView
        companyPrefix="SEE"
        page={{
          slug: "transformer",
          meta: { title: "Transformer", type: "entity" },
          body: "Body content here.",
        }}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /Transformer/i }),
    ).toBeDefined();
  });

  it("renders standard markdown (paragraphs, headings)", () => {
    render(
      <WikiPageView
        companyPrefix="SEE"
        page={{
          slug: "x",
          meta: { title: "X", type: "concept" },
          body: "## Subheading\n\nA paragraph.",
        }}
      />,
    );
    expect(
      screen.getByRole("heading", { level: 2, name: /Subheading/i }),
    ).toBeDefined();
    expect(screen.getByText(/A paragraph/)).toBeDefined();
  });

  it("renders GFM tables via remark-gfm", () => {
    render(
      <WikiPageView
        companyPrefix="SEE"
        page={{
          slug: "x",
          meta: { title: "X", type: "concept" },
          body: `| col-a | col-b |
|-------|-------|
| one   | two   |`,
        }}
      />,
    );
    expect(screen.getByRole("table")).toBeDefined();
    expect(screen.getByText("col-a")).toBeDefined();
    expect(screen.getByText("two")).toBeDefined();
  });

  it("converts [[slug]] to a real anchor with /{prefix}/llm-wiki# href", () => {
    const { container } = render(
      <WikiPageView
        companyPrefix="SEE"
        page={{
          slug: "transformer",
          meta: { title: "T", type: "entity" },
          body: "see [[attention-paper]] for context",
        }}
      />,
    );
    const link = container.querySelector("a[data-wiki-slug='attention-paper']");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe(
      "/SEE/llm-wiki#attention-paper",
    );
  });

  it("encodes slugs containing slashes in the wikilink href", () => {
    const { container } = render(
      <WikiPageView
        companyPrefix="SEE"
        page={{
          slug: "transformer",
          meta: { title: "T", type: "entity" },
          body: "see [[concepts/attention]]",
        }}
      />,
    );
    const link = container.querySelector(
      "a[data-wiki-slug='concepts/attention']",
    );
    expect(link?.getAttribute("href")).toBe(
      "/SEE/llm-wiki#concepts%2Fattention",
    );
  });

  it("converts [[slug|display]] to a real anchor with the display text", () => {
    const { container } = render(
      <WikiPageView
        companyPrefix="SEE"
        page={{
          slug: "x",
          meta: { title: "X", type: "concept" },
          body: "see [[attention-paper|the attention paper]]",
        }}
      />,
    );
    const link = container.querySelector(
      "a[data-wiki-slug='attention-paper']",
    );
    expect(link?.textContent).toBe("the attention paper");
    expect(link?.getAttribute("href")).toBe("/SEE/llm-wiki#attention-paper");
  });

  it("renders external links as <a target=_blank> with rel=noopener noreferrer and no data-wiki-slug", () => {
    const { container } = render(
      <WikiPageView
        companyPrefix="SEE"
        page={{
          slug: "x",
          meta: { title: "X", type: "concept" },
          body: "see [arxiv](https://arxiv.org/abs/1706.03762)",
        }}
      />,
    );
    const link = container.querySelector(
      "a[href='https://arxiv.org/abs/1706.03762']",
    );
    expect(link).not.toBeNull();
    expect(link?.getAttribute("data-wiki-slug")).toBeNull();
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noopener");
  });

  it("falls back to slug as heading when meta.title is missing", () => {
    render(
      <WikiPageView
        companyPrefix="SEE"
        page={{ slug: "raw-slug", meta: {}, body: "body" }}
      />,
    );
    const heading = screen.queryByRole("heading", { name: /raw-slug/i });
    expect(heading).not.toBeNull();
  });

  it("renders a frontmatter type badge", () => {
    const { container } = render(
      <WikiPageView
        companyPrefix="SEE"
        page={{
          slug: "x",
          meta: { title: "X", type: "concept" },
          body: "body",
        }}
      />,
    );
    expect(
      within(container as HTMLElement).getByText(/concept/i),
    ).toBeDefined();
  });

  it("does not crash on an empty body", () => {
    const { container } = render(
      <WikiPageView
        companyPrefix="SEE"
        page={{
          slug: "x",
          meta: { title: "X", type: "concept" },
          body: "",
        }}
      />,
    );
    expect(container.querySelector("article")).not.toBeNull();
  });

  it("falls back to '#' for wikilinks when companyPrefix is null", () => {
    const { container } = render(
      <WikiPageView
        companyPrefix={null}
        page={{
          slug: "x",
          meta: { title: "X", type: "concept" },
          body: "see [[other]]",
        }}
      />,
    );
    const link = container.querySelector("a[data-wiki-slug='other']");
    expect(link?.getAttribute("href")).toBe("#");
  });
});

describe("WikiPageView — rehype pipeline", () => {
  it("assigns stable ids to headings via rehype-slug", () => {
    const { container } = render(
      <WikiPageView
        companyPrefix="SEE"
        page={{
          slug: "x",
          meta: { title: "X", type: "concept" },
          body: "## Hello World\n\n## Hello world",
        }}
      />,
    );
    const h2s = container.querySelectorAll("h2");
    expect(h2s[0]?.getAttribute("id")).toBe("hello-world");
    // rehype-slug appends -1, -2, ... on collisions to keep ids unique.
    expect(h2s[1]?.getAttribute("id")).toBe("hello-world-1");
  });

  it("renders an autolink anchor inside each heading via rehype-autolink-headings", () => {
    const { container } = render(
      <WikiPageView
        companyPrefix="SEE"
        page={{
          slug: "x",
          meta: { title: "X", type: "concept" },
          body: "## Linkable",
        }}
      />,
    );
    const h2 = container.querySelector("h2#linkable");
    expect(h2).not.toBeNull();
    const anchor = h2?.querySelector("a[href='#linkable']");
    expect(anchor).not.toBeNull();
  });

  it("adds hljs language classes to fenced code blocks via rehype-highlight", () => {
    const { container } = render(
      <WikiPageView
        companyPrefix="SEE"
        page={{
          slug: "x",
          meta: { title: "X", type: "concept" },
          body: "```python\nx = 1\n```",
        }}
      />,
    );
    const code = container.querySelector("pre code");
    expect(code).not.toBeNull();
    const cls = code?.getAttribute("class") ?? "";
    expect(cls).toContain("hljs");
    expect(cls).toContain("language-python");
  });
});
