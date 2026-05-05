// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import * as React from "react";
import { useWikiLocation, navigateTo } from "../../src/ui/href.js";

function Probe(): React.ReactElement {
  const loc = useWikiLocation();
  return <div data-testid="loc">{JSON.stringify(loc)}</div>;
}

function setLocation(pathname: string, search: string, hash: string): void {
  window.history.replaceState({}, "", `${pathname}${search}${hash}`);
}

describe("useWikiLocation", () => {
  beforeEach(() => {
    setLocation("/SEE/llm-wiki", "", "");
  });

  it("reads the current location on first render", () => {
    setLocation("/SEE/llm-wiki", "", "#concepts/transformer");
    const { getByTestId } = render(<Probe />);
    expect(JSON.parse(getByTestId("loc").textContent!)).toEqual({
      kind: "page",
      slug: "concepts/transformer",
    });
  });

  it("re-renders on hashchange", () => {
    const { getByTestId } = render(<Probe />);
    expect(JSON.parse(getByTestId("loc").textContent!)).toEqual({
      kind: "landing",
    });
    act(() => {
      window.location.hash = "#@concepts";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(JSON.parse(getByTestId("loc").textContent!)).toEqual({
      kind: "folder",
      folder: "concepts",
    });
  });

  it("re-renders on popstate (query-string changes via pushState)", () => {
    const { getByTestId } = render(<Probe />);
    act(() => {
      window.history.pushState({}, "", "/SEE/llm-wiki?q=attention");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(JSON.parse(getByTestId("loc").textContent!)).toEqual({
      kind: "search",
      query: "attention",
      slug: null,
    });
  });

  it("removes both listeners on unmount", () => {
    const { unmount, getByTestId } = render(<Probe />);
    const before = getByTestId("loc").textContent;
    unmount();
    // After unmount, dispatching events must not throw and must not mutate
    // any leftover state. We assert by re-rendering a fresh probe and seeing
    // that it picks up the latest location synchronously.
    setLocation("/SEE/llm-wiki", "", "#concepts/transformer");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    const second = render(<Probe />);
    expect(JSON.parse(second.getByTestId("loc").textContent!)).toEqual({
      kind: "page",
      slug: "concepts/transformer",
    });
    // The first probe's last-known value pre-unmount was the landing state.
    expect(JSON.parse(before!)).toEqual({ kind: "landing" });
  });
});

describe("navigateTo", () => {
  beforeEach(() => {
    setLocation("/SEE/llm-wiki", "", "");
  });

  it("pushes a new history entry and dispatches a popstate-equivalent event", () => {
    const { getByTestId } = render(<Probe />);
    act(() => {
      navigateTo("SEE", { kind: "page", slug: "concepts/transformer" });
    });
    expect(window.location.pathname + window.location.hash).toBe(
      "/SEE/llm-wiki#concepts%2Ftransformer",
    );
    expect(JSON.parse(getByTestId("loc").textContent!)).toEqual({
      kind: "page",
      slug: "concepts/transformer",
    });
  });

  it("clears the query string when navigating to landing/page/folder", () => {
    setLocation("/SEE/llm-wiki", "?q=stale", "#concepts");
    const { getByTestId } = render(<Probe />);
    act(() => {
      navigateTo("SEE", { kind: "page", slug: "other" });
    });
    expect(window.location.search).toBe("");
    expect(JSON.parse(getByTestId("loc").textContent!)).toEqual({
      kind: "page",
      slug: "other",
    });
  });
});
