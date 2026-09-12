#!/usr/bin/env python3
"""Protocol and failure integration tests; these do not claim live model gains."""
from datetime import date
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

SCRIPTS = Path(__file__).resolve().parents[2] / 'skills/llm-wiki/scripts'
sys.path.insert(0, str(SCRIPTS))
import wiki_evolve as lifecycle
import wiki_evolve_api as api
import wiki_evolve_loop as loop

# Pricing expires in production; protocol fixtures use the reviewed date.
class ReviewedDate(date):
    @classmethod
    def today(cls):
        return cls(2026, 9, 13)
api.date = ReviewedDate
from wiki_evolve_stream import parse_native


def fails(fn, phrase):
    try:
        fn()
    except ValueError as exc:
        assert phrase in str(exc), str(exc)
    else:
        raise AssertionError('Expected failure: ' + phrase)


answer = {'answer': '42', 'citations': ['source.md'], 'abstain': False}
text = json.dumps(answer)
usage = {'input': 8, 'output': 3, 'cacheRead': 2, 'cacheWrite': 0, 'cost': {'total': .01}}
streams = {
    'pi': [{'type': 'tool_execution_start', 'toolCallId': 'a', 'toolName': 'read', 'args': {'path': 'source.md'}},
           {'type': 'tool_execution_end', 'toolCallId': 'a', 'result': {'content': [{'type': 'text', 'text': '42'}]}},
           {'type': 'message_end', 'message': {'role': 'assistant', 'content': [{'type': 'thinking', 'thinking': 'private'},
                {'type': 'text', 'text': text}], 'usage': usage, 'stopReason': 'stop'}}],
    'cursor': [{'type': 'tool_call', 'call_id': 'a', 'subtype': 'completed', 'tool_call': {'readToolCall': {'args': {'path': 'source.md'}, 'result': '42'}}},
               {'type': 'result', 'subtype': 'success', 'is_error': False, 'result': text}],
    'gemini': [{'type': 'tool_use', 'tool_id': 'a', 'tool_name': 'read_file', 'parameters': {'file_path': 'source.md'}},
               {'type': 'tool_result', 'tool_id': 'a', 'output': '42'},
               {'type': 'message', 'role': 'assistant', 'content': text},
               {'type': 'result', 'status': 'success', 'stats': {'input_tokens': 10, 'output_tokens': 3}}],
    'opencode': [{'type': 'tool_use', 'part': {'callID': 'a', 'tool': 'read', 'state': {'input': {'filePath': 'source.md'}, 'output': '42'}}},
                 {'type': 'text', 'part': {'text': text}},
                 {'type': 'step_finish', 'part': {'reason': 'stop', 'tokens': {'input': 8, 'output': 3, 'cache': {'read': 2, 'write': 0}}, 'cost': .01}}],
    'codex': [{'type': 'item.started', 'item': {'id': 'a', 'type': 'command_execution', 'command': 'cat source.md'}},
              {'type': 'item.completed', 'item': {'id': 'a', 'type': 'command_execution', 'aggregated_output': '42'}},
              {'type': 'turn.completed', 'usage': {'input_tokens': 10, 'output_tokens': 3}}],
    'claude': [{'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'id': 'a', 'name': 'Read', 'input': {'file_path': 'source.md'}}]}},
               {'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': 'a', 'content': '42'}]}},
               {'type': 'result', 'subtype': 'success', 'structured_output': answer, 'usage': {'input_tokens': 10, 'output_tokens': 3}, 'total_cost_usd': .01}],
}
streams['omp'] = streams['pi']
for name in ('pi', 'omp', 'cursor', 'gemini', 'opencode'):
    result = parse_native(name, streams[name])
    assert result['answer'] == '42' and result['tool_calls'] == 1
    assert 'private' not in json.dumps(result)

with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    request = {'role': 'inference', 'model': 'test-model', 'wiki_root': tmp, 'skill_files': {},
               'skill_sha256': 'test', 'question': 'Read source.md', 'max_usd': None}
    (root / 'source.md').write_text('42')
    fake = root / 'fake.py'
    fake.write_text('''#!'''+sys.executable+'''
import json,os,sys,time
from pathlib import Path
name=Path(sys.argv[0]).name
if '--version' in sys.argv: print('test-version');sys.exit()
if name=='openclaw' and 'gateway' in sys.argv:
 p=json.loads(sys.argv[sys.argv.index('--params')+1]);assert p['key']=='acp-bridge:s'
 print(json.dumps({'ok':True,'resolved':{'modelProvider':'test','model':'model'}}));sys.exit()
if name in ('hermes','openclaw'):
 for line in sys.stdin:
  r=json.loads(line); method=r['method']
  if method=='initialize': value={'agentInfo':{'version':'test-version'}}
  elif method=='session/new': value={'sessionId':'s'}
  elif method=='session/set_model': value={}
  elif method=='session/load': value={'models':{'currentModelId':'wrong:model' if os.environ.get('FAKE_MODEL_FALLBACK') else 'test:model'}}
  else:
   for update in [{'sessionUpdate':'agent_thought_chunk','content':{'type':'text','text':'private'}},
      {'sessionUpdate':'tool_call','toolCallId':'a','kind':'read','rawInput':{'path':'source.md'}},
      {'sessionUpdate':'tool_call_update','toolCallId':'a','status':'completed','rawOutput':'42'},
      {'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':json.dumps({'answer':'42','abstain':False,'citations':['source.md']})}}]:
    print(json.dumps({'method':'session/update','params':{'update':update}}),flush=True)
   value={'stopReason':'end_turn'}
  print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':value}),flush=True)
 sys.exit()
sys.stdin.read()
if name=='cursor-agent': name='cursor'
events=json.loads(Path(os.environ['FAKE_STREAMS']).read_text())[name]
if '--output-last-message' in sys.argv:
 Path(sys.argv[sys.argv.index('--output-last-message')+1]).write_text('''+repr(text)+''')
for e in events:
 print(json.dumps(e),flush=True)
 if os.environ.get('FAKE_HANG'): time.sleep(60)
''')
    fake.chmod(0o755)
    for name in (*streams, 'cursor-agent', 'hermes', 'openclaw'):
        (root / name).symlink_to(fake)
    (root / 'streams.json').write_text(json.dumps(streams))
    old = dict(os.environ)
    os.environ.update(PATH=str(root)+os.pathsep+os.environ['PATH'], FAKE_STREAMS=str(root/'streams.json'))
    try:
        for name in (*streams, 'hermes', 'openclaw'):
            request['model'] = 'test:model' if name == 'hermes' else 'test/model' if name == 'openclaw' else 'test-model'
            trace = root / (name+'.jsonl')
            request['trace_path'] = str(trace)
            out = lifecycle.run_runner([sys.executable, str(SCRIPTS/'wiki_evolve_agent.py'), name], request, root, 10)
            assert out['answer'] == '42' and out['skill_sha256'] == 'test' and out['tool_calls'] == 1, (name,out)
            assert '42' in trace.read_text() and 'private' not in trace.read_text(), name
        os.environ['FAKE_MODEL_FALLBACK'] = '1'
        fails(lambda: lifecycle.run_runner([sys.executable, str(SCRIPTS/'wiki_evolve_agent.py'), 'hermes'],
              dict(request, model='test:model'), root, 10), 'did not resolve')
        del os.environ['FAKE_MODEL_FALLBACK']
        os.environ['FAKE_HANG'] = '1'
        request['trace_path'] = str(root/'interrupted.jsonl')
        try:
            lifecycle.run_runner([sys.executable, str(SCRIPTS/'wiki_evolve_agent.py'), 'codex'], request, root, 1)
        except subprocess.TimeoutExpired:
            pass
        else:
            raise AssertionError('Runner should have timed out')
        assert json.loads((root/'interrupted.jsonl').read_text())['item']['command'] == 'cat source.md'
    finally:
        os.environ.clear(); os.environ.update(old)
    # Refuse all opaque CLI USD configurations, including transfer, before calls.
    config = {'budget': {'max_calls': 10, 'max_seconds': 10, 'timeout': 5, 'max_usd': 10},
              **{r: {'argv': [sys.executable,str(SCRIPTS/'wiki_evolve_agent.py'),'claude'], 'model': 'sonnet'}
                 for r in ('inference','judge','maintainer','proposer')}}
    fails(lambda: loop.Calls(config, root), 'Hard USD budgets require')
    # An unreservable call never reaches the provider; uncertain calls retain debit.
    api_request = dict(request, model='claude-sonnet-5', max_usd=.01, trace_path=str(root/'api.jsonl'))
    fails(lambda: api.execute(dict(api_request, max_usd=float('inf'))), 'finite')
    expires = api.PRICE_EXPIRES
    api.PRICE_EXPIRES = date(2026, 9, 12)
    fails(lambda: api.reservation('claude-sonnet-5'), 'expired')
    api.PRICE_EXPIRES = expires
    sent = []
    def send(body):
        sent.append(body)
        return {'model': 'claude-sonnet-5', 'usage': {'input_tokens': 100, 'output_tokens': 10},
                'stop_reason': 'tool_use', 'content': [{'type':'tool_use','name':'finish','input':answer}]}
    fails(lambda: api.execute(api_request, send), 'cannot reserve')
    assert not sent
    api_request['max_usd'] = 3
    result = api.execute(api_request, send)
    assert len(sent) == 1 and result['cost'] == .0003
    assert 'temperature' not in sent[0] and sent[0]['thinking'] == {'type':'disabled'}
    assert sent[0]['service_tier'] == 'standard_only' and sent[0]['inference_geo'] == 'global'
    assert [json.loads(s)['type'] for s in (root/'api.jsonl').read_text().splitlines()] == ['budget-reserved','budget-settled']
    fails(lambda: api.local_tool('write_file', {'path':'source.md','content':'changed'}, api_request), 'Write outside')
    api_request['trace_path'] = str(root/'uncertain.jsonl')
    def uncertain(body):
        raise OSError('Response lost after transmission')
    try:
        api.execute(api_request, uncertain)
    except OSError:
        pass
    records = [json.loads(s) for s in (root/'uncertain.jsonl').read_text().splitlines()]
    assert len(records) == 1 and records[0]['type'] == 'budget-reserved'
    assert loop.command_checks({'required_commands': [['wiki_search.py','--json']]},
        [{'type':'tool_result','content':'wiki_search.py --json'}]) == [False]
    assert loop.command_checks({'required_commands': [['wiki_search.py','--json']]},
        [{'type':'tool_use','input':{'command':'python wiki_search.py q --json'}}]) == [True]
    assert loop.command_observations(streams['codex']) == [{'command':'cat source.md','output':'42'}]
    assert loop.command_observations([{'type':'tool_use','id':'a','input':{'command':'echo 42'}},
        {'type':'tool_result','tool_use_id':'a','content':'42'}]) == [{'command':'echo 42','output':'42'}]
    assert loop.subset({'mode':'hybrid','results':[{'slug':'new'}]},
                       {'mode':'hybrid','results':[{'slug':'old'},{'slug':'new','score':1}]})
    assert not loop.subset({'mode':'hybrid'}, {'mode':'lexical'})
    scores = {v: [dict(task=str(t),passed=v=='selected',output={'cost':None,'tool_calls':1})
                  for t in range(8) for repeat in range(3)] for v in ('baseline','selected')}
    analysis = loop.paired_report(scores)
    assert analysis['independent_tasks'] == 8 and analysis['paired_executions'] == 24
    assert analysis['positive_evidence'] and analysis['mean_inference_metrics']['cost']['baseline'] is None
    scores['selected'] = scores['baseline']
    assert not loop.paired_report(scores)['positive_evidence']
    try:
        inspect_processes = os.name == 'posix' and subprocess.run(['ps','-eo','pid=,ppid='], capture_output=True).returncode == 0
    except OSError:
        inspect_processes = False
    if inspect_processes:
        child_runner = root/'detached.py'
        child_runner.write_text('import subprocess,sys,time\nfrom pathlib import Path\n'
            'p=subprocess.Popen([sys.executable,"-c","import time; time.sleep(60)"],start_new_session=True)\n'
            'Path("child.pid").write_text(str(p.pid))\ntime.sleep(60)\n')
        try:
            lifecycle.run_runner([sys.executable,str(child_runner)],{},root,1)
        except subprocess.TimeoutExpired:
            pass
        else:
            raise AssertionError('Detached child test did not time out')
        status = subprocess.run(['ps','-p',(root/'child.pid').read_text(),'-o','stat='],capture_output=True,text=True).stdout.strip()
        assert not status or status.startswith('Z'), 'Detached tool survived timeout: '+status
print('Nine adapter protocols, interrupted durable traces, unknown usage and pre-request dollar reservations: PASS')
