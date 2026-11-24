import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PHASE_TIMING = ROOT / "e2e/journey/phase-timing.sh"


class JourneyPhaseTimingTests(unittest.TestCase):
    def test_phase_markers_include_utc_time_and_elapsed_seconds(self):
        result = subprocess.run(
            [
                "bash",
                "-c",
                'source "$1"; journey_phase_start pack; SECONDS=$((SECONDS + 3)); journey_phase_end',
                "journey-phase-timing-test",
                str(PHASE_TIMING),
            ],
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stderr.splitlines()
        self.assertEqual(len(lines), 2, result.stderr)
        self.assertRegex(lines[0], r"^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\] phase=start name=pack$")
        completed = re.fullmatch(
            r"\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\] phase=complete name=pack elapsed_seconds=(\d+)",
            lines[1],
        )
        self.assertIsNotNone(completed, result.stderr)
        self.assertGreaterEqual(int(completed.group(1)), 3)


if __name__ == "__main__":
    unittest.main()
