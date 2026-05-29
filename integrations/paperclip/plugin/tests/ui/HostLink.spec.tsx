// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { HostLink } from "../../src/ui/HostLink.js";

beforeEach(() => {
  window.history.replaceState({}, "", "/start");
});

describe("HostLink — bypasses full-page reload via pushState + popstate", () => {
  it("renders as a plain anchor with the given href", () => {
    const { container } = render(<HostLink href="/SEE/llm-wiki">Wiki</HostLink>);
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("/SEE/llm-wiki");
    expect(a?.textContent).toBe("Wiki");
  });

  it("intercepts a left-click, calls pushState, and dispatches popstate", () => {
    const popstate = vi.fn();
    window.addEventListener("popstate", popstate);
    try {
      const { container } = render(
        <HostLink href="/SEE/llm-wiki?view=setup">Setup</HostLink>,
      );
      const a = container.querySelector("a") as HTMLAnchorElement;
      act(() => {
        fireEvent.click(a, { button: 0 });
      });
      // pushState updated the URL.
      expect(window.location.pathname + window.location.search).toBe(
        "/SEE/llm-wiki?view=setup",
      );
      // The synthetic popstate fired so React Router's history listener
      // can observe the navigation.
      expect(popstate).toHaveBeenCalled();
    } finally {
      window.removeEventListener("popstate", popstate);
    }
  });

  it("falls through (does not preventDefault) on cmd-click — open-in-new-tab still works", () => {
    const { container } = render(
      <HostLink href="/SEE/llm-wiki">Wiki</HostLink>,
    );
    const a = container.querySelector("a") as HTMLAnchorElement;
    const evt = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      metaKey: true,
    });
    act(() => {
      a.dispatchEvent(evt);
    });
    expect(evt.defaultPrevented).toBe(false);
    // Original URL remains — we did not pushState.
    expect(window.location.pathname).toBe("/start");
  });

  it("falls through on middle-click", () => {
    const { container } = render(
      <HostLink href="/SEE/llm-wiki">Wiki</HostLink>,
    );
    const a = container.querySelector("a") as HTMLAnchorElement;
    const evt = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 1,
    });
    act(() => {
      a.dispatchEvent(evt);
    });
    expect(evt.defaultPrevented).toBe(false);
    expect(window.location.pathname).toBe("/start");
  });

  it("falls through for target=\"_blank\"", () => {
    const { container } = render(
      <HostLink href="/SEE/llm-wiki" target="_blank">
        Wiki
      </HostLink>,
    );
    const a = container.querySelector("a") as HTMLAnchorElement;
    const evt = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    act(() => {
      a.dispatchEvent(evt);
    });
    expect(evt.defaultPrevented).toBe(false);
  });

  it("falls through for bare-fragment hrefs (in-page anchors)", () => {
    const { container } = render(<HostLink href="#overview">Overview</HostLink>);
    const a = container.querySelector("a") as HTMLAnchorElement;
    const evt = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    act(() => {
      a.dispatchEvent(evt);
    });
    expect(evt.defaultPrevented).toBe(false);
  });

  it("invokes the consumer's onClick before deciding whether to intercept", () => {
    const onClick = vi.fn();
    const { container } = render(
      <HostLink href="/SEE/llm-wiki" onClick={onClick}>
        Wiki
      </HostLink>,
    );
    const a = container.querySelector("a") as HTMLAnchorElement;
    act(() => {
      fireEvent.click(a, { button: 0 });
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
