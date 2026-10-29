import { env as rawEnv, exports } from "cloudflare:workers";
import { vi } from "vitest";

// The first request in a file starts the Worker and its Durable Objects.
vi.setConfig({ testTimeout: 30_000 });
import type { Env } from "../../src/env";
import type { Scope } from "../../src/types";

export const env = rawEnv as unknown as Env;
export const ORIGIN = "https://wiki.example.com";
export const ADMIN = "test-admin-token-0123456789abcdef";

export function call(path: string, init: RequestInit = {}): Promise<Response> {
  return (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default.fetch(
    new Request(ORIGIN + path, init),
  );
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  headers?: Record<string, string>;
}

/** JSON API call. `token` defaults to ADMIN_TOKEN; pass null for no Authorization header. */
export async function api<T = any>(path: string, o: ApiOptions = {}): Promise<{ status: number; body: T; res: Response }> {
  const headers = new Headers(o.headers);
  const token = o.token === undefined ? ADMIN : o.token;
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let body: BodyInit | undefined;
  if (o.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(o.body);
  }
  const res = await call(`/api/v1${path}`, { method: o.method ?? (o.body === undefined ? "GET" : "POST"), headers, body });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: res.status, body: parsed as T, res };
}

/** Create a wiki through the admin API and return a token with the given scopes. */
export async function setupWiki(id: string, scopes: Scope[] = ["read", "write"], label = "agent"): Promise<string> {
  const w = await api("/admin/wikis", { body: { id } });
  if (w.status !== 201 && w.status !== 200) throw new Error(`create wiki failed: ${w.status} ${JSON.stringify(w.body)}`);
  const t = await api("/admin/tokens", { body: { wiki: id, label, scopes } });
  if (t.status !== 201) throw new Error(`create token failed: ${t.status} ${JSON.stringify(t.body)}`);
  return t.body.token as string;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Collect Set-Cookie values into a Cookie header value. */
export function cookiesFrom(res: Response, existing = ""): string {
  const jar = new Map<string, string>();
  for (const part of existing.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const sc of res.headers.getSetCookie()) {
    const first = sc.split(";")[0]!;
    const i = first.indexOf("=");
    jar.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
  }
  return [...jar.entries()]
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/** Extract the hidden CSRF field from a rendered page. */
export function csrfFrom(html: string): string {
  const m = /name="csrf" value="([^"]+)"/.exec(html);
  if (!m) throw new Error("no csrf field");
  return m[1]!.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export function form(data: Record<string, string | string[]>): URLSearchParams {
  const f = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
}

/** Sign in to the UI with a token and return the cookie header. */
export async function signIn(token: string): Promise<string> {
  const page = await call("/login");
  let cookie = cookiesFrom(page);
  const csrf = csrfFrom(await page.text());
  const res = await call("/login", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
    body: form({ csrf, token }),
    redirect: "manual",
  });
  if (res.status !== 303) throw new Error(`sign in failed: ${res.status} ${await res.text()}`);
  cookie = cookiesFrom(res, cookie);
  return cookie;
}

/** Streamable HTTP JSON-RPC call to /mcp. `modern` adds the 2026-07-28 envelope. */
export async function mcp(
  token: string | null,
  method: string,
  params: Record<string, unknown> = {},
  opts: { modern?: boolean; id?: number; query?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any; res: Response }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...opts.headers,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  let p = params;
  if (opts.modern) {
    headers["MCP-Protocol-Version"] = "2026-07-28";
    headers["Mcp-Method"] = method;
    if (typeof params.name === "string") headers["Mcp-Name"] = params.name;
    p = {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "edge-test", version: "1.0.0" },
      },
    };
  }
  const res = await call(`/mcp${opts.query ?? ""}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: opts.id ?? 1, method, params: p }),
  });
  const text = await res.text();
  let body: any = text;
  const ct = res.headers.get("Content-Type") ?? "";
  if (ct.includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    body = data.length ? JSON.parse(data[data.length - 1]!) : null;
  } else if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
  }
  return { status: res.status, body, res };
}

/** Parse the JSON text content of a tool result. */
export function toolJson(result: any): any {
  const text = result?.content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : undefined;
}
