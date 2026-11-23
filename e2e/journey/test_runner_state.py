from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from service_runner import main as service_main, service_check
from runner import missing_service_report_detail


class RunnerStateBoundaryTests(unittest.TestCase):
    def test_missing_service_report_diagnostic_includes_both_redacted_streams(self):
        secret = "service-token-value-12345"
        result = SimpleNamespace(
            returncode=0,
            stdout=f"runner started token={secret}",
            stderr="failed before report write",
        )

        detail = missing_service_report_detail(
            result, Path("/summary/service-local.json"), {"KB_JOURNEY_SERVICE_TOKEN": secret})

        self.assertIn("exited 0", detail)
        self.assertIn("/summary/service-local.json", detail)
        self.assertIn("runner started token=[REDACTED]", detail)
        self.assertIn("failed before report write", detail)
        self.assertNotIn(secret, detail)

    def test_service_runner_blocks_failed_project_state_and_keeps_independent_checks(self):
        with tempfile.TemporaryDirectory(prefix="service-runner-failed-project-state-") as directory:
            output = Path(directory) / "service-local.json"
            evidence = "kb project show exited 7: secondary shim missing"
            inherited = json.dumps({
                "host-running": {"passed": True, "evidence": "host is running"},
                "project-registered": {"passed": False, "evidence": evidence,
                                       "group": "project", "step": "kb project show/list",
                                       "claim": "no case claim"},
            })
            declared = [
                service_check("project-dependent gateway check", "gateway", lambda: None,
                              cases=["PC-002.3"]),
                service_check("independent auth check", "auth.local", lambda: None,
                              cases=["S-110.1"]),
            ]
            with patch("service_runner.checks", return_value=declared), \
                    patch("service_runner.configure_installed_cli_path"), \
                    patch("service_runner.archive_service_logs"), \
                    patch.dict(os.environ, {
                        "HOME": directory,
                        "PATH": os.environ.get("PATH", ""),
                        "KB_JOURNEY_PLATFORM_ROOT": str(Path(directory) / "platform"),
                        "KB_JOURNEY_STATES": inherited,
                    }, clear=True), \
                    patch("sys.argv", ["service_runner.py", "--mode", "local", "--output", str(output)]), \
                    redirect_stdout(io.StringIO()):
                code = service_main()

            self.assertEqual(code, 1)
            self.assertTrue(output.is_file())
            result = json.loads(output.read_text())
            by_name = {step["name"]: step for step in result["steps"]}
            self.assertEqual(by_name["project-dependent gateway check"]["status"], "BLOCKED")
            self.assertIn("project-registered", by_name["project-dependent gateway check"]["message"])
            self.assertIn(evidence, by_name["project-dependent gateway check"]["message"])
            self.assertEqual(by_name["independent auth check"]["status"], "PASS")
