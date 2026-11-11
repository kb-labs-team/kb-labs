from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

import unexpected_error_steps


class RecordingJourney:
    def __init__(self, mode: str):
        self.mode = mode
        self.steps = []

    def step(self, name, capability, check, cases=(), **_kwargs):
        message = check()
        details = _kwargs.get('details')() if _kwargs.get('details') else None
        self.steps.append((name, capability, list(cases), message, details))


class UnexpectedErrorJourneyTests(unittest.TestCase):
    def test_installs_fixture_and_queries_plugin_handler_failure_for_both_host_states(self):
        journey = RecordingJourney('local')
        commands = []
        fixture_root = Path(__file__).parent / 'fixtures/plugin-error'
        package_name = json.loads((fixture_root / 'package.json').read_text())['name']
        error_catalog = json.loads((Path(__file__).parents[2] / 'core/platform/src/error-envelope/errors.catalog.json').read_text())
        plugin_failure = next(item for item in error_catalog['codes'] if item['code'] == 'KB_PLUGIN_COMMAND_FAILED')

        def runner(command, **kwargs):
            commands.append(command)
            if command[1:3] == ['marketplace', 'install']:
                return subprocess.CompletedProcess(command, 0, json.dumps({'ok': True, 'data': {}}), '')
            if command[1:3] == ['logs', 'query']:
                correlation_id = command[command.index('--correlation-id') + 1]
                record = {
                    'correlationId': correlation_id,
                    'event': 'plugin.handler.failed',
                    'sourceErrorClass': 'Error',
                    'sourceMessage': 'journey fixture outer failure [REDACTED]',
                    'serializedError': {
                        'name': 'Error',
                        'message': 'journey fixture outer failure [REDACTED]',
                        'stack': 'Error: outer [REDACTED]',
                        'cause': {
                            'name': 'Error',
                            'message': 'journey fixture nested cause [REDACTED]',
                            'stack': 'Error: nested [REDACTED]',
                        },
                    },
                }
                return subprocess.CompletedProcess(command, 0, json.dumps({'ok': True, 'data': {'data': {'logs': [record]}}}), '')
            if command[1:3] == ['journey-error', 'throw']:
                correlation_id = f'correlation-{len(commands)}'
                hint = plugin_failure['hint'].replace('{correlationId}', correlation_id)
                if '--json' in command:
                    output = json.dumps({'ok': False, 'error': {
                        'code': 'KB_PLUGIN_COMMAND_FAILED', 'correlationId': correlation_id,
                        'hint': hint, 'details': {'plugin': package_name, 'command': 'journey-error throw'},
                    }})
                else:
                    output = f"Plugin command journey-error throw in {package_name} failed unexpectedly. [KB_PLUGIN_COMMAND_FAILED]\nHint: {hint}"
                return subprocess.CompletedProcess(command, 1, output, '')
            return subprocess.CompletedProcess(command, 0, '', '')

        with patch.object(unexpected_error_steps, 'run_command', side_effect=runner), \
             patch.object(unexpected_error_steps.shutil, 'which', return_value='/installed/kb-create'):
            unexpected_error_steps.run_unexpected_error_steps(journey, mode='local', env={
                'KB_JOURNEY_CLI_PATH': '/installed/kb',
                'KB_JOURNEY_PLATFORM_ROOT': '/platform',
                'PATH': '/bin',
            })

        self.assertTrue(all(step[3] is None for step in journey.steps), journey.steps)
        self.assertEqual([step[2] for step in journey.steps if step[2]], [['S-203.26'], ['S-203.26']])
        self.assertTrue(all(step[4] and step[4]['correlatedFailureRecords'] for step in journey.steps[:2]))
        installs = [command for command in commands if command[1:3] == ['marketplace', 'install']]
        self.assertEqual(installs, [['/installed/kb', 'marketplace', 'install', package_name, '--scope', 'platform', '--json']])
        failures = [command for command in commands if command[1:3] == ['journey-error', 'throw']]
        self.assertEqual(len(failures), 4)
        self.assertEqual(sum('--json' in command for command in failures), 2)
        self.assertEqual(sum('--json' not in command for command in failures), 2)
        queries = [command for command in commands if command[1:3] == ['logs', 'query']]
        self.assertEqual(len(queries), 4)
        self.assertTrue(any(command[1:2] == ['stop'] for command in commands))
        self.assertTrue(any(command[1:2] == ['start'] for command in commands))


if __name__ == '__main__':
    unittest.main()
