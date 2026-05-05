// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  recordRecent,
  readRecent,
  RECENT_CAP,
  RECENT_UPDATED_EVENT,
} from "../../src/ui/recent.js";

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("recent pages list", () => {
  it("starts empty", () => {
    expect(readRecent()).toEqual([]);
  });

  it("records a page and reads it back", () => {
    recordRecent({ slug: "concepts/transformer", title: "Transformer" });
    expect(readRecent()).toEqual([
      { slug: "concepts/transformer", title: "Transformer" },
    ]);
  });

  it("places the most recently recorded page first", () => {
    recordRecent({ slug: "a", title: "A" });
    recordRecent({ slug: "b", title: "B" });
    recordRecent({ slug: "c", title: "C" });
    expect(readRecent().map((p) => p.slug)).toEqual(["c", "b", "a"]);
  });

  it("dedups by slug — re-recording moves to front, doesn't duplicate", () => {
    recordRecent({ slug: "a", title: "A" });
    recordRecent({ slug: "b", title: "B" });
    recordRecent({ slug: "a", title: "A renamed" });
    const list = readRecent();
    expect(list.map((p) => p.slug)).toEqual(["a", "b"]);
    expect(list[0]?.title).toBe("A renamed");
  });

  it("caps at RECENT_CAP entries", () => {
    for (let i = 0; i < RECENT_CAP + 5; i++) {
      recordRecent({ slug: `s${i}`, title: `S${i}` });
    }
    const list = readRecent();
    expect(list.length).toBe(RECENT_CAP);
    // The cap drops the oldest, so the first entry is the most recent.
    expect(list[0]?.slug).toBe(`s${RECENT_CAP + 4}`);
  });

  it("survives non-JSON garbage in sessionStorage by returning empty", () => {
    window.sessionStorage.setItem(
      "llm-wiki:recent",
      "{not valid json",
    );
    expect(readRecent()).toEqual([]);
  });

  it("survives a non-array JSON payload by returning empty", () => {
    window.sessionStorage.setItem("llm-wiki:recent", '"a string"');
    expect(readRecent()).toEqual([]);
  });

  it("dispatches RECENT_UPDATED_EVENT on every successful write", () => {
    const handler = vi.fn();
    window.addEventListener(RECENT_UPDATED_EVENT, handler);
    try {
      recordRecent({ slug: "a", title: "A" });
      recordRecent({ slug: "b", title: "B" });
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(RECENT_UPDATED_EVENT, handler);
    }
  });

  it("ignores entries with bad shape", () => {
    window.sessionStorage.setItem(
      "llm-wiki:recent",
      JSON.stringify([
        { slug: "ok", title: "OK" },
        { slug: 42, title: "bad" },
        { title: "no slug" },
        { slug: "ok2", title: "OK2" },
      ]),
    );
    expect(readRecent()).toEqual([
      { slug: "ok", title: "OK" },
      { slug: "ok2", title: "OK2" },
    ]);
  });
});
