#!/usr/bin/env python3
"""
wiki_search.py — Section-level BM25 and optional hybrid search over wiki pages.

Fallback for when index-first navigation doesn't surface the right pages.
Pure-Python implementation (no dependencies beyond stdlib) so it runs anywhere.

Usage:
    python wiki_search.py "query terms" [options]

Options:
    --wiki <dir>            Wiki directory (default: ./wiki)
    --top N                 Return top N results (default: 10)
    --type <type>           Filter by frontmatter type (source|entity|concept|synthesis|...)
    --tag <tag>             Filter by tag (repeatable)
    --since YYYY-MM-DD      Only pages updated on or after this date
    --backlinks <slug>      Find pages that link to <slug>; ignores the query
    --top-linked N          Show the N most-linked-to pages (hubs); ignores the query
    --cache [<path>]        Incremental parse cache (default: wiki/.wiki-cache/search-index.json)
    --granularity <mode>    Search sections (default) or whole pages
    --per-page N            Maximum section results per page (default: 2)
    --json                  Emit structured evidence rows
    --no-embed              Force lexical-only BM25
    --approve-embedding-build
                            Approve an initial/full provider-specific vector build

Examples:
    python wiki_search.py "diffusion training stability" --top 5
    python wiki_search.py "alignment" --type concept --tag safety
    python wiki_search.py "" --backlinks transformer
    python wiki_search.py "" --top-linked 10
"""

import argparse
import json
import hashlib
import math
import re
import os
import sys
from collections import Counter, defaultdict
from datetime import date, datetime
from pathlib import Path
from urllib import error as urllib_error
from urllib import request as urllib_request


WIKILINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]")
FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
TOKEN_RE = re.compile(r"[a-z0-9]+")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
EMBEDDING_MODE_RE = re.compile(
    r"^\s*-\s*Embedding mode:\s*`?(lexical|openai|custom|deferred|undecided)`?",
    re.IGNORECASE | re.MULTILINE,
)
EMBEDDING_CACHE_VERSION = 3


class LegacyEmbeddingCacheError(RuntimeError):
    pass

class EmbeddingBuildApprovalError(RuntimeError):
    pass


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Lightweight YAML-ish frontmatter parser. Returns (metadata, body)."""
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    fm_text = m.group(1)
    body = text[m.end():]
    meta = {}
    current_key = None
    for line in fm_text.split("\n"):
        if not line.strip():
            continue
        # Inline list: tags: [a, b, c]
        kv = re.match(r"^([a-zA-Z_]+):\s*(.*)$", line)
        if kv:
            key, value = kv.group(1), kv.group(2).strip()
            if value.startswith("[") and value.endswith("]"):
                items = [x.strip().strip('"').strip("'") for x in value[1:-1].split(",") if x.strip()]
                meta[key] = items
            elif value:
                meta[key] = value.strip('"').strip("'")
            else:
                meta[key] = []
                current_key = key
        elif line.startswith("  - ") and current_key:
            meta[current_key].append(line[4:].strip().strip('"').strip("'"))
    return meta, body


def tokenize(text: str) -> list[str]:
    return TOKEN_RE.findall(text.lower())


def embedding_mode_from_schema(wiki_root: Path) -> str:
    """Return the user-approved embedding mode, defaulting safely to undecided."""
    try:
        schema = (wiki_root / "SCHEMA.md").read_text(encoding="utf-8")
    except OSError:
        return "undecided"
    match = EMBEDDING_MODE_RE.search(schema)
    return match.group(1).lower() if match else "undecided"


def slug_from_path(path: Path, wiki_root: Path) -> str:
    return path.stem


def extract_wikilinks(body: str) -> list[str]:
    return [m.group(1).strip() for m in WIKILINK_RE.finditer(body)]


def cache_page_body(sections: list[dict]) -> str:
    """Reconstruct searchable Markdown from cached section data."""
    chunks = []
    for section in sections:
        if section["heading_path"]:
            chunks.append("#" * section["level"] + " " + section["heading_path"][-1])
        chunks.append(section["text"])
    return "\n".join(chunks)


def load_parse_cache(cache_path: Path) -> dict:
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        print("cache: rebuilding (missing)", file=sys.stderr)
        return {}
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        print(f"cache: rebuilding ({exc})", file=sys.stderr)
        return {}
    if not isinstance(payload, dict) or payload.get("schema") != 1:
        print("cache: rebuilding (unsupported schema)", file=sys.stderr)
        return {}
    files = payload.get("files")
    if not isinstance(files, dict):
        print("cache: rebuilding (invalid files)", file=sys.stderr)
        return {}
    for rel_path, entry in files.items():
        sections = entry.get("sections") if isinstance(entry, dict) else None
        valid_sections = (
            isinstance(sections, list)
            and all(
                isinstance(section, dict)
                and isinstance(section.get("heading_path"), list)
                and all(isinstance(heading, str) for heading in section["heading_path"])
                and isinstance(section.get("level"), int)
                and isinstance(section.get("text"), str)
                for section in sections
            )
        )
        if not (
            isinstance(rel_path, str)
            and isinstance(entry, dict)
            and isinstance(entry.get("sha256"), str)
            and isinstance(entry.get("meta"), dict)
            and isinstance(entry.get("links"), list)
            and all(isinstance(link, str) for link in entry["links"])
            and valid_sections
        ):
            print(f"cache: rebuilding (invalid entry: {rel_path})", file=sys.stderr)
            return {}
    return files


def write_parse_cache(cache_path: Path, files: dict) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(str(cache_path) + ".tmp")
    temporary.write_text(
        json.dumps({"schema": 1, "files": files}, ensure_ascii=False, sort_keys=True),
        encoding="utf-8",
    )
    os.replace(temporary, cache_path)


def collect_pages(wiki_root: Path, cache_path: Path | None = None) -> list[dict]:
    """Walk the wiki and return [{path, slug, meta, body, tokens, links}]."""
    pages = []
    cached_files = load_parse_cache(cache_path) if cache_path else {}
    next_cache = {}
    for md_path in wiki_root.rglob("*.md"):
        rel = md_path.relative_to(wiki_root)
        if rel.parts[0] in {"SCHEMA.md", "index.md", "log.md"} or rel.name.startswith("."):
            continue
        if rel.parts[0] in {"indexes", "graph", "raw", ".wiki-cache"}:
            continue
        rel_path = str(rel)
        try:
            raw = md_path.read_bytes()
        except OSError:
            continue
        digest = hashlib.sha256(raw).hexdigest()
        cached = cached_files.get(rel_path)
        if cached and cached.get("sha256") == digest:
            meta = cached.get("meta", {})
            links = cached.get("links", [])
            sections = cached.get("sections", [])
            body = cache_page_body(sections)
        else:
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                continue
            meta, body = parse_frontmatter(text)
            links = extract_wikilinks(body)
            title = meta.get("title") or slug_from_path(md_path, wiki_root)
            sections = split_sections(title, body)
        next_cache[rel_path] = {
            "sha256": digest,
            "meta": meta,
            "links": links,
            "sections": [
                {
                    "heading_path": section["heading_path"],
                    "level": section["level"],
                    "text": section["text"],
                }
                for section in sections
            ],
        }
        pages.append({
            "path": str(md_path),
            "rel_path": rel_path,
            "slug": slug_from_path(md_path, wiki_root),
            "meta": meta,
            "body": body,
            "tokens": tokenize(body + " " + meta.get("title", "")),
            "links": links,
            "sections": [
                {**section, "section_index": index}
                for index, section in enumerate(sections)
            ],
        })
    pages.sort(key=lambda page: page["rel_path"])
    if cache_path:
        write_parse_cache(cache_path, next_cache)
    return pages


def split_sections(title: str, body: str) -> list[dict]:
    """Split a page body into sections at ATX headings outside code fences."""
    del title  # Kept in the API for parity with the TypeScript implementation.
    sections = []
    heading_stack: list[tuple[int, str]] = []
    current_path: list[str] = []
    current_level = 0
    current_lines: list[str] = []
    in_fence = False

    def append_section() -> None:
        sections.append({
            "heading_path": current_path.copy(),
            "level": current_level,
            "text": "\n".join(current_lines),
            "section_index": len(sections),
        })

    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith(("```", "~~~")):
            in_fence = not in_fence
            current_lines.append(line)
            continue
        heading = None if in_fence else HEADING_RE.match(line)
        if not heading:
            current_lines.append(line)
            continue

        append_section()
        current_level = len(heading.group(1))
        heading_text = heading.group(2).strip()
        while heading_stack and heading_stack[-1][0] >= current_level:
            heading_stack.pop()
        heading_stack.append((current_level, heading_text))
        current_path = [text for _, text in heading_stack]
        current_lines = []

    append_section()
    return sections


def collect_sections(pages: list[dict]) -> list[dict]:
    """Expand pages into searchable section rows in deterministic order."""
    rows = []
    for page in pages:
        title = page["meta"].get("title") or page["slug"]
        for section in page.get("sections") or split_sections(title, page["body"]):
            searchable = title + " " + " ".join(section["heading_path"]) + " " + section["text"]
            rows.append({
                "page": page,
                **section,
                "searchable_text": searchable,
                "tokens": tokenize(searchable),
            })
    return rows


def build_bm25(pages: list[dict]) -> dict:
    """Build a BM25 index. Returns {df, avgdl, N, doc_lens, term_freqs}."""
    N = len(pages)
    df = Counter()
    doc_lens = []
    term_freqs = []
    for page in pages:
        tokens = page["tokens"]
        doc_lens.append(len(tokens))
        tf = Counter(tokens)
        term_freqs.append(tf)
        for term in tf:
            df[term] += 1
    avgdl = sum(doc_lens) / N if N else 0
    return {"N": N, "df": df, "avgdl": avgdl, "doc_lens": doc_lens, "term_freqs": term_freqs}


def bm25_score(query_tokens: list[str], doc_idx: int, idx: dict, k1: float = 1.5, b: float = 0.75) -> float:
    score = 0.0
    N = idx["N"]
    df = idx["df"]
    avgdl = idx["avgdl"]
    dl = idx["doc_lens"][doc_idx]
    tf = idx["term_freqs"][doc_idx]
    for term in query_tokens:
        if term not in df:
            continue
        idf = math.log(1 + (N - df[term] + 0.5) / (df[term] + 0.5))
        f = tf.get(term, 0)
        if f == 0:
            continue
        denom = f + k1 * (1 - b + b * (dl / avgdl if avgdl else 1))
        score += idf * (f * (k1 + 1)) / denom
    return score


def parse_date(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


def passes_filters(page: dict, args) -> bool:
    meta = page["meta"]
    if args.type and meta.get("type") != args.type:
        return False
    if args.tag:
        page_tags = set(meta.get("tags", []) or [])
        if not all(t in page_tags for t in args.tag):
            return False
    if args.since:
        since = parse_date(args.since)
        updated = parse_date(meta.get("updated"))
        if since and updated and updated < since:
            return False
        if since and not updated:
            return False
    return True


def embed_config(mode: str) -> dict | None:
    if mode == "openai":
        key = os.environ.get("OPENAI_API_KEY")
        if not key:
            return None
        return {
            "provider": "openai",
            "url": "https://api.openai.com/v1/embeddings",
            "key": key,
            "model": os.environ.get("LLM_WIKI_EMBED_MODEL") or "text-embedding-3-small",
        }
    if mode == "custom":
        url = os.environ.get("LLM_WIKI_EMBED_URL")
        model = os.environ.get("LLM_WIKI_EMBED_MODEL")
        if not url or not model:
            return None
        return {
            "provider": "custom",
            "url": url,
            "key": os.environ.get("LLM_WIKI_EMBED_KEY"),
            "model": model,
        }
    return None


def embed_texts(texts: list[str], cfg: dict) -> list[list[float]]:
    def post_batch(batch: list[str], can_retry: bool = True) -> list[list[float]]:
        payload = json.dumps({"model": cfg["model"], "input": batch}).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if cfg.get("key"):
            headers["Authorization"] = f"Bearer {cfg['key']}"
        request = urllib_request.Request(cfg["url"], data=payload, headers=headers, method="POST")
        try:
            with urllib_request.urlopen(request, timeout=30) as response:
                decoded = json.loads(response.read().decode("utf-8"))
        except urllib_error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            if can_retry and 400 <= exc.code < 500 and "input" in detail.lower() and len(batch) > 1:
                midpoint = max(1, len(batch) // 2)
                return post_batch(batch[:midpoint], False) + post_batch(batch[midpoint:], False)
            raise RuntimeError(f"HTTP {exc.code}: {detail[:200]}") from exc
        data = decoded.get("data")
        if not isinstance(data, list):
            raise ValueError("embedding response has no data list")
        ordered = sorted(data, key=lambda item: item.get("index", -1))
        vectors = [item.get("embedding") for item in ordered]
        if len(vectors) != len(batch) or any(not isinstance(vector, list) for vector in vectors):
            raise ValueError(f"embedding response returned {len(vectors)} vectors for {len(batch)} inputs")
        return [[float(value) for value in vector] for vector in vectors]

    vectors = []
    for offset in range(0, len(texts), 64):
        vectors.extend(post_batch(texts[offset:offset + 64]))
    return vectors


def embedding_failure_label(exc: Exception) -> str:
    current: BaseException | None = exc
    while current is not None:
        if isinstance(current, urllib_error.HTTPError):
            return f"HTTP {current.code}"
        current = current.__cause__
    return type(exc).__name__


def cosine_similarity(left: list[float], right: list[float]) -> float:
    if len(left) != len(right):
        raise ValueError(f"embedding dimension mismatch: {len(left)} != {len(right)}")
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if not left_norm or not right_norm:
        return 0.0
    return sum(a * b for a, b in zip(left, right)) / (left_norm * right_norm)


def embedding_provider_identity(cfg: dict) -> str:
    return "\n".join((
        cfg["provider"],
        cfg["url"].rstrip("/"),
        cfg["model"],
    ))


def embedding_provider_fingerprint(cfg: dict) -> str:
    identity = embedding_provider_identity(cfg)
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def load_embedding_cache(
    path: Path,
    cfg: dict,
) -> tuple[dict[str, list[float]], bool, bool]:
    vectors = {}
    has_legacy_rows = False
    provider_approved = False
    fingerprint = embedding_provider_fingerprint(cfg)
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return vectors, False, False
    for line in lines:
        try:
            row = json.loads(line)
            if row.get("cache_version") != EMBEDDING_CACHE_VERSION:
                if (
                    row.get("cache_version") is not None
                    or (
                        isinstance(row.get("key"), str)
                        and isinstance(row.get("vec"), list)
                    )
                ):
                    has_legacy_rows = True
                continue
            if row.get("kind") == "provider_marker":
                if row.get("provider_fingerprint") == fingerprint:
                    provider_approved = True
                continue
            if isinstance(row.get("key"), str) and isinstance(row.get("vec"), list):
                vectors[row["key"]] = [float(value) for value in row["vec"]]
        except (json.JSONDecodeError, TypeError, ValueError):
            continue
    return vectors, has_legacy_rows, provider_approved


def section_embedding_key(cfg: dict, text: str) -> str:
    fingerprint = embedding_provider_fingerprint(cfg)
    return hashlib.sha256(f"{fingerprint}\n{text}".encode("utf-8")).hexdigest()


def section_vectors(
    sections: list[dict],
    wiki_root: Path,
    cfg: dict,
    approve_build: bool = False,
) -> list[list[float]]:
    path = wiki_root / ".wiki-cache" / "embeddings.jsonl"
    cached, legacy_only, provider_approved = load_embedding_cache(path, cfg)
    if legacy_only:
        raise LegacyEmbeddingCacheError(
            "legacy embedding cache detected; approve a full rebuild, then remove "
            f"{path} and rerun with --approve-embedding-build"
        )
    keys = [section_embedding_key(cfg, section["searchable_text"]) for section in sections]
    missing = {}
    for key, section in zip(keys, sections):
        if key not in cached and key not in missing:
            missing[key] = section["searchable_text"]
    if missing and not provider_approved and not approve_build:
        raise EmbeddingBuildApprovalError(
            "provider's initial embedding build requires explicit approval; rerun "
            "with --approve-embedding-build only after the user approves sending "
            "all missing canonical sections"
        )
    if missing:
        print(f"embedding {len(missing)} new sections via {cfg['model']}...", file=sys.stderr)
        missing_keys = list(missing)
        new_vectors = embed_texts(list(missing.values()), cfg)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            for key, vector in zip(missing_keys, new_vectors):
                cached[key] = vector
                handle.write(json.dumps({
                    "cache_version": EMBEDDING_CACHE_VERSION,
                    "provider": cfg["provider"],
                    "key": key,
                    "model": cfg["model"],
                    "vec": vector,
                }) + "\n")
            if approve_build and not provider_approved:
                handle.write(json.dumps({
                    "cache_version": EMBEDDING_CACHE_VERSION,
                    "kind": "provider_marker",
                    "provider": cfg["provider"],
                    "model": cfg["model"],
                    "provider_fingerprint": embedding_provider_fingerprint(cfg),
                }) + "\n")
    elif approve_build and not provider_approved:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({
                "cache_version": EMBEDDING_CACHE_VERSION,
                "kind": "provider_marker",
                "provider": cfg["provider"],
                "model": cfg["model"],
                "provider_fingerprint": embedding_provider_fingerprint(cfg),
            }) + "\n")
    return [cached[key] for key in keys]


def collapse_snippet(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip())[:400]


def json_result(
    score: float,
    page: dict,
    section: dict | None = None,
    sections: list[dict] | None = None,
    retrievers: list[str] | None = None,
) -> dict:
    meta = page["meta"]
    heading_path = section["heading_path"] if section else []
    section_index = section["section_index"] if section else None
    prev_heading = None
    next_heading = None
    snippet_text = section["text"] if section else cache_page_body(page["sections"])
    snippet = collapse_snippet(snippet_text)
    if section is not None and sections is not None:
        index = section["section_index"]
        if index > 0:
            previous = sections[index - 1]["heading_path"]
            prev_heading = previous[-1] if previous else None
        if index + 1 < len(sections):
            following = sections[index + 1]["heading_path"]
            next_heading = following[-1] if following else None
    return {
        "slug": page["slug"],
        "rel_path": page["rel_path"],
        "type": meta.get("type"),
        "title": meta.get("title") or page["slug"],
        "heading_path": heading_path,
        "section_index": section_index,
        "score": round(score, 4),
        "retrievers": retrievers or ["bm25"],
        "snippet": snippet,
        "updated": meta.get("updated"),
        "tags": meta.get("tags", []) or [],
        "sources": meta.get("sources", []) or [],
        "neighbors": {"prev": prev_heading, "next": next_heading},
    }


def emit_json(args, results: list[dict], mode: str = "lexical") -> None:
    print(json.dumps({
        "query": args.query,
        "wiki": str(args.wiki),
        "granularity": args.granularity,
        "mode": mode,
        "results": results,
    }, ensure_ascii=False))


def emit_empty_json(args) -> None:
    print(json.dumps({"query": args.query, "results": []}, ensure_ascii=False))


def cmd_search(args, pages: list[dict]) -> None:
    filtered = [page for page in pages if passes_filters(page, args)]
    if not filtered:
        if args.json:
            emit_empty_json(args)
        else:
            print("No pages matched the filters.", file=sys.stderr)
        return
    query_tokens = tokenize(args.query)
    if not query_tokens:
        print("Empty query.", file=sys.stderr)
        return

    if args.granularity == "page":
        idx = build_bm25(filtered)
        scored = [(bm25_score(query_tokens, i, idx), i) for i in range(len(filtered))]
        scored.sort(key=lambda item: -item[0])
        top = [(score, filtered[i]) for score, i in scored[:args.top] if score > 0]
        if not top:
            if args.json:
                emit_empty_json(args)
            else:
                print("No matches.", file=sys.stderr)
            return
        if args.json:
            emit_json(args, [json_result(score, page) for score, page in top])
            return
        print(f"Top {len(top)} results for: {args.query!r}")
        print()
        for score, page in top:
            title = page["meta"].get("title") or page["slug"]
            page_type = page["meta"].get("type", "?")
            print(f"  [{score:6.2f}] [{page_type:9}] {title}")
            print(f"             {page['rel_path']}")
        return

    sections = collect_sections(filtered)
    idx = build_bm25(sections)
    bm25_ranked = [(bm25_score(query_tokens, i, idx), i) for i in range(len(sections))]
    bm25_ranked.sort(key=lambda item: -item[0])
    bm25_ranked = [item for item in bm25_ranked if item[0] > 0]
    ranked = [(score, section_index, ["bm25"]) for score, section_index in bm25_ranked]
    mode = "lexical"
    schema_mode = embedding_mode_from_schema(args.wiki)
    hybrid_selected = schema_mode in {"openai", "custom"}
    cfg = None if args.no_embed or not hybrid_selected else embed_config(schema_mode)
    if hybrid_selected and not args.no_embed and not cfg:
        print(
            f"warning: embedding mode {schema_mode!r} is selected but its provider is not configured; "
            "falling back to lexical",
            file=sys.stderr,
        )
    if cfg:
        try:
            vectors = section_vectors(
                sections,
                args.wiki,
                cfg,
                approve_build=args.approve_embedding_build,
            )
            query_vector = embed_texts([args.query], cfg)[0]
            embedding_ranked = [
                (cosine_similarity(query_vector, vector), index)
                for index, vector in enumerate(vectors)
            ]
            embedding_ranked.sort(key=lambda item: -item[0])
            lexical_top = bm25_ranked[:50]
            embedding_top = embedding_ranked[:50]
            candidate_order = [index for _, index in lexical_top]
            seen_candidates = set(candidate_order)
            for _, index in embedding_top:
                if index not in seen_candidates:
                    candidate_order.append(index)
                    seen_candidates.add(index)
            lexical_ranks = {index: rank for rank, (_, index) in enumerate(lexical_top, 1)}
            embedding_ranks = {index: rank for rank, (_, index) in enumerate(embedding_top, 1)}
            ranked = []
            for index in candidate_order:
                score = 0.0
                retrievers = []
                if index in lexical_ranks:
                    score += 1.0 / (60 + lexical_ranks[index])
                    retrievers.append("bm25")
                if index in embedding_ranks:
                    score += 1.0 / (60 + embedding_ranks[index])
                    retrievers.append("embedding")
                ranked.append((score, index, retrievers))
            ranked.sort(key=lambda item: -item[0])
            mode = "hybrid"
        except EmbeddingBuildApprovalError as exc:
            print(f"warning: {exc}; falling back to lexical", file=sys.stderr)
        except LegacyEmbeddingCacheError as exc:
            print(f"warning: {exc}; falling back to lexical", file=sys.stderr)
        except Exception as exc:
            label = embedding_failure_label(exc)
            print(f"warning: embedding backend failed ({label}); falling back to lexical", file=sys.stderr)

    page_counts = Counter()
    top_sections = []
    for score, section_index, retrievers in ranked:
        section = sections[section_index]
        rel_path = section["page"]["rel_path"]
        if page_counts[rel_path] >= args.per_page:
            continue
        page_counts[rel_path] += 1
        top_sections.append((score, section, retrievers))
        if len(top_sections) >= args.top:
            break
    if not top_sections:
        if args.json:
            emit_empty_json(args)
        else:
            print("No matches.", file=sys.stderr)
        return
    if args.json:
        sections_by_page = {page["rel_path"]: page["sections"] for page in filtered}
        emit_json(args, [
            json_result(
                score,
                section["page"],
                section,
                sections_by_page[section["page"]["rel_path"]],
                retrievers,
            )
            for score, section, retrievers in top_sections
        ], mode)
        return
    print(f"Top {len(top_sections)} results for: {args.query!r}")
    print()
    for score, section, _retrievers in top_sections:
        page = section["page"]
        title = page["meta"].get("title") or page["slug"]
        page_type = page["meta"].get("type", "?")
        print(f"  [{score:6.2f}] [{page_type:9}] {title}")
        print(f"             {page['rel_path']}")
        if section["heading_path"]:
            print(f"             § {' > '.join(section['heading_path'])}")


def cmd_backlinks(args, pages: list[dict]) -> None:
    target = args.backlinks
    inbound = []
    for page in pages:
        if target in page["links"]:
            inbound.append(page)
    if not inbound:
        print(f"No pages link to [[{target}]].", file=sys.stderr)
        return
    print(f"Pages linking to [[{target}]] ({len(inbound)}):")
    for page in inbound:
        title = page["meta"].get("title") or page["slug"]
        print(f"  - {title}  ({page['rel_path']})")


def cmd_top_linked(args, pages: list[dict]) -> None:
    inbound_count = Counter()
    for page in pages:
        for link in page["links"]:
            inbound_count[link] += 1
    top = inbound_count.most_common(args.top_linked)
    if not top:
        print("No links found in the wiki.", file=sys.stderr)
        return
    print(f"Top {len(top)} most-linked-to pages (hubs):")
    for slug, count in top:
        # Try to find the page for the title
        match = next((p for p in pages if p["slug"] == slug), None)
        title = (match["meta"].get("title") if match else None) or slug
        marker = "" if match else "  [BROKEN LINK]"
        print(f"  {count:4d}  {title}  ({slug}){marker}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("query", nargs="?", default="", help="Query terms.")
    parser.add_argument("--wiki", type=Path, default=Path("wiki"), help="Wiki directory (default: ./wiki).")
    parser.add_argument("--top", type=int, default=10, help="Top N results (default: 10).")
    parser.add_argument("--type", help="Filter by frontmatter type.")
    parser.add_argument("--tag", action="append", default=[], help="Filter by tag (repeatable).")
    parser.add_argument("--since", help="Only pages updated on or after YYYY-MM-DD.")
    parser.add_argument("--backlinks", help="Find pages linking to this slug.")
    parser.add_argument("--top-linked", type=int, help="Show the N most-linked-to pages.")
    parser.add_argument("--cache", nargs="?", const="AUTO", default=None,
                        help="Incremental parse cache path (default with no value: wiki/.wiki-cache/search-index.json).")
    parser.add_argument("--granularity", choices=("section", "page"), default="section",
                        help="Search sections (default) or whole pages.")
    parser.add_argument("--per-page", type=int, default=2,
                        help="Maximum section results per page (default: 2).")
    parser.add_argument("--json", action="store_true", help="Emit structured JSON search results.")
    parser.add_argument("--no-embed", action="store_true", help="Force lexical-only search.")
    parser.add_argument(
        "--approve-embedding-build",
        action="store_true",
        help="Approve an initial/full provider-specific vector build.",
    )
    args = parser.parse_args()
    cache_path = None
    if args.cache:
        cache_path = args.wiki / ".wiki-cache" / "search-index.json" if args.cache == "AUTO" else Path(args.cache)

    if not args.wiki.exists():
        print(f"Wiki directory not found: {args.wiki}", file=sys.stderr)
        sys.exit(1)

    pages = collect_pages(args.wiki, cache_path)
    if not pages:
        print(f"No wiki pages found under {args.wiki}", file=sys.stderr)
        sys.exit(0)

    if args.backlinks:
        cmd_backlinks(args, pages)
    elif args.top_linked:
        cmd_top_linked(args, pages)
    elif args.query:
        cmd_search(args, pages)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
