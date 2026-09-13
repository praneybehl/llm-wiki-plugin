# Public project workflow study

This suite exercises repository workflows, including ingestion, source/concept provenance, index/log updates, graph compilation, hybrid retrieval and corrections to a stale concept. It contains 4 training tasks, 4 validation tasks and 8 final tasks. The raw inputs are snapshots of this public repository at commit `06369b2eb0617bf7b07b2b8a5c07f4aca1fb1bf0`; `source-manifest.json` records their hashes. The stale concept is explicitly labeled evaluation data.

`protocol.json` freezes two optimization iterations and one execution per comparison, with Codex inference and Claude transfer. Only validation selects the skill. The eight final tasks remain outside consolidation and proposal inputs. The statistical unit is a task, with repeats clustered; each of the two agent comparisons uses a 97.5% bootstrap interval and a paired randomization threshold of 0.025. This small, purpose-built sample can detect large consistent effects, not establish general performance across arbitrary wikis.

Implementation checks and live model evidence are distinct. `adapter-checks.json` records account checks and their limits. Protocol tests exercise all nine native runner paths with recorded-format messages; they do not prove that an unavailable account or gateway works. Reported CLI dollar values can be model-price estimates under a subscription, not additional billed charges. Codex does not report USD, so a mixed study's aggregate dollar cost remains unknown.

## Measured result (2026-09-13)

The frozen study completed 117 runner calls and 56 executions in 68.5 minutes. Both proposals were rejected: validation was 3/4 versus 2/4 in iteration one and 2/4 versus 1/4 in iteration two. The selected skill is byte-identical to the baseline, so no evolution benefit was demonstrated and no installed skill changed.

| Final comparison | Baseline | Selected | Paired change, 97.5% task-bootstrap interval |
| --- | --- | --- | --- |
| Codex | 3/8 | 2/8 | -12.5 percentage points, [-62.5, +37.5] |
| Claude | 3/8 | 3/8 | 0 percentage points, [-37.5, +37.5] |

These differences measure execution variability with the same skill. Both paired randomization p-values are 1.0. The metric is an end-to-end pass rate covering semantic grading, exact evidence, artifacts and write boundaries, not a pure measure of answer accuracy. Seven final executions had an affirmative semantic verdict but failed the frozen quotation contract; some cited observed artifacts that were not valid evidence targets. The corrected runtime accepts exact artifact quotations and supplies every changed text artifact while keeping factual sources distinct. The original scores were not recomputed or used for further selection.

[`live-results.json`](./live-results.json) includes every verdict, overlapping failure counts, uncertainty, actual reported model IDs, usage and archive hashes. All judge, maintainer and proposer calls used zero tools. Aggregate USD is unknown because Codex does not report it; Claude's reported model costs under the existing subscription are not evidence of additional billing. The frozen skill/evidence export passed verification across 662 files; its manifest hash is recorded in the report. Full private traces, earlier stopped attempts and the export are retained in the owner's wiki raw evidence archive.

The additional Pi/OMP preflights below exercise the corrected runtime. They do not turn this negative study into evidence of quality improvement. Five native hosts and the bounded API runner still lack complete live validation because of the recorded account/client/gateway/key requirements.

## Reproduce

For the published measurement, extract `skills/llm-wiki/scripts/wiki_evolve*.py` from commit `e3f2babcc44c7a7c01fee0c5fdc21b9a7e02eb5e` into a separate checkout and apply `frozen-runtime.patch` with `git apply`. The patch removes later error-message logging; all six resulting scripts were verified byte-for-byte against the frozen run. This reconstructs the measured runtime; hosted model outputs remain stochastic. The current runtime additionally corrects artifact evidence handling; running it measures the corrected implementation and must be reported separately from the original measurement.

1. Install and authenticate the selected native CLIs. Copy `../pilot/config.example.json`; use absolute runner paths and exact supported model IDs. Set two iterations, one repeat, `max_calls: 160`, `max_seconds: 7200`, `timeout: 480` and `max_usd: null`. Add a Claude transfer runner to reproduce the second-agent comparison.
2. Prepare a Python interpreter with FastEmbed 0.8.0, sqlite-vec 0.1.9 and PyYAML 6.0.3. Set its absolute path as top-level `runtime_python`. Run the supplied `setup_wiki.py` against the fixture corpus once to cache the model and verify hybrid readiness. Subsequent runs can use `HF_HUB_OFFLINE=1` and `ORT_DISABLE_TELEMETRY=1`.
3. Initialize a disposable learning wiki with `init_wiki.py`. Use a separate working copy of the baseline skill; the measured baseline is the public commit above. Run `wiki_evolve_loop.py --wiki /path/to/learning/wiki --raw /path/to/learning/raw --skill /path/to/baseline/skill --id fresh-run --suite /absolute/path/to/this/suite.json --config /path/to/config.json`.
4. Keep the archive, including failed attempts. Export a completed run with `wiki_evolve.py --wiki /path/to/learning/wiki export fresh-run --destination /path/to/new-bundle`; verify it with `verify-bundle`.

The suite is already checked in; regeneration is unnecessary for a trial. `build_suite.py` needs a Git checkout containing the pinned source commit. Published final questions are regression fixtures after exposure. Use fresh independently authored final tasks for a new generalization claim; do not move failed final tasks into training and keep calling the result an independent test.

## Development preflights

All preflights used training tasks; no final questions were used to repair infrastructure. Original failed verdicts are retained, rather than rewritten as passing scores.

- Claude completed ingestion, graph extraction and hybrid retrieval. Codex initially selected a plain Python interpreter and correctly failed the hybrid-mode check; a shared prepared runtime removed that ambiguity.
- A later Codex run exposed an ONNX telemetry sidecar outside the wiki. Disabling ONNX telemetry removed the actual side effect, without weakening the workspace hash check.
- The judge initially lacked raw ingestion input, command output and protected-file comparisons. Those observations now accompany grading, so it can assess faithful summaries and completed actions.
- The first broader study was interrupted during validation after an agent copied an unnecessary host dependency cache; detached child cleanup and prepared-runtime instructions were corrected. The temporary copies were removed, preserving the original cache.
- The fifth attempt completed one two-repeat validation comparison (baseline 3/8, candidate 2/8, rejected) and a second training/proposal pass. Its second proposal deleted SKILL.md, which was correctly blocked but incorrectly ended the run. Invalid model-authored patches now remain rejected history while the last valid skill proceeds to final testing. The fresh full study retains two iterations and all tasks/agents, using one repeat to limit additional subscription use. No earlier attempt exposed final tasks.
- A later baseline ingestion also edited an unrelated protected concept. The original run stopped during validation. Completed write violations now score zero with preserved hashes and artifacts, while a fresh workspace permits the remaining comparisons to continue. The restriction is unchanged; malformed runner responses and authentication errors remain fatal.
- One fresh launch stopped during calibration: its positive answer did not explicitly answer whether the cache could replace Markdown. The positive paraphrase was clarified to cover the complete rubric. Both original calibration and corrected-run evidence remain available.

A live failure can expose an adapter, environment, judge or skill problem. Passing implementation tests alone closes none of those empirical questions. The study result must identify accepted/rejected proposals, final outcomes, transfer outcomes and uncertainty before claiming benefit.

## Additional adapter workflow checks

Pi and OMP each executed the `train-link-ingest` workflow through runtime `1eded4b`, after the artifact-evidence correction. Both passed all six artifact assertions, both actual-command checks, citations, evidence grounding and protected-file checks. OMP passed the semantic verdict; Pi was rejected for an alleged internal contradiction about the stats exception. That interpretation is debatable because the source explicitly states the exception later in the same list; the original verdict is preserved. `adapter-checks.json` records both outcomes, versions, usage and evidence hashes. These training preflights do not change the frozen study or establish improvement.

## Remediation coverage

| Original gap | Implemented behavior | Remaining empirical limit |
| --- | --- | --- |
| Cross-agent evaluation | Nine native adapters and subprocess protocol tests; explicit host/model selection | Five hosts need account/gateway setup; available hosts have workflow preflights, not universal transfer validation |
| Answer quality | Blinded semantic judge, calibration, exact evidence quotations, citations, abstention and artifact observations | A model judge is fallible; malformed quotations fail rather than silently passing |
| Clean comparison | Identical neutral runner boundaries, full skill injection with a hash, no rubric or variant label in inference | Provisioning proves content was supplied, not that a model followed it; progressive native skill discovery is not measured |
| Actual wiki workflow | Permitted mutations, protected-file hashes, actual command I/O, graph and hybrid-search artifacts, shared prepared runtime | Workflow completion and answer-quality improvement are measured separately; host-wide filesystem isolation depends on the native runner |
| Execution evidence | Fsynced public tool I/O as it arrives, surviving interrupted traces and process cleanup | Hosts can expose different detail; hidden reasoning is excluded |
| Consolidation and reuse | Executable experience-to-pattern consolidation, persistent history and exact repeated-proposal rejection | Similar-but-not-identical proposals remain a maintainer judgment |
| Independent final testing | Train/validation/final splits, frozen selection and consumed-test ledger | Legacy v1 holdout remains a regression gate; it is explicitly not an independent final set |
| Broader skill changes | Add/edit/delete coherent text files, create a new skill, carry PURPOSE mappings, export skill plus audit evidence | Bundles verify checksums, not the truth of an observation or a publisher signature |
| Evidence of benefit | Preregistered project workflow study, cross-agent comparison and task-level uncertainty analysis | Results must support any benefit claim; a rejected or tied candidate cannot demonstrate improvement |
| Spending control | Pre-request reservations for bounded first-party API inference; shared call/time admission for CLI subscriptions | Native opaque CLI calls cannot offer a hard USD guarantee; the API runner has no shell tool and needs a live API key |
