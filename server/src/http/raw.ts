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
  const head = await bucket.head(key);
  const headSha = head?.checksums.sha256 ? hex(head.checksums.sha256) : null;
  if (headSha && headSha !== sha256) return conflict(path, headSha);
  let obj: R2Object | null;
  try {
    obj = await bucket.put(key, body, {
      sha256,
      httpMetadata: { contentType },
      customMetadata: { sha256, uploaded_by: p.label },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/checksum|sha-?256|digest|integrity/i.test(msg)) return badRequest("The body does not match X-Content-SHA256.");
    throw e;
  }
  if (!obj) return badRequest("The upload was rejected.");
  const entry: RawEntry = {
    path,
    bytes: obj.size,
    sha256,
    content_type: contentType,
    uploaded_at: new Date().toISOString(),
    uploaded_by: p.label,
  };
  return stub.rawRecord(entry);
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
