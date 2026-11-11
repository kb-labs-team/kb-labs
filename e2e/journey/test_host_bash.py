from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from test_environment import isolated_environment
import jsonl


ROOT = Path(__file__).resolve().parents[2]
JOURNEY = ROOT / "e2e/journey"


class HostBashTests(unittest.TestCase):
    # case: S-262.2
    def test_empty_monitor_and_container_lists_reach_cleanup_under_host_bash(self):
        with tempfile.TemporaryDirectory(prefix="journey-bash32-") as temporary:
            sandbox = Path(temporary)
            repo = sandbox / "repo"
            journey = repo / "e2e/journey"
            journey.mkdir(parents=True)
            (repo / "e2e/verdaccio").mkdir(parents=True)
            shutil.copy2(ROOT / "package.json", repo / "package.json")
            generated_policy = subprocess.run(
                ["node", str(ROOT / "tools/clikit/toolchain/generate-node-policy.mjs"), "--root", str(repo)],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(generated_policy.returncode, 0, generated_policy.stderr)
            shutil.copy2(ROOT / "e2e/verdaccio/clear-candidates.sh", repo / "e2e/verdaccio/clear-candidates.sh")
            for name in ("run.sh", "../compose-owner.sh", "candidate-services.sh", "runner-toolchain.sh", "teardown-compose.sh",
                         "container_outcomes.py", "jsonl.py"):
                shutil.copy2(JOURNEY / name, journey / name)

            bin_dir = sandbox / "bin"
            bin_dir.mkdir()
            (bin_dir / "bash").symlink_to("/bin/bash")
            calls_path = sandbox / "docker-calls.jsonl"
            self._install_docker(bin_dir / "docker")
            self._write_stub(
                bin_dir / "python3",
                f"#!{sys.executable}\nimport json, os, sys\n"
                "if sys.argv[1:2] == ['e2e/journey/container_outcomes.py'] and '--write-log-name' in sys.argv:\n"
                "    os.execv(sys.executable, [sys.executable, *sys.argv[1:]])\n"
                "if sys.argv[1:2] == ['-c']:\n"
                "    os.execv(sys.executable, [sys.executable, *sys.argv[1:]])\n"
                "if sys.argv[1:3] == ['e2e/journey/dispatch_registry.py', '--lanes']:\n"
                "    print('[]')\n"
                "if sys.argv[1:] == ['" + str(repo) + "/e2e/journey/journey_resources.py', '--toolchain-contract']:\n"
                "    print(json.dumps({'imageReference': 'kb-journey-runner-toolchain:test', 'imageLabel': 'dev.kblabs.journey.toolchain', 'imageArgument': 'KB_JOURNEY_TOOLCHAIN_IMAGE'}))\n"
                "raise SystemExit(0)\n",
            )
            self._write_stub(bin_dir / "git", "#!/bin/sh\nprintf 'test-revision\\n'\n")

            environment = isolated_environment(
                sandbox, bin_dir,
                required_tools=("bash", "git", "python3", "dirname", "id", "mkdir", "rm", "find", "date"),
                overrides={
                "FAKE_DOCKER_CALLS": str(calls_path),
                "KB_JOURNEY_ONLY": "service-local:explore",
                },
            )

            result = subprocess.run(
                ["/bin/bash", str(journey / "run.sh"), "--no-build"],
                cwd=repo,
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn("Journey package publisher container exited 17", result.stderr)
            self.assertIn("Next: cat .journey/reports/containers/publisher.log", result.stderr)
            publisher_log = repo / ".journey/reports/containers/publisher.log"
            self.assertTrue(publisher_log.is_file(), "nonzero publisher logs were not written to the journey report")
            self.assertEqual(publisher_log.read_text(encoding="utf-8"),
                             "container logs:\npublisher failed: missing package\n")
            docker_records = jsonl.read_jsonl(calls_path)
            self.assertEqual([row.line_number for row in docker_records if row.error is not None], [])
            docker_calls = [row.value for row in docker_records]
            ps_calls = [call for call in docker_calls if "ps" in call]
            self.assertEqual(len(ps_calls), 2, f"expected empty monitor and teardown listings: {docker_calls}")
            default_compose_calls = [call for call in docker_calls if call[:1] == ["compose"] and call[1:2] != ["version"]]
            self.assertTrue(default_compose_calls, f"no default-lane Compose calls were recorded: {docker_calls}")
            command_names = {"ps", "up", "run", "build", "exec", "stop", "down", "port"}
            selected_files = []
            for call in default_compose_calls:
                command_index = next(index for index, item in enumerate(call) if item in command_names)
                selected_files.append(call[1:command_index])
            self.assertTrue(all(files == selected_files[0] for files in selected_files),
                            f"default Compose commands did not reuse one owner file list: {selected_files}")
            self.assertIn(["wait", "publisher-container-id"], docker_calls, f"publisher wait did not use the created id: {docker_calls}")
            self.assertIn(["logs", "publisher-container-id"], docker_calls, f"publisher logs were not read: {docker_calls}")
            self.assertIn(["rm", "-f", "publisher-container-id"], docker_calls, f"publisher container cleanup did not use the created id: {docker_calls}")
            self.assertLess(docker_calls.index(["logs", "publisher-container-id"]),
                            docker_calls.index(["rm", "-f", "publisher-container-id"]),
                            f"publisher logs must be saved before container removal: {docker_calls}")
            self.assertTrue(
                any("down" in call and "--remove-orphans" in call and "--volumes" not in call for call in docker_calls),
                f"Compose teardown was not called: {docker_calls}",
            )

    @staticmethod
    def _install_docker(path: Path) -> None:
        path.write_text(
            f"#!{sys.executable}\n"
            "import os, sys\n"
            "sys.path.insert(0, 'e2e/journey')\n"
            "from jsonl import write_jsonl\n"
            "args = sys.argv[1:]\n"
            "write_jsonl(os.environ['FAKE_DOCKER_CALLS'], [args], append=True)\n"
            "action = next((item for item in args if item in {'version', 'ps', 'run', 'exec', 'down', 'build', 'up', 'stop', 'rm', 'logs', 'port'}), None)\n"
            "if action in {'version', 'ps', 'down', 'build', 'up', 'stop', 'rm'}: raise SystemExit(0)\n"
            "if action == 'run':\n    print('publisher-container-id')\n    raise SystemExit(0)\n"
            "if action == 'exec': raise SystemExit(1)\n"
            "if args[:1] == ['images']: raise SystemExit(0)\n"
            "if args[:1] == ['wait']:\n"
            "    print('17')\n"
            "    raise SystemExit(0)\n"
            "if action == 'logs':\n    print('publisher failed: missing package')\n    raise SystemExit(0)\n"
            "if action == 'port':\n    print('127.0.0.1:49183')\n    raise SystemExit(0)\n"
            "raise SystemExit(f'unmodeled Docker command: {args!r}')\n",
            encoding="utf-8",
        )
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    @staticmethod
    def _write_stub(path: Path, contents: str) -> None:
        path.write_text(contents, encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)


if __name__ == "__main__":
    unittest.main()
