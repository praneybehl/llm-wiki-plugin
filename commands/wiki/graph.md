---
description: Compile, lint, or query the wiki's typed graph layer.
argument-hint: "extract | lint | neighbors --node <id> | edges --subject <id> | path --from <id> --to <id> | facts --about <id>"
---

Run a graph-layer operation against the wiki using the `llm-wiki` skill's graph workflow.

Arguments: $ARGUMENTS

1. Confirm `wiki/graph/ontology.yaml` exists. If not, the wiki is pre-graph — offer to seed `wiki/graph/` (copy the templates from `skills/llm-wiki/assets/`) before doing anything else. Do not fabricate ontology entries.
2. Dispatch on the first argument:
   - `extract` → `uv run --script skills/llm-wiki/scripts/wiki_graph_extract.py wiki/`
   - `lint` → `uv run --script skills/llm-wiki/scripts/wiki_graph_lint.py wiki/`
   - `neighbors --node <id>` → `python skills/llm-wiki/scripts/wiki_graph_query.py wiki/ neighbors --node <id>`
   - `edges --subject <id> [--predicate <p>]` → `python skills/llm-wiki/scripts/wiki_graph_query.py wiki/ edges --subject <id> [--predicate <p>]`
   - `path --from <id> --to <id> [--max-depth N]` → `python skills/llm-wiki/scripts/wiki_graph_query.py wiki/ path --from <id> --to <id>`
   - `facts --about <id>` → `python skills/llm-wiki/scripts/wiki_graph_query.py wiki/ facts --about <id>`
3. For query subcommands, after running the script, follow the most relevant edges back to their wiki pages and summarize. Cite with `[[wikilinks]]` to wiki pages, not graph rows. The graph accelerates navigation; the wiki page and its raw source remain the evidence.
4. For `lint`, present findings as proposed edits — do not silently rewrite typed `graph.relationships`. After approved fixes, suggest re-running `extract` so the compiled artifacts stay in sync with the markdown.
5. If `graph.sqlite` is older than the most recent ingest line in `log.md`, suggest running `extract` first.

Full reference: `skills/llm-wiki/references/graph-workflow.md`.
