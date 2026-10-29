import type { Env } from "../env";
import { createWiki, PAIRING_TTL_SECONDS } from "../http/api";
import {
  ALL_SCOPES,
  hasScope,
  isAdminToken,
  isWikiId,
  principalFromBearer,
  principalFromSession,
  registryStub,
  wikiStub,
} from "../http/auth";
import { HttpError, escapeHtml as esc, readForm, unwrap } from "../http/util";
import type { DecisionBackend, ListEntry, Principal, Scope, SearchRow, TokenInfo, WikiSettings } from "../types";
import { csrfField, htmlPage, redirect, type PageOptions } from "./layout";
import { renderPage } from "./markdown";
import { checkCsrf, clearSessionCookie, csrfFor, readSession, sessionCookie, type CsrfState } from "./session";
import { mcpSnippets, TOKEN_ENV } from "./snippets";

const BACKENDS: DecisionBackend[] = ["workers-ai", "typesafe", "openrouter", "liquid"];

interface Ctx {
  request: Request;
  env: Env;
  url: URL;
  csrf: CsrfState | null;
}

/** Render a page and attach the CSRF cookie when it is new. */
function page(c: Ctx, o: PageOptions): Response {
  const headers = new Headers(o.headers);
  if (c.csrf?.setCookie) headers.append("Set-Cookie", c.csrf.setCookie);
  return htmlPage({ ...o, headers, ...(c.csrf ? { csrf: c.csrf.token } : {}) });
}

function messagePage(c: Ctx, status: number, title: string, text: string, signedIn = false): Response {
  return page(c, { title, status, signedIn, body: `<h1>${esc(title)}</h1><p class="error" role="alert">${esc(text)}</p>` });
}

function fmtDate(v: string | null | undefined): string {
  return v ? esc(v.replace("T", " ").replace(/\.\d+Z$/, "Z")) : '<span class="muted">never</span>';
}

function safeNext(next: string | null): string | null {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : null;
}

/** Handle UI routes. Returns null when the path is not a UI path. */
export async function handleUi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const isUi = path === "/" || path === "/login" || path === "/logout" || path === "/setup" || path.startsWith("/ui/");
  if (!isUi) return null;
  const c: Ctx = { request, env, url, csrf: await csrfFor(request, env) };
  try {
    if (request.method === "POST") {
      const form = await readForm(request);
      if (!(await checkCsrf(request, env, stringField(form, "csrf")))) {
        return messagePage(c, 403, "Form expired", "The form token is not valid. Reload the page and try again.");
      }
      if (path === "/login") return await loginPost(c, form);
      if (path === "/logout") return redirect("/", { "Set-Cookie": clearSessionCookie() });
      if (path === "/setup") return await setupPost(c, form);
      const m = /^\/ui\/([^/]+)\/review$/.exec(path);
      if (m) return await reviewPost(c, m[1]!, form);
      return messagePage(c, 405, "Not allowed", "This page does not accept forms.");
    }
    if (request.method !== "GET" && request.method !== "HEAD") return messagePage(c, 405, "Not allowed", "Use GET.");
    if (path === "/") return await landing(c);
    if (path === "/login") return loginForm(c, null, 200);
    if (path === "/logout") return redirect("/");
    if (path === "/setup") return await setupGet(c);
    if (/^\/ui\/[a-z0-9][a-z0-9-]{0,62}$/.test(path)) return redirect(`${path}/`);
    const m = /^\/ui\/([^/]+)\/(page|go|history|diff|review)?$/.exec(path);
    if (!m) return messagePage(c, 404, "Not found", "No page at this address.");
    return await wikiPage(c, m[1]!, m[2] ?? "index");
  } catch (e) {
    if (e instanceof HttpError) return messagePage(c, e.status, "Request failed", e.message);
    throw e;
  }
}

function stringField(form: FormData, name: string): string | null {
  const v = form.get(name);
  return typeof v === "string" ? v : null;
}

// ---------------------------------------------------------------------------
// Landing and sign-in
// ---------------------------------------------------------------------------

async function landing(c: Ctx): Promise<Response> {
  const s = await readSession(c.request, c.env);
  const origin = c.url.origin;
  const open = s ? `<p><a href="/ui/${esc(s.wiki)}/">Open wiki ${esc(s.wiki)}</a></p>` : "";
  return page(c, {
    title: "Home",
    signedIn: !!s,
    body: `<h1>LLM Wiki</h1>
<p>This server keeps a Markdown wiki that AI agents read and maintain.</p>
${open}
<div class="card">
<h2>Connect</h2>
<p>MCP endpoint: <code>${esc(origin)}/mcp</code></p>
<p>JSON API: <code>${esc(origin)}/api/v1</code></p>
<p>Go to <a href="/setup">Setup</a> to create wikis, tokens and agent configuration.</p>
</div>`,
  });
}

function loginForm(c: Ctx, error: string | null, status: number): Response {
  if (!c.env.ADMIN_TOKEN) return noAdminSecret(c);
  const next = safeNext(c.url.searchParams.get("next")) ?? "";
  return page(c, {
    title: "Sign in",
    status,
    body: `<h1>Sign in</h1>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/login${next ? `?next=${encodeURIComponent(next)}` : ""}" class="card">
${csrfField(c.csrf!.token)}
<label for="token">Admin token or wiki token</label>
<input id="token" name="token" type="password" autocomplete="current-password" required>
<p class="muted">The admin token is the ADMIN_TOKEN secret of this Worker. A wiki token needs the read scope.</p>
<button type="submit">Sign in</button>
</form>`,
  });
}

function noAdminSecret(c: Ctx): Response {
  return page(c, {
    title: "Setup",
    status: 503,
    body: `<h1>Set the ADMIN_TOKEN secret</h1>
<p class="notice">This Worker has no ADMIN_TOKEN secret. Sign-in and setup are not available.</p>
<p>Run this command in the server folder, then reload this page:</p>
<pre><code>npx wrangler secret put ADMIN_TOKEN</code></pre>`,
  });
}

async function loginPost(c: Ctx, form: FormData): Promise<Response> {
  const token = (stringField(form, "token") ?? "").trim();
  const next = safeNext(c.url.searchParams.get("next"));
  if (token && (await isAdminToken(c.env, token))) {
    const wikis = await registryStub(c.env).listWikis();
    const wiki = wikis[0]?.id ?? "main";
    const cookie = await sessionCookie(c.env, { wiki, label: "admin", scopes: ["admin"], admin: true });
    return redirect(next ?? "/setup", cookie ? { "Set-Cookie": cookie } : undefined);
  }
  const p = token.startsWith("lw_") ? await principalFromBearer(c.env, token, c.request) : null;
  if (p && hasScope(p, "read")) {
    const cookie = await sessionCookie(c.env, { wiki: p.wiki, label: p.label, scopes: p.scopes, admin: false, tid: p.tokenId! });
    return redirect(next ?? `/ui/${p.wiki}/`, cookie ? { "Set-Cookie": cookie } : undefined);
  }
  return loginForm(c, "The token is not valid, was revoked, or lacks the read scope.", 401);
}

// ---------------------------------------------------------------------------
// Setup (deployment admin)
// ---------------------------------------------------------------------------

async function requireAdminSession(c: Ctx): Promise<Principal | Response> {
  if (!c.env.ADMIN_TOKEN) return noAdminSecret(c);
  const s = await readSession(c.request, c.env);
  if (!s || !s.admin) return redirect(`/login?next=${encodeURIComponent(c.url.pathname + c.url.search)}`);
  return { wiki: s.wiki, label: "admin", scopes: ["admin"], deploymentAdmin: true };
}

async function setupGet(c: Ctx, flash = "", status = 200, selected?: string): Promise<Response> {
  const admin = await requireAdminSession(c);
  if (admin instanceof Response) return admin;
  const wikis = await registryStub(c.env).listWikis();
  const csrf = csrfField(c.csrf!.token);
  const origin = c.url.origin;
  let body = `<h1>Setup</h1>${flash}`;

  if (wikis.length === 0) {
    body += `<div class="card">
<h2>First run</h2>
<p>This deployment has no wiki yet. Create the <code>main</code> wiki and a first agent token.</p>
<form method="post" action="/setup">${csrf}<input type="hidden" name="action" value="first_run">
<button type="submit">Create wiki main and a first token</button></form>
</div>`;
  } else {
    const q = selected ?? c.url.searchParams.get("wiki");
    const wiki = wikis.find((w) => w.id === q)?.id ?? wikis[0]!.id;
    const stub = wikiStub(c.env, wiki);
    const [tokens, settings] = await Promise.all([stub.listTokens(), stub.getSettings()]);
    body += wikisCard(wikis, wiki, csrf);
    body += tokensCard(wiki, tokens as TokenInfo[], csrf);
    body += pairingCard(wiki, csrf);
    body += settingsCard(c.env, wiki, settings as WikiSettings, csrf);
  }
  body += `<h2 id="connect">Connect an agent</h2>
<p>Put the token in the <code>${TOKEN_ENV}</code> environment variable. Then add one of these configurations.</p>`;
  for (const s of mcpSnippets(origin)) {
    body += `<div class="card"><h3>${esc(s.client)}</h3><p class="muted">${esc(s.where)}</p><pre><code>${esc(s.code)}</code></pre></div>`;
  }
  body += `<div class="card"><h3>Command line (migration and mirror)</h3>
<pre><code>${esc(`python3 skills/llm-wiki/scripts/wiki_remote.py login --url ${origin} --token "$${TOKEN_ENV}"\npython3 skills/llm-wiki/scripts/wiki_remote.py import ~/wiki --dry-run`)}</code></pre></div>`;
  return page(c, { title: "Setup", body, status, signedIn: true });
}

function wikisCard(wikis: { id: string; created_at: string; created_by: string }[], selected: string, csrf: string): string {
  const rows = wikis
    .map(
      (w) =>
        `<tr><td>${w.id === selected ? `<strong>${esc(w.id)}</strong>` : `<a href="/setup?wiki=${esc(w.id)}">${esc(w.id)}</a>`}</td><td>${fmtDate(w.created_at)}</td><td>${esc(w.created_by)}</td><td><a href="/ui/${esc(w.id)}/">Open</a></td></tr>`,
    )
    .join("");
  return `<div class="card"><h2>Wikis</h2>
<table><thead><tr><th scope="col">Id</th><th scope="col">Created</th><th scope="col">By</th><th scope="col"><span class="muted">Link</span></th></tr></thead><tbody>${rows}</tbody></table>
<form method="post" action="/setup" class="row">${csrf}<input type="hidden" name="action" value="create_wiki">
<div><label for="wiki-id">New wiki id</label><input id="wiki-id" name="id" type="text" pattern="[a-z0-9][a-z0-9-]{0,62}" required></div>
<button type="submit">Create wiki</button></form>
<p class="muted">Ids use lowercase letters, digits and hyphens. Settings below apply to wiki <strong>${esc(selected)}</strong>.</p></div>`;
}

function scopeBoxes(prefix: string, checked: Scope[]): string {
  return ALL_SCOPES.map(
    (s) =>
      `<label class="inline"><input type="checkbox" name="scopes" value="${s}" id="${prefix}-${s.replace(":", "-")}"${checked.includes(s) ? " checked" : ""}> ${s}</label>`,
  ).join("");
}

function tokensCard(wiki: string, tokens: TokenInfo[], csrf: string): string {
  const rows = tokens
    .map((t) => {
      const status = t.revoked_at ? `revoked ${fmtDate(t.revoked_at)}` : "active";
      const revoke = t.revoked_at
        ? ""
        : `<form method="post" action="/setup">${csrf}<input type="hidden" name="action" value="revoke_token"><input type="hidden" name="wiki" value="${esc(wiki)}"><input type="hidden" name="token_id" value="${esc(t.id)}"><button class="danger" type="submit" aria-label="Revoke token ${esc(t.label)}">Revoke</button></form>`;
      return `<tr><td>${esc(t.label)}</td><td>${esc(t.scopes.join(", "))}</td><td>${fmtDate(t.created_at)}</td><td>${fmtDate(t.last_used_at)}</td><td>${status}</td><td>${revoke}</td></tr>`;
    })
    .join("");
  return `<div class="card"><h2>Tokens for ${esc(wiki)}</h2>
${tokens.length ? `<table><thead><tr><th scope="col">Label</th><th scope="col">Scopes</th><th scope="col">Created</th><th scope="col">Last used</th><th scope="col">Status</th><th scope="col"><span class="muted">Action</span></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No tokens yet.</p>'}
<form method="post" action="/setup">${csrf}<input type="hidden" name="action" value="create_token"><input type="hidden" name="wiki" value="${esc(wiki)}">
<label for="token-label">Label (for example the agent name)</label><input id="token-label" name="label" type="text" maxlength="100" required>
<fieldset><legend>Scopes</legend>${scopeBoxes("tok", ["read", "write"])}</fieldset>
<p><button type="submit">Create token</button></p></form></div>`;
}

function pairingCard(wiki: string, csrf: string): string {
  return `<div class="card"><h2>Pairing code</h2>
<p>A pairing code lets an OAuth client connect to wiki <strong>${esc(wiki)}</strong> without the admin token. It works once, for 10 minutes.</p>
<form method="post" action="/setup">${csrf}<input type="hidden" name="action" value="pairing_code"><input type="hidden" name="wiki" value="${esc(wiki)}">
<label for="pair-label">Label</label><input id="pair-label" name="label" type="text" maxlength="100" required>
<fieldset><legend>Access</legend>
<label class="inline"><input type="radio" name="access" value="read"> Read</label>
<label class="inline"><input type="radio" name="access" value="write" checked> Read and write</label></fieldset>
<p><button type="submit">Create pairing code</button></p></form></div>`;
}

function settingsCard(env: Env, wiki: string, settings: WikiSettings, csrf: string): string {
  const d = settings.decisions;
  const keys: Record<DecisionBackend, boolean> = {
    "workers-ai": !!env.AI,
    typesafe: !!env.TYPESAFE_API_KEY,
    openrouter: !!env.OPENROUTER_API_KEY,
    liquid: !!env.LIQUID_API_KEY,
  };
  const options = BACKENDS.map(
    (b) => `<option value="${b}"${d.backend === b ? " selected" : ""}>${b}${keys[b] ? "" : " (not configured)"}</option>`,
  ).join("");
  const box = (name: string, label: string, on: boolean) =>
    `<label class="inline"><input type="checkbox" name="${name}" value="1"${on ? " checked" : ""}> ${label}</label>`;
  return `<div class="card"><h2>Decision models for ${esc(wiki)}</h2>
<p class="notice">Decision models are optional and off by default. A hosted backend receives page text and search queries. Turn it on only if you accept this.</p>
<form method="post" action="/setup">${csrf}<input type="hidden" name="action" value="settings"><input type="hidden" name="wiki" value="${esc(wiki)}">
<p>${box("enabled", "Enabled", d.enabled)}${box("search_gate", "Gate every search", d.search_gate)}${box("screen_writes", "Screen new source pages", d.screen_writes)}</p>
<div class="row">
<div><label for="d-backend">Backend</label><select id="d-backend" name="backend">${options}</select></div>
<div><label for="d-model">Model</label><input id="d-model" name="model" type="text" value="${esc(d.model)}" required></div>
</div>
<div class="row">
<div><label for="d-rel">Relevance threshold</label><input id="d-rel" name="relevance_threshold" type="number" min="0" max="1" step="0.01" value="${d.relevance_threshold}"></div>
<div><label for="d-scr">Screen threshold</label><input id="d-scr" name="screen_threshold" type="number" min="0" max="1" step="0.01" value="${d.screen_threshold}"></div>
<div><label for="d-to">Timeout (ms)</label><input id="d-to" name="timeout_ms" type="number" min="100" max="60000" step="100" value="${d.timeout_ms}"></div>
</div>
<p><button type="submit">Save settings</button></p></form></div>`;
}

function accessScopes(access: string | null): Scope[] {
  return access === "read" ? ["read"] : ["read", "write"];
}

function tokenReveal(token: string, wiki: string, label: string): string {
  return `<div class="success" role="status"><p>Token <strong>${esc(label)}</strong> for wiki <strong>${esc(wiki)}</strong> was created. Copy it now. The server does not show it again.</p>
<code class="token">${esc(token)}</code>
<pre><code>${esc(`export ${TOKEN_ENV}=${token}`)}</code></pre></div>`;
}

async function setupPost(c: Ctx, form: FormData): Promise<Response> {
  const admin = await requireAdminSession(c);
  if (admin instanceof Response) return admin;
  const action = stringField(form, "action");
  const wikiField = stringField(form, "wiki");
  const ok = (html: string, wiki?: string) => setupGet(c, html, 200, wiki);
  const bad = (msg: string, wiki?: string) => setupGet(c, `<p class="error" role="alert">${esc(msg)}</p>`, 400, wiki);

  if (action === "first_run") {
    unwrap(await createWiki(c.env, "main", "admin"));
    const { token } = await wikiStub(c.env, "main").createToken("first-agent", ["read", "write", "raw:write"]);
    return ok(tokenReveal(token, "main", "first-agent"), "main");
  }
  if (action === "create_wiki") {
    const id = (stringField(form, "id") ?? "").trim();
    if (!isWikiId(id)) return bad("The wiki id must match ^[a-z0-9][a-z0-9-]{0,62}$.");
    const { created } = unwrap(await createWiki(c.env, id, "admin"));
    return ok(`<p class="success" role="status">Wiki ${esc(id)} ${created ? "was created" : "already exists"}.</p>`, id);
  }
  if (!isWikiId(wikiField) || !(await registryStub(c.env).hasWiki(wikiField))) return bad("Select an existing wiki.");
  const stub = wikiStub(c.env, wikiField);
  if (action === "create_token") {
    const label = (stringField(form, "label") ?? "").trim();
    const scopes = form.getAll("scopes").filter((s): s is Scope => (ALL_SCOPES as readonly unknown[]).includes(s));
    if (!label || label.length > 100) return bad("Give a label of 1 to 100 characters.", wikiField);
    if (scopes.length === 0) return bad("Select at least one scope.", wikiField);
    const { token } = await stub.createToken(label, scopes);
    return ok(tokenReveal(token, wikiField, label), wikiField);
  }
  if (action === "revoke_token") {
    const id = stringField(form, "token_id") ?? "";
    const done = await stub.revokeToken(id);
    return done ? ok('<p class="success" role="status">The token was revoked.</p>', wikiField) : bad("No active token with this id.", wikiField);
  }
  if (action === "pairing_code") {
    const label = (stringField(form, "label") ?? "").trim();
    if (!label || label.length > 100) return bad("Give a label of 1 to 100 characters.", wikiField);
    const { code, expires_at } = await stub.createPairingCode(label, accessScopes(stringField(form, "access")), PAIRING_TTL_SECONDS);
    return ok(
      `<div class="success" role="status"><p>Pairing code for wiki <strong>${esc(wikiField)}</strong>. Enter it on the authorization page before ${fmtDate(expires_at)}.</p><code class="token">${esc(code)}</code></div>`,
      wikiField,
    );
  }
  if (action === "settings") {
    const backend = stringField(form, "backend") as DecisionBackend;
    if (!BACKENDS.includes(backend)) return bad("Select a valid backend.", wikiField);
    const num = (name: string) => Number(stringField(form, name));
    const patch = {
      enabled: form.get("enabled") === "1",
      search_gate: form.get("search_gate") === "1",
      screen_writes: form.get("screen_writes") === "1",
      backend,
      model: (stringField(form, "model") ?? "").trim(),
      relevance_threshold: num("relevance_threshold"),
      screen_threshold: num("screen_threshold"),
      timeout_ms: num("timeout_ms"),
    };
    if (!patch.model) return bad("Give a model id.", wikiField);
    for (const k of ["relevance_threshold", "screen_threshold"] as const) {
      if (!(patch[k] >= 0 && patch[k] <= 1)) return bad(`${k} must be between 0 and 1.`, wikiField);
    }
    if (!(patch.timeout_ms >= 100 && patch.timeout_ms <= 60000)) return bad("timeout_ms must be between 100 and 60000.", wikiField);
    try {
      await stub.updateSettings({ decisions: patch });
    } catch (e) {
      return bad(e instanceof Error ? e.message : "Settings are not valid.", wikiField);
    }
    return ok('<p class="success" role="status">Settings were saved.</p>', wikiField);
  }
  return bad("Unknown action.");
}

// ---------------------------------------------------------------------------
// Wiki browser
// ---------------------------------------------------------------------------

async function wikiPrincipal(c: Ctx, wiki: string): Promise<Principal | Response> {
  if (!isWikiId(wiki)) return messagePage(c, 404, "Not found", "The wiki id is not valid.");
  const p = await principalFromSession(c.env, c.request, wiki);
  if (!p) {
    const s = await readSession(c.request, c.env);
    if (s && !s.admin && s.wiki !== wiki) return messagePage(c, 403, "No access", "Your token is for another wiki.", true);
    return redirect(`/login?next=${encodeURIComponent(c.url.pathname + c.url.search)}`);
  }
  if (!hasScope(p, "read")) return messagePage(c, 403, "No access", "Your token lacks the read scope.", true);
  if (p.deploymentAdmin && !(await registryStub(c.env).hasWiki(wiki))) {
    return messagePage(c, 404, "Not found", `Wiki ${wiki} does not exist. Create it on the setup page.`, true);
  }
  return p;
}

async function wikiPage(c: Ctx, wiki: string, view: string): Promise<Response> {
  const p = await wikiPrincipal(c, wiki);
  if (p instanceof Response) return p;
  const stub = wikiStub(c.env, wiki);
  const base = { wiki, signedIn: true } as const;
  const q = c.url.searchParams;

  if (view === "index") {
    const query = (q.get("q") ?? "").trim();
    const form = `<form method="get" action="/ui/${esc(wiki)}/" role="search" class="row"><div><label for="q">Search</label><input id="q" name="q" type="search" value="${esc(query)}"></div><button type="submit">Search</button></form>`;
    if (query) {
      const res = unwrap(await stub.search({ query, top: 20 }));
      const rows = (res.results as SearchRow[])
        .map(
          (r) =>
            `<li><a href="/ui/${esc(wiki)}/page?path=${encodeURIComponent(r.rel_path)}">${esc(r.title)}</a> <span class="muted">${esc(r.rel_path)}${r.heading_path.length ? " › " + esc(r.heading_path.join(" › ")) : ""}</span><br>${esc(r.snippet)}</li>`,
        )
        .join("");
      return page(c, {
        ...base,
        title: `Search: ${query}`,
        body: `<h1>Search</h1>${form}<p class="muted">Mode: ${esc(res.mode)}. ${res.results.length} results.</p><ol>${rows}</ol>`,
      });
    }
    const [overview, entries] = await Promise.all([stub.overview(), stub.list({ prefix: "" })]);
    return page(c, {
      ...base,
      title: wiki,
      body: `<h1>Wiki ${esc(wiki)}</h1>${form}
<p class="muted">${overview.pages} pages, ${overview.sections} sections, search mode ${overview.vectors_enabled ? "hybrid" : "lexical"}${overview.open_review_flags ? `, <a href="/ui/${esc(wiki)}/review">${overview.open_review_flags} open review flags</a>` : ""}.</p>
<nav class="tree" aria-label="Pages">${renderTree(wiki, entries as ListEntry[])}</nav>`,
    });
  }

  if (view === "page") {
    const path = q.get("path") ?? "";
    if (!path) return messagePage(c, 400, "Missing path", "Give a page path.", true);
    const res = await stub.read({ paths: [path] });
    const pg = res.pages[0];
    if (!pg) return messagePage(c, 404, "Page not found", `No page at ${path}.`, true);
    const slug = path.split("/").pop()!.replace(/\.md$/, "");
    const [rendered, links] = [renderPage(wiki, path, pg.content), await stub.backlinks(slug)];
    const props = Object.entries(rendered.frontmatter)
      .map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(Array.isArray(v) ? v.join(", ") : v)}</td></tr>`)
      .join("");
    const outline = rendered.outline
      .map((h) => `<li class="d${h.depth}"><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`)
      .join("");
    const back = links.inbound
      .map((b) => `<li><a href="/ui/${esc(wiki)}/page?path=${encodeURIComponent(b.rel_path)}">${esc(b.title || b.slug)}</a></li>`)
      .join("");
    return page(c, {
      ...base,
      title: path,
      body: `<p class="muted">${esc(path)} · rev ${pg.rev} · updated ${fmtDate(pg.updated_at)} by ${esc(pg.updated_by)} · <a href="/ui/${esc(wiki)}/history?path=${encodeURIComponent(path)}">History</a></p>
<div class="layout"><article class="page">
${props ? `<table aria-label="Properties"><tbody>${props}</tbody></table>` : ""}
${rendered.html}
</article>
<aside>${outline ? `<nav aria-label="Outline"><h2>Outline</h2><ul>${outline}</ul></nav>` : ""}
<nav aria-label="Backlinks"><h2>Backlinks</h2>${back ? `<ul>${back}</ul>` : '<p class="muted">No pages link here.</p>'}</nav></aside></div>`,
    });
  }

  if (view === "go") {
    const slug = (q.get("slug") ?? "").trim().replace(/\.md$/, "").toLowerCase();
    const entries = (await stub.list({ prefix: "" })) as ListEntry[];
    const hit =
      entries.find((e) => e.path.toLowerCase() === `${slug}.md`) ??
      entries.find((e) => e.path.split("/").pop()!.replace(/\.md$/, "").toLowerCase() === slug);
    if (!hit) return messagePage(c, 404, "Page not found", `No page matches [[${slug}]].`, true);
    return redirect(`/ui/${wiki}/page?path=${encodeURIComponent(hit.path)}`);
  }

  if (view === "history") {
    const path = q.get("path") ?? undefined;
    const before = q.get("before_seq");
    const commits = await stub.history({
      ...(path ? { path } : {}),
      limit: 50,
      ...(before && /^\d+$/.test(before) ? { before_seq: Number(before) } : {}),
    });
    const rows = commits
      .map(
        (cm) =>
          `<tr><td>${cm.seq}</td><td>${fmtDate(cm.created_at)}</td><td>${esc(cm.author)}</td><td>${esc(cm.message)}</td><td>${cm.paths
            .map((pp) => `<a href="/ui/${esc(wiki)}/page?path=${encodeURIComponent(pp)}">${esc(pp)}</a>`)
            .join("<br>")}</td></tr>`,
      )
      .join("");
    let diffForm = "";
    if (path) {
      const cur = (await stub.read({ paths: [path] })).pages[0];
      const to = cur?.rev ?? 1;
      diffForm = `<form method="get" action="/ui/${esc(wiki)}/diff" class="row card"><input type="hidden" name="path" value="${esc(path)}">
<div><label for="from">From rev</label><input id="from" name="from" type="number" min="0" value="${Math.max(0, to - 1)}"></div>
<div><label for="to">To rev</label><input id="to" name="to" type="number" min="0" value="${to}"></div>
<button type="submit">Show diff</button></form>`;
    }
    const last = commits.at(-1);
    const more =
      commits.length === 50 && last
        ? `<p><a href="/ui/${esc(wiki)}/history?${path ? `path=${encodeURIComponent(path)}&amp;` : ""}before_seq=${last.seq}">Older commits</a></p>`
        : "";
    return page(c, {
      ...base,
      title: "History",
      body: `<h1>History${path ? ` of ${esc(path)}` : ""}</h1>${diffForm}
<table><thead><tr><th scope="col">Seq</th><th scope="col">Date</th><th scope="col">Author</th><th scope="col">Message</th><th scope="col">Pages</th></tr></thead><tbody>${rows}</tbody></table>${more}`,
    });
  }

  if (view === "diff") {
    const path = q.get("path") ?? "";
    const from = Number(q.get("from"));
    const to = Number(q.get("to"));
    if (!path || !Number.isInteger(from) || !Number.isInteger(to)) return messagePage(c, 400, "Bad request", "Give path, from and to.", true);
    const { diff } = unwrap(await stub.diff(path, from, to));
    const lines = diff
      .split("\n")
      .map((l) => {
        const cls = l.startsWith("@@") ? "hunk" : l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : "";
        return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
      })
      .join("\n");
    return page(c, {
      ...base,
      title: `Diff ${path}`,
      body: `<h1>Diff of ${esc(path)}</h1><p class="muted">rev ${from} to rev ${to}</p><pre class="diff"><code>${lines || '<span class="muted">No changes.</span>'}</code></pre>`,
    });
  }

  // review
  const flags = await stub.listReview("open");
  const canWrite = hasScope(p, "write");
  const csrf = csrfField(c.csrf!.token);
  const rows = flags
    .map((f) => {
      const actions = canWrite
        ? `<form method="post" action="/ui/${esc(wiki)}/review" class="row">${csrf}<input type="hidden" name="id" value="${esc(f.id)}"><button name="status" value="accepted" type="submit">Accept</button><button class="secondary" name="status" value="dismissed" type="submit">Dismiss</button></form>`
        : "";
      return `<tr><td>${esc(f.kind)}</td><td><a href="/ui/${esc(wiki)}/page?path=${encodeURIComponent(f.path)}">${esc(f.path)}</a></td><td>${esc(f.detail)}</td><td>${f.score === null ? "" : esc(f.score.toFixed(2))}</td><td>${fmtDate(f.created_at)}</td><td>${actions}</td></tr>`;
    })
    .join("");
  return page(c, {
    ...base,
    title: "Review",
    body: `<h1>Open review flags</h1>${
      flags.length
        ? `<table><thead><tr><th scope="col">Kind</th><th scope="col">Page</th><th scope="col">Detail</th><th scope="col">Score</th><th scope="col">Created</th><th scope="col"><span class="muted">Action</span></th></tr></thead><tbody>${rows}</tbody></table>`
        : '<p class="muted">No open review flags.</p>'
    }`,
  });
}

async function reviewPost(c: Ctx, wiki: string, form: FormData): Promise<Response> {
  const p = await wikiPrincipal(c, wiki);
  if (p instanceof Response) return p;
  if (!hasScope(p, "write")) return messagePage(c, 403, "No access", "Your token lacks the write scope.", true);
  const id = stringField(form, "id") ?? "";
  const status = stringField(form, "status");
  if (status !== "accepted" && status !== "dismissed") return messagePage(c, 400, "Bad request", "Pick accept or dismiss.", true);
  unwrap(await wikiStub(c.env, wiki).resolveReview(id, status, p.label));
  return redirect(`/ui/${wiki}/review`);
}

interface TreeNode {
  dirs: Map<string, TreeNode>;
  files: ListEntry[];
}

function renderTree(wiki: string, entries: ListEntry[]): string {
  const root: TreeNode = { dirs: new Map(), files: [] };
  for (const e of entries) {
    const parts = e.path.split("/");
    let node = root;
    for (const dir of parts.slice(0, -1)) {
      let next = node.dirs.get(dir);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(dir, next);
      }
      node = next;
    }
    node.files.push(e);
  }
  const walk = (node: TreeNode, depth: number): string => {
    const dirs = [...node.dirs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, child]) => `<li><details${depth === 0 ? " open" : ""}><summary>${esc(name)}/</summary>${walk(child, depth + 1)}</details></li>`)
      .join("");
    const files = node.files
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => {
        const name = f.path.split("/").pop()!;
        const title = f.title && f.title !== name ? ` <span class="muted">${esc(f.title)}</span>` : "";
        return `<li><a href="/ui/${esc(wiki)}/page?path=${encodeURIComponent(f.path)}">${esc(name)}</a>${title}</li>`;
      })
      .join("");
    return `<ul>${dirs}${files}</ul>`;
  };
  return entries.length ? walk(root, 0) : '<p class="muted">The wiki has no pages yet.</p>';
}
