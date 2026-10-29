# Decision Models (optional)

A decision model is a small model that answers a closed question. Examples: "Does this section help answer the query? A or B". "Which sentence supports this edge? s1, s2 or none". Code prepares the options. The model picks one and gives a confidence.

The decision layer is off by default. The wiki works the same without it. Enable it only when the user asks.

## Rules

- A decision never writes or blocks a write. Read paths fail open. Write checks only add lint findings or review flags.
- Fail open means: on an error, a timeout or an invalid answer, the tool returns the normal result and reports `failed_open: true`.
- Never send wiki text to a hosted backend unless the user enabled that backend.
- Every output records the backend, the model, `latency_ms` and the threshold.
- Do not use a decision model to write, merge or summarize pages, to answer questions, to make slugs or to check frontmatter. Code or the main agent does that work.

## Checks

| Check | Where | Question | Result |
|---|---|---|---|
| D1 relevance gate | Search (local and hosted) | For each of the top 20 rows: does this section help answer the query (A) or does it only share words (B)? | Rows with P(A) below the threshold are removed. An empty result means the wiki has no answer. |
| D2 evidence check | Graph lint (local and hosted) | The evidence text of a typed edge does not occur in its source page. Which sentence supports the edge, or none? | Lint finding `evidence_unsupported` or a review flag |
| D3 contradiction screen | Local lint (`wiki_decide.py contradictions`) | For two sections about the same entity: corroborates, contradicts, new detail or unrelated? | A list of pairs to read. The agent decides. |
| D4 ingest shortlist | Local ingest (`wiki_decide.py shortlist`) | For each search candidate: does this source add to or change this page? | A ranked list of pages to read first |
| D5 untrusted-text screen | Hosted writes to `sources/`, local `wiki_decide.py screen` | Does this text give instructions to an AI system? | Review flag `untrusted_text`. The commit still applies. |

A check that has not passed its eval is experimental. Use its result as a hint, not as a fact.

## Backends

| Backend | Where it runs | Model | Key | Text leaves the machine |
|---|---|---|---|---|
| `local` | `llama-server` on `127.0.0.1:8080` with `LiquidAI/d1-2B-GGUF` | `d1-2B` | None | No |
| `typesafe` | `https://api.typesafe.ai` | `jev-1.14.0` | `TYPESAFE_API_KEY` | Yes, to TypeSafe |
| `openrouter` | `https://openrouter.ai/api` | `typesafe/jev-1.14` | `OPENROUTER_API_KEY` | Yes, to OpenRouter and TypeSafe |
| `liquid` | `https://api.liquid.ai/decisions` | `d1.1` | `LIQUID_API_KEY` | Yes, to Liquid |
| `hosted` | The hosted wiki server (`/api/v1/decide`) | The server setting | Wiki token | Yes, to your Worker and its backend |
| `workers-ai` | Server only: Jev on Workers AI | `typesafe/jev-1.14.0` | None (needs AI Gateway credits) | Stays in Cloudflare |

Notes:

- `workers-ai` needs Cloudflare AI Gateway credits (unified billing). Without credits, the call fails with `2021: Insufficient AI Gateway credits`. The wiki then fails open: no gate and no flags.
- For `typesafe`, `openrouter` or `liquid` on the server, add the key as a Worker secret: `npx wrangler secret put TYPESAFE_API_KEY`.
- Bind `llama-server` to `127.0.0.1` only.
- Licence: Liquid d1 models use the LFM Open License v1.0. Free use stops at $10M annual revenue. Above that limit, the user needs a commercial licence from Liquid.
- Price (vendor figures, October 2026): Jev $0.042 for each million input tokens. Liquid API `d1.1` $0.02 for each million input tokens. Local use costs nothing.
- Privacy: TypeSafe keeps zero data only on enterprise plans. Liquid has not stated API retention. Jev on Workers AI has zero data retention. Tell the user which text each check sends (D1: query and section text; D2: edge and page sentences; D3: two sections; D4: source start and candidate sections; D5: page text).

## Enable locally

Set the backend with an environment variable or a flag. The default is `off`.

```bash
export LLM_WIKI_DECISIONS=local          # off | local | typesafe | openrouter | liquid | hosted
export LLM_WIKI_DECISIONS_URL=http://127.0.0.1:8080   # optional base URL
export LLM_WIKI_DECISIONS_MODEL=d1-2B                 # optional model override
python scripts/wiki_decide.py check                   # test the backend
```

Use the checks:

```bash
uv run --script scripts/wiki_search.py "query" --json --decide [--decide-pool 20] [--decide-threshold 0.65]
uv run --script scripts/wiki_graph_lint.py wiki/ --decide [--decide-threshold 0.55]
python scripts/wiki_decide.py contradictions --wiki wiki/ [--max-pairs 40]
python scripts/wiki_decide.py shortlist raw/<source-file> --wiki wiki/ [--top 30]
python scripts/wiki_decide.py screen <file>
```

Global flags for `wiki_decide.py`: `--backend`, `--model`, `--url`, `--timeout`, `--profile`. See each subcommand's `--help` for its threshold flag. With `--decide`, the search JSON gets a top-level `decision` block and a `decision` field on each row. Without `--decide`, the output does not change.

## Enable on a hosted wiki

The owner changes the wiki settings on the `/setup` page or with `python3 scripts/wiki_remote.py settings --set <key>=<value>`. Settings:

| Setting | Meaning | Default |
|---|---|---|
| `decisions.enabled` | Turn the layer on | `false` |
| `decisions.backend` | `workers-ai`, `typesafe`, `openrouter` or `liquid` | `workers-ai` |
| `decisions.model` | Pinned model id | Backend default |
| `decisions.search_gate` | Gate every search, not only searches with `decide: true` | `false` |
| `decisions.screen_writes` | Run D5 on new or replaced pages under `sources/` | `false` |
| `decisions.relevance_threshold` | P(relevant) to keep a search row | `0.65` |
| `decisions.screen_threshold` | P(untrusted) to create a review flag | `0.7` |
| `decisions.timeout_ms` | Timeout for one call | `4000` |

Agents send `decide: true` to `wiki_search`, or `--decide` to `wiki_remote.py search` and `lint`. Review flags are in `wiki_lint` output and on the `/ui/<wiki>/review` page. Resolve them with `wiki_remote.py review --resolve <id> --status accepted|dismissed`.

## Evaluate before use

The eval uses only synthetic fixtures. Never send private wiki text to a hosted backend for an eval.

```bash
python eval/decisions/run_eval.py --backend fake            # no network
python eval/decisions/run_eval.py --backend local --out results.json
```

Report each backend separately. Set a threshold only from a held-out split.
