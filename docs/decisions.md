---
title: Decision models
description: Optional small decision models that gate search relevance, check graph evidence and screen untrusted text, with backends, privacy, licence and costs.
---

# Decision models

Decision models are small models that answer closed questions. Code prepares the options. The model picks one and gives a probability. LLM Wiki can use them for five checks.

::: info Off by default
The decision layer is optional and off by default. The wiki works the same without it. Nothing goes to a decision backend until you turn one on.
:::

## Rules

- A decision model never writes a page and never blocks a write. Write checks only add lint findings or review flags.
- Read paths fail open. On an error, a timeout or an invalid answer, you get the normal result with `failed_open: true`.
- The main agent still writes, merges and summarizes pages and answers questions. Code still checks frontmatter, types and dates.
- Every output records the backend, the model, the latency and the threshold.
- A check that has not passed its eval is experimental. Treat its result as a hint.

## The five checks

| Check | Where | What it asks | What you get |
|---|---|---|---|
| D1 relevance gate | Search, local and hosted | For each of the top 20 rows: does this section help answer the query, or does it only share words? | Rows below the threshold are removed. An empty result tells the agent that the wiki has no answer. |
| D2 evidence check | Graph lint, local and hosted | The evidence text of a typed edge does not occur in its source page. Which sentence supports the edge, or none? | Lint finding `evidence_unsupported`, or a review flag on a hosted wiki |
| D3 contradiction screen | Local (`wiki_decide.py contradictions`) | Two sections about the same entity: do they corroborate, contradict, add detail, or not relate? | Pairs for the agent to read |
| D4 ingest shortlist | Local (`wiki_decide.py shortlist`) | For each search candidate: does this source add to or change the page? | A ranked list of pages to read first |
| D5 untrusted-text screen | Hosted commits to `sources/`, local `wiki_decide.py screen` | Does this text give instructions to an AI system? | Review flag `untrusted_text`. The commit still applies. |

## Backends

| Backend | Where it runs | Model | Key | Data |
|---|---|---|---|---|
| `local` | `llama-server` on your machine | Liquid `d1-2B` (GGUF) | None | Stays on your machine |
| `typesafe` | TypeSafe API | `jev-1.14.0` | `TYPESAFE_API_KEY` | Goes to TypeSafe |
| `openrouter` | OpenRouter | `typesafe/jev-1.14` | `OPENROUTER_API_KEY` | Goes to OpenRouter and TypeSafe |
| `liquid` | Liquid API | `d1.1` | `LIQUID_API_KEY` | Goes to Liquid |
| `workers-ai` | Hosted wiki only: Jev on Workers AI | `typesafe/jev-1.14.0` | None, but needs AI Gateway credits | Stays in Cloudflare |
| `hosted` | Local scripts call your hosted wiki | The hosted wiki setting | Wiki token | Goes to your Worker and its backend |

Jev on Workers AI is the first hosted option.

::: warning Workers AI needs credits
The `workers-ai` backend calls `typesafe/jev-1.14.0` through Cloudflare AI Gateway unified billing. Your account needs AI Gateway credits. Without credits, calls fail with `2021: Insufficient AI Gateway credits`. The wiki then fails open: search is not gated and no flags are made.
:::

For the other hosted backends, add the key as a Worker secret:

```bash
cd server
npx wrangler secret put TYPESAFE_API_KEY     # or OPENROUTER_API_KEY, LIQUID_API_KEY
```

## Privacy, licence and costs

What each check sends to the backend:

| Check | Text sent |
|---|---|
| D1 | The query, and the title, heading and up to 1,500 characters of each candidate section |
| D2 | The edge and up to 60 sentences of the source page |
| D3 | Two sections |
| D4 | The first 2,000 characters of the source and each candidate section |
| D5 | The page text |

- TypeSafe: not trained on customer data. Zero retention only on enterprise plans.
- Liquid API: retention for API traffic is not stated.
- Jev on Workers AI: zero data retention.
- Local `llama-server`: no text leaves your machine. Bind it to `127.0.0.1` only.

Licence: Liquid d1 models use the LFM Open License v1.0. Free use is limited to organizations below $10M annual revenue. Above that limit, get a commercial licence from Liquid.

Prices (vendor figures, October 2026):

| Backend | Price |
|---|---|
| Jev (TypeSafe, OpenRouter, Workers AI) | $0.042 for each million input tokens |
| Liquid API `d1.1` | $0.02 for each million input tokens |
| Local `d1-2B` | No charge |

One gated search sends about 20 requests. Each request holds one section, so one search uses some thousands of input tokens.

## Turn it on locally

Run a local backend (no key, no data leaves the machine):

```bash
llama-server -hf LiquidAI/d1-2B-GGUF --host 127.0.0.1 --port 8080
export LLM_WIKI_DECISIONS=local
python skills/llm-wiki/scripts/wiki_decide.py check
```

Or select a hosted backend:

```bash
export LLM_WIKI_DECISIONS=typesafe        # off | local | typesafe | openrouter | liquid | hosted
export TYPESAFE_API_KEY=...
```

Optional: `LLM_WIKI_DECISIONS_URL` changes the base URL. `LLM_WIKI_DECISIONS_MODEL` changes the model. The `wiki_decide.py` flags `--backend`, `--model`, `--url` and `--timeout` override the environment.

Use the checks:

```bash
uv run --script skills/llm-wiki/scripts/wiki_search.py "query" --json --decide
uv run --script skills/llm-wiki/scripts/wiki_graph_lint.py wiki/ --decide
python skills/llm-wiki/scripts/wiki_decide.py contradictions --wiki wiki/
python skills/llm-wiki/scripts/wiki_decide.py shortlist raw/new-source.md --wiki wiki/
python skills/llm-wiki/scripts/wiki_decide.py screen raw/new-clipping.md
```

Without `--decide`, search and graph lint output does not change.

## Turn it on for a hosted wiki

Open `/setup`, sign in, and change the decision settings for the wiki. Or use the CLI with an admin token:

```bash
python3 skills/llm-wiki/scripts/wiki_remote.py settings --set decisions.enabled=true
python3 skills/llm-wiki/scripts/wiki_remote.py settings --set decisions.backend=workers-ai
```

| Setting | Meaning | Default |
|---|---|---|
| `decisions.enabled` | Turn the layer on | `false` |
| `decisions.backend` | `workers-ai`, `typesafe`, `openrouter` or `liquid` | `workers-ai` |
| `decisions.model` | Pinned model id | Backend default |
| `decisions.search_gate` | Gate every search, not only searches with `decide: true` | `false` |
| `decisions.screen_writes` | Screen new or replaced pages under `sources/` | `false` |
| `decisions.relevance_threshold` | Probability needed to keep a search row | `0.65` |
| `decisions.screen_threshold` | Probability that makes an `untrusted_text` flag | `0.7` |
| `decisions.timeout_ms` | Timeout for one call | `4000` |

Review flags show in `wiki_lint` results and at `/ui/<wiki>/review`. Accept or dismiss them there, or with `wiki_remote.py review --resolve <id> --status accepted`.

## Evaluate first

The eval uses only synthetic fixtures under `eval/decisions/`. Do not send private wiki text to a hosted backend to test it.

```bash
python eval/decisions/run_eval.py --backend fake                  # no network
python eval/decisions/run_eval.py --backend local --out results.json
```

Compare each backend with the plain baseline (no gate, or exact text match). Set a threshold only from a held-out split. To test with your own queries, use the `local` backend.

### Measured results (2026-10-29)

The default thresholds come from one live run of the synthetic eval with the `local` backend: llama.cpp b11976 and `LiquidAI/d1-2B-GGUF:Q8_0`, lexical search, 1,179 requests, 0 errors. The raw numbers are in `eval/decisions/results-local-d1-2b.json`.

| Check | Threshold | Held-out half |
|---|---|---|
| D1 relevance gate | 0.65 | No-answer queries that return rows: 100% to 0%. Recall@5: 1.0 to 1.0. |
| D2 evidence check | 0.55 | Precision 1.0, recall 1.0 |
| D3 contradictions | 0.5 | Precision 1.0, recall 1.0 |
| D5 untrusted text | 0.7 | Precision 1.0, recall 1.0 |

The fixtures are small, so these numbers are optimistic. Jev was not measured, because no paid credits were available for the run. Run the eval with your backend before you turn on a check.
