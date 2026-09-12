#!/usr/bin/env python3
"""Capture experience and validate evidence-linked, single-file skill improvements.

Stdlib only. Candidates run in copies; the installed skill changes only with
`apply`. `rollback` restores the accepted experiment's original file, refusing
concurrent edits. The local runner is a trusted executable, not a sandbox.

Examples:
  python wiki_evolve.py capture --raw ~/wiki/raw --record experience.json
  python wiki_evolve.py --wiki ~/wiki propose --id query-v1 --skill ./my-skill \
    --target references/query.md --candidate /tmp/query.md \
    --evidence concepts/stale-decisions.md --reason 'Resolve superseded decisions'
  python wiki_evolve.py --wiki ~/wiki evaluate query-v1 --suite suite.json \
    --runner runner.json --model model-version --tools tool-versions
  python wiki_evolve.py --wiki ~/wiki apply query-v1
  python wiki_evolve.py --wiki ~/wiki rollback query-v1
  python wiki_evolve.py --wiki ~/wiki history
"""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import difflib
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import uuid

IGNORED = {'.git', '__pycache__', '.wiki-cache', '.evolution', 'node_modules', '.wiki-evolve-lock'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def encode(value):
    return json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + '\n'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def slug(value):
    require(isinstance(value, str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', value),
            'IDs must be lowercase letters, numbers and hyphens (1-64 characters)')
    return value


def relative(value):
    path = Path(value)
    require(value and not path.is_absolute() and '..' not in path.parts
            and not any(p.startswith('.') for p in path.parts), 'Unsafe relative path')
    return path


def inside(root, value):
    path = root / relative(value)
    require(path.resolve().is_relative_to(root.resolve()), 'Path escapes its root')
    require(not any((root / Path(*path.relative_to(root).parts[:i])).is_symlink()
                    for i in range(1, len(path.relative_to(root).parts) + 1)),
            'Symlink paths are not supported')
    return path


def atomic(path, data, mode=None):
    fd, name = tempfile.mkstemp(prefix='.evolve-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if mode is not None:
            os.chmod(name, mode)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def tree(root):
    require(root.is_dir() and not root.is_symlink(), f'Not a regular directory: {root}')
    result = {}
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in IGNORED)
        for name in dirs + sorted(files):
            path = Path(directory) / name
            require(not path.is_symlink(), f'Symlink not allowed: {path}')
        for name in sorted(files):
            path = Path(directory) / name
            require(path.is_file(), f'Not a regular file: {path}')
            result[path.relative_to(root).as_posix()] = {
                'sha256': digest(path.read_bytes()), 'mode': path.stat().st_mode & 0o777,
            }
    return result


def copy_tree(source, dest):
    files = tree(source)
    dest.mkdir(parents=True, exist_ok=True)
    for name in files:
        target = dest / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / name, target)
    return files


@contextmanager
def locked(wiki):
    require((wiki / 'SCHEMA.md').is_file(), 'Select an initialized wiki with SCHEMA.md')
    state = wiki / '.evolution'
    require(not state.is_symlink(), 'Evolution directory cannot be a symlink')
    state.mkdir(exist_ok=True)
    lock = state / 'lock'
    # ponytail: one wiki-wide lock; use per-experiment locks if concurrent runs matter.
    try:
        lock.mkdir()
    except FileExistsError:
        raise ValueError(f'Evolution busy. If its process died, inspect then remove {lock}')
    try:
        yield state
    finally:
        lock.rmdir()


def event(exp, kind, payload):
    record = {'event': kind, 'at': datetime.now(timezone.utc).isoformat(), **payload}
    path = exp / f'{kind}-{uuid.uuid4().hex}.json'
    with path.open('x', encoding='utf-8') as f:
        f.write(encode(record))
    return record


def manifest(exp):
    value = read_json(exp / 'proposal.json')
    require(tree(exp / 'baseline') == value['baseline'], 'Baseline snapshot changed')
    require(tree(exp / 'candidate') == value['candidate'], 'Candidate snapshot changed')
    return value


def capture(args):
    record = read_json(args.record)
    slug(record.get('id'))
    for key in ('task', 'verification', 'model', 'tools', 'scope'):
        require(isinstance(record.get(key), str) and record[key].strip(), f'Missing {key}')
    require(record.get('outcome') in ('success', 'failure'), 'Outcome must be success or failure')
    require(isinstance(record.get('actions'), list) and record['actions']
            and all(isinstance(x, str) and x.strip() for x in record['actions']), 'Actions required')
    for key in ('hypothesis', 'counterexamples'):
        require(isinstance(record.get(key, ''), str), f'{key} must be text')
    raw = args.raw.resolve()
    require(raw.is_dir(), 'Raw root must already exist')
    folder = raw / 'experiences'
    require(not folder.is_symlink(), 'Experience directory cannot be a symlink')
    folder.mkdir(exist_ok=True)
    path = folder / (record['id'] + '.json')
    body = encode(record)
    if path.exists():
        require(not path.is_symlink() and path.read_text() == body, 'Immutable experience ID already exists')
    else:
        with path.open('x', encoding='utf-8') as f:
            f.write(body)
    return {'raw': str(path), 'sha256': digest(body.encode()), 'next': 'Ingest as a source; consolidate supported patterns'}


def propose(args, state):
    exp = state / slug(args.id)
    require(not exp.exists(), 'Experiment ID already exists; use a new ID')
    source = args.skill.resolve()
    require((source / 'SKILL.md').is_file(), 'Skill directory must contain SKILL.md')
    target = inside(source, args.target)
    require(target.is_file(), 'Target must be an existing file in this skill')
    before, after = target.read_text(encoding='utf-8'), args.candidate.read_text(encoding='utf-8')
    require(before != after and after.strip(), 'Candidate must be nonempty and different')
    require(args.reason.strip(), 'Proposal reason is required')
    evidence = {}
    for name in args.evidence:
        path = inside(args.wiki, name)
        require(path.suffix == '.md' and path.is_file(), 'Evidence must reference existing wiki Markdown')
        evidence[name] = path.read_text(encoding='utf-8')
    require(evidence, 'At least one evidence page is required')
    with tempfile.TemporaryDirectory(prefix='.staging-', dir=state) as tmp:
        staging = Path(tmp) / 'experiment'
        baseline = copy_tree(source, staging / 'baseline')
        copy_tree(source, staging / 'candidate')
        (staging / 'candidate' / args.target).write_text(after, encoding='utf-8')
        value = {'id': args.id, 'skill': str(source), 'target': args.target,
                 'reason': args.reason, 'evidence': evidence, 'baseline': baseline,
                 'candidate': tree(staging / 'candidate')}
        (staging / 'proposal.json').write_text(encode(value), encoding='utf-8')
        diff = ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
                                          fromfile='baseline/' + args.target, tofile='candidate/' + args.target))
        (staging / 'change.diff').write_text(diff, encoding='utf-8')
        staging.rename(exp)
    return {'id': args.id, 'status': 'proposed', 'diff': str(exp / 'change.diff')}


def finite(value, label):
    require(type(value) in (int, float) and math.isfinite(value) and value >= 0,
            f'{label} must be a finite nonnegative number')
    return value


def suite_contract(suite, corpus):
    require(suite.get('version') == 1, 'Suite version must be 1')
    tasks = suite.get('tasks')
    require(isinstance(tasks, list) and tasks, 'Suite tasks required')
    seen, splits = set(), set()
    for task in tasks:
        slug(task.get('id'))
        require(task['id'] not in seen, 'Duplicate task ID')
        seen.add(task['id'])
        require(task.get('split') in ('validation', 'holdout'), 'Use validation or holdout splits')
        splits.add(task['split'])
        require(isinstance(task.get('question'), str) and task['question'].strip(), 'Question required')
        require(type(task.get('abstain')) is bool, 'Expected abstain must be boolean')
        for key in ('answer_all', 'answer_none', 'citations'):
            require(isinstance(task.get(key), list) and all(isinstance(s, str) and s for s in task[key]),
                    f'{key} must be a list of nonempty strings')
        require(task['abstain'] or (task['answer_all'] and task['citations']),
                'Answerable tasks require answer checks and supporting citations')
        for name in task['citations']:
            require(inside(corpus, name).is_file(), f'Expected citation missing: {name}')
    require(splits == {'validation', 'holdout'}, 'Both validation and held-out tasks are required')
    for key in ('max_cost_ratio', 'max_tool_ratio'):
        finite(suite.get(key, 1.25), key)
    return tasks


def normalize(text):
    return ' '.join(text.casefold().split())


def score(task, output, corpus):
    require(isinstance(output, dict) and isinstance(output.get('answer'), str), 'Runner must return an answer')
    require(type(output.get('abstain')) is bool, 'Runner abstain must be boolean')
    calls = output.get('tool_calls')
    require(type(calls) is int and calls >= 0, 'Runner tool_calls must be a nonnegative integer')
    finite(output.get('cost'), 'Runner cost')
    citations = output.get('citations')
    require(isinstance(citations, list) and all(isinstance(c, str) for c in citations), 'Runner citations must be strings')
    valid = True
    for name in citations:
        try:
            valid = valid and inside(corpus, name).is_file()
        except ValueError:
            valid = False
    answer = normalize(output['answer'])
    checks = {
        'answer': all(normalize(s) in answer for s in task['answer_all']),
        'forbidden': not any(normalize(s) in answer for s in task['answer_none']),
        'citations': valid and set(task['citations']).issubset(citations),
        'abstain': output['abstain'] == task['abstain'],
    }
    return {'passed': all(checks.values()), 'checks': checks,
            'tool_calls': calls, 'cost': output['cost']}


def run_runner(argv, request, cwd, timeout):
    process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, cwd=cwd,
                               start_new_session=os.name == 'posix')
    try:
        stdout, stderr = process.communicate(encode(request), timeout=timeout)
        if process.returncode:
            raise ValueError(f'Runner exited {process.returncode}; no skill was applied')
        return json.loads(stdout)
    except BaseException:
        if os.name == 'posix':
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        elif process.poll() is None:
            subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True)
            process.kill()
        process.communicate()
        raise


def evaluate(args, exp):
    value = manifest(exp)
    require(not list(exp.glob('evaluation-*.json')) and not list(exp.glob('inputs-*.json')),
            'Evaluation already recorded or started; use a new proposal for a new trial')
    require(not (exp / 'transition.json').exists(), 'Cannot evaluate a promoted experiment')
    suite_path = args.suite.resolve()
    suite = read_json(suite_path)
    corpus = (suite_path.parent / relative(suite['corpus'])).resolve()
    runner = read_json(args.runner)
    require(isinstance(runner, list) and runner and all(isinstance(x, str) and x for x in runner),
            'Runner file must contain a nonempty JSON argv array (no shell)')
    finite(args.timeout, 'timeout')
    require(args.repeats >= 1 and args.timeout > 0, 'Positive repeats and timeout required')
    require(args.model.strip() and args.tools.strip(), 'Model and tool versions required')
    suite_contract(suite, corpus)
    # Preserve inputs before invoking a runner, including for failed/interrupted trials.
    event(exp, 'inputs', {'suite': suite, 'model': args.model, 'tools': args.tools,
                          'runner': runner, 'repeats': args.repeats, 'timeout': args.timeout,
                          'proposal_sha256': digest((exp / 'proposal.json').read_bytes())})
    corpus_hash = copy_tree(corpus, exp / 'corpus')
    # Every rollout receives a fresh copy of the archived inputs.
    with tempfile.TemporaryDirectory(prefix='wiki-evaluation-') as tmp:
        workspace = Path(tmp)
        require(copy_tree(exp / 'corpus', workspace / 'corpus') == corpus_hash,
                'Archived corpus changed during preparation')
        tasks = suite_contract(suite, workspace / 'corpus')
        rows = []
        try:
            for repeat in range(args.repeats):
                for task in tasks:
                    # Alternate order to reduce systematic warm-up/order effects.
                    variants = ('baseline', 'candidate') if repeat % 2 == 0 else ('candidate', 'baseline')
                    for variant in variants:
                        with tempfile.TemporaryDirectory(dir=workspace) as run_dir:
                            run = Path(run_dir)
                            copy_tree(exp / variant, run / 'skill')
                            copy_tree(workspace / 'corpus', run / 'wiki')
                            request = {'version': 1, 'question': task['question'],
                                       'skill_root': str(run / 'skill'), 'wiki_root': str(run / 'wiki'),
                                       'model': args.model, 'tools': args.tools}
                            output = run_runner(runner, request, run, args.timeout)
                            result = score(task, output, run / 'wiki')
                            # A query runner must not change its evidence or procedure.
                            require(tree(run / 'wiki') == corpus_hash, 'Runner modified the evaluation corpus')
                            require(tree(run / 'skill') == value[variant], 'Runner modified the skill')
                            rows.append({'task': task['id'], 'split': task['split'], 'repeat': repeat,
                                         'variant': variant, **result, 'output': output})
            manifest(exp)
            require(tree(exp / 'corpus') == corpus_hash, 'Archived corpus changed during evaluation')
            totals = {}
            for split in ('validation', 'holdout'):
                totals[split] = {variant: sum(r['passed'] for r in rows if r['split'] == split and r['variant'] == variant)
                                 for variant in ('baseline', 'candidate')}
            regressions = []
            paired = {(r['task'], r['repeat'], r['variant']): r for r in rows}
            for row in rows:
                if row['variant'] == 'baseline' and row['passed'] and not paired[(row['task'], row['repeat'], 'candidate')]['passed']:
                    regressions.append({'task': row['task'], 'repeat': row['repeat']})
            budgets = {}
            for metric, config in (('cost', 'max_cost_ratio'), ('tool_calls', 'max_tool_ratio')):
                amounts = {v: sum(r[metric] for r in rows if r['variant'] == v) for v in ('baseline', 'candidate')}
                budgets[metric] = {**amounts, 'ratio_limit': suite.get(config, 1.25),
                                   'passed': amounts['candidate'] <= amounts['baseline'] * suite.get(config, 1.25)}
            accepted = (totals['validation']['candidate'] > totals['validation']['baseline']
                        and totals['holdout']['candidate'] >= totals['holdout']['baseline']
                        and not regressions and all(b['passed'] for b in budgets.values()))
            report = {'status': 'passed' if accepted else 'rejected', 'totals': totals,
                      'regressions': regressions, 'budgets': budgets, 'rows': rows,
                      'model': args.model, 'tools': args.tools, 'runner': runner,
                      'suite': suite, 'corpus': corpus_hash, 'repeats': args.repeats,
                      'proposal_sha256': digest((exp / 'proposal.json').read_bytes())}
            event(exp, 'evaluation', report)
            return {k: v for k, v in report.items() if k not in ('rows', 'suite', 'corpus')}
        except (ValueError, OSError, subprocess.SubprocessError, KeyboardInterrupt) as exc:
            event(exp, 'evaluation', {'status': 'error', 'error': type(exc).__name__,
                                     'rows': rows, 'model': args.model, 'tools': args.tools})
            raise


def transition(exp, rollback=False):
    value = manifest(exp)
    source = Path(value['skill'])
    lock = source / '.wiki-evolve-lock'
    try:
        lock.mkdir()
    except FileExistsError:
        raise ValueError(f'Skill busy. If its process died, inspect then remove {lock}')
    try:
        return promote(exp, value, rollback)
    finally:
        lock.rmdir()


def promote(exp, value, rollback):
    source = Path(value['skill'])
    target = inside(source, value['target'])
    records = list(exp.glob('evaluation-*.json'))
    require(len(records) == 1, 'A completed evaluation is required')
    report = read_json(records[0])
    require(report['status'] == 'passed', 'Evaluation did not pass; installed skill is unchanged')
    require(tree(exp / 'corpus') == report['corpus'], 'Archived corpus changed after evaluation')
    require(report['proposal_sha256'] == digest((exp / 'proposal.json').read_bytes()), 'Proposal changed after evaluation')
    journal = exp / 'transition.json'
    current = read_json(journal) if journal.exists() else {'status': 'proposed'}
    if rollback:
        require(current['status'] in ('accepted', 'rolling_back', 'rolled_back'), 'Only accepted changes can be rolled back')
        before, after, pending, done = 'candidate', 'baseline', 'rolling_back', 'rolled_back'
    else:
        require(current['status'] in ('proposed', 'applying', 'accepted'), 'A rolled-back experiment cannot be reapplied')
        before, after, pending, done = 'baseline', 'candidate', 'applying', 'accepted'
    actual = tree(source)
    if current['status'] in (pending, done) and actual == value[after]:
        atomic(journal, encode({'status': done}).encode())
        return {'id': value['id'], 'status': done}
    require(actual == value[before], 'Installed skill changed; refusing to overwrite concurrent edits')
    require(current['status'] != done, 'Installed skill no longer matches completed transition')
    atomic(journal, encode({'status': pending}).encode())
    atomic(target, (exp / after / value['target']).read_bytes(), value[after][value['target']]['mode'])
    atomic(journal, encode({'status': done}).encode())
    event(exp, done, {'target': str(target)})
    return {'id': value['id'], 'status': done}


def history(state):
    rows = []
    for exp in sorted(state.iterdir()):
        if not exp.is_dir() or exp.is_symlink() or not (exp / 'proposal.json').is_file():
            continue
        value = read_json(exp / 'proposal.json')
        evaluations = [read_json(p) for p in exp.glob('evaluation-*.json')]
        status = evaluations[0]['status'] if evaluations else ('incomplete' if list(exp.glob('inputs-*.json')) else 'proposed')
        if (exp / 'transition.json').exists():
            status = read_json(exp / 'transition.json')['status']
        rows.append({'id': value['id'], 'reason': value['reason'], 'target': value['target'],
                     'status': status, 'evidence': list(value['evidence'])})
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--wiki', type=Path, default=Path('wiki'))
    sub = parser.add_subparsers(dest='action', required=True)
    capture_parser = sub.add_parser('capture', help='Save a verified experience as immutable raw JSON')
    capture_parser.add_argument('--raw', type=Path, required=True)
    capture_parser.add_argument('--record', type=Path, required=True)
    p = sub.add_parser('propose', help='Snapshot one skill and stage an evidence-linked edit')
    for flag in ('id', 'target', 'reason'):
        p.add_argument('--' + flag, required=True)
    p.add_argument('--skill', type=Path, required=True)
    p.add_argument('--candidate', type=Path, required=True)
    p.add_argument('--evidence', action='append', required=True)
    p = sub.add_parser('evaluate', help='Compare both snapshots through a trusted local runner')
    p.add_argument('id')
    p.add_argument('--suite', type=Path, required=True)
    p.add_argument('--runner', type=Path, required=True)
    p.add_argument('--model', required=True)
    p.add_argument('--tools', required=True)
    p.add_argument('--repeats', type=int, default=3)
    p.add_argument('--timeout', type=float, default=120)
    for action in ('apply', 'rollback', 'show'):
        sub.add_parser(action).add_argument('id')
    sub.add_parser('history')
    args = parser.parse_args()
    try:
        if args.action == 'capture':
            result = capture(args)
        else:
            args.wiki = args.wiki.resolve()
            with locked(args.wiki) as state:
                if args.action == 'propose':
                    result = propose(args, state)
                elif args.action == 'history':
                    result = history(state)
                else:
                    exp = inside(state, slug(args.id))
                    if args.action == 'evaluate':
                        result = evaluate(args, exp)
                    elif args.action == 'show':
                        result = {'proposal': manifest(exp), 'inputs': [read_json(p) for p in exp.glob('inputs-*.json')], 'diff': (exp / 'change.diff').read_text(),
                                  'evaluations': [read_json(p) for p in exp.glob('evaluation-*.json')]}
                    else:
                        result = transition(exp, rollback=args.action == 'rollback')
        print(encode(result), end='')
        if args.action == 'evaluate' and result.get('status') == 'rejected':
            return 2
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as exc:
        print(f'Error: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
