#!/usr/bin/env python3
"""
wiki_graph_store.py — The compiled graph's SQLite shape, in one place.

Two scripts need this schema: `wiki_graph_extract.py`, which compiles it from
markdown, and `wiki_graph_query.py`, which rebuilds it from the committed JSONL
exports when a fresh clone has no database yet. A second copy of the DDL would
be a divergence waiting to happen — the same failure the shared markdown parser
was created to end.

Deliberately stdlib-only. `wiki_graph_extract.py` carries a pinned PyYAML and
runs under `uv`; `wiki_graph_query.py` does neither, and must not start.
"""

import json
import sqlite3
from pathlib import Path

SCHEMA = """
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      page_type TEXT NOT NULL,
      node_type TEXT NOT NULL,
      kind TEXT,
      path TEXT NOT NULL,
      created TEXT,
      updated TEXT,
      metadata_json TEXT NOT NULL
    );
    CREATE TABLE aliases (
      alias TEXT NOT NULL,
      node_id TEXT NOT NULL,
      PRIMARY KEY (alias, node_id),
      FOREIGN KEY (node_id) REFERENCES nodes(id)
    );
    CREATE TABLE edges (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      source TEXT,
      evidence TEXT,
      confidence TEXT,
      status TEXT,
      extraction_method TEXT NOT NULL,
      page TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
    CREATE INDEX idx_edges_subject ON edges(subject);
    CREATE INDEX idx_edges_object ON edges(object);
    CREATE INDEX idx_edges_predicate ON edges(predicate);
    CREATE INDEX idx_edges_source ON edges(source);
"""

NODES_EXPORT = "nodes.jsonl"
EDGES_EXPORT = "edges.jsonl"


def normalize_for_json(value):
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if isinstance(value, list):
        return [normalize_for_json(v) for v in value]
    if isinstance(value, dict):
        return {k: normalize_for_json(v) for k, v in value.items()}
    return value


def write_sqlite(db_path: Path, nodes: list[dict], aliases: list[dict], edges: list[dict]) -> None:
    """(Re)create the database at `db_path` from in-memory rows."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if db_path.exists():
        db_path.unlink()
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(SCHEMA)
        for n in sorted(nodes, key=lambda n: n["id"]):
            metadata_json = json.dumps(normalize_for_json({
                "tags": n.get("tags", []),
                "aliases": n.get("aliases", []),
                "canonical": n.get("canonical", False),
            }), sort_keys=True, ensure_ascii=False)
            conn.execute(
                "INSERT INTO nodes (id, slug, title, page_type, node_type, kind, path, "
                "created, updated, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    n["id"], n["slug"], n["title"], n["page_type"], n["node_type"],
                    n.get("kind") or None, n["path"],
                    str(n.get("created") or "") or None,
                    str(n.get("updated") or "") or None,
                    metadata_json,
                ),
            )
        for a in sorted(aliases, key=lambda a: (a["alias"], a["node_id"])):
            conn.execute(
                "INSERT OR IGNORE INTO aliases (alias, node_id) VALUES (?, ?)",
                (a["alias"], a["node_id"]),
            )
        for e in sorted(edges, key=lambda e: e["id"]):
            metadata_json = json.dumps(normalize_for_json(e.get("extras") or {}),
                                       sort_keys=True, ensure_ascii=False)
            conn.execute(
                "INSERT INTO edges (id, subject, predicate, object, source, evidence, "
                "confidence, status, extraction_method, page, metadata_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    e["id"], e["subject"], e["predicate"], e["object"],
                    e.get("source") or None, e.get("evidence") or None,
                    e.get("confidence") or None, e.get("status") or None,
                    e["extraction_method"], e["page"], metadata_json,
                ),
            )
        conn.commit()
    finally:
        conn.close()


def export_paths(graph_dir: Path) -> tuple[Path, Path]:
    return graph_dir / NODES_EXPORT, graph_dir / EDGES_EXPORT


def read_exports(graph_dir: Path) -> tuple[list[dict], list[dict], list[dict]]:
    """Load the committed JSONL exports as (nodes, aliases, edges).

    The aliases table is derived rather than stored: `build_nodes()` fills it
    from each node's own `aliases` list, so the export already carries every
    row and a separate file would only be a second thing to keep in sync.
    """
    nodes_path, edges_path = export_paths(graph_dir)
    nodes, edges, aliases = [], [], []
    for line in nodes_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        node = json.loads(line)
        nodes.append(node)
        for alias in node.get("aliases") or []:
            aliases.append({"alias": str(alias), "node_id": node["id"]})
    for line in edges_path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            edges.append(json.loads(line))
    return nodes, aliases, edges
