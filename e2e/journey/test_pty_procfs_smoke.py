from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
SMOKE_SCRIPT = ROOT / "e2e" / "journey" / "pty-procfs-smoke.py"
SPEC = importlib.util.spec_from_file_location("pty_procfs_smoke", SMOKE_SCRIPT)
assert SPEC is not None and SPEC.loader is not None
SMOKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SMOKE)


class PtyProcfsSmokeTranscriptTests(unittest.TestCase):
    def test_waits_for_complete_terminal_line_across_partial_reads(self):
        transcript = bytearray()
        transcript.extend(b"PTY-PROCFS-SMOKE:/dev/pts/")
        self.assertIsNone(SMOKE._terminal_announcement(transcript))

        transcript.extend(b"17\r")
        self.assertIsNone(SMOKE._terminal_announcement(transcript))

        transcript.extend(b"\n")
        self.assertEqual(SMOKE._terminal_announcement(transcript), "/dev/pts/17")

    def test_ignores_prefix_before_complete_marker_and_line(self):
        self.assertIsNone(SMOKE._terminal_announcement(b"startup PTY-PROCFS-SMOKE:/dev/pts/3"))
        self.assertEqual(
            SMOKE._terminal_announcement(b"startup PTY-PROCFS-SMOKE:/dev/pts/3\n"),
            "/dev/pts/3",
        )


if __name__ == "__main__":
    unittest.main()
