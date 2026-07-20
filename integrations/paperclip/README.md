# Using `llm-wiki` inside a Paperclip Company

The wiki has an **agent side** and a **human side**. They are independent installs.

| | Agent side | Human side |
|---|---|---|
| What it is | The [`llm-wiki` skill](../../skills/llm-wiki/) — agentskills.io format | The [`paperclip-plugin-llm-wiki`](./plugin/) Paperclip plugin |
| What it does | Agents read the wiki at heartbeat; write to it when their work produces durable knowledge | Operators see the wiki inside Paperclip — sidebar, full-page view, issue context tab, dashboard health card, agent-callable search tool |
| Where it runs | Each adapter the Company uses (Claude Code, Codex, Gemini CLI, Cursor, OpenCode, Pi, Hermes) | The Paperclip host (worker as Node child process; UI bundle in the host's iframe-less plugin loader) |
| Required? | **Yes, if you want the wiki maintained at all** | Optional — install if you curate or read the wiki from inside Paperclip |

This directory holds:

- [`plugin/`](./plugin/) — the npm package source. The [plugin README](./plugin/README.md) is the comprehensive user guide (install, usage per surface, config, security, troubleshooting, FAQ).
- [`SPEC.md`](./SPEC.md) — v0.1 design proposal with verbatim references to the Paperclip plugin SDK.
- [`FEASIBILITY.md`](./FEASIBILITY.md) — Phase 0 validation report against the live SDK at `paperclipai/paperclip@master`. Documents the 14 SPEC errata that surfaced during validation.

## Should I install the plugin?

Install the Paperclip plugin if any of these apply:

- **You actively curate the wiki** and want it visible from Paperclip's board.
- You want **issue-relevant wiki context** to surface inline when reviewing an issue, instead of having to remember which pages might be relevant.
- You want a **wiki health card** on the dashboard so a stale or broken wiki nags you visibly instead of silently rotting.
- You run **HTTP-only adapters** (Hermes Agent, custom HTTP/webhook agents) that don't run the skill directly. The plugin's `wiki.query` agent tool gives them search access by tool call.

Skip the plugin if:

- You only ever read the wiki through Obsidian / your editor and never inside Paperclip.
- Your Company has no UI users — fully autonomous agents, no operator decisions.
- The wiki is small enough that you don't need an in-app browser.

The plugin doesn't replace the skill, doesn't write to the wiki, and doesn't change the heartbeat path. It's a window, not a hand.

## First-time setup walkthrough

This is the recommended order of operations for a Company that doesn't have a wiki yet.

### Step 1 — Install the agent-side skill

Pick whichever adapter your Company uses and follow the [main repo's installation table](../../README.md#installation). The skill installs into `.claude/skills/`, `.codex/skills/`, etc., depending on the adapter.

### Step 2 — Bootstrap a wiki

From any agent in the Company's primary workspace:

```
/wiki:init
```

This creates:

```
wiki/
├── SCHEMA.md            ← schema doc, co-evolved with you over time
├── index.md             ← starter index
├── log.md               ← append-only ingest log
└── (page subdirectories appear as you ingest sources)
raw/                     ← drop sources here for /wiki:ingest to process
```

The `/wiki:init` command also proposes wiring the wiki into your project's agent-memory file (`AGENTS.md` / `CLAUDE.md` / `GEMINI.md`) so the agent remembers the wiki across sessions. **Approve this** — without it, the agent will need to be told about the wiki every time.

### Step 3 — Install the Paperclip plugin

Once published to npm:

```bash
pnpm paperclipai plugin install paperclip-plugin-llm-wiki
```

The host validates the manifest, displays the **eight capabilities** the plugin requests, and starts the worker. Approve all eight; they are all read or registration capabilities. (Detailed per-capability rationale is in [`plugin/README.md`](./plugin/README.md#capability-reference).)

For local development from this repo:

```bash
cd integrations/paperclip/plugin
pnpm install
pnpm run build
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"'"$(pwd)"'","isLocalPath":true}'
```

### Step 4 — Verify

Open any Company in Paperclip:

- The **Wiki** entry should appear in the company sidebar.
- The **Wiki health** card should appear on the dashboard with a real page count.
- Inside any open issue, a **Wiki context** tab should appear.

If the dashboard widget shows *"Wiki path not configured"*, the plugin can't resolve `wiki/` under the Company's primary workspace. See [`plugin/README.md` § Troubleshooting](./plugin/README.md#troubleshooting).

### Step 5 — Drop in your first source

From any agent:

```
/wiki:ingest raw/some-paper.pdf
```

Or natural language: *"add this paper to the wiki"*. The agent reads the source, summarizes it into a source page, identifies which existing entity and concept pages it touches, surgically updates them with `str_replace`, creates new pages where needed, updates the index, and appends to the log. All of this happens **without the plugin** — the plugin just reads what the agent writes.

Refresh the Paperclip page. The new pages appear in the Wiki sidebar and (if relevant) in the Wiki context tab of any open issue.

## How they fit together

```
        ┌───────────────────────────┐
  ┌─────│  llm-wiki skill           │──ingest, lint, query, write──┐
  │     │  (in Claude Code/Codex/…) │                              │
  │     └───────────────────────────┘                              ▼
  │                                                       ┌────────────────┐
  │                                                       │ wiki/          │
  │                                                       │  (markdown +   │
  │                                                       │  optional      │
  │                                                       │  graph layer)  │
  │                                                       └────────────────┘
  │                                                                ▲
  │     ┌───────────────────────────┐                              │
  └─via─│  paperclip-plugin-        │──read-only via node:fs───────┘
       │  llm-wiki                 │
       │  (in Paperclip UI)        │
       └───────────────────────────┘
                  │
                  ▼
          (operator's eyes)
```

Both halves see the same files on disk. No double-bookkeeping, no event coordination, no event-driven cache invalidation. If an agent ingests a source at 03:00 and creates a new entity page, the operator sees it on the next slot mount in Paperclip — fresh filesystem read.

## Heartbeat pattern (unchanged by the plugin)

1. An agent in the Company starts a heartbeat run.
2. The skill is loaded (via `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`).
3. The agent reads the wiki via `wiki/index.md` or `python wiki_search.py` for fuzzy queries.
4. If the work produces durable knowledge, the agent writes back via `/wiki:ingest` semantics — surgical `str_replace` updates to existing pages plus new pages for new entities/concepts.
5. The plugin sees the same files on the next slot mount because both sides share the filesystem.

The plugin **adds** an alternate path: agents that don't run the skill directly (HTTP/webhook adapters) can call the `wiki.query` tool the plugin registers via `agent.tools.register`. The tool returns section-level BM25 results identical to the Python CLI's `--no-embed` mode—same algorithm, same constants, fixture-snapshot tested. Default local hybrid retrieval remains available through the skill's Python CLI.

## Multi-Company

Paperclip plugins are instance-wide today (per-Company activation has been discussed but is not currently shipped — see [`paperclipai/paperclip` Discussion #258](https://github.com/paperclipai/paperclip/discussions/258)).

The plugin handles multi-Company correctly through configuration: each Company has its own `wiki_path` config (default `wiki`), and all slot context is Company-scoped. Multiple Companies on the same Paperclip instance get independent wikis with no cross-contamination.

If you run an HQ Company that aggregates context across business Companies, the HQ Company has its own wiki. Cross-Company queries either go through the existing per-Company plugin instances (one Company at a time in the HQ Wiki sidebar) or you run an HQ-scoped agent that reads multiple Companies' wikis directly via filesystem. The plugin doesn't try to model "wiki federation" — that's a different product.

## When something goes wrong

Most issues fall into one of three buckets:

| Symptom | Likely cause | Fix |
|---|---|---|
| Sidebar / dashboard says *"Wiki path not configured"* | No wiki bootstrapped, or `wiki_path` config points at the wrong directory | Run `/wiki:init` from any agent, or set `wiki_path` correctly via `/settings/plugins/io.praneybehl.llm-wiki` |
| Search results from the plugin differ from Python `--no-embed` output | They shouldn't—both lexical paths use BM25 with identical constants | File an issue with the corpus and queries; both implementations are parity-tested against `wiki_search.py --no-embed` |

Full troubleshooting + FAQ live in [`plugin/README.md`](./plugin/README.md#troubleshooting).

## Cross-references

- The full user guide for installing and using the plugin: [`plugin/README.md`](./plugin/README.md).
- The v0.1 design with SDK-source citations: [`SPEC.md`](./SPEC.md).
- The Phase 0 validation report: [`FEASIBILITY.md`](./FEASIBILITY.md).
- The skill (canonical, agent-side): [`../../skills/llm-wiki/`](../../skills/llm-wiki/).
- The agent-memory stanza: [`../../skills/llm-wiki/references/agent-memory-integration.md`](../../skills/llm-wiki/references/agent-memory-integration.md).
- The repo top-level README: [`../../README.md`](../../README.md).
