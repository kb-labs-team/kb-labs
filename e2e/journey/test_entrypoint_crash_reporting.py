from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


JOURNEY_DIR = Path(__file__).resolve().parent


class RunnerCrashReportingTests(unittest.TestCase):
    def _run_runner(self, body: str, *, limit_output: bool = False, cleanup_failure: bool = False,
                    selected: bool = False, crash_before_journey: bool = False):
        temporary = tempfile.TemporaryDirectory(prefix="journey-crash-report-")
        root = Path(temporary.name)
        home = root / "home"
        home.mkdir()
        runner = root / "injected_runner.py"
        runner.write_text(
            ("raise RuntimeError('injected early exception')\n" if crash_before_journey else
             "from service_steps import Journey\n"
             "CASE_JOURNEY = Journey('local', 'crash-test')\n"
             "CASE_JOURNEY.step('completed before crash', 'journey.test', lambda: None)\n")
            + ("def cleanup():\n    raise RuntimeError('injected cleanup failure')\n" if cleanup_failure else "")
            + "def main():\n"
            + "\n".join(f"    {line}" for line in body.splitlines())
            + "\n",
            encoding="utf-8",
        )
        summary = root / "journey-summary.md"
        bootstrap = root / "invoke_entrypoint.py"
        bootstrap.write_text(
            "import sys\n"
            + ("import resource, signal\nresource.setrlimit(resource.RLIMIT_FSIZE, (1, 1))\nsignal.signal(signal.SIGXFSZ, signal.SIG_IGN)\n"
               if limit_output else "")
            + "from entrypoint import run_runner\n"
            + ("from journey_selection import read_journey_selection, use_journey_selection\n"
               "requested = read_journey_selection({'KB_JOURNEY_CASES': 'S-268.1,S-268.11', "
               "'KB_JOURNEY_SELECTED_STEPS': 'S-268.1,S-268.11', "
               "'KB_JOURNEY_SELECTED_OWNING_STEPS': '{\\\"publish package\\\":[\\\"S-268.1\\\",\\\"S-268.11\\\"]}'})\n"
               "with use_journey_selection(requested):\n"
               "    raise SystemExit(run_runner(sys.argv[1], sys.argv[2], 'secured', selection=requested))\n"
               if selected else "raise SystemExit(run_runner(sys.argv[1], sys.argv[2], 'local'))\n"),
            encoding="utf-8",
        )
        env = os.environ.copy()
        env["HOME"] = str(home)
        env["PYTHONPATH"] = str(JOURNEY_DIR)
        result = subprocess.run(
            [sys.executable, "-B", str(bootstrap), str(runner), str(summary)],
            cwd=JOURNEY_DIR,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        return temporary, root, result

    def _assert_failure_report(self, temporary, root: Path, result: subprocess.CompletedProcess[str], reason: str):
        with temporary:
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            rendered = result.stdout + result.stderr
            self.assertIn(reason, rendered)
            self.assertIn("Next: cat ", result.stdout)
            report_path = root / "service-local.json"
            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertTrue(any(step["name"] == "completed before crash" for step in report["steps"]))
            self.assertTrue(any(step["name"] == "runner crash" for step in report["steps"]))
            diagnostics = (root / "journey-diagnostics.log").read_text(encoding="utf-8")
            self.assertIn(reason, diagnostics)

    def test_uncaught_exception_keeps_partial_steps_and_reason(self):
        temporary, root, result = self._run_runner("raise RuntimeError('injected exception')")
        self._assert_failure_report(temporary, root, result, "injected exception")

    def test_crash_before_journey_preserves_requested_claim_selection(self):
        temporary, root, result = self._run_runner(
            "raise RuntimeError('unused')", selected=True, crash_before_journey=True)
        with temporary:
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            report = json.loads((root / "service-secured.json").read_text(encoding="utf-8"))
            self.assertEqual(report["case_run"]["selection"], ["S-268.1", "S-268.11"])
            self.assertEqual(report["case_run"]["selectedClaims"], ["S-268.1", "S-268.11"])
            self.assertEqual(report["case_run"]["selectedOwningSteps"], {
                "publish package": ["S-268.1", "S-268.11"]})
            scoreboard = json.loads((root / "case-scoreboard-secured.json").read_text(encoding="utf-8"))
            self.assertEqual(scoreboard["selection"], ["S-268.1", "S-268.11"])
            target_case = next(case for case in scoreboard["cases"] if case["id"] == "S-268")
            self.assertEqual(target_case["status"], "Unclaimed")
            self.assertEqual(target_case["passingClaims"], [])

    def test_helper_system_exit_keeps_partial_steps_and_reason(self):
        temporary, root, result = self._run_runner("raise SystemExit(17)")
        self._assert_failure_report(temporary, root, result, "SystemExit")

    def test_sigterm_keeps_partial_steps_and_reason(self):
        temporary, root, result = self._run_runner("import os, signal\nos.kill(os.getpid(), signal.SIGTERM)")
        self._assert_failure_report(temporary, root, result, "SIGTERM")

    def test_cleanup_exception_is_reported_after_main_returns(self):
        temporary, root, result = self._run_runner("return 0", cleanup_failure=True)
        self._assert_failure_report(temporary, root, result, "injected cleanup failure")

    def test_report_write_failure_keeps_reason_on_stdout(self):
        temporary, _root, result = self._run_runner("raise RuntimeError('before write failure')", limit_output=True)
        with temporary:
            self.assertEqual(result.returncode, 1)
            rendered = result.stdout + result.stderr
            self.assertIn("before write failure", rendered)
            self.assertIn("could not write", rendered)


if __name__ == "__main__":
    unittest.main()
