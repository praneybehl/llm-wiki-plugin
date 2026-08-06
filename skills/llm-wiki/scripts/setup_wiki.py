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


def verify_parse_cache(cache_path: Path, pages: list[dict]) -> None:
    """Setup promises a usable parse cache; a search only prefers one.

    `collect_pages()` writes the cache best-effort — a query that already has
    its answer should not fail because a concurrent writer won the rename. Setup
    is the opposite contract: `references/retrieval-setup.md` makes
    `search-index.json` a precondition of readiness, so an unwritable path,
    a cache from an older parser, or a partial write must stop `"status":
    "ready"` instead of being reported as a healthy wiki.
    """
    if not cache_path.exists():
        raise RuntimeError(f"parse cache was not written: {cache_path}")
    # Re-reading through the loader is the point: it enforces the current
    # PARSE_CACHE_SCHEMA and the per-entry shape, so setup verifies the file a
    # later search would actually accept, not merely that some file exists.
    # `None` means unusable; an empty map means a usable cache for a wiki with
    # nothing ingested yet, which is exactly the state `/wiki:init` leaves
    # behind — treating that as corruption would fail every new wiki's setup.
    cached = wiki_search.load_parse_cache(cache_path)
    if cached is None:
        raise RuntimeError(
            f"parse cache is unusable (wrong schema or malformed): {cache_path}"
        )
    missing = sorted({page["rel_path"] for page in pages} - cached.keys())
    if missing:
        raise RuntimeError(
            f"parse cache is incomplete: {len(missing)} of {len(pages)} pages absent, "
            f"first is {missing[0]}"
        )


def prepare(wiki_root: Path, cache_path: Path | None = None) -> dict:
    """Download the pinned model and synchronize every current wiki section."""
    pages = wiki_search.collect_pages(wiki_root, cache_path)
    if cache_path is not None:
        verify_parse_cache(cache_path, pages)
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
    try:
        payload = prepare(args.wiki, cache_path)
    except Exception as exc:  # noqa: BLE001 - this is the CLI boundary
        # Structured on stdout, non-zero on exit: the caller that parses the
        # ready envelope can parse the failure too, and a shell check still sees
        # a failure without reading JSON.
        #
        # Broad on purpose. The readiness contract promises an envelope on every
        # failure, and the failures here come from three third-party layers:
        # sqlite3 (`OperationalError` when the index path is unwritable),
        # FastEmbed and sqlite-vec (model download, extension loading), and the
        # filesystem underneath both. Enumerating those exception types means
        # guessing at other packages' internals, and every wrong guess turns a
        # documented `{"status": "error"}` back into a traceback. `Exception`
        # deliberately does not cover KeyboardInterrupt or SystemExit, so Ctrl-C
        # and explicit exits still behave normally. The type name is kept in the
        # message so a traceback is not needed to tell the layers apart.
        detail = str(exc) or repr(exc)
        message = detail if isinstance(exc, RuntimeError) else f"{type(exc).__name__}: {detail}"
        print(json.dumps({"status": "error", "wiki": str(args.wiki), "error": message},
                         ensure_ascii=False, indent=2))
        raise SystemExit(1)
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
