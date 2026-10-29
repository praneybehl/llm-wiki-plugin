/**
 * Graph lint. Port of `lint` in skills/llm-wiki/scripts/wiki_graph_lint.py:
 * same finding categories, same fields, same summary.
 */

import {
  buildGraph,
  deriveNodeId,
  deriveNodeType,
  graphMeta,
  isObject,
  pyIter,
  pyStr,
  truthy,
  type GraphPage,
  type Json,
  type Ontology,
} from "./graph";

const ALLOWED_CONFIDENCE = new Set(["high", "medium", "low"]);
const ALLOWED_STATUS = new Set(["current", "historical", "proposed", "disputed", "superseded"]);
const IMPLICIT_PREDICATES = new Set(["mentions", "sourced_from", "summarizes_raw"]);

export const GRAPH_FINDING_KEYS = [
  "duplicate_node_ids",
  "unknown_predicates",
  "broken_object_refs",
  "subject_type_mismatch",
  "object_type_mismatch",
  "missing_evidence",
  "missing_source_field",
  "broken_source_refs",
  "invalid_confidence",
  "invalid_status",
  "duplicate_canonical",
  "alias_collisions",
  "broken_contradicts",
  "broken_supersedes",
  "orphan_typed_nodes",
] as const;

export type GraphFindingKey = (typeof GRAPH_FINDING_KEYS)[number];
export type GraphFindings = Record<GraphFindingKey, Record<string, unknown>[]> & {
  summary: Record<string, number>;
};

function typesMatch(allowed: Json | undefined, actual: string | null | undefined): boolean {
  if (!truthy(allowed)) return true;
  const list = pyIter(allowed);
  if (list.includes("*")) return true;
  return actual !== null && actual !== undefined && list.includes(actual);
}

interface LintNode {
  id: string;
  node_type: string;
  rel_path: string;
  slug: string;
  canonical: boolean;
  aliases: Json[];
  graph: Record<string, Json>;
}

/** `pages` must be sorted by path (Python `sorted(rglob)`). */
export function graphLint(pages: GraphPage[], ontology: Ontology): GraphFindings {
  const lists = Object.fromEntries(GRAPH_FINDING_KEYS.map((key) => [key, [] as Record<string, unknown>[]]));
  const findings = { ...(lists as Record<GraphFindingKey, Record<string, unknown>[]>), summary: {} as Record<string, number> };
  const predicates = ontology.predicates;

  const nodeById = new Map<string, LintNode>();
  const duplicates = new Map<string, string[]>();
  for (const page of pages) {
    const nid = deriveNodeId(page.meta, page.slug, ontology);
    const existing = nodeById.get(nid);
    if (existing) {
      const list = duplicates.get(nid) ?? [];
      list.push(page.path, existing.rel_path);
      duplicates.set(nid, list);
      continue;
    }
    const gm = graphMeta(page.meta);
    nodeById.set(nid, {
      id: nid,
      node_type: deriveNodeType(page.meta, ontology) ?? "concept",
      rel_path: page.path,
      slug: page.slug,
      canonical: truthy(gm.canonical ?? false),
      aliases: pyIter(gm.aliases),
      graph: gm,
    });
  }
  for (const [nid, paths] of duplicates) {
    findings.duplicate_node_ids.push({ node_id: nid, paths: [...new Set(paths)].sort() });
  }

  const sourceSlugs = new Set(pages.filter((page) => page.meta.type === "source").map((page) => page.slug));

  const aliasOwners = new Map<string, Set<string>>();
  const canonicalById = new Map<string, string[]>();
  for (const node of nodeById.values()) {
    if (node.canonical) {
      const list = canonicalById.get(node.id) ?? [];
      list.push(node.rel_path);
      canonicalById.set(node.id, list);
    }
    for (const alias of node.aliases) {
      const key = pyStr(alias);
      const owners = aliasOwners.get(key) ?? new Set<string>();
      owners.add(node.id);
      aliasOwners.set(key, owners);
    }
  }
  for (const [nid, paths] of canonicalById) {
    if (paths.length > 1) findings.duplicate_canonical.push({ node_id: nid, paths });
  }
  for (const [alias, owners] of aliasOwners) {
    if (owners.size > 1) findings.alias_collisions.push({ alias, owners: [...owners].sort() });
  }

  for (const page of pages) {
    const gm = graphMeta(page.meta);
    const subjectId = deriveNodeId(page.meta, page.slug, ontology);
    const subjectType = nodeById.get(subjectId)?.node_type ?? null;
    pyIter(gm.relationships).forEach((rel, index) => {
      if (!isObject(rel)) return;
      const predicate = rel.predicate ?? null;
      const obj = rel.object ?? null;
      const here = { page: page.path, predicate, object: obj, index };

      if (!truthy(predicate) || typeof predicate !== "string" || !(predicate in predicates)) {
        findings.unknown_predicates.push({ ...here });
        return;
      }
      const pdefRaw = predicates[predicate];
      const pdef: Record<string, Json> = isObject(pdefRaw) ? pdefRaw : {};

      const objectTypes = pyIter(pdef.object_types);
      const objKey = truthy(obj) ? pyStr(obj) : null;
      if (objKey !== null && !nodeById.has(objKey) && !objectTypes.includes("*")) {
        findings.broken_object_refs.push({ ...here });
      }
      if (!typesMatch(pdef.subject_types, subjectType)) {
        findings.subject_type_mismatch.push({
          ...here,
          subject: subjectId,
          subject_type: subjectType,
          allowed: pdef.subject_types ?? null,
        });
      }
      const objNode = objKey !== null ? nodeById.get(objKey) : undefined;
      if (objNode && !typesMatch(pdef.object_types, objNode.node_type)) {
        findings.object_type_mismatch.push({ ...here, object_type: objNode.node_type, allowed: pdef.object_types ?? null });
      }
      const requiresEvidence = "requires_evidence" in pdef ? truthy(pdef.requires_evidence) : true;
      if (requiresEvidence) {
        if (!truthy(rel.evidence)) findings.missing_evidence.push({ ...here });
        if (!truthy(rel.source)) findings.missing_source_field.push({ ...here });
      }
      const src = rel.source;
      if (truthy(src) && !sourceSlugs.has(pyStr(src))) findings.broken_source_refs.push({ ...here, source: src });
      const confidence = rel.confidence;
      if (truthy(confidence) && !(typeof confidence === "string" && ALLOWED_CONFIDENCE.has(confidence))) {
        findings.invalid_confidence.push({ ...here, confidence });
      }
      const status = rel.status;
      if (truthy(status) && !(typeof status === "string" && ALLOWED_STATUS.has(status))) {
        findings.invalid_status.push({ ...here, status });
      }
      for (const [field, bucket] of [
        ["contradicts", "broken_contradicts"],
        ["supersedes", "broken_supersedes"],
      ] as const) {
        const ref = rel[field];
        if (truthy(ref)) {
          const refStr = pyStr(ref);
          if (!nodeById.has(refStr) && !sourceSlugs.has(refStr)) findings[bucket].push({ ...here, [field]: refStr });
        }
      }
    });
  }

  // Orphan typed nodes: pages with `graph:` metadata but no typed edge after extraction.
  // Python builds edges with {slug: id} from node_by_id, the same first-wins map buildGraph uses.
  const { edges } = buildGraph(pages, ontology);
  const typedRefs = new Set<string>();
  for (const edge of edges) {
    if (IMPLICIT_PREDICATES.has(edge.predicate)) continue;
    typedRefs.add(edge.subject);
    if (nodeById.has(edge.object)) typedRefs.add(edge.object);
  }
  for (const node of nodeById.values()) {
    if (node.node_type === "source") continue;
    if (!truthy(node.graph)) continue;
    if (typedRefs.has(node.id)) continue;
    findings.orphan_typed_nodes.push({ node_id: node.id, path: node.rel_path });
  }

  const summary: Record<string, number> = { pages_scanned: pages.length, nodes: nodeById.size };
  for (const key of GRAPH_FINDING_KEYS) summary[key] = findings[key].length;
  findings.summary = summary;
  return findings;
}
