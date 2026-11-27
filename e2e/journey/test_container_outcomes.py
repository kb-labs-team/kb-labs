from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from container_outcomes import DockerCLI, _verdict, collect_container_outcomes, decode_engine_log_stream, monitor_container
import jsonl


class DockerModel:
    """Independent model of inspect, logs, events and stats at container teardown."""
    def __init__(self, states):
        self.states = states

    def inspect(self, container_id):
        return self.states[container_id]["inspect"]

    def logs(self, container_id):
        return self.states[container_id]["logs"]

    def events(self, since):
        return [
            {"Action": "oom", "Actor": {"ID": "oom-id"}, "time": 15},
            {"Action": "kill", "Actor": {"ID": "signal-id"}, "time": 16},
            {"Action": "die", "Actor": {"ID": "exit-id"}, "time": 17},
        ]

    def metrics(self, container_id):
        return self.states[container_id]["metrics"]


class ContainerOutcomeTests(unittest.TestCase):
    def test_final_metrics_exec_race_is_unavailable_only_after_container_exits(self):
        class ExitingContainer:
            def __init__(self):
                self.exited = False
                self.log_reads = 0

            def inspect(self, _container_id):
                if not self.exited:
                    return {"Id": "container-id", "Name": "/origin",
                            "State": {"Running": True, "ExitCode": 0,
                                      "OOMKilled": False, "Error": "", "FinishedAt": ""}}
                return {"Id": "container-id", "Name": "/origin",
                        "State": {"Running": False, "ExitCode": 137,
                                  "OOMKilled": True, "Error": "oom", "FinishedAt": "now"}}

            def logs(self, _container_id):
                self.log_reads += 1
                return {"stdout": "before exit\n" if self.log_reads == 1 else "oom output\n",
                        "stderr": ""}

            def events(self, _since):
                return [{"Action": "oom", "Actor": {"ID": "container-id"}}]

            def metrics(self, _container_id):
                self.exited = True
                raise RuntimeError("docker exec failed: exit 137")

        with tempfile.TemporaryDirectory(prefix="journey-container-outcome-") as directory:
            outcomes = collect_container_outcomes(ExitingContainer(), ["container-id"],
                                                   directory, since="now")
        self.assertEqual(outcomes[0]["metrics"]["memoryPeakBytes"], None)
        self.assertEqual(outcomes[0]["metrics"]["unavailable"],
                         "container exited before final metrics sampling")
        self.assertEqual(outcomes[0]["state"]["ExitCode"], 137)
        self.assertTrue(outcomes[0]["state"]["OOMKilled"])
        self.assertEqual(outcomes[0]["stdout"], "oom output\n")
        self.assertEqual(outcomes[0]["events"][0]["Action"], "oom")
        self.assertIn("origin killed by OOM", outcomes[0]["verdict"])

    def test_final_metrics_exec_failure_stays_fatal_while_container_runs(self):
        class RunningContainer:
            def inspect(self, _container_id):
                return {"Id": "container-id", "Name": "/origin",
                        "State": {"Running": True}}

            def logs(self, _container_id):
                return {"stdout": "", "stderr": ""}

            def events(self, _since):
                return []

            def metrics(self, _container_id):
                raise RuntimeError("docker exec failed while container is running")

        with tempfile.TemporaryDirectory(prefix="journey-container-outcome-") as directory:
            with self.assertRaisesRegex(RuntimeError, "container is running"):
                collect_container_outcomes(RunningContainer(), ["container-id"],
                                           directory, since="now")

        class UnknownContainerState(RunningContainer):
            def __init__(self):
                self.inspections = iter((True, None))

            def inspect(self, _container_id):
                return {"Id": "container-id", "Name": "/origin",
                        "State": {"Running": next(self.inspections)}}

        with tempfile.TemporaryDirectory(prefix="journey-container-outcome-") as directory:
            with self.assertRaisesRegex(RuntimeError, "container is running"):
                collect_container_outcomes(UnknownContainerState(), ["container-id"],
                                           directory, since="now")

    def test_terminal_event_refreshes_state_logs_and_verdict_after_last_running_inspect(self):
        class ExitingAfterInspect:
            def __init__(self):
                self.exited = False
                self.log_reads = 0

            def inspect(self, _container_id):
                if self.exited:
                    return {"Id": "container-id", "Name": "/origin",
                            "State": {"Running": False, "ExitCode": 137,
                                      "OOMKilled": True, "Error": "", "FinishedAt": "now"}}
                return {"Id": "container-id", "Name": "/origin",
                        "State": {"Running": True, "ExitCode": 0,
                                  "OOMKilled": False, "Error": "", "FinishedAt": ""}}

            def logs(self, _container_id):
                self.log_reads += 1
                return {"stdout": "stale live output\n" if self.log_reads == 1 else "final oom output\n",
                        "stderr": ""}

            def metrics(self, _container_id):
                return {"memoryCurrentBytes": 1024, "memoryPeakBytes": 2048,
                        "freeDiskBytes": 4096}

            def events(self, _since):
                self.exited = True
                return [
                    {"Action": "oom", "Actor": {"ID": "container-id"}},
                    {"Action": "die", "Actor": {"ID": "container-id",
                        "Attributes": {"exitCode": "137"}}},
                ]

        with tempfile.TemporaryDirectory(prefix="journey-container-outcome-") as directory:
            outcomes = collect_container_outcomes(ExitingAfterInspect(), ["container-id"],
                                                   directory, since="now")
            log = (Path(directory) / outcomes[0]["logPath"]).read_text()

        self.assertFalse(outcomes[0]["state"]["Running"])
        self.assertEqual(outcomes[0]["state"]["ExitCode"], 137)
        self.assertEqual(outcomes[0]["stdout"], "final oom output\n")
        self.assertEqual(outcomes[0]["events"][-1]["Action"], "die")
        self.assertIn("killed by OOM (exit 137)", outcomes[0]["verdict"])
        self.assertEqual(log, "stdout:\nfinal oom output\nstderr:\n")

    def test_verdict_reports_live_containers_as_running(self):
        container = {"id": "live-id", "name": "/origin",
                     "state": {"Running": True, "ExitCode": 0, "OOMKilled": False},
                     "stdout": "", "stderr": ""}
        self.assertEqual(_verdict(container, []), "origin still running")

    def test_verdict_uses_zero_die_event_when_inspect_is_stale(self):
        container = {"id": "clean-id", "name": "/origin",
                     "state": {"Running": True, "ExitCode": 0, "OOMKilled": False},
                     "stdout": "", "stderr": ""}
        events = [{"Action": "die", "Actor": {"ID": "clean-id",
                   "Attributes": {"exitCode": "0"}}}]
        self.assertEqual(_verdict(container, events), "origin exited 0 after terminal event")

    def test_verdict_uses_oom_event_exit_code_when_inspect_is_stale(self):
        container = {"id": "oom-id", "name": "/origin",
                     "state": {"Running": True, "ExitCode": 0, "OOMKilled": False},
                     "stdout": "", "stderr": ""}
        events = [
            {"Action": "oom", "Actor": {"ID": "oom-id"}},
            {"Action": "die", "Actor": {"ID": "oom-id",
                "Attributes": {"exitCode": "137"}}},
        ]
        self.assertEqual(_verdict(container, events), "origin killed by OOM (exit 137)")

    def test_verdict_keeps_kill_signal_reason_ahead_of_terminal_exit_summary(self):
        container = {"id": "killed-id", "name": "/origin",
                     "state": {"Running": False, "ExitCode": 137,
                               "OOMKilled": False, "Error": "signal 9"},
                     "stdout": "", "stderr": "shutdown interrupted\n"}
        events = [{"Action": "kill", "Actor": {"ID": "killed-id",
                   "Attributes": {"signal": "9"}}},
                  {"Action": "die", "Actor": {"ID": "killed-id",
                   "Attributes": {"exitCode": "137"}}}]
        self.assertEqual(_verdict(container, events), "origin killed by 9")

    def test_verdict_keeps_stderr_reason_for_nonzero_die_event(self):
        container = {"id": "failed-id", "name": "/origin",
                     "state": {"Running": False, "ExitCode": None,
                               "OOMKilled": False, "Error": ""},
                     "stdout": "", "stderr": "fatal worker error\n"}
        events = [{"Action": "die", "Actor": {"ID": "failed-id",
                   "Attributes": {"exitCode": "137"}}}]
        self.assertEqual(_verdict(container, events),
                         "origin exited 137 after reason fatal worker error")

    def test_monitor_treats_metrics_exec_race_as_normal_only_after_container_exits(self):
        class ExitingPublisher:
            def __init__(self):
                self.inspections = iter((True, False))

            def inspect(self, _container_id):
                return {"State": {"Running": next(self.inspections)}}

            def metrics(self, _container_id):
                raise RuntimeError("docker exec lost the container namespace")

        with tempfile.TemporaryDirectory(prefix="journey-container-monitor-") as directory:
            monitor_container(ExitingPublisher(), "publisher-id", directory)
            self.assertFalse((Path(directory) / "container-metrics.jsonl").exists())

        class StillRunningPublisher:
            def inspect(self, _container_id):
                return {"State": {"Running": True}}

            def metrics(self, _container_id):
                raise RuntimeError("docker exec failed while container is running")

        with tempfile.TemporaryDirectory(prefix="journey-container-monitor-") as directory:
            with self.assertRaisesRegex(RuntimeError, "container is running"):
                monitor_container(StillRunningPublisher(), "publisher-id", directory)

    def test_docker_events_use_lf_jsonl_framing_for_unicode_separators(self):
        unusual = "NEL\x85 LS\u2028 FS\x1c"
        output = jsonl.encode_jsonl_records(({
            "Action": "die", "Actor": {"Attributes": {"note": unusual}},
        },))
        backend = DockerCLI()
        with patch.object(backend, "_run", return_value=output):
            events = backend.events("2026-10-14T09:00:00Z")
        self.assertEqual(events[0]["Actor"]["Attributes"]["note"], unusual)

    # case: S-262.2
    def test_engine_log_stream_keeps_stdout_and_stderr_distinct_and_rejects_truncation(self):
        def frame(channel, payload):
            return bytes([channel, 0, 0, 0]) + len(payload).to_bytes(4, "big") + payload

        decoded = decode_engine_log_stream(frame(1, b"stdout") + frame(2, b"stderr"), "container-id")
        self.assertEqual(decoded, {"stdout": "stdout", "stderr": "stderr"})
        with self.assertRaisesRegex(ValueError, "truncated log frame"):
            decode_engine_log_stream(b"\x01\x00", "container-id")

    def test_records_oom_kill_and_nonzero_with_events_outputs_metrics_and_verdicts(self):
        model = DockerModel({
            "oom-id": {"inspect": {"Id": "oom-id", "Name": "/runner", "State": {
                "ExitCode": 137, "OOMKilled": True, "Error": "", "FinishedAt": "2026-10-14T10:00:00Z"}},
                "logs": {"stdout": "partial steps\n", "stderr": "",},
                "metrics": {"memoryCurrentBytes": 8192, "memoryPeakBytes": 16384, "freeDiskBytes": 4096}},
            "signal-id": {"inspect": {"Id": "signal-id", "Name": "/platform", "State": {
                "ExitCode": 137, "OOMKilled": False, "Error": "signal 9", "FinishedAt": "2026-10-14T10:01:00Z"}},
                "logs": {"stdout": "", "stderr": "stopped\n"},
                "metrics": {"memoryCurrentBytes": 0, "memoryPeakBytes": 32768, "freeDiskBytes": 2048}},
            "exit-id": {"inspect": {"Id": "exit-id", "Name": "/worker", "State": {
                "ExitCode": 1, "OOMKilled": False, "Error": "", "FinishedAt": "2026-10-14T10:02:00Z"}},
                "logs": {"stdout": "setup started\nfailed step: bad config\n", "stderr": ""},
                "metrics": {"memoryCurrentBytes": 1024, "memoryPeakBytes": 2048, "freeDiskBytes": 1024}},
        })
        with tempfile.TemporaryDirectory(prefix="journey-container-outcome-") as directory:
            outcomes = collect_container_outcomes(model, ["oom-id", "signal-id", "exit-id"],
                                                   directory, since="2026-10-14T09:00:00Z")
            record = json.loads((Path(directory) / "container-outcomes.json").read_text())
            verdicts = (Path(directory) / "container-verdicts.txt").read_text()
            worker_log = (Path(directory) / "containers/worker.log").read_text()
        self.assertEqual(len(record["containers"]), 3)
        self.assertEqual(record["events"], model.events("2026-10-14T09:00:00Z"))
        self.assertEqual(record["containers"][0]["state"], {
            "Running": None, "ExitCode": 137, "OOMKilled": True, "Error": "",
            "FinishedAt": "2026-10-14T10:00:00Z",
        })
        self.assertEqual(record["containers"][0]["stdout"], "partial steps\n")
        self.assertEqual(record["containers"][1]["stderr"], "stopped\n")
        self.assertEqual(record["containers"][2]["metrics"]["freeDiskBytes"], 1024)
        self.assertEqual(record["containers"][0]["metrics"]["memoryPeakBytes"], 16384)
        self.assertIn("runner killed by OOM", verdicts)
        self.assertIn("platform killed by signal 9", verdicts)
        self.assertIn("worker exited 1 after reason failed step: bad config", verdicts)
        self.assertEqual(worker_log, "stdout:\nsetup started\nfailed step: bad config\nstderr:\n")
        self.assertIn("Next: cat ", outcomes[2]["verdict"])
        self.assertEqual(outcomes[2]["logPath"], "containers/worker.log")
        self.assertEqual(len(outcomes), 3)


if __name__ == "__main__":
    unittest.main()
