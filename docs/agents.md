---
title: Agents
description: Which coding agents support the llm-wiki skill, how to install for each, and the agent-memory file to use.
---

<!-- Adapted from: docs/agents.html (source: README.md agent table, skills/llm-wiki/references/agent-memory-integration.md). -->

# Agents

The `llm-wiki` skill uses the standard [agentskills.io](https://agentskills.io) format, so it runs in every agent below. Bundled-script execution (BM25 search, lint, stats) is verified across all listed agents as of 2026-07-20.

## Support matrix

| Agent | `--agent` value | Invoke via | Scripts run |
| --- | --- | --- | :---: |
| Claude Code | `claude-code` | `/wiki:*` slash commands (bundled) or natural language | ✅ |
| Codex (OpenAI) | `codex` | `/skills` or `$llm-wiki` / natural language | ✅ |
| Cursor | `cursor` | `/llm-wiki` or natural language | ✅ |
| Gemini CLI | `gemini-cli` | `/skills` management commands / natural language | ✅ |
| OpenCode | `opencode` | natural language (agent invokes the native `skill` tool) | ✅ |
| OpenClaw | `openclaw` | auto-exposed as a user command | ✅ |
| Pi Agent | `pi` | `/skill:llm-wiki` or natural language | ✅ |
| OMP ("Oh My Pi") | manual (see below) | natural language (skills auto-surface via `skill://`) | ✅ |

OpenCode also reads `.claude/skills/` and `~/.claude/skills/`, so a Claude Code install works there without a second install.

## Install snippets

**Claude Code** gets the full plugin (skill + slash commands + manifest):

```bash
/plugin marketplace add praneybehl/llm-wiki-plugin
/plugin install llm-wiki@llm-wiki
```

**Codex, Cursor, Gemini CLI, OpenCode, OpenClaw, Pi** install the skill through the `skills` CLI — substitute the matrix's `--agent` value:

```bash
npx skills add praneybehl/llm-wiki-plugin -a codex -g
npx skills add praneybehl/llm-wiki-plugin -a cursor -g
npx skills add praneybehl/llm-wiki-plugin -a gemini-cli -g
npx skills add praneybehl/llm-wiki-plugin -a opencode -g
npx skills add praneybehl/llm-wiki-plugin -a openclaw -g
npx skills add praneybehl/llm-wiki-plugin -a pi -g
```

Drop `-g` to install into the current project only.

**OMP ("Oh My Pi")** and **Hermes Agent** aren't yet in the `npx skills` registry — clone the repo and symlink the skill into the agent's skills directory. OMP reads managed/user skills from `~/.omp/agent/skills/` and surfaces them via `skill://`:

```bash
git clone https://github.com/praneybehl/llm-wiki-plugin.git
mkdir -p ~/.omp/agent/skills ~/.hermes/skills
ln -s "$(pwd)/llm-wiki-plugin/skills/llm-wiki" ~/.omp/agent/skills/llm-wiki
ln -s "$(pwd)/llm-wiki-plugin/skills/llm-wiki" ~/.hermes/skills/llm-wiki
```

## Agent-memory file

After a wiki is bootstrapped, add a short stanza to the project's agent-memory file so the agent remembers the wiki in future sessions without being re-told. The right file depends on the agent:

| Agent | Memory file |
| --- | --- |
| Claude Code | `CLAUDE.md` |
| Codex (OpenAI) | `AGENTS.md` |
| Cursor | `AGENTS.md` (or `.cursor/rules/*.mdc`) |
| OpenCode | `AGENTS.md` (also reads `CLAUDE.md`) |
| Gemini CLI | `GEMINI.md` |
| Pi Agent | `AGENTS.md` |
| OpenClaw | `AGENTS.md` |
| OMP (Oh My Pi) | `AGENTS.md` |

Running multiple agents in one project? Prefer `AGENTS.md` as the canonical file and symlink `CLAUDE.md` to it. The skill never writes a memory file without your approval. The canonical stanza (and a three-line short variant) lives in `skills/llm-wiki/references/agent-memory-integration.md`.

::: info
Slash commands are Claude Code–only. Everywhere else, invoke the skill by natural language: "add this paper to the wiki", "what does the wiki say about X", "lint the wiki". The wiki itself is agent-agnostic — ingest with one agent, query with another.
:::
