from __future__ import annotations

import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


JOURNEY_DIR = Path(__file__).resolve().parent


class JourneyTeardownTests(unittest.TestCase):
    def test_collector_failure_still_removes_compose_resources(self):
        with tempfile.TemporaryDirectory(prefix="journey-teardown-") as temporary:
            root = Path(temporary)
            state_path = root / "docker-state.json"
            state_path.write_text(json.dumps({
                "containers": ["runner-kept", "platform-kept"],
                "volumes": ["journey-data"],
                "calls": [],
            }), encoding="utf-8")
            compose = root / "compose"
            compose.write_text(
                "#!/usr/bin/env python3\n"
                "import json, pathlib, sys\n"
                f"state_path = pathlib.Path({str(state_path)!r})\n"
                "state = json.loads(state_path.read_text())\n"
                "args = sys.argv[1:]\n"
                "if args[-3:] == ['ps', '-aq', '--all']:\n"
                "    state['calls'].append(['ps', args[:-3]])\n"
                "    state_path.write_text(json.dumps(state))\n"
                "    print('\\n'.join(state['containers']))\n"
                "elif args[-2:] == ['down', '--remove-orphans']:\n"
                "    state['calls'].append(['down', args[:-2]])\n"
                "    state['containers'] = []\n"
                "    state_path.write_text(json.dumps(state))\n"
                "else:\n"
                "    raise SystemExit(f'unmodeled Docker command: {args!r}')\n",
                encoding="utf-8",
            )
            compose.chmod(compose.stat().st_mode | stat.S_IXUSR)
            invalid_report = root / "report-path-is-a-file"
            invalid_report.write_text("forces the real outcome collector to fail", encoding="utf-8")
            environment = os.environ.copy()
            environment["PATH"] = f"{root}{os.pathsep}{environment['PATH']}"
            result = subprocess.run(
                [
                    "bash",
                    str(JOURNEY_DIR / "teardown-compose.sh"),
                    "0",
                    str(invalid_report),
                    "2026-10-14T00:00:00Z",
                    str(compose),
                ],
                cwd=JOURNEY_DIR.parents[1],
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn("Journey container outcome capture failed", result.stderr)
            self.assertIn("Next: e2e/journey/run.sh --down", result.stderr)
            state = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual([call[0] for call in state["calls"]], ["ps", "down"])
            self.assertEqual(state["calls"][0][1], state["calls"][1][1],
                             "outcome ps and teardown down used different owner arguments")
            self.assertEqual(state["containers"], [])
            self.assertEqual(state["volumes"], ["journey-data"])


if __name__ == "__main__":
    unittest.main()
