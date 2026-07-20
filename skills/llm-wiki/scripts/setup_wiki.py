#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "fastembed==0.8.0",
#   "pyyaml==6.0.3",
#   "sqlite-vec==0.1.9",
# ]
# ///
"""Install and verify LLM Wiki runtime dependencies, model, and local indexes."""

import argparse
import json
from importlib.metadata import version
from pathlib import Path

# Importability check for the pinned graph-script dependency.
import yaml

import wiki_search


def prepare(wiki_root: Path, cache_path: Path | None = None) -> dict:
    """Download the pinned model and synchronize every current wiki section."""
    pages = wiki_search.collect_pages(wiki_root, cache_path)
    sections = wiki_search.collect_sections(pages)
    model, sqlite_vec, dimension = wiki_search.load_local_embedding_backend()
    connection = wiki_search.open_vector_index(wiki_root, sqlite_vec, dimension)
    try:
        locator_ids = wiki_search.sync_vector_index(connection, sqlite_vec, model, sections)
        vector_count = connection.execute("SELECT count(*) FROM semantic_vectors").fetchone()[0]
    finally:
        connection.close()

    if vector_count != len(locator_ids):
        raise RuntimeError(
            f"semantic index is inconsistent: {len(locator_ids)} sections, {vector_count} vectors"
        )

    return {
        "status": "ready",
        "wiki": str(wiki_root),
        "dependencies": {
            "fastembed": version("fastembed"),
            "pyyaml": version("pyyaml"),
            "sqlite-vec": version("sqlite-vec"),
        },
        "model": wiki_search.LOCAL_EMBED_MODEL,
        "dimension": dimension,
        "pages": len(pages),
        "sections": len(locator_ids),
        "vectors": vector_count,
        "vector_index": str(wiki_root / ".wiki-cache" / wiki_search.VECTOR_INDEX_NAME),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wiki", type=Path, default=Path("wiki"), help="Wiki directory (default: ./wiki).")
    parser.add_argument(
        "--cache",
        nargs="?",
        const="AUTO",
        default=None,
        help="Build the incremental parse cache too (default path: wiki/.wiki-cache/search-index.json).",
    )
    args = parser.parse_args()

    if not args.wiki.is_dir():
        parser.error(f"wiki directory not found: {args.wiki}")
    cache_path = None
    if args.cache:
        cache_path = args.wiki / ".wiki-cache" / "search-index.json" if args.cache == "AUTO" else Path(args.cache)
    print(json.dumps(prepare(args.wiki, cache_path), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
