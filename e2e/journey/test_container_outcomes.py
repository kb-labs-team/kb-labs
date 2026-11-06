from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from container_outcomes import DockerCLI, collect_container_outcomes, decode_engine_log_stream
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
            "ExitCode": 137, "OOMKilled": True, "Error": "",
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
