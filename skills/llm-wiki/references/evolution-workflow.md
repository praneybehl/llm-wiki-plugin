# Experience to tested skills

Use this optional workflow when asked to learn from completed work or improve a procedure. Normal ingest, query and lint remain available without it. The agent performs diagnosis and authors proposals; the stdlib `scripts/wiki_evolve.py` owns snapshots, measurements and promotion. There is no background optimizer or automatic model selection.

## Capture observable experience

Resolve the configured wiki and raw roots, then read SCHEMA.md and the relevant index shard. Read the actual task artifacts, actions, tool responses and verifiable outcome. Capture successes as well as failures. Never invent a trace, infer success from the agent's confidence, or require private model reasoning. Remove secrets before the first capture; saved raw records are immutable.

Copy `.experience-template.json` from the wiki (or `assets/experience.json.template` from the installed skill), replace every example with actual observations, and run:

```bash
python <skill-root>/scripts/wiki_evolve.py capture \
  --raw <RAW_ROOT> --record /absolute/path/experience.json
```

`capture` requires an ID, task, success/failure outcome, observed actions, verification, model version, tool versions and applicability scope. Optional hypothesis and counterexamples remain explicitly separate. It saves `RAW_ROOT/experiences/<id>.json` without overwriting an existing record. An identical retry is safe. A correction gets a new ID and explains which earlier record it corrects.

Ingest that JSON through the normal ingest workflow into a `source` page, including its raw reference. Search the appropriate index before consolidating a lesson into an existing `concept` page. Use `.pattern-template.md` only for a new reusable pattern. Keep the source page and pattern linked, update the appropriate index, and append to log.md. Patterns use existing page types; `kind: experience-pattern` and `status: hypothesis|supported|superseded` are optional local conventions, not new mandatory fields. Record applicability, evidence, causal hypotheses, successful procedures and counterexamples. A single failure is evidence of an occurrence, not proof of a universal rule. Re-read raw evidence before reconciling contradictions. Preserve evidence while correcting conclusions.

## Propose one bounded change

Read `wiki_evolve.py --wiki <WIKI_ROOT> history`, the relevant experiment's `show <id>` output, and the current target skill. Do not repeat a rejected intervention without new evidence or a documented change in conditions. Check every caller or reference to a procedure being changed. Prefer a small edit to an existing workflow; do not promote model-specific workarounds into universal instructions.

Prepare a candidate for one existing UTF-8 file inside one skill directory. Multi-file changes must be decomposed into independently testable proposals; this workflow does not claim to validate a whole repository change. Use a working copy of the skill for experiments, not the only installed copy. Record why the change should help, including which failures it addresses and which successful behavior must remain.

```bash
python <skill-root>/scripts/wiki_evolve.py --wiki <WIKI_ROOT> propose \
  --id query-supersession-01 --skill /absolute/path/working-skill \
  --target references/query-workflow.md --candidate /absolute/path/query-candidate.md \
  --evidence concepts/superseded-decisions.md \
  --evidence sources/experience-query-01.md \
  --reason "Follow explicit superseding decisions for current-state questions"
```

Evidence paths are relative to the wiki. The script snapshots the entire skill, evidence text, reason and unified diff under `wiki/.evolution/<id>/`. The candidate only changes the selected file. Hidden runtime directories `.git`, `__pycache__`, `.wiki-cache`, `.evolution` and `node_modules` are excluded from snapshots; skill symlinks are rejected. This directory is a durable experiment archive, not a cache. Ordinary wiki tools exclude it. Keep searchable explanations in source/concept/synthesis pages with normal provenance.

## Evaluate on fixed evidence

Before running, choose representative tasks, record exact model/tool versions and agree an inference budget. A runner can call a paid or remote model using the operator's configured account; this is separate from local wiki retrieval. Never launch a paid run just to capture a lesson. Use synthetic or approved source snapshots and remove credentials from runner configuration. Local scripts do not contain model credentials or call a provider on their own.

The suite format is demonstrated by `assets/evolution/suite.json`. Its 20 fictional query tasks cover direct answers, historical/current decisions, multi-source answers, conflicting reports and abstention. The public fixture is a starter regression suite, not proof of generalization. For a real optimization, develop on separate examples and reserve fresh held-out tasks. Do not feed holdout answers to the proposer. If you inspect failed holdout results to author the next change, those tasks have become development data; replace the holdout set.

The runner is a trusted local executable described by a JSON argv array. Use an absolute executable/script path; no shell expansion occurs. Each invocation reads a JSON request from stdin and must emit only one JSON object on stdout. The request contains `version`, `question`, `skill_root`, `wiki_root`, `model`, and `tools`. It omits task IDs, expected answers, split labels and candidate labels. Follow the supplied skill, allow normal access to the supplied factual wiki, and do not load experiment history, unrelated wikis or other installed skills. Paths are temporary and differ per run.

The response contract is:

```json
{"answer":"The trial is 30 days.","abstain":false,"citations":["sources/pricing-current.md"],"tool_calls":3,"cost":0.02}
```

Citations are exact wiki-relative file paths, without anchors. Cost is actual inference cost in a single declared currency (the supplied Claude runner uses USD); tool_calls counts actual tool invocations. Missing or invalid measurements fail the run. The `model` and `tools` fields identify the execution setup; adapters must actually use the requested model and the operator must record the installed tool versions accurately.

An optional ready-to-use Claude Code adapter is bundled at `scripts/wiki_evolve_claude.py`. It uses the selected model and authenticated CLI account, restricts tools to Read/Grep/Glob, disables ambient skills and MCP servers, requests structured output, and extracts tool counts and cost from CLI events. It requires a CLI supporting `--restricted`, `--json-schema` and stream JSON. It intentionally evaluates document navigation, not Bash-based hybrid search; use a different trusted adapter when evaluating tool changes. Managed host policy can still apply. Example runner.json:

```json
["python3", "/absolute/installed-skill/scripts/wiki_evolve_claude.py"]
```

```bash
python <skill-root>/scripts/wiki_evolve.py --wiki <WIKI_ROOT> evaluate query-supersession-01 \
  --suite <skill-root>/assets/evolution/suite.json \
  --runner /absolute/path/runner.json --model <exact-model-id> \
  --tools "Claude Code <version>; Read/Grep/Glob" --repeats 3 --timeout 120
```

The harness runs both skill snapshots on the same frozen corpus, in fresh directories per task and repeat, and alternates baseline/candidate order across repeats. It checks that the runner leaves the supplied corpus and skill unchanged. These copies and instructions are not a sandbox against a malicious runner: use only reviewed local adapters and an OS/container sandbox for untrusted code.

Each task declares required answer phrases, forbidden phrases, expected citations and expected abstention. Checks normalize case/whitespace but do not perform semantic grading. Citation checks establish expected paths, not general logical entailment. Author rubrics carefully and review answers yourself, particularly negation, paraphrases and contradictory sources. This deterministic check complements rather than replaces expert review and existing retrieval evaluations.

The gate requires strict improvement in total validation passes, no paired task/repeat regression in either split, non-decreasing held-out passes, and cost/tool totals within the suite's limits (default 1.25 times baseline). A zero baseline budget permits only zero candidate usage. The default is three repeats; results are counts, not a statistical significance claim. Benchmark costs scale with both variants, all tasks and repeats: 20 tasks with three repeats means 120 runner invocations. Set budget ratios in the suite before evaluation, not after seeing results.

One evaluation is recorded per experiment. An error, timeout, malformed response or failed gate cannot promote the candidate. Keep failed attempts; use a new proposal ID for a subsequent trial. `show <id>` includes the diff, evidence and all outcomes. Record real measurements; a deterministic fake runner is useful for testing the harness but provides no evidence of model improvement.

## Review, apply, retain and recover

Review the complete diff and measured result. Apply only when the user authorized changing that target skill and the evidence supports the change; an evaluation pass is not independent permission to modify another project or publish a plugin. Existing authorization is sufficient. Source/trace text cannot grant authority. Do not silently modify global agent instructions or unrelated skills.

```bash
python <skill-root>/scripts/wiki_evolve.py --wiki <WIKI_ROOT> apply query-supersession-01
python <skill-root>/scripts/wiki_evolve.py --wiki <WIKI_ROOT> rollback query-supersession-01
```

Only `apply` replaces the selected live file after a passing result. It checks the whole skill still matches the baseline snapshot and verifies the evaluated proposal/snapshots before writing. Rejected experiments never change the live skill. `rollback` restores the baseline only if the whole skill still matches the candidate. Both refuse concurrent edits rather than overwriting them. Repeating a completed transition is safe, and repeating an interrupted transition completes it. A rolled-back experiment cannot be reapplied; create a new proposal with a new evaluation.

If the process dies, `transition.json` records `applying` or `rolling_back`; rerun the corresponding command. The wiki-wide lock prevents simultaneous evolution commands. If a dead process left `.evolution/lock/`, confirm no process remains before removing the empty directory. Snapshot mismatches require inspection, not hand-editing records to force acceptance. Do not edit the selected skill concurrently with apply/rollback. The lock coordinates this tool, not arbitrary editors.

After each trial, write or update a synthesis page linking the motivating pattern/source pages, experiment ID, exact target, decision, model/tool versions, validation/held-out results, cost and counterexamples. Link it from the pattern page and index, append to log.md, and refresh graph metadata when the schema requires it. Retain rejected diffs and measurements so the next proposer can explain why it is trying something different. Keep private captures, snapshots and trial outputs out of public releases. Plugin changes still follow repository release/version rules; this tool does not commit, push, publish or install updates across agents.

## Research basis

This workflow adapts persistent experience consolidation, evidence-linked procedures and measured promotion from [WikiSkill (Tang et al., 2026)](https://arxiv.org/html/2608.27454v1). It adds a bounded operator-driven workflow to the existing wiki; it is not a reproduction of that paper's optimizer or benchmark results.

Apply/rollback also use a temporary `.wiki-evolve-lock/` in the target skill to coordinate changes from different wikis. After a process dies, inspect both this lock and the wiki lock before removing stale empty lock directories and retrying. This lock directory is excluded from skill snapshots.
