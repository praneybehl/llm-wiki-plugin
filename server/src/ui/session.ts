import type { Env } from "../env";
import type { Scope } from "../types";
import { base64url, fromBase64url } from "../http/util";

/** Signed UI session. Short field names keep the cookie small. */
export interface Session {
  v: 1;
  wiki: string;
  label: string;
  scopes: Scope[];
  /** Deployment admin (signed in with ADMIN_TOKEN). */
  admin: boolean;
  /** Token id when signed in with a wiki token; checked against revocation on use. */
  tid?: string;
  /** Expiry, seconds since epoch. */
  exp: number;
}

export const SESSION_COOKIE = "__Host-lw-session";
export const CSRF_COOKIE = "__Host-lw-csrf";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

const keyCache = new Map<string, Promise<CryptoKey>>();

/** HMAC key derived from ADMIN_TOKEN with HKDF. Rotating the secret ends every session. */
export function sessionKey(env: Env): Promise<CryptoKey> | null {
  const secret = env.ADMIN_TOKEN;
  if (!secret) return null;
  let p = keyCache.get(secret);
  if (!p) {
    p = (async () => {
      const ikm = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new TextEncoder().encode("llm-wiki"),
          info: new TextEncoder().encode("ui-session-v1"),
        },
        ikm,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign", "verify"],
      );
    })();
    keyCache.clear();
    keyCache.set(secret, p);
  }
  return p;
}

async function sign(key: CryptoKey, data: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return base64url(new Uint8Array(mac));
}

async function verify(key: CryptoKey, data: string, sig: string): Promise<boolean> {
  const bytes = fromBase64url(sig);
  if (!bytes) return false;
  return crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(data));
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function encodeSession(env: Env, s: Omit<Session, "v" | "exp">): Promise<string | null> {
  const key = await sessionKey(env);
  if (!key) return null;
  const payload: Session = { v: 1, ...s, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${await sign(key, "session." + body)}`;
}

export async function sessionCookie(env: Env, s: Omit<Session, "v" | "exp">): Promise<string | null> {
  const value = await encodeSession(env, s);
  return value ? cookie(SESSION_COOKIE, value, SESSION_TTL_SECONDS) : null;
}

export function clearSessionCookie(): string {
  return cookie(SESSION_COOKIE, "", 0);
}

/** Read and verify the session cookie. Returns null for missing, tampered or expired cookies. */
export async function readSession(request: Request, env: Env): Promise<Session | null> {
  const raw = getCookie(request, SESSION_COOKIE);
  if (!raw) return null;
  const key = await sessionKey(env);
  if (!key) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  if (!(await verify(key, "session." + body, raw.slice(dot + 1)))) return null;
  const bytes = fromBase64url(body);
  if (!bytes) return null;
  let s: Session;
  try {
    s = JSON.parse(new TextDecoder().decode(bytes)) as Session;
  } catch {
    return null;
  }
  if (s.v !== 1 || typeof s.exp !== "number" || s.exp < Date.now() / 1000) return null;
  return s;
}

/**
 * CSRF: a random nonce in an HttpOnly cookie plus a form field that holds
 * HMAC(nonce). An attacker can neither read the cookie nor compute the MAC.
 */
export interface CsrfState {
  token: string;
  /** Set-Cookie value when the nonce is new, else null. */
  setCookie: string | null;
}

export async function csrfFor(request: Request, env: Env): Promise<CsrfState | null> {
  const key = await sessionKey(env);
  if (!key) return null;
  let nonce = getCookie(request, CSRF_COOKIE);
  let setCookie: string | null = null;
  if (!nonce || !/^[A-Za-z0-9_-]{22,64}$/.test(nonce)) {
    nonce = base64url(crypto.getRandomValues(new Uint8Array(24)));
    setCookie = cookie(CSRF_COOKIE, nonce, SESSION_TTL_SECONDS);
  }
  return { token: await sign(key, "csrf." + nonce), setCookie };
}

/** Validate a submitted CSRF token and the request origin. */
export async function checkCsrf(request: Request, env: Env, submitted: string | null): Promise<boolean> {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return false;
  const key = await sessionKey(env);
  const nonce = getCookie(request, CSRF_COOKIE);
  if (!key || !nonce || !submitted) return false;
  return verify(key, "csrf." + nonce, submitted);
}
