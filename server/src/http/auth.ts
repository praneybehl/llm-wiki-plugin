import type { Env } from "../env";
import type { Principal, Scope } from "../types";
import { readSession, type Session } from "../ui/session";
import { HttpError } from "./util";

export const WIKI_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const DEFAULT_WIKI = "main";
export const ALL_SCOPES: readonly Scope[] = ["read", "write", "raw:write", "admin"];

export function isWikiId(v: unknown): v is string {
  return typeof v === "string" && WIKI_ID_RE.test(v);
}

export function wikiStub(env: Env, wiki: string) {
  return env.WIKI.get(env.WIKI.idFromName(wiki));
}

export function registryStub(env: Env) {
  return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}

export function isScopeList(v: unknown): v is Scope[] {
  return Array.isArray(v) && v.length > 0 && v.every((s) => (ALL_SCOPES as readonly unknown[]).includes(s));
}

/** `admin` implies every scope; the deployment admin holds every scope on every wiki. */
export function hasScope(p: Principal, scope: Scope): boolean {
  return p.deploymentAdmin || p.scopes.includes("admin") || p.scopes.includes(scope);
}

export function requireScope(p: Principal, scope: Scope): void {
  if (!hasScope(p, scope)) throw new HttpError(403, "forbidden", `This credential lacks the "${scope}" scope.`);
}

const enc = new TextEncoder();

/** Constant-time string compare. Hashing first removes the length signal. */
export async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db) && a.length === b.length;
}

export async function isAdminToken(env: Env, token: string): Promise<boolean> {
  if (!env.ADMIN_TOKEN) return false;
  return timingSafeEqualString(token, env.ADMIN_TOKEN);
}

/** Wiki that a deployment admin selects with `X-LLM-Wiki` or `?wiki=`. */
export function adminWikiSelection(request: Request): string {
  const header = request.headers.get("X-LLM-Wiki");
  const query = new URL(request.url).searchParams.get("wiki");
  const wiki = header ?? (query || DEFAULT_WIKI);
  if (!isWikiId(wiki)) throw new HttpError(400, "bad_request", "The selected wiki id is not valid.");
  return wiki;
}

/** Split `lw_<wiki>_<secret>`. Wiki ids never contain `_`, so the first `_` after the prefix ends the id. */
export function parseWikiToken(token: string): { wiki: string; secret: string } | null {
  if (!token.startsWith("lw_")) return null;
  const rest = token.slice(3);
  const i = rest.indexOf("_");
  if (i <= 0) return null;
  const wiki = rest.slice(0, i);
  const secret = rest.slice(i + 1);
  if (!isWikiId(wiki) || !/^[A-Za-z0-9_-]{16,128}$/.test(secret)) return null;
  return { wiki, secret };
}

/**
 * Resolve a bearer credential: a wiki token or the deployment ADMIN_TOKEN.
 * Returns null for unknown, malformed or revoked credentials.
 * Throws HttpError(400) when the admin selects an invalid wiki id.
 */
export async function principalFromBearer(env: Env, token: string, request: Request): Promise<Principal | null> {
  const parsed = parseWikiToken(token);
  if (parsed) {
    // A wiki that was never set up throws; treat it like an unknown token.
    const verified = await wikiStub(env, parsed.wiki)
      .verifyToken(parsed.secret)
      .catch(() => null);
    if (!verified) return null;
    return {
      wiki: parsed.wiki,
      label: verified.label,
      scopes: verified.scopes,
      deploymentAdmin: false,
      tokenId: verified.id,
    };
  }
  if (await isAdminToken(env, token)) {
    return { wiki: adminWikiSelection(request), label: "admin", scopes: ["admin"], deploymentAdmin: true };
  }
  return null;
}

export function bearerToken(request: Request): string | null {
  const h = request.headers.get("Authorization");
  if (!h) return null;
  const m = /^Bearer[\t ]+(\S+)$/i.exec(h);
  return m ? (m[1] ?? null) : null;
}

/** Check that a token-based session still maps to a live token. */
export async function sessionStillValid(env: Env, s: Session): Promise<boolean> {
  if (s.admin || !s.tid) return s.admin;
  const tokens = await wikiStub(env, s.wiki).listTokens();
  const t = tokens.find((x) => x.id === s.tid);
  return !!t && !t.revoked_at;
}

/** Principal from a signed UI session cookie. The admin may switch wikis with `wiki`. */
export async function principalFromSession(env: Env, request: Request, wikiOverride?: string): Promise<Principal | null> {
  const s = await readSession(request, env);
  if (!s || !(await sessionStillValid(env, s))) return null;
  if (s.admin) {
    const wiki = wikiOverride ?? adminWikiSelectionOr(request, s.wiki);
    return { wiki, label: "admin", scopes: ["admin"], deploymentAdmin: true };
  }
  if (wikiOverride && wikiOverride !== s.wiki) return null;
  return { wiki: s.wiki, label: s.label, scopes: s.scopes, deploymentAdmin: false, ...(s.tid ? { tokenId: s.tid } : {}) };
}

function adminWikiSelectionOr(request: Request, fallback: string): string {
  const header = request.headers.get("X-LLM-Wiki");
  const query = new URL(request.url).searchParams.get("wiki");
  const wiki = header ?? (query || fallback);
  if (!isWikiId(wiki)) throw new HttpError(400, "bad_request", "The selected wiki id is not valid.");
  return wiki;
}

/**
 * Resolve the principal for an `/api/v1` request: bearer first, then the UI
 * session cookie. Cookie-authenticated writes must come from the same origin.
 */
export async function resolveApiPrincipal(env: Env, request: Request): Promise<Principal> {
  const token = bearerToken(request);
  if (token) {
    const p = await principalFromBearer(env, token, request);
    if (!p) throw new HttpError(401, "unauthorized", "The bearer token is not valid or was revoked.");
    return p;
  }
  if (request.headers.get("Authorization")) throw new HttpError(401, "unauthorized", "Use the Bearer authorization scheme.");
  const p = await principalFromSession(env, request);
  if (!p) throw new HttpError(401, "unauthorized", "Send a bearer token in the Authorization header.");
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("Origin");
    if (origin !== new URL(request.url).origin) {
      throw new HttpError(403, "forbidden", "Cross-origin writes with a session cookie are not allowed.");
    }
  }
  return p;
}
