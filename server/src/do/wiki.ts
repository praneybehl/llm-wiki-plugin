/**
 * WikiDO: one SQLite Durable Object per wiki. Holds pages, revisions,
 * commits, derived search data (sections, FTS5, links, graph), tokens,
 * pairing codes, settings, review flags and raw file metadata.
 *
 * Request paths stay small: a commit only parses the pages it changes.
 * Embeddings and full graph rebuilds run in the alarm.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import type {
  ChangesResponse,
  CommitOp,
  CommitRequest,
  CommitResult,
  CommitSummary,
  ConflictDetails,
  DecisionBackend,
  ApiError,
  DecisionSettings,
  ErrorCode,
  JsonBody,
  GraphRequest,
  HistoryRequest,
  LintRequest,
  ListEntry,
  ListRequest,
  Manifest,
  Overview,
  PageRecord,
  RawEntry,
  ReadRequest,
  ReadResponse,
  Result,
  ReviewFlag,
  Scope,
  SearchRequest,
  SearchResponse,
  SearchRow,
  TokenInfo,
  WikiSettings,
} from "../types";
import { SERVER_VERSION } from "../types";
import {
  DECISION_POOL,
  DEFAULT_DECISION_SETTINGS,
  checkEvidence,
  decideResult,
  defaultModel,
  evidenceInText,
  gateSearchRows,
  screenText,
} from "../decisions";
import {
  cachePageBody,
  collapseSnippet,
  ftsQuery,
  fuseRrf,
  LEXICAL_FUSION_DEPTH,
  round4,
  searchableText,
} from "../core/bm25";
import { unifiedDiff } from "../core/diff";
import type { FrontmatterValue } from "../core/frontmatter";
import {
  buildNode,
  buildPageEdges,
  edgeRow,
  exportGraphml,
  exportJsonl,
  isObject,
  nodeRow,
  parseOntology,
  parseYamlFrontmatter,
  pyStr,
  truthy,
  type EdgeLookup,
  type EdgeRow,
  type GraphEdge,
  type GraphNode,
  type GraphPage,
  type NodeRow,
  type Ontology,
} from "../core/graph";
import { facts as graphFacts, neighbors as graphNeighbors, path as graphPath, type GraphStore } from "../core/graph-query";
import { graphLint } from "../core/graph-lint";
import { randomBase64Url, randomHex, sha256Hex } from "../core/hash";
import { lintPages, type LintPage } from "../core/lint";
import { cleanLinkTarget } from "../core/links";
import {
  byteLength,
  isSearchable,
  isTopLevelReadme,
  isWellFormedText,
  LOG_PATH,
  MAX_COMMIT_BYTES,
  MAX_COMMIT_OPS,
  MAX_FILE_BYTES,
  ONTOLOGY_PATH,
  pathError,
} from "../core/paths";
import { computeStats, type StatsPage } from "../core/stats";
import {
  MIN_SIMILARITY,
  sectionContentHash,
  sectionVectorId,
  VECTOR_QUERY_TOP_K,
  workersVectorBackend,
  type VectorBackend,
} from "../core/vectors";
import { derivePage, validDatePrefix, type DerivedPage } from "./derive";
import { WIKI_SCHEMA } from "./schema";

export const WIKI_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SCOPES: Scope[] = ["read", "write", "raw:write", "admin"];
const BACKENDS: DecisionBackend[] = ["workers-ai", "typesafe", "openrouter", "liquid"];
const TOKEN_TOUCH_MS = 5 * 60_000;
const VECTOR_BATCH = 100;
/** Pages per graph rebuild step (one alarm run). */
const GRAPH_BATCH = 200;
const VECTOR_DELETE_BATCH = 1000;
const LEXICAL_LIMIT = 500;
const EXCERPT_CHARS = 2000;
const MAX_READ_PATHS = 100;
const MAX_EVIDENCE_CHECKS = 25;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 3_600_000;
const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

type Row = Record<string, SqlStorageValue>;

interface PageRow extends Row {
  id: number;
  path: string;
  rev: number;
  sha256: string;
  bytes: number;
  content: string;
  updated_at: string;
  updated_by: string;
  deleted: number;
  searchable: number;
  slug: string;
  type: string | null;
  title: string | null;
  display_title: string;
  tags: string;
  sources: string;
  updated: string | null;
  graph_json: string | null;
}

interface SectionRow extends Row {
  id: number;
  path: string;
  section_index: number;
  heading_path: string;
  level: number;
  text: string;
  vector_id: string;
  vec_state: number;
}

interface Working {
  path: string;
  orig: PageRow | null;
  live: boolean;
  content: string;
  rev: number | null;
  touched: boolean;
  /** True when an op replaced the whole content (create/put/upsert/move target). */
  replaced: boolean;
}

/** The failure branch of `Result`. */
type Failure = { ok: false; status: number; error: ApiError };

/** Unchecked cast for RPC results: values built here are plain JSON objects (rows, strings, numbers). */
function json(value: unknown): JsonBody {
  return value as unknown as JsonBody;
}

class Abort {
  constructor(readonly result: Failure) {}
}

function fail(status: number, code: ErrorCode, message: string, details?: ApiError["details"]): Failure {
  return { ok: false, status, error: details === undefined ? { code, message } : { code, message, details } };
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) count++;
  return count;
}

const HEADING_LINE_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

function isFence(line: string): boolean {
  const stripped = line.trim();
  return stripped.startsWith("```") || stripped.startsWith("~~~");
}

/** Line range [start, end) of the section whose heading text matches `heading`. */
function findHeadingSection(lines: string[], heading: string): [number, number] | null {
  const wanted = heading.replace(/^#+\s*/, "").trim().toLowerCase();
  let inFence = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isFence(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING_LINE_RE.exec(line);
    if (!m) continue;
    if (start >= 0 && m[1]!.length <= level) return [start, i];
    if (start < 0 && m[2]!.trim().toLowerCase() === wanted) {
      start = i;
      level = m[1]!.length;
    }
  }
  return start >= 0 ? [start, lines.length] : null;
}

/** Text around `offset` bounded by the nearest headings. */
function sectionExcerpt(content: string, offset: number): string {
  const lines = content.split("\n");
  let line = content.slice(0, Math.max(0, offset)).split("\n").length - 1;
  line = Math.min(line, lines.length - 1);
  let start = line;
  while (start > 0 && !HEADING_LINE_RE.test(lines[start]!)) start--;
  let end = line + 1;
  while (end < lines.length && !HEADING_LINE_RE.test(lines[end]!)) end++;
  return lines.slice(start, end).join("\n").slice(0, EXCERPT_CHARS);
}

function appendText(content: string, text: string, afterHeading?: string): string {
  const addition = text.endsWith("\n") ? text : `${text}\n`;
  if (afterHeading) {
    const lines = content.split("\n");
    const range = findHeadingSection(lines, afterHeading);
    if (range) {
      let insertAt = range[1];
      while (insertAt > range[0] + 1 && lines[insertAt - 1]!.trim() === "") insertAt--;
      const inserted = addition.replace(/\n+$/, "").split("\n");
      lines.splice(insertAt, 0, ...inserted);
      return lines.join("\n");
    }
  }
  if (content === "") return addition;
  return `${content.replace(/\n+$/, "")}\n${addition}`;
}

function isScopeList(value: unknown): value is Scope[] {
  return Array.isArray(value) && value.every((scope) => typeof scope === "string" && SCOPES.includes(scope as Scope));
}

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Validates op shapes and sizes; returns an error result or null. */
function validateCommit(req: CommitRequest): Failure | null {
  if (!req || typeof req !== "object") return fail(400, "bad_request", "commit body must be an object");
  if (typeof req.message !== "string") return fail(400, "bad_request", "message must be a string");
  if (req.log !== undefined && typeof req.log !== "string") return fail(400, "bad_request", "log must be a string");
  if (!Array.isArray(req.ops) || req.ops.length === 0) return fail(400, "bad_request", "ops must be a non-empty array");
  if (req.ops.length > MAX_COMMIT_OPS) return fail(413, "too_large", `a commit holds at most ${MAX_COMMIT_OPS} ops`);
  let total = byteLength(req.message) + byteLength(req.log ?? "");
  const textField = (index: number, name: string, value: unknown): Failure | null => {
    if (typeof value !== "string") return fail(400, "bad_request", `ops[${index}].${name} must be a string`);
    if (!isWellFormedText(value)) return fail(400, "bad_request", `ops[${index}].${name} is not valid UTF-8 text`);
    const size = byteLength(value);
    if (size > MAX_FILE_BYTES) return fail(413, "too_large", `ops[${index}].${name} is larger than ${MAX_FILE_BYTES} bytes`);
    total += size;
    return null;
  };
  const checkPath = (index: number, name: string, value: unknown): Failure | null => {
    const problem = pathError(value);
    return problem ? fail(400, "bad_request", `ops[${index}].${name}: ${problem}`) : null;
  };
  for (let i = 0; i < req.ops.length; i++) {
    const op: unknown = req.ops[i];
    if (!isObject(op) || typeof op.op !== "string") return fail(400, "bad_request", `ops[${i}] must be an object with op`);
    const problem = ((): Failure | null => {
      switch (op.op) {
        case "create":
        case "upsert":
          return checkPath(i, "path", op.path) ?? textField(i, "content", op.content);
        case "put":
          if (!isInt(op.base_rev)) return fail(400, "bad_request", `ops[${i}].base_rev must be a non-negative integer`);
          return checkPath(i, "path", op.path) ?? textField(i, "content", op.content);
        case "edit": {
          const pathProblem = checkPath(i, "path", op.path);
          if (pathProblem) return pathProblem;
          if (op.base_rev !== undefined && op.base_rev !== null && !isInt(op.base_rev)) {
            return fail(400, "bad_request", `ops[${i}].base_rev must be a non-negative integer`);
          }
          if (!Array.isArray(op.edits) || op.edits.length === 0) return fail(400, "bad_request", `ops[${i}].edits must be a non-empty array`);
          for (let j = 0; j < op.edits.length; j++) {
            const pair = op.edits[j];
            if (!isObject(pair)) return fail(400, "bad_request", `ops[${i}].edits[${j}] must be an object`);
            if (typeof pair.old !== "string" || pair.old === "") return fail(400, "bad_request", `ops[${i}].edits[${j}].old must be a non-empty string`);
            const oldProblem = textField(i, `edits[${j}].old`, pair.old) ?? textField(i, `edits[${j}].new`, pair.new);
            if (oldProblem) return oldProblem;
          }
          return null;
        }
        case "append":
          if (op.after_heading !== undefined && typeof op.after_heading !== "string") {
            return fail(400, "bad_request", `ops[${i}].after_heading must be a string`);
          }
          return checkPath(i, "path", op.path) ?? textField(i, "text", op.text);
        case "delete":
          if (!isInt(op.base_rev)) return fail(400, "bad_request", `ops[${i}].base_rev must be a non-negative integer`);
          return checkPath(i, "path", op.path);
        case "move":
          if (!isInt(op.base_rev)) return fail(400, "bad_request", `ops[${i}].base_rev must be a non-negative integer`);
          return checkPath(i, "from", op.from) ?? checkPath(i, "to", op.to);
        default:
          return fail(400, "bad_request", `ops[${i}].op is not a known operation`);
      }
    })();
    if (problem) return problem;
  }
  if (total > MAX_COMMIT_BYTES) return fail(413, "too_large", `a commit holds at most ${MAX_COMMIT_BYTES} bytes`);
  return null;
}

export class WikiDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private vectorOverride: VectorBackend | null | undefined = undefined;
  private ontologyCache: { seq: number; ontology: Ontology; error: string | null } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    void ctx.blockConcurrencyWhile(async () => {
      for (const statement of WIKI_SCHEMA) this.sql.exec(statement);
    });
  }

  // -------------------------------------------------------------------------
  // SQL helpers
  // -------------------------------------------------------------------------

  private all<T extends Row>(query: string, ...bindings: unknown[]): T[] {
    return this.sql.exec<T>(query, ...bindings).toArray();
  }

  private first<T extends Row>(query: string, ...bindings: unknown[]): T | null {
    return this.sql.exec<T>(query, ...bindings).toArray()[0] ?? null;
  }

  private getMeta(key: string): string | null {
    return this.first<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  private seq(): number {
    return Number(this.getMeta("seq") ?? "0");
  }

  private wikiId(): string {
    const id = this.getMeta("wiki");
    if (!id) throw new Error("wiki is not set up; call setup(wiki) first");
    return id;
  }

  /** Test seam: replace the Workers AI + Vectorize backend (null disables vectors). */
  useVectorBackend(backend: VectorBackend | null): void {
    this.vectorOverride = backend;
  }

  private vectors(): VectorBackend | null {
    return this.vectorOverride !== undefined ? this.vectorOverride : workersVectorBackend(this.env);
  }

  // -------------------------------------------------------------------------
  // Setup and overview
  // -------------------------------------------------------------------------

  async setup(wiki: string): Promise<void> {
    if (!WIKI_ID_RE.test(wiki)) throw new Error(`invalid wiki id: ${wiki}`);
    if (this.getMeta("wiki") === null) {
      this.setMeta("wiki", wiki);
      this.setMeta("created_at", nowIso());
    }
  }

  async overview(): Promise<Overview> {
    const wiki = this.wikiId();
    const counts = this.first<{ pages: number; bytes: number | null }>(
      "SELECT COUNT(*) AS pages, SUM(bytes) AS bytes FROM pages WHERE deleted = 0",
    );
    const sections = this.first<{ n: number }>("SELECT COUNT(*) AS n FROM sections")?.n ?? 0;
    const settings = this.settings();
    const page = (path: string): string | null =>
      this.first<{ content: string }>("SELECT content FROM pages WHERE path = ? AND deleted = 0", path)?.content ?? null;
    return {
      wiki,
      server_version: SERVER_VERSION,
      seq: this.seq(),
      pages: counts?.pages ?? 0,
      sections,
      bytes: counts?.bytes ?? 0,
      vector_lag: this.vectorLag(),
      vectors_enabled: this.vectors() !== null,
      raw_enabled: Boolean(this.env.RAW),
      decisions: { enabled: settings.decisions.enabled, backend: settings.decisions.backend, model: settings.decisions.model },
      schema: page("SCHEMA.md"),
      index: page("index.md"),
      open_review_flags: this.openReviewCount(),
    };
  }

  private vectorLag(): number {
    if (this.vectors() === null) return 0;
    return this.first<{ n: number }>("SELECT COUNT(*) AS n FROM sections WHERE vec_state = 0")?.n ?? 0;
  }

  private openReviewCount(): number {
    return this.first<{ n: number }>("SELECT COUNT(*) AS n FROM review_flags WHERE status = 'open'")?.n ?? 0;
  }

  // -------------------------------------------------------------------------
  // Read and list
  // -------------------------------------------------------------------------

  private record(row: PageRow): PageRecord {
    return {
      path: row.path,
      rev: row.rev,
      sha256: row.sha256,
      bytes: row.bytes,
      content: row.content,
      updated_at: row.updated_at,
      updated_by: row.updated_by,
    };
  }

  private livePage(path: string): PageRow | null {
    return this.first<PageRow>("SELECT * FROM pages WHERE path = ? AND deleted = 0", path);
  }

  async read(req: ReadRequest): Promise<ReadResponse> {
    const paths = Array.isArray(req?.paths) ? req.paths.filter((path) => typeof path === "string").slice(0, MAX_READ_PATHS) : [];
    const pages: PageRecord[] = [];
    const missing: string[] = [];
    for (const path of paths) {
      const row = this.livePage(path);
      if (!row) {
        missing.push(path);
        continue;
      }
      let content = row.content;
      if (req.heading) {
        const lines = content.split("\n");
        const range = findHeadingSection(lines, req.heading);
        if (!range) {
          missing.push(path);
          continue;
        }
        content = lines.slice(range[0], range[1]).join("\n");
      }
      if (req.start_line !== undefined || req.end_line !== undefined) {
        const lines = content.split("\n");
        const start = Math.max(1, Math.floor(req.start_line ?? 1));
        const end = Math.min(lines.length, Math.floor(req.end_line ?? lines.length));
        content = lines.slice(start - 1, Math.max(start - 1, end)).join("\n");
      }
      pages.push({ ...this.record(row), content });
    }
    return { pages, missing };
  }

  async list(req: ListRequest): Promise<ListEntry[]> {
    const prefix = typeof req?.prefix === "string" ? req.prefix : "";
    const rows = this.all<PageRow>(
      "SELECT path, rev, sha256, bytes, type, title, tags, updated FROM pages WHERE deleted = 0 AND substr(path, 1, ?) = ? ORDER BY path",
      prefix.length,
      prefix,
    );
    return rows.map((row) => ({
      path: row.path,
      rev: row.rev,
      sha256: row.sha256,
      bytes: row.bytes,
      type: row.type,
      title: row.title,
      tags: parseJson<string[]>(row.tags, []),
      updated: row.updated,
    }));
  }

  // -------------------------------------------------------------------------
  // Commit
  // -------------------------------------------------------------------------

  async commit(author: string, req: CommitRequest): Promise<Result<CommitResult>> {
    const invalid = validateCommit(req);
    if (invalid) return invalid;
    const result = this.applyCommit(author, req.message, req.ops, req.log);
    if (!result.ok) return result;
    const { value, screen } = result;
    if (screen.length > 0) value.review_flags = await this.screenWrites(value.commit_id, screen);
    await this.afterWrite();
    return { ok: true, value };
  }

  /** Runs ops atomically. Returns the result plus pages to screen (D5). */
  private applyCommit(
    author: string,
    message: string,
    ops: CommitOp[],
    log: string | undefined,
  ): { ok: true; value: CommitResult; screen: { path: string; text: string }[] } | Failure {
    const wiki = this.wikiId();
    try {
      return this.ctx.storage.transactionSync(() => {
        const work = new Map<string, Working>();
        const seq = this.seq() + 1;
        const get = (path: string): Working => {
          let w = work.get(path);
          if (!w) {
            const orig = this.first<PageRow>("SELECT * FROM pages WHERE path = ?", path);
            const live = Boolean(orig && !orig.deleted);
            w = { path, orig, live, content: live ? orig!.content : "", rev: live ? orig!.rev : null, touched: false, replaced: false };
            work.set(path, w);
          }
          return w;
        };
        const set = (w: Working, content: string, live: boolean, replaced: boolean): void => {
          if (live && byteLength(content) > MAX_FILE_BYTES) {
            throw new Abort(fail(413, "too_large", `${w.path} would be larger than ${MAX_FILE_BYTES} bytes`));
          }
          w.content = live ? content : "";
          w.live = live;
          w.rev = live ? seq : null;
          w.touched = true;
          if (replaced) w.replaced = true;
        };
        const conflict = (details: ConflictDetails): never => {
          throw new Abort(fail(409, "conflict", `${details.reason}: ${details.path}`, details));
        };
        const staleDiff = (w: Working, baseRev: number): string | undefined => {
          const base = this.versionContent(w.path, baseRev);
          if (base === null) return undefined;
          return unifiedDiff(base, w.content, `a/${w.path}@${baseRev}`, `b/${w.path}@${w.rev ?? "deleted"}`);
        };
        const head = (w: Working): string => w.content.slice(0, EXCERPT_CHARS);

        ops.forEach((op, index) => {
          switch (op.op) {
            case "create": {
              const w = get(op.path);
              if (w.live) conflict({ op_index: index, path: op.path, reason: "exists", current_rev: w.rev, current_excerpt: head(w) });
              set(w, op.content, true, true);
              break;
            }
            case "put": {
              const w = get(op.path);
              if (!w.live) conflict({ op_index: index, path: op.path, reason: "missing", current_rev: null, base_rev: op.base_rev });
              if (w.rev !== op.base_rev) {
                conflict({
                  op_index: index,
                  path: op.path,
                  reason: "stale_base_rev",
                  current_rev: w.rev,
                  base_rev: op.base_rev,
                  diff: staleDiff(w, op.base_rev),
                  current_excerpt: head(w),
                });
              }
              set(w, op.content, true, true);
              break;
            }
            case "upsert": {
              const w = get(op.path);
              set(w, op.content, true, true);
              break;
            }
            case "edit": {
              const w = get(op.path);
              if (!w.live) conflict({ op_index: index, path: op.path, reason: "missing", current_rev: null });
              const stale = op.base_rev !== undefined && op.base_rev !== null && op.base_rev !== w.rev;
              let text = w.content;
              for (const pair of op.edits) {
                const count = countOccurrences(text, pair.old);
                const reason = count === 0 ? "edit_no_match" : count > 1 && !pair.replace_all ? "edit_multiple_matches" : null;
                if (reason) {
                  const details: ConflictDetails = {
                    op_index: index,
                    path: op.path,
                    reason,
                    current_rev: w.rev,
                    current_excerpt: count === 0 ? head(w) : sectionExcerpt(text, text.indexOf(pair.old)),
                  };
                  if (op.base_rev !== undefined && op.base_rev !== null) details.base_rev = op.base_rev;
                  if (stale) details.diff = staleDiff(w, op.base_rev!);
                  conflict(details);
                }
                text = pair.replace_all ? text.split(pair.old).join(pair.new) : text.replace(pair.old, () => pair.new);
              }
              set(w, text, true, false);
              break;
            }
            case "append": {
              const w = get(op.path);
              if (!w.live && !op.create) conflict({ op_index: index, path: op.path, reason: "missing", current_rev: null });
              set(w, appendText(w.content, op.text, op.after_heading), true, false);
              break;
            }
            case "delete": {
              const w = get(op.path);
              if (!w.live) conflict({ op_index: index, path: op.path, reason: "missing", current_rev: null, base_rev: op.base_rev });
              if (w.rev !== op.base_rev) {
                conflict({ op_index: index, path: op.path, reason: "stale_base_rev", current_rev: w.rev, base_rev: op.base_rev, diff: staleDiff(w, op.base_rev) });
              }
              set(w, "", false, false);
              break;
            }
            case "move": {
              const from = get(op.from);
              if (!from.live) conflict({ op_index: index, path: op.from, reason: "missing", current_rev: null, base_rev: op.base_rev });
              if (from.rev !== op.base_rev) {
                conflict({ op_index: index, path: op.from, reason: "stale_base_rev", current_rev: from.rev, base_rev: op.base_rev, diff: staleDiff(from, op.base_rev) });
              }
              const to = get(op.to);
              if (to.live) conflict({ op_index: index, path: op.to, reason: "exists", current_rev: to.rev, current_excerpt: head(to) });
              const content = from.content;
              set(from, "", false, false);
              set(to, content, true, true);
              break;
            }
          }
        });

        if (log && log.trim()) {
          const w = get(LOG_PATH);
          const line = `- ${nowIso().slice(0, 10)} ${author}: ${log.replace(/\s*[\r\n]+\s*/g, " ").trim()}`;
          set(w, appendText(w.content, line), true, false);
        }

        const changed = [...work.values()].filter((w) => {
          if (!w.touched) return false;
          const origLive = Boolean(w.orig && !w.orig.deleted);
          return w.live !== origLive || (w.live && w.content !== w.orig!.content);
        });
        if (changed.length === 0) {
          const unchanged = [...work.values()]
            .filter((w) => w.live && w.orig)
            .map((w) => ({ path: w.path, rev: w.orig!.rev, sha256: w.orig!.sha256 }));
          return { ok: true as const, value: { commit_id: "", seq: seq - 1, changed: unchanged, review_flags: 0 }, screen: [] };
        }

        const commitId = `c${seq}-${randomHex(6)}`;
        const at = nowIso();
        this.sql.exec(
          "INSERT INTO commits (seq, commit_id, author, message, created_at) VALUES (?, ?, ?, ?, ?)",
          seq,
          commitId,
          author,
          message,
          at,
        );
        this.setMeta("seq", String(seq));
        const result: CommitResult = { commit_id: commitId, seq, changed: [], review_flags: 0 };
        const screen: { path: string; text: string }[] = [];
        const ontologyChanged = changed.some((w) => w.path === ONTOLOGY_PATH);
        for (const w of changed.sort((a, b) => (a.path < b.path ? -1 : 1))) {
          this.writePage(wiki, w, seq, commitId, author, at, ontologyChanged);
          const sha = w.live ? sha256Hex(w.content) : "";
          result.changed.push(w.live ? { path: w.path, rev: seq, sha256: sha } : { path: w.path, rev: seq, sha256: "", deleted: true });
          if (w.live && w.replaced && w.path.startsWith("sources/")) screen.push({ path: w.path, text: w.content });
        }
        if (ontologyChanged) {
          const ontologyRow = this.livePage(ONTOLOGY_PATH);
          this.setMeta("ontology", ontologyRow?.content ?? "");
          this.ontologyCache = null;
          this.markGraphDirty();
        }
        return { ok: true as const, value: result, screen };
      });
    } catch (error) {
      if (error instanceof Abort) return error.result;
      throw error;
    }
  }

  /** Content a path had at `rev`, or null when that version is unknown or deleted. */
  private versionContent(path: string, rev: number): string | null {
    const current = this.first<PageRow>("SELECT rev, deleted, content FROM pages WHERE path = ?", path);
    if (current && current.rev === rev) return current.deleted ? null : current.content;
    const old = this.first<{ content: string; deleted: number }>("SELECT content, deleted FROM revisions WHERE path = ? AND rev = ?", path, rev);
    return old && !old.deleted ? old.content : null;
  }

  /** Writes one changed path, its revision and its derived rows (inside the commit transaction). */
  private writePage(wiki: string, w: Working, seq: number, commitId: string, author: string, at: string, ontologyChanged: boolean): void {
    void commitId;
    const orig = w.orig;
    const origLive = Boolean(orig && !orig.deleted);
    if (orig) {
      this.sql.exec(
        "INSERT OR REPLACE INTO revisions (path, rev, sha256, content, deleted, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
        orig.path,
        orig.rev,
        orig.sha256,
        orig.content,
        orig.deleted,
        orig.updated_at,
        orig.updated_by,
      );
    }
    this.sql.exec(
      "INSERT INTO commit_paths (seq, path, old_rev, old_deleted, deleted) VALUES (?, ?, ?, ?, ?)",
      seq,
      w.path,
      orig ? orig.rev : null,
      orig ? orig.deleted : 1,
      w.live ? 0 : 1,
    );

    const reuse = this.clearDerived(w.path, orig?.id ?? null);
    const derived = w.live ? derivePage(w.path, w.content) : null;
    const graphPage = derived?.graph ?? null;
    const sha = w.live ? sha256Hex(w.content) : "";
    this.sql.exec(
      `INSERT INTO pages (path, rev, sha256, bytes, content, updated_at, updated_by, deleted, searchable, slug, type, title,
         display_title, tags, sources, updated, updated_date, meta_json, malformed, line_count, word_count, stats_type,
         stats_links, links, graph_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET rev = excluded.rev, sha256 = excluded.sha256, bytes = excluded.bytes,
         content = excluded.content, updated_at = excluded.updated_at, updated_by = excluded.updated_by,
         deleted = excluded.deleted, searchable = excluded.searchable, slug = excluded.slug, type = excluded.type,
         title = excluded.title, display_title = excluded.display_title, tags = excluded.tags, sources = excluded.sources,
         updated = excluded.updated, updated_date = excluded.updated_date, meta_json = excluded.meta_json,
         malformed = excluded.malformed, line_count = excluded.line_count, word_count = excluded.word_count,
         stats_type = excluded.stats_type, stats_links = excluded.stats_links, links = excluded.links,
         graph_json = excluded.graph_json`,
      w.path,
      seq,
      sha,
      w.live ? byteLength(w.content) : 0,
      w.content,
      at,
      author,
      w.live ? 0 : 1,
      derived?.searchable ? 1 : 0,
      derived?.slug ?? w.path.split("/").pop() ?? w.path,
      derived?.type ?? null,
      derived?.title ?? null,
      derived?.displayTitle ?? "",
      JSON.stringify(derived?.tags ?? []),
      JSON.stringify(derived?.sources ?? []),
      derived?.updated ?? null,
      derived?.updatedDate ?? null,
      JSON.stringify(derived?.meta ?? {}),
      derived?.malformed ? 1 : 0,
      derived?.lineCount ?? 0,
      derived?.wordCount ?? 0,
      derived?.statsType ?? null,
      JSON.stringify(derived?.statsLinks ?? []),
      JSON.stringify(derived?.links ?? []),
      graphPage ? JSON.stringify(graphPage) : null,
    );
    const pageId = this.first<{ id: number }>("SELECT id FROM pages WHERE path = ?", w.path)!.id;
    if (derived?.searchable) this.writeDerived(wiki, w.path, pageId, derived, reuse);

    // Graph rows: incremental for edits that keep the node identity, else a batched rebuild.
    const hadGraph = Boolean(orig?.graph_json && origLive);
    if (ontologyChanged || (!hadGraph && !graphPage)) return;
    if (!hadGraph || !graphPage || !this.updatePageGraph(w.path, graphPage)) this.markGraphDirty();
  }

  /** Deletes derived rows of a path. Returns vector ids already embedded, for reuse. */
  private clearDerived(path: string, pageId: number | null): Set<string> {
    const done = new Set<string>();
    for (const row of this.all<{ id: number; vector_id: string; vec_state: number }>(
      "SELECT id, vector_id, vec_state FROM sections WHERE path = ?",
      path,
    )) {
      this.sql.exec("DELETE FROM sections_fts WHERE rowid = ?", row.id);
      if (row.vec_state === 1) done.add(row.vector_id);
    }
    this.sql.exec("DELETE FROM sections WHERE path = ?", path);
    if (pageId !== null) this.sql.exec("DELETE FROM pages_fts WHERE rowid = ?", pageId);
    this.sql.exec("DELETE FROM links WHERE src = ?", path);
    return done;
  }

  private writeDerived(wiki: string, path: string, pageId: number, derived: DerivedPage, done: Set<string>): void {
    for (const section of derived.sections) {
      const searchable = searchableText(derived.displayTitle, section);
      const contentHash = sectionContentHash(searchable);
      const vectorId = sectionVectorId(wiki, path, section.sectionIndex, contentHash);
      const state = done.delete(vectorId) ? 1 : 0;
      const row = this.first<{ id: number }>(
        `INSERT INTO sections (path, section_index, heading_path, level, text, content_hash, vector_id, vec_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        path,
        section.sectionIndex,
        JSON.stringify(section.headingPath),
        section.level,
        section.text,
        contentHash,
        vectorId,
        state,
      )!;
      this.sql.exec("INSERT INTO sections_fts (rowid, body) VALUES (?, ?)", row.id, searchable);
    }
    for (const vectorId of done) this.sql.exec("INSERT OR IGNORE INTO vector_deletes (vector_id) VALUES (?)", vectorId);
    this.sql.exec("INSERT INTO pages_fts (rowid, body) VALUES (?, ?)", pageId, `${derived.body} ${derived.title ?? ""}`);
    derived.links.forEach((link, ord) => {
      const clean = cleanLinkTarget(link);
      this.sql.exec(
        "INSERT INTO links (src, ord, clean, has_slash, base) VALUES (?, ?, ?, ?, ?)",
        path,
        ord,
        clean,
        clean.includes("/") ? 1 : 0,
        clean.split("/").pop() ?? clean,
      );
    });
  }

  private async afterWrite(): Promise<void> {
    const needsGraph = this.getMeta("graph_dirty") === "1";
    const vectors = this.vectors();
    const needsVectors =
      vectors !== null &&
      Boolean(this.first<{ x: number }>("SELECT 1 AS x FROM sections WHERE vec_state = 0 UNION ALL SELECT 1 FROM vector_deletes LIMIT 1"));
    if (!needsGraph && !needsVectors) return;
    const at = await this.ctx.storage.getAlarm();
    if (at === null) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  private async screenWrites(commitId: string, pages: { path: string; text: string }[]): Promise<number> {
    const settings = this.settings().decisions;
    if (!settings.enabled || !settings.screen_writes) return 0;
    let flags = 0;
    for (const page of pages) {
      const verdict = await screenText(this.env, settings, page);
      if (!verdict?.flagged) continue;
      this.insertFlag({
        kind: "untrusted_text",
        path: page.path,
        detail: `Text may give orders to an AI agent (P = ${verdict.score}, threshold ${verdict.threshold}).`,
        score: verdict.score,
        backend: verdict.backend,
        model: verdict.model,
        commit_id: commitId,
      });
      flags++;
    }
    return flags;
  }

  // -------------------------------------------------------------------------
  // Graph
  // -------------------------------------------------------------------------

  private ontology(): { ontology: Ontology; error: string | null } {
    const seq = this.seq();
    if (this.ontologyCache && this.ontologyCache.seq === seq) return this.ontologyCache;
    const text = this.livePage(ONTOLOGY_PATH)?.content ?? null;
    const parsed = parseOntology(text);
    this.ontologyCache = { seq, ...parsed };
    return parsed;
  }

  /** Per-page graph update. Returns false when a full rebuild is needed instead. */
  private updatePageGraph(path: string, page: GraphPage): boolean {
    // A rebuild is pending: restart it so it reads this change.
    if (this.getMeta("graph_dirty") === "1") return false;
    const { ontology } = this.ontology();
    const old = this.first<{ id: string; slug: string }>("SELECT id, slug FROM graph_nodes WHERE path = ?", path);
    const node = buildNode(page, ontology);
    if (!old || old.id !== node.id || old.slug !== node.slug) return false;
    const sameSlug = this.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM pages WHERE deleted = 0 AND searchable = 1 AND slug = ? AND path != 'README.md'",
      page.slug,
    )!.n;
    if (sameSlug > 1) return false;
    this.sql.exec("DELETE FROM graph_nodes WHERE id = ?", node.id);
    this.insertNode(node);
    this.sql.exec("DELETE FROM graph_edges WHERE page = ?", path);
    const lookup: EdgeLookup = {
      idForSlug: (slug) => this.first<{ id: string }>("SELECT id FROM graph_nodes WHERE slug = ? LIMIT 1", slug)?.id,
      resolve: (link) => {
        const target = cleanLinkTarget(link);
        if (!target) return null;
        if (target.includes("/")) {
          const hit = this.first<{ slug: string }>(
            "SELECT slug FROM pages WHERE path = ? AND deleted = 0 AND searchable = 1 AND path != 'README.md'",
            `${target}.md`,
          );
          return hit?.slug ?? null;
        }
        return this.first<{ x: number }>("SELECT 1 AS x FROM graph_nodes WHERE slug = ? LIMIT 1", target) ? target : null;
      },
    };
    for (const edge of buildPageEdges(page, lookup)) this.insertEdge(edge);
    return true;
  }

  /** Inserts a node into the live table, or into the rebuild staging table with `next`. Returns true when inserted. */
  private insertNode(node: GraphNode, next = false): boolean {
    const row = nodeRow(node);
    return this.sql.exec(
      `INSERT OR IGNORE INTO ${next ? "graph_nodes_next" : "graph_nodes"} (id, slug, title, page_type, node_type, kind, path, created, updated, metadata_json, node_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.slug,
      row.title,
      row.page_type,
      row.node_type,
      row.kind,
      row.path,
      row.created,
      row.updated,
      row.metadata_json,
      JSON.stringify(node),
    ).rowsWritten > 0;
  }

  private insertEdge(edge: GraphEdge, next = false): void {
    const row = edgeRow(edge);
    this.sql.exec(
      `INSERT OR IGNORE INTO ${next ? "graph_edges_next" : "graph_edges"} (id, subject, predicate, object, source, evidence, confidence, status, extraction_method,
         page, metadata_json, edge_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.subject,
      row.predicate,
      row.object,
      row.source,
      row.evidence,
      row.confidence,
      row.status,
      row.extraction_method,
      row.page,
      row.metadata_json,
      JSON.stringify(edge),
    );
  }

  private graphPages(): GraphPage[] {
    return this.all<{ graph_json: string }>(
      "SELECT graph_json FROM pages WHERE deleted = 0 AND searchable = 1 AND graph_json IS NOT NULL ORDER BY path",
    ).map((row) => parseJson<GraphPage>(row.graph_json, { path: "", slug: "", meta: {}, links: [] }));
  }

  /** Marks the graph for a full rebuild and restarts any rebuild in progress. */
  private markGraphDirty(): void {
    this.setMeta("graph_dirty", "1");
    this.sql.exec("DELETE FROM meta WHERE key = 'graph_rebuild'");
  }

  /**
   * One bounded step of the full graph rebuild, run by the alarm. Same result
   * as `buildGraph` (path order, first node id wins, last slug wins), built in
   * staging tables: phase "nodes" then phase "edges", GRAPH_BATCH pages per
   * step, then one swap into the live tables. A commit that changes graph
   * input restarts the rebuild. Returns true when more steps remain.
   */
  private graphRebuildStep(): boolean {
    if (this.getMeta("graph_dirty") !== "1") return false;
    return this.ctx.storage.transactionSync(() => {
      let state = parseJson<{ phase: "nodes" | "edges"; cursor: string } | null>(this.getMeta("graph_rebuild"), null);
      if (!state) {
        this.sql.exec("DELETE FROM graph_nodes_next");
        this.sql.exec("DELETE FROM graph_edges_next");
        this.sql.exec("DELETE FROM graph_slugs_next");
        state = { phase: "nodes", cursor: "" };
      }
      const rows = this.all<{ path: string; graph_json: string }>(
        "SELECT path, graph_json FROM pages WHERE deleted = 0 AND searchable = 1 AND graph_json IS NOT NULL AND path > ? ORDER BY path LIMIT ?",
        state.cursor,
        GRAPH_BATCH,
      );
      const pages = rows.map((row) => parseJson<GraphPage>(row.graph_json, { path: row.path, slug: "", meta: {}, links: [] }));
      if (state.phase === "nodes") {
        const { ontology } = this.ontology();
        for (const page of pages) {
          const node = buildNode(page, ontology);
          if (this.insertNode(node, true)) {
            this.sql.exec("INSERT OR REPLACE INTO graph_slugs_next (slug, id) VALUES (?, ?)", page.slug, node.id);
          }
        }
      } else {
        const lookup: EdgeLookup = {
          idForSlug: (slug) => this.first<{ id: string }>("SELECT id FROM graph_slugs_next WHERE slug = ?", slug)?.id,
          resolve: (link) => {
            const target = cleanLinkTarget(link);
            if (!target) return null;
            if (target.includes("/")) {
              return (
                this.first<{ slug: string }>(
                  "SELECT slug FROM pages WHERE path = ? AND deleted = 0 AND searchable = 1 AND graph_json IS NOT NULL",
                  `${target}.md`,
                )?.slug ?? null
              );
            }
            return this.first("SELECT 1 AS x FROM graph_slugs_next WHERE slug = ?", target) ? target : null;
          },
        };
        for (const page of pages) for (const edge of buildPageEdges(page, lookup)) this.insertEdge(edge, true);
      }
      if (rows.length === GRAPH_BATCH) {
        this.setMeta("graph_rebuild", JSON.stringify({ phase: state.phase, cursor: rows[rows.length - 1]!.path }));
        return true;
      }
      if (state.phase === "nodes") {
        this.setMeta("graph_rebuild", JSON.stringify({ phase: "edges", cursor: "" }));
        return true;
      }
      this.sql.exec("DELETE FROM graph_nodes");
      this.sql.exec("DELETE FROM graph_edges");
      this.sql.exec("INSERT INTO graph_nodes SELECT * FROM graph_nodes_next");
      this.sql.exec("INSERT INTO graph_edges SELECT * FROM graph_edges_next");
      this.sql.exec("DELETE FROM graph_nodes_next");
      this.sql.exec("DELETE FROM graph_edges_next");
      this.sql.exec("DELETE FROM graph_slugs_next");
      this.sql.exec("DELETE FROM meta WHERE key = 'graph_rebuild'");
      this.setMeta("graph_dirty", "0");
      return false;
    });
  }

  /** Live graph rows. While a rebuild is pending these may lag the pages; the alarm catches up. */
  private graphStore(): GraphStore {
    const nodeCols = "id, slug, title, page_type, node_type, kind, path, created, updated, metadata_json";
    const edgeCols = "id, subject, predicate, object, source, evidence, confidence, status, extraction_method, page, metadata_json";
    return {
      node: (id) => this.first<NodeRow & Row>(`SELECT ${nodeCols} FROM graph_nodes WHERE id = ?`, id),
      edgesFrom: (subject, predicate) =>
        predicate
          ? this.all<EdgeRow & Row>(`SELECT ${edgeCols} FROM graph_edges WHERE subject = ? AND predicate = ? ORDER BY predicate, object`, subject, predicate)
          : this.all<EdgeRow & Row>(`SELECT ${edgeCols} FROM graph_edges WHERE subject = ? ORDER BY predicate, object`, subject),
      edgesTo: (object, predicate) =>
        predicate
          ? this.all<EdgeRow & Row>(`SELECT ${edgeCols} FROM graph_edges WHERE object = ? AND predicate = ? ORDER BY predicate, subject`, object, predicate)
          : this.all<EdgeRow & Row>(`SELECT ${edgeCols} FROM graph_edges WHERE object = ? ORDER BY predicate, subject`, object),
    };
  }

  async graph(req: GraphRequest): Promise<Result<JsonBody>> {
    if (!req || typeof req !== "object" || typeof req.op !== "string") return fail(400, "bad_request", "graph request needs op");
    await this.afterWrite();
    const store = this.graphStore();
    const toResult = (r: { ok: true; value: unknown } | { ok: false; message: string }): Result<JsonBody> =>
      r.ok ? { ok: true, value: json(r.value) } : fail(404, "not_found", r.message);
    switch (req.op) {
      case "neighbors":
        if (typeof req.node !== "string") return fail(400, "bad_request", "neighbors needs node");
        return toResult(graphNeighbors(store, req.node, req.depth ?? 1, req.predicate || undefined));
      case "facts":
        if (typeof req.node !== "string") return fail(400, "bad_request", "facts needs node");
        return toResult(graphFacts(store, req.node));
      case "path":
        if (typeof req.from !== "string" || typeof req.to !== "string") return fail(400, "bad_request", "path needs from and to");
        return toResult(graphPath(store, req.from, req.to, Math.max(0, Math.min(12, Math.floor(req.max_depth ?? 6)))));
      case "edges": {
        const where: string[] = [];
        const args: unknown[] = [];
        if (req.node) {
          where.push("subject = ?");
          args.push(req.node);
        }
        if (req.predicate) {
          where.push("predicate = ?");
          args.push(req.predicate);
        }
        if (req.status) {
          where.push("status = ?");
          args.push(req.status);
        }
        const limit = Math.max(1, Math.min(1000, Math.floor(req.limit ?? 100)));
        const edges = this.all<EdgeRow & Row>(
          `SELECT id, subject, predicate, object, source, evidence, confidence, status, extraction_method, page, metadata_json
           FROM graph_edges ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY subject, predicate, object LIMIT ?`,
          ...args,
          limit,
        );
        return { ok: true, value: json({ subject: req.node ?? null, predicate: req.predicate ?? null, status: req.status ?? null, edges }) };
      }
      case "export": {
        const nodes = this.all<{ node_json: string }>("SELECT node_json FROM graph_nodes").map((row) => parseJson<GraphNode>(row.node_json, null!));
        const edges = this.all<{ edge_json: string }>("SELECT edge_json FROM graph_edges").map((row) => parseJson<GraphEdge>(row.edge_json, null!));
        if (req.format === "graphml") return { ok: true, value: { format: "graphml", graphml: exportGraphml(nodes, edges) } };
        if (req.format === "jsonl") return { ok: true, value: { format: "jsonl", ...exportJsonl(nodes, edges) } };
        return fail(400, "bad_request", "export format must be jsonl or graphml");
      }
      default:
        return fail(400, "bad_request", "unknown graph op");
    }
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  private filterSql(req: SearchRequest): { sql: string; args: unknown[] } {
    const parts: string[] = [];
    const args: unknown[] = [];
    if (req.type) {
      parts.push("p.type = ?");
      args.push(req.type);
    }
    if (req.tag) {
      parts.push("EXISTS (SELECT 1 FROM json_each(p.tags) WHERE json_each.value = ?)");
      args.push(req.tag);
    }
    const since = validDatePrefix(req.since);
    if (since) {
      parts.push("p.updated_date IS NOT NULL AND p.updated_date >= ?");
      args.push(since);
    }
    return { sql: parts.map((part) => ` AND ${part}`).join(""), args };
  }

  private pageFields(row: PageRow): Pick<SearchRow, "slug" | "rel_path" | "type" | "title" | "updated" | "tags" | "sources"> {
    return {
      slug: row.slug,
      rel_path: row.path,
      type: row.type,
      title: row.display_title,
      updated: row.updated,
      tags: parseJson<string[]>(row.tags, []),
      sources: parseJson<string[]>(row.sources, []),
    };
  }

  async search(req: SearchRequest): Promise<Result<SearchResponse>> {
    if (!req || typeof req.query !== "string") return fail(400, "bad_request", "query must be a string");
    const wiki = this.wikiId();
    const top = Math.max(1, Math.min(100, Math.floor(req.top ?? 10)));
    const perPage = Math.max(1, Math.floor(req.per_page ?? 2));
    const granularity = req.granularity === "page" ? "page" : "section";
    const settings = this.settings().decisions;
    const gate = req.decide === true || (settings.enabled && settings.search_gate);
    const want = gate ? Math.max(top, DECISION_POOL) : top;
    const filters = this.filterSql(req);
    const match = ftsQuery(req.query);
    const vectors = req.mode === "lexical" ? null : this.vectors();
    const base: SearchResponse = { query: req.query, wiki, granularity, mode: "lexical", results: [], vector_lag: this.vectorLag() };
    if (vectors && base.vector_lag > 0) await this.afterWrite();
    if (!match) return { ok: true, value: base };

    let rows: SearchRow[] = [];
    const texts = new Map<SearchRow, string>();
    if (granularity === "page") {
      const hits = this.all<PageRow & { rank: number }>(
        `SELECT p.*, bm25(pages_fts) AS rank FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid
         WHERE pages_fts MATCH ? AND p.deleted = 0 AND p.searchable = 1${filters.sql} ORDER BY rank, p.path LIMIT ?`,
        match,
        ...filters.args,
        want,
      );
      for (const hit of hits) {
        const sections = this.all<SectionRow>("SELECT heading_path, level, text FROM sections WHERE path = ? ORDER BY section_index", hit.path);
        const snippet = collapseSnippet(
          cachePageBody(sections.map((s) => ({ headingPath: parseJson<string[]>(s.heading_path, []), level: s.level, text: s.text }))),
        );
        const row: SearchRow = {
          ...this.pageFields(hit),
          heading_path: [],
          section_index: null,
          score: round4(-hit.rank),
          retrievers: ["bm25"],
          snippet,
          neighbors: { prev: null, next: null },
        };
        rows.push(row);
      }
    } else {
      const lexical = this.all<{ id: number; rank: number }>(
        `SELECT s.id AS id, bm25(sections_fts) AS rank FROM sections_fts
         JOIN sections s ON s.id = sections_fts.rowid JOIN pages p ON p.path = s.path
         WHERE sections_fts MATCH ? AND p.deleted = 0${filters.sql} ORDER BY rank, p.path, s.section_index LIMIT ?`,
        match,
        ...filters.args,
        vectors ? LEXICAL_FUSION_DEPTH : LEXICAL_LIMIT,
      );
      let ranked: { id: number; score: number; retrievers: string[] }[] = lexical.map((hit) => ({
        id: hit.id,
        score: -hit.rank,
        retrievers: ["bm25"],
      }));
      if (vectors) {
        try {
          const [vector] = await vectors.embed([req.query]);
          const matches = (await vectors.query(wiki, vector!, VECTOR_QUERY_TOP_K)).filter((m) => m.score >= MIN_SIMILARITY);
          const ids = matches.map((m) => m.id);
          const found = new Map<string, number>();
          for (let i = 0; i < ids.length; i += 50) {
            const chunk = ids.slice(i, i + 50);
            for (const row of this.all<{ id: number; vector_id: string }>(
              `SELECT s.id AS id, s.vector_id AS vector_id FROM sections s JOIN pages p ON p.path = s.path
               WHERE s.vec_state = 1 AND p.deleted = 0 AND s.vector_id IN (${chunk.map(() => "?").join(",")})${filters.sql}`,
              ...chunk,
              ...filters.args,
            )) {
              found.set(row.vector_id, row.id);
            }
          }
          const embedding = ids.map((id) => found.get(id)).filter((id): id is number => id !== undefined);
          ranked = fuseRrf(
            lexical.map((hit) => hit.id),
            embedding,
          ).map((row) => ({ id: row.key, score: row.score, retrievers: row.retrievers }));
          base.mode = "hybrid";
        } catch {
          // Vector leg failed: lexical results only, like wiki_search.py.
        }
      }
      const counts = new Map<string, number>();
      const picked: { id: number; score: number; retrievers: string[]; path: string }[] = [];
      const paths = new Map<number, string>();
      if (ranked.length > 0) {
        for (let i = 0; i < ranked.length; i += 100) {
          const chunk = ranked.slice(i, i + 100).map((r) => r.id);
          for (const row of this.all<{ id: number; path: string }>(
            `SELECT id, path FROM sections WHERE id IN (${chunk.map(() => "?").join(",")})`,
            ...chunk,
          )) {
            paths.set(row.id, row.path);
          }
        }
      }
      for (const item of ranked) {
        const path = paths.get(item.id);
        if (path === undefined) continue;
        const count = counts.get(path) ?? 0;
        if (count >= perPage) continue;
        counts.set(path, count + 1);
        picked.push({ ...item, path });
        if (picked.length >= want) break;
      }
      for (const item of picked) {
        const section = this.first<SectionRow>("SELECT * FROM sections WHERE id = ?", item.id)!;
        const page = this.first<PageRow>("SELECT * FROM pages WHERE path = ?", section.path)!;
        const neighbor = (index: number): string | null => {
          if (index < 0) return null;
          const n = this.first<{ heading_path: string }>("SELECT heading_path FROM sections WHERE path = ? AND section_index = ?", section.path, index);
          if (!n) return null;
          const headings = parseJson<string[]>(n.heading_path, []);
          return headings.length ? headings[headings.length - 1]! : null;
        };
        const row: SearchRow = {
          ...this.pageFields(page),
          heading_path: parseJson<string[]>(section.heading_path, []),
          section_index: section.section_index,
          score: round4(item.score),
          retrievers: item.retrievers,
          snippet: collapseSnippet(section.text),
          neighbors: { prev: neighbor(section.section_index - 1), next: neighbor(section.section_index + 1) },
        };
        texts.set(row, section.text);
        rows.push(row);
      }
    }

    if (gate) {
      const gated = await gateSearchRows(this.env, settings, req.query, rows, {
        top,
        textOf: (row) => texts.get(row) ?? row.snippet,
      });
      rows = gated.rows;
      base.decision = gated.decision;
    } else {
      rows = rows.slice(0, top);
    }
    base.results = rows;
    return { ok: true, value: base };
  }

  // -------------------------------------------------------------------------
  // Links
  // -------------------------------------------------------------------------

  /** `link_key` in SQL: path-qualified links that resolve collapse to the page slug. */
  private static readonly LINK_KEY_SQL = `CASE WHEN l.has_slash = 1 AND EXISTS (
      SELECT 1 FROM pages t WHERE t.path = l.clean || '.md' AND t.deleted = 0 AND t.searchable = 1
    ) THEN l.base ELSE l.clean END`;

  async backlinks(target: string): Promise<{ target: string; inbound: { slug: string; rel_path: string; title: string }[] }> {
    const clean = cleanLinkTarget(String(target ?? ""));
    let key = clean;
    if (clean.includes("/")) {
      const hit = this.first<{ slug: string }>("SELECT slug FROM pages WHERE path = ? AND deleted = 0 AND searchable = 1", `${clean}.md`);
      if (hit) key = hit.slug;
    }
    const inbound = this.all<{ slug: string; rel_path: string; title: string }>(
      `SELECT DISTINCT p.slug AS slug, p.path AS rel_path, p.display_title AS title
       FROM links l JOIN pages p ON p.path = l.src AND p.deleted = 0 AND p.searchable = 1
       WHERE (l.clean = ? OR l.base = ?) AND ${WikiDO.LINK_KEY_SQL} = ? ORDER BY p.path`,
      key,
      key,
      key,
    );
    return { target: key, inbound };
  }

  async topLinked(n: number): Promise<{ slug: string; rel_path: string | null; title: string; inbound: number }[]> {
    const limit = Math.max(1, Math.min(1000, Math.floor(n || 10)));
    const rows = this.all<{ key: string; inbound: number }>(
      `SELECT k.key AS key, COUNT(*) AS inbound, MIN(k.pos) AS first FROM (
         SELECT ${WikiDO.LINK_KEY_SQL} AS key, l.src || char(0) || printf('%08d', l.ord) AS pos
         FROM links l JOIN pages p ON p.path = l.src AND p.deleted = 0 AND p.searchable = 1
       ) k WHERE k.key != '' GROUP BY k.key ORDER BY inbound DESC, first ASC LIMIT ?`,
      limit,
    );
    return rows.map((row) => {
      const page = this.first<{ path: string; display_title: string }>(
        "SELECT path, display_title FROM pages WHERE slug = ? AND deleted = 0 AND searchable = 1 ORDER BY path LIMIT 1",
        row.key,
      );
      return { slug: row.key, rel_path: page?.path ?? null, title: page?.display_title || row.key, inbound: row.inbound };
    });
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  async history(req: HistoryRequest): Promise<CommitSummary[]> {
    const limit = Math.max(1, Math.min(200, Math.floor(req?.limit ?? 50)));
    const before = isInt(req?.before_seq) ? req.before_seq : Number.MAX_SAFE_INTEGER;
    const commits = req?.path
      ? this.all<{ seq: number; commit_id: string; author: string; message: string; created_at: string }>(
          `SELECT c.* FROM commits c JOIN commit_paths cp ON cp.seq = c.seq WHERE cp.path = ? AND c.seq < ? ORDER BY c.seq DESC LIMIT ?`,
          req.path,
          before,
          limit,
        )
      : this.all<{ seq: number; commit_id: string; author: string; message: string; created_at: string }>(
          "SELECT * FROM commits WHERE seq < ? ORDER BY seq DESC LIMIT ?",
          before,
          limit,
        );
    return commits.map((c) => ({
      commit_id: c.commit_id,
      seq: c.seq,
      author: c.author,
      message: c.message,
      created_at: c.created_at,
      paths: this.all<{ path: string }>("SELECT path FROM commit_paths WHERE seq = ? ORDER BY path", c.seq).map((r) => r.path),
    }));
  }

  async revision(path: string, rev: number): Promise<Result<PageRecord>> {
    const current = this.first<PageRow>("SELECT * FROM pages WHERE path = ?", path);
    if (current && current.rev === rev && !current.deleted) return { ok: true, value: this.record(current) };
    const old = this.first<PageRow>("SELECT * FROM revisions WHERE path = ? AND rev = ?", path, rev);
    if (!old || old.deleted) return fail(404, "not_found", `no revision ${rev} of ${path}`);
    return { ok: true, value: this.record(old) };
  }

  async diff(path: string, fromRev: number, toRev: number): Promise<Result<{ diff: string }>> {
    const before = this.versionContent(path, fromRev);
    const after = this.versionContent(path, toRev);
    if (before === null) return fail(404, "not_found", `no revision ${fromRev} of ${path}`);
    if (after === null) return fail(404, "not_found", `no revision ${toRev} of ${path}`);
    return { ok: true, value: { diff: unifiedDiff(before, after, `a/${path}@${fromRev}`, `b/${path}@${toRev}`) } };
  }

  async revert(author: string, commitId: string): Promise<Result<CommitResult>> {
    const commit = this.first<{ seq: number }>("SELECT seq FROM commits WHERE commit_id = ?", commitId);
    if (!commit) return fail(404, "not_found", `no commit ${commitId}`);
    const paths = this.all<{ path: string; old_rev: number | null; old_deleted: number }>(
      "SELECT path, old_rev, old_deleted FROM commit_paths WHERE seq = ? ORDER BY path",
      commit.seq,
    );
    const ops: CommitOp[] = [];
    for (let i = 0; i < paths.length; i++) {
      const entry = paths[i]!;
      const current = this.first<PageRow>("SELECT rev, deleted FROM pages WHERE path = ?", entry.path);
      if (!current || current.rev !== commit.seq) {
        const details: ConflictDetails = {
          op_index: i,
          path: entry.path,
          reason: "stale_base_rev",
          current_rev: current && !current.deleted ? current.rev : null,
          base_rev: commit.seq,
        };
        return fail(409, "conflict", `${entry.path} changed after commit ${commitId}`, details);
      }
      const restore = entry.old_rev === null || entry.old_deleted ? null : this.versionContent(entry.path, entry.old_rev);
      if (restore === null) {
        if (!current.deleted) ops.push({ op: "delete", path: entry.path, base_rev: commit.seq });
      } else {
        ops.push({ op: "upsert", path: entry.path, content: restore });
      }
    }
    if (ops.length === 0) return fail(400, "bad_request", `commit ${commitId} has nothing to revert`);
    const result = this.applyCommit(author, `Revert ${commitId}`, ops, undefined);
    if (!result.ok) return result;
    await this.afterWrite();
    return { ok: true, value: result.value };
  }

  // -------------------------------------------------------------------------
  // Changes, manifest, export
  // -------------------------------------------------------------------------

  async changes(since: number, limit: number): Promise<ChangesResponse> {
    const from = isInt(since) ? since : 0;
    const max = Math.max(1, Math.min(200, Math.floor(limit || 50)));
    const rows = this.all<PageRow>(
      "SELECT path, rev, sha256, deleted, content FROM pages WHERE rev > ? ORDER BY rev, path LIMIT ?",
      from,
      max + 1,
    );
    let page = rows.slice(0, max);
    let more = rows.length > max;
    if (more) {
      // Never split one commit across responses: drop the trailing partial seq,
      // or extend to the whole seq when it alone fills the page.
      const lastSeq = page[page.length - 1]!.rev;
      const trimmed = page.filter((row) => row.rev !== lastSeq);
      if (trimmed.length > 0) {
        page = trimmed;
      } else {
        page = this.all<PageRow>("SELECT path, rev, sha256, deleted, content FROM pages WHERE rev = ? ORDER BY path", lastSeq);
        more = Boolean(this.first<{ x: number }>("SELECT 1 AS x FROM pages WHERE rev > ? LIMIT 1", lastSeq));
      }
    }
    const changes = page.map((row) =>
      row.deleted
        ? { path: row.path, rev: row.rev, sha256: "", deleted: true }
        : { path: row.path, rev: row.rev, sha256: row.sha256, deleted: false, content: row.content },
    );
    const seq = this.seq();
    return { seq, changes, more, next_since: more ? page[page.length - 1]!.rev : Math.max(from, seq) };
  }

  async manifest(): Promise<Manifest> {
    const pages: Record<string, string> = {};
    for (const row of this.all<{ path: string; sha256: string }>("SELECT path, sha256 FROM pages WHERE deleted = 0 ORDER BY path")) {
      pages[row.path] = row.sha256;
    }
    return { seq: this.seq(), pages };
  }

  async exportBatch(cursor: string | null, limit: number): Promise<{ pages: PageRecord[]; cursor: string | null; seq: number }> {
    const max = Math.max(1, Math.min(500, Math.floor(limit || 100)));
    const rows = this.all<PageRow>(
      "SELECT * FROM pages WHERE deleted = 0 AND path > ? ORDER BY path LIMIT ?",
      cursor ?? "",
      max + 1,
    );
    const pages = rows.slice(0, max).map((row) => this.record(row));
    return { pages, cursor: rows.length > max ? pages[pages.length - 1]!.path : null, seq: this.seq() };
  }

  // -------------------------------------------------------------------------
  // Lint and stats
  // -------------------------------------------------------------------------

  async lint(req: LintRequest): Promise<JsonBody> {
    const lintRows = this.all<{ path: string; slug: string; meta_json: string; malformed: number; line_count: number; links: string }>(
      "SELECT path, slug, meta_json, malformed, line_count, links FROM pages WHERE deleted = 0 AND searchable = 1 AND path != 'README.md' ORDER BY path",
    );
    const pages: LintPage[] = lintRows.map((row) => ({
      path: row.path,
      slug: row.slug,
      meta: parseJson<Record<string, FrontmatterValue>>(row.meta_json, {}),
      malformed: row.malformed === 1,
      lineCount: row.line_count,
      links: parseJson<string[]>(row.links, []),
    }));
    const structural = lintPages(pages, { staleDays: isInt(req?.stale_days) ? req.stale_days : 90 });

    let graph: Record<string, unknown> | null = null;
    if (this.livePage(ONTOLOGY_PATH)) {
      const { ontology, error } = this.ontology();
      const graphPages = this.graphPages();
      const findings: Record<string, unknown> = { ...graphLint(graphPages, ontology) };
      if (error) findings.ontology_error = error;
      if (req?.decide) Object.assign(findings, await this.evidenceCheck(graphPages, ontology, findings));
      graph = findings;
    }
    return json({ ...structural, graph, open_review_flags: this.openReviewCount() });
  }

  /** D2: check typed edges whose evidence is not quoted in the source page. */
  private async evidenceCheck(pages: GraphPage[], ontology: Ontology, findings: Record<string, unknown>): Promise<Record<string, unknown>> {
    const settings = this.settings().decisions;
    const implicit = new Set(["mentions", "sourced_from", "summarizes_raw"]);
    const unsupported: Record<string, unknown>[] = [];
    const check = {
      backend: settings.backend,
      model: settings.model,
      threshold: null as number | null,
      latency_ms: 0,
      checked: 0,
      candidates: 0,
      errors: 0,
      failed_open: false,
    };
    const titleOf = new Map<string, string>();
    for (const page of pages) titleOf.set(buildNode(page, ontology).id, truthy(page.meta.title) ? pyStr(page.meta.title) : page.slug);
    const bodies = new Map<string, string | null>();
    const sourceBody = (slug: string): string | null => {
      if (!bodies.has(slug)) {
        const row = this.first<{ content: string }>(
          "SELECT content FROM pages WHERE slug = ? AND deleted = 0 AND searchable = 1 AND type = 'source' ORDER BY path LIMIT 1",
          slug,
        );
        bodies.set(slug, row ? parseYamlFrontmatter(row.content).body : null);
      }
      return bodies.get(slug) ?? null;
    };
    for (const page of pages) {
      const gm = isObject(page.meta.graph) ? page.meta.graph : {};
      const rels = Array.isArray(gm.relationships) ? gm.relationships : [];
      const subject = buildNode(page, ontology).id;
      for (let index = 0; index < rels.length; index++) {
        const rel = rels[index];
        if (!isObject(rel) || !truthy(rel.predicate) || !truthy(rel.object)) continue;
        const predicate = pyStr(rel.predicate);
        if (implicit.has(predicate) || !truthy(rel.evidence) || !truthy(rel.source)) continue;
        const body = sourceBody(pyStr(rel.source));
        const evidence = pyStr(rel.evidence);
        if (body === null || evidenceInText(evidence, body)) continue;
        check.candidates++;
        if (check.checked >= MAX_EVIDENCE_CHECKS) continue;
        check.checked++;
        const object = pyStr(rel.object);
        const verdict = await checkEvidence(this.env, settings, {
          source: pyStr(rel.source),
          body,
          evidence,
          edge: `${titleOf.get(subject) ?? subject} ${predicate.replaceAll("_", " ")} ${titleOf.get(object) ?? object}`,
        });
        if ("error" in verdict) {
          check.errors++;
          check.failed_open = true;
          continue;
        }
        check.threshold = verdict.threshold;
        check.latency_ms += verdict.latency_ms;
        if (verdict.supported) continue;
        const item = {
          page: page.path,
          predicate,
          object,
          index,
          source: pyStr(rel.source),
          evidence,
          choice: verdict.choice,
          confidence: verdict.confidence,
          best_sentence: verdict.sentence,
          backend: verdict.backend,
          model: verdict.model,
        };
        unsupported.push(item);
        const detail = `Evidence for ${subject} ${predicate} ${object} is not supported by source ${item.source}.`;
        const exists = this.first<{ x: number }>(
          "SELECT 1 AS x FROM review_flags WHERE kind = 'evidence' AND path = ? AND detail = ? AND status = 'open'",
          page.path,
          detail,
        );
        if (!exists) {
          this.insertFlag({
            kind: "evidence",
            path: page.path,
            detail,
            score: verdict.confidence,
            backend: verdict.backend,
            model: verdict.model,
            commit_id: null,
          });
        }
      }
    }
    const summary = isObject(findings.summary) ? { ...findings.summary } : {};
    summary.evidence_unsupported = unsupported.length;
    return { evidence_unsupported: unsupported, evidence_check: check, summary };
  }

  async stats(): Promise<JsonBody> {
    const rows = this.all<{ path: string; line_count: number; word_count: number; stats_type: string | null; stats_links: string }>(
      "SELECT path, line_count, word_count, stats_type, stats_links FROM pages WHERE deleted = 0 AND path LIKE '%.md' ORDER BY path",
    );
    let indexLines = 0;
    let hasIndexesDir = false;
    const pages: StatsPage[] = [];
    const skipFiles = new Set(["SCHEMA.md", "log.md", "README.md"]);
    const skipDirs = new Set(["indexes", "graph", "raw", ".evolution", ".wiki-cache"]);
    for (const row of rows) {
      const parts = row.path.split("/");
      if (parts[0] === "indexes" && parts.length > 1) hasIndexesDir = true;
      if (row.path === "index.md") {
        indexLines = row.line_count;
        continue;
      }
      if (parts.length === 1 && skipFiles.has(parts[0]!)) continue;
      if (parts.length > 1 && skipDirs.has(parts[0]!)) continue;
      if (parts[parts.length - 1]!.startsWith(".")) continue;
      pages.push({
        path: row.path,
        lineCount: row.line_count,
        wordCount: row.word_count,
        statsType: row.stats_type,
        links: parseJson<string[]>(row.stats_links, []),
      });
    }
    return json(computeStats(pages, indexLines, hasIndexesDir));
  }

  // -------------------------------------------------------------------------
  // Tokens and pairing codes
  // -------------------------------------------------------------------------

  private tokenInfo(row: { id: string; label: string; scopes: string; created_at: string; last_used_at: string | null; revoked_at: string | null }): TokenInfo {
    return {
      id: row.id,
      label: row.label,
      scopes: parseJson<Scope[]>(row.scopes, []),
      created_at: row.created_at,
      last_used_at: row.last_used_at,
      revoked_at: row.revoked_at,
    };
  }

  async createToken(label: string, scopes: Scope[]): Promise<{ token: string; info: TokenInfo }> {
    const wiki = this.wikiId();
    if (typeof label !== "string" || !label.trim()) throw new Error("token label must be a non-empty string");
    if (!isScopeList(scopes) || scopes.length === 0) throw new Error("token scopes must be a non-empty list of read, write, raw:write, admin");
    const secret = randomBase64Url(32);
    const row = {
      id: `tok_${randomHex(8)}`,
      label: label.trim().slice(0, 200),
      scopes: JSON.stringify([...new Set(scopes)]),
      created_at: nowIso(),
      last_used_at: null,
      revoked_at: null,
    };
    this.sql.exec(
      "INSERT INTO tokens (id, hash, label, scopes, created_at) VALUES (?, ?, ?, ?, ?)",
      row.id,
      sha256Hex(secret),
      row.label,
      row.scopes,
      row.created_at,
    );
    return { token: `lw_${wiki}_${secret}`, info: this.tokenInfo(row) };
  }

  async listTokens(): Promise<TokenInfo[]> {
    return this.all<{ id: string; label: string; scopes: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>(
      "SELECT id, label, scopes, created_at, last_used_at, revoked_at FROM tokens ORDER BY created_at, id",
    ).map((row) => this.tokenInfo(row));
  }

  async revokeToken(id: string): Promise<boolean> {
    return this.sql.exec("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", nowIso(), id).rowsWritten > 0;
  }

  async verifyToken(secret: string): Promise<{ id: string; label: string; scopes: Scope[] } | null> {
    if (typeof secret !== "string" || secret.length === 0 || secret.length > 200) return null;
    const row = this.first<{ id: string; label: string; scopes: string; last_used_at: string | null }>(
      "SELECT id, label, scopes, last_used_at FROM tokens WHERE hash = ? AND revoked_at IS NULL",
      sha256Hex(secret),
    );
    if (!row) return null;
    const now = Date.now();
    if (!row.last_used_at || now - Date.parse(row.last_used_at) > TOKEN_TOUCH_MS) {
      this.sql.exec("UPDATE tokens SET last_used_at = ? WHERE id = ?", new Date(now).toISOString(), row.id);
    }
    return { id: row.id, label: row.label, scopes: parseJson<Scope[]>(row.scopes, []) };
  }

  async createPairingCode(label: string, scopes: Scope[], ttlSeconds: number): Promise<{ code: string; expires_at: string }> {
    if (typeof label !== "string" || !label.trim()) throw new Error("pairing label must be a non-empty string");
    if (!isScopeList(scopes) || scopes.length === 0) throw new Error("pairing scopes must be a non-empty list of read, write, raw:write, admin");
    const ttl = Math.max(30, Math.min(3600, Math.floor(ttlSeconds || 600)));
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const chars = Array.from(bytes, (b) => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]).join("");
    const code = `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    this.sql.exec(
      "DELETE FROM pairing_codes WHERE expires_at < ? OR used_at IS NOT NULL",
      new Date(Date.now() - 86_400_000).toISOString(),
    );
    this.sql.exec(
      "INSERT INTO pairing_codes (hash, label, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      sha256Hex(normalizeCode(code)),
      label.trim().slice(0, 200),
      JSON.stringify([...new Set(scopes)]),
      nowIso(),
      expiresAt,
    );
    return { code, expires_at: expiresAt };
  }

  async consumePairingCode(code: string): Promise<{ label: string; scopes: Scope[] } | null> {
    if (typeof code !== "string") return null;
    const hash = sha256Hex(normalizeCode(code));
    const now = nowIso();
    const row = this.first<{ label: string; scopes: string }>(
      "UPDATE pairing_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ? RETURNING label, scopes",
      now,
      hash,
      now,
    );
    return row ? { label: row.label, scopes: parseJson<Scope[]>(row.scopes, []) } : null;
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  private settings(): WikiSettings {
    const stored = parseJson<Partial<DecisionSettings>>(this.getMeta("decision_settings"), {});
    return { decisions: { ...DEFAULT_DECISION_SETTINGS, ...stored } };
  }

  async getSettings(): Promise<WikiSettings> {
    return this.settings();
  }

  /** Throws an Error with a readable message when a field is invalid. */
  async updateSettings(patch: Partial<{ decisions: Partial<DecisionSettings> }>): Promise<WikiSettings> {
    const input: unknown = patch?.decisions ?? {};
    if (!isObject(input)) throw new Error("settings.decisions must be an object");
    const current = this.settings().decisions;
    const next: DecisionSettings = { ...current };
    const unknownKeys = Object.keys(input).filter((key) => !(key in DEFAULT_DECISION_SETTINGS));
    if (unknownKeys.length) throw new Error(`unknown decision settings: ${unknownKeys.join(", ")}`);
    const bool = (key: "enabled" | "search_gate" | "screen_writes"): void => {
      if (key in input) {
        if (typeof input[key] !== "boolean") throw new Error(`${key} must be true or false`);
        next[key] = input[key];
      }
    };
    const unit = (key: "relevance_threshold" | "screen_threshold"): void => {
      if (key in input) {
        const value = input[key];
        if (typeof value !== "number" || !(value >= 0 && value <= 1)) throw new Error(`${key} must be a number from 0 to 1`);
        next[key] = value;
      }
    };
    bool("enabled");
    bool("search_gate");
    bool("screen_writes");
    unit("relevance_threshold");
    unit("screen_threshold");
    if ("backend" in input) {
      const backend = input.backend;
      if (typeof backend !== "string" || !BACKENDS.includes(backend as DecisionBackend)) {
        throw new Error(`backend must be one of ${BACKENDS.join(", ")}`);
      }
      if (backend !== current.backend && !("model" in input)) next.model = defaultModel(backend as DecisionBackend);
      next.backend = backend as DecisionBackend;
    }
    if ("model" in input) {
      const model = input.model;
      if (typeof model !== "string" || !model.trim() || model.length > 200) throw new Error("model must be a non-empty string");
      next.model = model.trim();
    }
    if ("timeout_ms" in input) {
      const timeout = input.timeout_ms;
      if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 100 || timeout > 60_000) {
        throw new Error("timeout_ms must be an integer from 100 to 60000");
      }
      next.timeout_ms = timeout;
    }
    this.setMeta("decision_settings", JSON.stringify(next));
    return { decisions: next };
  }

  async decide(body: { state: unknown; questions: Record<string, unknown> }): Promise<Result<JsonBody>> {
    const result = await decideResult(this.env, this.settings().decisions, body);
    return result.ok ? { ok: true, value: json(result.value) } : result;
  }

  // -------------------------------------------------------------------------
  // Review flags
  // -------------------------------------------------------------------------

  private insertFlag(flag: Omit<ReviewFlag, "id" | "created_at" | "status">): void {
    this.sql.exec(
      `INSERT INTO review_flags (id, created_at, kind, path, detail, score, backend, model, commit_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      `rf_${randomHex(8)}`,
      nowIso(),
      flag.kind,
      flag.path,
      flag.detail,
      flag.score,
      flag.backend,
      flag.model,
      flag.commit_id,
    );
  }

  private flag(row: Row): ReviewFlag {
    return {
      id: String(row.id),
      created_at: String(row.created_at),
      kind: row.kind as ReviewFlag["kind"],
      path: String(row.path),
      detail: String(row.detail),
      score: typeof row.score === "number" ? row.score : null,
      backend: typeof row.backend === "string" ? row.backend : null,
      model: typeof row.model === "string" ? row.model : null,
      commit_id: typeof row.commit_id === "string" ? row.commit_id : null,
      status: row.status as ReviewFlag["status"],
      resolved_by: typeof row.resolved_by === "string" ? row.resolved_by : null,
    };
  }

  async listReview(status?: ReviewFlag["status"]): Promise<ReviewFlag[]> {
    const rows = status
      ? this.all("SELECT * FROM review_flags WHERE status = ? ORDER BY created_at DESC, id", status)
      : this.all("SELECT * FROM review_flags ORDER BY created_at DESC, id");
    return rows.map((row) => this.flag(row));
  }

  async resolveReview(id: string, status: "accepted" | "dismissed", by: string): Promise<Result<ReviewFlag>> {
    if (status !== "accepted" && status !== "dismissed") return fail(400, "bad_request", "status must be accepted or dismissed");
    const row = this.first("UPDATE review_flags SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ? RETURNING *", status, by, nowIso(), id);
    return row ? { ok: true, value: this.flag(row) } : fail(404, "not_found", `no review flag ${id}`);
  }

  // -------------------------------------------------------------------------
  // Raw file metadata
  // -------------------------------------------------------------------------

  async rawRecord(entry: RawEntry): Promise<Result<{ entry: RawEntry; created: boolean }>> {
    const problem = pathError(entry?.path);
    if (problem) return fail(400, "bad_request", `raw path: ${problem}`);
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) return fail(400, "bad_request", "sha256 must be 64 lowercase hex characters");
    if (!isInt(entry.bytes)) return fail(400, "bad_request", "bytes must be a non-negative integer");
    const existing = await this.rawStat(entry.path);
    if (existing) {
      if (existing.sha256 === entry.sha256) return { ok: true, value: { entry: existing, created: false } };
      return fail(409, "conflict", `raw file ${entry.path} exists with different content`, { path: entry.path, sha256: existing.sha256 });
    }
    const row: RawEntry = {
      path: entry.path,
      bytes: entry.bytes,
      sha256: entry.sha256,
      content_type: typeof entry.content_type === "string" && entry.content_type ? entry.content_type : "application/octet-stream",
      uploaded_at: typeof entry.uploaded_at === "string" && entry.uploaded_at ? entry.uploaded_at : nowIso(),
      uploaded_by: typeof entry.uploaded_by === "string" ? entry.uploaded_by : "",
    };
    this.sql.exec(
      "INSERT INTO raw_files (path, bytes, sha256, content_type, uploaded_at, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)",
      row.path,
      row.bytes,
      row.sha256,
      row.content_type,
      row.uploaded_at,
      row.uploaded_by,
    );
    return { ok: true, value: { entry: row, created: true } };
  }

  async rawStat(path: string): Promise<RawEntry | null> {
    return this.first<RawEntry & Row>("SELECT * FROM raw_files WHERE path = ?", path);
  }

  async rawList(prefix: string): Promise<RawEntry[]> {
    const p = typeof prefix === "string" ? prefix : "";
    return this.all<RawEntry & Row>("SELECT * FROM raw_files WHERE substr(path, 1, ?) = ? ORDER BY path", p.length, p);
  }

  // -------------------------------------------------------------------------
  // Alarm: graph rebuild and vector sync
  // -------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    const graphMore = this.graphRebuildStep();
    const backend = this.vectors();
    if (!backend || this.getMeta("wiki") === null) {
      if (graphMore) await this.ctx.storage.setAlarm(Date.now() + 100);
      return;
    }
    const wiki = this.wikiId();
    try {
      const deletes = this.all<{ vector_id: string }>("SELECT vector_id FROM vector_deletes LIMIT ?", VECTOR_DELETE_BATCH).map((r) => r.vector_id);
      if (deletes.length) {
        await backend.deleteByIds(deletes);
        for (const id of deletes) this.sql.exec("DELETE FROM vector_deletes WHERE vector_id = ?", id);
      }
      const pending = this.all<SectionRow & { display_title: string }>(
        `SELECT s.id, s.path, s.section_index, s.heading_path, s.text, s.vector_id, p.display_title
         FROM sections s JOIN pages p ON p.path = s.path WHERE s.vec_state = 0 ORDER BY s.id LIMIT ?`,
        VECTOR_BATCH,
      );
      if (pending.length) {
        const texts = pending.map((s) => searchableText(s.display_title, { headingPath: parseJson<string[]>(s.heading_path, []), text: s.text }));
        const vectors = await backend.embed(texts);
        if (vectors.length !== pending.length) throw new Error("embedding count does not match the batch");
        await backend.upsert(
          wiki,
          pending.map((s, i) => ({ id: s.vector_id, values: vectors[i]!, metadata: { path: s.path, section_index: s.section_index } })),
        );
        for (const s of pending) {
          const updated = this.sql.exec("UPDATE sections SET vec_state = 1 WHERE id = ? AND vector_id = ?", s.id, s.vector_id).rowsWritten;
          // The section changed while the batch ran: the stored vector is stale.
          if (updated === 0 && !this.first("SELECT 1 AS x FROM sections WHERE vector_id = ?", s.vector_id)) {
            this.sql.exec("INSERT OR IGNORE INTO vector_deletes (vector_id) VALUES (?)", s.vector_id);
          }
        }
      }
      this.setMeta("vector_failures", "0");
      const more = this.first("SELECT 1 AS x FROM sections WHERE vec_state = 0 UNION ALL SELECT 1 FROM vector_deletes LIMIT 1");
      if (more || graphMore) await this.ctx.storage.setAlarm(Date.now() + (more ? 1000 : 100));
    } catch {
      const failures = Number(this.getMeta("vector_failures") ?? "0") + 1;
      this.setMeta("vector_failures", String(failures));
      await this.ctx.storage.setAlarm(Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1)));
    }
  }
}
