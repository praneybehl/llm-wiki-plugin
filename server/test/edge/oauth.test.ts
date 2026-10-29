import { describe, expect, it } from "vitest";
import { ADMIN, ORIGIN, api, call, cookiesFrom, csrfFrom, form, mcp, setupWiki, toolJson } from "./helpers";

const REDIRECT = "https://client.example/cb";

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function register(name: string): Promise<string> {
  const res = await call("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: name, token_endpoint_auth_method: "none" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

interface Started {
  url: string;
  cookie: string;
  html: string;
  verifier: string;
  handle: string;
  csrf: string;
}

async function startAuthorize(clientId: string, scope = "wiki:read wiki:write"): Promise<Started> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope,
    state: "st-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${ORIGIN}/mcp`,
  });
  const url = `/authorize?${q}`;
  const res = await call(url);
  const html = await res.text();
  expect(res.status, html).toBe(200);
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  return { url, cookie: cookiesFrom(res), html, verifier, handle, csrf: csrfFrom(html) };
}

function submit(s: Started, fields: Record<string, string>) {
  return call(s.url, {
    method: "POST",
    headers: { Cookie: s.cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
    body: form({ csrf: s.csrf, handle: s.handle, ...fields }),
    redirect: "manual",
  });
}

async function exchange(clientId: string, location: string, verifier: string): Promise<string> {
  const code = new URL(location).searchParams.get("code")!;
  const res = await call("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${ORIGIN}/mcp` }),
  });
  const body = (await res.json()) as { access_token: string; scope: string };
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body.access_token;
}

describe("OAuth authorize", () => {
  it("shows the consent facts with escaped client data", async () => {
    await setupWiki("oa-a");
    const clientId = await register('<script>alert("x")</script>');
    const s = await startAuthorize(clientId);
    expect(s.html).not.toContain("<script>alert");
    expect(s.html).toContain("&#60;script&#62;");
    expect(s.html).toContain("client.example");
    expect(s.html).toContain("wiki:write");
    expect(s.html).toContain('value="oa-a"');
  });

  it("requires a CSRF token and owner proof, then issues a working token", async () => {
    await setupWiki("oa-b");
    const clientId = await register("Test Agent");
    const s = await startAuthorize(clientId);

    const noCsrf = await call(s.url, {
      method: "POST",
      headers: { Cookie: s.cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ handle: s.handle, decision: "approve", wiki: "oa-b", access: "write", proof: ADMIN }),
      redirect: "manual",
    });
    expect(noCsrf.status).toBe(403);

    const wrong = await submit(s, { decision: "approve", wiki: "oa-b", access: "write", proof: "not-the-token" });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("not valid");

    const ok = await submit(s, { decision: "approve", wiki: "oa-b", access: "write", proof: ADMIN });
    expect(ok.status).toBe(302);
    const location = ok.headers.get("Location")!;
    expect(location.startsWith(REDIRECT)).toBe(true);
    expect(new URL(location).searchParams.get("state")).toBe("st-123");

    const access = await exchange(clientId, location, s.verifier);
    const ov = await mcp(access, "tools/call", { name: "wiki_overview", arguments: {} });
    expect(ov.status, JSON.stringify(ov.body)).toBe(200);
    expect(toolJson(ov.body.result).wiki).toBe("oa-b");
    const commit = await mcp(access, "tools/call", {
      name: "wiki_commit",
      arguments: { message: "oauth", ops: [{ op: "create", path: "o.md", content: "# O\n" }] },
    });
    expect(commit.body.result.isError, JSON.stringify(commit.body)).toBeFalsy();
    const page = await api("/page?path=o.md&wiki=oa-b");
    expect(page.body.updated_by).toBe("oauth:Test Agent");
  });

  it("limits access to the pairing code scopes", async () => {
    await setupWiki("oa-c");
    const code = (await api("/admin/pairing-codes", { body: { wiki: "oa-c", label: "phone", scopes: ["read"] } })).body.code as string;
    const clientId = await register("Reader App");
    const s = await startAuthorize(clientId);
    const ok = await submit(s, { decision: "approve", wiki: "oa-c", access: "write", proof: code });
    expect(ok.status).toBe(302);
    const access = await exchange(clientId, ok.headers.get("Location")!, s.verifier);
    const commit = await mcp(access, "tools/call", {
      name: "wiki_commit",
      arguments: { message: "x", ops: [{ op: "create", path: "x.md", content: "x" }] },
    });
    expect(commit.body.result.isError).toBe(true);
    expect(toolJson(commit.body.result).error.code).toBe("forbidden");

    // A pairing code works once.
    const s2 = await startAuthorize(clientId);
    const again = await submit(s2, { decision: "approve", wiki: "oa-c", access: "read", proof: code });
    expect(again.status).toBe(401);
  });

  it("redirects with access_denied on Deny", async () => {
    await setupWiki("oa-d");
    const clientId = await register("Denied App");
    const s = await startAuthorize(clientId);
    const res = await submit(s, { decision: "deny" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("st-123");
  });

  it("renders invalid requests locally", async () => {
    const res = await call("/authorize?response_type=code&client_id=unknown&redirect_uri=https://evil.example/cb");
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });
});
