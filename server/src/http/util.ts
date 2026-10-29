import type { ApiError, ErrorCode, Result } from "../types";

/** Largest JSON request body the API reads (bytes). Commits are capped at 4 MB of content. */
export const MAX_JSON_BODY = 5 * 1024 * 1024;

/** Largest HTML form body the UI and consent page read (bytes). */
export const MAX_FORM_BODY = 64 * 1024;

const NO_STORE = { "Cache-Control": "no-store" };

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: ApiError["details"],
  ) {
    super(message);
  }
  toApiError(): ApiError {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(NO_STORE)) if (!h.has(k)) h.set(k, v);
  return new Response(JSON.stringify(value), { status, headers: h });
}

export function errorResponse(status: number, code: ErrorCode, message: string, details?: ApiError["details"]): Response {
  const error: ApiError = details === undefined ? { code, message } : { code, message, details };
  return json({ error }, status);
}

export function fromHttpError(e: HttpError): Response {
  return json({ error: e.toApiError() }, e.status);
}

/** Turn a DO `Result<T>` into a Response. */
export function fromResult<T>(r: Result<T>, okStatus = 200): Response {
  return r.ok ? json(r.value, okStatus) : json({ error: r.error }, r.status);
}

/** Return a DO result's value, or throw its error as an HttpError. */
export function unwrap<T>(r: Result<T>): T {
  if (r.ok) return r.value;
  throw new HttpError(r.status, r.error.code, r.error.message, r.error.details);
}

/**
 * Read a request body with a byte cap, also when Content-Length is missing.
 * Throws a 413 HttpError before the whole body is read. No body yields null.
 */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "NaN");
  if (Number.isFinite(declared) && declared > max) throw new HttpError(413, "too_large", `Request body exceeds ${max} bytes.`);
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new HttpError(413, "too_large", `Request body exceeds ${max} bytes.`);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return buf;
}

/** Read and parse a form body with a byte cap. Throws HttpError on failure. */
export async function readForm(request: Request, max = MAX_FORM_BODY): Promise<FormData> {
  const buf = await readCapped(request, max);
  const type = request.headers.get("Content-Type") ?? "";
  if (!buf || buf.byteLength === 0) return new FormData();
  try {
    return await new Response(buf, { headers: { "Content-Type": type } }).formData();
  } catch {
    throw new HttpError(400, "bad_request", "Request body is not a valid form.");
  }
}

/** Read and parse a JSON body with a byte cap. Throws HttpError on failure. An optional empty body yields `{}`. */
export async function readJson(request: Request, max = MAX_JSON_BODY, optional = false): Promise<unknown> {
  const buf = await readCapped(request, max);
  if (!buf) {
    if (optional) return {};
    throw new HttpError(400, "bad_request", "Request body is required.");
  }
  const text = new TextDecoder().decode(buf);
  if (text.trim() === "") {
    if (optional) return {};
    throw new HttpError(400, "bad_request", "Request body is required.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_request", "Request body is not valid JSON.");
  }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse an optional integer query parameter. Throws HttpError when present but invalid. */
export function intParam(url: URL, name: string, opts: { min?: number; max?: number } = {}): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  if (!/^-?\d+$/.test(raw)) throw new HttpError(400, "bad_request", `Query parameter ${name} must be an integer.`);
  const n = Number(raw);
  if (opts.min !== undefined && n < opts.min) throw new HttpError(400, "bad_request", `Query parameter ${name} must be at least ${opts.min}.`);
  if (opts.max !== undefined && n > opts.max) throw new HttpError(400, "bad_request", `Query parameter ${name} must be at most ${opts.max}.`);
  return n;
}

export function requiredParam(url: URL, name: string): string {
  const v = url.searchParams.get(name);
  if (v === null || v === "") throw new HttpError(400, "bad_request", `Query parameter ${name} is required.`);
  return v;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const input = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", input));
}

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
