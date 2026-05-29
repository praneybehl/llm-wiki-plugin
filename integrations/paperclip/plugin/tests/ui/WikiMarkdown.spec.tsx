// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { WikiMarkdown } from "../../src/ui/WikiMarkdown.js";

/**
 * The shared markdown pipeline. Both the page reader (WikiPageView)
 * and the landing-view index renderer go through it, so wikilinks
 * resolve to real URLs in BOTH places.
 */

describe("WikiMarkdown", () => {
  it("rewrites [[wikilinks]] to /{prefix}/llm-wiki#{slug} anchors", () => {
    const { container } = render(
      <WikiMarkdown
        body="See [[transformer]] and [[concepts/attention|attention]]."
        companyPrefix="SEE"
      />,
    );
    const t = container.querySelector("a[data-wiki-slug='transformer']");
    expect(t?.getAttribute("href")).toBe("/SEE/llm-wiki#transformer");
    const a = container.querySelector("a[data-wiki-slug='concepts/attention']");
    expect(a?.getAttribute("href")).toBe(
      "/SEE/llm-wiki#concepts%2Fattention",
    );
    expect(a?.textContent).toBe("attention");
  });

  it("renders headings with stable ids via rehype-slug", () => {
    const { container } = render(
      <WikiMarkdown body="## Hello World" companyPrefix="SEE" />,
    );
    expect(container.querySelector("h2#hello-world")).not.toBeNull();
  });

  it("highlights fenced code blocks via rehype-highlight", () => {
    const { container } = render(
      <WikiMarkdown body={"```python\nx = 1\n```"} companyPrefix="SEE" />,
    );
    const cls = container.querySelector("pre code")?.getAttribute("class") ?? "";
    expect(cls).toContain("hljs");
    expect(cls).toContain("language-python");
  });

  it("opens external links in a new tab", () => {
    const { container } = render(
      <WikiMarkdown body="[arxiv](https://arxiv.org/abs/1706.03762)" companyPrefix="SEE" />,
    );
    const link = container.querySelector(
      "a[href='https://arxiv.org/abs/1706.03762']",
    );
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noopener");
  });
});
