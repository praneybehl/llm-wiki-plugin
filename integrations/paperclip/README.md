# Using `llm-wiki` inside a Paperclip Company

This directory holds:

- [`SPEC.md`](./SPEC.md) — the v0.1 design for `paperclip-plugin-llm-wiki`, with verbatim references to the Paperclip plugin SDK source.
- [`FEASIBILITY.md`](./FEASIBILITY.md) — the Phase 0 validation report against the live SDK at `paperclipai/paperclip@master`. Source-grounded contract findings and the 14 SPEC errata they surfaced.
- [`plugin/`](./plugin/) — the npm package itself, with its own [README](./plugin/README.md) for the npm audience.

If you're an operator deciding **whether to install the plugin**, this page is for you.

## Two-tier integration

The wiki has an **agent side** and a **human side**. They are independent installs.

### Agent side — the skill (always required)

The [`llm-wiki` Claude Code skill](../../skills/llm-wiki/) is what makes the wiki useful at all. Agents that run on heartbeat in your Paperclip Company read the wiki when starting a task and write to it when their work produces durable knowledge.

Install the skill into whichever adapter your Company uses (Claude Code, Codex, Gemini CLI, Cursor, OpenCode, Pi, Hermes — see the [top-level README](../../README.md#installation)). Then add the canonical agent-memory stanza to:

- `CLAUDE.md` for Claude Code
- `AGENTS.md` for Codex / Cursor / OpenCode / Pi
- `GEMINI.md` for Gemini CLI
- `AGENTS.md` (symlinked from `CLAUDE.md`) if you mix adapters

The full canonical stanza, the three-line short variant, and the "never write without consent" protocol are in [`skills/llm-wiki/references/agent-memory-integration.md`](../../skills/llm-wiki/references/agent-memory-integration.md).

This is enough to use the wiki productively. The plugin is optional.

### Human side — the plugin (optional, but high value if you curate)

The plugin solves one specific friction: **operators who curate the wiki flip out of Paperclip to read it**. They flip to Obsidian, Claude Code, or a markdown viewer to look up what the wiki already knows about a lead, a competitor, or an objection — even though they're inside Paperclip making decisions about exactly that.

Install the plugin if any of these apply:

- You curate the wiki actively and want it visible from Paperclip's board.
- You want **issue-relevant wiki context** to surface inline when reviewing an issue, instead of having to remember which pages might be relevant.
- You want a **wiki health card** on the dashboard so a stale or broken wiki nags you visibly instead of silently rotting.
- You run **HTTP-only adapters** (Hermes Agent, custom HTTP/webhook agents) that don't run the skill directly. The plugin's `wiki.query` agent tool gives them search access by tool call.

Skip the plugin if:

- You only ever read the wiki through Obsidian and never inside Paperclip.
- Your Company has no UI users — fully autonomous, no operator decisions.
- The wiki is small and you just want the agent side.

The plugin doesn't replace the skill, doesn't write to the wiki, and doesn't change anything about the heartbeat path. It's a window, not a hand.

## Install

```bash
pnpm paperclipai plugin install paperclip-plugin-llm-wiki
```

The host validates the manifest, displays the eight capabilities the plugin requests, persists the install record in Postgres, and starts the worker. Hot-installable; no Paperclip restart required. Per-Company config (`wiki_path`, `lint_check_interval_minutes`, `search_top_k`) lives at `/settings/plugins/io.praneybehl.llm-wiki`.

For the npm-package perspective — capability rationale, configuration reference, troubleshooting — see [`plugin/README.md`](./plugin/README.md).

## Heartbeat pattern

The plugin's existence doesn't change the heartbeat path:

1. An agent in the Company starts a heartbeat run.
2. The skill is loaded (via `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`).
3. The agent reads the wiki via `wiki/index.md` or `python wiki_search.py` for fuzzy queries.
4. If the work produces durable knowledge, the agent writes back via `/wiki:ingest` semantics — surgical `str_replace` updates to existing pages plus new pages for new entities/concepts.
5. The plugin sees the same files on the next slot mount because both sides share the filesystem.

The plugin **adds** an alternate path: agents that don't run the skill directly (HTTP/webhook adapters) can call the `wiki.query` tool the plugin registers via `agent.tools.register`. The tool returns ranked BM25 results identical to what the skill produces — same algorithm, same constants, same fixture-snapshot tested.

## Troubleshooting

### Sidebar / page slot shows "Wiki path not configured"

The configured `wiki_path` doesn't resolve under any project's primary workspace. Two likely causes:

- The wiki hasn't been bootstrapped yet. Run `/wiki:init` (or the equivalent skill invocation in your adapter) from any agent in the Company.
- The wiki lives at a non-default path. Set `wiki_path` in the plugin settings form at `/settings/plugins/io.praneybehl.llm-wiki`.

### Capabilities prompt fails with "Missing required capabilities for declared features: ui.dashboardWidget.register"

This is a known upstream bug — [`paperclipai/paperclip` issue #2276](https://github.com/paperclipai/paperclip/issues/2276). The validator has a duplicate-key entry that causes false-positive rejections for plugins declaring `dashboardWidget`.

**Workaround:** comment out the duplicate `dashboardWidget` entry in your local Paperclip's `server/src/services/plugin-capability-validator.ts` and restart. See the upstream issue for the exact lines.

### `wiki.query` returns "wiki not accessible"

Same root cause as the sidebar message — the plugin can't resolve the workspace path. Check the `wiki_path` config and confirm the operator approved `project.workspaces.read` at install. If the capability was declined, re-approve it in the plugin settings.

### Search results from the plugin differ from agent heartbeat output

They shouldn't. Both implementations are tested against the same Python reference (`skills/llm-wiki/scripts/wiki_search.py`) for byte-for-byte parity on a fixed corpus. If they diverge, file an issue with:

- The exact query.
- A minimal corpus that reproduces the divergence.
- The two ranked outputs.

## Cross-references

- The full v0.1 design with SDK source citations: [`SPEC.md`](./SPEC.md).
- The SDK-contract validation that gated implementation: [`FEASIBILITY.md`](./FEASIBILITY.md).
- The npm-package readme: [`plugin/README.md`](./plugin/README.md).
- The skill (canonical, agent-side): [`../../skills/llm-wiki/`](../../skills/llm-wiki/).
- The agent-memory stanza: [`../../skills/llm-wiki/references/agent-memory-integration.md`](../../skills/llm-wiki/references/agent-memory-integration.md).
