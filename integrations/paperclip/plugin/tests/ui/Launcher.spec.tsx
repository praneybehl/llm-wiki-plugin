// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  usePluginData: vi.fn(),
}));

import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import { Launcher } from "../../src/ui/launcher/Launcher.js";
import { recordRecent } from "../../src/ui/recent.js";

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

const indexPayload = {
  index: "",
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
    {
      slug: "entities/karpathy",
      title: "Andrej Karpathy",
      type: "entity",
      relPath: "entities/karpathy.md",
    },
  ],
};

const healthPayload = {
  pageCount: 3,
  indexLines: 0,
  linkDensity: 1,
  scalingMessages: [],
  lintStatus: "pass" as const,
  lintFindings: { totalPages: 3 },
  wikiPathMissing: false,
  lintCheckIntervalMinutes: 60,
};

beforeEach(() => {
  vi.mocked(usePluginData).mockReset();
  window.sessionStorage.clear();
});

function mockProviders() {
  vi.mocked(usePluginData).mockImplementation((provider: string) => {
    if (provider === "loadIndex") return dataResult(indexPayload) as never;
    if (provider === "wikiHealth") return dataResult(healthPayload) as never;
    return dataResult(null) as never;
  });
}

describe("Launcher (sidebar)", () => {
  it("renders an Open link to the wiki workspace", () => {
    mockProviders();
    const { container } = render(<Launcher context={baseContext} />);
    const open = container.querySelector("a[data-testid='wiki-open']");
    expect(open?.getAttribute("href")).toBe("/SEE/llm-wiki");
  });

  it("submits the search box as ?q=… on the wiki page route", () => {
    mockProviders();
    const { container } = render(<Launcher context={baseContext} />);
    const input = container.querySelector(
      "input[type='search']",
    ) as HTMLInputElement;
    const form = input.closest("form")!;
    act(() => {
      fireEvent.change(input, { target: { value: "transformer" } });
      fireEvent.submit(form);
    });
    expect(window.location.pathname + window.location.search).toBe(
      "/SEE/llm-wiki?q=transformer",
    );
  });

  it("renders a Browse list grouped by frontmatter type with counts", () => {
    mockProviders();
    const { container, getByText } = render(<Launcher context={baseContext} />);
    expect(getByText(/concept/i)).toBeDefined();
    expect(getByText(/entity/i)).toBeDefined();
    // Each entry is an anchor to the folder view.
    const conceptLink = container.querySelector(
      "a[data-testid='wiki-browse-concept']",
    );
    expect(conceptLink?.getAttribute("href")).toBe("/SEE/llm-wiki#@concept");
    const entityLink = container.querySelector(
      "a[data-testid='wiki-browse-entity']",
    );
    expect(entityLink?.getAttribute("href")).toBe("/SEE/llm-wiki#@entity");
  });

  it("renders a Recent list when sessionStorage has entries", () => {
    recordRecent({ slug: "concepts/transformer", title: "Transformer" });
    recordRecent({ slug: "entities/karpathy", title: "Andrej Karpathy" });
    mockProviders();
    const { container, getByText } = render(<Launcher context={baseContext} />);
    expect(getByText("Andrej Karpathy")).toBeDefined();
    const recent = container.querySelector(
      "a[data-wiki-slug='concepts/transformer']",
    );
    expect(recent?.getAttribute("href")).toBe(
      "/SEE/llm-wiki#concepts%2Ftransformer",
    );
  });

  it("refreshes the Recent list when recordRecent fires its event mid-session", () => {
    mockProviders();
    const { queryByText, getByText } = render(<Launcher context={baseContext} />);
    expect(queryByText("Transformer")).toBeNull();
    act(() => {
      recordRecent({ slug: "concepts/transformer", title: "Transformer" });
    });
    expect(getByText("Transformer")).toBeDefined();
  });

  it("renders a 'Set up the wiki' CTA when wikiPathMissing is true", () => {
    vi.mocked(usePluginData).mockImplementation((provider: string) => {
      if (provider === "loadIndex")
        return dataResult({ index: "", shards: [], pages: [] }) as never;
      if (provider === "wikiHealth")
        return dataResult({ ...healthPayload, wikiPathMissing: true }) as never;
      return dataResult(null) as never;
    });
    const { container } = render(<Launcher context={baseContext} />);
    const setup = container.querySelector("a[data-testid='wiki-setup-cta']");
    expect(setup?.getAttribute("href")).toBe("/SEE/llm-wiki?view=setup");
  });

  it("renders a condensed health badge with the page count and lint status", () => {
    mockProviders();
    const { container } = render(<Launcher context={baseContext} />);
    expect(container.textContent).toContain("3");
    expect(container.textContent?.toLowerCase()).toContain("pass");
  });
});
