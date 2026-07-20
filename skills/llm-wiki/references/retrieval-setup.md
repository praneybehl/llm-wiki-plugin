# Retrieval Setup Interview

Use this grouped interview before `/wiki:init` and `/wiki:upgrade`. Both commands then install and verify the complete local runtime; there is no lazy or partial setup path.

## Inspect before asking

Check:

- whether `uv` is available (required prerequisite);
- whether `FASTEMBED_CACHE_PATH` is set (report only the path, never modify it silently);
- whether `wiki/.wiki-cache/search-index.json` exists;
- whether `wiki/.wiki-cache/embeddings.sqlite` exists and contains `semantic_sections` rows.

Report state precisely:

- **Prerequisite ready:** `uv` and Python 3.10+ are available.
- **Semantic dependencies ready:** the pinned runtime loads FastEmbed, sqlite-vec, and PyYAML.
- **Model cached:** the local `BAAI/bge-small-en-v1.5` model has been downloaded.
- **Wiki synchronized:** `setup_wiki.py` emitted `"status": "ready"` and its section count equals the vector count.

A database file alone is not proof that the corpus is synchronized. Initialization and upgrade always run the setup script, which performs the incremental sync before reporting readiness.

## Ask once, as a group

1. **Paths:** confirm the wiki directory (default `wiki/`) and raw-source directory (default `raw/`).
2. **Model cache:** use `~/.cache/llm-wiki/fastembed/`, or set `FASTEMBED_CACHE_PATH` to another local directory?
3. **Graph layer:** configure typed graph metadata now, keep the generated graph available but unused, or defer?
4. **Agent integration:** which agent-memory file should point to the wiki, or skip?

Explain these facts before setup:

- Initialization and every upgrade install pinned FastEmbed, sqlite-vec, and PyYAML through `uv`.
- Setup downloads the pinned model once, builds the parse cache, and embeds every current section; it embeds only new or changed sections on later runs and removes deleted sections.
- Wiki sections and queries stay on the machine; no API key, remote endpoint, request fee, or provider retention policy applies.
- Per-wiki vectors are derived data in `wiki/.wiki-cache/embeddings.sqlite` and can be deleted safely.
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

## Upgrade from v2 provider caches

`wiki/.wiki-cache/embeddings.jsonl` is obsolete, ignored, and may contain historical provider metadata. It is fully derived, so offer to delete it; deletion requires the user's approval because it is an existing file. No content migration or remote re-send is needed. Mandatory v3 setup builds `embeddings.sqlite` locally.
