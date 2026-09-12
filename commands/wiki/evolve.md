---
description: Propose, evaluate, apply or roll back an evidence-linked skill improvement.
argument-hint: "<skill and improvement goal | history | show/apply/rollback experiment-id>"
---

Use the `llm-wiki` skill and read `references/evolution-workflow.md` before any action.

Request: $ARGUMENTS

Resolve the configured wiki and the specific target skill separately. Read SCHEMA.md, relevant patterns/raw evidence, and `wiki_evolve.py history`. For a new improvement, diagnose the observed failure, preserve successful behavior, and prepare one existing-file candidate with evidence and a rationale. Stage it with `propose`; do not edit the live skill during evaluation. Inspect prior rejected proposals before repeating an intervention.

Choose an appropriate fixed corpus, validation tasks and fresh held-out tasks, a trusted runner, exact model/tool versions and an authorized inference budget. Use the bundled 20-task query pilot only where relevant; its public cases do not prove generalization. Evaluate both snapshots through `wiki_evolve.py evaluate`. Review the deterministic rubric and actual answers, not merely the aggregate score. A fake runner only verifies plumbing.

Use `apply` only if the result passed, the reviewed change is supported, and the user authorized editing that target skill. Honor authorization already given; do not request it again. Use `rollback` when asked to revert an accepted experiment. Never bypass a failing gate or concurrent-edit check. Preserve every failed or rejected attempt. Publish a cited synthesis of the result, update its pattern and index links, append to log.md, and report the measured benefit or rejection. A request for history/show is read-only. This command does not publish a plugin release or mutate global agent instructions.
