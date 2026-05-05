// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  usePluginData: vi.fn(),
}));

import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import { SetupView } from "../../src/ui/setup/SetupView.js";

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

describe("SetupView", () => {
  it("renders the four checklist steps", () => {
    vi.mocked(usePluginData).mockReturnValue(
      dataResult({
        wiki: { found: true, path: "/wiki", pageCount: 42 },
        tool: { registered: true },
        sample: { query: "test", resultCount: 5, durationMs: 12 },
      }) as never,
    );
    const { container } = render(<SetupView context={ctx} />);
    const steps = container.querySelectorAll(".llm-wiki-setup-step");
    expect(steps.length).toBeGreaterThanOrEqual(5);
  });

  it("shows the wiki-found state when verifySetup reports found=true", () => {
    vi.mocked(usePluginData).mockReturnValue(
      dataResult({
        wiki: { found: true, path: "/Users/x/wiki", pageCount: 13 },
        tool: { registered: true },
        sample: { query: "test", resultCount: 3, durationMs: 8 },
      }) as never,
    );
    const { container } = render(<SetupView context={ctx} />);
    expect(container.textContent).toContain("/Users/x/wiki");
    expect(container.textContent).toContain("13 pages");
  });

  it("shows init guidance when the wiki is missing", () => {
    vi.mocked(usePluginData).mockReturnValue(
      dataResult({
        wiki: { found: false, path: null, pageCount: 0 },
        tool: { registered: true },
        sample: { query: "test", resultCount: 0, durationMs: 0 },
      }) as never,
    );
    const { container } = render(<SetupView context={ctx} />);
    expect(container.textContent).toContain("/wiki:init");
  });

  it("renders a copy block per adapter and one for the heartbeat stanza", () => {
    vi.mocked(usePluginData).mockReturnValue(
      dataResult({
        wiki: { found: true, path: "/wiki", pageCount: 1 },
        tool: { registered: true },
        sample: { query: "test", resultCount: 1, durationMs: 5 },
      }) as never,
    );
    const { container } = render(<SetupView context={ctx} />);
    // One per adapter (id values from snippets.ts).
    expect(
      container.querySelector("[data-testid='wiki-setup-install-claude-code']"),
    ).not.toBeNull();
    expect(
      container.querySelector("[data-testid='wiki-setup-install-codex']"),
    ).not.toBeNull();
    // The heartbeat stanza.
    expect(
      container.querySelector("[data-testid='wiki-setup-stanza']"),
    ).not.toBeNull();
    // The HTTP-only system-prompt suggestion.
    expect(
      container.querySelector("[data-testid='wiki-setup-http-prompt']"),
    ).not.toBeNull();
  });
});
