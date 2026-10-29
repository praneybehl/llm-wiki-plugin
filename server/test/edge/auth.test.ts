import { describe, expect, it } from "vitest";
import { ADMIN, api, call, setupWiki } from "./helpers";

describe("authentication", () => {
  it("rejects requests without credentials", async () => {
    const r = await api("/overview", { token: null });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("unauthorized");
  });

  it("rejects malformed and unknown tokens", async () => {
    await setupWiki("auth-a");
    for (const token of ["nope", "lw_auth-a_" + "x".repeat(43), "lw_BAD_" + "x".repeat(43), ADMIN + "x"]) {
      const r = await api("/whoami", { token });
      expect(r.status, token).toBe(401);
    }
    const basic = await call("/api/v1/whoami", { headers: { Authorization: "Basic abc" } });
    expect(basic.status).toBe(401);
  });

  it("resolves a wiki token and rejects it after revocation", async () => {
    const token = await setupWiki("auth-b", ["read"], "reader");
    const who = await api("/whoami", { token });
    expect(who.status).toBe(200);
    expect(who.body).toEqual({ wiki: "auth-b", label: "reader", scopes: ["read"], admin: false });

    const list = await api("/admin/tokens?wiki=auth-b");
    const id = list.body.find((t: { label: string }) => t.label === "reader").id;
    const del = await api(`/admin/tokens/${id}?wiki=auth-b`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await api("/whoami", { token })).status).toBe(401);
    expect((await api(`/admin/tokens/${id}?wiki=auth-b`, { method: "DELETE" })).status).toBe(404);
  });

  it("denies missing scopes", async () => {
    const reader = await setupWiki("auth-c", ["read"]);
    const commit = await api("/commit", { token: reader, body: { message: "x", ops: [{ op: "create", path: "a.md", content: "# A\n" }] } });
    expect(commit.status).toBe(403);
    expect(commit.body.error.code).toBe("forbidden");
    expect((await api("/settings", { token: reader, method: "PATCH", body: { decisions: { enabled: false } } })).status).toBe(403);
    expect((await api("/admin/tokens", { token: reader, body: { label: "x", scopes: ["read"] } })).status).toBe(403);
    expect((await api("/admin/wikis", { token: reader })).status).toBe(403);
  });

  it("lets a wiki admin manage only its own wiki", async () => {
    const wadmin = await setupWiki("auth-d", ["admin"]);
    await setupWiki("auth-e");
    const own = await api("/admin/tokens", { token: wadmin, body: { label: "bot", scopes: ["read"] } });
    expect(own.status).toBe(201);
    expect(own.body.token).toMatch(/^lw_auth-d_/);
    const other = await api("/admin/tokens", { token: wadmin, body: { wiki: "auth-e", label: "bot", scopes: ["read"] } });
    expect(other.status).toBe(403);
    expect((await api("/admin/wikis", { token: wadmin })).status).toBe(403);
  });

  it("lets the deployment admin select a wiki by header or query", async () => {
    await setupWiki("auth-f");
    const byHeader = await api("/whoami", { headers: { "X-LLM-Wiki": "auth-f" } });
    expect(byHeader.body).toEqual({ wiki: "auth-f", label: "admin", scopes: ["admin"], admin: true });
    const byQuery = await api("/whoami?wiki=auth-f");
    expect(byQuery.body.wiki).toBe("auth-f");
    const dflt = await api("/whoami");
    expect(dflt.body.wiki).toBe("main");
    const bad = await api("/whoami", { headers: { "X-LLM-Wiki": "Bad_Id" } });
    expect(bad.status).toBe(400);
    const missing = await api("/overview", { headers: { "X-LLM-Wiki": "does-not-exist" } });
    expect(missing.status).toBe(404);
  });

  it("validates admin inputs", async () => {
    expect((await api("/admin/wikis", { body: { id: "Not Valid" } })).status).toBe(400);
    await setupWiki("auth-g");
    expect((await api("/admin/tokens", { body: { wiki: "auth-g", label: "", scopes: ["read"] } })).status).toBe(400);
    expect((await api("/admin/tokens", { body: { wiki: "auth-g", label: "x", scopes: ["root"] } })).status).toBe(400);
    expect((await api("/admin/tokens", { body: { wiki: "nope-wiki", label: "x", scopes: ["read"] } })).status).toBe(404);
    const again = await api("/admin/wikis", { body: { id: "auth-g" } });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
  });
});
