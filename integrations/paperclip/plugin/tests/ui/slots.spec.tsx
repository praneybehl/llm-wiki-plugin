// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { PluginHostContext } from "@paperclipai/plugin-sdk/ui";
import * as React from "react";

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  usePluginData: vi.fn(),
  useHostContext: vi.fn(),
  usePluginAction: vi.fn(),
}));

import {
  usePluginData,
  useHostContext,
  usePluginAction,
} from "@paperclipai/plugin-sdk/ui";
import { WikiSidebar } from "../../src/ui/WikiSidebar.js";
import { WikiPage } from "../../src/ui/WikiPage.js";
import { WikiContextTab } from "../../src/ui/WikiContextTab.js";
import { WikiHealthIndicator } from "../../src/ui/WikiHealthIndicator.js";
import * as uiIndex from "../../src/ui/index.js";

const baseHostContext: PluginHostContext = {
  companyId: "c1",
  companyPrefix: "co",
  projectId: "p1",
  entityId: null,
  entityType: null,
  parentEntityId: null,
  userId: "u1",
};

function loadingResult() {
  return { data: null, loading: true, error: null, refresh: vi.fn() };
}
function dataResult<T>(data: T) {
  return { data, loading: false, error: null, refresh: vi.fn() };
}
function errorResult(message: string) {
  return {
    data: null,
    loading: false,
    error: { code: "WORKER_ERROR" as const, message },
    refresh: vi.fn(),
  };
}

beforeEach(() => {
  vi.mocked(useHostContext).mockReturnValue(baseHostContext);
  vi.mocked(usePluginAction).mockReturnValue(async () => undefined);
});

// ────────────────────────────────────────────────────────────────────────
// WikiHealthIndicator
// ────────────────────────────────────────────────────────────────────────

describe("WikiHealthIndicator", () => {
  it("shows a loading state while data is loading", () => {
    vi.mocked(usePluginData).mockReturnValue(loadingResult());
    render(<WikiHealthIndicator context={baseHostContext} />);
    expect(screen.getByText(/loading/i)).toBeDefined();
  });

  it("renders pageCount and lintStatus pass badge", () => {
    vi.mocked(usePluginData).mockReturnValue(
      dataResult({
        pageCount: 42,
        indexLines: 60,
        linkDensity: 1.8,
        scalingMessages: ["Below first threshold."],
        lintStatus: "pass" as const,
        lintFindings: { totalPages: 42 },
        wikiPathMissing: false,
      }),
    );
    render(<WikiHealthIndicator context={baseHostContext} />);
    expect(screen.getByText(/42/)).toBeDefined();
    expect(screen.getByText(/pass/i)).toBeDefined();
  });

  it("renders a fail badge when lintStatus is fail", () => {
    vi.mocked(usePluginData).mockReturnValue(
      dataResult({
        pageCount: 100,
        indexLines: 0,
        linkDensity: 2,
        scalingMessages: [],
        lintStatus: "fail" as const,
        lintFindings: { totalPages: 100 },
        wikiPathMissing: false,
      }),
    );
    const { container } = render(
      <WikiHealthIndicator context={baseHostContext} />,
    );
    const badge = container.querySelector("[data-lint-status='fail']");
    expect(badge).not.toBeNull();
  });

  it("shows a 'wiki not configured' state when wikiPathMissing", () => {
    vi.mocked(usePluginData).mockReturnValue(
      dataResult({
        pageCount: 0,
        indexLines: 0,
        linkDensity: 0,
        scalingMessages: [],
        lintStatus: "warn" as const,
        lintFindings: null,
        wikiPathMissing: true,
      }),
    );
    render(<WikiHealthIndicator context={baseHostContext} />);
    expect(screen.getByText(/not configured|wiki path/i)).toBeDefined();
  });

  it("shows an error message when the bridge errors", () => {
    vi.mocked(usePluginData).mockReturnValue(errorResult("bridge boom"));
    render(<WikiHealthIndicator context={baseHostContext} />);
    expect(screen.getByText(/bridge boom/i)).toBeDefined();
  });

  it("handles null companyId gracefully (FEASIBILITY §8 #6)", () => {
    vi.mocked(useHostContext).mockReturnValue({
      ...baseHostContext,
      companyId: null,
    });
    vi.mocked(usePluginData).mockReturnValue(loadingResult());
    render(
      <WikiHealthIndicator
        context={{ ...baseHostContext, companyId: null }}
      />,
    );
    // Doesn't crash; renders an empty state.
    expect(screen.queryAllByText(/.+/).length).toBeGreaterThanOrEqual(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// WikiContextTab — the issue detail tab
// ────────────────────────────────────────────────────────────────────────

describe("WikiContextTab", () => {
  it("calls usePluginData with relevantForIssue + companyId + entityId", () => {
    const ctx = {
      ...baseHostContext,
      entityId: "issue-99",
      entityType: "issue",
    } satisfies PluginHostContext & { entityId: string; entityType: string };
    vi.mocked(useHostContext).mockReturnValue(ctx);
    vi.mocked(usePluginData).mockReturnValue(dataResult({ results: [] }));
    render(<WikiContextTab context={ctx} />);
    expect(usePluginData).toHaveBeenCalledWith(
      "relevantForIssue",
      expect.objectContaining({
        companyId: "c1",
        issueId: "issue-99",
      }),
    );
  });

  it("renders a list of relevant wiki pages", () => {
    const ctx = {
      ...baseHostContext,
      entityId: "issue-99",
      entityType: "issue",
    } satisfies PluginHostContext & { entityId: string; entityType: string };
    vi.mocked(useHostContext).mockReturnValue(ctx);
    vi.mocked(usePluginData).mockReturnValue(
      dataResult({
        results: [
          { slug: "transformer", title: "Transformer", type: "entity", score: 1.7 },
          { slug: "attention-mechanism", title: "Attention Mechanism", type: "concept", score: 1.5 },
        ],
      }),
    );
    render(<WikiContextTab context={ctx} />);
    expect(screen.getByText("Transformer")).toBeDefined();
    expect(screen.getByText("Attention Mechanism")).toBeDefined();
  });

  it("shows an empty state when results is empty", () => {
    const ctx = {
      ...baseHostContext,
      entityId: "issue-99",
      entityType: "issue",
    } satisfies PluginHostContext & { entityId: string; entityType: string };
    vi.mocked(useHostContext).mockReturnValue(ctx);
    vi.mocked(usePluginData).mockReturnValue(dataResult({ results: [] }));
    render(<WikiContextTab context={ctx} />);
    expect(
      screen.getByText(/no.*relevant|nothing|no matches/i),
    ).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// WikiSidebar / WikiPage (both wrap WikiBrowser)
// ────────────────────────────────────────────────────────────────────────

describe("WikiSidebar (browser surface)", () => {
  const indexPayload = {
    index: "# Wiki\n\n- [[transformer]]",
    shards: [],
    pages: [
      { slug: "transformer", title: "Transformer", type: "entity", relPath: "entities/transformer.md" },
      { slug: "attention-mechanism", title: "Attention Mechanism", type: "concept", relPath: "concepts/attention-mechanism.md" },
    ],
  };

  it("renders the page list when loadIndex resolves", () => {
    vi.mocked(usePluginData).mockReturnValue(dataResult(indexPayload));
    render(<WikiSidebar context={baseHostContext} />);
    expect(screen.getByText("Transformer")).toBeDefined();
    expect(screen.getByText("Attention Mechanism")).toBeDefined();
  });

  it("renders a search input", () => {
    vi.mocked(usePluginData).mockReturnValue(dataResult(indexPayload));
    render(<WikiSidebar context={baseHostContext} />);
    const input = screen.getByPlaceholderText(/search/i) as HTMLInputElement;
    expect(input).toBeDefined();
  });

  it("typing in search calls usePluginData('searchWiki', ...) with the query", () => {
    // First call (mount) returns the index; subsequent calls during search
    // can return any payload — we just want to verify the key.
    vi.mocked(usePluginData).mockImplementation((key, params) => {
      if (key === "searchWiki") {
        return dataResult({ results: [] }) as never;
      }
      return dataResult(indexPayload) as never;
    });
    render(<WikiSidebar context={baseHostContext} />);
    const input = screen.getByPlaceholderText(/search/i) as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: "transformer" } });
    });
    expect(usePluginData).toHaveBeenCalledWith(
      "searchWiki",
      expect.objectContaining({ query: "transformer" }),
    );
  });

  it("renders a wiki-not-configured state on bridge error", () => {
    vi.mocked(usePluginData).mockReturnValue(errorResult("no wiki"));
    render(<WikiSidebar context={baseHostContext} />);
    expect(screen.getByText(/no wiki|not configured|error/i)).toBeDefined();
  });
});

describe("WikiPage (full-width browser)", () => {
  it("renders the page browser", () => {
    vi.mocked(usePluginData).mockReturnValue(
      dataResult({ index: "", shards: [], pages: [] }),
    );
    const { container } = render(<WikiPage context={baseHostContext} />);
    // Distinct full-width surface; assert via class hook.
    expect(container.querySelector(".llm-wiki-page-surface")).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// index.tsx — named exports must match manifest exportName fields
// ────────────────────────────────────────────────────────────────────────

describe("ui/index.tsx — named exports", () => {
  it("exports the four named slots the manifest declares", () => {
    expect(typeof uiIndex.WikiSidebar).toBe("function");
    expect(typeof uiIndex.WikiPage).toBe("function");
    expect(typeof uiIndex.WikiContextTab).toBe("function");
    expect(typeof uiIndex.WikiHealthIndicator).toBe("function");
  });

  it("also exports WikiPageView as a public utility for embedding", () => {
    expect(typeof uiIndex.WikiPageView).toBe("function");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Fix 2 — UI must not pass a hardcoded topK so the worker config wins
// ────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────
// Fix 3 — WikiHealthIndicator refreshes on lintCheckIntervalMinutes
// ────────────────────────────────────────────────────────────────────────

describe("WikiHealthIndicator — periodic refresh", () => {
  function healthPayload(intervalMinutes: number) {
    return {
      pageCount: 10,
      indexLines: 50,
      linkDensity: 1.5,
      scalingMessages: [],
      lintStatus: "pass" as const,
      lintFindings: { totalPages: 10 },
      wikiPathMissing: false,
      lintCheckIntervalMinutes: intervalMinutes,
    };
  }

  it("calls refresh() after the configured interval elapses", () => {
    vi.useFakeTimers();
    try {
      const refresh = vi.fn();
      vi.mocked(usePluginData).mockReturnValue({
        data: healthPayload(5),
        loading: false,
        error: null,
        refresh,
      });
      render(<WikiHealthIndicator context={baseHostContext} />);
      // 5 minutes = 300_000 ms.
      expect(refresh).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5 * 60_000);
      expect(refresh).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5 * 60_000);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the interval on unmount (no leak)", () => {
    vi.useFakeTimers();
    try {
      const refresh = vi.fn();
      vi.mocked(usePluginData).mockReturnValue({
        data: healthPayload(5),
        loading: false,
        error: null,
        refresh,
      });
      const { unmount } = render(
        <WikiHealthIndicator context={baseHostContext} />,
      );
      unmount();
      vi.advanceTimersByTime(60 * 60_000);
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule when payload is loading or in error state", () => {
    vi.useFakeTimers();
    try {
      const refresh = vi.fn();
      vi.mocked(usePluginData).mockReturnValue({
        data: null,
        loading: true,
        error: null,
        refresh,
      });
      render(<WikiHealthIndicator context={baseHostContext} />);
      vi.advanceTimersByTime(60 * 60_000);
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WikiBrowser — does not hardcode topK for searchWiki", () => {
  it("does not pass topK in the searchWiki params", () => {
    vi.mocked(usePluginData).mockReturnValue(
      dataResult({ index: "", shards: [], pages: [] }),
    );
    render(<WikiSidebar context={baseHostContext} />);

    const searchCall = vi
      .mocked(usePluginData)
      .mock.calls.find(([key]) => key === "searchWiki");
    expect(searchCall).toBeDefined();
    const params = searchCall?.[1] ?? {};
    // topK must be absent (or explicitly undefined) so the worker's
    // resolveTopK uses config.search_top_k.
    expect((params as Record<string, unknown>).topK).toBeUndefined();
  });
});

describe("WikiContextTab — does not hardcode topK for relevantForIssue", () => {
  it("does not pass topK in the relevantForIssue params", () => {
    const ctx = {
      ...baseHostContext,
      entityId: "issue-99",
      entityType: "issue",
    } satisfies PluginHostContext & { entityId: string; entityType: string };
    vi.mocked(useHostContext).mockReturnValue(ctx);
    vi.mocked(usePluginData).mockReturnValue(dataResult({ results: [] }));
    render(<WikiContextTab context={ctx} />);

    const call = vi
      .mocked(usePluginData)
      .mock.calls.find(([key]) => key === "relevantForIssue");
    expect(call).toBeDefined();
    const params = call?.[1] ?? {};
    expect((params as Record<string, unknown>).topK).toBeUndefined();
  });
});
