import tempfile
import subprocess
import sys
import unittest
from pathlib import Path

from verify_registry_deploy_inputs import REQUIRED, missing_inputs


class RegistryDeployInputTests(unittest.TestCase):
    def test_reports_missing_image_inputs_explicitly(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.assertEqual(missing_inputs(root), list(REQUIRED))
            result = subprocess.run(
                [sys.executable, str(Path(__file__).with_name("verify_registry_deploy_inputs.py")), str(root)],
                text=True, capture_output=True, check=False,
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("missing required image inputs", result.stderr)
            self.assertIn("state-daemon/node_modules", result.stderr)

    def test_accepts_complete_local_image_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for item in REQUIRED:
                path = root / item
                path.mkdir(parents=True, exist_ok=True) if not item.endswith(".json") else path.parent.mkdir(parents=True, exist_ok=True)
                if item.endswith(".json"):
                    path.write_text("{}\n", encoding="utf-8")
            self.assertEqual(missing_inputs(root), [])


if __name__ == "__main__":
    unittest.main()
