// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { OutlinePanel } from "../../src/ui/page/OutlinePanel.js";

describe("OutlinePanel", () => {
  it("renders an empty state when no headings are passed", () => {
    const { container } = render(<OutlinePanel headings={[]} />);
    expect(container.querySelector(".llm-wiki-outline-empty")).not.toBeNull();
  });

  it("renders headings as anchor links to in-page #ids", () => {
    const { container } = render(
      <OutlinePanel
        headings={[
          { level: 2, text: "Overview", id: "overview" },
          { level: 2, text: "History", id: "history" },
          { level: 3, text: "Encoder", id: "encoder" },
        ]}
      />,
    );
    const links = container.querySelectorAll("a");
    expect(links.length).toBe(3);
    expect(links[0]?.getAttribute("href")).toBe("#overview");
    expect(links[0]?.textContent).toBe("Overview");
    expect(links[2]?.getAttribute("href")).toBe("#encoder");
  });

  it("indents nested headings via data-level attribute", () => {
    const { container } = render(
      <OutlinePanel
        headings={[
          { level: 2, text: "A", id: "a" },
          { level: 3, text: "B", id: "b" },
          { level: 2, text: "C", id: "c" },
        ]}
      />,
    );
    const items = container.querySelectorAll("li[data-level]");
    expect(items[0]?.getAttribute("data-level")).toBe("2");
    expect(items[1]?.getAttribute("data-level")).toBe("3");
    expect(items[2]?.getAttribute("data-level")).toBe("2");
  });
});
