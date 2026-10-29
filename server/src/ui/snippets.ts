/** MCP client configuration for a deployed origin. The token comes from the LLM_WIKI_TOKEN variable. */
export interface Snippet {
  client: string;
  where: string;
  code: string;
}

export const TOKEN_ENV = "LLM_WIKI_TOKEN";

export function mcpSnippets(origin: string): Snippet[] {
  const url = `${origin}/mcp`;
  const j = (v: unknown) => JSON.stringify(v, null, 2);
  return [
    {
      client: "Claude Code",
      where: "Run once in a terminal (or add the JSON to .mcp.json in your project).",
      code:
        `claude mcp add --transport http llm-wiki ${url} --header "Authorization: Bearer $${TOKEN_ENV}"\n\n` +
        j({ mcpServers: { "llm-wiki": { type: "http", url, headers: { Authorization: `Bearer \${${TOKEN_ENV}}` } } } }),
    },
    {
      client: "Codex",
      where: "~/.codex/config.toml",
      code: `[mcp_servers.llm-wiki]\nurl = "${url}"\nbearer_token_env_var = "${TOKEN_ENV}"`,
    },
    {
      client: "Cursor",
      where: "~/.cursor/mcp.json or .cursor/mcp.json",
      code: j({ mcpServers: { "llm-wiki": { url, headers: { Authorization: `Bearer \${env:${TOKEN_ENV}}` } } } }),
    },
    {
      client: "Gemini CLI",
      where: "~/.gemini/settings.json",
      code: j({ mcpServers: { "llm-wiki": { httpUrl: url, headers: { Authorization: `Bearer $${TOKEN_ENV}` } } } }),
    },
    {
      client: "OpenCode",
      where: "opencode.json",
      code: j({
        $schema: "https://opencode.ai/config.json",
        mcp: { "llm-wiki": { type: "remote", url, enabled: true, headers: { Authorization: `Bearer {env:${TOKEN_ENV}}` } } },
      }),
    },
    {
      client: "omp",
      where: "~/.omp/agent/mcp.json (all projects) or .omp/mcp.json (one project)",
      code: j({ mcpServers: { "llm-wiki": { type: "http", url, headers: { Authorization: `Bearer \${${TOKEN_ENV}}` } } } }),
    },
    {
      client: "Pi",
      where: "~/.pi/agent/mcp.json (all projects) or .pi/mcp.json (one project). Pi has built-in MCP support. Run /reload in a Pi session after you change the file.",
      code: j({ mcpServers: { "llm-wiki": { type: "http", url, headers: { Authorization: `Bearer \${${TOKEN_ENV}}` } } } }),
    },
    {
      client: "Generic MCP client",
      where:
        "Any client with Streamable HTTP. A client with OAuth support can omit the header: it starts its own sign-in and opens the /authorize page for you.",
      code: `URL:    ${url}\nHeader: Authorization: Bearer <token>`,
    },
  ];
}
