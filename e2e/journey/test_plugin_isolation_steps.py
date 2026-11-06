from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from plugin_isolation_steps import run_project_plugin_availability_steps
from service_steps import Journey


class PluginIsolationStepsTest(unittest.TestCase):
    # case: S-197.3, S-197.5
    def test_cross_project_plugin_commands_reject_fake_failure_then_require_install_hint(self):
        with tempfile.TemporaryDirectory(prefix="c07-plugin-isolation-") as directory:
            root = Path(directory)
            project_a, project_b = root / "project-a", root / "project-b"
            project_a.mkdir()
            project_b.mkdir()
            platform = root / "platform-not-installed"
            env = {"HOME": directory, "KB_PLATFORM_ROOT": str(platform)}

            red = Journey("local", "plugin-isolation-red")
            staged_fixture = False

            def available(command, **_kwargs):
                nonlocal staged_fixture
                if command[:3] == ["git", "-C", str(project_b)]:
                    if command[3] == "add":
                        staged_fixture = True
                    elif command[3] == "reset":
                        staged_fixture = False
                    return subprocess.CompletedProcess(command, 0, "", "")
                if "review" in command and Path(_kwargs.get("cwd", "")) == project_b and not staged_fixture:
                    return subprocess.CompletedProcess(command, 1, "", "No changed files found")
                return subprocess.CompletedProcess(command, 0, "", "")

            run_project_plugin_availability_steps(red, "kb", project_a, project_b, env, runner=available)
            self.assertEqual(red.result().case_run["claims"], [
                {"claimId": "S-197.3", "kind": "journey", "status": "FAIL"},
                {"claimId": "S-197.5", "kind": "journey", "status": "FAIL"},
            ])

            green = Journey("local", "plugin-isolation-green")
            staged_fixture = False

            def unavailable(command, **_kwargs):
                nonlocal staged_fixture
                if command[:3] == ["git", "-C", str(project_b)]:
                    if command[3] == "add":
                        staged_fixture = True
                    elif command[3] == "reset":
                        staged_fixture = False
                    return subprocess.CompletedProcess(command, 0, "", "")
                if "review" in command and Path(_kwargs.get("cwd", "")) == project_b:
                    if not staged_fixture:
                        return subprocess.CompletedProcess(command, 1, "", "No changed files found")
                    payload = {"findings": [], "metadata": {"mode": "heuristic", "analyzedFiles": 1}}
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "data": payload}), "")
                package = "@kb-labs/review" if "review" in command else "@kb-labs/commit"
                output = f"KB_PLUGIN_NOT_FOUND: {package} is not installed. Run kb marketplace install {package}."
                return subprocess.CompletedProcess(command, 1, "", output)

            run_project_plugin_availability_steps(green, "kb", project_a, project_b, env, runner=unavailable)
            self.assertEqual(green.result().status, "PASS", green.result().first_failure)
            self.assertEqual(green.result().case_run["claims"], [
                {"claimId": "S-197.3", "kind": "journey", "status": "PASS"},
                {"claimId": "S-197.5", "kind": "journey", "status": "PASS"},
            ])


if __name__ == "__main__":
    unittest.main()
