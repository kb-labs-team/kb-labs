from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


class PrepareRegistryDeployArtifactsTest(unittest.TestCase):
    def test_prepares_both_production_trees_and_shared_image_config(self):
        source_root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="journey-registry-deploy-") as temporary:
            root = Path(temporary)
            (root / "e2e/journey").mkdir(parents=True)
            (root / "tools/release").mkdir(parents=True)
            script = root / "e2e/journey/prepare-registry-deploy-artifacts.sh"
            script.write_bytes((source_root / "e2e/journey/prepare-registry-deploy-artifacts.sh").read_bytes())
            commands = root / "commands.log"
            bin_dir = root / "bin"
            bin_dir.mkdir()
            pnpm = bin_dir / "pnpm"
            pnpm.write_text(
                "#!/bin/sh\n"
                f"printf 'pnpm %s\\n' \"$*\" >> '{commands}'\n"
                "target=\"${@: -1}\"\n"
                "mkdir -p \"$target\"\n"
                "printf ready > \"$target/ready\"\n",
                encoding="utf-8",
            )
            # Use POSIX sh in the stub: capture pnpm's final positional argument.
            pnpm.write_text(pnpm.read_text().replace('target="${@: -1}"', 'for target do :; done'), encoding="utf-8")
            pnpm.chmod(0o755)
            node = bin_dir / "node"
            node.write_text(
                "#!/bin/sh\n"
                f"printf 'node %s\\n' \"$*\" >> '{commands}'\n"
                "for target do :; done\n"
                "mkdir -p \"${target%/*}\"\n"
                "printf config > \"$target\"\n",
                encoding="utf-8",
            )
            node.chmod(0o755)
            env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}")

            result = subprocess.run(["bash", str(script)], cwd=root, env=env,
                                    text=True, capture_output=True, check=False)

            self.assertEqual(0, result.returncode, result.stderr)
            self.assertTrue((root / ".journey/deploy/manual/state-daemon/ready").is_file())
            self.assertTrue((root / ".journey/deploy/manual/marketplace-registry-app/ready").is_file())
            self.assertTrue((root / ".journey/deploy/manual/image-default/kb.config.json").is_file())
            calls = commands.read_text(encoding="utf-8").splitlines()
            self.assertEqual(3, len(calls))
            self.assertIn("--filter @kb-labs/core-state-daemon --prod .journey/deploy/manual/state-daemon", calls[0])
            self.assertIn("--filter @kb-labs/marketplace-registry-app --prod .journey/deploy/manual/marketplace-registry-app", calls[1])
            self.assertEqual("node tools/release/generate-platform-image-default.mjs .journey/deploy/manual/image-default/kb.config.json", calls[2])


if __name__ == "__main__":
    unittest.main()
