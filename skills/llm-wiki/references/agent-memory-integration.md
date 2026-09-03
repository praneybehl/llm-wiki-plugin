# Agent memory integration

After a wiki is bootstrapped, add a short stanza so the AI agent knows its location in future sessions. Use global agent instructions with a stable user-level path for one personal wiki shared across projects, or a project memory file with relative paths for a project-only wiki. Without this pointer, the agent will often answer from training data instead of reading the wiki.

## Which file to use

The memory-file convention varies by agent. Use this table to pick the right one:

| Agent | Memory file | Notes |
|---|---|---|
| Claude Code | `CLAUDE.md` | Project root; Claude walks up to the git root searching for it. |
| Codex (OpenAI) | `AGENTS.md` | Standard `agents.md` convention. |
| Cursor | `AGENTS.md` (or `.cursor/rules/*.mdc`) | AGENTS.md is simpler and portable across other agents. |
| OpenCode | `AGENTS.md` | Also reads `CLAUDE.md`, so either works. |
| Gemini CLI | `GEMINI.md` | Gemini-specific filename. |
| Pi Agent | `AGENTS.md` | Follows the `agents.md` standard. |
| OMP (Oh My Pi) | `AGENTS.md` | Follows the `agents.md` standard. |
| OpenClaw | `AGENTS.md` | Follows the `agents.md` standard. |

If the user runs multiple agents in the same project, prefer `AGENTS.md` as the canonical file and symlink `CLAUDE.md` to it (or duplicate the content). Claude Code will read a symlinked `CLAUDE.md` without issue.

If the user is unsure which agent they use most, default to `AGENTS.md` — it works for the widest set of runtimes.

## Project-wiki stanza

Append this stanza to the project's chosen memory file. Keep it tight. Memory files live in the agent's context on every session, so every line has a cost.

```markdown
## LLM Wiki

This project maintains an LLM-curated wiki at `wiki/` following Andrej Karpathy's "LLM Wiki" pattern (https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

Before answering questions that rely on knowledge accumulated in this project, read `wiki/index.md` (or the relevant shard under `wiki/indexes/` if the wiki has been sharded) and use its one-line summaries to find the pages you need. Cite with `[[wikilinks]]`. If the index does not surface good candidates, fall back to `wiki_search.py` from the `llm-wiki` skill for local hybrid retrieval; add `--no-embed` for dependency-free BM25.

To add a new source, follow the `llm-wiki` skill's ingest workflow: decide placement under `wiki/sources/`, `wiki/entities/`, `wiki/concepts/`, or `wiki/synthesis/`; identify touched pages and make surgical `str_replace` updates rather than rewrites; update the index; append a one-line entry to `wiki/log.md`.

Scaling discipline: atomic pages (400-line soft cap, 800-line hard cap), sharded indexes past ~150 pages or 300 index lines, required YAML frontmatter on every page, `[[wikilinks]]` for every cross-reference.

Full conventions live in `wiki/SCHEMA.md`. Treat it as authoritative when it disagrees with this summary.
```

Adjust the path references if the user bootstrapped the wiki into a non-default directory (the schema file and the stanza should always agree with each other).

## Personal-global-wiki stanza

Put this variant in the agent's global instructions. Adjust `~/wiki/` if the wiki lives elsewhere.

```markdown
## LLM Wiki

My canonical LLM-curated wiki is at `~/wiki/` and is independent of any project. Before answering from accumulated knowledge, read `~/wiki/index.md` first, then the relevant shard under `~/wiki/indexes/`. Full conventions live in `~/wiki/SCHEMA.md`.

When work in any project produces durable facts, decisions, incidents, or post-mortems, preserve them in `~/wiki/` using the `llm-wiki` skill. Put captured source material under `~/wiki/raw/`. Do not ingest an entire project automatically; add only requested sources and durable findings.
```

## The bootstrap conversation

At init time, after the directory structure is in place and the schema walkthrough is done, propose the stanza. Don't silently append. The user owns their memory file.

A good script:

1. Ask whether the wiki is global across projects or belongs to the current project, then ask which agent(s) they run. For a global wiki, target that agent's global instructions and use a stable user-level path. For a project wiki, use `CLAUDE.md`, `AGENTS.md`, or `GEMINI.md` in the project as described above.
2. Check whether that file already exists.
   - If **not**, offer to create it with just the LLM Wiki stanza as the content.
   - If **yes**, show the proposed stanza and ask whether to append it.
3. Ask whether the user would prefer a shorter stanza. Some users keep their memory files to under 50 lines on principle; the canonical stanza above is already tight, but offer a three-line alternative:

```markdown
## LLM Wiki

This project has an LLM-curated wiki at `wiki/`. Read `wiki/index.md` before answering research questions. Full conventions in `wiki/SCHEMA.md`. Ingest and query workflows live in the `llm-wiki` skill.
```

4. Whatever the user picks, write it, then confirm.

## When the wiki changes shape

The stanza is a pointer, not a playbook. Most evolution of the wiki (new page types, new tags, domain conventions) should happen in `SCHEMA.md`, not in the memory file. The memory file only changes when:

- The wiki moves to a non-standard directory (update the path).
- The wiki shards its index (mention `wiki/indexes/` specifically so the agent starts there).
- The wiki is deprecated (remove the stanza; don't leave a dead pointer).

If you edit the memory file on the user's behalf during a lint or scaling-migration operation, show them the diff and get consent. Silent rewrites of agent-memory files are the fastest way to break user trust.

## Multiple projects

One global wiki is the simplest choice when knowledge should compound across projects. Its global instruction stanza must use a stable user-level path so every working directory resolves the same wiki. Project-specific wikis remain useful when their content should be isolated, committed with the repository, or governed separately. Never merge two wiki scopes silently; follow the closest explicit instruction or ask the user which wiki should receive the material.
