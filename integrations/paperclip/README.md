# Paperclip integration for `llm-wiki`

This directory holds the [`paperclip-plugin-llm-wiki`](./plugin/) Paperclip plugin and the spec it ships against ([`SPEC.md`](./SPEC.md)).

The plugin surfaces the LLM Wiki inside Paperclip's UI as a read-only context lens. The skill at [`../../skills/llm-wiki/`](../../skills/llm-wiki/) remains the canonical home for wiki conventions, schema, and the curation workflow — the plugin is the human-side window into what the agent already knows.

## Status

**Pre-release.** v0.1 is in active development on the `paperclip-plugin-spec` branch.

- [`SPEC.md`](./SPEC.md) — the v0.1 design proposal.
- [`FEASIBILITY.md`](./FEASIBILITY.md) — Phase 0 validation report. SPEC errata and SDK contract findings.
- [`plugin/`](./plugin/) — the npm package source.

## Documentation (filled in at v0.1 release)

When v0.1 ships, this README will cover:

- When to install the skill alone vs. also installing this plugin.
- The `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` agent-memory stanza (unchanged from skill-only installs).
- Heartbeat pattern: how the agent uses the wiki on heartbeat and the plugin surfaces that context to the operator.
- Troubleshooting: missing wiki, wrong `wiki_path`, capability declined at install.

For now, see [SPEC.md](./SPEC.md) for the full design and [FEASIBILITY.md](./FEASIBILITY.md) for current implementation context.
