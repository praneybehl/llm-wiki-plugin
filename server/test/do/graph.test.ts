import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import graphFixture from "../core/fixtures/graph.json";
import corpus from "../core/fixtures/corpus.json";
import { failure, freshWiki, importCorpus, statusOf } from "./helpers";
import type { CommitOp } from "../../src/types";
import type { WikiDO } from "../../src/do/wiki";

const gfiles = graphFixture.files as Record<string, string>;

async function graphWiki() {
  const w = await freshWiki("g");
  const ops: CommitOp[] = Object.entries(gfiles).map(([path, content]) => ({ op: "create", path, content }));
  const result = await w.wiki.commit("a", { message: "graph", ops });
  if (!result.ok) throw new Error(JSON.stringify(failure(result).error));
  await settle(w.wiki);
  return w;
}

/** Run alarms until the graph rebuild (and vector work) has no steps left. */
async function settle(wiki: DurableObjectStub<WikiDO>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (!(await runDurableObjectAlarm(wiki))) return;
  }
  throw new Error("alarms did not settle after 50 runs");
}

async function value<T = Record<string, unknown>>(p: Promise<{ ok: boolean; value?: unknown; error?: unknown }>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(JSON.stringify(failure(r).error));
  return r.value as T;
}

describe("graph", () => {
  it("builds the same graph as wiki_graph_extract.py", async () => {
    const { wiki } = await graphWiki();
    await runDurableObjectAlarm(wiki);
    const jsonl = await value<{ nodes: string; edges: string }>(wiki.graph({ op: "export", format: "jsonl" }));
    expect(jsonl.nodes).toBe(graphFixture.nodes_jsonl);
    expect(jsonl.edges).toBe(graphFixture.edges_jsonl);
    const graphml = await value<{ graphml: string }>(wiki.graph({ op: "export", format: "graphml" }));
    expect(graphml.graphml.trimEnd()).toBe(graphFixture.graphml.trimEnd());
  });

  it("answers neighbors, facts, edges and path like wiki_graph_query.py", async () => {
    const { wiki } = await graphWiki();
    const facts = await value<{ node: { id: string }; outbound: { predicate: string; object: string }[]; inbound: unknown[] }>(
      wiki.graph({ op: "facts", node: "person:ilya" }),
    );
    expect(facts.node.id).toBe("person:ilya");
    const outbound = facts.outbound.map((e) => `${e.predicate}>${e.object}`);
    expect(outbound).toEqual([...outbound].sort());
    expect(outbound).toContain("founded>company:openai");
    expect(outbound).toContain("mentions>concept:kv-cache");

    const neighbors = await value<{ neighbors: { node_id: string; title: string; out: unknown[]; in: unknown[] }[] }>(
      wiki.graph({ op: "neighbors", node: "person:ilya" }),
    );
    const openai = neighbors.neighbors.find((n) => n.node_id === "company:openai")!;
    expect(openai.title).toBe("OpenAI");
    expect(openai.out.length).toBeGreaterThan(0);
    expect(openai.in.length).toBeGreaterThan(0);

    const deep = await value<{ reachable: { node_id: string; distance: number }[] }>(wiki.graph({ op: "neighbors", node: "company:openai", depth: 2 }));
    expect(deep.reachable.find((r) => r.node_id === "concept:kv-cache")?.distance).toBe(2);

    const path = await value<{ path_nodes: string[] }>(wiki.graph({ op: "path", from: "concept:kv-cache", to: "company:openai" }));
    expect(path.path_nodes).toEqual(["concept:kv-cache", "person:ilya", "company:openai"]);
    const none = await value<{ path_nodes: string[] }>(wiki.graph({ op: "path", from: "company:openai", to: "concept:orphan-typed" }));
    expect(none.path_nodes).toEqual([]);

    const edges = await value<{ edges: { predicate: string }[] }>(wiki.graph({ op: "edges", predicate: "mentions" }));
    expect(edges.edges.length).toBeGreaterThan(0);
    expect(edges.edges.every((e) => e.predicate === "mentions")).toBe(true);

    const missing = await wiki.graph({ op: "facts", node: "nobody" });
    expect(statusOf(missing)).toBe(404);
  });

  it("keeps per-page updates equal to a full rebuild", async () => {
    const { wiki } = await graphWiki();
    await runDurableObjectAlarm(wiki);
    await wiki.commit("a", {
      message: "edit",
      ops: [{ op: "edit", path: "concepts/kv-cache.md", edits: [{ old: "Uses [[entities/ilya]] twice [[ilya]].", new: "Uses [[openai]] now." }] }],
    });
    const incremental = await value<{ nodes: string; edges: string }>(wiki.graph({ op: "export", format: "jsonl" }));
    expect(incremental.edges).toContain('"object": "company:openai", "page": "concepts/kv-cache.md"');

    // Same final files in a fresh wiki, built in one go.
    const fresh = await freshWiki("g2");
    const files = { ...gfiles };
    files["concepts/kv-cache.md"] = files["concepts/kv-cache.md"]!.replace("Uses [[entities/ilya]] twice [[ilya]].", "Uses [[openai]] now.");
    await fresh.wiki.commit("a", { message: "all", ops: Object.entries(files).map(([path, content]): CommitOp => ({ op: "create", path, content })) });
    await settle(fresh.wiki);
    const rebuilt = await value<{ nodes: string; edges: string }>(fresh.wiki.graph({ op: "export", format: "jsonl" }));
    expect(incremental).toEqual(rebuilt);

    // New page: link targets change, the graph rebuilds in the alarm (or on read).
    await wiki.commit("a", { message: "new", ops: [{ op: "create", path: "concepts/attention.md", content: "---\ntype: concept\n---\nsee [[ilya]]" }] });
    await settle(wiki);
    const after = await value<{ nodes: string }>(wiki.graph({ op: "export", format: "jsonl" }));
    expect(after.nodes).toContain('"id": "concept:attention"');
  });

  it("rebuilds after an ontology change", async () => {
    const { wiki } = await graphWiki();
    const ont = gfiles["graph/ontology.yaml"]!.replace("  company:\n    maps_from:", "  firm:\n    maps_from:");
    const rev = (await wiki.list({ prefix: "graph/" }))[0]!.rev;
    await wiki.commit("a", { message: "ont", ops: [{ op: "put", path: "graph/ontology.yaml", content: ont, base_rev: rev }] });
    await settle(wiki);
    const facts = await wiki.graph({ op: "facts", node: "firm:openai" });
    expect(facts.ok).toBe(true);
  });

  it("finishes a rebuild while commits keep arriving between alarm steps", async () => {
    // More pages than one rebuild step (GRAPH_BATCH = 200): one rebuild takes 6 steps.
    const files: Record<string, string> = {};
    for (let i = 0; i < 450; i++) {
      const id = String(i).padStart(4, "0");
      files[`concepts/p-${id}.md`] = `---\ntype: concept\n---\nSee [[p-${String((i * 7) % 450).padStart(4, "0")}]].\n`;
    }
    const commitAll = async (wiki: DurableObjectStub<WikiDO>, entries: [string, string][]): Promise<void> => {
      for (let i = 0; i < entries.length; i += 150) {
        const ops = entries.slice(i, i + 150).map(([path, content]): CommitOp => ({ op: "create", path, content }));
        const result = await wiki.commit("a", { message: "batch", ops });
        if (!result.ok) throw new Error(JSON.stringify(failure(result).error));
      }
    };
    const { wiki } = await freshWiki("gs");
    await commitAll(wiki, Object.entries(files));

    // A graph-changing commit (a new page) before every alarm step.
    for (let i = 0; i < 10; i++) {
      const path = `concepts/new-${i}.md`;
      files[path] = `---\ntype: concept\n---\nLinks [[p-0001]] and [[new-${Math.max(0, i - 1)}]].\n`;
      await commitAll(wiki, [[path, files[path]!]]);
      expect(await runDurableObjectAlarm(wiki)).toBe(true);
    }
    // The first rebuild swapped in within those 10 steps: it holds the page made before it started.
    const early = await wiki.graph({ op: "facts", node: "concept:new-0" });
    expect(early.ok).toBe(true);

    await settle(wiki);
    const fresh = await freshWiki("gs2");
    await commitAll(fresh.wiki, Object.entries(files));
    await settle(fresh.wiki);
    const live = await value<{ nodes: string; edges: string }>(wiki.graph({ op: "export", format: "jsonl" }));
    const rebuilt = await value<{ nodes: string; edges: string }>(fresh.wiki.graph({ op: "export", format: "jsonl" }));
    expect(live.nodes.split("\n")).toHaveLength(461);
    expect(live).toEqual(rebuilt);
  });
});

/**
 * Calls a WikiDO method on the instance. Going through the RPC stub makes
 * tsc expand the depth-bounded JsonBody type past its instantiation limit (TS2589).
 */
function direct<R>(wiki: DurableObjectStub<WikiDO>, fn: (instance: WikiDO) => Promise<R>): Promise<R> {
  return runInDurableObject(wiki, (instance: WikiDO) => fn(instance));
}

describe("lint and stats", () => {
  it("returns wiki_lint.py findings plus open review flags", async () => {
    const { wiki } = await freshWiki();
    await importCorpus(wiki);
    const lint = (await direct(wiki, (i) => i.lint({}))) as unknown as Record<string, unknown> & { summary: Record<string, number> };
    const expected = corpus.lint as Record<string, unknown> & { summary: Record<string, number> };
    expect(lint.summary).toEqual(expected.summary);
    expect(lint.broken_links).toEqual(expected.broken_links);
    expect(lint.orphans).toEqual(expected.orphans);
    expect(lint.missing_frontmatter).toEqual(expected.missing_frontmatter);
    expect(lint.graph).toBeNull();
    expect(lint.open_review_flags).toBe(0);
    const strict = (await direct(wiki, (i) => i.lint({ stale_days: 100_000 }))) as unknown as { stale_pages: unknown[] };
    expect(strict.stale_pages).toEqual([]);
  });

  it("adds graph lint findings when an ontology exists", async () => {
    const { wiki } = await graphWiki();
    const lint = (await direct(wiki, (i) => i.lint({}))) as unknown as { graph: Record<string, unknown> };
    expect(lint.graph).toEqual(graphFixture.lint);
  });

  it("matches wiki_stats.py counts", async () => {
    const { wiki } = await freshWiki();
    await importCorpus(wiki);
    await wiki.commit("a", { message: "i", ops: [{ op: "create", path: "index.md", content: "# Index\n\n- [[kv-cache]]\n" }] });
    const stats = (await direct(wiki, (i) => i.stats())) as unknown as Record<string, unknown> & {
      pages_by_directory: { directory: string; pages: number }[];
      largest: { path: string; lines: number }[];
      most_linked: { slug: string; count: number }[];
    };
    // Expected values from `wiki_stats.py` over the same files.
    expect(stats).toMatchObject({
      pages: 22,
      total_lines: 744,
      total_words: 2972,
      total_links: 41,
      avg_lines_per_page: 33,
      avg_words_per_page: 135,
      link_density: 1.9,
      index_lines: 4,
    });
    expect(stats.pages_by_directory[0]).toEqual({ directory: "concepts", pages: 9 });
    expect(stats.largest.slice(0, 4).map((l) => `${l.lines} ${l.path}`)).toEqual([
      "85 concepts/distributed-training.md",
      "36 entities/pytorch.md",
      "36 concepts/attention-mechanism.md",
      "35 entities/ilya-sutskever.md",
    ]);
    expect(stats.most_linked.slice(0, 4).map((l) => l.count)).toEqual([4, 4, 4, 4]);
    expect(stats.most_linked.find((l) => l.slug === "transformer")?.count).toBe(3);
    expect(stats.scaling).toEqual(["Below first threshold. Flat structure is fine."]);
  });
});
