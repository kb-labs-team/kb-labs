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
    def test_waits_for_complete_wizard_prompt_across_partial_reads(self):
        transcript = bytearray()
        transcript.extend(b"Project directory (press Enter to install")
        self.assertFalse(SMOKE._wizard_prompt_ready(transcript))

        transcript.extend(b" without a project):")
        self.assertFalse(SMOKE._wizard_prompt_ready(transcript))

        transcript.extend(b" ")
        self.assertTrue(SMOKE._wizard_prompt_ready(transcript))

    def test_requires_real_wizard_prompt(self):
        self.assertFalse(SMOKE._wizard_prompt_ready(b"Project directory was selected"))
        self.assertTrue(SMOKE._wizard_prompt_ready(
            b"Project directory (press Enter to install without a project): "
        ))


if __name__ == "__main__":
    unittest.main()
