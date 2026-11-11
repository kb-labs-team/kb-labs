from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

from studio_fixture_steps import prepare_studio_fixtures


class StudioFixtureStepTests(unittest.TestCase):
    def test_keeps_workflow_builtin_and_publishes_real_greet_workflow(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project_a = root / "project-a"
            project_b = root / "project-b"
            project_a.mkdir()
            project_b.mkdir()
            commands: list[list[str]] = []
            attached = {project_a: ["@kb-labs/qa"], project_b: []}

            def runner(command, **_kwargs):
                commands.append(command)
                cwd = Path(_kwargs["cwd"])
                if command[1:3] == ["workflow", "defs"]:
                    return subprocess.CompletedProcess(command, 0, json.dumps({
                        "ok": True, "data": [{"id": "greet", "status": "active"}],
                    }), "")
                if command[1:4] == ["marketplace", "plugins", "list"]:
                    return subprocess.CompletedProcess(command, 0, json.dumps({
                        "ok": True, "data": {"entries": [{"id": package} for package in attached[cwd]]},
                    }), "")
                if command[1:3] == ["marketplace", "uninstall"]:
                    attached[cwd].remove(command[3])
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "data": {}}), "")
                package = command[3]
                attached[cwd].append(package)
                return subprocess.CompletedProcess(command, 0, json.dumps({
                    "ok": True, "data": {"installed": [{"id": package}]},
                }), "")

            with patch.dict("os.environ", {
                "KB_JOURNEY_INVOCATIONS": directory,
            }, clear=False):
                fixture_env = prepare_studio_fixtures(
                    {}, project_b_id="project-b",
                    project_a=project_a,
                    project_b=project_b,
                    runner=runner,
                )

            self.assertEqual(fixture_env["KB_STUDIO_GREET_WORKFLOW_ID"], "greet")
            manifest = (project_a / ".kb/workflows/greet.yml").read_text()
            self.assertIn("name: greet", manifest)
            self.assertIn("required: true", manifest)
            self.assertIn("type: string", manifest)
            installs = [command for command in commands if command[1:3] == ["marketplace", "install"]]
            self.assertEqual(len(installs), 1)
            self.assertFalse(any("@kb-labs/workflow-entry" in command for command in commands))
            self.assertTrue(any("@kb-labs/commit" in command for command in installs))
            self.assertIn(["kb", "marketplace", "uninstall", "@kb-labs/qa", "--json"], commands)

    def test_cli_fixture_failure_does_not_export_values(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project_a = root / "project-a"
            project_b = root / "project-b"
            project_a.mkdir()
            project_b.mkdir()
            failed = lambda command, **_kwargs: subprocess.CompletedProcess(command, 1, "", "fixture failure")
            with patch.dict("os.environ", {
                "KB_JOURNEY_INVOCATIONS": directory,
            }, clear=False):
                with self.assertRaisesRegex(RuntimeError, "marketplace install"):
                    prepare_studio_fixtures({}, project_b_id="project-b",
                                            project_a=project_a, project_b=project_b,
                                            runner=failed)


if __name__ == "__main__":
    unittest.main()
