"""Installed CLI help and catalogued unknown-command journey checks."""
from __future__ import annotations

from pathlib import Path
from typing import Callable, Mapping

from invocations import CompletedProcess, catalogued_error_hint, run_command
from kb_invocation import kb_command
from service_steps import Journey


def check_installed_cli_contract(
    env: Mapping[str, str],
    *,
    runner: Callable[..., CompletedProcess[str]] | None = None,
) -> str | None:
    home = Path(env["HOME"])
    binaries = (home / ".local" / "bin" / "kb", home / ".local" / "bin" / "kb-create")
    for executable in binaries:
        if not executable.is_file():
            return f"installed CLI binary is missing at {executable}"
        for arguments in (("--help",), ("help",)):
            command = kb_command(arguments, executable=executable)
            result = run_command(command, cwd=home, env=env, timeout=30, runner=runner)
            output = f"{result.stdout or ''}\n{result.stderr or ''}"
            has_usage = ("usage:" in output.lower()
                         or f"{executable.name} <command>" in output)
            if result.returncode != 0 or not has_usage:
                return f"{executable.name} {' '.join(arguments)} did not return usage successfully"

        command = kb_command(("__kb_journey_unknown_command__",), executable=executable)
        result = run_command(command, cwd=home, env=env, timeout=30, runner=runner)
        output = f"{result.stdout or ''}\n{result.stderr or ''}"
        expected_hint = catalogued_error_hint("KB_RUNTIME_UNKNOWN_COMMAND", binary=executable.name)
        if result.returncode == 0 or "KB_RUNTIME_UNKNOWN_COMMAND" not in output or expected_hint not in output:
            return f"{executable.name} unknown command did not report its catalogued help hint"
    return None


def run_installed_cli_contract_steps(
    journey: Journey,
    env: Mapping[str, str],
    *,
    runner: Callable[..., CompletedProcess[str]] | None = None,
) -> None:
    journey.step(
        "installed CLI root help and unknown-command hints",
        "cli-contract",
        lambda: check_installed_cli_contract(env, runner=runner),
        cases=["S-258.1"],
    )
