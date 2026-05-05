// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { FolderTree, buildTree } from "../../src/ui/page/FolderTree.js";

const pages = [
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
  {
    slug: "entities/karpathy",
    title: "Andrej Karpathy",
    type: "entity",
    relPath: "entities/karpathy.md",
  },
  {
    slug: "synthesis/2026/q1-review",
    title: "Q1 Review",
    type: "synthesis",
    relPath: "synthesis/2026/q1-review.md",
  },
  { slug: "log", title: "Log", type: "log", relPath: "log.md" },
  { slug: "SCHEMA", title: "Schema", type: "schema", relPath: "SCHEMA.md" },
];

describe("buildTree", () => {
  it("groups pages into folders and root files", () => {
    const tree = buildTree(pages);
    expect(tree.kind).toBe("folder");
    expect(tree.kind === "folder" && tree.name).toBe("");
    if (tree.kind !== "folder") return;
    const childNames = tree.children.map((c) =>
      c.kind === "folder" ? `[${c.name}]` : c.title,
    );
    // Folders first (alphabetical), then root files (alphabetical by title).
    expect(childNames).toEqual([
      "[concepts]",
      "[entities]",
      "[synthesis]",
      "Log",
      "Schema",
    ]);
  });

  it("nests deeper folders correctly", () => {
    const tree = buildTree(pages);
    if (tree.kind !== "folder") throw new Error("expected folder");
    const synthesis = tree.children.find(
      (c) => c.kind === "folder" && c.name === "synthesis",
    );
    if (!synthesis || synthesis.kind !== "folder") {
      throw new Error("expected synthesis folder");
    }
    const q1 = synthesis.children[0];
    if (!q1 || q1.kind !== "folder" || q1.name !== "2026") {
      throw new Error("expected nested 2026 folder");
    }
    expect(q1.children.length).toBe(1);
    expect(
      q1.children[0]?.kind === "page" ? q1.children[0].title : null,
    ).toBe("Q1 Review");
  });
});

describe("FolderTree component", () => {
  it("renders top-level folders and root pages", () => {
    const { container, getByText } = render(
      <FolderTree
        pages={pages}
        companyPrefix="SEE"
        currentSlug={null}
      />,
    );
    expect(getByText("concepts")).toBeDefined();
    expect(getByText("entities")).toBeDefined();
    expect(getByText("Log")).toBeDefined();
    expect(getByText("Schema")).toBeDefined();
    // Initially-collapsed folders hide their children (no Transformer leaf).
    expect(container.querySelector("a[data-wiki-slug='concepts/transformer']"))
      .toBeNull();
  });

  it("auto-expands the folder containing the current slug", () => {
    const { container, getByText } = render(
      <FolderTree
        pages={pages}
        companyPrefix="SEE"
        currentSlug="concepts/transformer"
      />,
    );
    expect(getByText("Transformer")).toBeDefined();
    const link = container.querySelector(
      "a[data-wiki-slug='concepts/transformer']",
    );
    expect(link?.getAttribute("href")).toBe(
      "/SEE/llm-wiki#concepts%2Ftransformer",
    );
  });

  it("toggles folder expansion when the folder header is clicked", () => {
    const { container, getByText } = render(
      <FolderTree pages={pages} companyPrefix="SEE" currentSlug={null} />,
    );
    expect(
      container.querySelector("a[data-wiki-slug='concepts/transformer']"),
    ).toBeNull();
    fireEvent.click(getByText("concepts"));
    expect(
      container.querySelector("a[data-wiki-slug='concepts/transformer']"),
    ).not.toBeNull();
    fireEvent.click(getByText("concepts"));
    expect(
      container.querySelector("a[data-wiki-slug='concepts/transformer']"),
    ).toBeNull();
  });

  it("collapses an auto-expanded folder on the first click of its header", () => {
    // Regression: previously the user-toggle map had no entry for an
    // auto-expanded folder, so clicking it kept the folder open instead
    // of closing it.
    const { container, getByText } = render(
      <FolderTree
        pages={pages}
        companyPrefix="SEE"
        currentSlug="concepts/transformer"
      />,
    );
    expect(
      container.querySelector("a[data-wiki-slug='concepts/transformer']"),
    ).not.toBeNull();
    fireEvent.click(getByText("concepts"));
    expect(
      container.querySelector("a[data-wiki-slug='concepts/transformer']"),
    ).toBeNull();
  });

  it("highlights the current page leaf with aria-current=page", () => {
    const { container } = render(
      <FolderTree
        pages={pages}
        companyPrefix="SEE"
        currentSlug="concepts/transformer"
      />,
    );
    const current = container.querySelector("a[aria-current='page']");
    expect(current?.getAttribute("data-wiki-slug")).toBe(
      "concepts/transformer",
    );
  });

  it("renders root file leaves with the wikiHref helper", () => {
    const { container } = render(
      <FolderTree pages={pages} companyPrefix="SEE" currentSlug={null} />,
    );
    const log = container.querySelector("a[data-wiki-slug='log']");
    expect(log?.getAttribute("href")).toBe("/SEE/llm-wiki#log");
  });

  it("filters tree by titleFilter substring (case-insensitive)", () => {
    const { container, getByText, queryByText } = render(
      <FolderTree
        pages={pages}
        companyPrefix="SEE"
        currentSlug={null}
        titleFilter="kar"
      />,
    );
    // "Andrej Karpathy" matches; nothing else does.
    expect(getByText("Andrej Karpathy")).toBeDefined();
    expect(queryByText("Transformer")).toBeNull();
    expect(queryByText("Log")).toBeNull();
    // The filter auto-expands containing folders so the leaf is visible.
    expect(
      container.querySelector("a[data-wiki-slug='entities/karpathy']"),
    ).not.toBeNull();
  });
});
