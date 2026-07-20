---
description: Query the LLM Wiki — answer a question from accumulated knowledge with citations.
argument-hint: "<question>"
---

Answer this question against the wiki using the `llm-wiki` skill's query workflow:

Question: $ARGUMENTS

Follow the full query procedure documented in the skill:

1. Read `wiki/SCHEMA.md` first if you haven't this session.
2. Read `wiki/index.md` (or the relevant `wiki/indexes/<type>.md` shard if the index has been sharded) to identify candidate pages.
3. Read the candidate pages. Follow `[[wikilinks]]` selectively — don't recursively chase every link.
4. If the index does not surface good candidates, run local hybrid search. Do not inspect or request API keys: the backend is FastEmbed + sqlite-vec and sends no wiki or query text off-device. If dependencies fail, the command returns lexical BM25 automatically.
4b. Run `uv run --script "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_search.py" "<query terms>" --wiki "${PWD}/wiki" --top 10 --cache --json`. When deterministic dependency-free lexical retrieval is desired, run `python "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_search.py" "<query terms>" --wiki "${PWD}/wiki" --top 10 --cache --json --no-embed` instead; do not append `--no-embed` to the `uv run --script` form because uv still resolves the declared semantic packages. Use `--type concept` / `--tag <tag>` when helpful and `--granularity page` for whole-page ranking.
5. If the question asks "what links to X", use `python "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_search.py" "" --wiki "${PWD}/wiki" --backlinks <slug>` instead of grep.
5b. If the question is relational ("what's connected to X", "who proposed Y", "trace the path from A to B") and `wiki/graph/graph.sqlite` exists, run `python "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_graph_query.py" "${PWD}/wiki" neighbors --node <id>` (or `facts` / `edges` / `path`) to get structured neighbors before reading pages. Use the typed-edge results to choose which wiki pages to open — do not answer from graph rows alone for high-stakes claims.
6. Synthesize the answer with `[[wikilink]]` citations to the wiki pages used. Surface contradictions explicitly rather than picking a side.
7. If the wiki has no relevant content, say so plainly — do not confabulate. Suggest sources I might want to ingest to fill the gap.
8. If the answer represents new connection-making, offer to file it back into `wiki/synthesis/` so future queries benefit. Default to offering; let me decline for trivial answers.
