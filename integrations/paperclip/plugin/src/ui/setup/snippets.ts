/**
 * Per-adapter install commands and the heartbeat stanza, bundled into
 * the plugin tarball so Setup works without network calls.
 *
 * Source of truth: the main repo README and
 * skills/llm-wiki/references/agent-memory-integration.md. This file is
 * hand-maintained — when the install commands or stanza change, update
 * here too. (A future Phase H+ enhancement could auto-generate this
 * from the repo, but the strings change rarely enough that a one-line
 * edit is fine for now.)
 */

export interface AdapterInstall {
  id: string;
  displayName: string;
  installCommand: string;
  memoryFile: string;
}

export const ADAPTERS: AdapterInstall[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    installCommand: "/plugin install llm-wiki@llm-wiki",
    memoryFile: "CLAUDE.md",
  },
  {
    id: "codex",
    displayName: "Codex (OpenAI)",
    installCommand: "npx skills add praneybehl/llm-wiki-plugin -a codex -g",
    memoryFile: "AGENTS.md",
  },
  {
    id: "cursor",
    displayName: "Cursor",
    installCommand: "npx skills add praneybehl/llm-wiki-plugin -a cursor -g",
    memoryFile: "AGENTS.md",
  },
  {
    id: "gemini-cli",
    displayName: "Gemini CLI",
    installCommand:
      "npx skills add praneybehl/llm-wiki-plugin -a gemini-cli -g",
    memoryFile: "GEMINI.md",
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    installCommand: "npx skills add praneybehl/llm-wiki-plugin -a opencode -g",
    memoryFile: "AGENTS.md",
  },
  {
    id: "pi",
    displayName: "Pi Agent",
    installCommand: "npx skills add praneybehl/llm-wiki-plugin -a pi -g",
    memoryFile: "AGENTS.md",
  },
];

/**
 * The canonical heartbeat stanza, copied from
 * skills/llm-wiki/references/agent-memory-integration.md. Drop into
 * each agent's CLAUDE.md / AGENTS.md / GEMINI.md.
 */
export const HEARTBEAT_STANZA = `## LLM Wiki

This project maintains an LLM-curated wiki at \`wiki/\` following Andrej Karpathy's "LLM Wiki" pattern (https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

Before answering questions that rely on knowledge accumulated in this project, read \`wiki/index.md\` (or the relevant shard under \`wiki/indexes/\` if the wiki has been sharded) and use its one-line summaries to find the pages you need. Cite with \`[[wikilinks]]\`. If the index does not surface good candidates, fall back to \`wiki_search.py\` from the \`llm-wiki\` skill for local hybrid retrieval; add \`--no-embed\` for dependency-free BM25.

To add a new source, follow the \`llm-wiki\` skill's ingest workflow: decide placement under \`wiki/sources/\`, \`wiki/entities/\`, \`wiki/concepts/\`, or \`wiki/synthesis/\`; identify touched pages and make surgical \`str_replace\` updates rather than rewrites; update the index; append a one-line entry to \`wiki/log.md\`.

Scaling discipline: atomic pages (400-line soft cap, 800-line hard cap), sharded indexes past ~150 pages or 300 index lines, required YAML frontmatter on every page, \`[[wikilinks]]\` for every cross-reference.

Full conventions live in \`wiki/SCHEMA.md\`. Treat it as authoritative when it disagrees with this summary.`;

/**
 * The system-prompt addition for HTTP-only agents (Hermes, custom
 * webhook agents) that don't load the agent-side skill but DO have
 * tool-call access to the plugin's `wiki.query` tool.
 */
export const HTTP_AGENT_SYSTEM_PROMPT = `You have access to a tool called \`wiki.query\` that searches this Company's LLM Wiki — a curated knowledge base maintained by other agents in the Company. Before answering questions about Company-specific context (people, products, decisions, prior research, sources), call \`wiki.query\` with a focused search query and use the ranked pages to ground your answer. Cite findings with \`[[wikilinks]]\` so other agents can follow the trail.`;
