import { McpServer, createMcpHandler, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { Env } from "../env";
import { hasScope, wikiStub } from "../http/auth";
import { putRaw, rawKey, requireRaw, validRawPath } from "../http/raw";
import { HttpError, MAX_JSON_BODY, base64, isObject, sha256Hex } from "../http/util";
import {
  SERVER_VERSION,
  type ApiError,
  type CommitRequest,
  type GraphRequest,
  type HistoryRequest,
  type Principal,
  type ReadRequest,
  type Result,
  type Scope,
  type SearchRequest,
} from "../types";

const RAW_READ_DEFAULT = 200_000;
const RAW_READ_MAX = 1_000_000;

export const SERVER_INSTRUCTIONS = [
  "LLM Wiki: a Markdown knowledge base that agents read and maintain.",
  "Call wiki_overview first. It returns SCHEMA.md and index.md for this wiki.",
  "Follow the rules in SCHEMA.md for page types, frontmatter, links and log entries.",
  "Use wiki_search to find pages, then wiki_read to read them.",
  "Change pages with wiki_commit. Prefer edit ops for surgical changes and append ops for log and index lines.",
  "When a commit returns a conflict, read the page again and retry with the current text.",
].join("\n");

function ok(value: unknown): CallToolResult {
  const result: CallToolResult = { content: [{ type: "text", text: JSON.stringify(value) }] };
  if (isObject(value)) result.structuredContent = value;
  return result;
}

function fail(error: ApiError, status?: number): CallToolResult {
  const payload = status === undefined ? { error } : { error, status };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
}

function fromResult<T>(r: Result<T>): CallToolResult {
  return r.ok ? ok(r.value) : fail(r.error, r.status);
}

function need(p: Principal, scope: Scope): void {
  if (!hasScope(p, scope)) throw new HttpError(403, "forbidden", `This credential lacks the "${scope}" scope.`);
}

/** Wrap a tool body: scope errors and DO failures become `isError` results. */
function guarded<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      if (e instanceof HttpError) return fail(e.toApiError(), e.status);
      console.error("mcp tool error", e);
      return fail({ code: "internal", message: e instanceof Error ? e.message : "Internal error." }, 500);
    }
  };
}

const path = z.string().min(1).max(512);
const editPair = z.object({
  old: z.string().min(1).describe("Exact text to replace. It must occur exactly once unless replace_all is true."),
  new: z.string().describe("Replacement text."),
  replace_all: z.boolean().optional().describe("Replace every occurrence."),
});
const commitOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), path, content: z.string() }).describe("Create a new page. Fails when the page exists."),
  z
    .object({ op: z.literal("put"), path, content: z.string(), base_rev: z.number().int().min(1) })
    .describe("Replace a whole page. base_rev must equal the current rev."),
  z
    .object({ op: z.literal("edit"), path, edits: z.array(editPair).min(1), base_rev: z.number().int().min(1).optional() })
    .describe("Surgical find and replace. Preferred for changes to existing pages."),
  z
    .object({
      op: z.literal("append"),
      path,
      text: z.string(),
      after_heading: z.string().optional(),
      create: z.boolean().optional(),
    })
    .describe("Add text at the end of a page or of one section. Use it for log.md and index lines. Never conflicts."),
  z.object({ op: z.literal("delete"), path, base_rev: z.number().int().min(1) }).describe("Delete a page."),
  z.object({ op: z.literal("move"), from: path, to: path, base_rev: z.number().int().min(1) }).describe("Rename a page."),
  z.object({ op: z.literal("upsert"), path, content: z.string() }).describe("Create or replace without a base revision. Use only for imports."),
]);

/** Build the per-request MCP server for one principal. */
export function buildMcpServer(env: Env, p: Principal): McpServer {
  const server = new McpServer({ name: "llm-wiki", version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const stub = wikiStub(env, p.wiki);

  server.registerTool(
    "wiki_overview",
    {
      title: "Wiki overview",
      description:
        "Call this first. Returns the wiki id, page and section counts, SCHEMA.md (the rules for this wiki), index.md, search mode and open review flags. Follow SCHEMA.md for every change.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    guarded(async () => {
      need(p, "read");
      return ok(await stub.overview());
    }),
  );

  server.registerTool(
    "wiki_read",
    {
      title: "Read pages",
      description:
        "Read one or more pages by path (for example entities/acme.md). Each page has rev and sha256: pass rev as base_rev when you replace a page. Use heading, start_line and end_line to read part of a long page. Set list_prefix (empty string for all) to list pages instead.",
      inputSchema: z.object({
        paths: z.array(path).min(1).max(50).optional().describe("Page paths to read."),
        path: path.optional().describe("One page path. Same as paths with one entry."),
        heading: z.string().optional().describe("Return only the section with this heading."),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
        list_prefix: z.string().optional().describe("List pages under this folder prefix instead of reading."),
      }),
      annotations: { readOnlyHint: true },
    },
    guarded(async (a) => {
      need(p, "read");
      if (a.list_prefix !== undefined) return ok(await stub.list({ prefix: a.list_prefix }));
      const paths = a.paths ?? (a.path ? [a.path] : []);
      if (paths.length === 0) throw new HttpError(400, "bad_request", "Give paths, path or list_prefix.");
      const req: ReadRequest = { paths };
      if (a.heading) req.heading = a.heading;
      if (a.start_line !== undefined) req.start_line = a.start_line;
      if (a.end_line !== undefined) req.end_line = a.end_line;
      return ok(await stub.read(req));
    }),
  );

  server.registerTool(
    "wiki_search",
    {
      title: "Search the wiki",
      description:
        "Hybrid search (BM25 and embeddings, fused with RRF) over page sections. Returns rows with rel_path, heading_path, score and snippet; read the best pages with wiki_read. Set backlinks to a page slug to list pages that link to it, or top_linked to a count to list the most linked pages.",
      inputSchema: z.object({
        query: z.string().optional().describe("Search text. Required unless backlinks or top_linked is set."),
        top: z.number().int().min(1).max(100).optional().describe("Number of results (default 10)."),
        type: z.string().optional().describe("Filter by frontmatter type."),
        tag: z.string().optional().describe("Filter by tag."),
        since: z.string().optional().describe("Only pages updated on or after this ISO date."),
        granularity: z.enum(["section", "page"]).optional(),
        per_page: z.number().int().min(1).max(20).optional().describe("Maximum sections per page."),
        mode: z.enum(["hybrid", "lexical"]).optional(),
        decide: z.boolean().optional().describe("Apply the relevance gate when decision models are enabled."),
        backlinks: z.string().optional().describe("Page slug: list inbound links instead of searching."),
        top_linked: z.number().int().min(1).max(500).optional().describe("List this many most linked pages instead of searching."),
      }),
      annotations: { readOnlyHint: true },
    },
    guarded(async (a) => {
      need(p, "read");
      if (a.backlinks !== undefined) return ok(await stub.backlinks(a.backlinks));
      if (a.top_linked !== undefined) return ok({ top_linked: await stub.topLinked(a.top_linked) });
      if (!a.query || !a.query.trim()) throw new HttpError(400, "bad_request", "query is required.");
      const { backlinks: _b, top_linked: _t, ...req } = a;
      return fromResult(await stub.search(req as SearchRequest));
    }),
  );

  server.registerTool(
    "wiki_commit",
    {
      title: "Change pages",
      description:
        "Apply one atomic commit: all ops succeed or none do. Prefer edit ops (exact find and replace) over put. Use append for log.md and index.md lines, or set log to add a log.md entry. On a conflict (isError with code conflict), read the page again with wiki_read and retry against the current text. Follow SCHEMA.md.",
      inputSchema: z.object({
        message: z.string().min(1).max(1000).describe("Short description of the change."),
        ops: z.array(commitOp).min(1).max(200),
        log: z.string().max(1000).optional().describe("One line to append to log.md in the same commit."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guarded(async (a) => {
      need(p, "write");
      return fromResult(await stub.commit(p.label, a as CommitRequest));
    }),
  );

  server.registerTool(
    "wiki_history",
    {
      title: "History, diff, revert",
      description:
        "List commits (optionally for one path). Set diff to compare two revisions of a page, revision to read an old revision, or revert to a commit_id to undo that commit with a new commit (needs write access).",
      inputSchema: z.object({
        path: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        before_seq: z.number().int().min(0).optional(),
        diff: z.object({ path, from_rev: z.number().int().min(0), to_rev: z.number().int().min(0) }).optional(),
        revision: z.object({ path, rev: z.number().int().min(1) }).optional(),
        revert: z.string().optional().describe("Commit id to revert."),
      }),
      annotations: { readOnlyHint: false },
    },
    guarded(async (a) => {
      if (a.revert !== undefined) {
        need(p, "write");
        return fromResult(await stub.revert(p.label, a.revert));
      }
      need(p, "read");
      if (a.diff) return fromResult(await stub.diff(a.diff.path, a.diff.from_rev, a.diff.to_rev));
      if (a.revision) return fromResult(await stub.revision(a.revision.path, a.revision.rev));
      const req: HistoryRequest = {};
      if (a.path) req.path = a.path;
      if (a.limit !== undefined) req.limit = a.limit;
      if (a.before_seq !== undefined) req.before_seq = a.before_seq;
      return ok({ commits: await stub.history(req) });
    }),
  );

  server.registerTool(
    "wiki_graph",
    {
      title: "Knowledge graph",
      description:
        "Query typed relations between pages. op neighbors (node, depth, predicate), edges (node, predicate, status, limit), facts (node), path (from, to, max_depth), export (format jsonl or graphml). Nodes are page slugs.",
      inputSchema: z.object({
        op: z.enum(["neighbors", "edges", "facts", "path", "export"]),
        node: z.string().optional(),
        depth: z.number().int().min(1).max(5).optional(),
        predicate: z.string().optional(),
        status: z.string().optional(),
        limit: z.number().int().min(1).max(5000).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        max_depth: z.number().int().min(1).max(10).optional(),
        format: z.enum(["jsonl", "graphml"]).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    guarded(async (a) => {
      need(p, "read");
      if ((a.op === "neighbors" || a.op === "facts") && !a.node) throw new HttpError(400, "bad_request", `op ${a.op} needs node.`);
      if (a.op === "path" && (!a.from || !a.to)) throw new HttpError(400, "bad_request", "op path needs from and to.");
      if (a.op === "export" && !a.format) throw new HttpError(400, "bad_request", "op export needs format.");
      return fromResult(await stub.graph(a as GraphRequest));
    }),
  );

  server.registerTool(
    "wiki_lint",
    {
      title: "Lint the wiki",
      description:
        "Check the wiki for broken links, orphans, stale pages, frontmatter problems and graph problems. Also returns open review flags. Fix findings with wiki_commit.",
      inputSchema: z.object({
        stale_days: z.number().int().min(1).optional(),
        decide: z.boolean().optional().describe("Run the evidence check when decision models are enabled."),
      }),
      annotations: { readOnlyHint: true },
    },
    guarded(async (a) => {
      need(p, "read");
      return ok(await stub.lint(a));
    }),
  );

  server.registerTool(
    "wiki_raw",
    {
      title: "Raw source files",
      description:
        "Immutable source files (PDFs, transcripts, notes) kept next to the wiki. action list (prefix), stat (path), read (path, offset, length; text comes back as UTF-8, other bytes as base64), put_text (path, text; needs raw:write). Raw files never change once stored.",
      inputSchema: z.object({
        action: z.enum(["list", "stat", "read", "put_text"]),
        path: z.string().optional(),
        prefix: z.string().optional(),
        offset: z.number().int().min(0).optional(),
        length: z.number().int().min(1).max(RAW_READ_MAX).optional(),
        text: z.string().optional(),
      }),
      annotations: { readOnlyHint: false },
    },
    guarded(async (a) => {
      if (a.action === "list") {
        need(p, "read");
        return ok({ entries: await stub.rawList(a.prefix ?? "") });
      }
      if (!a.path || !validRawPath(a.path)) throw new HttpError(400, "bad_request", "A valid path is required.");
      if (a.action === "stat") {
        need(p, "read");
        const entry = await stub.rawStat(a.path);
        if (!entry) throw new HttpError(404, "not_found", `Raw file not found: ${a.path}`);
        return ok(entry);
      }
      if (a.action === "put_text") {
        need(p, "raw:write");
        if (a.text === undefined) throw new HttpError(400, "bad_request", "text is required.");
        const bytes = new TextEncoder().encode(a.text);
        const type = a.path.endsWith(".md") ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8";
        const res = await putRaw(env, p, a.path, bytes, await sha256Hex(bytes), type);
        return fromResult(res);
      }
      need(p, "read");
      return ok(await readRawSlice(requireRaw(env), rawKey(p.wiki, a.path), a.path, a.offset ?? 0, a.length ?? RAW_READ_DEFAULT));
    }),
  );

  return server;
}

/** Read a byte range and decode it as UTF-8 on character boundaries, else base64. */
async function readRawSlice(bucket: R2Bucket, key: string, path: string, offset: number, length: number) {
  const obj = await bucket.get(key, { range: { offset, length } }).catch(() => null);
  if (!obj) throw new HttpError(404, "not_found", `Raw file not found or offset out of range: ${path}`);
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const total = obj.size;
  let start = offset;
  const isContinuation = (b: number | undefined) => b !== undefined && (b & 0xc0) === 0x80;
  let lead = 0;
  while (lead < 3 && isContinuation(bytes[lead]) && start > 0) lead++;
  let end = bytes.length;
  if (offset + bytes.length < total) {
    // Drop a trailing multi-byte character that the range cut in half.
    let i = end - 1;
    let back = 0;
    while (back < 3 && i >= 0 && isContinuation(bytes[i])) {
      i--;
      back++;
    }
    const b = bytes[i];
    if (b !== undefined && b >= 0xc0) {
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
      if (end - i < need) end = i;
    }
  }
  const textBytes = bytes.subarray(lead, end);
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(textBytes);
    start = offset + lead;
    return {
      path,
      encoding: "utf-8",
      offset: start,
      length: textBytes.byteLength,
      total_bytes: total,
      more: start + textBytes.byteLength < total,
      text,
    };
  } catch {
    return {
      path,
      encoding: "base64",
      offset,
      length: bytes.byteLength,
      total_bytes: total,
      more: offset + bytes.byteLength < total,
      data: base64(bytes),
      note: "The file is not UTF-8 text. Data is base64. Extract text locally before you cite it.",
    };
  }
}

/** Serve one MCP request for a resolved principal (Streamable HTTP, modern and legacy stateless). */
export function serveMcp(request: Request, env: Env, p: Principal): Promise<Response> {
  const handler = createMcpHandler(() => buildMcpServer(env, p), { maxRequestBodySize: MAX_JSON_BODY });
  return handler.fetch(request, {
    authInfo: { token: "", clientId: p.label, scopes: p.scopes, extra: { wiki: p.wiki } },
  });
}
