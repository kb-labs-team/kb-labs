"""Prepare real project attachments used by the Studio browser journey."""
from __future__ import annotations

from kb_invocation import kb_command

import json
import os
from pathlib import Path

from invocations import (
    CompletedProcess,
    decode_ux_error_result,
    decode_ux_success_result,
    invocation_context,
    read_ux_cli_result,
    run_command,
    run_with_runner,
)


GREET_WORKFLOW = """name: greet
version: 1.0.0
inputs:
  name:
    type: string
    required: true
on:
  manual: true
jobs:
  engineering:
    runsOn: local
    steps:
      - name: Greet the supplied name
        id: greet
        uses: builtin:shell
        with:
          command: 'echo Hello ${{ inputs.name }}'
"""


def _cli(command: list[str], *, cwd: Path, env: dict[str, str], runner) -> CompletedProcess[str]:
    with invocation_context(step_id="journey.setup"):
        return run_with_runner(runner, command, cwd=cwd, env=env, timeout=180,
                               capture_output=True, text=True, check=False)


def _install(package: str, *, cwd: Path, env: dict[str, str], runner) -> None:
    command = kb_command([ "marketplace", "install", package, "--json"])
    result = _cli(command, cwd=cwd, env=env, runner=runner)
    try:
        payload = decode_ux_success_result(read_ux_cli_result(result))
    except ValueError as error:
        raise RuntimeError(f"marketplace install {package} returned an invalid UX result: {error}") from error
    installed = payload.get("installed", []) if isinstance(payload, dict) else []
    if (result.returncode != 0 or not isinstance(installed, list)
            or not any(isinstance(item, dict) and item.get("id") == package for item in installed)):
        detail = " ".join((result.stderr or result.stdout).split())[-400:]
        raise RuntimeError(f"marketplace install {package} failed: {detail or 'plugin was not installed'}")


def _verify_greet(*, cwd: Path, env: dict[str, str], runner) -> None:
    command = kb_command([ "workflow", "defs", "list", "--json"])
    result = _cli(command, cwd=cwd, env=env, runner=runner)
    try:
        payload = decode_ux_success_result(read_ux_cli_result(result))
    except ValueError as error:
        raise RuntimeError(f"workflow defs list returned an invalid UX result after installing greet: {error}") from error
    if (result.returncode != 0 or not isinstance(payload, list)
            or not any(isinstance(item, dict) and item.get("id") == "greet"
                       and item.get("status") == "active" for item in payload)):
        raise RuntimeError("workflow defs list did not report greet as active")


def _ensure_only_plugins(packages: tuple[str, ...], *, cwd: Path, env: dict[str, str], runner) -> None:
    list_command = kb_command([ "marketplace", "plugins", "list", "--json"])
    listed = _cli(list_command, cwd=cwd, env=env, runner=runner)
    try:
        payload = decode_ux_success_result(read_ux_cli_result(listed))
    except ValueError as error:
        raise RuntimeError(f"marketplace plugins list returned an invalid UX result: {error}") from error
    entries = payload.get("entries") if isinstance(payload, dict) else None
    if (listed.returncode != 0 or not isinstance(entries, list)
            or any(not isinstance(item, dict) or not isinstance(item.get("id"), str) for item in entries)):
        raise RuntimeError("marketplace plugins list returned no valid project entries")
    for entry in entries:
        installed_id = entry["id"]
        if installed_id in packages:
            continue
        uninstall = kb_command([ "marketplace", "uninstall", installed_id, "--json"])
        removed = _cli(uninstall, cwd=cwd, env=env, runner=runner)
        try:
            envelope = read_ux_cli_result(removed)
        except ValueError as error:
            raise RuntimeError(f"marketplace uninstall {installed_id} returned an invalid UX result: {error}") from error
        if removed.returncode != 0:
            removal = decode_ux_error_result(envelope)
            detail = " ".join((removed.stderr or removed.stdout).split())[-400:]
            raise RuntimeError(f"marketplace uninstall {installed_id} failed: {removal!r}: {detail}")
        removal = decode_ux_success_result(envelope)
        if not isinstance(removal, dict):
            raise RuntimeError(f"marketplace uninstall {installed_id} returned non-object UX data")
    verified = _cli(list_command, cwd=cwd, env=env, runner=runner)
    try:
        final_payload = decode_ux_success_result(read_ux_cli_result(verified))
    except ValueError as error:
        raise RuntimeError(f"marketplace plugins list returned an invalid UX result after attachment setup: {error}") from error
    final_entries = final_payload.get("entries") if isinstance(final_payload, dict) else None
    installed_ids = [item.get("id") for item in final_entries if isinstance(item, dict)] if isinstance(final_entries, list) else None
    if verified.returncode != 0 or installed_ids is None or set(installed_ids) != set(packages):
        raise RuntimeError(f"project plugin attachments do not match {packages!r}")


def prepare_studio_fixtures(service_env: dict[str, str], *, project_b_id: str,
                            project_a: Path, project_b: Path,
                            runner=run_command) -> dict[str, str]:
    """Prepare one project plugin and a real active greet workflow via the installed CLI."""
    if not project_b_id:
        raise RuntimeError("fixtures-installed state must contain a project B id for Studio project fixtures")
    if not project_a.is_dir() or not project_b.is_dir() or project_a.resolve() == project_b.resolve():
        raise RuntimeError("Studio fixtures require two distinct registered project roots")

    env = dict(os.environ)
    env.update(service_env)
    _install("@kb-labs/commit", cwd=project_b, env=env, runner=runner)
    _ensure_only_plugins((), cwd=project_a, env=env, runner=runner)
    _ensure_only_plugins(("@kb-labs/commit",), cwd=project_b, env=env, runner=runner)
    workflow_dir = project_a / ".kb" / "workflows"
    workflow_dir.mkdir(parents=True, exist_ok=True)
    (workflow_dir / "greet.yml").write_text(GREET_WORKFLOW, encoding="utf-8")
    _verify_greet(cwd=project_a, env=env, runner=runner)

    return {
        "KB_STUDIO_GREET_WORKFLOW_ID": "greet",
    }
