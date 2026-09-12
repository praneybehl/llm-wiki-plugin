#!/usr/bin/env python3
"""Claude Messages runner with pre-request USD reservations (stdlib only).

Hard limits cover this runner's first-party inference, at the pinned standard
token prices, excluding tax/account activity. No server tools, caching, premium
routing, retries or arbitrary shell tool. CLI subscriptions use the CLI adapters.
"""
from datetime import date
from decimal import Decimal
import argparse
import fnmatch
import json
import os
from pathlib import Path
import sys
import urllib.request

from wiki_evolve import encode, finite, inside, require, tree
from wiki_evolve_agent import prompt, schema
from wiki_evolve_stream import append_trace

# First-party global standard prices verified 2026-09-13. Fail closed when stale.
# https://platform.claude.com/docs/en/about-claude/pricing
# Both models have a 1M context limit. Reserve that entire input limit rather
# than treating the token-count endpoint's estimate as a guaranteed upper bound.
PRICES = {'claude-sonnet-5': (2, 10), 'claude-sonnet-4-6': (3, 15)}
PRICE_EXPIRES = date(2026, 10, 13)
CONTEXT_LIMIT = 1_000_000
MAX_OUTPUT = 8192


def reservation(model, output_tokens=MAX_OUTPUT):
    require(model in PRICES and date.today() <= PRICE_EXPIRES, 'Unverified or expired API pricing; update the reviewed price table')
    require(type(output_tokens) is int and 1 <= output_tokens <= MAX_OUTPUT, 'Invalid API output limit')
    inp, out = PRICES[model]
    return (Decimal(CONTEXT_LIMIT) * inp + Decimal(output_tokens) * out) / 1_000_000


def post(body):
    key = os.environ.get('ANTHROPIC_API_KEY')
    require(key, 'ANTHROPIC_API_KEY required for bounded API runner')
    request = urllib.request.Request('https://api.anthropic.com/v1/messages',
        data=json.dumps(body).encode(), headers={'x-api-key': key, 'anthropic-version': '2023-06-01',
                                               'content-type': 'application/json'}, method='POST')
    # No automatic retry: an uncertain response retains its entire reservation.
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)


def local_tool(name, args, request):
    root = Path(request['wiki_root'])
    if name == 'list_files':
        return '\n'.join(tree(root))
    path = inside(root, args['path'])
    if name == 'read_file':
        return path.read_text(encoding='utf-8')
    require(name == 'write_file' and any(fnmatch.fnmatchcase(args['path'], p)
            for p in request.get('allow_write', [])), 'Write outside permitted artifacts')
    require(isinstance(args.get('content'), str), 'Write content required')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(args['content'], encoding='utf-8')
    return 'Saved ' + args['path']


def execute(request, send=post):
    maximum = request.get('max_usd')
    require(finite(maximum, 'max_usd') > 0, 'Bounded API runner requires max_usd')
    maximum = Decimal(str(maximum))
    model = request['model']
    cap = reservation(model)
    tools = [{'name': 'finish', 'description': 'Return the final structured result.', 'input_schema': schema(request['role'], request)}]
    if request['role'] == 'inference':
        for name, properties in [('list_files', {}), ('read_file', {'path': {'type': 'string'}}),
                                 ('write_file', {'path': {'type': 'string'}, 'content': {'type': 'string'}})]:
            if name != 'write_file' or request.get('allow_write'):
                tools.append({'name': name, 'description': name.replace('_', ' ') + ' within wiki_root.',
                              'input_schema': {'type': 'object', 'properties': properties, 'required': list(properties),
                                               'additionalProperties': False}})
    messages = [{'role': 'user', 'content': prompt(request)}]
    spent, observed, usage = Decimal(0), [], {'input_tokens': 0, 'output_tokens': 0}
    for turn in range(32):
        require(spent + cap <= maximum, 'API budget cannot reserve the next request; no inference sent')
        trace = request.get('trace_path')
        append_trace(trace, {'type': 'budget-reserved', 'turn': turn, 'ceiling_usd': str(cap), 'spent_usd': str(spent)})
        result = send({'model': model, 'max_tokens': MAX_OUTPUT, 'messages': messages, 'tools': tools,
                       'tool_choice': {'type': 'any'}, 'thinking': {'type': 'disabled'}, 'service_tier': 'standard_only'})
        measured = result['usage']
        require(all(type(measured.get(k)) is int and measured[k] >= 0 for k in usage), 'API usage missing')
        require(measured['input_tokens'] <= CONTEXT_LIMIT and measured['output_tokens'] <= MAX_OUTPUT,
                'Provider violated documented token limits; stop and audit reservations')
        require(not measured.get('cache_creation_input_tokens'), 'Unexpected caching surcharge')
        amount = (Decimal(measured['input_tokens']) * PRICES[model][0]
                  + Decimal(measured['output_tokens']) * PRICES[model][1]) / 1_000_000
        spent += amount
        for k in usage:
            usage[k] += measured[k]
        append_trace(trace, {'type': 'budget-settled', 'turn': turn, 'cost_usd': str(amount), 'spent_usd': str(spent)})
        require(result.get('stop_reason') == 'tool_use', 'API output truncated or tool result missing')
        blocks = result['content']
        calls = [b for b in blocks if b.get('type') == 'tool_use']
        finish = [b for b in calls if b['name'] == 'finish']
        if finish:
            require(len(calls) == 1, 'Final result mixed with unfinished tool calls')
            output = finish[0]['input']
            if request['role'] == 'proposer':
                files = output.pop('files')
                require(len({f['path'] for f in files}) == len(files), 'Duplicate proposed paths')
                output['changes'] = {f['path']: f['content'] for f in files}
            return dict(output, usage=usage, cost=float(spent), events=observed, tool_calls=len(observed) // 2,
                        skill_sha256=request.get('skill_sha256'), actual_models=[result['model']], agent_version='messages-2023-06-01')
        messages.append({'role': 'assistant', 'content': blocks})
        replies = []
        for call in calls:
            observed.append(call)
            append_trace(trace, call)
            require(request['role'] == 'inference', 'Tools are disabled for this role')
            try:
                value = local_tool(call['name'], call['input'], request)
                reply = {'type': 'tool_result', 'tool_use_id': call['id'], 'content': value}
            except (OSError, ValueError, KeyError) as exc:
                reply = {'type': 'tool_result', 'tool_use_id': call['id'], 'content': str(exc), 'is_error': True}
            observed.append(reply)
            append_trace(trace, reply)
            replies.append(reply)
        require(replies, 'API returned no tool calls')
        messages.append({'role': 'user', 'content': replies})
    raise ValueError('API turn limit exhausted')


if __name__ == '__main__':
    argparse.ArgumentParser(description=__doc__).parse_args()
    try:
        print(encode(execute(json.load(sys.stdin))), end='')
    except (ValueError, KeyError, TypeError, OSError) as exc:
        print(f'Bounded API runner failed: {type(exc).__name__}: {exc}', file=sys.stderr)
        sys.exit(1)
