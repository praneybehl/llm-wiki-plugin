import { describe, expect, it } from "vitest";
import { freshWiki, statusOf } from "./helpers";
import type { CommitOp, ConflictDetails } from "../../src/types";

function conflictOf(result: { ok: boolean; status?: number; error?: { code: string; details?: unknown } }): ConflictDetails {
  expect(result.ok).toBe(false);
  expect(result.status).toBe(409);
  expect(result.error?.code).toBe("conflict");
  return result.error!.details as ConflictDetails;
}

async function must<T>(promise: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

describe("commit ops", () => {
  it("creates, puts, edits, appends, moves and deletes", async () => {
    const { wiki } = await freshWiki();
    const c1 = await must(wiki.commit("alice", { message: "create", ops: [{ op: "create", path: "concepts/a.md", content: "# A\n\nalpha\n" }] }));
    expect(c1.seq).toBe(1);
    expect(c1.changed).toEqual([{ path: "concepts/a.md", rev: 1, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);

    const c2 = await must(wiki.commit("alice", { message: "put", ops: [{ op: "put", path: "concepts/a.md", content: "# A\n\nbeta\n", base_rev: 1 }] }));
    expect(c2.changed[0]!.rev).toBe(2);

    await must(wiki.commit("bob", { message: "edit", ops: [{ op: "edit", path: "concepts/a.md", edits: [{ old: "beta", new: "gamma" }], base_rev: 2 }] }));
    await must(wiki.commit("bob", { message: "append", ops: [{ op: "append", path: "concepts/a.md", text: "- line one" }] }));
    let page = (await wiki.read({ paths: ["concepts/a.md"] })).pages[0]!;
    expect(page.content).toBe("# A\n\ngamma\n- line one\n");
    expect(page.rev).toBe(4);
    expect(page.updated_by).toBe("bob");

    await must(wiki.commit("bob", { message: "move", ops: [{ op: "move", from: "concepts/a.md", to: "concepts/b.md", base_rev: 4 }] }));
    const read = await wiki.read({ paths: ["concepts/a.md", "concepts/b.md"] });
    expect(read.missing).toEqual(["concepts/a.md"]);
    expect(read.pages[0]!.content).toBe("# A\n\ngamma\n- line one\n");

    const del = await must(wiki.commit("bob", { message: "delete", ops: [{ op: "delete", path: "concepts/b.md", base_rev: 5 }] }));
    expect(del.changed).toEqual([{ path: "concepts/b.md", rev: 6, sha256: "", deleted: true }]);
    expect((await wiki.list({})).length).toBe(0);
  });

  it("upsert creates, replaces and treats identical content as a no-op", async () => {
    const { wiki } = await freshWiki();
    const first = await must(wiki.commit("i", { message: "u", ops: [{ op: "upsert", path: "x.md", content: "one" }] }));
    const again = await must(wiki.commit("i", { message: "u", ops: [{ op: "upsert", path: "x.md", content: "one" }] }));
    expect(again.commit_id).toBe("");
    expect(again.seq).toBe(first.seq);
    expect(again.changed).toEqual([{ path: "x.md", rev: 1, sha256: first.changed[0]!.sha256 }]);
    const replaced = await must(wiki.commit("i", { message: "u", ops: [{ op: "upsert", path: "x.md", content: "two" }] }));
    expect(replaced.seq).toBe(2);
  });

  it("appends after a heading and creates on demand", async () => {
    const { wiki } = await freshWiki();
    await must(
      wiki.commit("a", {
        message: "c",
        ops: [{ op: "create", path: "index.md", content: "# Index\n\n## Concepts\n- [[a]]\n\n## Sources\n- [[s]]\n" }],
      }),
    );
    await must(wiki.commit("a", { message: "a", ops: [{ op: "append", path: "index.md", text: "- [[b]]", after_heading: "concepts" }] }));
    await must(wiki.commit("a", { message: "a", ops: [{ op: "append", path: "new.md", text: "first", create: true }] }));
    const pages = (await wiki.read({ paths: ["index.md", "new.md"] })).pages;
    expect(pages[0]!.content).toBe("# Index\n\n## Concepts\n- [[a]]\n- [[b]]\n\n## Sources\n- [[s]]\n");
    expect(pages[1]!.content).toBe("first\n");
    const missing = await wiki.commit("a", { message: "a", ops: [{ op: "append", path: "nope.md", text: "x" }] });
    expect(conflictOf(missing).reason).toBe("missing");
  });

  it("writes the log line in the same commit", async () => {
    const { wiki } = await freshWiki();
    const result = await must(
      wiki.commit("agent-1", { message: "ingest", ops: [{ op: "create", path: "sources/s.md", content: "s" }], log: "ingest | s\nmore" }),
    );
    expect(result.changed.map((c) => c.path).sort()).toEqual(["log.md", "sources/s.md"]);
    const log = (await wiki.read({ paths: ["log.md"] })).pages[0]!;
    expect(log.content).toMatch(/^- \d{4}-\d{2}-\d{2} agent-1: ingest \| s more\n$/);
    await must(wiki.commit("agent-2", { message: "again", ops: [{ op: "create", path: "t.md", content: "t" }], log: "second" }));
    const log2 = (await wiki.read({ paths: ["log.md"] })).pages[0]!;
    expect(log2.content.split("\n").filter(Boolean)).toHaveLength(2);
  });
});

describe("commit conflicts", () => {
  async function seeded() {
    const w = await freshWiki();
    await must(w.wiki.commit("a", { message: "seed", ops: [{ op: "create", path: "p.md", content: "# P\n\nfoo bar foo\n\n## Two\n\nunique text\n" }] }));
    await must(w.wiki.commit("a", { message: "bump", ops: [{ op: "edit", path: "p.md", edits: [{ old: "unique text", new: "unique text v2" }] }] }));
    return w;
  }

  it("create on an existing path fails with exists", async () => {
    const { wiki } = await seeded();
    const details = conflictOf(await wiki.commit("a", { message: "x", ops: [{ op: "create", path: "p.md", content: "x" }] }));
    expect(details).toMatchObject({ op_index: 0, path: "p.md", reason: "exists", current_rev: 2 });
  });

  it("put with a stale base fails with a unified diff", async () => {
    const { wiki } = await seeded();
    const details = conflictOf(await wiki.commit("a", { message: "x", ops: [{ op: "put", path: "p.md", content: "x", base_rev: 1 }] }));
    expect(details).toMatchObject({ reason: "stale_base_rev", current_rev: 2, base_rev: 1 });
    expect(details.diff).toContain("--- a/p.md@1\n+++ b/p.md@2\n@@ ");
    expect(details.diff).toContain("-unique text\n+unique text v2\n");
  });

  it("put, edit, delete and move on a missing page fail with missing", async () => {
    const { wiki } = await seeded();
    const ops: CommitOp[] = [
      { op: "put", path: "none.md", content: "x", base_rev: 1 },
      { op: "edit", path: "none.md", edits: [{ old: "a", new: "b" }] },
      { op: "delete", path: "none.md", base_rev: 1 },
      { op: "move", from: "none.md", to: "z.md", base_rev: 1 },
    ];
    for (const op of ops) {
      expect(conflictOf(await wiki.commit("a", { message: "x", ops: [op] })).reason).toBe("missing");
    }
  });

  it("delete and move need the current base_rev", async () => {
    const { wiki } = await seeded();
    expect(conflictOf(await wiki.commit("a", { message: "x", ops: [{ op: "delete", path: "p.md", base_rev: 1 }] })).reason).toBe("stale_base_rev");
    expect(conflictOf(await wiki.commit("a", { message: "x", ops: [{ op: "move", from: "p.md", to: "q.md", base_rev: 1 }] })).reason).toBe(
      "stale_base_rev",
    );
    await must(wiki.commit("a", { message: "q", ops: [{ op: "create", path: "q.md", content: "q" }] }));
    const moveOnto = conflictOf(await wiki.commit("a", { message: "x", ops: [{ op: "move", from: "p.md", to: "q.md", base_rev: 2 }] }));
    expect(moveOnto).toMatchObject({ reason: "exists", path: "q.md" });
  });

  it("edit with no match or many matches fails with an excerpt", async () => {
    const { wiki } = await seeded();
    const none = conflictOf(await wiki.commit("a", { message: "x", ops: [{ op: "edit", path: "p.md", edits: [{ old: "absent", new: "y" }] }] }));
    expect(none.reason).toBe("edit_no_match");
    expect(none.diff).toBeUndefined();
    expect(none.current_excerpt).toContain("# P");
    const many = conflictOf(await wiki.commit("a", { message: "x", ops: [{ op: "edit", path: "p.md", edits: [{ old: "foo", new: "y" }] }] }));
    expect(many.reason).toBe("edit_multiple_matches");
    expect(many.current_excerpt).toContain("foo bar foo");
    await must(wiki.commit("a", { message: "all", ops: [{ op: "edit", path: "p.md", edits: [{ old: "foo", new: "baz", replace_all: true }] }] }));
    expect((await wiki.read({ paths: ["p.md"] })).pages[0]!.content).toContain("baz bar baz");
  });

  it("a failed edit with a stale base includes the diff from base to current", async () => {
    const { wiki } = await seeded();
    const details = conflictOf(
      await wiki.commit("a", { message: "x", ops: [{ op: "edit", path: "p.md", base_rev: 1, edits: [{ old: "unique text\n", new: "z" }] }] }),
    );
    expect(details.reason).toBe("edit_no_match");
    expect(details.base_rev).toBe(1);
    expect(details.diff).toContain("+unique text v2");
  });

  it("rebases an edit on a stale base_rev when the match is still unique", async () => {
    const { wiki } = await seeded();
    const result = await must(wiki.commit("a", { message: "x", ops: [{ op: "edit", path: "p.md", base_rev: 1, edits: [{ old: "bar", new: "BAR" }] }] }));
    expect(result.changed[0]!.rev).toBe(3);
    const content = (await wiki.read({ paths: ["p.md"] })).pages[0]!.content;
    expect(content).toContain("foo BAR foo");
    expect(content).toContain("unique text v2");
  });

  it("is all-or-nothing", async () => {
    const { wiki } = await seeded();
    const result = await wiki.commit("a", {
      message: "x",
      ops: [
        { op: "create", path: "new.md", content: "n" },
        { op: "create", path: "p.md", content: "dup" },
      ],
      log: "should not land",
    });
    expect(conflictOf(result).op_index).toBe(1);
    expect((await wiki.read({ paths: ["new.md", "log.md"] })).missing).toEqual(["new.md", "log.md"]);
    expect((await wiki.overview()).seq).toBe(2);
  });
});

describe("concurrency", () => {
  it("never loses concurrent appends or edits on one page", async () => {
    const { wiki } = await freshWiki();
    const lines = Array.from({ length: 25 }, (_, i) => `line-${i}`);
    await must(wiki.commit("a", { message: "seed", ops: [{ op: "create", path: "log2.md", content: `${lines.map((l) => `${l}: old`).join("\n")}\n` }] }));
    const results = await Promise.all([
      ...lines.map((line) => wiki.commit("w", { message: line, ops: [{ op: "append", path: "c.md", text: `- ${line}`, create: true }] })),
      ...lines.map((line) => wiki.commit("w", { message: line, ops: [{ op: "edit", path: "log2.md", base_rev: 1, edits: [{ old: `${line}: old`, new: `${line}: new` }] }] })),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    const seqs = results.map((r) => (r.ok ? r.value.seq : statusOf(r)));
    expect(new Set(seqs).size).toBe(seqs.length);
    const pages = (await wiki.read({ paths: ["c.md", "log2.md"] })).pages;
    for (const line of lines) {
      expect(pages[0]!.content).toContain(`- ${line}\n`);
      expect(pages[1]!.content).toContain(`${line}: new`);
    }
    expect((await wiki.overview()).seq).toBe(1 + lines.length * 2);
  });
});

describe("validation", () => {
  const bad = [
    "../x.md",
    "a/../x.md",
    "/abs.md",
    "a\\b.md",
    ".hidden/x.md",
    "dir/.x.md",
    ".env",
    "tab\there.md",
    "a//b.md",
    `${"a".repeat(510)}.md`,
  ];
  for (const path of bad) {
    it(`rejects ${JSON.stringify(path.slice(0, 40))}`, async () => {
      const { wiki } = await freshWiki();
      const result = await wiki.commit("a", { message: "x", ops: [{ op: "create", path, content: "x" }] });
      expect(result.ok).toBe(false);
      expect(statusOf(result)).toBe(400);
    });
  }

  it("allows top-level template dotfiles", async () => {
    const { wiki } = await freshWiki();
    const result = await wiki.commit("a", { message: "x", ops: [{ op: "create", path: ".page-template.md", content: "x" }] });
    expect(result.ok).toBe(true);
  });

  it("enforces size limits", async () => {
    const { wiki } = await freshWiki();
    const big = await wiki.commit("a", { message: "x", ops: [{ op: "create", path: "big.md", content: "x".repeat(1_500_001) }] });
    expect(statusOf(big)).toBe(413);
    const many = await wiki.commit("a", {
      message: "x",
      ops: Array.from({ length: 201 }, (_, i): CommitOp => ({ op: "create", path: `p${i}.md`, content: "x" })),
    });
    expect(statusOf(many)).toBe(413);
    const total = await wiki.commit("a", {
      message: "x",
      ops: Array.from({ length: 3 }, (_, i): CommitOp => ({ op: "create", path: `q${i}.md`, content: "y".repeat(1_400_000) })),
    });
    expect(statusOf(total)).toBe(413);
    const unknownOp = await wiki.commit("a", { message: "x", ops: [{ op: "rename", path: "x" } as unknown as CommitOp] });
    expect(statusOf(unknownOp)).toBe(400);
  });
});
