import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from invocations import run_logged_stage as invocation_run_logged_stage
from preflight_stage import run_logged_stage


STAGE_RUNNER = Path(__file__).with_name("preflight_stage.py")


class PreflightStageTests(unittest.TestCase):
    def test_stage_runner_uses_the_shared_process_creation_owner(self):
        self.assertIs(run_logged_stage, invocation_run_logged_stage)

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

    def test_leader_exit_cleans_remaining_group_and_preserves_leader_status(self):
        for leader_exit in (0, 143):
            with self.subTest(leader_exit=leader_exit), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                ready = directory / "grandchild-ready"
                term_seen = directory / "grandchild-term-seen"
                survived = directory / "grandchild-survived"
                group_file = directory / "stage-group.txt"
                child_code = (
                    "import pathlib,signal,sys,time; "
                    "signal.signal(signal.SIGTERM, lambda *_: pathlib.Path(sys.argv[2]).touch()); "
                    "pathlib.Path(sys.argv[1]).touch(); time.sleep(.7); "
                    f"pathlib.Path({str(survived)!r}).touch()"
                )
                leader_code = (
                    "import os,pathlib,signal,subprocess,sys,time; "
                    f"subprocess.Popen([sys.executable, '-c', {child_code!r}, {str(ready)!r}, {str(term_seen)!r}]); "
                    f"pathlib.Path({str(group_file)!r}).write_text(str(os.getpgrp())); "
                    f"deadline=time.monotonic()+2; "
                    f"exec(\"while not pathlib.Path({str(ready)!r}).exists() and time.monotonic()<deadline: time.sleep(.01)\"); "
                    f"(os.kill(os.getpid(), signal.SIGTERM) if {leader_exit} == 143 else sys.exit(0))"
                )
                events = []
                started = time.monotonic()
                try:
                    status = run_logged_stage(
                        "unit", directory / "unit.log", [sys.executable, "-c", leader_code],
                        termination_grace_seconds=.1, emit=events.append,
                    )
                    elapsed = time.monotonic() - started
                    self.assertTrue(ready.exists(), "grandchild did not start before leader exit")
                    self.assertTrue(term_seen.exists(), "remaining group was not terminated after leader exit")
                    self.assertEqual(status, leader_exit)
                    expected_status = "pass" if leader_exit == 0 else "fail"
                    self.assertIn(f"event=end status={expected_status} exit_code={leader_exit}", events[-1])
                    self.assertGreaterEqual(elapsed, .08, "group cleanup skipped its grace period")
                    self.assertLess(elapsed, 1, "group cleanup did not escalate promptly")
                    time.sleep(.8)
                    self.assertFalse(survived.exists(), "grandchild survived leader exit cleanup")
                finally:
                    if group_file.exists():
                        try:
                            os.killpg(int(group_file.read_text()), signal.SIGKILL)
                        except ProcessLookupError:
                            pass

    def test_signal_to_wrapper_escalates_for_the_whole_stage_group_and_reaps_leader(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            log = directory / "unit.log"
            group_file = directory / "stage-group.txt"
            term_seen = directory / "grandchild-term-seen"
            survived = directory / "grandchild-survived"
            grandchild_code = (
                "import pathlib,signal,sys,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                "pathlib.Path(sys.argv[1]).touch(); time.sleep(.7); pathlib.Path(sys.argv[2]).touch()"
            )
            parent_code = (
                "import os,pathlib,signal,subprocess,sys; "
                "signal.signal(signal.SIGTERM, lambda *_: sys.exit(0)); "
                f"child=subprocess.Popen([sys.executable, '-c', {grandchild_code!r}, {str(term_seen)!r}, {str(survived)!r}]); "
                f"pathlib.Path({str(group_file)!r}).write_text(str(os.getpgrp())); "
                "child.wait()"
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
                while (not group_file.exists() or not term_seen.exists()) and runner.poll() is None and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue(group_file.exists() and term_seen.exists(), "stage did not start its grandchild")
                started = time.monotonic()
                os.kill(runner.pid, signal.SIGTERM)  # Signal only the wrapper PID.
                output, _ = runner.communicate(timeout=5)
                elapsed = time.monotonic() - started

                self.assertEqual(runner.returncode, 128 + signal.SIGTERM, output)
                self.assertIn("event=end status=fail exit_code=143", output)
                self.assertGreaterEqual(elapsed, .15, "cleanup skipped the grace period after the leader exited")
                self.assertLess(elapsed, 3, "stage group was not escalated after the grace period")
                time.sleep(.8)
                self.assertFalse(survived.exists(), "grandchild survived the stage group escalation")
            finally:
                if group_file.exists():
                    try:
                        os.killpg(int(group_file.read_text()), signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                if runner.poll() is None:
                    runner.kill()
                    runner.communicate(timeout=2)


if __name__ == "__main__":
    unittest.main()
