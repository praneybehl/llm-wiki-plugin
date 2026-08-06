#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "pyyaml==6.0.3",
# ]
# ///
"""
wiki_graph_extract.py — Compile the markdown wiki into a queryable graph.

Markdown remains canonical. This script reads every wiki page, derives nodes
and edges (typed semantic edges from `graph.relationships`, plus implicit
`mentions`, `sourced_from`, `summarizes_raw` edges), and emits artifacts under
`<wiki>/graph/` that can be deleted and rebuilt at any time.

Carries a pinned PyYAML dependency; run with `uv run --script`.

Usage:
    uv run --script wiki_graph_extract.py <wiki-dir> [options]

Options:
    --out <dir>                  Output directory (default: <wiki-dir>/graph)
    --formats jsonl,sqlite,...   Comma-list of formats to emit
                                 (jsonl, sqlite, graphml; default: all three)
    --ontology <path>            Override ontology path
                                 (default: <wiki-dir>/graph/ontology.yaml)

Examples:
    uv run --script wiki_graph_extract.py wiki/
    uv run --script wiki_graph_extract.py wiki/ --out wiki/graph --formats jsonl,sqlite
"""

import argparse
import hashlib
import json
import re
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

import wiki_markdown
from wiki_markdown import configure_utf8_streams, extract_wikilinks
# The SQLite shape is shared with wiki_graph_query.py, which rebuilds the
# database from the committed exports and cannot import this module (PyYAML).
from wiki_graph_store import normalize_for_json as _normalize_for_json
from wiki_graph_store import write_sqlite as _write_sqlite


configure_utf8_streams()

# Node-id prefix for a cited document that is not itself a wiki page.
EXTERNAL_DOC_PREFIX = "document:"

try:
    import yaml
except ImportError:
    print(
        "wiki_graph_extract.py requires PyYAML. "
        "Run it with `uv run --script wiki_graph_extract.py ...`.",
        file=sys.stderr,
    )
    sys.exit(2)


FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)

SKIP_TOP_LEVEL_FILES = {"SCHEMA.md", "index.md", "log.md", "README.md"}
SKIP_TOP_LEVEL_DIRS = wiki_markdown.SKIP_TOP_LEVEL_DIRS

DEFAULT_FORMATS = ["jsonl", "sqlite", "graphml"]


# ---------------------------------------------------------------------------
# Page collection
# ---------------------------------------------------------------------------


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Extract YAML frontmatter using PyYAML. Returns (meta, body)."""
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    fm_text = m.group(1)
    body = text[m.end():]
    try:
        meta = yaml.safe_load(fm_text) or {}
    except yaml.YAMLError:
        meta = {}
    if not isinstance(meta, dict):
        meta = {}
    return meta, body


def collect_pages(wiki_root: Path) -> list[dict]:
    pages = []
    for md_path in sorted(wiki_root.rglob("*.md")):
        rel = md_path.relative_to(wiki_root)
        if rel.parts[0] in SKIP_TOP_LEVEL_FILES or rel.parts[0] in SKIP_TOP_LEVEL_DIRS:
            continue
        if rel.name.startswith("."):
            continue
        try:
            text = md_path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        meta, body = parse_frontmatter(text)
        links = extract_wikilinks(body)
        pages.append({
            "path": str(md_path),
            "rel_path": str(rel).replace("\\", "/"),
            "slug": md_path.stem,
            "meta": meta,
            "body": body,
            "links": links,
        })
    return pages


# ---------------------------------------------------------------------------
# Ontology
# ---------------------------------------------------------------------------


def load_ontology(path: Path) -> dict:
    if not path.exists():
        return {"node_types": {}, "predicates": {}}
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as e:
        print(f"Ontology parse error ({path}): {e}", file=sys.stderr)
        sys.exit(2)
    data.setdefault("node_types", {})
    data.setdefault("predicates", {})
    return data


def derive_node_type(meta: dict, ontology: dict) -> str | None:
    """Map a page's frontmatter to a node_type using ontology[node_types][*].maps_from."""
    page_type = meta.get("type")
    page_kind = meta.get("kind")
    explicit = (meta.get("graph") or {}).get("node_type") if isinstance(meta.get("graph"), dict) else None
    if explicit:
        return explicit
    # Try (type, kind) match first, then type-only.
    type_kind_match = None
    type_only_match = None
    for nt_name, nt_def in ontology["node_types"].items():
        maps = (nt_def or {}).get("maps_from") or {}
        m_type = maps.get("type")
        m_kind = maps.get("kind")
        if m_type and m_type == page_type:
            if m_kind and m_kind == page_kind:
                type_kind_match = nt_name
                break
            if not m_kind and type_only_match is None:
                type_only_match = nt_name
    return type_kind_match or type_only_match


# ---------------------------------------------------------------------------
# Node + edge construction
# ---------------------------------------------------------------------------


def build_nodes(pages: list[dict], ontology: dict) -> tuple[list[dict], dict, list[dict]]:
    """Build the node list + slug→node_id index + alias rows. Returns (nodes, slug_to_id, aliases)."""
    nodes: list[dict] = []
    slug_to_id: dict[str, str] = {}
    aliases: list[dict] = []
    seen_ids: set[str] = set()

    for p in pages:
        meta = p["meta"]
        graph_meta = meta.get("graph") if isinstance(meta.get("graph"), dict) else {}
        node_type = derive_node_type(meta, ontology) or "concept"
        explicit_id = graph_meta.get("node_id")
        node_id = explicit_id or f"{node_type}:{p['slug']}"

        # Skip duplicates — first one wins; lint will flag this.
        if node_id in seen_ids:
            continue
        seen_ids.add(node_id)

        node = {
            "id": node_id,
            "slug": p["slug"],
            "title": meta.get("title") or p["slug"],
            "page_type": meta.get("type") or "",
            "node_type": node_type,
            "kind": meta.get("kind") or "",
            "tags": list(meta.get("tags") or []),
            "aliases": list(graph_meta.get("aliases") or []),
            "path": p["rel_path"],
            "created": meta.get("created") or "",
            "updated": meta.get("updated") or "",
            "canonical": bool(graph_meta.get("canonical", False)),
        }
        nodes.append(node)
        slug_to_id[p["slug"]] = node_id
        for alias in node["aliases"]:
            aliases.append({"alias": str(alias), "node_id": node_id})

    return nodes, slug_to_id, aliases


def build_document_nodes(pages: list[dict], slug_to_id: dict[str, str]) -> tuple[list[dict], dict]:
    """Nodes for the external documents that pages cite in `sources:`.

    `sources:` used to be resolved against wiki slugs alone, and every entry
    that did not resolve was silently dropped. In a wiki whose pages cite
    repo-relative paths or URLs, that meant the provenance layer was empty and
    nothing said so: `sourced_from` and `summarizes_raw` both emitted zero
    edges while lint and the extractor reported success.

    Giving each cited document a node of its own makes provenance a first-class
    part of the graph — "which pages derive from this doc" becomes a query
    rather than a grep — and keeps every `sourced_from` edge pointing at
    something that exists.

    A path that does not exist on disk still gets a node: the graph stays
    closed, and judging whether the citation is real is `wiki_graph_lint.py`'s
    job, not the compiler's.
    """
    cited: set[str] = set()
    for p in pages:
        for entry in p["meta"].get("sources") or []:
            entry = str(entry).strip()
            if entry and entry not in slug_to_id:
                cited.add(entry)

    nodes, ids = [], {}
    for entry in sorted(cited):
        node_id = f"{EXTERNAL_DOC_PREFIX}{entry}"
        ids[entry] = node_id
        nodes.append({
            "id": node_id,
            "slug": entry,
            "title": entry.rsplit("/", 1)[-1] or entry,
            "page_type": "",
            "node_type": "document",
            "kind": "",
            "tags": [],
            "aliases": [],
            "path": entry,
            "created": "",
            "updated": "",
            "canonical": False,
        })
    return nodes, ids


def edge_id(subject: str, predicate: str, obj: str, source: str | None, evidence: str | None) -> str:
    # Truncated to 96 bits — collision risk is negligible at any plausible
    # wiki scale and shorter ids keep the JSONL/sqlite/graphml outputs readable.
    h = hashlib.sha256()
    parts = [subject or "", predicate or "", obj or "", source or "", evidence or ""]
    h.update("\x1f".join(parts).encode("utf-8"))
    return h.hexdigest()[:24]


def make_edge(*, subject, predicate, obj, source, evidence, confidence, status,
              extraction_method, page, extras: dict | None = None) -> dict:
    return {
        "id": edge_id(subject, predicate, obj, source, evidence),
        "subject": subject,
        "predicate": predicate,
        "object": obj,
        "source": source or "",
        "evidence": evidence or "",
        "confidence": confidence or "",
        "status": status or "",
        "extraction_method": extraction_method,
        "page": page,
        "extras": extras or {},
    }


def build_edges(pages: list[dict], slug_to_id: dict[str, str],
                document_ids: dict[str, str] | None = None) -> list[dict]:
    edges: list[dict] = []
    seen_ids: set[str] = set()
    document_ids = document_ids or {}

    def push(edge: dict) -> None:
        if edge["id"] in seen_ids:
            return
        seen_ids.add(edge["id"])
        edges.append(edge)

    for p in pages:
        slug = p["slug"]
        subject_id = slug_to_id.get(slug)
        if not subject_id:
            continue
        meta = p["meta"]
        graph_meta = meta.get("graph") if isinstance(meta.get("graph"), dict) else {}

        # 1. Typed semantic edges from graph.relationships[].
        for rel in graph_meta.get("relationships") or []:
            if not isinstance(rel, dict):
                continue
            obj = rel.get("object")
            predicate = rel.get("predicate")
            if not (obj and predicate):
                continue
            extras = {
                k: rel[k] for k in ("valid_from", "valid_to", "notes", "raw_ref",
                                    "contradicts", "supersedes")
                if k in rel and rel[k] is not None
            }
            push(make_edge(
                subject=subject_id,
                predicate=str(predicate),
                obj=str(obj),
                source=rel.get("source"),
                evidence=rel.get("evidence"),
                confidence=rel.get("confidence"),
                status=rel.get("status"),
                extraction_method="explicit_graph_frontmatter",
                page=p["rel_path"],
                extras=extras,
            ))

        # 2. Mentions edges from body wikilinks.
        seen_targets: set[str] = set()
        for link in p["links"]:
            target_slug = link.split("#")[0].strip()
            if not target_slug or target_slug == slug:
                continue
            target_id = slug_to_id.get(target_slug)
            if not target_id or target_id in seen_targets:
                continue
            seen_targets.add(target_id)
            push(make_edge(
                subject=subject_id,
                predicate="mentions",
                obj=target_id,
                source=None,
                evidence=None,
                confidence="low",
                status="current",
                extraction_method="body_wikilink",
                page=p["rel_path"],
            ))

        # 3. sourced_from edges from frontmatter `sources:`.
        for entry in meta.get("sources") or []:
            entry = str(entry).strip()
            if not entry:
                continue
            target = slug_to_id.get(entry)
            if target is not None:
                # On a source page, `sources:` naming another wiki page is not
                # provenance — the raw file is, and rule 4 below covers it.
                # The guard is deliberately narrowed to this wiki-slug case: a
                # source page's citation of an external document IS its
                # provenance, and skipping source pages wholesale discarded it.
                if meta.get("type") == "source":
                    continue
            else:
                # An external document. Source pages keep this edge: the doc a
                # source page summarizes is precisely its provenance, and it is
                # the most load-bearing provenance edge in the graph.
                target = document_ids.get(entry)
            if not target or target == subject_id:
                continue
            push(make_edge(
                subject=subject_id,
                predicate="sourced_from",
                obj=target,
                source=entry,
                evidence=None,
                confidence="high",
                status="current",
                extraction_method="frontmatter_sources",
                page=p["rel_path"],
            ))

        # 4. summarizes_raw edges from source pages' raw: field.
        if meta.get("type") == "source":
            raw_path = meta.get("raw")
            if raw_path:
                push(make_edge(
                    subject=subject_id,
                    predicate="summarizes_raw",
                    obj=f"raw:{raw_path}",
                    source=None,
                    evidence=None,
                    confidence="high",
                    status="current",
                    extraction_method="frontmatter_raw",
                    page=p["rel_path"],
                ))

    return edges


# ---------------------------------------------------------------------------
# Output writers
# ---------------------------------------------------------------------------


def write_jsonl(out_dir: Path, nodes: list[dict], edges: list[dict]) -> None:
    nodes_sorted = sorted(nodes, key=lambda n: n["id"])
    edges_sorted = sorted(edges, key=lambda e: e["id"])
    with (out_dir / "nodes.jsonl").open("w", encoding="utf-8") as f:
        for n in nodes_sorted:
            f.write(json.dumps(_normalize_for_json(n), sort_keys=True, ensure_ascii=False))
            f.write("\n")
    with (out_dir / "edges.jsonl").open("w", encoding="utf-8") as f:
        for e in edges_sorted:
            f.write(json.dumps(_normalize_for_json(e), sort_keys=True, ensure_ascii=False))
            f.write("\n")


def write_graphml(out_dir: Path, nodes: list[dict], edges: list[dict]) -> None:
    ns = "http://graphml.graphdrawing.org/xmlns"
    ET.register_namespace("", ns)
    root = ET.Element(f"{{{ns}}}graphml")

    keys = [
        ("d_title", "node", "title", "string"),
        ("d_node_type", "node", "node_type", "string"),
        ("d_page_type", "node", "page_type", "string"),
        ("d_path", "node", "path", "string"),
        ("d_predicate", "edge", "predicate", "string"),
        ("d_confidence", "edge", "confidence", "string"),
        ("d_status", "edge", "status", "string"),
        ("d_source", "edge", "source", "string"),
    ]
    for kid, kfor, kname, ktype in keys:
        k = ET.SubElement(root, f"{{{ns}}}key")
        k.set("id", kid)
        k.set("for", kfor)
        k.set("attr.name", kname)
        k.set("attr.type", ktype)

    graph = ET.SubElement(root, f"{{{ns}}}graph")
    graph.set("id", "wiki")
    graph.set("edgedefault", "directed")

    for n in sorted(nodes, key=lambda n: n["id"]):
        node_el = ET.SubElement(graph, f"{{{ns}}}node")
        node_el.set("id", n["id"])
        for kid, kfor, kname, _ in keys:
            if kfor != "node":
                continue
            data = ET.SubElement(node_el, f"{{{ns}}}data")
            data.set("key", kid)
            data.text = str(n.get(kname) or "")

    for e in sorted(edges, key=lambda e: e["id"]):
        edge_el = ET.SubElement(graph, f"{{{ns}}}edge")
        edge_el.set("id", e["id"])
        edge_el.set("source", e["subject"])
        edge_el.set("target", e["object"])
        for kid, kfor, kname, _ in keys:
            if kfor != "edge":
                continue
            data = ET.SubElement(edge_el, f"{{{ns}}}data")
            data.set("key", kid)
            data.text = str(e.get(kname) or "")

    tree = ET.ElementTree(root)
    ET.indent(tree, space="  ")
    tree.write(out_dir / "graph.graphml", encoding="utf-8", xml_declaration=True)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("wiki", type=Path, help="Wiki directory.")
    parser.add_argument("--out", type=Path, help="Output directory (default: <wiki>/graph)")
    parser.add_argument("--formats", default=",".join(DEFAULT_FORMATS),
                        help="Comma-list: jsonl, sqlite, graphml")
    parser.add_argument("--ontology", type=Path, help="Ontology file (default: <wiki>/graph/ontology.yaml)")
    args = parser.parse_args()

    if not args.wiki.exists():
        print(f"Wiki directory not found: {args.wiki}", file=sys.stderr)
        sys.exit(1)

    out_dir = args.out or (args.wiki / "graph")
    out_dir.mkdir(parents=True, exist_ok=True)
    ontology_path = args.ontology or (args.wiki / "graph" / "ontology.yaml")
    ontology = load_ontology(ontology_path)
    formats = [f.strip().lower() for f in args.formats.split(",") if f.strip()]
    unknown = [f for f in formats if f not in DEFAULT_FORMATS]
    if unknown:
        print(f"Unknown formats: {unknown}. Allowed: {DEFAULT_FORMATS}", file=sys.stderr)
        sys.exit(1)

    pages = collect_pages(args.wiki)
    nodes, slug_to_id, aliases = build_nodes(pages, ontology)
    document_nodes, document_ids = build_document_nodes(pages, slug_to_id)
    nodes = nodes + document_nodes
    edges = build_edges(pages, slug_to_id, document_ids)

    if "jsonl" in formats:
        write_jsonl(out_dir, nodes, edges)
    if "sqlite" in formats:
        _write_sqlite(out_dir / "graph.sqlite", nodes, aliases, edges)
    if "graphml" in formats:
        write_graphml(out_dir, nodes, edges)

    print(f"Extracted {len(nodes)} nodes, {len(edges)} edges → {out_dir}")
    breakdown = defaultdict(int)
    for e in edges:
        breakdown[e["predicate"]] += 1
    for pred, count in sorted(breakdown.items(), key=lambda x: (-x[1], x[0])):
        print(f"  {pred:20s} {count}")


if __name__ == "__main__":
    main()
