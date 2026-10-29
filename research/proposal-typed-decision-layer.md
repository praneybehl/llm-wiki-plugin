# Proposal: an optional typed-decision layer (Jev or local Laya)

Status: draft, not scheduled · Date: 2026-09-27 · Scope: `skills/llm-wiki/scripts`, `eval/retrieval`

## Summary

LLM Wiki's agent makes many small yes/no or pick-one decisions by reading prose instructions: which pages a new source touches, whether a search result is relevant, whether two claims contradict. A **typed-decision model** answers exactly that kind of question: state in, one choice with a probability out, no generated text.

Two backends speak the same request format:

| Backend | Where it runs | Cost | Licence |
|---|---|---|---|
| [TypeSafe Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) | Hosted API | ~$0.042 per million input tokens | Closed |
| [Laya](https://huggingface.co/convaiinnovations/laya) | Local (PyTorch, Apple MPS or CPU) | Free | Apache-2.0 |

Laya ships `laya-serve`, which exposes the same `POST /v1/systemone` request and response **schema** as Jev. One client with a configurable base URL could therefore talk to either. Schema compatibility is not equal quality. Laya's own card says its base checkpoints are near chance zero-shot on typed decisions, ship over-confident until calibrated, and leave only ~320 tokens for state on the English checkpoint.

**Recommendation:** add one decision first, a relevance reranker on search candidates. Keep it off by default. On the existing retrieval suite, filtering showed **no demonstrated retrieval improvement** (see Measurements). Build a larger, manually labeled hard-negative eval before adopting any backend or threshold. Offer Laya as the local choice and Jev as the opt-in hosted choice.

## Problem

- `wiki_search.py` fuses BM25 and embedding ranks with RRF and always returns its top N. It has no relevance cutoff. On a personal wiki, a query with no answer still returns five confident-looking sections, and the agent reads them.
- The retrieval eval already tracks this failure as `fp_rate` (`eval/retrieval/run_eval.py:53`, `:140`) and gates on it (`:224-225`). However, the fixture's five negative queries return no results at all, so the fixture cannot measure the problem it gates on.
- Ingest, query, and lint decisions are prose judgments inside the agent (`references/ingest-workflow.md`, `query-workflow.md`, `lint-workflow.md`). They cost full-model tokens, vary run to run, and leave no record of what was chosen or why.

## Where a typed decision fits

Ranked by value and by how easily it can be checked:

1. **Search relevance reranker** (query). Score a bounded candidate pool (for example the top 20 from hybrid search), then return the best 5. Filtering only the top 5 cannot recover a relevant page ranked 6th or lower. If nothing scores above the threshold, report "no sufficiently relevant result found" and broaden to the unfiltered search before concluding the wiki lacks an answer. The filter can discard a known answer (see q12 below), so an empty filtered set is never proof of absence.
2. **Ingest candidate pages** (ingest). Score index entries against the new source to shortlist pages to read and flag likely duplicates. The agent still reads and edits the pages.
3. **Claim relationship** (ingest and lint). For each pair of claims, choose `corroborates | contradicts | new-dimension | mentions`. This feeds the `## Contradictions` handling.
4. **Closed-set fields**: page `type`, graph predicate, `confidence`, `status`. All come from `SCHEMA.md` or `ontology.yaml`, and `wiki_graph_lint.py` already validates them afterwards.
5. **Evolution judge pre-filter** (`wiki_evolve_loop.py`). A cheap first pass before the LLM judge. It cannot replace the judge, because the judge must quote evidence verbatim and a typed model generates no text.

**Not suitable:** writing, merging, or summarising pages, generating slugs, or answering questions. The host agent keeps all writing.

## Design contract

This follows the "selector chooses, host checks" pattern from [Keel](https://github.com/codejunkie99/keel/blob/main/docs/decision-architecture.md):

1. The script prepares the options. The model never invents a page, label, or predicate.
2. The backend returns one choice (or a probability) per question.
3. The script validates the answer against the current option set. It fails open: on a timeout, an error, an invalid label, or a missing backend it returns today's unfiltered results.
4. A filter never deletes data and never blocks a write. It only reorders and narrows what the agent reads. Citations and local-only search stay the default.
5. Output keeps both the kept rows and the count dropped, so the agent can ask for the full list.
6. No threshold drives automatic dropping until a representative, labeled wiki-query eval and per-backend calibration support it.

Proposed surface for decision 1:

```text
wiki_search.py "query" --json --rerank [--rerank-pool 20] [--rerank-threshold <calibrated>]
```

Proposed configuration:

```text
LLM_WIKI_DECISIONS = off | laya | jev              (default off)
LLM_WIKI_DECISIONS_URL   (default http://127.0.0.1:8000 for laya, https://api.typesafe.ai for jev)
TYPESAFE_API_KEY         (jev only)
```

Request shape (identical for both backends):

```json
{
  "state": {"query": "...", "page_title": "...", "section": "...", "text": "..."},
  "questions": {"relevant": {"type": "choice",
    "instructions": "Does this wiki section help answer the search query?",
    "criteria": {"A": "yes, the section contains information that answers or directly addresses the query",
                 "B": "no, the section is unrelated or only superficially shares words with the query"}}}
}
```

Use a two-option `choice` with neutral keys rather than a yes/no (`noul`) question. Laya's model card documents `noul` answers sticking to their labels on the English checkpoint ([laya#156](https://github.com/NandhaKishorM/laya/issues/156)).

## Exploratory measurements (2026-09-27)

**Result: no demonstrated retrieval improvement on the existing suite.** On this fixture, the unfiltered baseline already has a negative-query false-positive rate of 0.0 (negatives return no results). Every filter lowered target recall@5 from 0.815 to 0.778 or worse. Nothing here shows that reranking fixes false positives.

Method: all 32 queries in `eval/retrieval/queries.json` were run through hybrid `wiki_search.py --top 5 --json` over the synthetic fixture corpus. This gave 116 `(query, section)` pairs. Each backend scored every pair with the request above. No private wiki content was used.

The `expected` slugs in `queries.json` are **query-level targets** used for recall in `run_eval.py`. They are not exhaustive relevance labels for every section. The "proxy" columns below treat every non-target section as irrelevant, so useful sections count as false positives. These numbers indicate relative ranking only. They are not accuracy, and they do not support a claim like "75% fewer irrelevant reads".

| Backend | Proxy AUROC (target vs non-target) | Rows kept at the highest threshold that still keeps recall@5 at 0.778 | Target recall@5 | Latency |
|---|---|---|---|---|
| Unfiltered baseline | – | 116 | 0.815 | – |
| Jev `jev-1.13.0` (hosted) | 0.885 | 29 (threshold 0.38) | 0.778 | 1.4 s for all 116, batched |
| Laya English, zero-shot (local) | 0.766 | 62 (threshold 0.51) | 0.778 | p50 110 ms per pair, M-series Mac |
| Laya `typed-decisions`, zero-shot (local) | 0.756 | 56 (threshold 0.68) | 0.778 | p50 93 ms per pair |

What this does and doesn't show:

- Every backend lost the target for q12, an odd paraphrase whose target section has no heading. A filter can discard a known answer.
- On this proxy, Jev ranked targets above non-targets more sharply than Laya zero-shot. Whether that reflects true relevance needs manual labels.
- Thresholds were picked on the same 116 pairs, so they are optimistic and not reusable.
- The fixture cannot test the motivating failure (plausible sections returned for a no-answer query). An earlier ad-hoc check on a private wiki suggested it happens, but that check sent private text to a hosted API and must not be repeated. Future checks use fixtures only.
- Cost and latency: Jev about $0.002 for the run. Laya's first call downloaded each ~800 MB checkpoint (3–4 minutes).

Laya's model card states the same limit: the base checkpoints are "a fast base to specialise, not a zero-shot decision engine". The card reports that fine-tuning plus fitting one calibration temperature per question type is what closes the gap. Laya's 512-token context on the English checkpoint (~320 tokens for state) is enough for search snippets but not for whole-source ingest decisions; `laya-multilingual` reads up to 8,192 tokens.

## Privacy

- **Laya:** everything stays on the machine, consistent with the README's promise of local search.
- **Jev:** the query and section text go to TypeSafe. It must be an explicit opt-in with a clear statement of what is sent. It must never become a default and never run from `setup_wiki.py` or init.
- `laya-serve` binds `0.0.0.0` with no authentication unless `LAYA_API_KEY` is set. Documentation must tell users to bind `127.0.0.1` or set the key.

## Rollout

1. **Labeled eval first.** Add at least 30 hard-negative queries that share vocabulary with the corpus but have no answer, plus manual relevance labels (relevant / partly / not) for every section in each query's top 20. Acceptance: unfiltered hybrid `fp_rate` > 0, and a second person has checked the labels.
2. **Decision client.** One small module in `scripts/` that posts the request to the configured URL, times out quickly, and returns `None` on any failure. Acceptance: offline tests with a fake server cover a valid answer, an invalid label, a timeout, and the backend being off.
3. **`--rerank` in `wiki_search.py`** behind the flag: score the top-20 pool, return the best 5, and fail open. Extend `run_eval.py` with a `hybrid+rerank` row. Acceptance, on the labeled set with calibration fitted on a held-out split: `fp_rate` falls, target recall@5 and recall@10 do not drop, and precision against the manual labels rises. With `off`, output is byte-identical to today.
4. **Laya calibration.** Fit one temperature per question on the held-out split and re-measure. Decide from the numbers whether Laya is good enough to recommend. A fine-tune is a separate proposal.
5. **Docs and release.** Document `laya-serve` setup, the Jev opt-in, and the privacy notes. Treat it as a minor version, per `AGENTS.md` release rules.

Decisions 2–5 in the ranked list wait until decision 1 shows a measured gain on the labeled set.

## Open questions

- Should the filter be the default in the query workflow when a backend is configured, or stay a flag the agent chooses?
- Should the plugin launch `laya-serve` itself or only document it? Launching adds a Python and PyTorch dependency, about 800 MB per checkpoint, to a plugin that currently needs only `uv`.
- Is a fine-tuned wiki-relevance Laya checkpoint worth maintaining, or is Jev opt-in plus "off" enough?
