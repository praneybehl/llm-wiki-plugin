/**
 * Graph queries. Port of skills/llm-wiki/scripts/wiki_graph_query.py
 * (neighbors, edges, facts, path) over the WikiDO graph tables.
 */

import type { EdgeRow, NodeRow } from "./graph";

export interface GraphStore {
  node(id: string): NodeRow | null;
  /** Edges with `subject = id`, ordered by predicate, object. */
  edgesFrom(subject: string, predicate?: string): EdgeRow[];
  /** Edges with `object = id`, ordered by predicate, subject. */
  edgesTo(object: string, predicate?: string): EdgeRow[];
}

export type QueryResult<T> = { ok: true; value: T } | { ok: false; message: string };

export const DEFAULT_PATH_DEPTH = 6;
export const MAX_NEIGHBOR_DEPTH = 3;

interface NeighborSlot {
  node_id: string;
  out: EdgeRow[];
  in: EdgeRow[];
  title: string;
  path: string | null;
}

function neighborSlots(store: GraphStore, id: string, predicate?: string): NeighborSlot[] {
  const slots = new Map<string, NeighborSlot>();
  const slot = (nodeId: string): NeighborSlot => {
    let found = slots.get(nodeId);
    if (!found) {
      found = { node_id: nodeId, out: [], in: [], title: nodeId, path: null };
      slots.set(nodeId, found);
    }
    return found;
  };
  for (const edge of store.edgesFrom(id, predicate)) slot(edge.object).out.push(edge);
  for (const edge of store.edgesTo(id, predicate)) slot(edge.subject).in.push(edge);
  for (const item of slots.values()) {
    const target = store.node(item.node_id);
    item.title = target ? target.title : item.node_id;
    item.path = target ? target.path : null;
  }
  return [...slots.values()].sort((a, b) => (a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0));
}

export function neighbors(store: GraphStore, id: string, depth = 1, predicate?: string): QueryResult<unknown> {
  const node = store.node(id);
  if (!node) return { ok: false, message: `node not found: ${id}` };
  const first = neighborSlots(store, id, predicate);
  const result: Record<string, unknown> = { node, neighbors: first };
  const maxDepth = Math.max(1, Math.min(MAX_NEIGHBOR_DEPTH, Math.floor(depth)));
  if (maxDepth > 1) {
    // Undirected breadth-first walk; reports every node within `depth` hops.
    const distance = new Map<string, number>([[id, 0]]);
    let frontier = first.map((slot) => slot.node_id);
    for (const nodeId of frontier) distance.set(nodeId, 1);
    for (let hop = 2; hop <= maxDepth; hop++) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        for (const slot of neighborSlots(store, nodeId, predicate)) {
          if (distance.has(slot.node_id)) continue;
          distance.set(slot.node_id, hop);
          next.push(slot.node_id);
        }
      }
      frontier = next;
    }
    result.depth = maxDepth;
    result.reachable = [...distance.entries()]
      .filter(([nodeId]) => nodeId !== id)
      .map(([nodeId, hops]) => {
        const target = store.node(nodeId);
        return { node_id: nodeId, title: target ? target.title : nodeId, path: target ? target.path : null, distance: hops };
      })
      .sort((a, b) => a.distance - b.distance || (a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0));
  }
  return { ok: true, value: result };
}

export function facts(store: GraphStore, id: string): QueryResult<unknown> {
  const node = store.node(id);
  if (!node) return { ok: false, message: `node not found: ${id}` };
  return { ok: true, value: { node, outbound: store.edgesFrom(id), inbound: store.edgesTo(id) } };
}

export function path(store: GraphStore, from: string, to: string, maxDepth = DEFAULT_PATH_DEPTH): QueryResult<unknown> {
  if (!store.node(from)) return { ok: false, message: `from-node not found: ${from}` };
  if (!store.node(to)) return { ok: false, message: `to-node not found: ${to}` };
  const queue: [string, string[], EdgeRow[]][] = [[from, [from], []]];
  const visited = new Set([from]);
  for (let head = 0; head < queue.length; head++) {
    const [node, nodePath, edgePath] = queue[head]!;
    if (node === to) return { ok: true, value: { from, to, path_nodes: nodePath, path_edges: edgePath } };
    if (nodePath.length - 1 >= maxDepth) continue;
    for (const edge of store.edgesFrom(node)) {
      if (visited.has(edge.object)) continue;
      visited.add(edge.object);
      queue.push([edge.object, [...nodePath, edge.object], [...edgePath, edge]]);
    }
  }
  return { ok: true, value: { from, to, path_nodes: [], path_edges: [] } };
}
