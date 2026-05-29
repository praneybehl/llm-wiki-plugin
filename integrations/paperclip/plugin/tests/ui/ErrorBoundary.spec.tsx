// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "../../src/ui/ErrorBoundary.js";

/**
 * SDK gotcha (FEASIBILITY §4): @paperclipai/plugin-sdk/ui does NOT re-export
 * ErrorBoundary from ui/index.ts (it lives in ui/components.ts only). We
 * roll our own — trivial React class boundary — to wrap each top-level
 * slot per PLUGIN_SPEC's recommendation.
 */

function Boom(): never {
  throw new Error("kaboom");
}

describe("ErrorBoundary", () => {
  it("renders children when no error is thrown", () => {
    render(
      <ErrorBoundary>
        <span>healthy</span>
      </ErrorBoundary>,
    );
    expect(screen.getByText("healthy")).toBeDefined();
  });

  it("renders the default fallback when a child throws", () => {
    // Suppress the React error log noise for this test.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );
      // Default fallback contains a recognizable string.
      expect(screen.getByText(/something went wrong/i)).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("renders a custom fallback if provided", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <ErrorBoundary fallback={<span>custom fallback</span>}>
          <Boom />
        </ErrorBoundary>,
      );
      expect(screen.getByText("custom fallback")).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });
});
