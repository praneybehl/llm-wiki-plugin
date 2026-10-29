import type { Env } from "../env";
import type { Principal, RawEntry, Result } from "../types";
import { wikiStub } from "./auth";
import { HttpError, hex } from "./util";

/** Workers accept request bodies up to 100 MB on the Free and Pro plans. */
export const MAX_RAW_BYTES = 100 * 1024 * 1024;

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Raw paths follow the page path rules: relative POSIX, no dot segments, no control characters. */
export function validRawPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || CONTROL_RE.test(path)) return false;
  if (new TextEncoder().encode(path).byteLength > 512) return false;
  return path.split("/").every((seg) => seg.length > 0 && !seg.startsWith("."));
}

export function rawKey(wiki: string, path: string): string {
  return `${wiki}/raw/${path}`;
}

export function requireRaw(env: Env): R2Bucket {
  if (!env.RAW) throw new HttpError(503, "unavailable", "Raw storage is not configured on this deployment (no RAW binding).");
  return env.RAW;
}

/**
 * Store immutable raw bytes. Same content again answers `created: false`;
 * different content at an existing path is a conflict.
 *
 * The R2 write is conditional (`If-None-Match: *`), so two uploads that race
 * to a new path cannot both write: the loser reads the stored object and gets
 * `created: false` (same bytes) or a conflict (different bytes). The Durable
 * Object metadata always describes the object that R2 holds.
 */
export async function putRaw(
  env: Env,
  p: Principal,
  path: string,
  body: ReadableStream | ArrayBuffer | Uint8Array,
  sha256: string,
  contentType: string,
): Promise<Result<{ entry: RawEntry; created: boolean }>> {
  const bucket = requireRaw(env);
  if (!validRawPath(path)) return badRequest("The raw path is not valid.");
  if (!/^[0-9a-f]{64}$/.test(sha256)) return badRequest("X-Content-SHA256 must be 64 lowercase hex characters.");
  const stub = wikiStub(env, p.wiki);
  const existing = await stub.rawStat(path);
  if (existing) {
    if (existing.sha256 === sha256) return { ok: true, value: { entry: existing, created: false } };
    return conflict(path, existing.sha256);
  }
  const key = rawKey(p.wiki, path);
  // An object without a metadata row: an earlier upload stopped before it recorded the row.
  const head = await bucket.head(key);
  if (head) return settleExisting(env, p, path, head, sha256);
  let obj: R2Object | null;
  try {
    obj = await bucket.put(key, body, {
      sha256,
      onlyIf: new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType },
      customMetadata: { sha256, uploaded_by: p.label },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/checksum|sha-?256|digest|integrity/i.test(msg)) return badRequest("The body does not match X-Content-SHA256.");
    throw e;
  }
  if (!obj) {
    // The precondition failed: another upload created the object first.
    const winner = await bucket.head(key);
    if (!winner) return { ok: false, status: 503, error: { code: "unavailable", message: "The raw write was not applied. Try again." } };
    return settleExisting(env, p, path, winner, sha256);
  }
  return stub.rawRecord(entryFor(path, obj, sha256, contentType, p.label));
}

/** Record the stored object's metadata, then compare it with the upload. Never replaces the object. */
async function settleExisting(
  env: Env,
  p: Principal,
  path: string,
  obj: R2Object,
  sha256: string,
): Promise<Result<{ entry: RawEntry; created: boolean }>> {
  const storedSha = obj.checksums.sha256 ? hex(obj.checksums.sha256) : obj.customMetadata?.sha256;
  if (!storedSha || !/^[0-9a-f]{64}$/.test(storedSha)) {
    return { ok: false, status: 409, error: { code: "conflict", message: "A raw object exists at this path without a SHA-256 checksum.", details: { path } } };
  }
  const contentType = obj.httpMetadata?.contentType || "application/octet-stream";
  const uploadedBy = obj.customMetadata?.uploaded_by ?? p.label;
  const recorded = await wikiStub(env, p.wiki).rawRecord(entryFor(path, obj, storedSha, contentType, uploadedBy, obj.uploaded.toISOString()));
  if (!recorded.ok) return recorded;
  if (recorded.value.entry.sha256 !== sha256) return conflict(path, recorded.value.entry.sha256);
  return { ok: true, value: { entry: recorded.value.entry, created: false } };
}

function entryFor(path: string, obj: R2Object, sha256: string, contentType: string, uploadedBy: string, uploadedAt = new Date().toISOString()): RawEntry {
  return { path, bytes: obj.size, sha256, content_type: contentType, uploaded_at: uploadedAt, uploaded_by: uploadedBy };
}

function badRequest(message: string): Result<never> {
  return { ok: false, status: 400, error: { code: "bad_request", message } };
}

function conflict(path: string, current: string): Result<never> {
  return {
    ok: false,
    status: 409,
    error: { code: "conflict", message: "Raw files are immutable. Different content exists at this path.", details: { path, current_sha256: current } },
  };
}
