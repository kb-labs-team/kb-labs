from __future__ import annotations

import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

from studio_steps import (
    create_studio_environment,
    create_studio_member,
    record_studio_browser_step,
    run_studio_browser_step,
    _record_playwright_case_claims,
)
from invocations import invocation_context
import jsonl


class FakeResponse:
    def __init__(self, body: dict, status: int = 200):
        self.status = status
        self.body = json.dumps(body).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self):
        return self.body


def fake_playwright_executable(browsers_path: Path) -> Path:
    executable = browsers_path / "chromium" / "headless_shell"
    executable.parent.mkdir(parents=True, exist_ok=True)
    executable.write_text("fake executable for preflight")
    return executable


class StudioJourneyTests(unittest.TestCase):
    def test_runner_playwright_version_comes_from_studio_source_manifest(self):
        repository = Path(__file__).parents[2]
        studio_manifest = json.loads((repository / "e2e/studio/package.json").read_text())
        expected_version = studio_manifest["devDependencies"]["@playwright/test"]
        dockerfile = (Path(__file__).parent / "Dockerfile.runner").read_text()

        self.assertIn("FROM ${KB_JOURNEY_NODE_BASE_IMAGE} AS toolchain", dockerfile)
        self.assertIn("COPY e2e/studio/package.json /tmp/studio-package.json", dockerfile)
        self.assertIn('@playwright/test"]\')', dockerfile)
        self.assertIn("ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright", dockerfile)
        from journey_resources import runner_toolchain_image
        self.assertTrue(runner_toolchain_image())
        self.assertTrue(expected_version)

    def test_studio_environment_preserves_playwright_browser_path(self):
        studio_env = create_studio_environment({
            "HOME": "/tmp/isolated-home",
            "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright",
            "KB_STUDIO_PLAYWRIGHT_OUTPUT_DIR": "/tmp/journey-run/studio-results",
        }, mode="local", project_id="project-1", project_name="Journey",
           project_root="/tmp/project", kb_bin="/tmp/bin/kb")

        self.assertEqual(studio_env["HOME"], "/tmp/isolated-home")
        self.assertEqual(studio_env["PLAYWRIGHT_BROWSERS_PATH"], "/ms-playwright")
        self.assertEqual(studio_env["KB_STUDIO_PLAYWRIGHT_OUTPUT_DIR"], "/tmp/journey-run/studio-results")
        self.assertEqual(studio_env["KB_ACCESS_MODE"], "local")

    def test_unwritable_playwright_output_directory_fails_with_path_and_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            blocker = root / "not-a-directory"
            blocker.write_text("blocker")
            output_dir = blocker / "studio-results"
            report = root / "service-local.json"
            report.write_text(json.dumps({"status": "PASS", "steps": []}))
            browsers_path = root / "browsers"
            executable = fake_playwright_executable(browsers_path)
            env = {
                "PLAYWRIGHT_BROWSERS_PATH": str(browsers_path),
                "KB_STUDIO_PLAYWRIGHT_OUTPUT_DIR": str(output_dir),
            }

            with patch("studio_steps.run_harness_command", return_value=subprocess.CompletedProcess([], 0, str(executable), "")), \
                    patch("studio_steps.run_streaming_command",
                          return_value=(subprocess.CompletedProcess([], 0, "", ""), 0.0)) as run_streaming:
                passed, elapsed, message = run_studio_browser_step(
                    ["playwright"], env, report, "local", True)
            saved = json.loads(report.read_text())

        self.assertFalse(passed)
        self.assertEqual(elapsed, 0.0)
        self.assertIn(str(output_dir), message)
        self.assertIn("writable to the journey runner", message)
        run_streaming.assert_not_called()
        self.assertEqual(saved["steps"][0]["status"], "FAIL")

    def test_playwright_receives_the_explicit_per_run_output_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            browsers_path = root / "browsers"
            executable = fake_playwright_executable(browsers_path)
            output_dir = root / "run-17" / "studio-results"
            report = root / "run-17" / "service-local.json"
            report.parent.mkdir()
            report.write_text(json.dumps({"status": "PASS", "steps": []}))
            env = {
                "PLAYWRIGHT_BROWSERS_PATH": str(browsers_path),
                "KB_STUDIO_PLAYWRIGHT_OUTPUT_DIR": str(output_dir),
            }
            completed = subprocess.CompletedProcess(["playwright"], 0, "", "")
            with patch("studio_steps.run_harness_command", return_value=subprocess.CompletedProcess([], 0, str(executable), "")), \
                    patch("studio_steps.run_streaming_command", return_value=(completed, 0.0)) as run_streaming:
                passed, _elapsed, message = run_studio_browser_step(
                    ["playwright", "test"], env, report, "local", True)
            invoked = run_streaming.call_args.args[0]

        self.assertTrue(passed, message)
        self.assertIn(f"--output={output_dir}", invoked)

    # case: S-020.3
    def test_secured_studio_environment_exports_admin_before_member_provisioning(self):
        studio_env = create_studio_environment({
            "KB_JOURNEY_ADMIN_EMAIL": "admin@example.test",
            "KB_JOURNEY_ADMIN_PASSWORD": "isolated-password",
        }, mode="secured", project_id="project-1", project_name="Journey",
           project_root="/tmp/project", kb_bin="/tmp/bin/kb")

        self.assertEqual(studio_env["KB_STUDIO_ADMIN_EMAIL"], "admin@example.test")
        self.assertEqual(studio_env["KB_STUDIO_ADMIN_PASSWORD"], "isolated-password")
        self.assertEqual(studio_env["KB_ACCESS_MODE"], "secured")
        self.assertNotIn("KB_STUDIO_MEMBER_EMAIL", studio_env)
        self.assertNotIn("KB_STUDIO_MEMBER_PASSWORD", studio_env)

    def test_missing_playwright_browser_fails_preflight_without_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "service-local.json"
            report.write_text(json.dumps({"status": "PASS", "steps": []}))
            browsers_path = Path(directory) / "browsers"
            env = {"PLAYWRIGHT_BROWSERS_PATH": str(browsers_path)}

            discovered = browsers_path / "chromium" / "headless_shell"
            with patch("studio_steps.run_harness_command", return_value=subprocess.CompletedProcess([], 0, str(discovered), "")), \
                    patch("invocations.subprocess.Popen") as popen:
                passed, elapsed, message = run_studio_browser_step(
                    ["playwright"], env, report, "local", True)
            saved = json.loads(report.read_text())

        expected_executable = browsers_path / "chromium" / "headless_shell"
        self.assertFalse(passed)
        self.assertEqual(elapsed, 0.0)
        self.assertEqual(
            message,
            f"Playwright Chromium headless shell is missing at {expected_executable}; "
            "rebuild the runner image with `e2e/journey/run.sh --no-build`.",
        )
        popen.assert_not_called()
        self.assertEqual(saved["steps"][0]["status"], "FAIL")
        self.assertEqual(saved["steps"][0]["message"], message)

    def test_secured_admin_users_requires_every_exported_credential_before_playwright(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "service-secured.json"
            report.write_text(json.dumps({"status": "PASS", "steps": []}))
            browsers_path = Path(directory) / "browsers"
            executable = fake_playwright_executable(browsers_path)
            env = {"PLAYWRIGHT_BROWSERS_PATH": str(browsers_path)}

            with patch("studio_steps.run_harness_command", return_value=subprocess.CompletedProcess([], 0, str(executable), "")), \
                    patch("invocations.subprocess.Popen") as popen:
                passed, elapsed, message = run_studio_browser_step(
                    ["playwright"], env, report, "secured", True)

            self.assertFalse(passed)
            self.assertEqual(elapsed, 0.0)
            self.assertEqual(
                message,
                "secured admin-users Playwright setup did not provide "
                "KB_STUDIO_ADMIN_EMAIL, KB_STUDIO_ADMIN_PASSWORD, KB_STUDIO_MEMBER_EMAIL, "
                "KB_STUDIO_MEMBER_PASSWORD; complete the isolated admin and member setup "
                "before rerunning the secured journey",
            )
            popen.assert_not_called()

    def test_playwright_subprocess_receives_browser_path(self):
        with tempfile.TemporaryDirectory() as directory:
            browsers_path = Path(directory) / "browsers"
            executable = fake_playwright_executable(browsers_path)
            report = Path(directory) / "service-local.json"
            report.write_text(json.dumps({"status": "PASS", "steps": []}))
            studio_env = create_studio_environment(
                {"HOME": "/tmp/isolated-home", "PLAYWRIGHT_BROWSERS_PATH": str(browsers_path)},
                mode="local", project_id="project-1", project_name="Journey",
                project_root="/tmp/project", kb_bin="/tmp/bin/kb")

            with patch("studio_steps.run_harness_command", return_value=subprocess.CompletedProcess([], 0, str(executable), "")):
                passed, _elapsed, message = run_studio_browser_step(
                    [sys.executable, "-c", "import os; print(os.environ['PLAYWRIGHT_BROWSERS_PATH'])"],
                    studio_env, report, "local", True)
            log = (Path(directory) / "studio-playwright-local.log").read_text()

        self.assertTrue(passed, message)
        self.assertIn(str(browsers_path), log)

    def test_playwright_invocation_records_the_actual_exit_code(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            browsers_path = root / "browsers"
            executable = fake_playwright_executable(browsers_path)
            report = root / "service-local.json"
            report.write_text(json.dumps({"status": "PASS", "steps": []}))
            env = {
                "PLAYWRIGHT_BROWSERS_PATH": str(browsers_path),
                "KB_JOURNEY_INVOCATIONS": str(root / "reports"),
            }

            with invocation_context(report_root=root / "reports"), \
                    patch("studio_steps.run_harness_command", return_value=subprocess.CompletedProcess([], 0, str(executable), "")):
                passed, _elapsed, message = run_studio_browser_step(
                    [sys.executable, "-c", "import sys; print('playwright failure'); sys.exit(7)"],
                    env, report, "local", True)
            invocation_records = jsonl.read_jsonl(root / "reports" / "invocations" / "calls.jsonl")
            self.assertEqual([row.line_number for row in invocation_records if row.error is not None], [])
            records = [row.value for row in invocation_records]
            evidence = next(record for record in records if record["argv"] and record["argv"][0] == sys.executable)

        self.assertFalse(passed)
        self.assertIn("Playwright exited 7", message)
        self.assertEqual(evidence["exit_code"], 7)
        self.assertEqual(evidence["stdout"], "playwright failure\n")

    def test_secured_member_is_created_through_invite_and_activation(self):
        responses = [
            FakeResponse({"data": {"accessToken": "synthetic-admin-access-token"}, "ok": True}),
            FakeResponse({"data": {"activationUrl": "http://localhost/activate/one-time-token"}, "ok": True}, 201),
            FakeResponse({"data": {}, "ok": True}, 200),
        ]
        with patch("studio_steps.urllib.request.urlopen", side_effect=responses) as open_url:
            email, password = create_studio_member(
                "http://127.0.0.1:4000", "admin@example.test", "synthetic-admin-password")

        self.assertEqual(email, "journey-member@example.test")
        self.assertEqual(password, "JourneyMember123!")
        invite_request = open_url.call_args_list[1].args[0]
        self.assertEqual(invite_request.get_header("Authorization"), "Bearer synthetic-admin-access-token")
        self.assertEqual(json.loads(invite_request.data), {"email": email, "role": "member"})
        activation_request = open_url.call_args_list[2].args[0]
        self.assertEqual(json.loads(activation_request.data), {"token": "one-time-token", "password": password})

    def test_browser_result_is_added_to_capability_report(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "service-local.json"
            report.write_text(json.dumps({"status": "PASS", "steps": []}))

            record_studio_browser_step(report, "local", True, 1.25, "Studio browser journey passed")

            saved = json.loads(report.read_text())
        self.assertEqual(saved["steps"][0]["capability"], "studio")
        self.assertEqual(saved["steps"][0]["status"], "PASS")
        self.assertEqual(saved["steps"][0]["duration_seconds"], 1.25)

    def test_playwright_timeout_streams_and_records_last_output(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "service-local.json"
            report.write_text(json.dumps({"status": "PASS", "steps": []}))
            browsers_path = Path(directory) / "browsers"
            executable = fake_playwright_executable(browsers_path)
            command = ["playwright"]
            output_dir = report.with_name("service-local-playwright-results")
            streamed = io.StringIO()
            def timeout_after_output(_command, *, env, timeout, on_output_line, start_new_session):
                self.assertEqual(_command, [*command, f"--output={output_dir}"])
                self.assertEqual(env["PLAYWRIGHT_BROWSERS_PATH"], str(browsers_path))
                self.assertEqual(env["KB_STUDIO_PLAYWRIGHT_OUTPUT_DIR"], str(output_dir))
                self.assertEqual(timeout, 0.2)
                self.assertTrue(start_new_session)
                lines = "".join(f"playwright line {i}\n" for i in range(45))
                for line in lines.splitlines():
                    on_output_line(line)
                raise subprocess.TimeoutExpired(command, timeout, output=lines)

            with patch("studio_steps.run_harness_command", return_value=subprocess.CompletedProcess([], 0, str(executable), "")), \
                    patch("studio_steps.run_streaming_command", side_effect=timeout_after_output) as run_streaming:
                with redirect_stdout(streamed):
                    passed, _elapsed, message = run_studio_browser_step(
                        command, {"PLAYWRIGHT_BROWSERS_PATH": str(browsers_path)},
                        report, "local", True, timeout=0.2)
            saved = json.loads(report.read_text())
            log = (Path(directory) / "studio-playwright-local.log").read_text()

        run_streaming.assert_called_once()
        self.assertFalse(passed)
        self.assertIn("timed out after 0.2s", message)
        self.assertIn("playwright line 44", message)
        self.assertNotIn("playwright line 4\n", message)
        self.assertIn("[studio-playwright] playwright line 44", streamed.getvalue())
        self.assertIn("playwright line 44", log)
        self.assertEqual(saved["steps"][0]["capability"], "studio")
        self.assertEqual(saved["steps"][0]["status"], "FAIL")

    def test_failed_studio_shell_blocks_playwright(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "service-local.json"
            report.write_text(json.dumps({"status": "FAIL", "steps": []}))
            with patch("invocations.subprocess.run") as run:
                passed, elapsed, message = run_studio_browser_step(
                    ["playwright"], {}, report, "local", False)
            saved = json.loads(report.read_text())

        run.assert_not_called()
        self.assertFalse(passed)
        self.assertEqual(elapsed, 0.0)
        self.assertIn("shell check failed", message)
        self.assertEqual(saved["steps"][0]["status"], "BLOCKED")

    def test_playwright_tagged_cases_are_merged_into_release_claims(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "service-local.json"
            playwright = Path(directory) / "playwright.json"
            report.write_text(json.dumps({"case_run": {"claims": []}}))
            playwright.write_text(json.dumps({"suites": [{"specs": [{
                "title": "Studio schedules @S-055.2 toggles a project cron",
                "tests": [{"results": [{"status": "passed"}]}],
            }]}]}))

            _record_playwright_case_claims(report, str(playwright))
            saved = json.loads(report.read_text())

        self.assertEqual(saved["case_run"]["claims"], [
            {"claimId": "S-055.2", "kind": "journey", "status": "PASS"},
        ])


if __name__ == "__main__":
    unittest.main()
