from __future__ import annotations

from pathlib import Path
import subprocess
import tempfile
import unittest

from installed_cli_contract_steps import check_installed_cli_contract, run_installed_cli_contract_steps
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


if __name__ == "__main__":
    unittest.main()
