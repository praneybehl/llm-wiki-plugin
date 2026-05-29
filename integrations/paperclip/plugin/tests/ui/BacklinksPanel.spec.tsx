// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  usePluginData: vi.fn(),
}));

import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import { BacklinksPanel } from "../../src/ui/page/BacklinksPanel.js";

function dataResult<T>(data: T) {
  return { data, loading: false, error: null, refresh: vi.fn() };
}

beforeEach(() => {
  vi.mocked(usePluginData).mockReset();
});

describe("BacklinksPanel", () => {
  it("renders backlink results as anchor links via wikiHref", () => {
    vi.mocked(usePluginData).mockReturnValue(
      dataResult({
        results: [
          {
            slug: "transformer",
            title: "Transformer",
            type: "entity",
            snippet: "see [[attention-mechanism]]",
          },
          {
            slug: "attention-paper",
            title: "Attention Is All You Need",
            type: "source",
            snippet: "introduces the [[attention-mechanism]]",
          },
        ],
      }) as never,
    );
    const { container } = render(
      <BacklinksPanel
        companyId="c1"
        projectId="p1"
        companyPrefix="SEE"
        slug="attention-mechanism"
      />,
    );
    expect(screen.getByText("Transformer")).toBeDefined();
    const link = container.querySelector("a[data-wiki-slug='transformer']");
    expect(link?.getAttribute("href")).toBe("/SEE/llm-wiki#transformer");
  });

  it("renders an empty state when there are no backlinks", () => {
    vi.mocked(usePluginData).mockReturnValue(
      dataResult({ results: [] }) as never,
    );
    const { container } = render(
      <BacklinksPanel
        companyId="c1"
        projectId="p1"
        companyPrefix="SEE"
        slug="orphan"
      />,
    );
    expect(container.querySelector(".llm-wiki-backlinks-empty")).not.toBeNull();
  });

  it("calls usePluginData with the active slug", () => {
    vi.mocked(usePluginData).mockReturnValue(
      dataResult({ results: [] }) as never,
    );
    render(
      <BacklinksPanel
        companyId="c1"
        projectId="p1"
        companyPrefix="SEE"
        slug="x"
      />,
    );
    expect(usePluginData).toHaveBeenCalledWith(
      "backlinks",
      expect.objectContaining({ slug: "x", companyId: "c1", projectId: "p1" }),
    );
  });
});
