// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QuickSwitcher } from "../../src/ui/page/QuickSwitcher.js";

const pages = [
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
];

beforeEach(() => {
  window.history.replaceState({}, "", "/SEE/llm-wiki");
});

describe("QuickSwitcher", () => {
  it("does not render the dialog when closed", () => {
    render(
      <QuickSwitcher
        pages={pages}
        companyPrefix="SEE"
        open={false}
        onOpenChange={() => {}}
      />,
    );
    expect(screen.queryByPlaceholderText(/search pages/i)).toBeNull();
  });

  it("renders the search input and all pages when open", () => {
    render(
      <QuickSwitcher
        pages={pages}
        companyPrefix="SEE"
        open={true}
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByPlaceholderText(/search pages/i)).toBeDefined();
    expect(screen.getByText("Transformer")).toBeDefined();
    expect(screen.getByText("Attention")).toBeDefined();
    expect(screen.getByText("Andrej Karpathy")).toBeDefined();
  });

  it("filters items by typed query (case-insensitive)", () => {
    render(
      <QuickSwitcher
        pages={pages}
        companyPrefix="SEE"
        open={true}
        onOpenChange={() => {}}
      />,
    );
    const input = screen.getByPlaceholderText(/search pages/i) as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: "kar" } });
    });
    expect(screen.queryByText("Transformer")).toBeNull();
    expect(screen.getByText("Andrej Karpathy")).toBeDefined();
  });

  it("clicking an item navigates and calls onOpenChange(false)", () => {
    let isOpen = true;
    function Wrapper(): React.ReactElement {
      return (
        <QuickSwitcher
          pages={pages}
          companyPrefix="SEE"
          open={isOpen}
          onOpenChange={(o) => {
            isOpen = o;
          }}
        />
      );
    }
    render(<Wrapper />);
    act(() => {
      fireEvent.click(screen.getByText("Transformer"));
    });
    expect(window.location.pathname + window.location.hash).toBe(
      "/SEE/llm-wiki#concepts%2Ftransformer",
    );
    expect(isOpen).toBe(false);
  });
});

import * as React from "react";
