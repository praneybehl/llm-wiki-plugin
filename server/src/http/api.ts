import type { Env } from "../env";
import type { CommitRequest, GraphRequest, HistoryRequest, LintRequest, Principal, ReadRequest, SearchRequest } from "../types";
import {
  hasScope,
  isScopeList,
  isWikiId,
  registryStub,
  requireScope,
  resolveApiPrincipal,
  wikiStub,
} from "./auth";
import { MAX_RAW_BYTES, putRaw, rawKey, requireRaw, validRawPath } from "./raw";
import {
  HttpError,
  errorResponse,
  fromHttpError,
  fromResult,
  intParam,
  isObject,
  json,
  readJson,
  requiredParam,
} from "./util";

export const API_PREFIX = "/api/v1";
export const PAIRING_TTL_SECONDS = 600;
const EXPORT_BATCH = 25;

/** Entry point for every `/api/v1/*` request. */
export async function handleApi(request: Request, env: Env): Promise<Response> {
  try {
    const p = await resolveApiPrincipal(env, request);
    return await route(request, env, p);
  } catch (e) {
    if (e instanceof HttpError) return fromHttpError(e);
    console.error("api error", e);
    return errorResponse(500, "internal", "Internal error.");
  }
}

function requireAdmin(p: Principal): void {
  if (!p.deploymentAdmin && !p.scopes.includes("admin")) {
    throw new HttpError(403, "forbidden", "This action needs the deployment admin token or a wiki admin token.");
  }
}

async function requireWikiExists(env: Env, wiki: string): Promise<void> {
  if (!(await registryStub(env).hasWiki(wiki))) {
    throw new HttpError(404, "not_found", `Wiki "${wiki}" does not exist. Create it first.`);
  }
}

/** Target wiki for admin calls: deployment admins pick any wiki, wiki admins only their own. */
async function adminTarget(env: Env, p: Principal, requested: unknown): Promise<string> {
  requireAdmin(p);
  const wiki = requested === undefined || requested === null || requested === "" ? p.wiki : requested;
  if (!isWikiId(wiki)) throw new HttpError(400, "bad_request", "The wiki id is not valid.");
  if (!p.deploymentAdmin && wiki !== p.wiki) throw new HttpError(403, "forbidden", "A wiki admin token manages only its own wiki.");
  await requireWikiExists(env, wiki);
  return wiki;
}

function validLabel(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= 100 && !/[\u0000-\u001f]/.test(v);
}

async function body(request: Request, optional = false): Promise<Record<string, unknown>> {
  const b = await readJson(request, undefined, optional);
  if (!isObject(b)) throw new HttpError(400, "bad_request", "Request body must be a JSON object.");
  return b;
}

async function route(request: Request, env: Env, p: Principal): Promise<Response> {
  const url = new URL(request.url);
  const sub = url.pathname.slice(API_PREFIX.length) || "/";
  const method = request.method;

  if (sub === "/whoami" && method === "GET") {
    return json({ wiki: p.wiki, label: p.label, scopes: p.scopes, admin: p.deploymentAdmin });
  }
  if (sub.startsWith("/admin/")) return adminRoute(request, env, p, sub, url);

  if (p.deploymentAdmin) await requireWikiExists(env, p.wiki);
  const stub = wikiStub(env, p.wiki);

  if (sub === "/raw" || sub === "/raw/" || sub.startsWith("/raw/")) return rawRoute(request, env, p, sub, url);

  const key = `${method} ${sub}`;
  switch (key) {
    case "GET /overview":
      requireScope(p, "read");
      return json(await stub.overview());
    case "GET /pages":
      requireScope(p, "read");
      return json(await stub.list({ prefix: url.searchParams.get("prefix") ?? "" }));
    case "GET /page": {
      requireScope(p, "read");
      const req: ReadRequest = { paths: [requiredParam(url, "path")] };
      const heading = url.searchParams.get("heading");
      if (heading) req.heading = heading;
      const start = intParam(url, "start_line", { min: 1 });
      const end = intParam(url, "end_line", { min: 1 });
      if (start !== undefined) req.start_line = start;
      if (end !== undefined) req.end_line = end;
      const res = await stub.read(req);
      const page = res.pages[0];
      if (!page) return errorResponse(404, "not_found", `Page not found: ${req.paths[0]}`);
      return json(page);
    }
    case "POST /read": {
      requireScope(p, "read");
      const b = await body(request);
      if (!Array.isArray(b.paths) || b.paths.length === 0 || b.paths.length > 200 || !b.paths.every((x) => typeof x === "string")) {
        throw new HttpError(400, "bad_request", "paths must be an array of 1 to 200 strings.");
      }
      return json(await stub.read(b as unknown as ReadRequest));
    }
    case "POST /commit": {
      requireScope(p, "write");
      const b = await body(request);
      if (typeof b.message !== "string" || !Array.isArray(b.ops)) {
        throw new HttpError(400, "bad_request", "A commit needs a message string and an ops array.");
      }
      return fromResult(await stub.commit(p.label, b as unknown as CommitRequest));
    }
    case "POST /search": {
      requireScope(p, "read");
      const b = await body(request);
      if (typeof b.query !== "string" || b.query.trim() === "") throw new HttpError(400, "bad_request", "query must be a non-empty string.");
      return fromResult(await stub.search(b as unknown as SearchRequest));
    }
    case "GET /backlinks":
      requireScope(p, "read");
      return json(await stub.backlinks(requiredParam(url, "target")));
    case "GET /top-linked":
      requireScope(p, "read");
      return json(await stub.topLinked(intParam(url, "n", { min: 1, max: 500 }) ?? 20));
    case "GET /history": {
      requireScope(p, "read");
      const req: HistoryRequest = {};
      const path = url.searchParams.get("path");
      if (path) req.path = path;
      const limit = intParam(url, "limit", { min: 1, max: 500 });
      const before = intParam(url, "before_seq", { min: 0 });
      if (limit !== undefined) req.limit = limit;
      if (before !== undefined) req.before_seq = before;
      return json(await stub.history(req));
    }
    case "GET /diff": {
      requireScope(p, "read");
      const path = requiredParam(url, "path");
      const from = intParam(url, "from", { min: 0 });
      const to = intParam(url, "to", { min: 0 });
      if (from === undefined || to === undefined) throw new HttpError(400, "bad_request", "Query parameters from and to are required.");
      return fromResult(await stub.diff(path, from, to));
    }
    case "GET /revision": {
      requireScope(p, "read");
      const rev = intParam(url, "rev", { min: 1 });
      if (rev === undefined) throw new HttpError(400, "bad_request", "Query parameter rev is required.");
      return fromResult(await stub.revision(requiredParam(url, "path"), rev));
    }
    case "POST /revert": {
      requireScope(p, "write");
      const b = await body(request);
      if (typeof b.commit_id !== "string" || !b.commit_id) throw new HttpError(400, "bad_request", "commit_id is required.");
      return fromResult(await stub.revert(p.label, b.commit_id));
    }
    case "POST /graph": {
      requireScope(p, "read");
      const b = await body(request);
      if (typeof b.op !== "string") throw new HttpError(400, "bad_request", "op is required.");
      return fromResult(await stub.graph(b as unknown as GraphRequest));
    }
    case "POST /lint": {
      requireScope(p, "read");
      const b = await body(request, true);
      return json(await stub.lint(b as LintRequest));
    }
    case "GET /stats":
      requireScope(p, "read");
      return json(await stub.stats());
    case "GET /changes": {
      requireScope(p, "read");
      const since = intParam(url, "since", { min: 0 }) ?? 0;
      const limit = intParam(url, "limit", { min: 1, max: 200 }) ?? 50;
      return json(await stub.changes(since, limit));
    }
    case "GET /manifest":
      requireScope(p, "read");
      return json(await stub.manifest());
    case "GET /export":
      requireScope(p, "read");
      return exportStream(env, p.wiki);
    case "POST /decide": {
      requireScope(p, "read");
      const b = await body(request);
      if (!("state" in b) || !isObject(b.questions)) throw new HttpError(400, "bad_request", "A decision request needs state and questions.");
      return fromResult(await stub.decide({ state: b.state, questions: b.questions }));
    }
    case "GET /review": {
      requireScope(p, "read");
      const status = url.searchParams.get("status");
      if (status !== null && !["open", "accepted", "dismissed"].includes(status)) {
        throw new HttpError(400, "bad_request", "status must be open, accepted or dismissed.");
      }
      return json(await stub.listReview((status ?? undefined) as "open" | "accepted" | "dismissed" | undefined));
    }
    case "GET /settings":
      requireScope(p, "read");
      return json(await stub.getSettings());
    case "PATCH /settings": {
      requireAdmin(p);
      const b = await body(request);
      if (b.decisions !== undefined && !isObject(b.decisions)) throw new HttpError(400, "bad_request", "decisions must be an object.");
      try {
        return json(await stub.updateSettings(b.decisions ? { decisions: b.decisions } : {}));
      } catch (e) {
        throw new HttpError(400, "bad_request", e instanceof Error ? e.message : "Settings are not valid.");
      }
    }
  }
  const review = /^\/review\/([^/]+)$/.exec(sub);
  if (review && method === "POST") {
    requireScope(p, "write");
    const b = await body(request);
    if (b.status !== "accepted" && b.status !== "dismissed") throw new HttpError(400, "bad_request", "status must be accepted or dismissed.");
    return fromResult(await stub.resolveReview(decodeURIComponent(review[1]!), b.status, p.label));
  }
  return errorResponse(404, "not_found", `No route for ${method} ${API_PREFIX}${sub}.`);
}

async function adminRoute(request: Request, env: Env, p: Principal, sub: string, url: URL): Promise<Response> {
  const method = request.method;
  if (sub === "/admin/wikis") {
    if (!p.deploymentAdmin) throw new HttpError(403, "forbidden", "Only the deployment admin token manages wikis.");
    if (method === "GET") return json(await registryStub(env).listWikis());
    if (method === "POST") {
      const b = await body(request);
      if (!isWikiId(b.id)) throw new HttpError(400, "bad_request", "id must match ^[a-z0-9][a-z0-9-]{0,62}$.");
      const res = await createWiki(env, b.id, p.label);
      if (!res.ok) return fromResult(res);
      return json(res.value, res.value.created ? 201 : 200);
    }
  }
  if (sub === "/admin/tokens") {
    if (method === "GET") {
      const wiki = await adminTarget(env, p, url.searchParams.get("wiki"));
      return json(await wikiStub(env, wiki).listTokens());
    }
    if (method === "POST") {
      const b = await body(request);
      const wiki = await adminTarget(env, p, b.wiki);
      if (!validLabel(b.label)) throw new HttpError(400, "bad_request", "label must be 1 to 100 printable characters.");
      if (!isScopeList(b.scopes)) throw new HttpError(400, "bad_request", "scopes must list read, write, raw:write or admin.");
      return json(await wikiStub(env, wiki).createToken(b.label.trim(), b.scopes), 201);
    }
  }
  const tok = /^\/admin\/tokens\/([^/]+)$/.exec(sub);
  if (tok && method === "DELETE") {
    const wiki = await adminTarget(env, p, url.searchParams.get("wiki"));
    const revoked = await wikiStub(env, wiki).revokeToken(decodeURIComponent(tok[1]!));
    return revoked ? json({ revoked: true }) : errorResponse(404, "not_found", "No active token with this id.");
  }
  if (sub === "/admin/pairing-codes" && method === "POST") {
    const b = await body(request);
    const wiki = await adminTarget(env, p, b.wiki);
    if (!validLabel(b.label)) throw new HttpError(400, "bad_request", "label must be 1 to 100 printable characters.");
    if (!isScopeList(b.scopes)) throw new HttpError(400, "bad_request", "scopes must list read, write, raw:write or admin.");
    return json(await wikiStub(env, wiki).createPairingCode(b.label.trim(), b.scopes, PAIRING_TTL_SECONDS), 201);
  }
  return errorResponse(404, "not_found", `No route for ${method} ${API_PREFIX}${sub}.`);
}

/** Register a wiki and initialise its Durable Object. Idempotent. */
export async function createWiki(env: Env, id: string, by: string) {
  const res = await registryStub(env).createWiki(id, by);
  if (res.ok) await wikiStub(env, id).setup(id);
  return res;
}

function exportStream(env: Env, wiki: string): Response {
  const stub = wikiStub(env, wiki);
  const enc = new TextEncoder();
  let cursor: string | null = null;
  let firstSeq: number | null = null;
  let finished = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      const batch = await stub.exportBatch(cursor, EXPORT_BATCH);
      // The first batch's seq is the safe resume point: later changes appear in /changes.
      if (firstSeq === null) firstSeq = batch.seq;
      let chunk = "";
      for (const page of batch.pages) chunk += JSON.stringify(page) + "\n";
      cursor = batch.cursor;
      if (!cursor) {
        chunk += JSON.stringify({ done: true, seq: firstSeq }) + "\n";
        finished = true;
      }
      if (chunk) controller.enqueue(enc.encode(chunk));
      if (finished) controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function rawPathFrom(sub: string): string {
  const parts = sub.slice("/raw/".length).split("/");
  try {
    return parts.map((s) => decodeURIComponent(s)).join("/");
  } catch {
    throw new HttpError(400, "bad_request", "The raw path is not valid URL encoding.");
  }
}

async function rawRoute(request: Request, env: Env, p: Principal, sub: string, url: URL): Promise<Response> {
  const method = request.method;
  if (sub === "/raw" || sub === "/raw/") {
    if (method !== "GET") return errorResponse(405, "bad_request", "Use GET to list raw files.");
    requireScope(p, "read");
    return json(await wikiStub(env, p.wiki).rawList(url.searchParams.get("prefix") ?? ""));
  }
  const path = rawPathFrom(sub);
  if (!validRawPath(path)) throw new HttpError(400, "bad_request", "The raw path is not valid.");

  if (method === "PUT") {
    if (!hasScope(p, "raw:write")) throw new HttpError(403, "forbidden", 'This credential lacks the "raw:write" scope.');
    requireRaw(env);
    const sha = (request.headers.get("X-Content-SHA256") ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new HttpError(400, "bad_request", "X-Content-SHA256 (64 hex characters) is required.");
    const declared = Number(request.headers.get("Content-Length") ?? "NaN");
    if (Number.isFinite(declared) && declared > MAX_RAW_BYTES) throw new HttpError(413, "too_large", `Raw files are limited to ${MAX_RAW_BYTES} bytes.`);
    const contentType = request.headers.get("Content-Type") || "application/octet-stream";
    // R2 needs a known length for streams; buffer bodies without Content-Length.
    const data = Number.isFinite(declared) && request.body ? request.body : await request.arrayBuffer();
    if (data instanceof ArrayBuffer && data.byteLength > MAX_RAW_BYTES) throw new HttpError(413, "too_large", `Raw files are limited to ${MAX_RAW_BYTES} bytes.`);
    const res = await putRaw(env, p, path, data, sha, contentType);
    if (!res.ok) return fromResult(res);
    return json(res.value.entry, res.value.created ? 201 : 200);
  }

  if (method !== "GET" && method !== "HEAD") return errorResponse(405, "bad_request", "Use GET, HEAD or PUT on raw files.");
  requireScope(p, "read");
  const bucket = requireRaw(env);
  const key = rawKey(p.wiki, path);
  if (method === "HEAD") {
    const head = await bucket.head(key);
    if (!head) return new Response(null, { status: 404 });
    return new Response(null, { status: 200, headers: objectHeaders(head) });
  }
  const hasRange = request.headers.has("Range");
  let obj: R2ObjectBody | R2Object | null;
  try {
    obj = await bucket.get(key, hasRange ? { range: request.headers } : {});
  } catch {
    const head = await bucket.head(key);
    if (!head) return errorResponse(404, "not_found", `Raw file not found: ${path}`);
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${head.size}` } });
  }
  if (!obj) return errorResponse(404, "not_found", `Raw file not found: ${path}`);
  if (!("body" in obj)) return new Response(null, { status: 412 });
  const headers = objectHeaders(obj);
  const range = obj.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (hasRange && range) {
    let start: number;
    let length: number;
    if (range.suffix !== undefined) {
      length = Math.min(range.suffix, obj.size);
      start = obj.size - length;
    } else {
      start = range.offset ?? 0;
      length = range.length ?? obj.size - start;
    }
    if (start >= obj.size && obj.size > 0) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${obj.size}` } });
    }
    headers.set("Content-Range", `bytes ${start}-${start + length - 1}/${obj.size}`);
    headers.set("Content-Length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { status: 200, headers });
}

function objectHeaders(obj: R2Object): Headers {
  const h = new Headers();
  h.set("Content-Type", obj.httpMetadata?.contentType || "application/octet-stream");
  h.set("Content-Length", String(obj.size));
  h.set("ETag", obj.httpEtag);
  h.set("Accept-Ranges", "bytes");
  h.set("Cache-Control", "private, no-store");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Content-Security-Policy", "default-src 'none'; sandbox");
  const sha = obj.customMetadata?.sha256;
  if (sha) h.set("X-Content-SHA256", sha);
  return h;
}
