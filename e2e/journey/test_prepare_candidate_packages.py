import os
from pathlib import Path
import subprocess
import tempfile
import unittest


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
PREPARE_SCRIPT = REPOSITORY_ROOT / "e2e/journey/prepare-candidate-packages.sh"


class PrepareCandidatePackagesTests(unittest.TestCase):
    def _fixture(self, *, fail_fresh_validation=False):
        temporary = tempfile.TemporaryDirectory(prefix="candidate-package-cache-")
        root = Path(temporary.name)
        packages = root / "packages"
        packages.mkdir()
        (root / "e2e/platform").mkdir(parents=True)
        scripts = root / "e2e/scripts"
        scripts.mkdir(parents=True)
        pack_log = root / "pack.log"
        pack_script = scripts / "pack-all.sh"
        pack_script.write_text(
            "#!/usr/bin/env bash\n"
            "set -euo pipefail\n"
            "printf fresh > \"$1/fresh.tgz\"\n"
            "printf '%s\\n' packed >> \"$PACK_LOG\"\n"
        )
        pack_script.chmod(0o755)
        validator = root / "e2e/platform/validate-package-outputs.mjs"
        validator.write_text("// fixture entry point\n")
        fake_bin = root / "bin"
        fake_bin.mkdir()
        fake_node = fake_bin / "node"
        fake_node.write_text(
            "#!/usr/bin/env python3\n"
            "import os, pathlib, sys\n"
            "packages = pathlib.Path(sys.argv[2])\n"
            "bad = any(packages.glob('stale.tgz')) or os.environ.get('FAIL_FRESH_VALIDATION') == '1'\n"
            "if bad:\n"
            "    print('ERROR: cached package metadata does not match workspace source', file=sys.stderr)\n"
            "    raise SystemExit(1)\n"
            "print('package metadata validated')\n"
        )
        fake_node.chmod(0o755)
        return temporary, root, packages, fake_bin, pack_log, fail_fresh_validation

    def _run(self, root, packages, fake_bin, pack_log, ready, *, fail_fresh_validation=False):
        env = {
            **os.environ,
            "PATH": f"{fake_bin}:{os.environ.get('PATH', '')}",
            "PACK_LOG": str(pack_log),
            "FAIL_FRESH_VALIDATION": "1" if fail_fresh_validation else "0",
        }
        return subprocess.run(
            [str(PREPARE_SCRIPT), str(root), str(packages), ready],
            text=True,
            capture_output=True,
            env=env,
            check=False,
        )

    def test_valid_restored_cache_is_used_without_repacking(self):
        temporary, root, packages, fake_bin, pack_log, _ = self._fixture()
        self.addCleanup(temporary.cleanup)
        (packages / "fresh.tgz").write_text("cached")

        result = self._run(root, packages, fake_bin, pack_log, "1")

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(pack_log.exists())
        self.assertEqual((packages / "fresh.tgz").read_text(), "cached")

    def test_invalid_restored_cache_is_discarded_repacked_and_revalidated(self):
        temporary, root, packages, fake_bin, pack_log, _ = self._fixture()
        self.addCleanup(temporary.cleanup)
        (packages / "stale.tgz").write_text("stale")

        result = self._run(root, packages, fake_bin, pack_log, "1")

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((packages / "stale.tgz").exists())
        self.assertTrue((packages / "fresh.tgz").exists())
        self.assertEqual(pack_log.read_text().splitlines(), ["packed"])
        self.assertIn("package metadata validated", result.stdout)
        self.assertIn("repacking", result.stderr.lower())

    def test_fresh_pack_validation_failure_remains_a_hard_error(self):
        temporary, root, packages, fake_bin, pack_log, _ = self._fixture()
        self.addCleanup(temporary.cleanup)
        (packages / "stale.tgz").write_text("stale")

        result = self._run(root, packages, fake_bin, pack_log, "1", fail_fresh_validation=True)

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(pack_log.read_text().splitlines(), ["packed"])
        self.assertIn("does not match workspace source", result.stderr)


if __name__ == "__main__":
    unittest.main()
