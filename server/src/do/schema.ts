/** WikiDO SQLite schema. Every statement is idempotent; the constructor runs them all. */

const FTS_TOKENIZER = "tokenize='unicode61 remove_diacritics 2'";

/**
 * Version of WIKI_SCHEMA. The constructor stores it in `meta.schema_version`
 * for new objects. A future schema change bumps it and migrates objects that
 * carry an older value. Changes made before the 4.0.0 release keep version 1
 * and migrate in `migrateWikiSchema` by checking the columns that exist.
 */
export const WIKI_SCHEMA_VERSION = 1;

/**
 * Brings an object created by an earlier 4.0.0 build up to WIKI_SCHEMA. Runs
 * after WIKI_SCHEMA (CREATE IF NOT EXISTS does not add columns). Idempotent.
 */
export function migrateWikiSchema(sql: SqlStorage): void {
  const sections = new Set(sql.exec<{ name: string }>("PRAGMA table_info(sections)").toArray().map((column) => column.name));
  if (!sections.has("vec_sent_at")) {
    sql.exec("ALTER TABLE sections ADD COLUMN vec_sent_at INTEGER");
    sql.exec("ALTER TABLE sections ADD COLUMN vec_checked_at INTEGER");
    // Earlier builds marked a vector done (state 1) right after the upsert, with no
    // check. A send time of 0 makes the next alarm check each one at once:
    // found -> confirmed, missing -> pending again (embed and upsert).
    sql.exec("UPDATE sections SET vec_sent_at = 0 WHERE vec_state = 1");
  }
}

export const WIKI_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // One row per path ever written. Deleted files keep a tombstone row (deleted = 1)
  // so `changes` can report the deletion. `rev` is the seq of the last change.
  // The row must stay under the 2 MB SQLite row limit for any accepted file
  // (content <= 1.5 MB): text columns derived from content are clipped in
  // derive.ts, and large derived JSON lives in `page_data`.
  `CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    rev INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    searchable INTEGER NOT NULL DEFAULT 0,
    slug TEXT NOT NULL,
    type TEXT,
    title TEXT,
    display_title TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    sources TEXT NOT NULL DEFAULT '[]',
    updated TEXT,
    updated_date TEXT,
    malformed INTEGER NOT NULL DEFAULT 0,
    line_count INTEGER NOT NULL DEFAULT 0,
    word_count INTEGER NOT NULL DEFAULT 0,
    stats_type TEXT,
    has_graph INTEGER NOT NULL DEFAULT 0
  )`,
  // Derived JSON of a live page (kinds: meta, links, stats_links, graph), split
  // into parts so that no row passes the SQLite row limit. Missing kind = default.
  `CREATE TABLE IF NOT EXISTS page_data (
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    part INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (path, kind, part)
  )`,
  `CREATE INDEX IF NOT EXISTS pages_rev ON pages(rev)`,
  `CREATE INDEX IF NOT EXISTS pages_slug ON pages(slug)`,
  // Earlier versions of a path: the content a path had at `rev`.
  `CREATE TABLE IF NOT EXISTS revisions (
    path TEXT NOT NULL,
    rev INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    content TEXT NOT NULL,
    deleted INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    PRIMARY KEY (path, rev)
  )`,
  `CREATE TABLE IF NOT EXISTS commits (
    seq INTEGER PRIMARY KEY,
    commit_id TEXT NOT NULL UNIQUE,
    author TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS commit_paths (
    seq INTEGER NOT NULL,
    path TEXT NOT NULL,
    old_rev INTEGER,
    old_deleted INTEGER NOT NULL,
    deleted INTEGER NOT NULL,
    PRIMARY KEY (seq, path)
  )`,
  `CREATE INDEX IF NOT EXISTS commit_paths_path ON commit_paths(path, seq)`,
  `CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    section_index INTEGER NOT NULL,
    heading_path TEXT NOT NULL,
    level INTEGER NOT NULL,
    text TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    vector_id TEXT NOT NULL,
    -- 0 = pending (embed and upsert), 1 = sent (upsert accepted, not yet seen in
    -- Vectorize), 2 = confirmed (getByIds returned it). Times are epoch ms.
    vec_state INTEGER NOT NULL DEFAULT 0,
    vec_sent_at INTEGER,
    vec_checked_at INTEGER,
    UNIQUE (path, section_index)
  )`,
  `CREATE INDEX IF NOT EXISTS sections_vector ON sections(vector_id)`,
  `CREATE INDEX IF NOT EXISTS sections_state ON sections(vec_state)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(body, ${FTS_TOKENIZER})`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(body, ${FTS_TOKENIZER})`,
  `CREATE TABLE IF NOT EXISTS vector_deletes (vector_id TEXT PRIMARY KEY)`,
  // `base` (the link text after the last "/") is a virtual column: storing it
  // next to `clean` would hold a long link twice and could pass the row limit.
  `CREATE TABLE IF NOT EXISTS links (
    src TEXT NOT NULL,
    ord INTEGER NOT NULL,
    clean TEXT NOT NULL,
    has_slash INTEGER NOT NULL,
    base_start INTEGER NOT NULL,
    base TEXT GENERATED ALWAYS AS (substr(clean, base_start)) VIRTUAL,
    PRIMARY KEY (src, ord)
  )`,
  `CREATE INDEX IF NOT EXISTS links_clean ON links(clean)`,
  `CREATE INDEX IF NOT EXISTS links_base ON links(base)`,
  `CREATE TABLE IF NOT EXISTS graph_nodes (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    page_type TEXT NOT NULL,
    node_type TEXT NOT NULL,
    kind TEXT,
    path TEXT NOT NULL,
    created TEXT,
    updated TEXT,
    metadata_json TEXT NOT NULL,
    node_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS graph_nodes_path ON graph_nodes(path)`,
  `CREATE INDEX IF NOT EXISTS graph_nodes_slug ON graph_nodes(slug)`,
  `CREATE TABLE IF NOT EXISTS graph_edges (
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
    metadata_json TEXT NOT NULL,
    edge_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS graph_edges_subject ON graph_edges(subject)`,
  `CREATE INDEX IF NOT EXISTS graph_edges_object ON graph_edges(object)`,
  `CREATE INDEX IF NOT EXISTS graph_edges_page ON graph_edges(page)`,
  // Staging tables for the batched full rebuild (same columns as the live tables).
  `CREATE TABLE IF NOT EXISTS graph_nodes_next (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    page_type TEXT NOT NULL,
    node_type TEXT NOT NULL,
    kind TEXT,
    path TEXT NOT NULL,
    created TEXT,
    updated TEXT,
    metadata_json TEXT NOT NULL,
    node_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS graph_edges_next (
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
    metadata_json TEXT NOT NULL,
    edge_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS graph_slugs_next (slug TEXT PRIMARY KEY, id TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    scopes TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS pairing_codes (
    hash TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    scopes TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS review_flags (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    detail TEXT NOT NULL,
    score REAL,
    backend TEXT,
    model TEXT,
    commit_id TEXT,
    status TEXT NOT NULL,
    resolved_by TEXT,
    resolved_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS review_flags_status ON review_flags(status, created_at)`,
  `CREATE TABLE IF NOT EXISTS raw_files (
    path TEXT PRIMARY KEY,
    bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    content_type TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    uploaded_by TEXT NOT NULL
  )`,
];

export const REGISTRY_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS wikis (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, created_by TEXT NOT NULL)`,
];
