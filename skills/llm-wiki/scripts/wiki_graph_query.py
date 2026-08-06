#!/usr/bin/env python3
"""
wiki_graph_query.py — Query the compiled wiki graph (graph.sqlite).

Use this to accelerate navigation: find what's connected to a node, list
typed edges around a subject, find what a set of pages has in common, find a
path between two nodes, or dump every fact about a node. The graph is a
navigation index — for high-stakes claims, follow the `source` field back to
the wiki page and the raw file.

Every subcommand takes an id, a bare page slug (what `wiki_search.py` reports)
or a unique alias.

Subcommands:
    neighbors --node <id>            List nodes one hop away from <id>
    edges    --subject <id>          List all outbound edges from <id>
             [--predicate <p>]        Filter by predicate
    subgraph --nodes <id,id,...>     The subgraph BOUNDED BY these terms: the
                                      terms, plus everything on the routes
                                      between them. Three layers, weakest last —
                                      direct edges inside the set; shared
                                      connectors (one node two or more members
                                      reach); and chains, the route between a
                                      pair that has neither. Distant terms have
                                      only the chain, so this answers "how are
                                      these related" at any distance, in one call
             [--predicate <p>]        Filter the reported edges
             [--radius N]             Hops from each member when hunting
                                      connectors. Default 1, widening to 2 only
                                      if that finds nothing; 0 = induced only
             [--max-chain-hops N]     Longest route reported (default 4). A pair
                                      further apart is reported with its true
                                      distance, never as "unrelated"
             [--max-connector-degree N]  Skip connectors adjacent to more than N
                                      nodes (default 25, 0 = keep all). Skipped
                                      hubs are reported, never hidden
             [--include-mentions]     Allow implicit `mentions` routes too
    path     --from <id> --to <id>   Shortest directed path (BFS, max depth 6)
             [--max-depth N]
    facts    --about <id>            Outbound + inbound edges for <id>

Common options:
    --db <path>           Path to graph.sqlite (default: <wiki>/graph/graph.sqlite)
    --json                Emit JSON instead of text (goes before the subcommand)

Examples:
    python wiki_graph_query.py wiki/ neighbors --node product:konvy
    python wiki_graph_query.py wiki/ edges    --subject person:stephanie-emmanouel
    python wiki_graph_query.py wiki/ subgraph --nodes kv-cache,quantization
    python wiki_graph_query.py wiki/ path     --from person:praney-behl --to product:konvy
    python wiki_graph_query.py wiki/ facts    --about product:konvy
"""

import argparse
import itertools
import json
import sqlite3
import sys
from collections import defaultdict, deque
from pathlib import Path

import wiki_graph_store
from wiki_markdown import configure_utf8_streams


configure_utf8_streams()


EVIDENCE_SNIPPET_LEN = 140

# Connector hunting walks typed edges only. Implicit `mentions` edges were 72%
# of the graph measured below and carry no evidence, and a route through one is
# routinely spurious: two specialised pages "connected" because both happen to
# link the same overview page, while their real shared step is a third concept
# neither of them names. `--include-mentions` widens it when that is wanted.
CONNECTOR_PREDICATES = (
    "relates_to", "depends_on", "alternative_to", "specializes", "constrains", "supersedes",
)
# Measured on a 570-page wiki: 228 nodes carry typed edges, degrees run 1–17
# with a median of 3, and one registry page sits at 196. A node adjacent to a
# quarter of the corpus puts every pair at distance 2 — it produced ~700k
# "indirectly related" triples against 30 that go through a substantive
# connector. So a hub is a bad connector by construction, not by topic. 25
# clears the highest legitimate degree observed and stays far below the hub;
# 0 disables the filter.
DEFAULT_MAX_CONNECTOR_DEGREE = 25
# Radius 1 finds the shared-intermediate shape (two members at distance 2).
# Escalating to 2 covers two intermediates, at the cost of much weaker claims —
# so it is tried only when radius 1 finds nothing at all.
MAX_AUTO_RADIUS = 2
# Distant terms have no shared neighbour to find: the relationship *is* a chain.
# Which edges a chain may walk decides whether the question is answerable at all.
# Measured here, hub-free, over random concept pairs:
#
#   typed only            8% reachable, 41 components — cannot answer
#   typed + mentions     74% reachable within 6 hops (41% within 4)
#   every predicate     shorter routes, but they run through `document` nodes of
#                       degree up to 600; "both are written about in the same
#                       file" is provenance, not a relationship
#   no hub cap          everything two hops apart via the registry page
#
# So the widened scope is page-to-page: typed plus `mentions`, never `sourced_from`.
CHAIN_PREDICATES = CONNECTOR_PREDICATES + ("mentions",)
# 4 hops is the edge of a claim: beyond it a wikilink chain is a chain of
# coincidences. A pair whose route is longer is reported with its true distance
# rather than as "unrelated", so the caller can raise the limit deliberately.
DEFAULT_MAX_CHAIN_HOPS = 4
CHAIN_PROBE_HOPS = 8


def rebuild_reason(db_path: Path, graph_dir: Path) -> str | None:
    """Why the database needs rebuilding from the exports, or None if it does not."""
    nodes_path, edges_path = wiki_graph_store.export_paths(graph_dir)
    if not (nodes_path.exists() and edges_path.exists()):
        return None                       # nothing to rebuild from; caller reports it
    if not db_path.exists():
        return "missing"
    db_mtime = db_path.stat().st_mtime
    if max(nodes_path.stat().st_mtime, edges_path.stat().st_mtime) > db_mtime:
        return "older than the exports"
    return None


def open_db(path: Path, graph_dir: Path) -> sqlite3.Connection:
    """Open the graph, compiling it from the committed exports when needed.

    `graph.sqlite` is derived and gitignored, so a fresh clone has the exports
    but no database. Before this, every query here failed and the agent simply
    skipped the graph step — the wiki still answered, just without typed
    neighbours, and nothing said a whole retrieval stage had gone missing.
    Silent degradation is worse than the two seconds a rebuild costs.

    Only the JSONL exports are read, never the markdown: this script is
    stdlib-only by design and must not acquire PyYAML or `uv`. Whether those
    exports still match the pages is a separate question, and a separate tool's.
    """
    reason = rebuild_reason(path, graph_dir)
    if reason:
        print(f"graph.sqlite {reason}; rebuilding from {graph_dir}/nodes.jsonl + edges.jsonl",
              file=sys.stderr)
        try:
            nodes, aliases, edges = wiki_graph_store.read_exports(graph_dir)
            wiki_graph_store.write_sqlite(path, nodes, aliases, edges)
        except (OSError, ValueError, sqlite3.Error) as exc:
            print(f"Rebuild failed: {exc}", file=sys.stderr)
            print("Run wiki_graph_extract.py to regenerate the graph.", file=sys.stderr)
            sys.exit(1)
        print(f"  {len(nodes)} nodes, {len(edges)} edges", file=sys.stderr)
    if not path.exists():
        print(f"graph.sqlite not found at {path}, and no exports to rebuild it from.",
              file=sys.stderr)
        print("Run wiki_graph_extract.py first.", file=sys.stderr)
        sys.exit(1)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def fetch_node(conn: sqlite3.Connection, node_id: str) -> dict | None:
    row = conn.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
    return dict(row) if row else None


def edges_from(conn: sqlite3.Connection, subject: str, predicate: str | None = None) -> list[dict]:
    q = "SELECT * FROM edges WHERE subject = ?"
    params: list = [subject]
    if predicate:
        q += " AND predicate = ?"
        params.append(predicate)
    q += " ORDER BY predicate, object"
    return [dict(r) for r in conn.execute(q, params).fetchall()]


def edges_to(conn: sqlite3.Connection, obj: str, predicate: str | None = None) -> list[dict]:
    q = "SELECT * FROM edges WHERE object = ?"
    params: list = [obj]
    if predicate:
        q += " AND predicate = ?"
        params.append(predicate)
    q += " ORDER BY predicate, subject"
    return [dict(r) for r in conn.execute(q, params).fetchall()]


def resolve_node_id(conn: sqlite3.Connection, token: str) -> str | None:
    """Accept a graph id, a bare page slug, or an alias.

    `subgraph` is fed from a retrieval result set, and `wiki_search.py` reports
    `slug` — not `<node_type>:<slug>`. Making the caller rebuild the namespace by
    hand is the one thing that would keep this command out of the workflow it
    exists for. `slug` is UNIQUE in the schema, so that lookup is unambiguous;
    an alias is not, so it resolves only when it names exactly one node. An
    ambiguous alias stays unresolved and is reported rather than silently
    picking a node for the caller.
    """
    if conn.execute("SELECT 1 FROM nodes WHERE id = ?", (token,)).fetchone():
        return token
    row = conn.execute("SELECT id FROM nodes WHERE slug = ?", (token,)).fetchone()
    if row:
        return row["id"]
    candidates = conn.execute(
        "SELECT node_id FROM aliases WHERE alias = ? ORDER BY node_id", (token,)
    ).fetchall()
    return candidates[0]["node_id"] if len(candidates) == 1 else None


def require_node_id(conn: sqlite3.Connection, token: str, label: str = "node") -> str:
    """Resolve or exit. Every subcommand accepts an id, a slug or a unique alias."""
    node_id = resolve_node_id(conn, token)
    if node_id is None:
        print(f"{label} not found: {token} "
              "(accepts a graph id, a page slug, or a unique alias)", file=sys.stderr)
        sys.exit(1)
    return node_id


def undirected_adjacency(conn: sqlite3.Connection,
                         predicates: tuple[str, ...] | None) -> dict[str, set[str]]:
    """Neighbour map for connector hunting, direction discarded.

    Undirected on purpose. `A depends_on X` and `B relates_to X` is exactly the
    shape of a shared dependency, and no directed walk can see it — leaving X
    for B means going against the arrow. Direction survives in the edges that
    get reported; only the reachability question ignores it.
    """
    query = "SELECT subject, object FROM edges"
    params: list = []
    if predicates:
        query += f" WHERE predicate IN ({','.join('?' for _ in predicates)})"
        params.extend(predicates)
    adjacency: dict[str, set[str]] = defaultdict(set)
    for subject, obj in conn.execute(query, params):
        adjacency[subject].add(obj)
        adjacency[obj].add(subject)
    return adjacency


def find_connectors(adjacency: dict[str, set[str]], node_ids: list[str],
                    radius: int, max_degree: int) -> tuple[dict[str, dict], dict[str, int]]:
    """Nodes outside the set that sit within `radius` hops of two or more members.

    "Common" is the whole question: a node reachable from one member explains
    nothing about the set, a node reachable from several is the shared step. Each
    member's own neighbourhood is walked once, so cost is linear in members
    rather than quadratic in pairs.

    Returns (connectors, excluded_hubs) — the hubs are returned rather than
    dropped silently, because "the only thing joining these pages is a registry
    every page touches" is itself the answer to some questions.
    """
    members = set(node_ids)
    reach: dict[str, dict[str, int]] = {}
    for member in node_ids:
        seen = {member: 0}
        queue = deque([(member, 0)])
        while queue:
            node, hops = queue.popleft()
            if hops >= radius:
                continue
            for neighbour in adjacency.get(node, ()):
                if neighbour in seen:
                    continue
                seen[neighbour] = hops + 1
                # A hub is barred from the walk, not just from the candidate list.
                # Letting it be traversed makes it a bridge: every one of the 196
                # neighbours of `concept:test-unit-registry` becomes "reachable
                # from all three members" at radius 2, and the command answers a
                # relational question with the entire corpus. Recorded in `seen`
                # first, so it can still be reported as a skipped candidate.
                if max_degree and len(adjacency.get(neighbour, ())) > max_degree:
                    continue
                queue.append((neighbour, hops + 1))
        for node, hops in seen.items():
            if hops and node not in members:
                reach.setdefault(node, {})[member] = hops
    connectors: dict[str, dict] = {}
    excluded_hubs: dict[str, int] = {}
    for node, joins in reach.items():
        if len(joins) < 2:
            continue
        degree = len(adjacency.get(node, ()))
        if max_degree and degree > max_degree:
            excluded_hubs[node] = degree
        else:
            connectors[node] = {"joins": joins, "degree": degree}
    return connectors, excluded_hubs


def shortest_chain(adjacency: dict[str, set[str]], source: str, target: str,
                   max_hops: int, max_degree: int) -> list[str]:
    """Shortest hub-free node path from `source` to `target`, or []."""
    if source == target:
        return []
    queue = deque([source])
    parent: dict[str, str | None] = {source: None}
    depth = {source: 0}
    while queue:
        node = queue.popleft()
        if depth[node] >= max_hops:
            continue
        for neighbour in adjacency.get(node, ()):
            if neighbour in parent:
                continue
            parent[neighbour] = node
            depth[neighbour] = depth[node] + 1
            if neighbour == target:
                path = [target]
                while parent[path[-1]] is not None:
                    path.append(parent[path[-1]])
                return list(reversed(path))
            # Same rule as connector hunting: a hub is not a route. Without this
            # every pair is "two hops apart" through the registry page.
            if max_degree and len(adjacency.get(neighbour, ())) > max_degree:
                continue
            queue.append(neighbour)
    return []


def chain_edges(conn: sqlite3.Connection, path: list[str]) -> list[dict]:
    """The edges realising a chain, in walk order, direction as recorded."""
    edges = []
    for left, right in zip(path, path[1:]):
        rows = conn.execute(
            "SELECT * FROM edges WHERE (subject = ? AND object = ?) "
            "OR (subject = ? AND object = ?) ORDER BY predicate DESC, id",
            (left, right, right, left),
        ).fetchall()
        if rows:
            edges.append(dict(rows[0]))
    return edges


def find_chains(conn: sqlite3.Connection, scopes: list[tuple[str, dict[str, set[str]]]],
                pairs: list[tuple[str, str]], max_hops: int,
                max_degree: int) -> tuple[list[dict], list[tuple[str, str]]]:
    """The routes between the given terms — the subgraph they bound.

    One shortest chain per pair. `scopes` are tried in order per pair, not
    globally: the typed layer reaches only 8% of random concept pairs here, so a
    single strict pass would report "unrelated" for almost everything, while a
    single wide pass would hide that a route exists only through wikilinks.
    Each chain therefore records which scope found it and its weakest predicate.

    Ordered by hop count — a two-hop route is a claim, a four-hop route is a lead.
    Returns (chains, pairs still unreachable).
    """
    chains = []
    unreachable = []
    for source, target in pairs:
        for scope_name, adjacency in scopes:
            path = shortest_chain(adjacency, source, target, max_hops, max_degree)
            if not path:
                # Silence here would read as "unrelated". Probe further so the
                # answer can be "related, but further away than you asked for".
                probe = shortest_chain(adjacency, source, target,
                                       CHAIN_PROBE_HOPS, max_degree)
                if probe and scope_name == scopes[-1][0]:
                    unreachable.append({"from": source, "to": target,
                                        "beyond_limit_hops": len(probe) - 1,
                                        "scope": scope_name})
                continue
            edges = chain_edges(conn, path)
            chains.append({
                "from": source,
                "to": target,
                "hops": len(path) - 1,
                "nodes": path,
                "via": path[1:-1],
                "edges": edges,
                "scope": scope_name,
                "weakest": "mentions" if any(edge["predicate"] == "mentions"
                                             for edge in edges) else "typed",
            })
            break
    chains.sort(key=lambda chain: (chain["hops"], chain["from"], chain["to"]))
    return chains, unreachable


def induced_edges(conn: sqlite3.Connection, node_ids: list[str],
                  predicate: str | None = None) -> list[dict]:
    """Edges whose subject AND object are both in `node_ids`.

    A temp table rather than two `IN (...)` lists: the set is a retrieval result
    of caller-chosen size, and 2N bound parameters would eventually hit
    SQLITE_MAX_VARIABLE_NUMBER. Both joins ride the subject/object indexes.
    """
    conn.execute("CREATE TEMP TABLE IF NOT EXISTS subgraph_nodes (id TEXT PRIMARY KEY)")
    conn.execute("DELETE FROM subgraph_nodes")
    conn.executemany(
        "INSERT OR IGNORE INTO subgraph_nodes(id) VALUES (?)",
        ((node_id,) for node_id in node_ids),
    )
    query = (
        "SELECT edges.* FROM edges "
        "JOIN subgraph_nodes AS subjects ON subjects.id = edges.subject "
        "JOIN subgraph_nodes AS objects ON objects.id = edges.object"
    )
    params: list = []
    if predicate:
        query += " WHERE edges.predicate = ?"
        params.append(predicate)
    query += " ORDER BY edges.subject, edges.predicate, edges.object"
    return [dict(row) for row in conn.execute(query, params).fetchall()]


def split_node_tokens(values: list[str] | None) -> list[str]:
    """Flatten repeated `--nodes` flags and comma lists into ordered unique tokens."""
    tokens: list[str] = []
    for value in values or []:
        for token in value.split(","):
            token = token.strip()
            if token and token not in tokens:
                tokens.append(token)
    return tokens


def truncate(text: str | None) -> str:
    if not text:
        return ""
    if len(text) <= EVIDENCE_SNIPPET_LEN:
        return text
    return text[: EVIDENCE_SNIPPET_LEN - 1].rstrip() + "…"


def render_edge_row(e: dict) -> str:
    pieces = [
        f"  {e['subject']} --[{e['predicate']}]--> {e['object']}",
    ]
    confidence = e.get("confidence") or "-"
    status = e.get("status") or "-"
    src = e.get("source") or "-"
    pieces.append(f"      via {src}  conf={confidence}  status={status}")
    if e.get("evidence"):
        pieces.append(f"      evidence: {truncate(e['evidence'])}")
    pieces.append(f"      (page: {e['page']})")
    return "\n".join(pieces)


def cmd_neighbors(conn: sqlite3.Connection, args) -> dict:
    node_id = require_node_id(conn, args.node)
    node = fetch_node(conn, node_id)
    out_edges = edges_from(conn, node_id)
    in_edges = edges_to(conn, node_id)

    neighbors: dict[str, dict] = {}
    for e in out_edges:
        neighbors.setdefault(e["object"], {"node_id": e["object"], "out": [], "in": []})
        neighbors[e["object"]]["out"].append(e)
    for e in in_edges:
        neighbors.setdefault(e["subject"], {"node_id": e["subject"], "out": [], "in": []})
        neighbors[e["subject"]]["in"].append(e)

    # Resolve neighbor titles where possible
    for nid, slot in neighbors.items():
        target = fetch_node(conn, nid)
        slot["title"] = target["title"] if target else nid
        slot["path"] = target["path"] if target else None

    return {
        "node": node,
        "neighbors": sorted(neighbors.values(), key=lambda n: n["node_id"]),
    }


def cmd_edges(conn: sqlite3.Connection, args) -> dict:
    subject = require_node_id(conn, args.subject, "subject")
    return {"subject": subject, "predicate": args.predicate,
            "edges": edges_from(conn, subject, args.predicate)}


def cmd_subgraph(conn: sqlite3.Connection, args) -> dict:
    """The subgraph bounded by a set of terms: the terms plus the routes between them.

    Three layers, weakest claim last:

      edges       direct relationships inside the set
      connectors  one node reached from two or more members — a shared step
      chains      the route between a pair that has neither, which for distant
                  terms is the only thing that exists

    Node order follows the tokens as given, because the set normally arrives as a
    ranked retrieval result and that ranking is information. The negatives are
    load-bearing too: `isolated` and `unreachable` say "these terms are not
    related in this wiki", which is a finding, not an empty result.
    """
    requested = split_node_tokens(args.nodes)
    if not requested:
        print("no nodes given: pass --nodes <id,id,...>", file=sys.stderr)
        sys.exit(2)
    resolved: dict[str, str] = {}
    unresolved: list[str] = []
    for token in requested:
        node_id = resolve_node_id(conn, token)
        if node_id is None:
            unresolved.append(token)
        else:
            resolved.setdefault(node_id, token)
    if not resolved:
        print(f"none of the requested nodes are in the graph: {', '.join(unresolved)}",
              file=sys.stderr)
        sys.exit(1)
    node_ids = list(resolved)
    connectors: dict[str, dict] = {}
    excluded_hubs: dict[str, int] = {}
    radius_used = 0
    adjacency: dict[str, set[str]] | None = None
    # `--radius` unset means "find the connection, whatever its distance": try the
    # strong claim first and widen only if it finds nothing. An explicit value is
    # obeyed exactly, and 0 asks for the induced subgraph alone.
    attempts = [1, MAX_AUTO_RADIUS] if args.radius is None else [args.radius]
    if any(attempts):
        # `--predicate` narrows discovery too, not just the printed edges: a
        # connector found over other predicates would come back with none of its
        # joining edges shown, which reads as a bug.
        if args.predicate:
            predicates: tuple[str, ...] | None = (args.predicate,)
        else:
            predicates = None if args.include_mentions else CONNECTOR_PREDICATES
        adjacency = undirected_adjacency(conn, predicates)
        for radius in attempts:
            if radius <= 0:
                continue
            radius_used = radius
            connectors, excluded_hubs = find_connectors(
                adjacency, node_ids, radius, args.max_connector_degree
            )
            if connectors:
                break
    ordered_connectors = sorted(
        connectors, key=lambda node: (-len(connectors[node]["joins"]),
                                      connectors[node]["degree"], node)
    )
    # The routes between the terms are the subgraph they bound. A shared connector
    # is the degenerate two-hop case of one; distant terms have only the chain.
    chains: list[dict] = []
    unreachable: list[dict] = []
    if args.max_chain_hops and len(node_ids) > 1:
        scopes = [("typed", adjacency if adjacency is not None
                   else undirected_adjacency(conn, CONNECTOR_PREDICATES))]
        if not args.predicate and not args.include_mentions:
            # Widened per pair, not globally — see find_chains.
            scopes.append(("typed+mentions", undirected_adjacency(conn, CHAIN_PREDICATES)))
        chains, unreachable = find_chains(
            conn, scopes, list(itertools.combinations(node_ids, 2)),
            args.max_chain_hops, args.max_connector_degree,
        )
    route_nodes: list[str] = []
    for chain in chains:
        for node in chain["via"]:
            if node not in route_nodes and node not in resolved:
                route_nodes.append(node)
    edges = induced_edges(conn, node_ids + ordered_connectors + route_nodes, args.predicate)
    connected = {edge["subject"] for edge in edges} | {edge["object"] for edge in edges}
    return {
        "requested": requested,
        "unresolved": unresolved,
        "predicate": args.predicate,
        "radius": radius_used,
        "include_mentions": bool(args.include_mentions),
        "nodes": [fetch_node(conn, node_id) for node_id in node_ids],
        "connectors": [
            {**(fetch_node(conn, node) or {"id": node}),
             "degree": connectors[node]["degree"],
             "joins": connectors[node]["joins"]}
            for node in ordered_connectors
        ],
        "chains": [
            {**chain,
             "titles": [(fetch_node(conn, node) or {}).get("title", node)
                        for node in chain["nodes"]]}
            for chain in chains
        ],
        "unreachable": unreachable,
        "edges": edges,
        "isolated": [node_id for node_id in node_ids if node_id not in connected],
        "excluded_hubs": [
            {"id": node, "degree": degree,
             "title": (fetch_node(conn, node) or {}).get("title", node)}
            for node, degree in sorted(excluded_hubs.items(), key=lambda kv: -kv[1])
        ],
    }


def cmd_facts(conn: sqlite3.Connection, args) -> dict:
    node_id = require_node_id(conn, args.about)
    return {
        "node": fetch_node(conn, node_id),
        "outbound": edges_from(conn, node_id),
        "inbound": edges_to(conn, node_id),
    }


def cmd_path(conn: sqlite3.Connection, args) -> dict:
    start = require_node_id(conn, getattr(args, "from"), "from-node")
    goal = require_node_id(conn, args.to, "to-node")
    queue = deque([(start, [start], [])])
    visited = {start}
    while queue:
        node, node_path, edge_path = queue.popleft()
        if node == goal:
            return {"from": start, "to": goal, "path_nodes": node_path, "path_edges": edge_path}
        if len(node_path) - 1 >= args.max_depth:
            continue
        for e in edges_from(conn, node):
            nxt = e["object"]
            if nxt in visited:
                continue
            visited.add(nxt)
            queue.append((nxt, node_path + [nxt], edge_path + [e]))
    return {"from": start, "to": goal, "path_nodes": [], "path_edges": []}


def render(result: dict, command: str) -> str:
    out: list[str] = []
    if command == "neighbors":
        n = result["node"]
        out.append(f"Node: {n['id']}  ({n['title']})  {n['node_type']}  [{n['path']}]")
        out.append(f"Neighbors: {len(result['neighbors'])}")
        for nb in result["neighbors"]:
            out.append("")
            out.append(f"  → {nb['node_id']}  ({nb['title']})")
            for e in nb.get("out", []):
                out.append(f"      out  [{e['predicate']}]  conf={e.get('confidence') or '-'}  src={e.get('source') or '-'}")
            for e in nb.get("in", []):
                out.append(f"      in   [{e['predicate']}]  from {e['subject']}  src={e.get('source') or '-'}")
    elif command == "edges":
        out.append(f"Edges from {result['subject']}"
                   + (f" with predicate {result['predicate']}" if result['predicate'] else ""))
        for e in result["edges"]:
            out.append("")
            out.append(render_edge_row(e))
    elif command == "subgraph":
        header = f"Subgraph over {len(result['nodes'])} nodes"
        if result["predicate"]:
            header += f", predicate {result['predicate']}"
        if result["radius"]:
            header += f", connector radius {result['radius']}"
        if result["include_mentions"]:
            header += ", mentions included"
        out.append(header)
        for node in result["nodes"]:
            out.append(f"  {node['id']}  ({node['title']})  [{node['path']}]")
        if result["connectors"]:
            out.append("")
            out.append(f"Shared connectors ({len(result['connectors'])}) — not in the set, "
                       "reached from two or more members:")
            for connector in result["connectors"]:
                joins = ", ".join(
                    f"{member.split(':', 1)[-1]} ({hops}h)"
                    for member, hops in sorted(connector["joins"].items())
                )
                out.append("")
                out.append(f"  ★ {connector['id']}  ({connector.get('title')})")
                out.append(f"      joins {len(connector['joins'])}: {joins}")
                out.append(f"      degree {connector['degree']}  [{connector.get('path')}]")
        if result.get("chains"):
            out.append("")
            out.append(f"Routes between the terms ({len(result['chains'])}) — the subgraph "
                       "they bound:")
            for chain in result["chains"]:
                arrow = "  " + " → ".join(node.split(":", 1)[-1] for node in chain["nodes"])
                out.append("")
                out.append(f"{arrow}   [{chain['hops']} hops, {chain['scope']}, "
                           f"weakest link: {chain['weakest']}]")
                for step, edge in enumerate(chain["edges"], 1):
                    quote = f"  — {truncate(edge['evidence'])}" if edge["evidence"] else ""
                    out.append(f"      {step}. [{edge['predicate']}] "
                               f"conf={edge.get('confidence') or '-'}{quote}")
        if result.get("unreachable"):
            out.append("")
            out.append("Related, but further than the hop limit:")
            for gap in result["unreachable"]:
                out.append(f"  {gap['from']} ⇄ {gap['to']} — shortest route is "
                           f"{gap['beyond_limit_hops']} hops "
                           "(raise --max-chain-hops to see it)")
        out.append("")
        out.append(f"Edges within the set and its connectors ({len(result['edges'])}):")
        for e in result["edges"]:
            out.append("")
            out.append(render_edge_row(e))
        if result["isolated"]:
            out.append("")
            out.append("Unconnected even through a connector: " + ", ".join(result["isolated"]))
        if result["excluded_hubs"]:
            out.append("")
            out.append("Hubs skipped as connectors (too general to explain anything):")
            for hub in result["excluded_hubs"]:
                out.append(f"  {hub['id']}  degree {hub['degree']}  ({hub['title']})")
        if result["unresolved"]:
            out.append("")
            out.append("Not in the graph: " + ", ".join(result["unresolved"]))
    elif command == "facts":
        n = result["node"]
        out.append(f"Facts about {n['id']}  ({n['title']})  [{n['path']}]")
        out.append("")
        out.append(f"Outbound ({len(result['outbound'])}):")
        for e in result["outbound"]:
            out.append(render_edge_row(e))
        out.append("")
        out.append(f"Inbound ({len(result['inbound'])}):")
        for e in result["inbound"]:
            out.append(render_edge_row(e))
    elif command == "path":
        if not result["path_nodes"]:
            out.append(f"No path found from {result['from']} to {result['to']} within depth limit.")
        else:
            out.append(f"Path from {result['from']} to {result['to']} ({len(result['path_edges'])} hops):")
            for e in result["path_edges"]:
                out.append("")
                out.append(render_edge_row(e))
    return "\n".join(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("wiki", type=Path, help="Wiki directory.")
    parser.add_argument("--db", type=Path, help="Path to graph.sqlite (default: <wiki>/graph/graph.sqlite)")
    parser.add_argument("--json", action="store_true")

    sub = parser.add_subparsers(dest="command", required=True)

    p_n = sub.add_parser("neighbors")
    p_n.add_argument("--node", required=True)

    p_e = sub.add_parser("edges")
    p_e.add_argument("--subject", required=True)
    p_e.add_argument("--predicate")

    p_s = sub.add_parser("subgraph")
    p_s.add_argument("--nodes", action="append", required=True,
                     help="Comma-separated ids, slugs or aliases; repeatable.")
    p_s.add_argument("--predicate")
    p_s.add_argument("--radius", type=int, default=None,
                     help="Hops from each member when hunting shared connectors. "
                          f"Default: 1, widening to {MAX_AUTO_RADIUS} only if that finds "
                          "nothing. 0 = induced subgraph only.")
    p_s.add_argument("--max-connector-degree", type=int,
                     default=DEFAULT_MAX_CONNECTOR_DEGREE,
                     help="Drop connectors adjacent to more than N nodes "
                          f"(default {DEFAULT_MAX_CONNECTOR_DEGREE}; 0 = keep all). "
                          "They are reported, not hidden.")
    p_s.add_argument("--include-mentions", action="store_true",
                     help="Allow implicit `mentions` edges as connector routes.")
    p_s.add_argument("--max-chain-hops", type=int, default=DEFAULT_MAX_CHAIN_HOPS,
                     help="Longest route reported between two terms "
                          f"(default {DEFAULT_MAX_CHAIN_HOPS}; 0 = no routes). The typed "
                          "layer reaches 8%% of concept pairs here, so a route may widen "
                          "to `mentions` — each one says which scope found it.")

    p_p = sub.add_parser("path")
    p_p.add_argument("--from", dest="from", required=True)
    p_p.add_argument("--to", required=True)
    p_p.add_argument("--max-depth", type=int, default=6)

    p_f = sub.add_parser("facts")
    p_f.add_argument("--about", required=True)

    args = parser.parse_args()

    if not args.wiki.exists():
        print(f"Wiki directory not found: {args.wiki}", file=sys.stderr)
        sys.exit(1)
    graph_dir = args.wiki / "graph"
    db_path = args.db or (graph_dir / "graph.sqlite")
    conn = open_db(db_path, graph_dir)
    try:
        if args.command == "neighbors":
            result = cmd_neighbors(conn, args)
        elif args.command == "edges":
            result = cmd_edges(conn, args)
        elif args.command == "subgraph":
            result = cmd_subgraph(conn, args)
        elif args.command == "path":
            result = cmd_path(conn, args)
        elif args.command == "facts":
            result = cmd_facts(conn, args)
        else:
            parser.print_help()
            sys.exit(1)
    finally:
        conn.close()

    if args.json:
        print(json.dumps(result, indent=2, default=str))
    else:
        print(render(result, args.command))


if __name__ == "__main__":
    main()
