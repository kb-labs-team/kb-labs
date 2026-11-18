"""Installed secured CLI backend checks for S-306.1."""
from __future__ import annotations

import json
from typing import Callable

from invocations import (CompletedProcess, decode_ux_error_result,
                         decode_ux_success_result, read_ux_cli_result)


def run_selected_secured_cli_execution_check(
    *, mode: str, selection_active: bool, selected_claims: set[str],
    check: Callable[[], str | None],
) -> tuple[bool, str | None]:
    """Avoid running configuration-mutating S-306 checks for unrelated selections."""
    if mode != "secured" or (selection_active and "S-306.1" not in selected_claims):
        return False, None
    return True, check()


def _failure_code(result: CompletedProcess[str]) -> str:
    try:
        parsed = json.loads(result.stdout)
        code = parsed.get("error", {}).get("code")
        return code if isinstance(code, str) else "invalid UX failure"
    except (TypeError, ValueError, AttributeError):
        return "invalid UX failure"


def _success_data(result: CompletedProcess[str]) -> dict:
    value = decode_ux_success_result(read_ux_cli_result(result))
    if not isinstance(value, dict):
        raise ValueError("expected a JSON object")
    return value


def check_secured_cli_execution_modes(
    invoke: Callable[[list[str]], CompletedProcess[str]],
    invoke_without_session: Callable[[list[str]], CompletedProcess[str]],
) -> str | None:
    """Run the installed Commit command under both supported isolated backends."""
    try:
        original = _success_data(invoke([
            "config", "get", "--scope", "platform", "platform.execution.mode", "--json",
        ]))
    except (ValueError, KeyError, TypeError):
        return "could not read prior platform execution mode"
    prior_mode = original.get("value") if original.get("found") else "auto"
    if not isinstance(prior_mode, str):
        return "prior platform execution mode was not a string"

    failure: str | None = None
    try:
        for mode in ("subprocess", "worker-pool"):
            configured = invoke([
                "config", "set", "--scope", "platform", "platform.execution.mode", mode, "--json",
            ])
            if configured.returncode != 0:
                failure = f"could not configure {mode}: {_failure_code(configured)}"
                break
            try:
                health = _success_data(invoke(["info", "health", "--json"]))
                execution = next(
                    component for component in health.get("components", [])
                    if isinstance(component, dict) and component.get("id") == "execution"
                )
                resolved = execution.get("details", {}).get("executionMode")
            except (ValueError, KeyError, TypeError, StopIteration, AttributeError):
                failure = f"{mode} CLI health omitted the execution backend"
                break
            if resolved != mode:
                failure = f"{mode} CLI health resolved {resolved!r} instead"
                break
            result = invoke(["commit", "commit", "--dry-run", "--json"])
            if result.returncode != 0:
                failure = f"secured {mode} command failed: {_failure_code(result)}"
                break
            try:
                _success_data(result)
            except (ValueError, KeyError, TypeError):
                failure = f"secured {mode} command returned no valid UX result"
                break
        if failure is None:
            anonymous = invoke_without_session(["commit", "commit", "--dry-run", "--json"])
            try:
                error = decode_ux_error_result(read_ux_cli_result(anonymous))
                if anonymous.returncode == 0 or error.get("code") != "KB_AUTH_REQUIRED":
                    failure = "unauthenticated secured command was not denied with KB_AUTH_REQUIRED"
            except (ValueError, KeyError, TypeError):
                failure = "unauthenticated secured command returned no valid auth failure"
    finally:
        restored = invoke([
            "config", "set", "--scope", "platform", "platform.execution.mode", prior_mode, "--json",
        ])
        if restored.returncode != 0:
            failure = f"platform execution mode restoration failed: {_failure_code(restored)}"
    return failure
