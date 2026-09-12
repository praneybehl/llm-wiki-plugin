#!/usr/bin/env python3
"""Bounded WikiSkill cycle: train, consolidate, propose, validate, then test once.

Run: python wiki_evolve_loop.py --wiki WIKI --id RUN --skill SKILL --suite SUITE --config CONFIG
All runners are trusted local executables. No installed skill is changed by a run.
"""
import argparse
import fnmatch
import json
import re
from pathlib import Path
import shutil
import sys
import tempfile
import time
from types import SimpleNamespace

from wiki_evolve import (atomic, copy_tree, digest, encode, event, finite, inside, locked,
                         propose, read_json, require, run_runner, slug, tree, capture)


def contract(suite, corpus):
    require(suite.get('version') == 2, 'Loop requires suite version 2')
    tasks = suite.get('tasks')
    require(isinstance(tasks, list) and tasks, 'Tasks required')
    ids, questions, splits = set(), set(), set()
    for task in tasks:
        slug(task.get('id'))
        require(task['id'] not in ids, 'Duplicate task ID')
        ids.add(task['id'])
        require(task.get('split') in ('train', 'validation', 'test'), 'Use train, validation and test splits')
        splits.add(task['split'])
        question = task.get('question')
        require(isinstance(question, str) and question.strip(), 'Task question required')
        require(question.strip().casefold() not in questions, 'Repeated question across tasks')
        questions.add(question.strip().casefold())
        require(isinstance(task.get('rubric'), str) and task['rubric'].strip(), 'Semantic rubric required')
        require(type(task.get('abstain')) is bool, 'Expected abstention required')
        require(isinstance(task.get('sources'), list), 'Expected sources required')
        for name in task['sources']:
            require(inside(corpus, name).is_file(), 'Rubric source missing')
        require(task['abstain'] or task['sources'] or task.get('artifacts'), 'Evidence or artifact checks required')
        for pattern in task.get('allow_write', []):
            require(isinstance(pattern, str) and pattern and not pattern.startswith(('/', '.'))
                    and '..' not in Path(pattern).parts, 'Unsafe write pattern')
        for check in task.get('artifacts', []):
            inside(corpus, check['path'])
            require(check.get('kind') in ('text', 'json', 'absent'), 'Unknown artifact check')
            if check['kind'] != 'absent':
                require('equals' in check, 'Artifact expected value required')
    require(splits == {'train', 'validation', 'test'}, 'All three independent splits required')
    calibration = suite.get('calibration')
    require(isinstance(calibration, list) and len(calibration) >= 2, 'Judge calibration needs positive and negative cases')
    require({c.get('passed') for c in calibration} == {True, False}, 'Calibration requires both verdicts')
    for case in calibration:
        require(type(case.get('passed')) is bool and type(case.get('abstain')) is bool, 'Calibration booleans required')
        for key in ('question', 'rubric', 'answer'):
            require(isinstance(case.get(key), str), 'Calibration text required')
        require(isinstance(case.get('sources'), list) and isinstance(case.get('citations'), list), 'Calibration sources required')
        for name in case['sources']:
            require(inside(corpus, name).is_file(), 'Calibration source missing')
    return tasks


def grounded_verdict(judge, sources, needs_evidence):
    require(type(judge.get('passed')) is bool and isinstance(judge.get('reason'), str), 'Judge verdict required')
    evidence = judge.get('evidence')
    require(isinstance(evidence, list), 'Judge evidence required')
    valid = all(isinstance(e, dict) and isinstance(e.get('quote'), str) and e['quote']
                and e.get('source') in sources and e['quote'] in sources[e['source']] for e in evidence)
    return bool(valid and (not needs_evidence or evidence))


def calibrate(suite, corpus, calls, work):
    results = []
    for case in suite['calibration']:
        request = {k: v for k, v in case.items() if k != 'passed'}
        request['sources'] = {p: inside(corpus, p).read_text() for p in case['sources']}
        result = calls.invoke('judge', request, work)
        require(grounded_verdict(result, request['sources'], case['passed'] and bool(request['sources']))
                and result['passed'] == case['passed'],
                'Judge failed calibration; revise the rubric or judge before evolving')
        results.append(result)
    return results


class Calls:
    """One ledger for inference, consolidation, proposal and judging, including failures."""
    def __init__(self, config, archive):
        self.config, self.archive = config, archive
        self.started = time.monotonic()
        self.count, self.tokens, self.cost = 0, 0, 0.0
        self.cost_known = True
        self.last_proposal = None
        budget = config['budget']
        for key in ('max_calls', 'max_seconds', 'timeout'):
            require(finite(budget[key], key) > 0, f'{key} must be positive')
        require(type(budget['max_calls']) is int, 'Call limit must be an integer')
        if budget.get('max_usd') is not None:
            require(finite(budget['max_usd'], 'max_usd') > 0, 'Positive USD limit required')
        for role in ('inference', 'maintainer', 'proposer', 'judge'):
            item = config[role]
            require(isinstance(item.get('argv'), list) and item['argv']
                    and all(isinstance(v, str) and v for v in item['argv']), 'Runner argv required')
            require(isinstance(item.get('model'), str) and item['model'], 'Model required for each role')

    def invoke(self, role, request, cwd):
        budget = self.config['budget']
        remaining = budget['max_seconds'] - (time.monotonic() - self.started)
        require(self.count < budget['max_calls'] and remaining > 0, 'Run call/time budget exhausted')
        usd = budget.get('max_usd')
        require(usd is None or (self.cost_known and self.cost < usd), 'Run USD budget exhausted or unavailable')
        self.count += 1
        item = self.config[role]
        request = dict(request, version=2, role=role, model=item['model'],
                       max_usd=None if usd is None else usd-self.cost)
        runner_files = {v: digest(Path(v).read_bytes()) for v in item['argv'] if Path(v).is_file()}
        record = {'number': self.count, 'role': role, 'request': request, 'runner': item,
                  'runner_files': runner_files}
        event(self.archive, 'call-start', record)
        try:
            output = run_runner(item['argv'], request, cwd, min(remaining, budget['timeout']))
            require(isinstance(output, dict), 'Runner output must be an object')
            if role == 'proposer':
                self.last_proposal = output
            require(type(output.get('tool_calls')) is int and output['tool_calls'] >= 0, 'Tool count required')
            require(isinstance(output.get('events'), list), 'Observable event trace required')
            usage = output.get('usage', {})
            for key in ('input_tokens', 'output_tokens'):
                require(type(usage.get(key)) is int and usage[key] >= 0, 'Measured token usage required')
            self.tokens += usage['input_tokens'] + usage['output_tokens']
            amount = output.get('cost')
            if amount is None:
                self.cost_known = False
            else:
                self.cost += finite(amount, 'Runner cost')
            require(usd is None or (self.cost_known and self.cost <= usd), 'Runner exceeded USD budget or omitted cost')
            event(self.archive, 'call-result', dict(record, output=output))
            return output
        except BaseException as exc:
            event(self.archive, 'call-error', dict(record, error=type(exc).__name__))
            raise

    def summary(self):
        return {'calls': self.count, 'tokens': self.tokens,
                'cost_usd': self.cost if self.cost_known else None,
                'elapsed_seconds': time.monotonic()-self.started}


def skill_text(root):
    # The entire procedure is injected, so skill retrieval cannot confound comparison.
    return {name: (root / name).read_text(encoding='utf-8') for name in tree(root)}


def artifact_checks(task, wiki):
    results = []
    for check in task.get('artifacts', []):
        path = inside(wiki, check['path'])
        if check['kind'] == 'absent':
            passed = not path.exists()
        elif not path.is_file():
            passed = False
        elif check['kind'] == 'text':
            passed = path.read_text(encoding='utf-8') == check['equals']
        else:
            try:
                passed = read_json(path) == check['equals']
            except ValueError:
                passed = False
        results.append(passed)
    return results


def rollout(task, skill, corpus, calls, archive, label):
    with tempfile.TemporaryDirectory(prefix='wiki-rollout-') as tmp:
        work = Path(tmp)
        before = copy_tree(corpus, work / 'wiki')
        frozen_skill = copy_tree(skill, work / 'skill')
        original_workspace = tree(work)
        supplied = skill_text(work / 'skill')
        request = {'question': task['question'], 'wiki_root': str(work / 'wiki'),
                   'skill_root': str(work / 'skill'), 'skill_files': supplied,
                   'skill_sha256': digest(encode(supplied).encode()),
                   'allow_write': task.get('allow_write', [])}
        output = calls.invoke('inference', request, work)
        require(output.get('skill_sha256') == request['skill_sha256'], 'Runner did not attest supplied skill injection')
        require(tree(work / 'skill') == frozen_skill, 'Inference modified skill')
        final_workspace = tree(work)
        require(all(name.startswith('wiki/') or original_workspace.get(name) == final_workspace.get(name)
                    for name in set(original_workspace) | set(final_workspace)), 'Inference wrote outside the task wiki')
        after = tree(work / 'wiki')
        changed = {p for p in set(before) | set(after) if before.get(p) != after.get(p)}
        allowed = task.get('allow_write', [])
        require(all(any(fnmatch.fnmatchcase(p, pattern) for pattern in allowed) for p in changed),
                'Inference changed a protected corpus file')
        require(isinstance(output.get('answer'), str) and type(output.get('abstain')) is bool,
                'Answer and abstention required')
        citations = output.get('citations')
        require(isinstance(citations, list) and all(isinstance(p, str) for p in citations), 'Citations required')
        valid = True
        for name in citations:
            try:
                valid = valid and inside(work / 'wiki', name).is_file()
            except ValueError:
                valid = False
        if task['sources'] and not task['abstain']:
            valid = valid and bool(citations)
        artifacts = artifact_checks(task, work / 'wiki')
        observations = {}
        for check, passed_check in zip(task.get('artifacts', []), artifacts):
            path = inside(work / 'wiki', check['path'])
            observations[check['path']] = {'check_passed': passed_check, 'exists': path.is_file(),
                                           'content': path.read_text() if path.is_file() else None}
        source_paths = set(task['sources']) | (set(citations) if valid else set())
        sources = {p: inside(work / 'wiki', p).read_text(encoding='utf-8') for p in source_paths}
        # The judge gets no model, variant, history, or skill instructions.
        judge = calls.invoke('judge', {'question': task['question'], 'rubric': task['rubric'],
                              'answer': output['answer'], 'abstain': output['abstain'],
                              'citations': citations, 'sources': sources, 'artifacts': observations}, work)
        grounded = grounded_verdict(judge, sources, not task['abstain'] and bool(sources))
        passed = (valid and all(artifacts) and output['abstain'] == task['abstain']
                  and judge['passed'] and grounded)
        row = {'task': task['id'], 'split': task['split'], 'label': label, 'passed': bool(passed),
               'question': task['question'], 'output': output, 'judge': judge,
               'model': calls.config['inference']['model'], 'runner': calls.config['inference']['argv'],
               'checks': {'citations': valid, 'artifacts': artifacts, 'grounding': bool(grounded)},
               'changed': sorted(changed)}
        # Preserve artifacts as evidence, not just a success claim.
        artifact_dir = archive / ('artifacts-' + slug(label) + '-' + task['id'])
        artifact_dir.mkdir()
        for p in changed:
            if p in after:
                target = inside(artifact_dir, p)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(work / 'wiki' / p, target)
        event(archive, 'rollout', row)
        return row


def evaluate(tasks, skill, corpus, calls, archive, label, repeats):
    return [rollout(task, skill, corpus, calls, archive, f'{label}-{repeat}')
            for repeat in range(repeats) for task in tasks]


def compare(tasks, skills, corpus, calls, archive, label, repeats):
    scores = {name: [] for name in skills}
    for repeat in range(repeats):
        order = list(skills) if repeat % 2 == 0 else list(reversed(skills))
        for variant in order:
            scores[variant] += evaluate(tasks, skills[variant], corpus, calls, archive,
                                        f'{label}-{repeat}-{variant}', 1)
    return scores


def consolidate(rows, patterns, history, calls, workspace, iteration):
    output = calls.invoke('maintainer', {'experiences': rows, 'patterns': patterns, 'history': history}, workspace)
    updates = output.get('patterns')
    require(isinstance(updates, list), 'Maintainer must return patterns')
    available = {r['task'] for r in rows}
    for pattern in updates:
        slug(pattern.get('id'))
        require(all(isinstance(pattern.get(k), str) and pattern[k].strip()
                    for k in ('claim', 'scope', 'counterexamples')), 'Pattern needs claim, scope and counterexamples')
        require(isinstance(pattern.get('evidence'), list) and pattern['evidence']
                and set(pattern['evidence']) <= available, 'Pattern must cite current observed tasks')
        prior = patterns.get(pattern['id'], {})
        patterns[pattern['id']] = dict(pattern, iteration=iteration, sources=prior.get('sources', []))
    return patterns


def publish_learning(args, rows, patterns, iteration):
    """Raw observable training evidence plus ordinary searchable source/concept pages."""
    raw = getattr(args, 'raw', None) or args.wiki.parent / 'raw'
    raw.mkdir(parents=True, exist_ok=True)
    today = time.strftime('%Y-%m-%d')
    source_names = []
    for row in rows:
        name = 'evolution-' + digest(f"{args.id}:{iteration}:{row['task']}".encode())[:20]
        record = {'id': name, 'task': row['question'], 'outcome': 'success' if row['passed'] else 'failure',
                  'actions': [encode(e).strip() for e in row['output']['events']] or ['No tool events observed'],
                  'verification': encode({'judge': row['judge'], 'checks': row['checks']}),
                  'model': row['model'], 'tools': encode(row['runner']).strip(),
                  'scope': 'training observation; not a causal generalization', 'observable': row}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'experience.json'
            path.write_text(encode(record))
            receipt = capture(SimpleNamespace(raw=raw, record=path))
        source = f'sources/{name}.md'
        target = inside(args.wiki, source)
        target.parent.mkdir(exist_ok=True)
        body = (f'---\ntitle: "Training observation {name}"\ntype: source\ntags: [skill-evolution]\n'
                f'created: {today}\nupdated: {today}\nauthors: ["Evolution runner"]\n'
                f'raw: {json.dumps(receipt["raw"])}\ningested: {today}\n---\n\n'
                f"Task: {row['question']}\n\nOutcome: {record['outcome']}\n\n"
                + row['judge']['reason'] + '\n')
        body = body.replace('—', '-')
        require(not target.exists() or target.read_text() == body, 'Training source already exists with different content')
        if not target.exists():
            target.write_text(body, encoding='utf-8')
        source_names.append(source)
    for key, pattern in patterns.items():
        if pattern.get('run') != args.id or pattern['iteration'] != iteration:
            continue
        pattern['sources'] = list(dict.fromkeys(pattern.get('sources', []) + source_names))
        pattern['page'] = 'concepts/evolution-pattern-' + key + '.md'
        target = args.wiki / 'concepts' / ('evolution-pattern-' + key + '.md')
        target.parent.mkdir(exist_ok=True)
        body = (f'---\ntitle: {json.dumps(key.replace("-", " "))}\ntype: concept\ntags: [skill-evolution]\n'
                f'created: {today}\nupdated: {today}\nsources: {json.dumps(pattern["sources"])}\n---\n\n'
                f"{pattern['claim']}\n\nScope: {pattern['scope']}\n\nCounterexamples: {pattern['counterexamples']}\n\n"
                + '\n'.join(f'- [[{name[:-3]}]]' for name in source_names) + '\n')
        if target.exists():
            previous = target.read_text(encoding='utf-8')
            previous = re.sub(r'^updated:.*$', 'updated: ' + today, previous, count=1, flags=re.M)
            previous = re.sub(r'^sources:.*$', 'sources: ' + json.dumps(pattern['sources']), previous, count=1, flags=re.M)
            body = previous.rstrip() + f'\n\n## Observation from {args.id}, iteration {iteration}\n\n' + body.split('---', 2)[2].lstrip()
        atomic(target, body.replace('—', '-').encode())
    index = args.wiki / 'index.md'
    old = index.read_text() if index.exists() else '# Index\n'
    links = source_names + [p['page'] for p in patterns.values() if p.get('page')]
    for name in links:
        line = f'- [[{name[:-3]}]]'
        if line not in old:
            old = old.rstrip() + '\n' + line + '\n'
    atomic(index, old.encode())
    log = args.wiki / 'log.md'
    old = log.read_text() if log.exists() else '# Log\n'
    line = f'- {today}: Captured training iteration {iteration} from evolution {args.id}.'
    if line not in old:
        atomic(log, (old.rstrip() + '\n' + line + '\n').encode())



def fingerprint(skill):
    return digest(encode({p: v for p, v in tree(skill).items() if p != 'PURPOSE.md'}).encode())


def run(args, state):
    archive = state / slug(args.id)
    require(not archive.exists(), 'Run ID exists; completed and interrupted runs cannot be resumed with exposed tests')
    require(not args.skill.is_symlink() and not args.skill.resolve().is_relative_to(state.resolve()),
            'Skill must be a working directory outside the experiment archive')
    require(not args.skill.exists() or (args.skill / 'SKILL.md').is_file() or not tree(args.skill),
            'Skill directory must contain SKILL.md or be empty')
    suite_path = args.suite.resolve()
    suite = read_json(suite_path)
    corpus = inside(suite_path.parent, suite['corpus'])
    tasks = contract(suite, corpus)
    consumed_path = state / 'consumed-tests.json'
    consumed = read_json(consumed_path) if consumed_path.exists() else {}
    test_keys = [digest(encode({'question': t['question'], 'rubric': t['rubric'],
                  'sources': {name: inside(corpus, name).read_text() for name in t['sources']}}).encode())
                 for t in tasks if t['split'] == 'test']
    require(not any(key in consumed for key in test_keys), 'Final-test tasks already exposed; supply fresh test tasks')
    config = read_json(args.config)
    slug(args.id + '-selected')
    require(type(config.get('iterations')) is int and config['iterations'] > 0, 'Positive iterations required')
    require(type(config.get('repeats')) is int and config['repeats'] > 0, 'Positive repeats required')
    archive.mkdir()
    calls = Calls(config, archive)
    atomic(archive / 'run-inputs.json', encode({'suite': suite, 'config': config, 'skill': str(args.skill)}).encode())
    runtime = archive / 'runtime'
    runtime.mkdir()
    for script in Path(__file__).parent.glob('wiki_evolve*.py'):
        shutil.copy2(script, runtime / script.name)
    atomic(archive / 'runtime-hashes.json', encode(tree(runtime)).encode())
    corpus_hash = copy_tree(corpus, archive / 'corpus')
    initial = archive / 'baseline'
    if args.skill.exists():
        copy_tree(args.skill, initial)
    else:
        initial.mkdir()
    copy_tree(initial, archive / 'best')
    learning_path = state / 'learning.json'
    learning = read_json(learning_path) if learning_path.exists() else {'patterns': {}, 'history': []}
    patterns, history = learning['patterns'], []
    prior_history = learning['history']
    seen = {fingerprint(initial)} | {h['fingerprint'] for h in prior_history if h['status'] == 'rejected' and h.get('baseline') == fingerprint(initial)}
    split = {s: [t for t in tasks if t['split'] == s] for s in ('train', 'validation', 'test')}
    try:
        with tempfile.TemporaryDirectory(prefix='wiki-evolution-') as tmp:
            work = Path(tmp)
            best = archive / 'best'
            calibrate(suite, archive / 'corpus', calls, work)
            for iteration in range(config['iterations']):
                rows = evaluate(split['train'], best, archive / 'corpus', calls, archive,
                                f'train-{iteration}', 1)
                publish_learning(args, rows, {}, iteration)
                patterns = consolidate(rows, patterns, prior_history + history, calls, work, iteration)
                for pattern in patterns.values():
                    if pattern.get('iteration') == iteration and not pattern.get('run'):
                        pattern['run'] = args.id
                publish_learning(args, rows, patterns, iteration)
                if not patterns:
                    event(archive, 'iteration', {'iteration': iteration, 'status': 'no-patterns'})
                    continue
                atomic(archive / 'patterns.json', encode(patterns).encode())
                proposal = calls.invoke('proposer', {'skill_files': skill_text(best), 'patterns': patterns,
                                        'experiences': rows, 'history': prior_history + history}, work)
                changes = proposal.get('changes')
                require(isinstance(changes, dict) and changes, 'Proposer must return nonempty file changes')
                require(isinstance(proposal.get('reason'), str) and proposal['reason'].strip(), 'Proposal reason required')
                evidence = proposal.get('evidence')
                require(isinstance(evidence, list) and evidence and set(evidence) <= set(patterns),
                        'Proposal must cite existing patterns')
                candidate = work / f'candidate-{iteration}'
                copy_tree(best, candidate)
                for name, body in changes.items():
                    path = inside(candidate, name)
                    require(body is None or isinstance(body, str), 'Changed files must contain text or null')
                    if body is None:
                        path.unlink(missing_ok=True)
                    else:
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_text(body, encoding='utf-8')
                require((candidate / 'SKILL.md').is_file() and (candidate / 'SKILL.md').read_text().strip(), 'Proposal must retain or create nonempty SKILL.md')
                purpose = '# Purpose\n\n' + proposal['reason'] + '\n\n'
                for key in evidence:
                    item = patterns[key]
                    purpose += f"## {key}\n\n{item['claim']}\n\nScope: {item['scope']}\n\nCounterexamples: {item['counterexamples']}\n\nEvidence: run {item.get('run', args.id)}, iteration {item['iteration']}, tasks {', '.join(item['evidence'])}.\n\n"
                (candidate / 'PURPOSE.md').write_text(purpose, encoding='utf-8')
                candidate_hash = fingerprint(candidate)
                entry = {'iteration': iteration, 'reason': proposal['reason'], 'changes': changes,
                         'evidence': evidence, 'fingerprint': candidate_hash, 'baseline': fingerprint(best), 'run': args.id}
                if candidate_hash in seen:
                    entry['status'] = 'duplicate'
                else:
                    seen.add(candidate_hash)
                    copy_tree(candidate, archive / f'candidate-{iteration}')
                    # Pair repeats and alternate order; only validation selects a candidate.
                    scores = compare(split['validation'], {'best': best, 'candidate': candidate},
                                     archive / 'corpus', calls, archive, f'validation-{iteration}', config['repeats'])
                    totals = {v: sum(r['passed'] for r in rs) for v, rs in scores.items()}
                    entry['validation'] = totals
                    limits = config.get('selection', {})
                    metrics = {}
                    for metric, setting in (('tool_calls', 'max_tool_ratio'), ('cost', 'max_cost_ratio')):
                        amounts = {v: [r['output'].get(metric) for r in rs] for v, rs in scores.items()}
                        limit = limits.get(setting)
                        if limit is not None:
                            finite(limit, setting)
                            require(all(x is not None for xs in amounts.values() for x in xs),
                                    'Selection metric unavailable; explicitly omit its ratio limit')
                        sums = {v: sum(xs) if all(x is not None for x in xs) else None for v, xs in amounts.items()}
                        metrics[metric] = dict(sums, limit=limit, passed=limit is None or sums['candidate'] <= sums['best'] * limit)
                    critical = [t['id'] for t in split['validation'] if t.get('critical')]
                    regressions = [tid for tid in critical if
                        sum(r['passed'] for r in scores['candidate'] if r['task'] == tid) <
                        sum(r['passed'] for r in scores['best'] if r['task'] == tid)]
                    entry['metrics'], entry['regressions'] = metrics, regressions
                    entry['status'] = 'accepted' if (totals['candidate'] > totals['best']
                        and all(m['passed'] for m in metrics.values()) and not regressions) else 'rejected'
                    if entry['status'] == 'accepted':
                        shutil.rmtree(best)
                        copy_tree(candidate, best)
                history.append(entry)
                event(archive, 'iteration', entry)
                atomic(learning_path, encode({'patterns': patterns, 'history': prior_history + history}).encode())
            # Freeze selection BEFORE final testing. Test results never enter patterns/proposer history.
            atomic(archive / 'selection.json', encode({'skill': tree(best), 'history': history}).encode())
            consumed.update({key: args.id for key in test_keys})
            atomic(consumed_path, encode(consumed).encode())
            final = compare(split['test'], {'baseline': initial, 'selected': best},
                            archive / 'corpus', calls, archive, 'test', config['repeats'])
            transfer = []
            original_inference = calls.config['inference']
            try:
                for number, runner in enumerate(config.get('transfer', [])):
                    calls.config['inference'] = runner
                    rows = compare(split['test'], {'baseline': initial, 'selected': best},
                                   archive / 'corpus', calls, archive, f'transfer-{number}', config['repeats'])
                    measured = {v: {'passed': sum(r['passed'] for r in rs), 'total': len(rs)} for v, rs in rows.items()}
                    transfer.append({'runner': runner, 'test': measured})
            finally:
                calls.config['inference'] = original_inference
            require(tree(archive / 'corpus') == corpus_hash, 'Archived corpus changed')
            report = {'status': 'completed', 'history': history,
                      'test': {v: {'passed': sum(r['passed'] for r in rows), 'total': len(rows)}
                               for v, rows in final.items()}, 'budget': calls.summary(),
                      'selected': tree(best), 'corpus': corpus_hash, 'transfer': transfer}
            # Promotion uses the existing reviewed proposal/rollback workflow.
            if tree(best) != tree(initial):
                evidence_dir = args.wiki / 'concepts'
                evidence_dir.mkdir(exist_ok=True)
                evidence_name = f'concepts/evolution-{args.id}.md'
                evidence_path = inside(args.wiki, evidence_name)
                require(not evidence_path.exists(), 'Evolution evidence page already exists')
                today = time.strftime('%Y-%m-%d')
                selected_sources = list(dict.fromkeys(p for pattern in patterns.values() for p in pattern.get('sources', [])))
                body = (f'---\ntitle: "Evolution {args.id}"\ntype: concept\ntags: [skill-evolution]\n'
                        f'created: {today}\nupdated: {today}\nsources: {json.dumps(selected_sources)}\n---\n\n'
                        + (best / 'PURPOSE.md').read_text() + '\n'.join(f'- [[{p[:-3]}]]' for p in selected_sources) + '\nSelection evidence: strict validation improvement. Final results remain in the experiment archive.\n')
                evidence_path.write_text(body.replace('—', '-'), encoding='utf-8')
                index = args.wiki / 'index.md'
                old = index.read_text() if index.exists() else '# Index\n'
                atomic(index, (old.rstrip() + f'\n- [[concepts/evolution-{args.id}]]\n').encode())
                proposal_id = slug(args.id + '-selected')
                propose(SimpleNamespace(id=proposal_id, skill=args.skill, target=None, candidate=best,
                                        wiki=args.wiki, evidence=[evidence_name], reason='Selected by bounded evolution validation'), state)
                exp = state / proposal_id
                copy_tree(archive / 'corpus', exp / 'corpus')
                # Test is a report, not another selection gate. Reviewer decides whether to apply.
                event(exp, 'evaluation', {'status': 'passed', 'selection': str(archive / 'selection.json'),
                      'final_test': report['test'], 'corpus': corpus_hash,
                      'proposal_sha256': digest((exp / 'proposal.json').read_bytes())})
                report['proposal'] = proposal_id
            event(archive, 'run', report)
            return report
    except BaseException as exc:
        # Retain failed proposal context, but never feed final-test outcomes into learning.
        if not (archive / 'selection.json').exists() and calls.last_proposal is not None:
            failure = {'run': args.id, 'status': 'error', 'error': type(exc).__name__,
                       'proposal': calls.last_proposal}
            atomic(learning_path, encode({'patterns': patterns, 'history': prior_history + history + [failure]}).encode())
        event(archive, 'run', {'status': 'error', 'error': type(exc).__name__, 'budget': calls.summary()})
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('wiki', 'skill', 'suite', 'config'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--id', required=True)
    parser.add_argument('--raw', type=Path, help='Immutable experiences; defaults to sibling raw directory')
    args = parser.parse_args()
    args.wiki, args.skill = args.wiki.resolve(), args.skill.absolute()
    try:
        with locked(args.wiki) as state:
            print(encode(run(args, state)), end='')
    except (ValueError, KeyError, TypeError, OSError) as exc:
        print(f'Error: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
