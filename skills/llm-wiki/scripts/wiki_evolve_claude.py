#!/usr/bin/env python3
"""Optional Claude Code runner for wiki_evolve.py's query pilot.

Reads one JSON request on stdin, returns one JSON result on stdout. Requires
an installed, authenticated Claude CLI with --restricted and --json-schema.
Uses the shared neutral adapter, disables ambient skills/MCP servers, and counts observed
tool-use events. Model inference uses your Claude account; it is not local.

Runner argv JSON: ["python3", "/absolute/skill/scripts/wiki_evolve_claude.py"]
"""

import json
from pathlib import Path
import subprocess
import sys


SCHEMA = {
    'type': 'object', 'properties': {
        'answer': {'type': 'string'},
        'abstain': {'type': 'boolean'},
        'citations': {'type': 'array', 'items': {'type': 'string'}},
    }, 'required': ['answer', 'abstain', 'citations'], 'additionalProperties': False,
}


def parse_events(lines):
    events = [json.loads(line) for line in lines.splitlines() if line.strip()]
    results = [e for e in events if e.get('type') == 'result']
    if len(results) != 1 or results[0].get('is_error') or results[0].get('subtype') != 'success':
        raise ValueError('Claude did not complete a structured answer')
    result = results[0]
    output = result['structured_output']
    # Count each emitted tool-use ID once, excluding the JSON output formatter.
    calls = {block['id'] for e in events if e.get('type') == 'assistant'
             for block in e.get('message', {}).get('content', [])
             if block.get('type') == 'tool_use' and block.get('name') != 'StructuredOutput'}
    output['tool_calls'] = len(calls)
    output['cost'] = result['total_cost_usd']
    return output


def main():
    request = json.load(sys.stdin)
    skill = Path(request['skill_root']).resolve()
    wiki = Path(request['wiki_root']).resolve()
    from wiki_evolve_agent import execute
    from wiki_evolve_loop import skill_text
    from wiki_evolve import digest, encode
    supplied = skill_text(skill)
    request.update(role='inference', skill_files=supplied,
                   skill_sha256=digest(encode(supplied).encode()), allow_write=[])
    print(json.dumps(execute('claude', request), allow_nan=False))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as exc:
        print(f'Claude runner failed: {type(exc).__name__}', file=sys.stderr)
        sys.exit(1)
