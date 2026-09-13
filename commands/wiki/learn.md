---
description: Capture verified task experience and consolidate reusable lessons in the wiki.
argument-hint: "<task artifact or experience record>"
---

Use the `llm-wiki` skill and read `references/evolution-workflow.md`.

Input: $ARGUMENTS

Resolve the configured wiki/raw roots and read SCHEMA.md and the relevant index first. Inspect actual task actions and verification artifacts, not just an agent's self-assessment. Capture a success or failure with `wiki_evolve.py capture`, then ingest its immutable raw JSON as a source and consolidate an evidence-linked concept pattern. Separate observed facts from causal hypotheses, record applicability/model/tool versions and counterexamples, and update normal links, index and log. Reuse existing patterns rather than duplicating them. Do not invent missing experience or collect private model reasoning. Do not change any skill or launch paid evaluations as part of capture. Report the saved evidence, lesson and unresolved uncertainty.
