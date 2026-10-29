/**
 * Shared contract between the Worker edge (HTTP API, MCP, OAuth, UI) and the
 * WikiDO / Registry Durable Objects. Every value crossing the RPC boundary is
 * structured-clone safe JSON. Change this file only together with both sides.
 */

export const SERVER_VERSION = "4.0.0";

/** Token scopes. `admin` implies every other scope for its wiki. */
export type Scope = "read" | "write" | "raw:write" | "admin";

/** Identity resolved by the edge for one request. */
export interface Principal {
  wiki: string;
  /** Recorded as the commit author. Token label, OAuth client label, or "admin". */
  label: string;
  scopes: Scope[];
  /** True for the deployment ADMIN_TOKEN. */
  deploymentAdmin: boolean;
  /** Token id (absent for the deployment admin). */
  tokenId?: string;
}

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "too_large"
  | "unavailable"
  | "internal";

export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: ConflictDetails | Record<string, string | number | boolean | null | string[]>;
}

/** JSON scalar. */
export type JsonPrimitive = string | number | boolean | null;
/** One more level of JSON nesting over T. */
export type JsonLevel<T> = T | T[] | { [key: string]: T | T[] | undefined };
/**
 * Pass-through JSON object returned by graph, lint, stats and decide. It is
 * depth-bounded on purpose: a recursive JSON type makes the workers-types RPC
 * mapping fail with TS2589 ("type instantiation is excessively deep").
 */
export type JsonBody = {
  [key: string]: JsonLevel<JsonLevel<JsonLevel<JsonLevel<JsonLevel<JsonPrimitive>>>>> | undefined;
};

export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: ApiError };

// ---------------------------------------------------------------------------
// Pages and commits
// ---------------------------------------------------------------------------

export interface PageRecord {
  path: string;
  rev: number;
  sha256: string;
  bytes: number;
  content: string;
  updated_at: string;
  updated_by: string;
}

export interface ReadRequest {
  paths: string[];
  /** Optional heading text; returns only that section (first match, case-insensitive). */
  heading?: string;
  /** 1-based inclusive line range applied after `heading`. */
  start_line?: number;
  end_line?: number;
}

export interface ReadResponse {
  pages: PageRecord[];
  missing: string[];
}

export interface ListRequest {
  prefix?: string;
}

export interface ListEntry {
  path: string;
  rev: number;
  sha256: string;
  bytes: number;
  type: string | null;
  title: string | null;
  tags: string[];
  updated: string | null;
}

export interface EditPair {
  old: string;
  new: string;
  /** Replace every occurrence instead of requiring exactly one. */
  replace_all?: boolean;
}

export type CommitOp =
  | { op: "create"; path: string; content: string }
  | { op: "put"; path: string; content: string; base_rev: number }
  | { op: "upsert"; path: string; content: string }
  | { op: "edit"; path: string; edits: EditPair[]; base_rev?: number }
  | { op: "append"; path: string; text: string; after_heading?: string; create?: boolean }
  | { op: "delete"; path: string; base_rev: number }
  | { op: "move"; from: string; to: string; base_rev: number };

export interface CommitRequest {
  message: string;
  ops: CommitOp[];
  /** Optional one-line entry appended to log.md in the same commit. */
  log?: string;
}

export interface CommitResult {
  commit_id: string;
  seq: number;
  changed: { path: string; rev: number; sha256: string; deleted?: boolean }[];
  /** Review flags created by optional write checks (decision models). */
  review_flags: number;
}

/** Details returned with HTTP 409. */
export interface ConflictDetails {
  op_index: number;
  path: string;
  reason: "exists" | "missing" | "stale_base_rev" | "edit_no_match" | "edit_multiple_matches";
  current_rev: number | null;
  base_rev?: number;
  /** Unified diff from base_rev to current, when both revisions are known. */
  diff?: string;
  /** Current text of the section that contains the failed edit, or the page head. */
  current_excerpt?: string;
}

// ---------------------------------------------------------------------------
// Search (row shape mirrors `wiki_search.py --json`)
// ---------------------------------------------------------------------------

export interface SearchRequest {
  query: string;
  top?: number;
  type?: string;
  tag?: string;
  since?: string;
  granularity?: "section" | "page";
  per_page?: number;
  mode?: "hybrid" | "lexical";
  /** Optional relevance gate through the configured decision backend. */
  decide?: boolean;
}

export interface SearchRow {
  slug: string;
  rel_path: string;
  type: string | null;
  title: string;
  heading_path: string[];
  section_index: number | null;
  score: number;
  retrievers: string[];
  snippet: string;
  updated: string | null;
  tags: string[];
  sources: string[];
  neighbors: { prev: string | null; next: string | null };
  /** Present when the decision gate ran. */
  decision?: { relevant: number; backend: string; model: string };
}

export interface SearchResponse {
  query: string;
  wiki: string;
  granularity: "section" | "page";
  mode: "hybrid" | "lexical";
  results: SearchRow[];
  /** Sections whose vector is not yet current. */
  vector_lag: number;
  /** Present when the decision gate ran. */
  decision?: {
    backend: string;
    model: string;
    threshold: number;
    pool: number;
    kept: number;
    dropped: number;
    /** True when the backend failed and the ungated rows were returned. */
    failed_open: boolean;
    /** Wall time of all decision calls for this search. */
    latency_ms: number;
    /** Short error code when the backend failed, for example "insufficient_credits". */
    error?: string;
  };
}

// ---------------------------------------------------------------------------
// History, changes, export
// ---------------------------------------------------------------------------

export interface CommitSummary {
  commit_id: string;
  seq: number;
  author: string;
  message: string;
  created_at: string;
  paths: string[];
}

export interface HistoryRequest {
  path?: string;
  limit?: number;
  before_seq?: number;
}

export interface Change {
  path: string;
  rev: number;
  sha256: string;
  deleted: boolean;
  content?: string;
}

export interface ChangesResponse {
  seq: number;
  changes: Change[];
  /** True when more changes follow; call again with since = next_since. */
  more: boolean;
  next_since: number;
}

export interface Manifest {
  seq: number;
  pages: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Graph, lint, stats, review
// ---------------------------------------------------------------------------

export type GraphRequest =
  | { op: "neighbors"; node: string; depth?: number; predicate?: string }
  | { op: "edges"; node?: string; predicate?: string; status?: string; limit?: number }
  | { op: "facts"; node: string }
  | { op: "path"; from: string; to: string; max_depth?: number }
  | { op: "export"; format: "jsonl" | "graphml" };

export interface LintRequest {
  stale_days?: number;
  /** Run the optional evidence check through the decision backend. */
  decide?: boolean;
}

export interface ReviewFlag {
  id: string;
  created_at: string;
  kind: "untrusted_text" | "evidence" | "contradiction" | "other";
  path: string;
  detail: string;
  score: number | null;
  backend: string | null;
  model: string | null;
  commit_id: string | null;
  status: "open" | "accepted" | "dismissed";
  resolved_by?: string | null;
}

// ---------------------------------------------------------------------------
// Settings, tokens, overview
// ---------------------------------------------------------------------------

export type DecisionBackend = "workers-ai" | "typesafe" | "openrouter" | "liquid";

export interface DecisionSettings {
  enabled: boolean;
  backend: DecisionBackend;
  /** Pinned model id, e.g. "typesafe/jev-1.14.0" (workers-ai), "jev-1.14.0" (typesafe). */
  model: string;
  /** Apply the relevance gate to every search, not only when `decide` is set. */
  search_gate: boolean;
  /** Screen new source pages for text that gives orders to AI agents (review flags only). */
  screen_writes: boolean;
  /** P(relevant) needed to keep a search row. */
  relevance_threshold: number;
  /** P(untrusted) above which a review flag is created. */
  screen_threshold: number;
  /** Request timeout in milliseconds. */
  timeout_ms: number;
}

export interface WikiSettings {
  decisions: DecisionSettings;
}

export interface TokenInfo {
  id: string;
  label: string;
  scopes: Scope[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface Overview {
  wiki: string;
  server_version: string;
  seq: number;
  pages: number;
  sections: number;
  bytes: number;
  vector_lag: number;
  vectors_enabled: boolean;
  raw_enabled: boolean;
  decisions: Pick<DecisionSettings, "enabled" | "backend" | "model">;
  schema: string | null;
  index: string | null;
  open_review_flags: number;
}

/** Raw source object metadata (bytes live in R2 under `<wiki>/raw/<path>`). */
export interface RawEntry {
  path: string;
  bytes: number;
  sha256: string;
  content_type: string;
  uploaded_at: string;
  uploaded_by: string;
}
