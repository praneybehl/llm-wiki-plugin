// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  usePluginData: vi.fn(),
  useHostContext: vi.fn(),
  usePluginAction: vi.fn(),
}));

import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import { WikiHealthIndicator } from "../../src/ui/WikiHealthIndicator.js";

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
  window.sessionStorage.clear();
});

const baseHealth = {
  pageCount: 7,
  indexLines: 0,
  linkDensity: 1.5,
  scalingMessages: [],
  lintFindings: { totalPages: 7 },
  wikiPathMissing: false,
  lintCheckIntervalMinutes: 60,
};

describe("WikiHealthIndicator setup status banner", () => {
  it("shows '4/4 ✅ Setup complete' with a Dismiss button when all checks pass", () => {
    vi.mocked(usePluginData).mockReturnValue(
      dataResult({ ...baseHealth, lintStatus: "pass" as const }) as never,
    );
    const { container } = render(<WikiHealthIndicator context={ctx} />);
    const badge = container.querySelector(
      "[data-testid='wiki-health-setup-badge']",
    );
    expect(badge?.textContent).toMatch(/Setup complete/);
    expect(
      container.querySelector("[data-testid='wiki-health-setup-dismiss']"),
    ).not.toBeNull();
  });

  it("shows '3/4 …' with a link to setup when lint is warn", () => {
    vi.mocked(usePluginData).mockReturnValue(
      dataResult({ ...baseHealth, lintStatus: "warn" as const }) as never,
    );
    const { container } = render(<WikiHealthIndicator context={ctx} />);
    const badge = container.querySelector(
      "[data-testid='wiki-health-setup-badge']",
    );
    expect(badge?.textContent).toMatch(/Setup: 3\/4/);
    const link = container.querySelector(
      "[data-testid='wiki-health-setup-link']",
    );
    expect(link?.getAttribute("href")).toBe("/SEE/llm-wiki?view=setup");
  });

  it("shows '2/4 …' when there are no pages and lint warns", () => {
    vi.mocked(usePluginData).mockReturnValue(
      dataResult({
        ...baseHealth,
        pageCount: 0,
        lintStatus: "warn" as const,
      }) as never,
    );
    const { container } = render(<WikiHealthIndicator context={ctx} />);
    expect(
      container
        .querySelector("[data-testid='wiki-health-setup-badge']")
        ?.textContent,
    ).toMatch(/Setup: 2\/4/);
  });

  it("hides the banner after Dismiss is clicked when complete", () => {
    vi.mocked(usePluginData).mockReturnValue(
      dataResult({ ...baseHealth, lintStatus: "pass" as const }) as never,
    );
    const { container } = render(<WikiHealthIndicator context={ctx} />);
    const dismiss = container.querySelector(
      "[data-testid='wiki-health-setup-dismiss']",
    ) as HTMLButtonElement;
    expect(dismiss).not.toBeNull();
    act(() => {
      fireEvent.click(dismiss);
    });
    expect(
      container.querySelector("[data-testid='wiki-health-setup-banner']"),
    ).toBeNull();
  });

  it("re-shows the banner after dismissal if anything regresses", () => {
    window.sessionStorage.setItem("llm-wiki:setup-dismissed", "1");
    vi.mocked(usePluginData).mockReturnValue(
      dataResult({ ...baseHealth, lintStatus: "fail" as const }) as never,
    );
    const { container } = render(<WikiHealthIndicator context={ctx} />);
    const banner = container.querySelector(
      "[data-testid='wiki-health-setup-banner']",
    );
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toMatch(/Setup: 3\/4/);
  });
});
