// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { WikiPageView } from "../../src/ui/WikiPageView.js";

/**
 * Renders a single wiki page's body as markdown. The most subtle bit is
 * `[[wikilink]]` handling: links must navigate within the plugin's
 * surfaces (data-slug attribute, internal href scheme) — not as external
 * `<a href>` tags pointing somewhere unsafe.
 */

describe("WikiPageView — markdown rendering", () => {
  it("renders the page title from frontmatter as the document heading", () => {
    render(
      <WikiPageView
        page={{
          slug: "transformer",
          meta: { title: "Transformer", type: "entity" },
          body: "Body content here.",
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: /Transformer/i })).toBeDefined();
  });

  it("renders standard markdown (paragraphs, headings)", () => {
    render(
      <WikiPageView
        page={{
          slug: "x",
          meta: { title: "X", type: "concept" },
          body: "## Subheading\n\nA paragraph.",
        }}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: /Subheading/i })).toBeDefined();
    expect(screen.getByText(/A paragraph/)).toBeDefined();
  });

  it("renders GFM tables via remark-gfm", () => {
    render(
      <WikiPageView
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

  it("converts [[slug]] to an internal link with data-slug", () => {
    const { container } = render(
      <WikiPageView
        page={{
          slug: "transformer",
          meta: { title: "T", type: "entity" },
          body: "see [[attention-paper]] for context",
        }}
      />,
    );
    const link = container.querySelector("a[data-wiki-slug]");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("data-wiki-slug")).toBe("attention-paper");
  });

  it("converts [[slug|display]] to an internal link with the display text", () => {
    const { container } = render(
      <WikiPageView
        page={{
          slug: "x",
          meta: { title: "X", type: "concept" },
          body: "see [[attention-paper|the attention paper]]",
        }}
      />,
    );
    const link = container.querySelector("a[data-wiki-slug]");
    expect(link?.getAttribute("data-wiki-slug")).toBe("attention-paper");
    expect(link?.textContent).toBe("the attention paper");
  });

  it("invokes onWikilinkClick instead of navigating, when supplied", () => {
    const onClick = vi.fn();
    const { container } = render(
      <WikiPageView
        page={{
          slug: "x",
          meta: { title: "X", type: "concept" },
          body: "see [[gpt-3]]",
        }}
        onWikilinkClick={onClick}
      />,
    );
    const link = container.querySelector(
      "a[data-wiki-slug='gpt-3']",
    ) as HTMLAnchorElement;
    link.click();
    expect(onClick).toHaveBeenCalledWith("gpt-3");
  });

  it("renders external links as standard <a href> with no data-wiki-slug", () => {
    const { container } = render(
      <WikiPageView
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
  });

  it("falls back to slug as heading when meta.title is missing", () => {
    render(
      <WikiPageView
        page={{
          slug: "raw-slug",
          meta: {},
          body: "body",
        }}
      />,
    );
    // The heading should at least contain the slug as a usable label.
    const heading = screen.queryByRole("heading", { name: /raw-slug/i });
    expect(heading).not.toBeNull();
  });

  it("renders a frontmatter type badge", () => {
    const { container } = render(
      <WikiPageView
        page={{
          slug: "x",
          meta: { title: "X", type: "concept" },
          body: "body",
        }}
      />,
    );
    // Implementation surfaces meta.type as text somewhere in the chrome.
    expect(within(container as HTMLElement).getByText(/concept/i)).toBeDefined();
  });

  it("does not crash on an empty body", () => {
    const { container } = render(
      <WikiPageView
        page={{ slug: "x", meta: { title: "X", type: "concept" }, body: "" }}
      />,
    );
    expect(container.querySelector("article")).not.toBeNull();
  });
});
