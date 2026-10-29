import { describe, expect, it } from "vitest";
import { ADMIN, call, mcp, setupWiki, toolJson } from "./helpers";

async function getJson(path: string) {
  const res = await call(path);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const TOOLS = ["wiki_commit", "wiki_graph", "wiki_history", "wiki_lint", "wiki_overview", "wiki_raw", "wiki_read", "wiki_search"];

describe("MCP", () => {
  it("challenges unauthenticated and invalid requests", async () => {
    const none = await mcp(null, "tools/list");
    expect(none.status).toBe(401);
    expect(none.res.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
    const bad = await mcp("lw_main_" + "x".repeat(43), "tools/list");
    expect(bad.status).toBe(401);
  });

  for (const modern of [false, true]) {
    it(`lists the tools (${modern ? "2026-07-28" : "legacy stateless"})`, async () => {
      const token = await setupWiki(modern ? "mcp-m" : "mcp-l", ["read"]);
      const r = await mcp(token, "tools/list", {}, { modern });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const names = (r.body.result.tools as { name: string }[]).map((t) => t.name).sort();
      expect(names).toEqual(TOOLS);
      const commit = (r.body.result.tools as { name: string; description: string }[]).find((t) => t.name === "wiki_commit")!;
      expect(commit.description).toMatch(/edit/);
      expect(commit.description).toMatch(/conflict/);
    });
  }

  it("calls every tool", async () => {
    const token = await setupWiki("mcp-a", ["read", "write", "raw:write"]);
    const tool = async (name: string, args: Record<string, unknown>, modern = false) => {
      const r = await mcp(token, "tools/call", { name, arguments: args }, { modern });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.result, JSON.stringify(r.body)).toBeDefined();
      return r.body.result as { isError?: boolean; content: { type: string; text: string }[] };
    };

    const overview = await tool("wiki_overview", {}, true);
    expect(overview.isError).toBeFalsy();
    expect(toolJson(overview).wiki).toBe("mcp-a");

    const commit = await tool("wiki_commit", {
      message: "add",
      ops: [
        { op: "create", path: "notes/alpha.md", content: "# Alpha\n\nAlpha links [[beta]].\n" },
        { op: "create", path: "notes/beta.md", content: "# Beta\n\nBeta text about zebras.\n" },
      ],
    });
    expect(commit.isError, commit.content[0]!.text).toBeFalsy();
    const seq = toolJson(commit).seq;
    expect(seq).toBeGreaterThan(0);

    const conflict = await tool("wiki_commit", { message: "dup", ops: [{ op: "create", path: "notes/alpha.md", content: "x" }] });
    expect(conflict.isError).toBe(true);
    expect(toolJson(conflict).error.code).toBe("conflict");
    expect(toolJson(conflict).error.details.reason).toBe("exists");

    const read = await tool("wiki_read", { path: "notes/alpha.md" });
    expect(toolJson(read).pages[0].content).toContain("Alpha links");
    const list = await tool("wiki_read", { list_prefix: "notes/" });
    expect(toolJson(list).map((e: { path: string }) => e.path)).toEqual(["notes/alpha.md", "notes/beta.md"]);

    const search = await tool("wiki_search", { query: "zebras" }, true);
    expect(toolJson(search).results[0].rel_path).toBe("notes/beta.md");
    const backlinks = await tool("wiki_search", { backlinks: "beta" });
    expect(toolJson(backlinks).inbound.map((b: { rel_path: string }) => b.rel_path)).toEqual(["notes/alpha.md"]);
    const top = await tool("wiki_search", { top_linked: 3 });
    expect(Array.isArray(toolJson(top).top_linked)).toBe(true);

    const history = await tool("wiki_history", { path: "notes/alpha.md" });
    expect(toolJson(history).commits.length).toBeGreaterThan(0);

    const graph = await tool("wiki_graph", { op: "edges" });
    expect(graph.isError, graph.content[0]!.text).toBeFalsy();
    const lint = await tool("wiki_lint", {});
    expect(lint.isError).toBeFalsy();

    const put = await tool("wiki_raw", { action: "put_text", path: "sources/note.txt", text: "héllo wörld" });
    expect(put.isError, put.content[0]!.text).toBeFalsy();
    const stat = await tool("wiki_raw", { action: "stat", path: "sources/note.txt" });
    expect(toolJson(stat).bytes).toBe(new TextEncoder().encode("héllo wörld").byteLength);
    const raw = await tool("wiki_raw", { action: "read", path: "sources/note.txt", offset: 0, length: 2 });
    // The range cuts "é" in half; the reader stops before it.
    expect(toolJson(raw)).toMatchObject({ encoding: "utf-8", text: "h", more: true });
    const rawList = await tool("wiki_raw", { action: "list" });
    expect(toolJson(rawList).entries).toHaveLength(1);
  });

  it("enforces scopes inside tools", async () => {
    const token = await setupWiki("mcp-b", ["read"]);
    const r = await mcp(token, "tools/call", {
      name: "wiki_commit",
      arguments: { message: "x", ops: [{ op: "create", path: "a.md", content: "x" }] },
    });
    expect(r.body.result.isError).toBe(true);
    expect(toolJson(r.body.result).error.code).toBe("forbidden");
  });

  it("accepts the admin token with wiki selection", async () => {
    await setupWiki("mcp-c");
    const r = await mcp(ADMIN, "tools/call", { name: "wiki_overview", arguments: {} }, { headers: { "X-LLM-Wiki": "mcp-c" } });
    expect(toolJson(r.body.result).wiki).toBe("mcp-c");
    const q = await mcp(ADMIN, "tools/call", { name: "wiki_overview", arguments: {} }, { query: "?wiki=mcp-c" });
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect(toolJson(q.body.result).wiki).toBe("mcp-c");
  });

  it("serves OAuth discovery metadata", async () => {
    const as = await getJson("/.well-known/oauth-authorization-server");
    expect(as.status).toBe(200);
    expect(as.body.issuer).toBe("https://wiki.example.com");
    expect(as.body.authorization_endpoint).toBe("https://wiki.example.com/authorize");
    expect(as.body.token_endpoint).toBe("https://wiki.example.com/oauth/token");
    expect(as.body.registration_endpoint).toBe("https://wiki.example.com/oauth/register");
    expect(as.body.scopes_supported).toEqual(["wiki:read", "wiki:write"]);
    const pr = await getJson("/.well-known/oauth-protected-resource/mcp");
    expect(pr.status).toBe(200);
    expect(pr.body.resource).toBe("https://wiki.example.com/mcp");
    expect(pr.body.authorization_servers).toEqual(["https://wiki.example.com"]);
  });
});
