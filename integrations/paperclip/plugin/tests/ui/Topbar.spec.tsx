// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { Topbar } from "../../src/ui/page/Topbar.js";
import type { WikiLocation } from "../../src/ui/href.js";

beforeEach(() => {
  window.history.replaceState({}, "", "/SEE/llm-wiki");
});

describe("Topbar — breadcrumb", () => {
  it("renders 'Wiki' as the breadcrumb root for the landing view", () => {
    const loc: WikiLocation = { kind: "landing" };
    const { container } = render(
      <Topbar
        location={loc}
        companyPrefix="SEE"
        onOpenSwitcher={() => {}}
      />,
    );
    const crumbs = container.querySelectorAll(".llm-wiki-topbar-crumb");
    expect(crumbs.length).toBe(1);
    expect(crumbs[0]?.textContent).toBe("Wiki");
  });

  it("renders nested folder + page breadcrumb segments for a page view", () => {
    const loc: WikiLocation = {
      kind: "page",
      slug: "concepts/transformer",
    };
    const { container } = render(
      <Topbar
        location={loc}
        companyPrefix="SEE"
        onOpenSwitcher={() => {}}
      />,
    );
    const crumbs = Array.from(
      container.querySelectorAll(".llm-wiki-topbar-crumb"),
    ).map((el) => el.textContent);
    expect(crumbs).toEqual(["Wiki", "concepts", "transformer"]);
  });

  it("renders folder breadcrumb for a folder view", () => {
    const loc: WikiLocation = { kind: "folder", folder: "concepts" };
    const { container } = render(
      <Topbar
        location={loc}
        companyPrefix="SEE"
        onOpenSwitcher={() => {}}
      />,
    );
    const crumbs = Array.from(
      container.querySelectorAll(".llm-wiki-topbar-crumb"),
    ).map((el) => el.textContent);
    expect(crumbs).toEqual(["Wiki", "concepts"]);
  });

  it("renders a Setup label for ?view=setup", () => {
    const loc: WikiLocation = { kind: "setup" };
    const { container } = render(
      <Topbar
        location={loc}
        companyPrefix="SEE"
        onOpenSwitcher={() => {}}
      />,
    );
    const crumbs = Array.from(
      container.querySelectorAll(".llm-wiki-topbar-crumb"),
    ).map((el) => el.textContent);
    expect(crumbs).toEqual(["Wiki", "Setup"]);
  });
});

describe("Topbar — back/forward + switcher trigger", () => {
  it("Back button calls window.history.back()", () => {
    const loc: WikiLocation = { kind: "landing" };
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    try {
      const { getByLabelText } = render(
        <Topbar
          location={loc}
          companyPrefix="SEE"
          onOpenSwitcher={() => {}}
        />,
      );
      act(() => {
        fireEvent.click(getByLabelText(/back/i));
      });
      expect(back).toHaveBeenCalledTimes(1);
    } finally {
      back.mockRestore();
    }
  });

  it("⌘K trigger calls onOpenSwitcher", () => {
    const onOpen = vi.fn();
    const loc: WikiLocation = { kind: "landing" };
    const { getByText } = render(
      <Topbar
        location={loc}
        companyPrefix="SEE"
        onOpenSwitcher={onOpen}
      />,
    );
    act(() => {
      fireEvent.click(getByText(/⌘K|Ctrl-K|Quick/i));
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
