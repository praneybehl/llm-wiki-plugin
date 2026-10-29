/**
 * Graph layer: TS port of skills/llm-wiki/scripts/wiki_graph_extract.py
 * (nodes, typed edges, mentions, sourced_from, summarizes_raw),
 * wiki_graph_query.py (neighbors, edges, facts, path) and the jsonl /
 * graphml writers. Frontmatter and the ontology parse with `yaml`, like the
 * Python scripts parse with PyYAML.
 */

import { parse as parseYaml } from "yaml";
import { extractWikilinks } from "./frontmatter";
import { buildLinkIndex, resolveLink, type LinkIndex } from "./links";
import { sha256Hex } from "./hash";

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;
const GRAPH_META_KEYS = ["type", "kind", "title", "tags", "created", "updated", "sources", "raw", "graph"];

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface Ontology {
  node_types: Record<string, Json>;
  predicates: Record<string, Json>;
}

/** Per-page input to the graph builder; stored as JSON on the page row. */
export interface GraphPage {
  path: string;
  slug: string;
  meta: JsonObject;
  links: string[];
}

export interface GraphNode {
  id: string;
  slug: string;
  title: string;
  page_type: Json;
  node_type: string;
  kind: Json;
  tags: Json[];
  aliases: Json[];
  path: string;
  created: Json;
  updated: Json;
  canonical: boolean;
}

export interface GraphEdge {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  source: Json;
  evidence: Json;
  confidence: Json;
  status: Json;
  extraction_method: string;
  page: string;
  extras: JsonObject;
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python truthiness for JSON values. */
export function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return true;
}

/** Python `str()` for JSON scalars. */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/** Python iteration over `value or []`: lists, string characters, dict keys. */
export function pyIter(value: unknown): Json[] {
  if (!truthy(value)) return [];
  if (Array.isArray(value)) return value as Json[];
  if (typeof value === "string") return Array.from(value);
  if (isObject(value)) return Object.keys(value);
  return [];
}

/** PyYAML-style frontmatter parse: `{}` on any error or non-mapping. */
export function parseYamlFrontmatter(text: string): { meta: JsonObject; body: string } {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return { meta: {}, body: text };
  const body = text.slice(m[0].length);
  let meta: unknown;
  try {
    meta = parseYaml(m[1] ?? "");
  } catch {
    meta = {};
  }
  return { meta: isObject(meta) ? meta : {}, body };
}

/** Graph input for one page; keeps only the frontmatter keys the graph reads. */
export function graphPageFromText(path: string, slug: string, text: string): GraphPage {
  const { meta, body } = parseYamlFrontmatter(text);
  const subset: JsonObject = {};
  for (const key of GRAPH_META_KEYS) {
    if (key in meta) subset[key] = jsonSafe(meta[key]);
  }
  return { path, slug, meta: subset, links: extractWikilinks(body) };
}

function jsonSafe(value: unknown): Json {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) out[key] = jsonSafe(item);
    return out;
  }
  if (typeof value === "bigint") return Number(value);
  if (value === undefined) return null;
  return value as Json;
}

export function parseOntology(text: string | null): { ontology: Ontology; error: string | null } {
  const empty: Ontology = { node_types: {}, predicates: {} };
  if (text === null) return { ontology: empty, error: null };
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (error) {
    return { ontology: empty, error: error instanceof Error ? error.message : String(error) };
  }
  const safe = jsonSafe(data ?? {});
  if (!isObject(safe)) return { ontology: empty, error: "ontology is not a mapping" };
  return {
    ontology: {
      node_types: isObject(safe.node_types) ? safe.node_types : {},
      predicates: isObject(safe.predicates) ? safe.predicates : {},
    },
    error: null,
  };
}

export function graphMeta(meta: JsonObject): JsonObject {
  return isObject(meta.graph) ? meta.graph : {};
}

export function deriveNodeType(meta: JsonObject, ontology: Ontology): string | null {
  const explicit = graphMeta(meta).node_type;
  if (truthy(explicit)) return pyStr(explicit);
  let typeOnly: string | null = null;
  for (const [name, def] of Object.entries(ontology.node_types)) {
    const maps = isObject(def) && isObject(def.maps_from) ? def.maps_from : {};
    const mType = maps.type;
    const mKind = maps.kind;
    if (truthy(mType) && mType === meta.type) {
      if (truthy(mKind) && mKind === meta.kind) return name;
      if (!truthy(mKind) && typeOnly === null) typeOnly = name;
    }
  }
  return typeOnly;
}

export function deriveNodeId(meta: JsonObject, slug: string, ontology: Ontology): string {
  const explicit = graphMeta(meta).node_id;
  if (truthy(explicit)) return pyStr(explicit);
  return `${deriveNodeType(meta, ontology) ?? "concept"}:${slug}`;
}

export function buildNode(page: GraphPage, ontology: Ontology): GraphNode {
  const meta = page.meta;
  const gm = graphMeta(meta);
  const nodeType = deriveNodeType(meta, ontology) ?? "concept";
  return {
    id: truthy(gm.node_id) ? pyStr(gm.node_id) : `${nodeType}:${page.slug}`,
    slug: page.slug,
    title: truthy(meta.title) ? pyStr(meta.title) : page.slug,
    page_type: truthy(meta.type) ? (meta.type ?? "") : "",
    node_type: nodeType,
    kind: truthy(meta.kind) ? (meta.kind ?? "") : "",
    tags: pyIter(meta.tags),
    aliases: pyIter(gm.aliases),
    path: page.path,
    created: truthy(meta.created) ? (meta.created ?? "") : "",
    updated: truthy(meta.updated) ? (meta.updated ?? "") : "",
    canonical: truthy(gm.canonical ?? false),
  };
}

export function buildNodes(pages: GraphPage[], ontology: Ontology): { nodes: GraphNode[]; slugToId: Map<string, string> } {
  const nodes: GraphNode[] = [];
  const slugToId = new Map<string, string>();
  const seen = new Set<string>();
  for (const page of pages) {
    const node = buildNode(page, ontology);
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    nodes.push(node);
    slugToId.set(page.slug, node.id);
  }
  return { nodes, slugToId };
}

export function edgeId(subject: string, predicate: string, obj: string, source: Json, evidence: Json): string {
  const parts = [subject, predicate, obj, truthy(source) ? pyStr(source) : "", truthy(evidence) ? pyStr(evidence) : ""];
  return sha256Hex(parts.join("\x1f")).slice(0, 24);
}

function makeEdge(args: {
  subject: string;
  predicate: string;
  obj: string;
  source: Json;
  evidence: Json;
  confidence: Json;
  status: Json;
  method: string;
  page: string;
  extras?: JsonObject;
}): GraphEdge {
  return {
    id: edgeId(args.subject, args.predicate, args.obj, args.source, args.evidence),
    subject: args.subject,
    predicate: args.predicate,
    object: args.obj,
    source: truthy(args.source) ? args.source : "",
    evidence: truthy(args.evidence) ? args.evidence : "",
    confidence: truthy(args.confidence) ? args.confidence : "",
    status: truthy(args.status) ? args.status : "",
    extraction_method: args.method,
    page: args.page,
    extras: args.extras ?? {},
  };
}

/** Lookups the edge builder needs: slug -> node id and wikilink resolution. */
export interface EdgeLookup {
  idForSlug(slug: string): string | undefined;
  resolve(link: string): string | null;
}

export function mapLookup(pages: GraphPage[], slugToId: Map<string, string>): EdgeLookup {
  const index: LinkIndex = buildLinkIndex(pages);
  // Python resolves bare links against slug_to_id keys (kept nodes only).
  const resolver: LinkIndex = { byPath: index.byPath, bySlug: new Set(slugToId.keys()) };
  return {
    idForSlug: (slug) => slugToId.get(slug),
    resolve: (link) => resolveLink(link, resolver),
  };
}

const EXTRA_KEYS = ["valid_from", "valid_to", "notes", "raw_ref", "contradicts", "supersedes"];

/** Edges declared by one page (deduplicated within the page). */
export function buildPageEdges(page: GraphPage, lookup: EdgeLookup): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const push = (edge: GraphEdge): void => {
    if (seen.has(edge.id)) return;
    seen.add(edge.id);
    edges.push(edge);
  };
  const subject = lookup.idForSlug(page.slug);
  if (!subject) return edges;
  const meta = page.meta;
  const gm = graphMeta(meta);

  for (const rel of pyIter(gm.relationships)) {
    if (!isObject(rel)) continue;
    const obj = rel.object;
    const predicate = rel.predicate;
    if (!(truthy(obj) && truthy(predicate))) continue;
    const extras: JsonObject = {};
    for (const key of EXTRA_KEYS) {
      if (key in rel && rel[key] !== null && rel[key] !== undefined) extras[key] = rel[key]!;
    }
    push(
      makeEdge({
        subject,
        predicate: pyStr(predicate),
        obj: pyStr(obj),
        source: rel.source ?? null,
        evidence: rel.evidence ?? null,
        confidence: rel.confidence ?? null,
        status: rel.status ?? null,
        method: "explicit_graph_frontmatter",
        page: page.path,
        extras,
      }),
    );
  }

  const seenTargets = new Set<string>();
  for (const link of page.links) {
    const targetSlug = lookup.resolve(link);
    if (!targetSlug || targetSlug === page.slug) continue;
    const targetId = lookup.idForSlug(targetSlug);
    if (!targetId || seenTargets.has(targetId)) continue;
    seenTargets.add(targetId);
    push(
      makeEdge({
        subject,
        predicate: "mentions",
        obj: targetId,
        source: null,
        evidence: null,
        confidence: "low",
        status: "current",
        method: "body_wikilink",
        page: page.path,
      }),
    );
  }

  if (meta.type !== "source") {
    for (const src of pyIter(meta.sources)) {
      const srcId = lookup.idForSlug(pyStr(src));
      if (!srcId) continue;
      push(
        makeEdge({
          subject,
          predicate: "sourced_from",
          obj: srcId,
          source: pyStr(src),
          evidence: null,
          confidence: "high",
          status: "current",
          method: "frontmatter_sources",
          page: page.path,
        }),
      );
    }
  } else if (truthy(meta.raw)) {
    push(
      makeEdge({
        subject,
        predicate: "summarizes_raw",
        obj: `raw:${pyStr(meta.raw)}`,
        source: null,
        evidence: null,
        confidence: "high",
        status: "current",
        method: "frontmatter_raw",
        page: page.path,
      }),
    );
  }
  return edges;
}

/** Full extraction over pages sorted by path, like `wiki_graph_extract.py`. */
export function buildGraph(pages: GraphPage[], ontology: Ontology): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const sorted = [...pages].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const { nodes, slugToId } = buildNodes(sorted, ontology);
  const lookup = mapLookup(sorted, slugToId);
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const page of sorted) {
    for (const edge of buildPageEdges(page, lookup)) {
      if (seen.has(edge.id)) continue;
      seen.add(edge.id);
      edges.push(edge);
    }
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// SQLite row shapes (same columns as graph.sqlite written by the extractor)
// ---------------------------------------------------------------------------

export interface NodeRow {
  id: string;
  slug: string;
  title: string;
  page_type: string;
  node_type: string;
  kind: string | null;
  path: string;
  created: string | null;
  updated: string | null;
  metadata_json: string;
}

export interface EdgeRow {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  source: string | null;
  evidence: string | null;
  confidence: string | null;
  status: string | null;
  extraction_method: string;
  page: string;
  metadata_json: string;
}

function emptyToNull(value: Json): string | null {
  const text = truthy(value) ? pyStr(value) : "";
  return text === "" ? null : text;
}

export function nodeRow(node: GraphNode): NodeRow {
  return {
    id: node.id,
    slug: node.slug,
    title: node.title,
    page_type: pyStr(node.page_type),
    node_type: node.node_type,
    kind: emptyToNull(node.kind),
    path: node.path,
    created: emptyToNull(node.created),
    updated: emptyToNull(node.updated),
    metadata_json: pyJsonDumps({ tags: node.tags, aliases: node.aliases, canonical: node.canonical }),
  };
}

export function edgeRow(edge: GraphEdge): EdgeRow {
  return {
    id: edge.id,
    subject: edge.subject,
    predicate: edge.predicate,
    object: edge.object,
    source: emptyToNull(edge.source),
    evidence: emptyToNull(edge.evidence),
    confidence: emptyToNull(edge.confidence),
    status: emptyToNull(edge.status),
    extraction_method: edge.extraction_method,
    page: edge.page,
    metadata_json: pyJsonDumps(edge.extras),
  };
}

/** `json.dumps(value, sort_keys=True, ensure_ascii=False)`. */
export function pyJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return String(value);
    return Number.isFinite(value) ? String(value) : value > 0 ? "Infinity" : value < 0 ? "-Infinity" : "NaN";
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pyJsonDumps).join(", ")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}: ${pyJsonDumps(item)}`).join(", ")}}`;
}

// ---------------------------------------------------------------------------
// Export writers
// ---------------------------------------------------------------------------

const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function exportJsonl(nodes: GraphNode[], edges: GraphEdge[]): { nodes: string; edges: string } {
  const lines = (items: unknown[]): string => items.map((item) => `${pyJsonDumps(item)}\n`).join("");
  return { nodes: lines([...nodes].sort(byId)), edges: lines([...edges].sort(byId)) };
}

function xmlEscape(text: string, attribute: boolean): string {
  let out = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  if (attribute) {
    out = out.replaceAll('"', "&quot;").replaceAll("\r", "&#13;").replaceAll("\n", "&#10;").replaceAll("\t", "&#09;");
  }
  return out;
}

const NODE_KEYS: [string, string, (node: GraphNode) => Json][] = [
  ["d_title", "title", (node) => node.title],
  ["d_node_type", "node_type", (node) => node.node_type],
  ["d_page_type", "page_type", (node) => node.page_type],
  ["d_path", "path", (node) => node.path],
];
const EDGE_KEYS: [string, string, (edge: GraphEdge) => Json][] = [
  ["d_predicate", "predicate", (edge) => edge.predicate],
  ["d_confidence", "confidence", (edge) => edge.confidence],
  ["d_status", "status", (edge) => edge.status],
  ["d_source", "source", (edge) => edge.source],
];

/** GraphML in the layout of ElementTree with `indent(space="  ")`. */
export function exportGraphml(nodes: GraphNode[], edges: GraphEdge[]): string {
  const out: string[] = ["<?xml version='1.0' encoding='utf-8'?>", '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">'];
  for (const [id, name] of NODE_KEYS) out.push(`  <key id="${id}" for="node" attr.name="${name}" attr.type="string" />`);
  for (const [id, name] of EDGE_KEYS) out.push(`  <key id="${id}" for="edge" attr.name="${name}" attr.type="string" />`);
  out.push('  <graph id="wiki" edgedefault="directed">');
  const data = (key: string, value: Json | undefined): string => {
    const text = truthy(value) ? pyStr(value) : "";
    return text === "" ? `      <data key="${key}" />` : `      <data key="${key}">${xmlEscape(text, false)}</data>`;
  };
  for (const node of [...nodes].sort(byId)) {
    out.push(`    <node id="${xmlEscape(node.id, true)}">`);
    for (const [id, , get] of NODE_KEYS) out.push(data(id, get(node)));
    out.push("    </node>");
  }
  for (const edge of [...edges].sort(byId)) {
    out.push(
      `    <edge id="${xmlEscape(edge.id, true)}" source="${xmlEscape(edge.subject, true)}" target="${xmlEscape(edge.object, true)}">`,
    );
    for (const [id, , get] of EDGE_KEYS) out.push(data(id, get(edge)));
    out.push("    </edge>");
  }
  out.push("  </graph>");
  out.push("</graphml>");
  return out.join("\n");
}
