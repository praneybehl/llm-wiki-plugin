import { describe, expect, it } from "vitest";
import { failure, freshWiki, statusOf } from "./helpers";
import type { CommitOp } from "../../src/types";

describe("history, revisions and revert", () => {
  it("lists commits, revisions and diffs", async () => {
    const { wiki } = await freshWiki();
    await wiki.commit("a", { message: "one", ops: [{ op: "create", path: "p.md", content: "a\nb\nc\n" }] });
    await wiki.commit("b", { message: "two", ops: [{ op: "put", path: "p.md", content: "a\nB\nc\n", base_rev: 1 }, { op: "create", path: "q.md", content: "q" }] });
    await wiki.commit("c", { message: "three", ops: [{ op: "create", path: "r.md", content: "r" }] });

    const all = await wiki.history({});
    expect(all.map((c) => c.seq)).toEqual([3, 2, 1]);
    expect(all[1]).toMatchObject({ author: "b", message: "two", paths: ["p.md", "q.md"] });
    expect((await wiki.history({ path: "p.md" })).map((c) => c.seq)).toEqual([2, 1]);
    expect((await wiki.history({ limit: 1, before_seq: 3 })).map((c) => c.seq)).toEqual([2]);

    const r1 = await wiki.revision("p.md", 1);
    expect(r1.ok && r1.value.content).toBe("a\nb\nc\n");
    const r2 = await wiki.revision("p.md", 2);
    expect(r2.ok && r2.value.content).toBe("a\nB\nc\n");
    const missing = await wiki.revision("p.md", 3);
    expect(statusOf(missing)).toBe(404);

    const diff = await wiki.diff("p.md", 1, 2);
    expect(diff.ok && diff.value.diff).toBe("--- a/p.md@1\n+++ b/p.md@2\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
  });

  it("reverts a commit as a new commit and refuses when pages changed later", async () => {
    const { wiki } = await freshWiki();
    await wiki.commit("a", { message: "seed", ops: [{ op: "create", path: "p.md", content: "v1" }, { op: "create", path: "gone.md", content: "g" }] });
    const change = await wiki.commit("a", {
      message: "change",
      ops: [
        { op: "put", path: "p.md", content: "v2", base_rev: 1 },
        { op: "create", path: "added.md", content: "new" },
        { op: "delete", path: "gone.md", base_rev: 1 },
      ],
    });
    if (!change.ok) throw new Error("commit failed");
    const reverted = await wiki.revert("admin", change.value.commit_id);
    expect(reverted.ok).toBe(true);
    const read = await wiki.read({ paths: ["p.md", "added.md", "gone.md"] });
    expect(read.pages.map((p) => [p.path, p.content])).toEqual([
      ["p.md", "v1"],
      ["gone.md", "g"],
    ]);
    expect(read.missing).toEqual(["added.md"]);
    expect((await wiki.history({ limit: 1 }))[0]!.message).toBe(`Revert ${change.value.commit_id}`);

    const again = await wiki.revert("admin", change.value.commit_id);
    expect(statusOf(again)).toBe(409);
    expect(failure(again).error.details).toMatchObject({ reason: "stale_base_rev", base_rev: change.value.seq });
    const unknown = await wiki.revert("admin", "nope");
    expect(statusOf(unknown)).toBe(404);
  });

  it("reverts a move", async () => {
    const { wiki } = await freshWiki();
    await wiki.commit("a", { message: "seed", ops: [{ op: "create", path: "a.md", content: "A" }] });
    const move = await wiki.commit("a", { message: "mv", ops: [{ op: "move", from: "a.md", to: "b.md", base_rev: 1 }] });
    if (!move.ok) throw new Error("move failed");
    expect((await wiki.revert("x", move.value.commit_id)).ok).toBe(true);
    const read = await wiki.read({ paths: ["a.md", "b.md"] });
    expect(read.pages.map((p) => p.path)).toEqual(["a.md"]);
  });
});

describe("changes, manifest and export", () => {
  it("pages through changes without splitting a commit", async () => {
    const { wiki } = await freshWiki();
    for (let i = 0; i < 4; i++) {
      const ops: CommitOp[] = [0, 1, 2].map((j) => ({ op: "upsert", path: `d${i}/p${j}.md`, content: `${i}-${j}` }));
      await wiki.commit("a", { message: `c${i}`, ops });
    }
    await wiki.commit("a", { message: "del", ops: [{ op: "delete", path: "d0/p0.md", base_rev: 1 }] });

    const seen: string[] = [];
    let since = 0;
    let rounds = 0;
    for (;;) {
      const res = await wiki.changes(since, 4);
      rounds++;
      const seqs = new Set(res.changes.map((c) => c.rev));
      for (const seq of seqs) {
        // Every change of a seq arrives in one response.
        expect(res.changes.filter((c) => c.rev === seq).length).toBe(seq === 5 ? 1 : seq === 1 ? 2 : 3);
      }
      seen.push(...res.changes.map((c) => `${c.path}@${c.rev}${c.deleted ? "x" : ""}`));
      expect(res.seq).toBe(5);
      since = res.next_since;
      if (!res.more) break;
    }
    expect(rounds).toBeGreaterThan(2);
    expect(seen).toContain("d0/p0.md@5x");
    expect(seen.filter((s) => s.startsWith("d3/"))).toHaveLength(3);
    expect(seen).toHaveLength(12);
    const tail = await wiki.changes(5, 10);
    expect(tail).toEqual({ seq: 5, changes: [], more: false, next_since: 5 });

    const first = await wiki.changes(0, 200);
    const live = first.changes.find((c) => c.path === "d1/p1.md")!;
    expect(live.content).toBe("1-1");
    const dead = first.changes.find((c) => c.path === "d0/p0.md")!;
    expect(dead).toEqual({ path: "d0/p0.md", rev: 5, sha256: "", deleted: true });

    const manifest = await wiki.manifest();
    expect(manifest.seq).toBe(5);
    expect(Object.keys(manifest.pages)).toHaveLength(11);
    expect(manifest.pages["d0/p0.md"]).toBeUndefined();

    const exported: string[] = [];
    let cursor: string | null = null;
    do {
      const batch: Awaited<ReturnType<typeof wiki.exportBatch>> = await wiki.exportBatch(cursor, 5);
      exported.push(...batch.pages.map((p) => p.path));
      cursor = batch.cursor;
    } while (cursor);
    expect(exported).toEqual(Object.keys(manifest.pages).sort());
  });

  it("returns the whole wiki from changes(0) and records sha256 of the exact bytes", async () => {
    const { wiki } = await freshWiki();
    const content = "line\r\nno trailing newline";
    await wiki.commit("a", { message: "c", ops: [{ op: "upsert", path: "x.md", content }] });
    const bytes = new TextEncoder().encode(content);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
    expect((await wiki.manifest()).pages["x.md"]).toBe(digest);
    expect((await wiki.changes(0, 50)).changes[0]!.content).toBe(content);
  });
});

describe("read and list", () => {
  it("reads a heading section and a line range, lists by prefix", async () => {
    const { wiki } = await freshWiki();
    await wiki.commit("a", {
      message: "c",
      ops: [
        { op: "create", path: "concepts/a.md", content: "---\ntype: concept\ntitle: A\ntags: [x, y]\nupdated: 2026-01-02\n---\n# A\n\n## Usage\n\nuse it\n\n### Detail\n\nmore\n\n## Other\n\nother\n" },
        { op: "create", path: "entities/b.md", content: "b" },
      ],
    });
    const section = await wiki.read({ paths: ["concepts/a.md"], heading: "usage" });
    expect(section.pages[0]!.content).toBe("## Usage\n\nuse it\n\n### Detail\n\nmore\n");
    const lines = await wiki.read({ paths: ["concepts/a.md"], heading: "## Usage", start_line: 3, end_line: 3 });
    expect(lines.pages[0]!.content).toBe("use it");
    expect((await wiki.read({ paths: ["concepts/a.md"], heading: "nope" })).missing).toEqual(["concepts/a.md"]);
    const list = await wiki.list({ prefix: "concepts/" });
    expect(list).toEqual([
      expect.objectContaining({ path: "concepts/a.md", rev: 1, type: "concept", title: "A", tags: ["x", "y"], updated: "2026-01-02" }),
    ]);
    expect((await wiki.list({})).map((e) => e.path)).toEqual(["concepts/a.md", "entities/b.md"]);
  });
});
