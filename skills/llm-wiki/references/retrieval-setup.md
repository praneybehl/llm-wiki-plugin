# Retrieval Setup Interview

Use this grouped interview before `/wiki:init` and `/wiki:upgrade`. Both commands then install and verify the complete local runtime; there is no lazy or partial setup path.

## Inspect before asking

Check:

- whether `uv` is available (required prerequisite);
- whether `FASTEMBED_CACHE_PATH` is set (report only the path, never modify it silently);
- whether `<wiki-root>/.wiki-cache/search-index.json` exists;
- whether `<wiki-root>/.wiki-cache/embeddings.sqlite` exists and contains `semantic_sections` rows.

Report state precisely:

- **Prerequisite ready:** `uv` and Python 3.10+ are available.
- **Semantic dependencies ready:** the pinned runtime loads FastEmbed, sqlite-vec, and PyYAML.
- **Model cached:** the local `BAAI/bge-small-en-v1.5` model has been downloaded.
- **Wiki synchronized:** `setup_wiki.py` emitted `"status": "ready"` and its section count equals the vector count.

A database file alone is not proof that the corpus is synchronized. Initialization and upgrade always run the setup script, which performs the incremental sync before reporting readiness.

## Ask once, as a group

1. **Storage scope and paths:** choose one personal global wiki (suggest `~/wiki/` with `~/wiki/raw/`) or a project wiki (default `wiki/` with `raw/`), then confirm both paths.
2. **Model cache:** use `~/.cache/llm-wiki/fastembed/`, or set `FASTEMBED_CACHE_PATH` to another local directory?
3. **Graph layer:** configure typed graph metadata now, keep the generated graph available but unused, or defer?
4. **Agent integration:** which agent-memory file should point to the wiki, or skip?

Explain these facts before setup:

- Initialization and every upgrade install pinned FastEmbed, sqlite-vec, and PyYAML through `uv`.
- Setup downloads the pinned model once, builds the parse cache, and embeds every current section; it embeds only new or changed sections on later runs and removes deleted sections.
- Wiki sections and queries stay on the machine; no API key, remote endpoint, request fee, or provider retention policy applies.
- Per-wiki vectors are derived data in `<wiki-root>/.wiki-cache/embeddings.sqlite` and can be deleted safely.
- Direct `python wiki_search.py "<query>" --no-embed` remains available for later dependency-free BM25 searches, but it does not replace mandatory initialization or upgrade setup.

## Record non-secret state

The current `SCHEMA.md` retrieval block should say:

```markdown
- Semantic backend: local FastEmbed + sqlite-vec (`BAAI/bge-small-en-v1.5`, 384 dimensions). No wiki or query text leaves the machine.
- First semantic use downloads model artifacts to `~/.cache/llm-wiki/fastembed/`; set `FASTEMBED_CACHE_PATH` to override the model cache.
- Semantic setup verified: YYYY-MM-DD | not yet built
```

Do not store absolute paths unless the user explicitly wants a machine-specific schema. Do not add legacy `Embedding mode`, provider, endpoint, or API-validation fields.

## Validate mandatory setup

Initialization and upgrade call this automatically:

```bash
uv run --script skills/llm-wiki/scripts/setup_wiki.py --wiki wiki --cache
```

Require all of the following before reporting readiness:

1. JSON reports `"status": "ready"`.
2. Dependencies list the pinned FastEmbed, sqlite-vec, and PyYAML packages.
3. Model is `BAAI/bge-small-en-v1.5` with dimension `384`.
4. `wiki/.wiki-cache/search-index.json` and `embeddings.sqlite` exist.
5. `sections` equals the `semantic_sections` and `semantic_vectors` row counts.
6. A second setup run reports the same counts and does not print an embedding batch.

If setup fails, report the exact failed command and safe exception. Check `uv`, model-download access, local disk space, and sqlite extension loading. Do not describe initialization or upgrade as complete.

## Hosted wikis

A hosted wiki needs no local runtime setup. The server makes its own search index:

- Keyword search uses SQLite FTS5 in the wiki Durable Object. A commit is searchable by keyword at once.
- Semantic search uses Workers AI `@cf/baai/bge-small-en-v1.5` (CLS pooling, L2-normalized, 384 dimensions) and a Vectorize index. A personal wiki fits in the Workers AI free allocation of 10,000 neurons a day.
- Rank fusion is RRF with the same constants as `wiki_search.py`. Results are equivalent to local results, not identical, because the BM25 constants and the embedding runtime are different.
- The server embeds changed sections in batches after each commit. `vector_lag` in `wiki_overview` and in search responses shows the sections that wait for a vector. After `vector_lag` reaches 0, Vectorize can need about one minute more before new sections match by meaning.
- Without the Vectorize or Workers AI binding, search is lexical only. Search responses show the mode.
- Wiki text and queries go to your Cloudflare account. They do not go to another provider unless the owner enables a hosted decision backend (`decision-models.md`).

Do not copy `.wiki-cache/` to a hosted wiki. The import command skips it. Local and hosted vectors never mix. A `pull` mirror can run local `setup_wiki.py` for offline search.

Record this state in the `SCHEMA.md` retrieval block of a hosted wiki:

```markdown
- Semantic backend: hosted (Workers AI `@cf/baai/bge-small-en-v1.5` + Vectorize, 384 dimensions). Wiki text stays in the owner's Cloudflare account.
```

## Upgrade from v2 provider caches

`wiki/.wiki-cache/embeddings.jsonl` is obsolete, ignored, and may contain historical provider metadata. It is fully derived, so offer to delete it; deletion requires the user's approval because it is an existing file. No content migration or remote re-send is needed. Mandatory v3 setup builds `embeddings.sqlite` locally.
