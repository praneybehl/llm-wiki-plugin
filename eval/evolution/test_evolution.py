#!/usr/bin/env python3
"""Runnable stdlib checks for the complete evolution lifecycle; no model calls.

python eval/evolution/test_evolution.py
The deterministic runner tests orchestration, not model quality.
"""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
SCRIPTS = REPO / 'skills/llm-wiki/scripts'
sys.path.insert(0, str(SCRIPTS))
import wiki_evolve as e
import wiki_evolve_claude as claude
import wiki_search
import wiki_lint
import init_wiki


def fails(fn, contains=None):
    try:
        fn()
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        if contains:
            assert contains in str(exc), str(exc)
    else:
        raise AssertionError('Expected failure')


def main():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp).resolve()
        wiki, skill, raw = root/'wiki', root/'skill', root/'raw'
        for p in (wiki, skill, raw): p.mkdir()
        (wiki/'SCHEMA.md').write_text('# Wiki\n')
        (wiki/'concepts').mkdir()
        (wiki/'concepts/lesson.md').write_text('---\ntype: concept\ntags: [test]\nsources: []\nupdated: 2026-09-12\n---\nLearn from evidence.\n')
        (skill/'SKILL.md').write_text('baseline\n')
        candidate = root/'candidate.md'; candidate.write_text('candidate\n')
        experience = root/'experience.json'
        data = {'id':'example', 'task':'query', 'outcome':'failure', 'verification':'checked source',
                'actions':['read wrong source'], 'model':'test', 'tools':'test', 'scope':'query'}
        experience.write_text(e.encode(data))
        captured = e.capture(SimpleNamespace(raw=raw, record=experience))
        assert Path(captured['raw']).exists()
        e.capture(SimpleNamespace(raw=raw, record=experience))  # exact retry is safe
        data['task']='different'; experience.write_text(e.encode(data))
        fails(lambda:e.capture(SimpleNamespace(raw=raw, record=experience)), 'Immutable')
        data['id']='../bad';experience.write_text(e.encode(data))
        fails(lambda:e.capture(SimpleNamespace(raw=raw, record=experience)))

        corpus=root/'corpus'; corpus.mkdir();(corpus/'fact.md').write_text('correct')
        suite={'version':1,'corpus':'corpus','tasks':[
            {'id':'v','split':'validation','question':'validation','abstain':False,
             'answer_all':['correct'],'answer_none':['incorrect'],'citations':['fact.md']},
            {'id':'h','split':'holdout','question':'holdout','abstain':True,
             'answer_all':[],'answer_none':[],'citations':[]}]}
        suite_path=root/'suite.json';suite_path.write_text(e.encode(suite))
        runner=root/'runner.py'
        runner.write_text('''import json,sys
from pathlib import Path
r=json.load(sys.stdin)
assert set(r)=={'version','question','skill_root','wiki_root','model','tools'}
assert not (Path(r['wiki_root'])/'.evolution').exists()
s=Path(r['skill_root'],'SKILL.md').read_text()
h=r['question']=='holdout'
if 'crash' in s: raise SystemExit(2)
if 'mutate' in s: Path(r['wiki_root'],'fact.md').write_text('changed')
print(json.dumps({'answer':'correct' if 'candidate' in s else 'wrong',
'abstain':h and 'regress' not in s,'citations':[] if h else ['fact.md'],
'tool_calls':1,'cost':3 if 'expensive' in s else 1}))
''')
        runner_json=root/'runner.json';runner_json.write_text(e.encode([sys.executable,str(runner)]))

        def proposal(state, name, content='candidate\n'):
            candidate.write_text(content)
            return e.propose(SimpleNamespace(id=name,skill=skill,target='SKILL.md',candidate=candidate,
                     evidence=['concepts/lesson.md'],reason='Address observed failure',wiki=wiki), state)
        def evaluate(state, name):
            return e.evaluate(SimpleNamespace(suite=suite_path,runner=runner_json,repeats=2,timeout=5,
                                             model='test-model',tools='test-tools'), state/name)
        with e.locked(wiki) as state:
            fails(lambda:e.locked(wiki).__enter__(), 'busy')
            proposal(state,'good')
            assert (skill/'SKILL.md').read_text()=='baseline\n'
            assert [p['slug'] for p in wiki_search.collect_pages(wiki)]==['lesson']
            assert len(wiki_lint.collect_pages(wiki)) == 1
            passed=evaluate(state,'good');assert passed['status']=='passed'
            assert (state/'good/corpus/fact.md').read_text()=='correct'
            assert list((state/'good').glob('inputs-*.json'))
            (corpus/'fact.md').write_text('later source change')
            assert (state/'good/corpus/fact.md').read_text()=='correct'
            (corpus/'fact.md').write_text('correct')
            (state/'good/corpus/fact.md').write_text('tampered')
            fails(lambda:e.transition(state/'good'), 'Archived corpus changed')
            (state/'good/corpus/fact.md').write_text('correct')
            assert passed['totals']['validation']=={'baseline':0,'candidate':2}
            fails(lambda:evaluate(state,'good'), 'already recorded')
            (skill/'SKILL.md').write_text('concurrent\n')
            fails(lambda:e.transition(state/'good'), 'concurrent edits')
            (skill/'SKILL.md').write_text('baseline\n')
            assert e.transition(state/'good')['status']=='accepted'
            assert (skill/'SKILL.md').read_text()=='candidate\n'
            assert e.transition(state/'good')['status']=='accepted'  # idempotent retry
            (skill/'other.md').write_text('new concurrent file')
            fails(lambda:e.transition(state/'good',True), 'concurrent edits')
            (skill/'other.md').unlink()
            assert e.transition(state/'good',True)['status']=='rolled_back'
            assert (skill/'SKILL.md').read_text()=='baseline\n'
            assert e.transition(state/'good',True)['status']=='rolled_back'
            fails(lambda:e.transition(state/'good'), 'cannot be reapplied')

            for name,body,status in [('reject','different\n','rejected'),
                                      ('regress','candidate regress\n','rejected'),
                                      ('cost','candidate expensive\n','rejected')]:
                proposal(state,name,body)
                assert evaluate(state,name)['status']==status
                fails(lambda:e.transition(state/name), 'did not pass')
                assert (skill/'SKILL.md').read_text()=='baseline\n'
            for name in ['crash','mutate']:
                proposal(state,name,'candidate '+name+'\n')
                fails(lambda:evaluate(state,name))
                assert e.read_json(next((state/name).glob('evaluation-*.json')))['status']=='error'
                fails(lambda:e.transition(state/name))
                assert list((state/name).glob('inputs-*.json'))
                assert (state/name/'corpus/fact.md').read_text()=='correct'
            proposal(state,'tamper')
            (state/'tamper/candidate/SKILL.md').write_text('tampered')
            fails(lambda:evaluate(state,'tamper'), 'snapshot changed')
            proposal(state,'recover')
            evaluate(state,'recover')
            # Crash after replacement but before completion receipt.
            (state/'recover/transition.json').write_text(e.encode({'status':'applying'}))
            (skill/'SKILL.md').write_text('candidate\n')
            assert e.transition(state/'recover')['status']=='accepted'
            e.transition(state/'recover',True)
            assert any(r['id']=='regress' and r['status']=='rejected' for r in e.history(state))
            assert (state/'reject/change.diff').exists()
            fails(lambda:proposal(state,'reject'), 'already exists')
        assert not (wiki/'.evolution/lock').exists()
        fails(lambda:e.inside(skill,'../escape'))
        (skill/'link').symlink_to(root)
        fails(lambda:e.tree(skill), 'Symlink')
        (skill/'link').unlink()
        invalid = {'answer':'correct','abstain':False,'citations':['../escape'],'tool_calls':0,'cost':0}
        assert not e.score(suite['tasks'][0],invalid,corpus)['passed']
        invalid['cost']=float('nan');fails(lambda:e.score(suite['tasks'][0],invalid,corpus))
        suite['tasks'][1]['split']='validation';fails(lambda:e.suite_contract(suite,corpus), 'held-out')
        fails(lambda:e.run_runner([sys.executable,'-c','import time; time.sleep(10)'],{},root,0.05))
        # Idempotent upgrade preserves schema and custom templates, while surfacing the new marker.
        (wiki/'.experience-template.json').write_text('custom')
        with mock.patch.object(init_wiki,'install_runtime'):
            init_wiki.init_wiki(root,'wiki','raw',upgrade=True)
            init_wiki.init_wiki(root,'wiki','raw',upgrade=True)
        assert (wiki/'.experience-template.json').read_text()=='custom'
        assert (wiki/'.pattern-template.md').is_file()
        assert (wiki/'.evolution/README.md').is_file()
        assert any(g['marker']=='## Skill evolution' for g in init_wiki.detect_schema_gaps(wiki/'SCHEMA.md'))

    starter=e.read_json(REPO/'eval/evolution/pilot/suite.json')
    pilot=REPO/'eval/evolution/pilot/wiki'
    assert len(e.suite_contract(starter,pilot))==20
    for task in starter['tasks']:
        sources=' '.join((pilot/c).read_text() for c in task['citations'])
        assert all(e.normalize(s) in e.normalize(sources) for s in task['answer_all'])
    events=[{'type':'assistant','message':{'content':[{'type':'tool_use','id':'a','name':'Read'}]}},
            {'type':'result','subtype':'success','is_error':False,'structured_output':
             {'answer':'yes','citations':[],'abstain':False},'total_cost_usd':0.01}]
    parsed=claude.parse_events('\n'.join(json.dumps(v) for v in events))
    assert parsed['tool_calls']==1 and parsed['cost']==0.01
    fails(lambda:claude.parse_events('{}'))
    print('Evolution lifecycle, rejection, recovery, isolation, validation and pilot contracts: PASS')


if __name__=='__main__': main()
