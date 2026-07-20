# Retrieval Setup Interview

Use this workflow during `/wiki:init`, `/wiki:upgrade`, or the first retrieval that needs search when `SCHEMA.md` does not record a retrieval choice. Setup is a conversation, not an automatic API call.

## Inspect before asking

Check only whether these variables are present. Never print their values:

- `OPENAI_API_KEY`
- `LLM_WIKI_EMBED_URL`
- `LLM_WIKI_EMBED_KEY`
- `LLM_WIKI_EMBED_MODEL`

Also inspect `wiki/.wiki-cache/` for `search-index.json` and `embeddings.jsonl`. Report each state precisely:

- **Not configured:** no embedding endpoint or key is available.
- **Configured, not API-validated:** environment variables are present, but no successful embedding request was observed.
- **API-validated:** a real embedding request succeeded.
- **Wiki embedded:** `embeddings.jsonl` exists and a hybrid query successfully used its vectors.

A present key is not proof that it is valid, funded, or authorized for embeddings. Never call a configuration "usable" until a real request succeeds. Never call a wiki "embedded" merely because a key exists.

## Ask the setup questions together

Present these choices in one grouped interaction so the user can decide without a long question-by-question exchange:

1. **Wiki layout** (init only): default `wiki/` plus sibling `raw/`, or custom paths. If `raw/` is nested inside the wiki, confirm that it remains immutable and excluded from retrieval.
2. **Retrieval mode:**
   - **Local lexical BM25 (recommended default):** no API key, no usage fees, exact-word retrieval.
   - **OpenAI hybrid:** BM25 plus embeddings through `OPENAI_API_KEY`; default model `text-embedding-3-small`; billable API usage.
   - **Custom OpenAI-compatible hybrid:** requires endpoint, key, and model supplied through environment variables.
   - **Defer:** stay lexical and ask again only when the user requests semantic retrieval or changes setup.
3. **First embedding build:** if hybrid is selected, ask whether to build the embedding cache now or only when semantic search is first needed. State that the first build sends canonical wiki section text to the selected provider and may incur charges.
4. **Graph layer:** configure typed graph metadata now, keep the generated graph available but unused, or defer.
5. **Agent integration:** which agent memory file should point to the wiki, or skip.

Never request an API key in chat. Tell the user which environment variable to set through their shell or secret manager, then verify presence without displaying the value.

## Persist the decision

With approval, record non-secret setup state in `SCHEMA.md` under `## Retrieval`:

```markdown
- Embedding mode: lexical | openai | custom | deferred
- Embedding model: text-embedding-3-small | <custom model> | none
- Embedding provider: OpenAI | <custom provider> | none
- Embedding setup verified: YYYY-MM-DD | not yet API-validated
```

Do not store keys or authorization headers. Honor `lexical` and `deferred` without repeatedly prompting during normal queries.

## Validate hybrid setup

A real validation is billable and sends text to the provider, so get explicit approval before running it. Then:

1. Run one representative `wiki_search.py` query with `--cache --json` and without `--no-embed`.
2. Confirm the JSON response reports `"mode": "hybrid"`.
3. Confirm `wiki/.wiki-cache/embeddings.jsonl` exists and is non-empty.
4. Run the same query again to confirm cached vectors are reused.
5. If the provider rejects the request, report the exact failure and the BM25 fallback. Keep the setup state as configured but not API-validated.
