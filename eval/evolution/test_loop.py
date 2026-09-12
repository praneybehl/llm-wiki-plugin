#!/usr/bin/env python3
"""Offline integration of the complete cycle; fake inference is not performance evidence."""
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace

SCRIPTS = Path(__file__).resolve().parents[2] / 'skills/llm-wiki/scripts'
sys.path.insert(0, str(SCRIPTS))
import wiki_evolve as lifecycle
import wiki_evolve_loop as loop
import wiki_evolve_agent as agent


def fails(fn, text):
    try:
        fn()
    except ValueError as exc:
        assert text in str(exc), str(exc)
    else:
        raise AssertionError('Expected rejection: ' + text)


with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    wiki, corpus, skill = root / 'wiki', root / 'corpus', root / 'skill'
    for path in (wiki, corpus, skill):
        path.mkdir()
    (wiki / 'SCHEMA.md').write_text('schema')
    (corpus / 'source.md').write_text('The verified value is 42.')
    (skill / 'SKILL.md').write_text('baseline')
    runner = root / 'runner.py'
    runner.write_text('''import json,sys
from pathlib import Path
r=json.load(sys.stdin)
role=r['role']
o={'cost':0.01,'tool_calls':1,'events':[{'type':'tool_use','name':'Read','input':{'path':'source.md'}}],
   'usage':{'input_tokens':10,'output_tokens':10}}
if role=='inference':
    assert 'rubric' not in r and 'split' not in r and 'patterns' not in r
    good='learned' in r['skill_files'].get('SKILL.md','')
    o.update(answer='42' if good else '0',abstain=False,citations=['source.md'],skill_sha256=r['skill_sha256'])
    if good and r.get('allow_write'):
        (Path(r['wiki_root'])/'result.json').write_text('{"value":42}')
elif role=='judge':
    assert 'skill_files' not in r and 'label' not in r
    o.update(passed=r['answer']=='42',reason='checked numerical value',evidence=[{'source':'source.md','quote':'42'}])
elif role=='maintainer':
    assert all(x['split']=='train' for x in r['experiences'])
    assert 'TEST_SECRET' not in json.dumps(r)
    o.update(patterns=[{'id':'verify','claim':'Read source before answering','scope':'numeric tasks',
        'counterexamples':'none observed','evidence':[r['experiences'][0]['task']]}])
else:
    assert 'TEST_SECRET' not in json.dumps(r)
    o.update(changes={'SKILL.md':'learned','references/check.md':'Read source'},reason='Verify',evidence=['verify'])
if 'bad-quote' in sys.argv and role=='judge':
    o['evidence']=[{'source':'source.md','quote':'invented quotation'}]
if 'outside-write' in sys.argv and role=='inference':
    Path('unexpected.txt').write_text('outside wiki')
if 'missing-cost' in sys.argv:
    o['cost']=None
print(json.dumps(o))
''')
    suite = {'version': 2, 'corpus': 'corpus', 'tasks': [
        {'id': s, 'split': s, 'question': s + (' TEST_SECRET' if s == 'test' else ''),
         'rubric': 'Answer 42 with supporting source', 'abstain': False, 'sources': ['source.md'],
         **({'allow_write': ['result.json'], 'artifacts': [{'path': 'result.json', 'kind': 'json', 'equals': {'value':42}}]} if s == 'test' else {})}
        for s in ('train', 'validation', 'test')]}
    suite['calibration'] = [dict(question='grade', rubric='Answer 42', answer=answer, abstain=False,
                                 sources=['source.md'], citations=['source.md'], passed=passed)
                            for answer, passed in [('42', True), ('0', False)]]
    config = {'iterations': 2, 'repeats': 1, 'budget': {'max_calls': 40, 'max_seconds': 30,
              'timeout': 5, 'max_usd': None},
              **{role: {'argv': [sys.executable, str(runner)], 'model': 'offline-test'}
                 for role in ('inference', 'maintainer', 'proposer', 'judge')}}
    suite_path, config_path = root / 'suite.json', root / 'config.json'
    suite_path.write_text(json.dumps(suite))
    config_path.write_text(json.dumps(config))
    args = SimpleNamespace(wiki=wiki, id='cycle', skill=skill, suite=suite_path, config=config_path)
    with lifecycle.locked(wiki) as state:
        result = loop.run(args, state)
    assert result['test'] == {'baseline': {'passed':0,'total':1}, 'selected': {'passed':1,'total':1}}
    assert result['history'][0]['status'] == 'accepted'
    assert (skill / 'SKILL.md').read_text() == 'baseline'
    exp = state / result['proposal']
    lifecycle.transition(exp)
    assert (skill / 'references/check.md').is_file()
    assert (skill / 'PURPOSE.md').is_file()
    lifecycle.transition(exp, rollback=True)
    assert (skill / 'SKILL.md').read_text() == 'baseline'
    assert not (skill / 'references/check.md').exists()
    assert not (skill / 'PURPOSE.md').exists()
    fails(lambda: loop.run(args, state), 'Run ID exists')
    config['budget']['max_calls'] = 1
    config_path.write_text(json.dumps(config))
    args.id = 'budget'
    suite['tasks'][2]['question'] += ' budget-case'
    suite_path.write_text(json.dumps(suite))
    fails(lambda: loop.run(args, state), 'budget exhausted')
    assert len(list((state / 'budget').glob('call-start-*.json'))) == 1
    assert not (state / 'budget' / 'selection.json').exists()
    # New skill can be created and rolled back to an empty directory.
    config['budget']['max_calls'] = 40
    config_path.write_text(json.dumps(config))
    args.id, args.skill = 'new', root / 'new-skill'
    suite['tasks'][2]['question'] += ' new-skill-case'
    suite_path.write_text(json.dumps(suite))
    result = loop.run(args, state)
    lifecycle.transition(state / result['proposal'])
    assert (args.skill / 'SKILL.md').read_text() == 'learned'
    lifecycle.transition(state / result['proposal'], rollback=True)
    assert lifecycle.tree(args.skill) == {}
    args.id = 'reused-test'
    fails(lambda: loop.run(args, state), 'already exposed')
    for mode, message in [('bad-quote', 'failed calibration'), ('outside-write', 'outside the task wiki')]:
        args.id, args.skill = mode, skill
        suite['tasks'][2]['question'] += ' ' + mode
        suite_path.write_text(json.dumps(suite))
        for role in ('inference', 'maintainer', 'proposer', 'judge'):
            config[role]['argv'] = [sys.executable, str(runner), mode]
        config_path.write_text(json.dumps(config))
        fails(lambda: loop.run(args, state), message)
        assert not (state / mode / 'selection.json').exists()
    # Recover a real mixed multi-file transition, then refuse unrelated edits.
    candidate = state / 'cycle' / 'best'
    manual = SimpleNamespace(id='mixed', skill=skill, target=None, candidate=candidate, wiki=wiki,
                             evidence=['concepts/evolution-cycle.md'], reason='Recovery check')
    lifecycle.propose(manual, state)
    mixed = state / 'mixed'
    corpus_hash = lifecycle.copy_tree(corpus, mixed / 'corpus')
    lifecycle.event(mixed, 'evaluation', {'status':'passed','corpus':corpus_hash,
        'proposal_sha256':lifecycle.digest((mixed / 'proposal.json').read_bytes())})
    (mixed / 'transition.json').write_text('{"status":"applying"}')
    (skill / 'SKILL.md').write_bytes((candidate / 'SKILL.md').read_bytes())
    lifecycle.transition(mixed)
    assert lifecycle.tree(skill) == lifecycle.tree(candidate)
    (skill / 'unrelated.md').write_text('concurrent edit')
    fails(lambda: lifecycle.transition(mixed, rollback=True), 'concurrent edits')
    (skill / 'unrelated.md').unlink()
    lifecycle.transition(mixed, rollback=True)
    invalid = json.loads(json.dumps(suite))
    invalid['tasks'][2]['question'] = invalid['tasks'][0]['question']
    fails(lambda: loop.contract(invalid, corpus), 'Repeated question')
    # Observable events exclude reasoning and preserve tool output.
    parsed = agent.parse_codex('\n'.join(json.dumps(x) for x in [
        {'type':'item.completed','item':{'id':'r','type':'reasoning','text':'private'}},
        {'type':'item.completed','item':{'id':'x','type':'command_execution','aggregated_output':'42'}},
        {'type':'turn.completed','usage':{'input_tokens':10,'output_tokens':3}}]), {'answer':'42'})
    assert parsed['tool_calls'] == 1 and parsed['cost'] is None
    assert 'private' not in json.dumps(parsed)
    assert parsed['events'][0]['item']['aggregated_output'] == '42'
    bundle = root/'portable'
    lifecycle.export_bundle(state/'cycle', bundle)
    assert lifecycle.verify_bundle(bundle)['status'] == 'verified'
    assert (bundle/'skill/PURPOSE.md').is_file() and (bundle/'evidence/patterns.json').is_file()
    (bundle/'skill/SKILL.md').write_text('tampered')
    fails(lambda: lifecycle.verify_bundle(bundle), 'Bundle evidence or skill changed')
    (state/'cycle/corpus/source.md').write_text('tampered')
    fails(lambda: lifecycle.export_bundle(state/'cycle', root/'bad-export'), 'Archived corpus changed')
print('Complete evolution cycle, isolation, artifacts, budget, full-skill apply/rollback, new skill and adapter parsing: PASS')
