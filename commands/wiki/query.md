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
4. If the index does not surface good candidates, inspect the retrieval choice in `SCHEMA.md` before running search. If it records `lexical` or `deferred`, run `wiki_search.py` with `--no-embed`. If it records `openai` or `custom`, inspect environment and cache presence without printing secrets. Before the first billable embedding build, explain that hybrid sends every query text and sends new or changed canonical sections when vectors are missing, then ask for explicit approval using `references/retrieval-setup.md`. If no choice is recorded, present local BM25, OpenAI hybrid, custom hybrid, and defer, with local BM25 as the safe default. Never infer that a present key is valid, and never claim the wiki is embedded unless `embeddings.jsonl` exists and a hybrid query was observed.
4b. Run `python skills/llm-wiki/scripts/wiki_search.py "<query terms>" --top 10 --cache --json` after resolving the mode. Add `--no-embed` for `lexical`, `deferred`, or unanswered setup. If the chosen provider has no approval marker, the command stays lexical; add `--approve-embedding-build` only after the user explicitly approves that provider's initial section upload. Use `--type concept` / `--tag <tag>` when helpful and `--granularity page` for whole-page ranking.
5. If the question asks "what links to X", use `python skills/llm-wiki/scripts/wiki_search.py "" --backlinks <slug>` instead of grep.
5b. If the question is relational ("what's connected to X", "who proposed Y", "trace the path from A to B") and `wiki/graph/graph.sqlite` exists, run `python skills/llm-wiki/scripts/wiki_graph_query.py wiki/ neighbors --node <id>` (or `facts` / `edges` / `path`) to get structured neighbors before reading pages. Use the typed-edge results to choose which wiki pages to open — do not answer from graph rows alone for high-stakes claims.
6. Synthesize the answer with `[[wikilink]]` citations to the wiki pages used. Surface contradictions explicitly rather than picking a side.
7. If the wiki has no relevant content, say so plainly — do not confabulate. Suggest sources I might want to ingest to fill the gap.
8. If the answer represents new connection-making, offer to file it back into `wiki/synthesis/` so future queries benefit. Default to offering; let me decline for trivial answers.
