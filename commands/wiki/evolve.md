---
description: Propose, evaluate, apply or roll back an evidence-linked skill improvement.
argument-hint: "<skill and improvement goal | history | show/apply/rollback experiment-id>"
---

Use the `llm-wiki` skill and read `references/evolution-workflow.md` before any action.

Request: $ARGUMENTS

Resolve the learning wiki, raw root, factual corpus and target skill separately. Read SCHEMA.md, relevant patterns and prior experiment history. Preserve authorization already given; do not ask again to perform authorized work.

For complete evolution, use `wiki_evolve_loop.py` with a version 2 suite and explicit role/model/budget configuration. Separate training, validation and untouched final tests. Calibrate the judge, capture observable outcomes, consolidate patterns, propose coherent changes to one complete skill, and retain rejected attempts. Use representative tasks, including ingestion/editing artifacts when relevant. The public fictional corpus only demonstrates the workflow. Freeze selection before final tests and optional cross-agent transfer; do not turn exposed test results into proposal feedback.

For a manual proposal, stage a candidate directory through `wiki_evolve.py propose`; `--target` remains available for one existing file. The legacy version 1 evaluator is a deterministic regression check, not independent final-test evidence. Review the complete diff, source grounding, artifacts, cost and actual answers. Fake-runner tests establish harness behavior only.

Apply only an evaluated, reviewed proposal when the user has authorized modifying that skill. Honor existing authorization. Roll back on request. Never bypass failed evaluations or concurrent-edit checks. Preserve raw evidence and failed attempts, update normal source/concept/synthesis pages, index and log, and report the measured result accurately. A history/show request is read-only. This command does not publish a plugin release or modify unrelated global instructions.
