"""Installed-platform checks for workflow execution inside git worktrees."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Callable

from invocations import (decode_ux_error_result, decode_ux_success_result, read_ux_cli_result,
                         run_command)
from service_steps import Journey
from kb_invocation import kb_shell_text


def _git(args: list[str], cwd: Path) -> None:
    result = run_command(["git", *args], cwd=cwd, env=os.environ.copy(),
                         capture_output=True, text=True, check=False, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed in {cwd}: {(result.stderr or result.stdout).strip()}")


def run_worktree_steps(
    journey: Journey,
    cli: str | Path,
    *,
    platform_root: str,
    env: dict[str, str] | None = None,
    runner: Callable = run_command,
) -> None:
    child_env = dict(os.environ if env is None else env)
    child_env["KB_PLATFORM_ROOT"] = platform_root

    def verify() -> str | None:
        with tempfile.TemporaryDirectory(prefix="kb-worktree-journey-") as temp:
            root = Path(temp)
            repo = root / "registered-repository"
            external = root / "external-worktrees"
            checkout = external / "registered-worktree"
            unregistered = root / "unregistered-repository"
            unregistered_checkout = external / "unregistered-worktree"
            repo.mkdir()
            external.mkdir()
            (repo / ".kb" / "workflows").mkdir(parents=True)
            (repo / ".kb" / "workflows" / "worktree-probe.yml").write_text(
                "name: worktree-probe\nversion: 1.0.0\non:\n  manual: true\njobs:\n"
                "  probe:\n    runsOn: local\n    steps:\n"
                "      - name: Check roots\n        id: roots\n"
                "        uses: builtin:shell\n        with:\n"
                f"          command: '{kb_shell_text(['workflow', 'defs', 'list', '--json'])} >/dev/null && test -n \"$KB_PLATFORM_ROOT\" && test \"$KB_WORKSPACE_ROOT\" = \"$PWD\"'\n",
                encoding="utf-8",
            )
            _git(["init", "-b", "main"], repo)
            _git(["config", "user.email", "journey@example.test"], repo)
            _git(["config", "user.name", "Journey"], repo)
            _git(["add", "."], repo)
            _git(["commit", "-m", "fixture"], repo)
            _git(["worktree", "add", "--detach", str(checkout), "main"], repo)

            add = runner([str(cli), "project", "add", str(repo), "--json"], cwd=repo,
                         env=child_env, capture_output=True, text=True, check=False, timeout=90)
            if add.returncode != 0:
                return f"kb project add failed for worktree fixture: {(add.stderr or add.stdout).strip()}"
            try:
                project_data = decode_ux_success_result(read_ux_cli_result(add))
                project_id = project_data["project"]["id"]
            except (ValueError, KeyError, TypeError) as error:
                return f"kb project add returned no project ID for worktree fixture: {error}"

            def remove_registered_project() -> str | None:
                remove = runner([str(cli), "project", "remove", project_id, "--yes", "--json"], cwd=repo,
                                env=child_env, capture_output=True, text=True, check=False, timeout=90)
                if remove.returncode != 0:
                    return f"could not unregister worktree fixture project: {(remove.stderr or remove.stdout).strip()}"
                return None

            def fail_and_remove(message: str) -> str:
                cleanup_error = remove_registered_project()
                return f"{message}; {cleanup_error}" if cleanup_error else message

            step_env = {
                **child_env,
                "KB_PROJECT_ID": project_id,
                "KB_PROJECT_ROOT": str(repo),
                "KB_WORKSPACE_ROOT": str(checkout),
            }
            lint = runner([str(cli), "workflow", "lint", "--json"], cwd=checkout,
                          env=step_env,
                          capture_output=True, text=True, check=False, timeout=90)
            if lint.returncode != 0:
                return fail_and_remove(f"built-in workflow command failed from worktree: {(lint.stderr or lint.stdout).strip()}")

            run = runner([str(cli), "workflow", "run", "--workflow-id=worktree-probe", "--json"], cwd=checkout,
                         env=step_env, capture_output=True, text=True, check=False, timeout=180)
            if run.returncode != 0:
                return fail_and_remove(f"workflow run from registered worktree failed: {(run.stderr or run.stdout).strip()}")
            try:
                run_payload = decode_ux_success_result(read_ux_cli_result(run))
                run_id = run_payload.get("runId") if isinstance(run_payload, dict) else None
                if not run_id:
                    return fail_and_remove("workflow run from worktree returned no run ID")
            except ValueError as error:
                return fail_and_remove(f"workflow run from worktree returned an invalid UX result: {error}")
            watch = runner([str(cli), "workflow", "runs", "watch", run_id], cwd=checkout,
                           env=step_env, capture_output=True, text=True, check=False, timeout=180)
            if watch.returncode != 0 or "Run SUCCESS." not in watch.stdout:
                return fail_and_remove(f"worktree workflow step did not finish successfully: {(watch.stderr or watch.stdout).strip()}")

            unregistered.mkdir()
            _git(["init", "-b", "main"], unregistered)
            _git(["config", "user.email", "journey@example.test"], unregistered)
            _git(["config", "user.name", "Journey"], unregistered)
            (unregistered / "README.md").write_text("unregistered fixture\n", encoding="utf-8")
            _git(["add", "README.md"], unregistered)
            _git(["commit", "-m", "fixture"], unregistered)
            _git(["worktree", "add", "--detach", str(unregistered_checkout), "main"], unregistered)
            unknown = runner([str(cli), "project", "show", "--json"], cwd=unregistered_checkout,
                             env=child_env, capture_output=True, text=True, check=False, timeout=90)
            try:
                error = decode_ux_error_result(read_ux_cli_result(unknown))
            except (ValueError, KeyError, TypeError) as error:
                return fail_and_remove(f"unregistered worktree did not return a typed project error: {error}")
            if unknown.returncode == 0 or error.get("code") != "KB_PROJECT_UNKNOWN":
                return fail_and_remove("unregistered worktree did not return KB_PROJECT_UNKNOWN")
            if "kb project add" not in error.get("hint", ""):
                return fail_and_remove("unregistered worktree error did not include a kb project add hint")
            return remove_registered_project()

    journey.step(
        "resolve owner identity and platform tools inside isolated git worktrees",
        "workflow",
        verify,
        cases=["S-198.5", "S-198.6", "S-198.7"],
    )
