// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  usePluginData: vi.fn(),
}));

import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import { WikiContextTab } from "../../src/ui/WikiContextTab.js";

const ctx = {
  companyId: "c1",
  companyPrefix: "SEE",
  projectId: "p1",
  entityId: "issue-99",
  entityType: "issue" as const,
  parentEntityId: null,
  userId: "u1",
};

function dataResult<T>(data: T) {
  return { data, loading: false, error: null, refresh: vi.fn() };
}

beforeEach(() => {
  vi.mocked(usePluginData).mockReset();
});

describe("WikiContextTab — links resolve to the wiki workspace", () => {
  it("each result anchors to /{prefix}/llm-wiki#slug, not to a fake hash", () => {
    vi.mocked(usePluginData).mockReturnValue(
      dataResult({
        results: [
          {
            slug: "concepts/transformer",
            title: "Transformer",
            type: "concept",
            score: 1,
          },
          {
            slug: "entities/karpathy",
            title: "Andrej Karpathy",
            type: "entity",
            score: 0.5,
          },
        ],
      }) as never,
    );
    const { container } = render(<WikiContextTab context={ctx} />);
    const first = container.querySelector(
      "a[data-wiki-slug='concepts/transformer']",
    );
    expect(first?.getAttribute("href")).toBe(
      "/SEE/llm-wiki#concepts%2Ftransformer",
    );
    const second = container.querySelector(
      "a[data-wiki-slug='entities/karpathy']",
    );
    expect(second?.getAttribute("href")).toBe(
      "/SEE/llm-wiki#entities%2Fkarpathy",
    );
  });
});
