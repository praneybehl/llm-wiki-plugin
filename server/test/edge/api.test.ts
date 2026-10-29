import { describe, expect, it } from "vitest";
import { api, call, setupWiki } from "./helpers";
import { SERVER_VERSION } from "../../src/types";

const ACME = `---
type: entity
title: Acme Corp
tags: [company, test]
updated: 2026-10-01
---
# Acme Corp

Acme builds rockets. See [[widget]].

## History

Founded in 1999.
`;

const WIDGET = `---
type: concept
title: Widget
---
# Widget

A widget made by [[acme]].
`;

describe("API round trip", () => {
  it("commits, reads, lists, searches and tracks history", async () => {
    const token = await setupWiki("api-a", ["read", "write"], "writer");
    expect((await call("/healthz").then((r) => r.json())) as unknown).toMatchObject({ ok: true, version: SERVER_VERSION });

    const c1 = await api("/commit", {
      token,
      body: {
        message: "add pages",
        ops: [
          { op: "create", path: "entities/acme.md", content: ACME },
          { op: "create", path: "concepts/widget.md", content: WIDGET },
        ],
        log: "added acme and widget",
      },
    });
    expect(c1.status).toBe(200);
    expect(c1.body.seq).toBeGreaterThan(0);
    const acmeRev = c1.body.changed.find((x: { path: string }) => x.path === "entities/acme.md").rev;

    const page = await api("/page?path=entities/acme.md", { token });
    expect(page.status).toBe(200);
    expect(page.body.content).toBe(ACME);
    expect(page.body.updated_by).toBe("writer");
    expect((await api("/page?path=missing.md", { token })).status).toBe(404);
    expect((await api("/page", { token })).status).toBe(400);

    const section = await api("/page?path=entities/acme.md&heading=History", { token });
    expect(section.body.content).toContain("Founded in 1999");
    expect(section.body.content).not.toContain("rockets");

    const read = await api("/read", { token, body: { paths: ["entities/acme.md", "nope.md"] } });
    expect(read.body.pages).toHaveLength(1);
    expect(read.body.missing).toEqual(["nope.md"]);
    expect((await api("/read", { token, body: { paths: "x" } })).status).toBe(400);

    const pages = await api("/pages?prefix=entities/", { token });
    expect(pages.body.map((e: { path: string }) => e.path)).toEqual(["entities/acme.md"]);

    const search = await api("/search", { token, body: { query: "rockets" } });
    expect(search.status).toBe(200);
    expect(search.body.mode).toBe("lexical");
    expect(search.body.results[0].rel_path).toBe("entities/acme.md");
    expect((await api("/search", { token, body: { query: "" } })).status).toBe(400);

    const back = await api("/backlinks?target=acme", { token });
    expect(back.body.inbound.map((b: { rel_path: string }) => b.rel_path)).toContain("concepts/widget.md");
    expect((await api("/top-linked?n=5", { token })).status).toBe(200);

    // Stale put conflicts with details.
    const stale = await api("/commit", {
      token,
      body: { message: "stale", ops: [{ op: "put", path: "entities/acme.md", content: "x", base_rev: acmeRev + 5 }] },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("conflict");
    expect(stale.body.error.details.reason).toBe("stale_base_rev");

    const edit = await api("/commit", {
      token,
      body: { message: "edit", ops: [{ op: "edit", path: "entities/acme.md", edits: [{ old: "1999", new: "2001" }] }] },
    });
    expect(edit.status).toBe(200);

    const hist = await api("/history?path=entities/acme.md", { token });
    expect(hist.body.length).toBeGreaterThanOrEqual(2);
    const diff = await api(`/diff?path=entities/acme.md&from=${acmeRev}&to=${acmeRev + 1}`, { token });
    expect(diff.status).toBe(200);
    expect(diff.body.diff).toContain("+Founded in 2001.");
    const rev = await api(`/revision?path=entities/acme.md&rev=${acmeRev}`, { token });
    expect(rev.body.content).toBe(ACME);

    const revert = await api("/revert", { token, body: { commit_id: edit.body.commit_id } });
    expect(revert.status).toBe(200);
    expect((await api("/page?path=entities/acme.md", { token })).body.content).toBe(ACME);

    const changes = await api("/changes?since=0&limit=200", { token });
    expect(changes.body.changes.length).toBeGreaterThan(0);
    expect((await api("/changes?limit=500", { token })).status).toBe(400);

    const manifest = await api("/manifest", { token });
    expect(Object.keys(manifest.body.pages)).toContain("entities/acme.md");

    for (const path of ["/overview", "/stats", "/settings", "/review?status=open"]) {
      const r = await api(path, { token });
      expect(r.status, path).toBe(200);
    }
    expect((await api("/lint", { token, body: {} })).status).toBe(200);
    expect((await api("/graph", { token, body: { op: "edges" } })).status).toBe(200);
    expect((await api("/graph", { token, body: {} })).status).toBe(400);
    expect((await api("/nope", { token })).status).toBe(404);
  });

  it("streams an NDJSON export", async () => {
    const token = await setupWiki("api-b");
    await api("/commit", {
      token,
      body: { message: "m", ops: [{ op: "create", path: "a.md", content: "# A\n" }, { op: "create", path: "b.md", content: "# B\n" }] },
    });
    const res = await call("/api/v1/export", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.headers.get("Content-Type")).toContain("application/x-ndjson");
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    const done = lines.at(-1);
    expect(done.done).toBe(true);
    expect(typeof done.seq).toBe("number");
    expect(lines.slice(0, -1).map((p: { path: string }) => p.path).sort()).toEqual(["a.md", "b.md"]);
  });

  it("rejects bad JSON and oversized bodies", async () => {
    const token = await setupWiki("api-c");
    const bad = await call("/api/v1/commit", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(bad.status).toBe(400);
    const big = await call("/api/v1/commit", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "x", ops: [{ op: "create", path: "big.md", content: "a".repeat(6 * 1024 * 1024) }] }),
    });
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: { code: string } }).error.code).toBe("too_large");
  });

  it("patches settings as admin and resolves review flags as writer", async () => {
    const token = await setupWiki("api-d");
    const patched = await api("/settings?wiki=api-d", { method: "PATCH", body: { decisions: { search_gate: true } } });
    expect(patched.status).toBe(200);
    expect(patched.body.decisions.search_gate).toBe(true);
    const missing = await api("/review/does-not-exist", { token, body: { status: "accepted" } });
    expect(missing.status).toBe(404);
    expect((await api("/review/x", { token, body: { status: "maybe" } })).status).toBe(400);
    const decide = await api("/decide", { token, body: { state: "x", questions: {} } });
    expect(decide.status).toBe(403);
  });

  it("creates pairing codes", async () => {
    await setupWiki("api-e");
    const r = await api("/admin/pairing-codes", { body: { wiki: "api-e", label: "laptop", scopes: ["read", "write"] } });
    expect(r.status).toBe(201);
    expect(typeof r.body.code).toBe("string");
    expect(Date.parse(r.body.expires_at)).toBeGreaterThan(Date.now());
    const wikis = await api("/admin/wikis");
    expect(wikis.body.map((w: { id: string }) => w.id)).toContain("api-e");
  });
});
