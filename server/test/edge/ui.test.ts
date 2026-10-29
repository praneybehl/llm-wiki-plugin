import { describe, expect, it } from "vitest";
import { renderPage } from "../../src/ui/markdown";
import { ADMIN, ORIGIN, api, call, cookiesFrom, csrfFrom, form, setupWiki, signIn } from "./helpers";

function get(path: string, cookie = "") {
  return call(path, { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" });
}

function post(path: string, cookie: string, fields: Record<string, string | string[]>) {
  return call(path, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
    body: form(fields),
    redirect: "manual",
  });
}

describe("UI", () => {
  it("renders the landing page with a strict CSP", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(await res.text()).toContain(`${ORIGIN}/mcp`);
  });

  it("lets browsers send the Origin header on same-origin form posts", async () => {
    // With "no-referrer", browsers send `Origin: null` on form POSTs and the
    // CSRF origin check rejects every sign-in.
    const res = await get("/login");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(await res.text()).toContain('<meta name="referrer" content="same-origin">');
  });

  it("runs first-run setup, shows the token once and lists snippets", async () => {
    const cookie = await signIn(ADMIN);
    const setup = await get("/setup", cookie);
    const html = await setup.text();
    expect(setup.status).toBe(200);
    expect(html).toContain("Create wiki main and a first token");
    const res = await post("/setup", cookie, { csrf: csrfFrom(html), action: "first_run" });
    const out = await res.text();
    expect(res.status).toBe(200);
    const token = /lw_main_[A-Za-z0-9_-]+/.exec(out)![0];
    expect((await api("/whoami", { token })).body.wiki).toBe("main");
    for (const client of ["Claude Code", "Codex", "Cursor", "Gemini CLI", "OpenCode", "omp / Pi", "Generic MCP client"]) {
      expect(out).toContain(client);
    }
    expect(out).toContain("bearer_token_env_var = &#34;LLM_WIKI_TOKEN&#34;");
    // The token list never shows the secret again.
    const again = await (await get("/setup?wiki=main", cookie)).text();
    expect(again).not.toContain(token);
  });

  it("redirects to sign-in and rejects bad tokens", async () => {
    const res = await get("/setup");
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/login?next=%2Fsetup");
    const page = await get("/login");
    const cookie = cookiesFrom(page);
    const bad = await post("/login", cookie, { csrf: csrfFrom(await page.text()), token: "wrong" });
    expect(bad.status).toBe(401);
  });

  it("rejects forms without a valid CSRF token", async () => {
    const cookie = await signIn(ADMIN);
    const res = await post("/setup", cookie, { csrf: "forged", action: "create_wiki", id: "ui-forged" });
    expect(res.status).toBe(403);
    const wikis = await api("/admin/wikis");
    expect(wikis.body.map((w: { id: string }) => w.id)).not.toContain("ui-forged");
  });

  it("rejects a tampered session cookie", async () => {
    const cookie = await signIn(ADMIN);
    expect((await get("/setup", cookie)).status).toBe(200);
    const tampered = cookie.replace(/(__Host-lw-session=)([^.;]+)/, (_, k: string, body: string) => {
      const json = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
      json.wiki = "other";
      return k + btoa(JSON.stringify(json)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    });
    expect(tampered).not.toBe(cookie);
    expect((await get("/setup", tampered)).status).toBe(303);
    const sigOnly = cookie.replace(/(__Host-lw-session=[^.;]+\.)([^;]+)/, (_, k: string) => k + "AAAA");
    expect((await get("/setup", sigOnly)).status).toBe(303);
  });

  it("renders pages with escaped HTML, wikilinks, properties and backlinks", async () => {
    const token = await setupWiki("ui-a", ["read", "write"]);
    await api("/commit", {
      token,
      body: {
        message: "seed",
        ops: [
          {
            op: "create",
            path: "entities/acme.md",
            content: "---\ntype: entity\ntags: [a, b]\n---\n# Acme <b>bold</b>\n\n<script>alert(1)</script>\n\nSee [[widget|the widget]] and [x](javascript:alert(1)).\n",
          },
          { op: "create", path: "concepts/widget.md", content: "# Widget\n\nMade by [[acme]].\n" },
        ],
      },
    });
    const cookie = await signIn(token);
    const index = await (await get("/ui/ui-a/", cookie)).text();
    expect(index).toContain("entities/");
    expect(index).toContain("acme.md");

    const res = await get("/ui/ui-a/page?path=entities/acme.md", cookie);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&#60;script&#62;");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="/ui/ui-a/go?slug=widget"');
    expect(html).toContain(">entity<");
    expect(html).toContain("concepts%2Fwidget.md");

    const go = await get("/ui/ui-a/go?slug=widget", cookie);
    expect(go.status).toBe(303);
    expect(go.headers.get("Location")).toBe("/ui/ui-a/page?path=concepts%2Fwidget.md");

    const search = await (await get("/ui/ui-a/?q=widget", cookie)).text();
    expect(search).toContain("concepts/widget.md");
    expect((await get("/ui/ui-a/history", cookie)).status).toBe(200);
    expect((await get("/ui/ui-a/history?path=entities/acme.md", cookie)).status).toBe(200);
    expect((await get("/ui/ui-a/review", cookie)).status).toBe(200);

    // A wiki token session cannot open another wiki.
    await setupWiki("ui-b");
    expect((await get("/ui/ui-b/", cookie)).status).toBe(403);
  });

  it("ends a token session after revocation", async () => {
    const token = await setupWiki("ui-c", ["read"], "viewer");
    const cookie = await signIn(token);
    expect((await get("/ui/ui-c/", cookie)).status).toBe(200);
    const id = (await api("/admin/tokens?wiki=ui-c")).body.find((t: { label: string }) => t.label === "viewer").id;
    await api(`/admin/tokens/${id}?wiki=ui-c`, { method: "DELETE" });
    expect((await get("/ui/ui-c/", cookie)).status).toBe(303);
  });

  it("escapes markdown edge cases", () => {
    const r = renderPage("w", "notes/a.md", "# T\n\n[rel](../entities/b.md) [[x|<i>y</i>]] ![i](javascript:x)\n");
    expect(r.html).toContain('href="/ui/w/page?path=entities%2Fb.md"');
    expect(r.html).toContain("&#60;i&#62;y&#60;/i&#62;");
    expect(r.html).not.toContain("javascript:");
    expect(r.outline).toEqual([{ depth: 1, text: "T", id: "t" }]);
  });
});
