// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { Launcher } from "../../src/ui/launcher/Launcher.js";

const baseContext = {
  companyId: "c1",
  companyPrefix: "SEE",
  projectId: "p1",
  entityId: null,
  entityType: null,
  parentEntityId: null,
  userId: "u1",
};

beforeEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("Launcher (sidebar) — host-styled navigation link", () => {
  it("renders a single anchor to the wiki landing", () => {
    const { container } = render(<Launcher context={baseContext} />);
    const link = container.querySelector("a[data-testid='wiki-open']");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/SEE/llm-wiki");
    expect(link?.textContent).toMatch(/LLM Wiki/);
  });

  it("uses the host's Tailwind nav-item classes so it visually matches Dashboard/Inbox/etc.", () => {
    const { container } = render(<Launcher context={baseContext} />);
    const cls = container
      .querySelector("a[data-testid='wiki-open']")
      ?.getAttribute("class") ?? "";
    // Same class set as ui/src/components/SidebarNavItem.tsx in the host.
    for (const expected of [
      "flex",
      "items-center",
      "gap-2.5",
      "px-3",
      "py-2",
      "text-[13px]",
      "font-medium",
    ]) {
      expect(cls).toContain(expected);
    }
  });

  it("renders an h-4 w-4 SVG icon to match the host's Lucide nav icons", () => {
    const { container } = render(<Launcher context={baseContext} />);
    const svg = container.querySelector("a[data-testid='wiki-open'] svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class")).toContain("h-4 w-4");
    expect(svg?.getAttribute("stroke")).toBe("currentColor");
  });

  it("marks the link active when the current pathname is the wiki workspace", () => {
    window.history.replaceState({}, "", "/SEE/llm-wiki");
    const { container } = render(<Launcher context={baseContext} />);
    const link = container.querySelector("a[data-testid='wiki-open']");
    expect(link?.getAttribute("aria-current")).toBe("page");
    expect(link?.getAttribute("class")).toContain("bg-accent");
  });

  it("re-evaluates active state when the URL changes (popstate)", () => {
    const { container } = render(<Launcher context={baseContext} />);
    const link = () =>
      container.querySelector("a[data-testid='wiki-open']");
    expect(link()?.getAttribute("aria-current")).toBeNull();
    act(() => {
      window.history.pushState({}, "", "/SEE/llm-wiki");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(link()?.getAttribute("aria-current")).toBe("page");
  });

  it("renders nothing when companyId is null (no Company in scope)", () => {
    const { container } = render(
      <Launcher context={{ ...baseContext, companyId: null }} />,
    );
    expect(container.querySelector("a[data-testid='wiki-open']")).toBeNull();
  });
});
