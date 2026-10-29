// Parity with the Python scripts. Fixtures come from running
// skills/llm-wiki/scripts/wiki_search.py, wiki_lint.py, wiki_graph_extract.py
// and wiki_graph_lint.py over eval/retrieval/corpus plus edge-case pages.
import { describe, expect, it } from "vitest";
import corpus from "./fixtures/corpus.json";
import graphFixture from "./fixtures/graph.json";
import { cachePageBody, fuseRrf, splitSections } from "../../src/core/bm25";
import { parseFrontmatter } from "../../src/core/frontmatter";
import { buildLinkIndex, linkKey, resolveLink } from "../../src/core/links";
import { lintPages, type LintPage } from "../../src/core/lint";
import { buildGraph, edgeRow, exportGraphml, exportJsonl, graphPageFromText, nodeRow, parseOntology } from "../../src/core/graph";
import { graphLint } from "../../src/core/graph-lint";
import { isSearchable, isTopLevelReadme, slugOf } from "../../src/core/paths";
import { derivePage } from "../../src/do/derive";

const files = corpus.files as Record<string, string>;
const searchable = Object.keys(files).filter(isSearchable).sort();

describe("split_sections parity", () => {
  for (const path of searchable) {
    it(path, () => {
      const { meta, body } = parseFrontmatter(files[path]!);
      const title = typeof meta.title === "string" && meta.title ? meta.title : slugOf(path);
      const sections = splitSections(title, body).map((s) => ({
        heading_path: s.headingPath,
        level: s.level,
        text: s.text,
        section_index: s.sectionIndex,
      }));
      expect(sections).toEqual((corpus.sections as Record<string, unknown>)[path]);
      expect(cachePageBody(splitSections(title, body))).toBe((corpus.cache_body as Record<string, string>)[path]);
    });
  }

  it("keeps headings inside fences and nested levels", () => {
    const sections = (corpus.sections as Record<string, { heading_path: string[] }[]>)["concepts/fences.md"]!;
    expect(sections.map((s) => s.heading_path)).toEqual([[], ["Example"], ["Example", "Nested"], ["Top again"], ["Top again", "Skip level"]]);
  });
});

describe("frontmatter parity", () => {
  for (const path of searchable) {
    it(path, () => {
      expect(parseFrontmatter(files[path]!).meta).toEqual((corpus.meta as Record<string, unknown>)[path]);
    });
  }
});

describe("resolve_link parity", () => {
  const index = buildLinkIndex(searchable.map((path) => ({ path, slug: slugOf(path) })));
  for (const path of searchable) {
    const expected = (corpus.links as Record<string, { link: string; resolved: string | null; key: string }[]>)[path] ?? [];
    if (expected.length === 0) continue;
    it(path, () => {
      const links = derivePage(path, files[path]!).links;
      expect(links).toEqual(expected.map((e) => e.link));
      for (const e of expected) {
        expect(resolveLink(e.link, index)).toBe(e.resolved);
        expect(linkKey(e.link, index)).toBe(e.key);
      }
    });
  }

  it("treats a directory prefix as a constraint", () => {
    expect(resolveLink("raw/foo", index)).toBeNull();
    expect(resolveLink("entities/openai", index)).toBe("openai");
    expect(resolveLink("sources/openai", index)).toBeNull();
    expect(resolveLink("/entities/openai.md#Intro", index)).toBe("openai");
    expect(resolveLink("OpenAI", index)).toBeNull();
  });
});

describe("wiki_lint parity", () => {
  it("matches the Python findings", () => {
    const pages: LintPage[] = searchable
      .filter((path) => !isTopLevelReadme(path))
      .map((path) => {
        const d = derivePage(path, files[path]!);
        return { path, slug: d.slug, meta: d.meta, malformed: d.malformed, lineCount: d.lineCount, links: d.links };
      });
    const findings = lintPages(pages, { today: corpus.today });
    expect(findings).toEqual(corpus.lint);
  });
});

describe("graph parity", () => {
  const gfiles = graphFixture.files as Record<string, string>;
  const pages = Object.keys(gfiles)
    .filter((path) => isSearchable(path))
    .sort()
    .map((path) => graphPageFromText(path, slugOf(path), gfiles[path]!));
  const { ontology, error } = parseOntology(gfiles["graph/ontology.yaml"]!);

  it("parses the ontology", () => {
    expect(error).toBeNull();
    expect(Object.keys(ontology.node_types)).toContain("person");
  });

  it("extracts the same nodes and edges", () => {
    const { nodes, edges } = buildGraph(pages, ontology);
    const jsonl = exportJsonl(nodes, edges);
    expect(jsonl.nodes).toBe(graphFixture.nodes_jsonl);
    expect(jsonl.edges).toBe(graphFixture.edges_jsonl);
    const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : 1);
    expect(nodes.map(nodeRow).sort(byId)).toEqual(graphFixture.node_rows);
    expect(edges.map(edgeRow).sort(byId)).toEqual(graphFixture.edge_rows);
  });

  it("writes the same GraphML", () => {
    const { nodes, edges } = buildGraph(pages, ontology);
    expect(exportGraphml(nodes, edges).trimEnd()).toBe(graphFixture.graphml.trimEnd());
  });

  it("finds the same graph lint findings", () => {
    expect(graphLint(pages, ontology)).toEqual(graphFixture.lint);
  });
});

describe("rrf fusion", () => {
  it("scores 1/(60+rank) per retriever and keeps lexical order on ties", () => {
    const fused = fuseRrf(["a", "b", "c"], ["c", "d"]);
    expect(fused.map((r) => r.key)).toEqual(["c", "a", "b", "d"]);
    expect(fused[0]!.score).toBeCloseTo(1 / 63 + 1 / 61, 12);
    expect(fused[0]!.retrievers).toEqual(["bm25", "embedding"]);
    expect(fused.find((r) => r.key === "d")!.retrievers).toEqual(["embedding"]);
  });

  it("fuses only the lexical top 50", () => {
    const lexical = Array.from({ length: 60 }, (_, i) => `l${i}`);
    expect(fuseRrf(lexical, []).length).toBe(50);
  });
});
