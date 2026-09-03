---
title: Getting started
description: Install the LLM Wiki skill for your agent, then walk through init, first ingest, first query, and first lint.
---

<!-- Adapted from: docs/getting-started.html (source: README.md "Installation"/"Quick start", commands/wiki/init.md, commands/wiki/ingest.md). -->

# Getting started

Install the skill for your coding agent, then run the four-step loop: initialize, ingest, query, lint.

## Install

There are two install paths. Claude Code gets the full plugin (skill + `/wiki:*` slash commands + marketplace manifest). Every other supported agent installs the same [agentskills.io](https://agentskills.io)-format skill through the [`skills` CLI](https://github.com/vercel-labs/skills). See the [agent support matrix](/agents) for the full picture.

Install [`uv`](https://docs.astral.sh/uv/getting-started/installation/) first. It is the only prerequisite and creates isolated, pinned environments for the bundled tools.

### Claude Code — full plugin {#a-claude}

The native path: skill, slash commands, and manifest ship together.

```bash
/plugin marketplace add praneybehl/llm-wiki-plugin
/plugin install llm-wiki@llm-wiki
```

Once installed, the plugin works in any project. Installation does not decide where your wiki lives.

The agents below install the same skill through the `skills` CLI. Each uses the same command with a different `-a` value — add `-g` to install globally across all projects, or drop it to install into the current project only. Slash commands are Claude Code–only; elsewhere, invoke the skill by natural language.

### Codex (OpenAI) {#a-codex}

```bash
npx skills add praneybehl/llm-wiki-plugin -a codex -g
```

Invoke via `/skills`, `$llm-wiki`, or natural language. Bundled scripts run.

### Cursor {#a-cursor}

```bash
npx skills add praneybehl/llm-wiki-plugin -a cursor -g
```

Invoke via `/llm-wiki` or natural language. Bundled scripts run.

### Gemini CLI {#a-gemini}

```bash
npx skills add praneybehl/llm-wiki-plugin -a gemini-cli -g
```

Invoke via the `/skills` management commands or natural language. Bundled scripts run.

### OpenCode {#a-opencode}

```bash
npx skills add praneybehl/llm-wiki-plugin -a opencode -g
```

The agent invokes the skill through its native `skill` tool on natural-language requests. OpenCode also reads `.claude/skills/` and `~/.claude/skills/`, so a Claude Code install works here too. Bundled scripts run.

### OpenClaw {#a-openclaw}

```bash
npx skills add praneybehl/llm-wiki-plugin -a openclaw -g
```

The skill is auto-exposed as a user command. Bundled scripts run.

### Pi Agent {#a-pi}

```bash
npx skills add praneybehl/llm-wiki-plugin -a pi -g
```

Invoke via `/skill:llm-wiki` or natural language. Bundled scripts run.

### OMP ("Oh My Pi") {#a-omp}

OMP reads managed and user skills from `~/.omp/agent/skills/` and surfaces them automatically via `skill://`. OMP is not yet in the `npx skills` registry, so install by cloning the repo and symlinking the skill:

```bash
git clone https://github.com/praneybehl/llm-wiki-plugin.git
mkdir -p ~/.omp/agent/skills
ln -s "$(pwd)/llm-wiki-plugin/skills/llm-wiki" ~/.omp/agent/skills/llm-wiki
```

### Other runtimes — clone and symlink {#a-other}

Hermes Agent and any other agentskills.io-compatible runtime not yet in the `npx skills` registry can use the skill by symlinking it into the agent's skills directory:

```bash
git clone https://github.com/praneybehl/llm-wiki-plugin.git
mkdir -p ~/.hermes/skills
ln -s "$(pwd)/llm-wiki-plugin/skills/llm-wiki" ~/.hermes/skills/llm-wiki
```

The wiki itself is agent-agnostic — it is just a directory of markdown files. You can ingest with one agent and query with another.

## Choose the wiki location

Skill scope and wiki scope are independent:

- **Personal global wiki:** one knowledge base at a stable user-level path such as `~/wiki/`, with raw sources at `~/wiki/raw/`. Add that path to your agent's global instructions. Any project can contribute durable findings and sources to this wiki.
- **Project wiki:** `wiki/` and `raw/` live in one project. Add a relative-path pointer to that project's agent-memory file. This keeps knowledge isolated and makes it easy to version with the repository.

Installing the skill globally with `-g` only makes the skill available everywhere. It does not create a global wiki. Likewise, a global wiki does not automatically crawl projects; the agent ingests project material when asked or when its global instructions require durable findings to be preserved.

## Your first wiki

The commands below use Claude Code's `/wiki:*` slash syntax. In other agents, phrase the same requests in natural language.

1. **Initialize the structure.** For one personal wiki shared across projects:

   ```bash
   /wiki:init --global
   ```

   For a wiki isolated to the current project, run `/wiki:init` without `--global`.

   > **Expected** — Bootstraps the wiki structure, then installs FastEmbed 0.8.0, sqlite-vec 0.1.9, and PyYAML 6.0.3; downloads the local `BAAI/bge-small-en-v1.5` model if absent; builds the parse cache; and embeds every current section. Setup is complete only when the runtime JSON reports `"status": "ready"`. The agent then walks through the schema and offers agent-memory integration; nothing is written there without approval.

   > **Already have a wiki** from an earlier version? Run [`/wiki:upgrade`](/upgrade) instead. It performs the same mandatory runtime setup and incremental full-corpus synchronization while leaving existing pages untouched.

2. **Add your first source.** Drop anything textual into the configured raw root, such as `~/wiki/raw/` for the global layout, then:

   ```bash
   /wiki:ingest ~/wiki/raw/your-source.pdf
   ```

   > **Expected** — The agent resolves the configured wiki, reads the source (chunk-reading if it is large), discusses the takeaways with you, writes a source summary, surgically updates the entity and concept pages it touches, creates new pages (each with at least one inbound link), updates the index, and appends one line to `log.md`.

3. **Ask a question.** Once a few sources are in:

   ```bash
   /wiki:query What does my wiki say about X?
   ```

   > **Expected** — The agent reads the index to find candidate pages, reads them, synthesizes an answer with `[[wikilink]]` citations, and offers to file substantive answers back into `wiki/synthesis/` so the exploration compounds.

4. **Run a health check** periodically:

   ```bash
   /wiki:lint
   ```

   > **Expected** — Catches orphan pages, broken wikilinks, oversized pages, missing frontmatter, and stale claims. Findings are presented as proposed edits — the wiki is never rewritten silently.

::: info
You don't have to use the slash commands. The agent triggers the same skill on natural-language requests too. The commands are there when you want explicit invocation — see the [Commands reference](/commands).
:::
