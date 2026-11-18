import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from preflight_stage import run_logged_stage


STAGE_RUNNER = Path(__file__).with_name("preflight_stage.py")


class PreflightStageTests(unittest.TestCase):
    def test_success_emits_bounded_lifecycle_and_periodic_heartbeat(self):
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / "build.log"
            events = []
            status = run_logged_stage(
                "build", log, [sys.executable, "-c", "import time; print('complete log'); time.sleep(.08)"],
                heartbeat_seconds=.02, emit=events.append,
            )

            self.assertEqual(status, 0)
            self.assertIn("event=start", events[0])
            self.assertTrue(any("event=heartbeat" in event for event in events))
            self.assertIn("event=end status=pass exit_code=0", events[-1])
            self.assertTrue(all("at=" in event for event in events))
            self.assertIn("complete log", log.read_text())

    def test_failure_keeps_complete_raw_log_off_live_output_and_preserves_exit_code(self):
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / "unit.log"
            events = []
            secret_and_large_output = "private-token-abc" + ("x" * 100_000)
            status = run_logged_stage(
                "unit", log,
                [sys.executable, "-c", f"import sys; print({secret_and_large_output!r}); sys.exit(7)"],
                emit=events.append,
            )

            self.assertEqual(status, 7)
            self.assertIn("event=end status=fail exit_code=7", events[-1])
            self.assertIn(secret_and_large_output, log.read_text())
            self.assertNotIn("private-token-abc", "\n".join(events))

    def test_child_signaled_by_itself_uses_shell_compatible_exit_code(self):
        with tempfile.TemporaryDirectory() as temporary:
            events = []
            status = run_logged_stage(
                "unit", Path(temporary) / "unit.log",
                [sys.executable, "-c", "import os, signal; os.kill(os.getpid(), signal.SIGTERM)"],
                emit=events.append,
            )

            self.assertEqual(status, 128 + signal.SIGTERM)
            self.assertIn("event=end status=fail exit_code=143", events[-1])

    def test_signal_to_wrapper_escalates_for_the_whole_stage_group_and_reaps_leader(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            log = directory / "unit.log"
            grandchild_pid = directory / "grandchild.pid"
            grandchild_code = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"
            parent_code = (
                "import signal,subprocess,sys; "
                f"child=subprocess.Popen([sys.executable, '-c', {grandchild_code!r}]); "
                f"open({str(grandchild_pid)!r}, 'w').write(str(child.pid)); "
                "signal.signal(signal.SIGTERM, signal.SIG_IGN); child.wait()"
            )
            runner = subprocess.Popen(
                [
                    sys.executable, str(STAGE_RUNNER), "run", "--stage", "unit", "--log", str(log),
                    "--termination-grace-seconds", "0.2", "--", sys.executable, "-c", parent_code,
                ],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                start_new_session=True,
            )
            try:
                deadline = time.monotonic() + 5
                while not grandchild_pid.exists() and runner.poll() is None and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue(grandchild_pid.exists(), "stage did not start its grandchild")
                started = time.monotonic()
                os.kill(runner.pid, signal.SIGTERM)  # Signal only the wrapper PID.
                output, _ = runner.communicate(timeout=5)
                elapsed = time.monotonic() - started

                self.assertEqual(runner.returncode, 128 + signal.SIGTERM, output)
                self.assertIn("event=end status=fail exit_code=143", output)
                self.assertLess(elapsed, 3, "stage group was not escalated after the grace period")
            finally:
                if runner.poll() is None:
                    runner.kill()
                    runner.communicate(timeout=2)
                try:
                    os.killpg(runner.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


if __name__ == "__main__":
    unittest.main()
