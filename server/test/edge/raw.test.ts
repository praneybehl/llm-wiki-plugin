import { describe, expect, it } from "vitest";
import { handleApi } from "../../src/http/api";
import { ADMIN, ORIGIN, api, call, env, setupWiki, sha256Hex } from "./helpers";

function put(token: string, path: string, body: string, sha: string | null, type = "text/plain") {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Content-Type": type };
  if (sha) headers["X-Content-SHA256"] = sha;
  return call(`/api/v1/raw/${path}`, { method: "PUT", headers, body });
}

describe("raw files", () => {
  it("stores, reads, ranges and keeps files immutable", async () => {
    const token = await setupWiki("raw-a", ["read", "write", "raw:write"]);
    const text = "0123456789abcdefghij";
    const sha = await sha256Hex(text);

    const created = await put(token, "papers/a%20b.txt", text, sha);
    expect(created.status).toBe(201);
    const entry = (await created.json()) as { path: string; sha256: string; bytes: number };
    expect(entry).toMatchObject({ path: "papers/a b.txt", sha256: sha, bytes: 20 });

    const same = await put(token, "papers/a%20b.txt", text, sha);
    expect(same.status).toBe(200);
    const other = await put(token, "papers/a%20b.txt", "different", await sha256Hex("different"));
    expect(other.status).toBe(409);

    const get = await call("/api/v1/raw/papers/a%20b.txt", { headers: { Authorization: `Bearer ${token}` } });
    expect(get.status).toBe(200);
    expect(get.headers.get("X-Content-SHA256")).toBe(sha);
    expect(get.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await get.text()).toBe(text);

    const range = await call("/api/v1/raw/papers/a%20b.txt", { headers: { Authorization: `Bearer ${token}`, Range: "bytes=2-5" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("Content-Range")).toBe("bytes 2-5/20");
    expect(await range.text()).toBe("2345");

    const suffix = await call("/api/v1/raw/papers/a%20b.txt", { headers: { Authorization: `Bearer ${token}`, Range: "bytes=-3" } });
    expect(suffix.status).toBe(206);
    expect(await suffix.text()).toBe("hij");

    const head = await call("/api/v1/raw/papers/a%20b.txt", { method: "HEAD", headers: { Authorization: `Bearer ${token}` } });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("20");

    const list = await api("/raw?prefix=papers/", { token });
    expect(list.body.map((e: { path: string }) => e.path)).toEqual(["papers/a b.txt"]);

    const missing = await call("/api/v1/raw/nope.txt", { headers: { Authorization: `Bearer ${token}` } });
    expect(missing.status).toBe(404);
  });

  it("validates uploads", async () => {
    const token = await setupWiki("raw-b", ["read", "write", "raw:write"]);
    expect((await put(token, "a.txt", "x", null)).status).toBe(400);
    expect((await put(token, "a.txt", "x", await sha256Hex("y"))).status).toBe(400);
    expect((await put(token, ".secret/a.txt", "x", await sha256Hex("x"))).status).toBe(400);
    expect((await put(token, "a%2F..%2Fb.txt", "x", await sha256Hex("x"))).status).toBe(400);
  });

  it("answers 503 without the RAW binding", async () => {
    await setupWiki("raw-d");
    const noRaw = { ...env, RAW: undefined };
    const r = await handleApi(
      new Request(`${ORIGIN}/api/v1/raw/a.txt?wiki=raw-d`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${ADMIN}`, "X-Content-SHA256": await sha256Hex("x") },
        body: "x",
      }),
      noRaw,
    );
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("unavailable");
  });

  it("needs the raw:write scope to upload", async () => {
    const token = await setupWiki("raw-c", ["read", "write"]);
    const r = await put(token, "a.txt", "x", await sha256Hex("x"));
    expect(r.status).toBe(403);
  });

  /**
   * Simulate a race: the other upload lands in R2 after this upload's
   * preflight `head`, so the preflight sees no object.
   */
  function racedEnv(winnerKey: string, winnerBody: string) {
    const real = env.RAW!;
    let first = true;
    const bucket = {
      head: async (key: string) => {
        if (first && key === winnerKey) {
          first = false;
          await real.put(key, winnerBody, { sha256: await sha256Hex(winnerBody), customMetadata: { uploaded_by: "winner" } });
          return null;
        }
        return real.head(key);
      },
      put: (...args: Parameters<R2Bucket["put"]>) => real.put(...args),
      get: (...args: Parameters<R2Bucket["get"]>) => real.get(...args),
    } as unknown as R2Bucket;
    return { ...env, RAW: bucket };
  }

  function rawPut(wiki: string, path: string, text: string, sha: string) {
    return new Request(`${ORIGIN}/api/v1/raw/${path}?wiki=${wiki}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ADMIN}`, "X-Content-SHA256": sha, "Content-Type": "text/plain" },
      body: text,
    });
  }

  it("never replaces an object that a racing upload created first", async () => {
    await setupWiki("raw-e");
    const r = await handleApi(rawPut("raw-e", "race.txt", "loser", await sha256Hex("loser")), racedEnv("raw-e/raw/race.txt", "winner"));
    expect(r.status).toBe(409);
    const stored = await env.RAW!.get("raw-e/raw/race.txt");
    expect(await stored!.text()).toBe("winner");
    const list = await api("/raw?wiki=raw-e");
    expect(list.body).toEqual([expect.objectContaining({ path: "race.txt", sha256: await sha256Hex("winner"), bytes: 6, uploaded_by: "winner" })]);
  });

  it("answers 200 when a racing upload stored the same bytes first", async () => {
    await setupWiki("raw-f");
    const sha = await sha256Hex("same");
    const r = await handleApi(rawPut("raw-f", "race.txt", "same", sha), racedEnv("raw-f/raw/race.txt", "same"));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ path: "race.txt", sha256: sha, bytes: 4 });
    const list = await api("/raw?wiki=raw-f");
    expect(list.body).toEqual([expect.objectContaining({ path: "race.txt", sha256: sha })]);
  });
});
