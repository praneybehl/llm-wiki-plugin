// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  usePluginData: vi.fn(),
  useHostContext: vi.fn(),
}));

import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import { Reader } from "../../src/ui/page/Reader.js";

const ctx = {
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

describe("Reader landing view — index.md rendering", () => {
  it("rewrites [[wikilinks]] inside the rendered index.md body", () => {
    vi.mocked(usePluginData).mockImplementation((provider: string) => {
      if (provider === "loadIndex") {
        return dataResult({
          index:
            "# Wiki\n\nStart with [[transformer]] or browse [[concepts/attention|attention]].",
          shards: [],
          pages: [],
        }) as never;
      }
      return dataResult(null) as never;
    });
    const { container } = render(
      <Reader
        context={ctx}
        location={{ kind: "landing" }}
        onPageLoaded={() => {}}
      />,
    );
    const t = container.querySelector("a[data-wiki-slug='transformer']");
    expect(t?.getAttribute("href")).toBe("/SEE/llm-wiki#transformer");
    const a = container.querySelector("a[data-wiki-slug='concepts/attention']");
    expect(a?.getAttribute("href")).toBe(
      "/SEE/llm-wiki#concepts%2Fattention",
    );
  });
});
