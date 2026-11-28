import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import platform_registry_plan


class PlatformRegistryPlanTest(unittest.TestCase):
    def test_plan_uses_shared_boundary_and_writes_valid_envelope(self):
        result = subprocess.CompletedProcess([], 0, '{"ok":true,"data":{"plan":{"request":{}}}}', '')
        with tempfile.TemporaryDirectory() as tmp, patch.object(platform_registry_plan, 'run_command', return_value=result) as run:
            out = Path(tmp) / 'plan.json'
            platform_registry_plan.main([str(out), '--index', '/index.json'])
            self.assertEqual(json.loads(out.read_text())['data']['plan']['request'], {})
            run.assert_called_once_with(['kb-create', 'plan', '--json', '--index', '/index.json'])

    def test_plan_failure_is_not_written_as_success(self):
        result = subprocess.CompletedProcess([], 1, '{"ok":false,"error":{"code":"KB_CONFIG_INVALID","message":"bad"}}', '')
        with tempfile.TemporaryDirectory() as tmp, patch.object(platform_registry_plan, 'run_command', return_value=result):
            out = Path(tmp) / 'plan.json'
            with self.assertRaisesRegex(RuntimeError, 'KB_CONFIG_INVALID'):
                platform_registry_plan.main([str(out)])
            self.assertFalse(out.exists())
