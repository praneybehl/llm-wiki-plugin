---
description: Compile, lint, or query the wiki's typed graph layer.
argument-hint: "extract | lint | neighbors --node <id> | edges --subject <id> | path --from <id> --to <id> | facts --about <id>"
---

Run a graph-layer operation against the wiki using the `llm-wiki` skill's graph workflow.

Arguments: $ARGUMENTS

0. Resolve `<WIKI_ROOT>` from an explicit user path, the nearest project instructions, global agent instructions, or finally the current project's `wiki/`. Never assume `${PWD}/wiki` when instructions name another wiki.
1. Confirm `<WIKI_ROOT>/graph/ontology.yaml` exists. If not, the wiki is pre-graph: offer to seed its `graph/` directory (copy the templates from `skills/llm-wiki/assets/`) before doing anything else. Do not fabricate ontology entries.
2. Dispatch on the first argument:
   - `extract` → `uv run --script "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_graph_extract.py" "<WIKI_ROOT>"`
   - `lint` → `uv run --script "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_graph_lint.py" "<WIKI_ROOT>"`
   - `neighbors --node <id>` → `python "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_graph_query.py" "<WIKI_ROOT>" neighbors --node <id>`
   - `edges --subject <id> [--predicate <p>]` → `python "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_graph_query.py" "<WIKI_ROOT>" edges --subject <id> [--predicate <p>]`
   - `path --from <id> --to <id> [--max-depth N]` → `python "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_graph_query.py" "<WIKI_ROOT>" path --from <id> --to <id>`
   - `facts --about <id>` → `python "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_graph_query.py" "<WIKI_ROOT>" facts --about <id>`
3. For query subcommands, after running the script, follow the most relevant edges back to their wiki pages and summarize. Cite with `[[wikilinks]]` to wiki pages, not graph rows. The graph accelerates navigation; the wiki page and its raw source remain the evidence.
4. For `lint`, present findings as proposed edits: do not silently rewrite typed `graph.relationships`. After approved fixes, suggest re-running `extract` so the compiled artifacts stay in sync with the markdown.
5. If `graph.sqlite` is older than the most recent ingest line in `log.md`, suggest running `extract` first.

**Hosted wiki.** If the resolved wiki is a hosted URL (or the instructions name one), use hosted mode from `skills/llm-wiki/references/hosted-mode.md`: the MCP tools, or `python3 "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_remote.py"` when MCP is not available. The server keeps the graph current on each commit, so `extract` is not necessary. Map the actions to `wiki_graph` (or `wiki_remote.py graph <op>`): `neighbors`, `edges`, `path`, `facts`, and `export` for JSONL or GraphML files. `lint` maps to `wiki_lint`. If `graph/ontology.yaml` is missing on the server, offer to create it from the template with a `wiki_commit` `create` operation.

Full reference: `skills/llm-wiki/references/graph-workflow.md`.
