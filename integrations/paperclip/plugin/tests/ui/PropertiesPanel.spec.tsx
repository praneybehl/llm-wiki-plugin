// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, within } from "@testing-library/react";
import { PropertiesPanel } from "../../src/ui/page/PropertiesPanel.js";

describe("PropertiesPanel", () => {
  it("renders nothing visible when there are no displayable properties", () => {
    const { container } = render(<PropertiesPanel meta={{}} />);
    // Component should render the section but mark it empty.
    expect(container.querySelector(".llm-wiki-properties-empty")).not.toBeNull();
  });

  it("renders frontmatter strings as definition-list pairs", () => {
    const { container } = render(
      <PropertiesPanel
        meta={{ type: "concept", status: "stable", updated: "2026-01-12" }}
      />,
    );
    const dl = container.querySelector(".llm-wiki-properties dl");
    expect(dl).not.toBeNull();
    const dts = within(dl as HTMLElement).getAllByRole("term");
    const dds = within(dl as HTMLElement).getAllByRole("definition");
    const pairs = dts.map((dt, i) => [
      dt.textContent,
      dds[i]?.textContent,
    ]);
    // Sorted by key alphabetical for predictability.
    expect(pairs).toEqual([
      ["status", "stable"],
      ["type", "concept"],
      ["updated", "2026-01-12"],
    ]);
  });

  it("joins string-array values with commas", () => {
    const { container } = render(
      <PropertiesPanel meta={{ tags: ["ml", "nlp", "transformers"] }} />,
    );
    const dd = container.querySelector("dd");
    expect(dd?.textContent).toBe("ml, nlp, transformers");
  });

  it("hides the title field (already shown as the page heading)", () => {
    const { container } = render(
      <PropertiesPanel meta={{ title: "Hidden", type: "concept" }} />,
    );
    expect(container.textContent).not.toContain("title");
    expect(container.textContent).not.toContain("Hidden");
  });

  it("ignores nested object values (not useful in a key/value list)", () => {
    const { container } = render(
      <PropertiesPanel
        meta={{
          type: "concept",
          embedding: { vec: [0.1, 0.2, 0.3] },
        }}
      />,
    );
    expect(container.textContent).not.toContain("embedding");
  });
});
