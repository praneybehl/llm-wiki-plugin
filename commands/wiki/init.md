---
description: Initialize a personal global LLM Wiki or one in this project, or connect this agent to a hosted wiki.
argument-hint: "[--global] [--wiki-dir <name>] [--raw-dir <name>] | --hosted <url>"
---

Initialize a new LLM Wiki, or connect to a hosted one. Use the `llm-wiki` skill.

Arguments (if any): $ARGUMENTS

If the arguments contain `--hosted <url>`, follow "Connect to a hosted wiki" below and skip the local steps.

## Local wiki

1. Open `skills/llm-wiki/references/retrieval-setup.md` and ask its setup questions in one grouped interaction: global or project scope, wiki/raw paths, model-cache location, graph usage, and agent-memory integration. Treat `--global` as selecting `~/wiki/` and `~/wiki/raw/` unless I supplied other paths.
2. Explain that initialization installs and verifies the complete local runtime through `uv`: pinned FastEmbed, sqlite-vec, PyYAML, the `BAAI/bge-small-en-v1.5` model, the parse cache, and vectors for every existing section. No API key, provider consent, per-query fee, or outbound wiki/query text is involved.
3. After I answer, run the initializer against the selected location. For a project wiki, use `python "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/init_wiki.py" "<absolute-project-root>"`. For the standard global layout, use `python "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/init_wiki.py" "<absolute-home-directory>" --wiki-dir wiki --raw-dir wiki/raw`. Never run it against the plugin directory. Do not report setup complete unless its runtime JSON says `"status": "ready"`.
4. Walk me through the bootstrapped `SCHEMA.md`, set its location block to the selected paths, and ask whether I want to customize page types, tags, or workflow conventions.
5. Propose the matching agent-memory integration using `references/agent-memory-integration.md`: global instructions with a stable user-level path for a global wiki, or project instructions with relative paths for a project wiki. Show the exact addition and ask whether to append, create, or skip. Never write without approval.
6. Do not ingest a source yet. This command only completes an informed setup.

## Connect to a hosted wiki (`--hosted <url>`)

Read `skills/llm-wiki/references/hosted-mode.md` first. This flow connects this agent to a wiki that is already deployed. It does not deploy a server. To deploy one, point me to the "Hosted wiki" documentation page.

1. Ask me which agent client I use, and whether I connect with a token or with OAuth. Use OAuth only if my client supports OAuth sign-in for remote MCP servers. Then follow one branch.

### Token branch

2. Ask me for a token for this agent. Tell me to make one on `<url>/setup` or with `wiki_remote.py token create`, with the scopes `read,write` (add `raw:write` for raw uploads). Tell me not to paste `ADMIN_TOKEN`.
3. Store the connection: `python3 "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_remote.py" login --url "<url>" --token -`. I type the token on standard input. Never echo the token, write it into a file in the project, or put it in a memory file.
4. Run `python3 "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_remote.py" status`. Report the wiki id, the scopes, the page count and the search mode. Stop if the command fails.
5. Run `python3 "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_remote.py" mcp-config <client>` (`claude-code`, `codex`, `cursor`, `gemini`, `opencode`, `omp`, `pi`, `generic`). Show the output and where it goes. Add it only after I approve. Tell me to set `LLM_WIKI_TOKEN` in my environment.

### OAuth branch

2. Add the MCP server URL `<url>/mcp` to my client without an `Authorization` header. Show me the exact configuration change and add it only after I approve. Do not run `wiki_remote.py login`: the OAuth sign-in gives a token to the client, not to `wiki_remote.py`.
3. Tell me to start the sign-in from my client (for example `/mcp` in Claude Code, or `pi mcp login llm-wiki` in Pi). The client opens the server authorization page in my browser with its own request parameters. Do not tell me to open `<url>/authorize` directly: without the client request, the page cannot complete the sign-in.
4. On the authorization page, I approve the client with `ADMIN_TOKEN` or with a one-time pairing code (made on `<url>/setup` or with `wiki_remote.py pair --label <label> --scopes read,write`), then select the wiki and the access.
5. Call `wiki_overview` through the new MCP server. Report the wiki id, the page count and the search mode from its result. Stop if the call fails.

### Both branches

6. Propose the hosted-wiki stanza from `references/agent-memory-integration.md`, with the URL filled in. Show the exact text and ask whether to append, create, or skip. Never write without approval. If a local-wiki stanza exists for the same wiki, propose to replace it.
7. If I have a local wiki to move, suggest `/wiki:migrate`. Do not import anything in this command.
