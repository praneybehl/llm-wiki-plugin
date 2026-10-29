import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FakeVectors, ageSentVectors, attachVectors, failure, freshWiki, importCorpus, sql } from "./helpers";
import type { WikiDO } from "../../src/do/wiki";
import type { SearchResponse } from "../../src/types";

async function search(wiki: Awaited<ReturnType<typeof freshWiki>>["wiki"], req: Parameters<typeof wiki.search>[0]): Promise<SearchResponse> {
  const result = await wiki.search(req);
  if (!result.ok) throw new Error(JSON.stringify(failure(result).error));
  return result.value;
}

/** Fake vectors that run `during` inside the next `embed` call, while the search awaits it. */
class GatedVectors extends FakeVectors {
  during: (() => Promise<void>) | null = null;

  override async embed(texts: string[]): Promise<number[][]> {
    const during = this.during;
    this.during = null;
    if (during) await during();
    return super.embed(texts);
  }
}

const ROW_KEYS = [
  "heading_path",
  "neighbors",
  "rel_path",
  "retrievers",
  "score",
  "section_index",
  "slug",
  "snippet",
  "sources",
  "tags",
  "title",
  "type",
  "updated",
];

describe("lexical search", () => {
  it("ranks sections with FTS5 and returns json_result rows", async () => {
    const { id, wiki } = await freshWiki();
    await importCorpus(wiki);
    const res = await search(wiki, { query: "paged attention cache" });
    expect(res).toMatchObject({ query: "paged attention cache", wiki: id, granularity: "section", mode: "lexical", vector_lag: 0 });
    const first = res.results[0]!;
    expect(Object.keys(first).sort()).toEqual(ROW_KEYS);
    expect(first.rel_path).toBe("concepts/kv-cache.md");
    expect(first.heading_path).toEqual(["KV Cache", "Paged attention"]);
    expect(first.neighbors).toEqual({ prev: "Memory growth", next: null });
    expect(first.retrievers).toEqual(["bm25"]);
    expect(first.title).toBe("KV Cache");
    expect(first.type).toBe("concept");
    expect(first.tags).toEqual(["inference", "efficiency", "attention"]);
    expect(first.score).toBeGreaterThan(0);
    expect(first.snippet).not.toMatch(/\s{2}/);
  });

  it("applies per_page, top and filters", async () => {
    const { wiki } = await freshWiki();
    await importCorpus(wiki);
    const res = await search(wiki, { query: "attention", top: 50, per_page: 1 });
    const paths = res.results.map((r) => r.rel_path);
    expect(new Set(paths).size).toBe(paths.length);
    expect((await search(wiki, { query: "attention", top: 3 })).results).toHaveLength(3);
    const typed = await search(wiki, { query: "attention", type: "source", top: 50 });
    expect(typed.results.length).toBeGreaterThan(0);
    expect(typed.results.every((r) => r.type === "source")).toBe(true);
    const tagged = await search(wiki, { query: "cache", tag: "inference", top: 50 });
    expect(tagged.results.every((r) => r.tags.includes("inference"))).toBe(true);
    const since = await search(wiki, { query: "attention", since: "2026-03-01", top: 50 });
    expect(since.results.every((r) => (r.updated ?? "") >= "2026-03-01")).toBe(true);
    expect((await search(wiki, { query: "attention", since: "2099-01-01" })).results).toEqual([]);
    expect((await search(wiki, { query: "!!!" })).results).toEqual([]);
  });

  it("excludes SCHEMA.md, index.md and log.md", async () => {
    const { wiki } = await freshWiki();
    await importCorpus(wiki);
    const res = await search(wiki, { query: "schema conventions page types", top: 50 });
    expect(res.results.some((r) => r.rel_path === "SCHEMA.md")).toBe(false);
  });

  it("searches at page granularity", async () => {
    const { wiki } = await freshWiki();
    await importCorpus(wiki);
    const res = await search(wiki, { query: "kv cache", granularity: "page" });
    expect(res.granularity).toBe("page");
    const first = res.results[0]!;
    expect(first.rel_path).toBe("concepts/kv-cache.md");
    expect(first.section_index).toBeNull();
    expect(first.heading_path).toEqual([]);
    expect(first.neighbors).toEqual({ prev: null, next: null });
    expect(first.snippet.startsWith("# KV Cache During autoregressive decoding")).toBe(true);
  });

  it("updates search data on edit and delete", async () => {
    const { wiki } = await freshWiki();
    await wiki.commit("a", { message: "c", ops: [{ op: "create", path: "concepts/z.md", content: "# Zeta\n\nzebra stripes\n" }] });
    expect((await search(wiki, { query: "zebra" })).results).toHaveLength(1);
    await wiki.commit("a", { message: "e", ops: [{ op: "edit", path: "concepts/z.md", edits: [{ old: "zebra", new: "okapi" }] }] });
    expect((await search(wiki, { query: "zebra" })).results).toHaveLength(0);
    expect((await search(wiki, { query: "okapi" })).results).toHaveLength(1);
    await wiki.commit("a", { message: "d", ops: [{ op: "delete", path: "concepts/z.md", base_rev: 2 }] });
    expect((await search(wiki, { query: "okapi" })).results).toHaveLength(0);
    expect(await sql(wiki, "SELECT * FROM sections")).toHaveLength(0);
  });
});

describe("hybrid search", () => {
  it("embeds pending sections in the alarm and fuses with RRF", async () => {
    const { id, wiki } = await freshWiki();
    const fake = new FakeVectors();
    await attachVectors(wiki, fake);
    await importCorpus(wiki);
    const before = await wiki.overview();
    expect(before.vectors_enabled).toBe(true);
    expect(before.vector_lag).toBe(before.sections);
    // Embed and send every section, then confirm them once the index serves them.
    const states = async () => (await sql<{ s: number; n: number }>(wiki, "SELECT vec_state AS s, COUNT(*) AS n FROM sections GROUP BY vec_state ORDER BY s"));
    while ((await states())[0]!.s === 0) expect(await runDurableObjectAlarm(wiki)).toBe(true);
    expect(await states()).toEqual([{ s: 1, n: before.sections }]);
    expect((await wiki.overview()).vector_lag).toBe(before.sections);
    // Too young to check: the alarm leaves sent vectors alone.
    expect(await runDurableObjectAlarm(wiki)).toBe(true);
    expect(await states()).toEqual([{ s: 1, n: before.sections }]);
    await ageSentVectors(wiki, 31_000);
    while ((await wiki.overview()).vector_lag > 0) expect(await runDurableObjectAlarm(wiki)).toBe(true);
    expect(await states()).toEqual([{ s: 2, n: before.sections }]);
    expect(await runDurableObjectAlarm(wiki)).toBe(false);
    expect(fake.store.size).toBe(before.sections);
    expect([...fake.store.values()].every((v) => v.namespace === id)).toBe(true);

    const res = await search(wiki, { query: "paged attention cache" });
    expect(res.mode).toBe("hybrid");
    expect(res.vector_lag).toBe(0);
    const both = res.results.find((r) => r.retrievers.length === 2);
    expect(both?.retrievers).toEqual(["bm25", "embedding"]);
    expect(res.results[0]!.score).toBeLessThanOrEqual(2 / 61 + 1e-4);

    const lexical = await search(wiki, { query: "paged attention cache", mode: "lexical" });
    expect(lexical.mode).toBe("lexical");
  });

  it("scores ranks exactly like cmd_search", async () => {
    const { wiki } = await freshWiki();
    const fake = new FakeVectors();
    await attachVectors(wiki, fake);
    await wiki.commit("a", {
      message: "c",
      ops: [
        { op: "create", path: "concepts/one.md", content: "# One\n\nalpha beta\n" },
        { op: "create", path: "concepts/two.md", content: "# Two\n\nalpha\n" },
        { op: "create", path: "concepts/three.md", content: "# Three\n\ngamma\n" },
      ],
    });
    await runDurableObjectAlarm(wiki);
    const ids = await sql<{ path: string; vector_id: string }>(wiki, "SELECT path, vector_id FROM sections WHERE section_index = 1");
    const vid = (p: string) => ids.find((r) => r.path === p)!.vector_id;
    // Embedding order: three, two (one below the 0.65 floor).
    fake.pinned = [
      { id: vid("concepts/three.md"), score: 0.9 },
      { id: vid("concepts/two.md"), score: 0.8 },
      { id: vid("concepts/one.md"), score: 0.5 },
    ];
    const res = await search(wiki, { query: "alpha beta" });
    const lexicalOrder = (await search(wiki, { query: "alpha beta", mode: "lexical" })).results.map((r) => r.rel_path);
    expect(lexicalOrder).toEqual(["concepts/one.md", "concepts/two.md"]);
    const scores = Object.fromEntries(res.results.map((r) => [r.rel_path, r.score]));
    const round = (x: number) => Math.round(x * 1e4) / 1e4;
    expect(scores["concepts/two.md"]).toBe(round(1 / 62 + 1 / 62));
    expect(scores["concepts/one.md"]).toBe(round(1 / 61));
    expect(scores["concepts/three.md"]).toBe(round(1 / 61));
    expect(res.results.map((r) => r.rel_path)).toEqual(["concepts/two.md", "concepts/one.md", "concepts/three.md"]);
  });

  it("keeps vectors of unchanged sections and deletes stale ones", async () => {
    const { wiki } = await freshWiki();
    const fake = new FakeVectors();
    await attachVectors(wiki, fake);
    await wiki.commit("a", { message: "c", ops: [{ op: "create", path: "concepts/v.md", content: "# V\n\n## Keep\n\nsame\n\n## Change\n\nold\n" }] });
    await runDurableObjectAlarm(wiki);
    await ageSentVectors(wiki, 31_000);
    await runDurableObjectAlarm(wiki);
    expect((await wiki.overview()).vector_lag).toBe(0);
    const initial = new Set(fake.store.keys());
    await wiki.commit("a", { message: "e", ops: [{ op: "edit", path: "concepts/v.md", edits: [{ old: "old", new: "new" }] }] });
    // Unchanged sections keep their confirmed vectors.
    expect((await wiki.overview()).vector_lag).toBe(1);
    await runDurableObjectAlarm(wiki);
    const after = new Set(fake.store.keys());
    expect(after.size).toBe(initial.size);
    expect([...initial].filter((k) => after.has(k))).toHaveLength(initial.size - 1);
  });

  it("deletes the vectors of pages that are deleted, moved or leave search", async () => {
    const { wiki } = await freshWiki();
    const fake = new FakeVectors();
    await attachVectors(wiki, fake);
    await wiki.commit("a", {
      message: "c",
      ops: [
        { op: "create", path: "concepts/del.md", content: "# Del\n\ngone\n" },
        { op: "create", path: "concepts/out.md", content: "# Out\n\nexcluded\n" },
        { op: "create", path: "concepts/mv.md", content: "# Mv\n\nmoved\n" },
      ],
    });
    await runDurableObjectAlarm(wiki);
    expect(fake.store.size).toBe(6);
    await wiki.commit("a", {
      message: "d",
      ops: [
        { op: "delete", path: "concepts/del.md", base_rev: 1 },
        { op: "move", from: "concepts/out.md", to: "raw/out.md", base_rev: 1 },
        { op: "move", from: "concepts/mv.md", to: "concepts/moved.md", base_rev: 1 },
      ],
    });
    for (let i = 0; i < 5 && (await runDurableObjectAlarm(wiki)); i++);
    const live = (await sql<{ vector_id: string }>(wiki, "SELECT vector_id FROM sections")).map((r) => r.vector_id).sort();
    expect(live).toHaveLength(2);
    expect([...fake.store.keys()].sort()).toEqual(live);
    expect(await sql(wiki, "SELECT vector_id FROM vector_deletes")).toEqual([]);
  });

  it("re-sends a vector that Vectorize accepted but never stored, then confirms it", async () => {
    const { wiki } = await freshWiki();
    const fake = new FakeVectors();
    await attachVectors(wiki, fake);
    await wiki.commit("a", { message: "c", ops: [{ op: "create", path: "concepts/lost.md", content: "# Lost\n\nfirst batch\n" }] });
    fake.dropUpserts = 1;
    expect(await runDurableObjectAlarm(wiki)).toBe(true);
    expect(fake.upsertCalls).toBe(1);
    expect(fake.store.size).toBe(0);
    const lag = async () => (await wiki.overview()).vector_lag;
    expect(await lag()).toBe(2);

    // Checked after 30 s: missing, but not old enough to re-send yet.
    await ageSentVectors(wiki, 31_000);
    expect(await runDurableObjectAlarm(wiki)).toBe(true);
    expect(await sql(wiki, "SELECT vec_state FROM sections WHERE vec_state != 1")).toEqual([]);
    expect(fake.upsertCalls).toBe(1);
    expect(await lag()).toBe(2);

    // Still missing after 10 minutes: pending again, then embedded and sent once more.
    await ageSentVectors(wiki, 600_000);
    expect(await runDurableObjectAlarm(wiki)).toBe(true);
    expect(await sql(wiki, "SELECT vec_state FROM sections WHERE vec_state != 0")).toEqual([]);
    expect(await runDurableObjectAlarm(wiki)).toBe(true);
    expect(fake.upsertCalls).toBe(2);
    expect(fake.store.size).toBe(2);
    expect(await lag()).toBe(2);

    await ageSentVectors(wiki, 31_000);
    expect(await runDurableObjectAlarm(wiki)).toBe(true);
    expect(await lag()).toBe(0);
    expect(await sql(wiki, "SELECT vec_state FROM sections WHERE vec_state != 2")).toEqual([]);
    expect(await runDurableObjectAlarm(wiki)).toBe(false);
  });

  it("searches sent and confirmed vectors, not pending ones", async () => {
    const { wiki } = await freshWiki();
    const fake = new FakeVectors();
    await attachVectors(wiki, fake);
    await wiki.commit("a", { message: "c", ops: [{ op: "create", path: "concepts/confirmed.md", content: "# Confirmed\n\none\n" }] });
    await runDurableObjectAlarm(wiki);
    await ageSentVectors(wiki, 31_000);
    await runDurableObjectAlarm(wiki);
    await wiki.commit("a", { message: "c", ops: [{ op: "create", path: "concepts/sent.md", content: "# Sent\n\ntwo\n" }] });
    await runDurableObjectAlarm(wiki);
    await wiki.commit("a", { message: "c", ops: [{ op: "create", path: "concepts/pending.md", content: "# Pending\n\nthree\n" }] });
    const rows = await sql<{ path: string; vector_id: string; vec_state: number }>(wiki, "SELECT path, vector_id, vec_state FROM sections WHERE section_index = 1 ORDER BY path");
    expect(rows.map((r) => [r.path, r.vec_state])).toEqual([
      ["concepts/confirmed.md", 2],
      ["concepts/pending.md", 0],
      ["concepts/sent.md", 1],
    ]);
    fake.pinned = rows.map((r, i) => ({ id: r.vector_id, score: 0.9 - i * 0.01 }));
    const res = await search(wiki, { query: "nomatch" });
    expect(res.mode).toBe("hybrid");
    expect(res.results.map((r) => [r.rel_path, r.retrievers])).toEqual([
      ["concepts/confirmed.md", ["embedding"]],
      ["concepts/sent.md", ["embedding"]],
    ]);
  });

  it("migrates an object from the build without send times and checks its old vectors", async () => {
    const { id, wiki: before } = await freshWiki();
    let wiki = before;
    const fake = new FakeVectors();
    await attachVectors(wiki, fake);
    await wiki.commit("a", { message: "c", ops: [{ op: "create", path: "concepts/old.md", content: "# Old\n\nkept\n\n## Lost\n\ndropped\n" }] });
    await runDurableObjectAlarm(wiki);
    // Simulate the earlier build: no send-time columns, every vector marked done (state 1),
    // and one upsert that Vectorize never applied.
    const lost = (await sql<{ vector_id: string }>(wiki, "SELECT vector_id FROM sections WHERE section_index = 2"))[0]!.vector_id;
    fake.store.delete(lost);
    await runInDurableObject(wiki, (_instance: WikiDO, state) => {
      state.storage.sql.exec("ALTER TABLE sections DROP COLUMN vec_sent_at");
      state.storage.sql.exec("ALTER TABLE sections DROP COLUMN vec_checked_at");
      state.storage.sql.exec("UPDATE sections SET vec_state = 1");
    });
    // Reopen: abort the instance; a new stub gets a new instance, whose constructor
    // runs the schema and the migration on the old data.
    await runInDurableObject(wiki, (_instance: WikiDO, state) => {
      try {
        state.abort("reopen");
      } catch {
        // abort() throws to end the current request.
      }
    }).catch(() => undefined);
    wiki = env.WIKI.get(env.WIKI.idFromName(id));
    await attachVectors(wiki, fake);
    expect(await sql(wiki, "SELECT vec_state, vec_sent_at, vec_checked_at FROM sections ORDER BY section_index")).toEqual([
      { vec_state: 1, vec_sent_at: 0, vec_checked_at: null },
      { vec_state: 1, vec_sent_at: 0, vec_checked_at: null },
      { vec_state: 1, vec_sent_at: 0, vec_checked_at: null },
    ]);
    expect((await wiki.overview()).vector_lag).toBe(3);

    // The next alarm checks them at once: the served ones confirm, the lost one goes back to pending.
    await wiki.commit("a", { message: "touch", ops: [{ op: "create", path: "concepts/new.md", content: "# New\n\nfresh\n" }] });
    for (let i = 0; i < 3; i++) await runDurableObjectAlarm(wiki);
    expect(fake.store.has(lost)).toBe(true);
    await ageSentVectors(wiki, 31_000);
    await runDurableObjectAlarm(wiki);
    expect((await wiki.overview()).vector_lag).toBe(0);
  });

  it("reads search rows after the vector awaits, so a concurrent commit cannot swap section ids", async () => {
    const { wiki } = await freshWiki();
    const fake = new GatedVectors();
    await attachVectors(wiki, fake);
    await wiki.commit("a", { message: "c", ops: [{ op: "create", path: "concepts/a.md", content: "# A\n\nzebra quokka\n" }] });
    await runDurableObjectAlarm(wiki);
    const ids = (await sql<{ id: number }>(wiki, "SELECT id FROM sections ORDER BY id")).map((r) => r.id);

    // During the embedding await: delete the matching page and create another.
    // The new sections reuse the freed row ids.
    let swapped = false;
    await runInDurableObject(wiki, (instance: WikiDO) => {
      fake.during = async () => {
        const swap = await instance.commit("a", {
          message: "swap",
          ops: [
            { op: "delete", path: "concepts/a.md", base_rev: 1 },
            { op: "create", path: "concepts/b.md", content: "# B\n\nunrelated words\n" },
          ],
        });
        swapped = swap.ok;
      };
    });
    const result = await wiki.search({ query: "zebra quokka" });
    expect(swapped).toBe(true);
    expect((await sql<{ id: number }>(wiki, "SELECT id FROM sections ORDER BY id")).map((r) => r.id)).toEqual(ids);
    if (!result.ok) throw new Error(JSON.stringify(failure(result).error));
    expect(result.value.mode).toBe("hybrid");
    expect(result.value.results.map((r) => r.rel_path)).toEqual([]);
  });

  it("retries embedding failures with backoff and falls back to lexical", async () => {
    const { wiki } = await freshWiki();
    const fake = new FakeVectors();
    await attachVectors(wiki, fake);
    await wiki.commit("a", { message: "c", ops: [{ op: "create", path: "concepts/f.md", content: "# F\n\nfailure text\n" }] });
    fake.failNext = true;
    await runDurableObjectAlarm(wiki);
    expect((await wiki.overview()).vector_lag).toBe(2);
    expect((await sql<{ value: string }>(wiki, "SELECT value FROM meta WHERE key = 'vector_failures'"))[0]!.value).toBe("1");
    await runDurableObjectAlarm(wiki);
    expect((await wiki.overview()).vector_lag).toBe(2);
    await ageSentVectors(wiki, 31_000);
    await runDurableObjectAlarm(wiki);
    expect((await wiki.overview()).vector_lag).toBe(0);
    fake.failNext = true;
    const res = await search(wiki, { query: "failure" });
    expect(res.mode).toBe("lexical");
    expect(res.results).toHaveLength(1);
  });
});

describe("links", () => {
  it("resolves backlinks for bare and path-qualified targets", async () => {
    const { wiki } = await freshWiki();
    await importCorpus(wiki);
    const bare = await wiki.backlinks("openai");
    const qualified = await wiki.backlinks("entities/openai");
    expect(qualified).toEqual(bare);
    expect(bare.target).toBe("openai");
    expect(bare.inbound.map((p) => p.rel_path)).toContain("concepts/quirks.md");
    expect(bare.inbound.every((p) => p.slug && p.title)).toBe(true);
    const raw = await wiki.backlinks("raw/foo");
    expect(raw).toEqual({ target: "raw/foo", inbound: [expect.objectContaining({ rel_path: "concepts/quirks.md" })] });
  });

  it("counts top-linked pages by resolved key", async () => {
    const { wiki } = await freshWiki();
    await wiki.commit("a", {
      message: "c",
      ops: [
        { op: "create", path: "entities/hub.md", content: "---\ntitle: Hub Page\n---\nhub" },
        { op: "create", path: "a.md", content: "[[hub]] [[entities/hub]] [[ghost]]" },
        { op: "create", path: "b.md", content: "[[entities/hub.md|Hub]] [[ghost]] [[raw/x]]" },
      ],
    });
    const top = await wiki.topLinked(10);
    expect(top).toEqual([
      { slug: "hub", rel_path: "entities/hub.md", title: "Hub Page", inbound: 3 },
      { slug: "ghost", rel_path: null, title: "ghost", inbound: 2 },
      { slug: "raw/x", rel_path: null, title: "raw/x", inbound: 1 },
    ]);
  });
});
