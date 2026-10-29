import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { failure, freshWiki, sql, statusOf } from "./helpers";
import type { WikiDO } from "../../src/do/wiki";

const MAX_FILE_BYTES = 1_500_000;
/** Production SQLite in Durable Objects rejects rows above 2 MB; the local test runtime does not. */
const SQLITE_MAX_ROW_BYTES = 2_000_000;
const encoder = new TextEncoder();

/** Largest row size in bytes for every table of the DO (virtual tables skipped; their shadow tables count). */
function rowSizes(wiki: DurableObjectStub<WikiDO>): Promise<Record<string, number>> {
  return runInDurableObject(wiki, (_instance: WikiDO, state) => {
    const db = state.storage.sql;
    const sizes: Record<string, number> = {};
    const tables = db
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%'")
      .toArray();
    for (const { name } of tables) {
      const columns = db.exec<{ name: string }>(`PRAGMA table_info("${name}")`).toArray().map((c) => `ifnull(length(CAST("${c.name}" AS BLOB)), 0)`);
      sizes[name] = db.exec<{ n: number | null }>(`SELECT MAX(${columns.join(" + ")}) AS n FROM "${name}"`).one().n ?? 0;
    }
    return sizes;
  });
}

/** Calls a WikiDO method on the instance (the RPC stub types hit TS2589 for JsonBody results). */
function direct<R>(wiki: DurableObjectStub<WikiDO>, fn: (instance: WikiDO) => Promise<R>): Promise<R> {
  return runInDurableObject(wiki, (instance: WikiDO) => fn(instance));
}

describe("file size limits", () => {
  it("stores a frontmatter-heavy page close to the file limit", async () => {
    const { wiki } = await freshWiki();
    const tags = Array.from({ length: 20_000 }, (_, i) => `tag-${i}`).join(", ");
    const content = [
      "---",
      `title: ${"T".repeat(300_000)}`,
      "type: concept",
      `tags: [${tags}]`,
      // Quotes double in JSON: the stored frontmatter JSON is larger than the text.
      `notes: ${'x"'.repeat(250_000)}`,
      "---",
      "# Heavy",
      "",
      "word ".repeat(60_000),
      "",
    ].join("\n");
    const size = encoder.encode(content).byteLength;
    expect(size).toBeGreaterThan(1_300_000);
    expect(size).toBeLessThan(MAX_FILE_BYTES);

    const result = await wiki.commit("a", { message: "heavy", ops: [{ op: "create", path: "concepts/heavy.md", content }] });
    if (!result.ok) throw new Error(JSON.stringify(failure(result).error));
    const page = (await wiki.read({ paths: ["concepts/heavy.md"] })).pages[0]!;
    expect(page.content).toBe(content);
    expect(page.bytes).toBe(size);

    const listed = (await wiki.list({ prefix: "concepts/" }))[0]!;
    expect(listed.type).toBe("concept");
    expect(listed.tags[0]).toBe("tag-0");

    const hits = await wiki.search({ query: "word" });
    expect(hits.ok && hits.value.results.map((r) => r.rel_path)).toEqual(["concepts/heavy.md"]);
    const lint = await direct(wiki, (w) => w.lint({}));
    expect(lint).toBeTypeOf("object");
    const stats = await direct(wiki, (w) => w.stats());
    expect(stats).toBeTypeOf("object");
    for (let i = 0; i < 10 && (await runDurableObjectAlarm(wiki)); i++);
    const node = await wiki.graph({ op: "facts", node: "concept:heavy" });
    expect(node.ok).toBe(true);

    // Replacing the page keeps the old version as a revision.
    const next = content.replace("# Heavy", "# Heavier");
    const put = await wiki.commit("a", { message: "edit", ops: [{ op: "put", path: "concepts/heavy.md", content: next, base_rev: 1 }] });
    expect(put.ok).toBe(true);
    const old = await wiki.revision("concepts/heavy.md", 1);
    expect(old.ok && old.value.content).toBe(content);

    // Page, revision, section, FTS and graph rows all fit the production row limit.
    for (const [table, bytes] of Object.entries(await rowSizes(wiki))) {
      expect(bytes, table).toBeLessThan(SQLITE_MAX_ROW_BYTES);
    }
  });

  it("leaves a graph node out when its row would pass the row limit", async () => {
    const { wiki } = await freshWiki();
    // A scalar `tags` value becomes one tag per character in the graph node (like the Python
    // graph scripts), so this 600 KB string needs several MB of node JSON.
    const content = `---\ntype: concept\ntags: ${"t".repeat(600_000)}\n---\n# Wide\n\nSee [[other]].\n`;
    const result = await wiki.commit("a", {
      message: "wide",
      ops: [
        { op: "create", path: "concepts/wide.md", content },
        { op: "create", path: "concepts/other.md", content: "---\ntype: concept\n---\n# Other\n" },
      ],
    });
    expect(result.ok).toBe(true);
    for (let i = 0; i < 10 && (await runDurableObjectAlarm(wiki)); i++);
    expect(statusOf(await wiki.graph({ op: "facts", node: "concept:wide" }))).toBe(404);
    expect((await wiki.graph({ op: "facts", node: "concept:other" })).ok).toBe(true);
    for (const [table, bytes] of Object.entries(await rowSizes(wiki))) {
      expect(bytes, table).toBeLessThan(SQLITE_MAX_ROW_BYTES);
    }
  });

  it("stores pages whose one wikilink is almost the whole file", async () => {
    const { wiki } = await freshWiki();
    const long = "a".repeat(1_400_000);
    const result = await wiki.commit("a", {
      message: "links",
      ops: [
        { op: "create", path: "concepts/bare.md", content: `[[${long}]]\n` },
        { op: "create", path: "concepts/slash.md", content: `[[x/${long}]]\n` },
      ],
    });
    expect(result.ok).toBe(true);
    const inbound = await wiki.backlinks(long);
    expect(inbound.inbound.map((p) => p.rel_path)).toEqual(["concepts/bare.md"]);
    for (const [table, bytes] of Object.entries(await rowSizes(wiki))) {
      expect(bytes, table).toBeLessThan(SQLITE_MAX_ROW_BYTES);
    }
  });

  it("rejects a commit message that would not fit one row", async () => {
    const { wiki } = await freshWiki();
    const result = await wiki.commit("a", { message: "m".repeat(1_000_000), ops: [{ op: "create", path: "p.md", content: "p" }] });
    expect(statusOf(result)).toBe(413);
    expect((await wiki.read({ paths: ["p.md"] })).missing).toEqual(["p.md"]);
  });

  it("rejects a replace_all that would pass the file limit before it builds the text", async () => {
    const { wiki } = await freshWiki();
    const content = "a".repeat(1_000_000);
    await wiki.commit("a", { message: "c", ops: [{ op: "create", path: "big.md", content }] });
    // 1,000,000 matches x 1,000 bytes: building this text would need about 1 GB.
    const result = await wiki.commit("a", {
      message: "grow",
      ops: [{ op: "edit", path: "big.md", edits: [{ old: "a", new: "b".repeat(1000), replace_all: true }] }],
    });
    expect(statusOf(result)).toBe(413);
    expect(failure(result).error.code).toBe("too_large");
    expect((await wiki.read({ paths: ["big.md"] })).pages[0]!.rev).toBe(1);

    // A replace_all that stays under the limit still works.
    const ok = await wiki.commit("a", { message: "swap", ops: [{ op: "edit", path: "big.md", edits: [{ old: "aa", new: "b", replace_all: true }] }] });
    expect(ok.ok).toBe(true);
    expect((await wiki.read({ paths: ["big.md"] })).pages[0]!.content).toBe("b".repeat(500_000));
  });
});
