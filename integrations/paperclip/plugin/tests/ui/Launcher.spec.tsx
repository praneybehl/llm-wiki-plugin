// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
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

describe("Launcher (sidebar) — minimal navigation link", () => {
  it("renders a single link to the wiki landing", () => {
    const { container } = render(<Launcher context={baseContext} />);
    const link = container.querySelector("a[data-testid='wiki-open']");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/SEE/llm-wiki");
    expect(link?.textContent).toMatch(/LLM Wiki/);
  });

  it("renders an empty-Company message when companyId is null", () => {
    const { container } = render(
      <Launcher context={{ ...baseContext, companyId: null }} />,
    );
    expect(container.querySelector("a[data-testid='wiki-open']")).toBeNull();
    expect(container.textContent).toMatch(/No Company/i);
  });
});
