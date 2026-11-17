from __future__ import annotations

from pathlib import Path
import subprocess
import tempfile
import unittest
import json
import os

from installed_cli_contract_steps import check_installed_cli_contract, check_installed_cli_node_engine, run_installed_cli_contract_steps
from invocations import catalogued_error_hint
from service_steps import Journey


class InstalledCLIContractStepsTest(unittest.TestCase):
    def test_installed_cli_accepts_rendered_root_command_syntax_as_usage(self):
        with tempfile.TemporaryDirectory(prefix="journey-cli-contract-") as home:
            bin_dir = Path(home) / ".local" / "bin"
            bin_dir.mkdir(parents=True)
            binaries = [bin_dir / "kb", bin_dir / "kb-create"]
            for binary in binaries:
                binary.touch()

            def runner(argv, **_kwargs):
                binary = Path(argv[0]).name
                if argv[-1] in {"--help", "help"}:
                    output = ("KB Labs CLI\nCommands\nkb <command> [subcommand] [flags]\n"
                              if binary == "kb" else f"Usage: {binary} <command>\n")
                    return subprocess.CompletedProcess(argv, 0, output, "")
                hint = catalogued_error_hint("KB_RUNTIME_UNKNOWN_COMMAND", binary=binary)
                return subprocess.CompletedProcess(argv, 2, "", f"KB_RUNTIME_UNKNOWN_COMMAND\n{hint}\n")

            self.assertIsNone(check_installed_cli_contract({"HOME": home}, runner=runner))

    def test_installed_binaries_return_help_and_catalogued_unknown_command_hint(self):
        with tempfile.TemporaryDirectory(prefix="journey-cli-contract-") as home:
            bin_dir = Path(home) / ".local" / "bin"
            bin_dir.mkdir(parents=True)
            binaries = [bin_dir / "kb", bin_dir / "kb-create"]
            for binary in binaries:
                binary.touch()

            calls: list[list[str]] = []

            def runner(argv, **_kwargs):
                calls.append(argv)
                binary = Path(argv[0]).name
                if argv[-1] in {"--help", "help"}:
                    return subprocess.CompletedProcess(argv, 0, f"Usage: {binary} <command>\n", "")
                hint = catalogued_error_hint("KB_RUNTIME_UNKNOWN_COMMAND", binary=binary)
                return subprocess.CompletedProcess(argv, 2, "", f"KB_RUNTIME_UNKNOWN_COMMAND\n{hint}\n")

            self.assertIsNone(check_installed_cli_contract({"HOME": home}, runner=runner))
            self.assertEqual(len(calls), 6)
            self.assertEqual([Path(call[0]).name for call in calls], ["kb"] * 3 + ["kb-create"] * 3)

    def test_journey_step_claims_s258_1(self):
        with tempfile.TemporaryDirectory(prefix="journey-cli-contract-") as home:
            bin_dir = Path(home) / ".local" / "bin"
            bin_dir.mkdir(parents=True)
            for name in ("kb", "kb-create"):
                (bin_dir / name).touch()

            def runner(argv, **_kwargs):
                binary = Path(argv[0]).name
                if argv[-1] in {"--help", "help"}:
                    return subprocess.CompletedProcess(argv, 0, f"Usage: {binary}\n", "")
                hint = catalogued_error_hint("KB_RUNTIME_UNKNOWN_COMMAND", binary=binary)
                return subprocess.CompletedProcess(argv, 2, "", f"KB_RUNTIME_UNKNOWN_COMMAND {hint}")

            journey = Journey("local", "installed-cli-contract")
            run_installed_cli_contract_steps(journey, {"HOME": home}, runner=runner)
            self.assertEqual(journey.steps[0].cases, ["S-258.1"])
            self.assertEqual(journey.steps[0].status, "PASS", journey.steps[0].message)

    def test_installed_shim_engine_journey_claims_s260_7(self):
        with tempfile.TemporaryDirectory(prefix="journey-node-engine-") as directory:
            root = Path(directory)
            home = root / "home"
            platform = root / "platform"
            launcher_dir = home / "bin"
            launcher_dir.mkdir(parents=True)
            active = platform / "versions" / "2.120.1"
            active.mkdir(parents=True)
            (platform / "current").symlink_to(Path("versions") / "2.120.1")
            launcher = launcher_dir / "kb-create"
            launcher.touch()
            shim = launcher_dir / "kb"
            shim.write_text("#!/bin/sh\n", encoding="utf-8")
            cli_package = active / "node_modules/@kb-labs/cli-bin"
            (cli_package / "dist").mkdir(parents=True)
            (cli_package / "package.json").write_text(json.dumps({
                "name": "@kb-labs/cli-bin", "bin": {"kb": "dist/bin.js"},
            }), encoding="utf-8")
            (cli_package / "dist/bin.js").touch()
            node20 = root / "node20" / "node"
            node24 = root / "node24" / "node"
            for node, version in ((node20, "v20.19.4"), (node24, "v24.18.1")):
                node.parent.mkdir()
                node.write_text(
                    "#!/bin/sh\n"
                    "case \"$*\" in *--experimental-import-meta-resolve*) printf '%s\\n' '{\"name\":\"@kb-labs/plugin-runtime\",\"engines\":{\"node\":\"24.x\"}}' ;; "
                    f"*) printf '%s\\n' '{version}' ;; esac\n",
                    encoding="utf-8",
                )
                node.chmod(0o755)

            def runner(argv, **kwargs):
                path = kwargs["env"]["PATH"]
                version = "20.19.4" if str(node20.parent) in path.split(os.pathsep)[0] else "24.18.1"
                if version.startswith("20"):
                    if argv[-1] == "--json":
                        envelope = {
                            "ok": False,
                            "error": {
                                "code": "KB_NODE_VERSION_UNSUPPORTED",
                                "details": {"actualVersion": version, "requiredMajor": "24"},
                                "message": "Node.js 20.19.4 is unsupported; KB Labs requires major 24.",
                                "hint": "Switch to Node.js 24: run `nvm install 24 && nvm use 24`, then rerun your command.",
                            },
                        }
                        return subprocess.CompletedProcess(argv, 1, json.dumps(envelope), "")
                    return subprocess.CompletedProcess(
                        argv, 1, "", "Node.js 20.19.4 is unsupported; KB Labs requires major 24. [KB_NODE_VERSION_UNSUPPORTED]\n"
                        "Hint: Switch to Node.js 24: run `nvm install 24 && nvm use 24`, then rerun your command.\n",
                    )
                return subprocess.CompletedProcess(argv, 0, "Marketplace commands\nUsage: kb marketplace plugins list\n", "")

            env = {
                "HOME": str(home),
                "KB_JOURNEY_PLATFORM_ROOT": str(platform),
                "KB_JOURNEY_KB_CREATE_PATH": str(launcher),
                "KB_TEST_OLD_NODE": str(node20),
                "KB_TEST_SUPPORTED_NODE": str(node24),
                "PATH": os.environ.get("PATH", ""),
            }
            self.assertIsNone(check_installed_cli_node_engine(env, runner=runner))

            journey = Journey("local", "installed-cli-node-engine")
            run_installed_cli_contract_steps(journey, env, runner=runner)
            self.assertEqual(journey.steps[1].cases, ["S-260.7"])
            self.assertEqual(journey.steps[1].status, "PASS", journey.steps[1].message)

    def test_missing_explicit_node_provisioning_blocks_s260_7(self):
        with tempfile.TemporaryDirectory(prefix="journey-node-engine-blocked-") as directory:
            home = Path(directory) / "home"
            bin_dir = home / "bin"
            bin_dir.mkdir(parents=True)
            (bin_dir / "kb").touch()
            env = {
                "HOME": str(home),
                "KB_JOURNEY_KB_CREATE_PATH": str(bin_dir / "kb-create"),
                "KB_JOURNEY_PLATFORM_ROOT": str(Path(directory) / "not-installed"),
                "PATH": os.environ.get("PATH", ""),
            }
            journey = Journey("local", "installed-cli-node-engine-blocked")
            run_installed_cli_contract_steps(journey, env)
            self.assertEqual(journey.steps[1].cases, ["S-260.7"])
            self.assertEqual(journey.steps[1].status, "BLOCKED", journey.steps[1].message)
            self.assertIn("KB_TEST_OLD_NODE", journey.steps[1].message)


if __name__ == "__main__":
    unittest.main()
