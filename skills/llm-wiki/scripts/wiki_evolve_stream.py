"""Observable CLI events, durably written before a runner can be interrupted."""
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import threading

from wiki_evolve import require


def append_trace(path, value):
    if path:
        with open(path, 'a', encoding='utf-8') as stream:
            stream.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + '\n')
            stream.flush()
            os.fsync(stream.fileno())


def observable(agent, event):
    """Allowlist public tool I/O; never persist reasoning or prompt echoes."""
    kind = event.get('type')
    if agent == 'codex':
        return [event] if kind in ('item.started', 'item.completed') and event.get('item', {}).get('type') in (
            'command_execution', 'mcp_tool_call', 'web_search', 'file_change') else []
    if agent == 'claude':
        content = event.get('message', {}).get('content', [])
        return [b for b in content if isinstance(b, dict) and b.get('type') in ('tool_use', 'tool_result')
                and b.get('name') != 'StructuredOutput'] if isinstance(content, list) else []
    if agent in ('pi', 'omp'):
        return [event] if kind in ('tool_execution_start', 'tool_execution_update', 'tool_execution_end') else []
    if agent == 'cursor':
        return [event] if kind == 'tool_call' else []
    if agent == 'gemini':
        return [event] if kind in ('tool_use', 'tool_result') else []
    if agent == 'opencode':
        return [event] if kind == 'tool_use' else []
    update = event.get('params', {}).get('update', {})
    return [update] if update.get('sessionUpdate') in ('tool_call', 'tool_call_update') else []


def stream_command(command, text, agent, trace_path=None, env=None):
    # Separate writer avoids deadlock when a large prompt and stdout fill both pipes.
    with tempfile.TemporaryFile(mode='w+') as errors:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=errors, text=True, env=env)
        def write():
            try:
                process.stdin.write(text)
                process.stdin.close()
            except (BrokenPipeError, OSError):
                pass
        writer = threading.Thread(target=write, daemon=True)
        writer.start()
        events, banners = [], []
        try:
            for line in process.stdout:
                if not line.strip():
                    continue
                try:
                    item = json.loads(line)
                except ValueError:
                    banners.append(line[-1000:])
                    continue  # Startup banners are not execution evidence.
                require(isinstance(item, dict), 'CLI event must be an object')
                events.append(item)
                for observed in observable(agent, item):
                    append_trace(trace_path, observed)
            code = process.wait()
            writer.join(timeout=1)
            if code:
                errors.seek(0)
                # Error diagnostics only; stdout reasoning remains excluded from traces.
                diagnostics = errors.read()[-2000:] + ''.join(banners)[:1500] + ''.join(banners)[-500:]
                diagnostics += json.dumps([e for e in events if e.get('type') == 'error'])
                detail = re.sub(r'(?i)(?:sk-[\w-]+|bearer\s+[\w.\-]+)', '[redacted]', diagnostics[-4000:])
                raise ValueError(f'{agent} exited {code}: {detail}; retained observable trace: {trace_path}')
            return events
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()


def answer_json(text):
    """Accept a JSON answer or one fenced JSON block, never extract an arbitrary substring."""
    text = text.strip()
    if text.startswith('```') and text.endswith('```'):
        text = text.split('\n', 1)[1].rsplit('```', 1)[0].strip()
    result = json.loads(text)
    require(isinstance(result, dict), 'Structured answer must be an object')
    return result


def parse_native(agent, events):
    observed = [o for e in events for o in observable(agent, e)]
    cost, usage = None, {'input_tokens': None, 'output_tokens': None}
    require(not any(e.get('type') == 'error' for e in events), f'{agent} returned an error')
    if agent in ('pi', 'omp'):
        messages = [e['message'] for e in events if e.get('type') == 'message_end'
                    and e.get('message', {}).get('role') == 'assistant']
        require(messages and messages[-1].get('stopReason') not in ('error', 'aborted', 'length'),
                'Agent completion missing: ' + (messages[-1].get('errorMessage', '') if messages else 'no assistant message'))
        text = ''.join(c['text'] for c in messages[-1]['content'] if c.get('type') == 'text')
        counts = [m.get('usage', {}) for m in messages]
        if all(all(type(c.get(k)) is int for k in ('input', 'output')) for c in counts):
            usage = {'input_tokens': sum(c['input'] + c.get('cacheRead', 0) + c.get('cacheWrite', 0) for c in counts),
                     'output_tokens': sum(c['output'] for c in counts)}
        if all(isinstance(c.get('cost', {}).get('total'), (int, float)) for c in counts):
            cost = sum(c['cost']['total'] for c in counts)
        ids = {e['toolCallId'] for e in observed}
    elif agent == 'cursor':
        results = [e for e in events if e.get('type') == 'result']
        require(len(results) == 1 and results[0].get('subtype') == 'success' and not results[0].get('is_error'), 'Cursor completion missing')
        text = results[0]['result']
        ids = {e['call_id'] for e in observed}
    elif agent == 'gemini':
        results = [e for e in events if e.get('type') == 'result']
        require(len(results) == 1 and results[0].get('status') == 'success', 'Gemini completion missing')
        text = ''.join(e.get('content', '') for e in events if e.get('type') == 'message' and e.get('role') == 'assistant')
        stats = results[0].get('stats', {})
        usage = {k: stats.get(k) for k in usage}
        ids = {e['tool_id'] for e in observed}
    else:
        finished = [e['part'] for e in events if e.get('type') == 'step_finish']
        require(finished and finished[-1].get('reason') == 'stop', 'OpenCode completion missing')
        texts = [e['part']['text'] for e in events if e.get('type') == 'text']
        require(texts, 'OpenCode answer missing')
        text = texts[-1]
        if all(isinstance(p.get('tokens'), dict) for p in finished):
            usage = {'input_tokens': sum(p['tokens']['input'] + sum(p['tokens'].get('cache', {}).values()) for p in finished),
                     'output_tokens': sum(p['tokens']['output'] for p in finished)}
        if all(isinstance(p.get('cost'), (int, float)) for p in finished):
            cost = sum(p['cost'] for p in finished)
        ids = {e['part']['callID'] for e in observed}
    return dict(answer_json(text), events=observed, tool_calls=len(ids), usage=usage, cost=cost)


def acp(command, request, text, env=None):
    """One fresh ACP session; retain public tool I/O and reject unscoped permissions."""
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=errors, text=True, env=env)
        observed, chunks, serial = [], [], 0
        def send(message):
            process.stdin.write(json.dumps(dict(jsonrpc='2.0', **message)) + '\n')
            process.stdin.flush()
        def rpc(method, params):
            nonlocal serial
            serial += 1
            wanted = serial
            send({'id': wanted, 'method': method, 'params': params})
            for line in process.stdout:
                try:
                    item = json.loads(line)
                except ValueError:
                    continue  # Some hosts emit startup banners before ACP initialization.
                for event in observable('acp', item):
                    observed.append(event)
                    append_trace(request.get('trace_path'), event)
                if item.get('method') == 'session/update':
                    update = item['params']['update']
                    if update.get('sessionUpdate') == 'agent_message_chunk' and update.get('content', {}).get('type') == 'text':
                        chunks.append(update['content']['text'])
                elif item.get('method') == 'session/request_permission':
                    # ACP permissions do not prove shell isolation. Scoped reads only;
                    # a configured gateway/container must enforce mutation permissions.
                    call = item['params'].get('toolCall', {})
                    locations = call.get('locations', [])
                    root = Path(request.get('wiki_root', Path.cwd())).resolve()
                    scoped = bool(locations) and all(Path(p['path']).is_absolute() and
                        Path(p['path']).resolve().is_relative_to(root) for p in locations)
                    allowed = request.get('role') == 'inference' and call.get('kind') in ('read', 'search') and scoped
                    option = next((o for o in item['params']['options'] if o['kind'] == ('allow_once' if allowed else 'reject_once')), None)
                    outcome = {'outcome': 'selected', 'optionId': option['optionId']} if option else {'outcome': 'cancelled'}
                    send({'id': item['id'], 'result': {'outcome': outcome}})
                elif item.get('method') and 'id' in item:
                    send({'id': item['id'], 'error': {'code': -32601, 'message': 'Client capability unavailable'}})
                elif item.get('id') == wanted:
                    require('error' not in item, f'ACP {method} failed: {item.get("error")}')
                    return item['result']
            raise ValueError('ACP stream ended before completion')
        try:
            info = rpc('initialize', {'protocolVersion': 1, 'clientCapabilities': {},
                       'clientInfo': {'name': 'wiki-evolve', 'version': '3.2.0'}})
            session = rpc('session/new', {'cwd': str(Path.cwd()), 'mcpServers': []})
            sid = session['sessionId']
            models = session.get('models', {})
            if Path(command[0]).name == 'hermes':
                require(':' in models.get('currentModelId', ''),
                        'Hermes did not resolve the requested provider:model; repair its authentication before inference')
            if Path(command[0]).name == 'openclaw':
                # OpenClaw's bridge has no ACP model setter. Its public session
                # mapper uses acp-bridge:<sessionId>; patch only this fresh session.
                gateway = command[:command.index('acp')]
                result = subprocess.run(gateway + ['gateway', 'call', 'sessions.patch', '--json', '--params',
                    json.dumps({'key': 'acp-bridge:'+sid, 'model': request['model']})],
                    text=True, capture_output=True, env=env, timeout=30, check=True)
                patched = json.loads(result.stdout)
                resolved = patched.get('resolved', {})
                require(patched.get('ok') is True and '/'.join((resolved.get('modelProvider', ''), resolved.get('model', ''))) == request['model'],
                        'Gateway did not confirm the requested canonical provider/model')
                append_trace(request.get('trace_path'), {'type': 'model-selected', 'model': request['model'], 'session': sid})
            elif models.get('currentModelId') != request['model']:
                rpc('session/set_model', {'sessionId': sid, 'modelId': request['model']})
            final = rpc('session/prompt', {'sessionId': sid, 'prompt': [{'type': 'text', 'text': text}]})
            require(final.get('stopReason') == 'end_turn', 'ACP turn did not finish normally')
            append_trace(request.get('trace_path'), {'type': 'public-answer', 'text': ''.join(chunks)})
            if not ''.join(chunks).strip():
                errors.seek(0)
                detail = errors.read().decode(errors='replace')[-2500:]
                detail = re.sub(r'(?i)(?:sk-[\w-]+|bearer\s+[\w.\-]+)', '[redacted]', detail)
                raise ValueError('ACP returned no answer: ' + detail)
            measured = final.get('usage') or {}
            return dict(answer_json(''.join(chunks)), events=observed,
                        tool_calls=len({e['toolCallId'] for e in observed}), cost=None,
                        usage={'input_tokens': measured.get('inputTokens'), 'output_tokens': measured.get('outputTokens')},
                        agent_version=info.get('agentInfo', {}).get('version', 'unknown'))
        finally:
            process.stdin.close()
            if process.poll() is None:
                process.kill()
            process.wait()
