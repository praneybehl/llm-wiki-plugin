---
description: Run a structural and semantic health check on the LLM Wiki.
argument-hint: "[--suggest-pages]"
---

Run a lint pass on the wiki using the `llm-wiki` skill's lint workflow.

Arguments (if any): $ARGUMENTS

0. Resolve `<WIKI_ROOT>` from an explicit user path, the nearest project instructions, global agent instructions, or finally the current project's `wiki/`. Never assume `${PWD}/wiki` when instructions name another wiki.
1. Read `<WIKI_ROOT>/SCHEMA.md` first if you haven't this session: it may declare additional lint rules.
2. Run the structural lint script: `python "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_lint.py" "<WIKI_ROOT>"`. Add `--suggest-pages` if I asked for it. This catches orphans, broken wikilinks, oversized pages, missing frontmatter, stale pages, and duplicate slugs.
2b. If `<WIKI_ROOT>/graph/ontology.yaml` exists, also run `uv run --script "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_graph_lint.py" "<WIKI_ROOT>"`. Triage typed-edge findings (unknown predicates, missing evidence, broken object refs, alias collisions) the same way as structural ones: propose fixes, don't apply silently. After approved fixes, suggest running `uv run --script "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_graph_extract.py" "<WIKI_ROOT>"`.
3. Walk through the structural findings with me and propose a fix for each: don't apply fixes silently. Wait for my approval per item or in batch.
4. Run the semantic pass: read the most recently updated pages and the most-linked-to hubs (use `python "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_search.py" "" --wiki "<WIKI_ROOT>" --top-linked 10` to find them). Look for contradictions with older pages, unstated cross-references, and concepts mentioned in many pages but lacking their own page.
5. Surface gaps: topics I've expressed interest in but haven't ingested yet, claims that newer sources have superseded.
6. After applying approved fixes, update the index entries that changed and append one line to `log.md` summarizing the lint pass.
7. If the lint report is too long for me to triage comfortably, that's a signal the cadence is wrong (lint more often) or the schema needs revision: call it out.

**Hosted wiki.** If the resolved wiki is a hosted URL (or the instructions name one), use hosted mode from `skills/llm-wiki/references/hosted-mode.md`: the MCP tools, or `python3 "${CLAUDE_PLUGIN_ROOT}/skills/llm-wiki/scripts/wiki_remote.py"` when MCP is not available. Use these forms of the steps above:

- Step 1: call `wiki_overview` for `SCHEMA.md`.
- Steps 2 and 2b: call `wiki_lint`. It returns structural findings, graph findings and open review flags in one result. No extract step is necessary.
- Step 4: `wiki_search` with `top_linked: 10`, then `wiki_read`.
- Step 6: apply approved fixes with `wiki_commit` (`edit`, or `move` and `delete` with `base_rev`). `move` does not change links, so edit the referring pages in the same commit. Add the `log.md` line with an `append` operation.
- Show open review flags with the other findings. Resolve each one only after my decision: `wiki_remote.py review --resolve <id> --status accepted|dismissed`.

If I enabled the optional decision layer, add `--decide` to `wiki_graph_lint.py` or `decide: true` to `wiki_lint`, and offer `wiki_decide.py contradictions` for a local wiki. See `skills/llm-wiki/references/decision-models.md`.
