"""Installed workflow, history, failure, and cron journeys."""
from __future__ import annotations

import json
import tempfile
import time
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable

from service_steps import Journey
from kb_invocation import kb_command, kb_login_shell
from steps.auth import assert_cli_session_absent, assert_platform_auth_required
from invocations import (
    CompletedProcess,
    catalogued_error_hint,
    decode_ux_error_result,
    invocation_context,
    read_ux_cli_result,
    run_command,
    run_pty_command,
    write_report_json,
    write_report_jsonl,
)


def run_cli(args: list[str], *, env: dict[str, str], cwd: Path, timeout: int = 120,
            input_text: str | None = None):
    cli_path = env.get("KB_JOURNEY_CLI_PATH")
    command = kb_login_shell(args) if not cli_path else kb_command(args, executable=cli_path)
    result = run_command(command, env=env, cwd=cwd, timeout=timeout, input=input_text)
    return CompletedProcess(command, result.returncode,
                                        stdout=result.stdout or "",
                                        stderr=result.stderr)


def _json_cli(args: list[str], *, env: dict[str, str], cwd: Path) -> object:
    result = run_cli(args, env=env, cwd=cwd)
    if result.returncode:
        raise AssertionError(f"`kb {' '.join(args)}` exited {result.returncode}: {' '.join(result.stdout.split())[-500:]}")
    try:
        payload = read_ux_cli_result(result)
    except json.JSONDecodeError as error:
        raise AssertionError(f"`kb {' '.join(args)}` did not return JSON: {' '.join(result.stdout.split())[-500:]}") from error
    if payload.get("ok") is not True:
        raise AssertionError(f"`kb {' '.join(args)}` returned an unsuccessful result: {payload!r}")
    if "data" not in payload:
        raise AssertionError(f"`kb {' '.join(args)}` JSON envelope is missing required `data`")
    return payload["data"]


def _case_cli(step_id: str, args: list[str], *, env: dict[str, str], cwd: Path,
              timeout: int = 120):
    """Run a case command with evidence attached to its exact scenario step."""
    with invocation_context(step_id=step_id):
        return run_cli(args, env=env, cwd=cwd, timeout=timeout)


def _case_json_cli(step_id: str, args: list[str], *, env: dict[str, str], cwd: Path) -> object:
    result = _case_cli(step_id, args, env=env, cwd=cwd)
    if result.returncode:
        raise AssertionError(f"`kb {' '.join(args)}` exited {result.returncode}: {' '.join(result.stdout.split())[-500:]}")
    try:
        payload = read_ux_cli_result(result)
    except json.JSONDecodeError as error:
        raise AssertionError(f"`kb {' '.join(args)}` did not return JSON: {' '.join(result.stdout.split())[-500:]}") from error
    command = f"kb {' '.join(args)}"
    if payload.get("ok") is not True:
        raise AssertionError(f"`kb {' '.join(args)}` returned an unsuccessful result: {payload!r}")
    if "data" not in payload:
        raise AssertionError(f"`{command}` JSON envelope is missing required `data`")
    return payload["data"]


def _contract_object(value: object, command: str) -> dict:
    if not isinstance(value, dict):
        raise AssertionError(f"`{command}` JSON contract expected `data` to be an object; got {type(value).__name__}")
    return value


def _contract_string(record: dict, key: str, command: str) -> str:
    value = record.get(key)
    if not isinstance(value, str) or not value:
        raise AssertionError(f"`{command}` JSON contract requires non-empty string `{key}`")
    return value


def _contract_status(record: dict, command: str) -> str:
    status = _contract_string(record, "status", command)
    if status not in {"queued", "running", "success", "failed", "cancelled"}:
        raise AssertionError(
            f"`{command}` JSON contract violation: `status` must be queued|running|success|failed|cancelled; "
            f"got {status!r}")
    return status


def _workflow_run_list_data(value: object, command: str = "kb workflow runs list --json") -> list[dict]:
    if not isinstance(value, list):
        raise AssertionError(f"`{command}` JSON contract expected envelope `data` to be an array of WorkflowRunSummary")
    runs = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise AssertionError(f"`{command}` JSON contract requires `data[{index}]` to be a WorkflowRunSummary object")
        _contract_string(item, "id", command)
        _contract_string(item, "name", command)
        _contract_status(item, command)
        runs.append(item)
    return runs


def _workflow_run_detail_data(value: object, command: str = "kb workflow runs view --json=all") -> dict:
    detail = _contract_object(value, command)
    _contract_string(detail, "id", command)
    _contract_string(detail, "name", command)
    _contract_status(detail, command)
    return detail


def _workflow_run_jobs(detail: dict, command: str) -> list[dict]:
    jobs = detail.get("jobs")
    if not isinstance(jobs, list):
        raise AssertionError(f"`{command}` JSON contract requires `data.jobs` to be an array for this case")
    checked = []
    for index, job in enumerate(jobs):
        if not isinstance(job, dict):
            raise AssertionError(f"`{command}` JSON contract requires `data.jobs[{index}]` to be an object")
        steps = job.get("steps")
        if not isinstance(steps, list):
            raise AssertionError(f"`{command}` JSON contract requires `data.jobs[{index}].steps` to be an array")
        for step_index, step in enumerate(steps):
            if not isinstance(step, dict):
                raise AssertionError(
                    f"`{command}` JSON contract requires `data.jobs[{index}].steps[{step_index}]` to be an object")
        checked.append(job)
    return checked


def _workflow_run_start_data(value: object, command: str = "kb workflow run --json") -> dict:
    result = _contract_object(value, command)
    _contract_string(result, "runId", command)
    _contract_string(result, "status", command)
    return result


def _workflow_rerun_data(value: object, command: str = "kb workflow runs rerun --json") -> dict:
    result = _contract_object(value, command)
    _contract_string(result, "runId", command)
    _contract_string(result, "status", command)
    return result


def _workflow_error_data(value: object, command: str) -> dict:
    envelope = _contract_object(value, command)
    if envelope.get("ok") is not False:
        raise AssertionError(f"`{command}` JSON contract requires top-level `ok: false` for an error")
    error = _contract_object(envelope.get("error"), command)
    _contract_string(error, "code", command)
    _contract_string(error, "message", command)
    _contract_string(error, "hint", command)
    return error


def _workflow_cron_list_data(value: object, command: str = "kb workflow crons list --json") -> dict:
    result = _contract_object(value, command)
    crons = result.get("crons")
    errors = result.get("errors")
    if not isinstance(crons, list):
        raise AssertionError(f"`{command}` JSON contract requires `data.crons` to be an array")
    if not isinstance(errors, list):
        raise AssertionError(f"`{command}` JSON contract requires `data.errors` to be an array")
    for index, cron in enumerate(crons):
        if not isinstance(cron, dict):
            raise AssertionError(f"`{command}` JSON contract requires `data.crons[{index}]` to be an object")
        _contract_string(cron, "id", command)
        _contract_string(cron, "source", command)
        _contract_string(cron, "schedule", command)
        target = cron.get("target")
        if not isinstance(target, dict):
            raise AssertionError(f"`{command}` JSON contract requires `data.crons[{index}].target` to be an object")
        if set(target) == {"workflow"}:
            _contract_string(target, "workflow", command)
        elif set(target) == {"handler"}:
            _contract_string(target, "handler", command)
        else:
            raise AssertionError(
                f"`{command}` JSON contract requires `data.crons[{index}].target` to contain exactly `workflow` or `handler`")
        if not isinstance(cron.get("enabled"), bool):
            raise AssertionError(f"`{command}` JSON contract requires `data.crons[{index}].enabled` to be a boolean")
    for index, error in enumerate(errors):
        if not isinstance(error, dict):
            raise AssertionError(f"`{command}` JSON contract requires `data.errors[{index}]` to be an object")
        _contract_string(error, "file", command)
        _contract_string(error, "reason", command)
    return result


def _workflow_definition_list_data(value: object, command: str = "kb workflow defs list --json") -> list[dict]:
    if not isinstance(value, list):
        raise AssertionError(f"`{command}` JSON contract expected envelope `data` to be an array of WorkflowInfo")
    workflows = []
    for index, workflow in enumerate(value):
        if not isinstance(workflow, dict):
            raise AssertionError(f"`{command}` JSON contract requires `data[{index}]` to be a WorkflowInfo object")
        _contract_string(workflow, "id", command)
        _contract_string(workflow, "name", command)
        _contract_string(workflow, "source", command)
        workflows.append(workflow)
    return workflows


def _workflow_logs_data(value: object, command: str = "kb workflow runs logs --json") -> list[dict]:
    result = _contract_object(value, command)
    logs = result.get("logs")
    if not isinstance(logs, list):
        raise AssertionError(f"`{command}` JSON contract requires `data.logs` to be an array")
    checked = []
    for index, entry in enumerate(logs):
        if not isinstance(entry, dict):
            raise AssertionError(f"`{command}` JSON contract requires `data.logs[{index}]` to be an object")
        _contract_string(entry, "level", command)
        _contract_string(entry, "message", command)
        _contract_string(entry, "timestamp", command)
        checked.append(entry)
    return checked


def _solo_workflow_case(journey: Journey, *, env: dict[str, str], project: Path,
                        clock: Callable[[], float], sleep: Callable[[float], None]) -> None:
    def initialize() -> None:
        result = _case_cli("S-002.1", ["workflow", "create"], env=env, cwd=project)
        expected = ("Created .kb/workflows/hello.yml" in result.stdout
                    and "Next: kb workflow lint && kb workflow run --workflow-id=hello" in result.stdout)
        definition = project / ".kb" / "workflows" / "hello.yml"
        if result.returncode or not expected or not definition.is_file():
            raise AssertionError(f"workflow create did not create the documented hello workflow: {result.stdout!r}")
        content = definition.read_text(encoding="utf-8")
        if "manual: true" not in content or "echo hello-workflow" not in content:
            raise AssertionError("workflow create created a hello workflow with unexpected trigger or command")

    journey.step("initialize solo project workflow", "workflow", initialize, cases=["S-002.1"])

    def lint() -> None:
        result = _case_cli("S-002.2", ["workflow", "lint"], env=env, cwd=project)
        if result.returncode or ".kb/workflows/hello.yml" not in result.stdout or "valid" not in result.stdout.lower():
            raise AssertionError(f"workflow lint did not report hello.yml valid: {result.stdout!r}")

    journey.step("lint solo project workflow", "workflow", lint, cases=["S-002.2"])

    run_id = ""

    def start() -> None:
        nonlocal run_id
        run_id = _run_id(_case_json_cli("S-002.3", ["workflow", "run", "--workflow-id=hello", "--json"],
                                        env=env, cwd=project))

    journey.step("start solo project workflow", "workflow", start, cases=["S-002.3"])

    def inspect() -> None:
        with invocation_context(step_id="S-002.4"):
            detail = _terminal_run(run_id, env=env, cwd=project, clock=clock, sleep=sleep)
        steps = [step for job in _workflow_run_jobs(detail, "kb workflow runs view --json=all")
                 for step in job["steps"]]
        output = "\n".join(str(step.get("output", "")) + " " +
                             json.dumps(step.get("outputs", {}), sort_keys=True) for step in steps)
        if detail.get("status") != "success" or "hello-workflow" not in output:
            raise AssertionError(f"hello workflow detail omitted success or its output: {detail!r}")

    journey.step("inspect solo project workflow result", "workflow", inspect, cases=["S-002.4"])

    def listed() -> None:
        data = _case_json_cli("S-002.5", ["workflow", "runs", "list", "--workflow=hello", "--json"],
                              env=env, cwd=project)
        runs = _workflow_run_list_data(data, "kb workflow runs list --workflow=hello --json")
        if not any(run.get("id") == run_id and run.get("workflowId") == "hello"
                   and run.get("status") == "success" for run in runs):
            if any(run.get("id") == run_id and "workflowId" not in run for run in runs):
                raise AssertionError(
                    "`kb workflow runs list --workflow=hello --json` JSON contract violation: "
                    "case S-002.5 requires `data[].workflowId`, but the command result omits it")
            raise AssertionError(f"workflow list omitted the successful hello run {run_id}")

    journey.step("find solo project workflow in history", "workflow", listed, cases=["S-002.5"])

    def unknown() -> None:
        result = _case_cli("S-002.6", ["workflow", "runs", "view", "journey-run-does-not-exist", "--json"],
                           env=env, cwd=project)
        try:
            response = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise AssertionError(f"unknown workflow run did not return JSON error output: {result.stdout!r}") from error
        error = response.get("error") if isinstance(response, dict) else None
        message = error.get("message", "") if isinstance(error, dict) else ""
        hint = error.get("hint", "") if isinstance(error, dict) else ""
        if (result.returncode == 0 or not isinstance(error, dict)
                or error.get("code") != "KB_RUNTIME_WORKFLOW_RUN_NOT_FOUND"
                or "journey-run-does-not-exist" not in message
                or hint != 'Run "kb workflow runs list" to inspect available runs.'):
            raise AssertionError(f"unknown workflow run did not return the typed not-found contract: {result.stdout!r}")

    journey.step("report unknown workflow run", "workflow", unknown, cases=["S-002.6"])


def _cancellation_case(journey: Journey, *, env: dict[str, str], project: Path,
                      clock: Callable[[], float], sleep: Callable[[float], None]) -> None:
    marker = project / ".kb" / "workflow-cancel-release"
    marker.unlink(missing_ok=True)
    definition = project / ".kb" / "workflows" / "journey-cancel.yml"
    definition.write_text(
        "name: journey-cancel\nversion: 1.0.0\non:\n  manual: true\njobs:\n  wait:\n    runsOn: local\n    steps:\n"
        "      - name: Wait for cancellation\n        id: wait\n        uses: builtin:shell\n        with:\n"
        f"          command: 'while [ ! -f {marker} ]; do sleep 0.1; done'\n",
        encoding="utf-8")

    run_id = [""]

    def start() -> None:
        run_id[0] = _run_id(_case_json_cli("S-008.1", ["workflow", "run", "--workflow-id=journey-cancel", "--json"],
                                           env=env, cwd=project))
        deadline = clock() + 30
        detail = None
        while clock() < deadline:
            detail = _case_json_cli("S-008.1", ["workflow", "runs", "view", run_id[0], "--json=status"],
                                    env=env, cwd=project)
            detail = _contract_object(detail, "kb workflow runs view --json=status")
            status = _contract_status(detail, "kb workflow runs view --json=status")
            if status == "running":
                return
            sleep(0.2)
        raise AssertionError(f"workflow run did not become active after it returned: {detail!r}")

    journey.step("start active workflow for cancellation", "workflow", start, cases=["S-008.1"])

    def cancel() -> None:
        result = _case_cli("S-008.2", ["workflow", "runs", "cancel", run_id[0]], env=env, cwd=project)
        if result.returncode or run_id[0] not in result.stdout or "cancellation" not in result.stdout.lower():
            raise AssertionError(f"workflow cancellation was not confirmed: {result.stdout!r}")

    journey.step("request workflow cancellation", "workflow", cancel, cases=["S-008.2"],
                 requires=("step:start active workflow for cancellation",))

    def verify_cancelled() -> None:
        deadline = clock() + 30
        detail = None
        while clock() < deadline:
            detail = _case_json_cli("S-008.3", ["workflow", "runs", "view", run_id[0], "--json=status"],
                                    env=env, cwd=project)
            detail = _contract_object(detail, "kb workflow runs view --json=status")
            status = _contract_status(detail, "kb workflow runs view --json=status")
            if status == "cancelled":
                return
            sleep(1)
        raise AssertionError(f"workflow run did not become cancelled: {detail!r}")

    journey.step("verify cancelled workflow status", "workflow", verify_cancelled, cases=["S-008.3"],
                 requires=("step:start active workflow for cancellation",))

    def reject_repeat_cancel() -> None:
        result = _case_cli("S-008.4", ["workflow", "runs", "cancel", run_id[0]], env=env, cwd=project)
        output = (result.stdout or "") + (result.stderr or "")
        if result.returncode == 0 or "finished" not in output.lower():
            raise AssertionError(f"repeat cancellation was not refused as already finished: {output!r}")
        detail = _case_json_cli("S-008.4", ["workflow", "runs", "view", run_id[0], "--json=status"],
                                env=env, cwd=project)
        detail = _contract_object(detail, "kb workflow runs view --json=status")
        if _contract_status(detail, "kb workflow runs view --json=status") != "cancelled":
            raise AssertionError(f"repeat cancellation changed the terminal status: {detail!r}")

    journey.step("reject cancellation after workflow finished", "workflow", reject_repeat_cancel,
                 cases=["S-008.4"], requires=("step:start active workflow for cancellation",))
    marker.touch()
    definition.unlink(missing_ok=True)



def _run_id(result: object) -> str:
    return _contract_string(_workflow_run_start_data(result), "runId", "kb workflow run --json")


def _terminal_run(run_id: str, *, env: dict[str, str], cwd: Path,
                  timeout_seconds: int = 180, clock: Callable[[], float] = time.monotonic,
                  sleep: Callable[[float], None] = time.sleep) -> dict:
    deadline = clock() + timeout_seconds
    while clock() < deadline:
        detail = _json_cli(["workflow", "runs", "view", run_id, "--json=all"], env=env, cwd=cwd)
        detail = _workflow_run_detail_data(detail)
        if detail["status"] in {"success", "failed", "cancelled"}:
            return detail
        sleep(2)
    raise AssertionError(f"workflow run {run_id} did not reach a terminal status within {timeout_seconds}s")


def _case_terminal_run(step_id: str, run_id: str, *, env: dict[str, str], cwd: Path,
                       timeout_seconds: int = 180, clock: Callable[[], float] = time.monotonic,
                       sleep: Callable[[float], None] = time.sleep) -> dict:
    with invocation_context(step_id=step_id):
        return _terminal_run(run_id, env=env, cwd=cwd, timeout_seconds=timeout_seconds,
                             clock=clock, sleep=sleep)


def select_session_protection_representatives(registry_listing: dict) -> dict[str, list[str]]:
    """Choose the first runnable command from each session-protected registry class."""
    data = registry_listing.get("data")
    commands = data.get("commands") if isinstance(data, dict) else None
    if not isinstance(commands, list):
        raise AssertionError("kb registry commands --json omitted data.commands")

    representatives: dict[str, list[str]] = {}
    classes: set[str] = set()
    for command in commands:
        if not isinstance(command, dict):
            raise AssertionError("CLI command registry returned a malformed command entry")
        protection_class = command.get("protectionClass")
        if not isinstance(protection_class, str) or not protection_class:
            raise AssertionError("CLI command registry omitted a command protectionClass")
        if command.get("requiresSession") is not True:
            continue
        classes.add(protection_class)
        if command.get("available") is not True:
            continue
        path = command.get("path")
        if not isinstance(path, list) or not path or not all(isinstance(part, str) and part for part in path):
            continue
        representatives.setdefault(protection_class, path)

    missing = sorted(classes - representatives.keys())
    if missing:
        raise AssertionError("No runnable registry command represents protected class(es): " + ", ".join(missing))
    if not representatives:
        raise AssertionError("CLI command registry declares no session-protected command classes")
    return representatives


def run_secured_cli_auth_step(journey: Journey, *, env: dict[str, str], project: Path) -> None:
    """Authenticate setup, then prove registry-declared session commands are gated."""
    def verify_unregistered_project_auth() -> None:
        email = env.get("KB_JOURNEY_ADMIN_EMAIL", "")
        password = env.get("KB_JOURNEY_ADMIN_PASSWORD", "")
        if not email or not password:
            raise AssertionError("secured workflow journey requires KB_JOURNEY_ADMIN_EMAIL and KB_JOURNEY_ADMIN_PASSWORD")
        gateway = env.get("KB_JOURNEY_BASE_URL", "http://127.0.0.1:4000")
        with tempfile.TemporaryDirectory(prefix="kb-secured-cli-projects-") as setup_home:
            unregistered_project = Path(setup_home) / "fresh-project"
            unregistered_project.mkdir()
            setup_env = env.copy()
            setup_env["HOME"] = setup_home
            setup_env["KB_JOURNEY_HOME_LABEL"] = "authenticated-secured-project-setup"
            setup_env["KB_PLATFORM_ROOT"] = env["KB_JOURNEY_PLATFORM_ROOT"]
            setup_env["KB_DIAGNOSTICS"] = "agent"
            setup_env["KB_LOG_LEVEL"] = "warn"
            setup_env.pop("KB_PROJECT_ROOT", None)
            login = run_cli(["auth", "login", "--gateway-url", gateway, "--email", email,
                             "--password-stdin"], env=setup_env, cwd=project,
                            input_text=password + "\n")
            if login.returncode != 0:
                raise AssertionError(f"admin CLI login failed: {' '.join((login.stdout or login.stderr).split())[-400:]}")
            registration = run_cli(["project", "add", str(project), "--json"],
                                   env=setup_env, cwd=project)
            if registration.returncode != 0:
                raise AssertionError(f"kb project add failed for secured auth evidence: {(registration.stderr or registration.stdout).strip()}")
            listed = run_cli(["project", "list", "--json"], env=setup_env, cwd=project)
            if listed.returncode != 0:
                raise AssertionError(f"kb project list failed for secured auth evidence: {(listed.stderr or listed.stdout).strip()}")
            registry_payload = read_ux_cli_result(listed)
            projects = registry_payload["data"].get("projects")
            if not isinstance(projects, list):
                raise AssertionError("kb project list omitted project registry contents")
            registered_paths = {Path(item["path"]).resolve() for item in projects if isinstance(item, dict) and isinstance(item.get("path"), str)}
            if project.resolve() not in registered_paths or unregistered_project.resolve() in registered_paths:
                raise AssertionError("secured auth evidence did not establish registered and unregistered project roots")
            report_root = env.get("KB_JOURNEY_INVOCATIONS")
            if report_root:
                write_report_jsonl(Path(report_root) / "project-registries.jsonl", {
                    "mode": "secured", "projects": projects,
                }, env=setup_env, append=True)
            with invocation_context(step_id="S-041.17"):
                command_listing = run_cli(["registry", "commands", "--json"], env=setup_env, cwd=project)
                if command_listing.returncode != 0:
                    raise AssertionError(f"kb registry commands failed for secured auth evidence: {(command_listing.stderr or command_listing.stdout).strip()}")
                representatives = select_session_protection_representatives(read_ux_cli_result(command_listing))
                logout = run_cli(["auth", "logout", "--json"], env=setup_env, cwd=project)
                if logout.returncode != 0:
                    raise AssertionError(f"kb auth logout failed for secured auth evidence: {(logout.stderr or logout.stdout).strip()}")
                anonymous_env = setup_env.copy()
                anonymous_env["KB_JOURNEY_HOME_LABEL"] = "anonymous-secured-project-probes"
                assert_platform_auth_required(
                    run_cli(["project", "add", str(unregistered_project), "--json"], env=anonymous_env,
                            cwd=unregistered_project),
                    ["project", "add", str(unregistered_project), "--json"], gateway, require_context=True)
                for cwd in (project, unregistered_project):
                    for command_path in representatives.values():
                        command = [*command_path, "--json"]
                        result = run_cli(command, env=anonymous_env, cwd=cwd)
                        assert_platform_auth_required(
                            result, command, gateway,
                            require_context=True)

    journey.step("secured auth precedes unregistered project resolution", "workflow",
                 verify_unregistered_project_auth, cases=["S-041.17"])

    def verify_auth() -> None:
        commands = [
            ["config", "show", "--json"],
            ["workflow", "defs", "list", "--json"],
            ["marketplace", "plugins", "list", "--json"],
            ["qa", "cases", "validate", "--json"],
        ]
        with tempfile.TemporaryDirectory(prefix="kb-anonymous-cli-home-") as anonymous_home:
            anonymous_env = env.copy()
            anonymous_env["HOME"] = anonymous_home
            anonymous_env["KB_JOURNEY_HOME_LABEL"] = "anonymous"
            platform_root = env.get("KB_JOURNEY_PLATFORM_ROOT")
            cli_path = env.get("KB_JOURNEY_CLI_PATH")
            if not platform_root or not cli_path:
                raise AssertionError("anonymous CLI auth checks require explicit platform and CLI paths")
            anonymous_env["KB_PLATFORM_ROOT"] = platform_root
            anonymous_env["KB_PROJECT_ROOT"] = str(project)
            status = run_cli(["auth", "status", "--json"], env=anonymous_env, cwd=project)
            assert_cli_session_absent(status)
            allowlisted = [
                ["auth", "login", "--help"],
                ["version"],
                ["health", "--json"],
            ]
            for command in allowlisted:
                result = run_cli(command, env=anonymous_env, cwd=project)
                if result.returncode != 0:
                    raise AssertionError(f"allowlisted {' '.join(command)} failed without a session")
            for command in commands:
                result = run_cli(command, env=anonymous_env, cwd=project)
                assert_platform_auth_required(result, command, env.get("KB_JOURNEY_BASE_URL", "http://127.0.0.1:4000"))
            human_result = run_cli(["workflow", "defs", "list"], env=anonymous_env, cwd=project)
            human_output = (human_result.stdout or "") + (human_result.stderr or "")
            login_hint = catalogued_error_hint(
                "KB_AUTH_REQUIRED", gatewayUrl=env.get("KB_JOURNEY_BASE_URL", "http://127.0.0.1:4000"))
            if (human_result.returncode == 0 or "KB_AUTH_REQUIRED" not in human_output
                    or "Authentication is required." not in human_output or login_hint not in human_output):
                raise AssertionError("unauthenticated `kb workflow defs list` did not show the catalogued login error and hint")

        email = env.get("KB_JOURNEY_ADMIN_EMAIL", "")
        password = env.get("KB_JOURNEY_ADMIN_PASSWORD", "")
        if not email or not password:
            raise AssertionError("secured workflow journey requires KB_JOURNEY_ADMIN_EMAIL and KB_JOURNEY_ADMIN_PASSWORD")
        gateway = env.get("KB_JOURNEY_BASE_URL", "http://127.0.0.1:4000")
        login = run_cli(["auth", "login", "--gateway-url", gateway,
                         "--email", email, "--password-stdin"], env=env, cwd=project,
                        input_text=password + "\n")
        if login.returncode != 0:
            raise AssertionError(f"admin CLI login failed: {' '.join(login.stdout.split())[-400:]}")
        for command in commands:
            resumed = run_cli(command, env=env, cwd=project)
            payload = read_ux_cli_result(resumed)
            error = payload.get("error") if isinstance(payload, dict) else None
            if isinstance(error, dict) and error.get("code") == "KB_AUTH_REQUIRED":
                raise AssertionError(f"authenticated {' '.join(command)} still returned KB_AUTH_REQUIRED")

    journey.step("secured CLI deny-by-default authentication", "workflow", verify_auth,
                 cases=["S-007.4", "S-041.7", "S-041.8", "S-041.12"])


def _logs(run_id: str, *, env: dict[str, str], cwd: Path) -> str:
    result = run_cli(["workflow", "runs", "logs", run_id], env=env, cwd=cwd)
    if result.returncode != 0:
        raise AssertionError(f"workflow logs command failed: {((result.stdout or '') + (result.stderr or ''))!r}")
    return (result.stdout or "") + (result.stderr or "")


def _write_workflows(project: Path) -> None:
    workflows = project / ".kb" / "workflows"
    workflows.mkdir(parents=True, exist_ok=True)
    (workflows / "journey-hello.yml").write_text(
        "name: journey-hello\nversion: 1.0.0\n"
        "inputs:\n  message:\n    type: string\n    required: true\n"
        "on:\n  manual: true\njobs:\n  smoke:\n    runsOn: local\n    steps:\n"
        "      - name: Echo supplied message\n        id: echo-message\n        uses: builtin:shell\n"
        "        with:\n          command: 'echo ${{ inputs.message }}'\n",
        encoding="utf-8",
    )
    (workflows / "journey-fails.yml").write_text(
        "name: journey-fails\nversion: 1.0.0\non:\n  manual: true\n"
        "jobs:\n  smoke:\n    runsOn: local\n    steps:\n"
        "      - name: Deliberate failure\n        id: deliberate-failure\n        uses: builtin:shell\n"
        "        with:\n          command: 'echo journey-failure-diagnostic && exit 23'\n",
        encoding="utf-8",
    )


def _schedule_yaml(enabled: bool) -> str:
    return (
        "schedule: '* * * * *'\nworkflow: journey-cron-target\n"
        "input:\n  message: journey-cron-fired\n"
        f"enabled: {'true' if enabled else 'false'}\n"
    )


def prepare_workflow_fixtures(project: Path) -> None:
    """Create watched workflow and schedule files before the project runtime starts."""
    _write_workflows(project)
    workflows = project / ".kb" / "workflows"
    (workflows / "journey-cron-target.yml").write_text(
        "name: journey-cron-target\nversion: 1.0.0\n"
        "inputs:\n  message:\n    type: string\n    required: true\n"
        "on:\n  manual: true\njobs:\n  smoke:\n    runsOn: local\n    steps:\n"
        "      - name: Log schedule input\n        id: log-schedule-input\n        uses: builtin:shell\n"
        "        with:\n          command: 'echo ${{ inputs.message }}'\n", encoding="utf-8")
    crons = project / ".kb" / "crons"
    crons.mkdir(parents=True, exist_ok=True)
    (crons / "journey-cron.yml").write_text(_schedule_yaml(False), encoding="utf-8")


def _live_progress_case(journey: Journey, *, env: dict[str, str], project: Path) -> None:
    gates = [project / ".kb" / "workflow-progress-first", project / ".kb" / "workflow-progress-second"]
    for gate in gates:
        gate.unlink(missing_ok=True)
    definition = project / ".kb" / "workflows" / "journey-progress.yml"
    definition.write_text(
        "name: journey-progress\nversion: 1.0.0\non:\n  manual: true\njobs:\n  progress:\n    runsOn: local\n    steps:\n"
        f"      - name: First visible step\n        id: first-id\n        uses: builtin:shell\n        with:\n          command: 'while [ ! -f {gates[0]} ]; do sleep 0.1; done; echo first-finished'\n"
        f"      - name: Second visible step\n        id: second-i\n        uses: builtin:shell\n        with:\n          command: 'while [ ! -f {gates[1]} ]; do sleep 0.1; done; echo second-finished'\n",
        encoding="utf-8")
    run_id = [""]

    def start() -> None:
        run_id[0] = _run_id(_case_json_cli("S-027.1", ["workflow", "run", "--workflow-id=journey-progress", "--json"],
                                           env=env, cwd=project))
    journey.step("start live progress workflow", "workflow", start, cases=["S-027.1"])

    cli_path = env.get("KB_JOURNEY_CLI_PATH")
    watch_args = ["workflow", "runs", "watch", run_id[0]]
    command = kb_command(watch_args, executable=cli_path) if cli_path else kb_login_shell(watch_args)
    seen: set[str] = set()
    watched = [None]

    def release_step(transcript: str) -> None:
        for index, step_id in enumerate(("first-id", "second-i")):
            if step_id in transcript:
                seen.add(step_id)
                gates[index].touch(exist_ok=True)

    def watch() -> None:
        with invocation_context(step_id="S-027.2"):
            result, _ = run_pty_command(command, cwd=project, env=env, timeout=120,
                                        on_output=release_step)
        watched[0] = result
        if (result.returncode or seen != {"first-id", "second-i"} or run_id[0] not in result.stdout
                or any(f"step.started step:{step_id}" not in result.stdout
                       or f"step.succeeded step:{step_id}" not in result.stdout
                       for step_id in ("first-id", "second-i"))):
            raise AssertionError(f"watch did not observe both active steps: {result.stdout!r}")
    journey.step("watch live workflow progress", "workflow", watch, cases=["S-027.2"],
                 requires=("step:start live progress workflow",))

    def terminal() -> None:
        result = watched[0]
        if result is None or result.returncode != 0 or "run.finished" not in result.stdout or "SUCCESS" not in result.stdout:
            raise AssertionError(f"watch omitted successful terminal event: {getattr(result, 'stdout', '')!r}")
        detail = _case_terminal_run("S-027.3", run_id[0], env=env, cwd=project)
        if detail.get("status") != "success":
            raise AssertionError(f"watched workflow ended {detail.get('status')!r}")
    journey.step("verify live workflow terminal result", "workflow", terminal, cases=["S-027.3"],
                 requires=("step:start live progress workflow", "step:watch live workflow progress"))
    definition.unlink(missing_ok=True)


class _HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"healthy")

    def log_message(self, _format: str, *_args: object) -> None:
        return


def _real_work_case(journey: Journey, *, env: dict[str, str], project: Path,
                    clock: Callable[[], float], sleep: Callable[[float], None]) -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _HealthHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    marker = project / ".kb" / "workflow-marker"
    marker.unlink(missing_ok=True)
    definition = project / ".kb" / "workflows" / "real-work.yml"
    port = server.server_address[1]
    definition.write_text(
        "name: real-work\nversion: 1.0.0\non:\n  manual: true\njobs:\n  work:\n    runsOn: local\n    steps:\n"
        "      - name: Write marker\n        id: write-marker\n        uses: builtin:shell\n        with:\n"
        "          command: 'printf done > .kb/workflow-marker'\n",
        encoding="utf-8")
    try:
        def lint_first_step() -> None:
            result = _case_cli("S-028.1", ["workflow", "lint"], env=env, cwd=project)
            if result.returncode or "real-work.yml" not in result.stdout or "valid" not in result.stdout.lower():
                raise AssertionError(f"workflow lint rejected real-work.yml: {result.stdout!r}")
        journey.step("lint real-work workflow", "workflow", lint_first_step, cases=["S-028.1"])
        with definition.open("a", encoding="utf-8") as stream:
            stream.write(
                "      - name: Check local health\n        id: check-health\n        uses: builtin:shell\n        with:\n"
                f"          command: 'curl -fsS http://127.0.0.1:{port}/health'\n")

        def lint_both_steps() -> None:
            result = _case_cli("S-028.2", ["workflow", "lint"], env=env, cwd=project)
            if result.returncode or "real-work.yml" not in result.stdout or "valid" not in result.stdout.lower():
                raise AssertionError(f"workflow lint rejected real-work.yml: {result.stdout!r}")
        journey.step("lint real-work workflow", "workflow", lint_both_steps, cases=["S-028.2"])

        def execute() -> None:
            data = _case_json_cli("S-028.3", ["workflow", "run", "--workflow-id=real-work", "--json"],
                                  env=env, cwd=project)
            run_id = _run_id(data)
            detail = _case_terminal_run("S-028.3", run_id, env=env, cwd=project, clock=clock, sleep=sleep)
            with invocation_context(step_id="S-028.3"):
                logs = _logs(run_id, env=env, cwd=project)
            steps = [step for job in _workflow_run_jobs(detail, "kb workflow runs view --json=all")
                     for step in job["steps"]]
            if (detail.get("status") != "success" or not marker.is_file()
                    or marker.read_text(encoding="utf-8") != "done" or "healthy" not in logs
                    or {step.get("spec", {}).get("id") for step in steps} != {"write-marker", "check-health"}
                    or any(step.get("status") != "success" for step in steps)):
                raise AssertionError(f"real-work output was incomplete: {detail!r}; {logs!r}")
        journey.step("run real shell work and inspect outputs", "workflow", execute, cases=["S-028.3"])
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        definition.unlink(missing_ok=True)


def _rerun_case(journey: Journey, *, env: dict[str, str], project: Path,
                clock: Callable[[], float], sleep: Callable[[float], None]) -> None:
    definition = project / ".kb" / "workflows" / "journey-rerun.yml"
    definition.write_text(
        "name: journey-rerun\nversion: 1.0.0\ninputs:\n  message:\n    type: string\n    required: true\non:\n  manual: true\njobs:\n  rerun:\n    runsOn: local\n    steps:\n"
        "      - name: Preserve successful output\n        id: succeeds\n        uses: builtin:shell\n        with:\n          command: 'echo ${{ inputs.message }}-preserved'\n"
        "      - name: Fail for rerun\n        id: fails\n        uses: builtin:shell\n        with:\n          command: 'echo rerun-failure-diagnostic && exit 23'\n",
        encoding="utf-8")
    source_id = [""]

    def create_source() -> None:
        data = _json_cli(["workflow", "run", "--workflow-id=journey-rerun",
                          '--input={"message":"rerun-input"}', "--json"], env=env, cwd=project)
        source_id[0] = _run_id(data)
        source = _terminal_run(source_id[0], env=env, cwd=project, clock=clock, sleep=sleep)
        if source.get("status") != "failed" or (source.get("inputs") or {}).get("message") != "rerun-input":
            raise AssertionError(f"rerun source did not fail with resolved input: {source!r}")
    journey.step("prepare failed workflow run for rerun", "workflow", create_source)

    rerun_ids: list[str] = []
    def rerun_all() -> None:
        data = _case_json_cli("S-143.1", ["workflow", "runs", "rerun", source_id[0], "--json"], env=env, cwd=project)
        outcome = _workflow_rerun_data(data)
        new_id = outcome["runId"]
        if new_id == source_id[0] or outcome["status"] not in {"queued", "running"}:
            raise AssertionError(f"rerun did not return a new active run: {data!r}")
        rerun_ids.append(new_id)
    journey.step("rerun all workflow jobs", "workflow", rerun_all, cases=["S-143.1"],
                 requires=("step:prepare failed workflow run for rerun",))

    def inspect() -> None:
        detail = _case_terminal_run("S-143.2", rerun_ids[0], env=env, cwd=project,
                                    timeout_seconds=60, clock=clock, sleep=sleep)
        steps = [step for job in _workflow_run_jobs(detail, "kb workflow runs view --json=all")
                 for step in job["steps"]]
        if (detail.get("status") != "failed" or (detail.get("inputs") or {}).get("message") != "rerun-input"
                or not any(step.get("status") == "success" and step.get("spec", {}).get("id") == "succeeds"
                           for step in steps)):
            raise AssertionError(f"rerun did not preserve workflow input and executed jobs: {detail!r}")
    journey.step("verify rerun result and inputs", "workflow", inspect, cases=["S-143.2"],
                 requires=("step:rerun all workflow jobs",))

    def rerun_failed() -> None:
        data = _case_json_cli("S-143.3", ["workflow", "runs", "rerun", source_id[0], "--failed-only", "--json"],
                              env=env, cwd=project)
        outcome = _workflow_rerun_data(data)
        new_id = outcome["runId"]
        if new_id in {source_id[0], rerun_ids[0]} or outcome["status"] not in {"queued", "running"}:
            raise AssertionError(f"failed-only rerun did not create a new active run: {data!r}")
        rerun_ids.append(new_id)
        detail = _case_terminal_run("S-143.3", new_id, env=env, cwd=project,
                                    timeout_seconds=60, clock=clock, sleep=sleep)
        steps = [step for job in _workflow_run_jobs(detail, "kb workflow runs view --json=all")
                 for step in job["steps"]]
        if (not any(step.get("spec", {}).get("id") == "fails" and step.get("status") == "failed" for step in steps)
                or not any(step.get("spec", {}).get("id") == "succeeds" and step.get("status") == "success"
                           for step in steps)):
            raise AssertionError(f"failed-only rerun did not retain successful outputs and replay failure: {detail!r}")
    journey.step("rerun failed jobs only", "workflow", rerun_failed, cases=["S-143.3"],
                 requires=("step:prepare failed workflow run for rerun", "step:rerun all workflow jobs"))

    def unknown_source() -> None:
        before = _case_json_cli("S-143.4", ["workflow", "runs", "list", "--json"], env=env, cwd=project)
        before_runs = _workflow_run_list_data(before)
        result = _case_cli("S-143.4", ["workflow", "runs", "rerun", "run-does-not-exist", "--json"],
                           env=env, cwd=project)
        try:
            envelope = read_ux_cli_result(result)
            payload = {"ok": False, "error": decode_ux_error_result(envelope)}
        except ValueError as error:
            raise AssertionError(f"unknown rerun did not return its typed error envelope: {result.stdout!r}") from error
        error = _workflow_error_data(payload, "kb workflow runs rerun run-does-not-exist --json")
        if (result.returncode == 0 or "run-does-not-exist" not in error["message"]
                or "list" not in error["hint"].lower()):
            raise AssertionError(f"unknown run rerun lacked its not-found guidance: {result.stdout!r}")
        after = _case_json_cli("S-143.4", ["workflow", "runs", "list", "--json"], env=env, cwd=project)
        after_runs = _workflow_run_list_data(after)
        if [run["id"] for run in before_runs] != [run["id"] for run in after_runs]:
            raise AssertionError("unknown rerun created a workflow run")
    journey.step("report unknown rerun source", "workflow", unknown_source, cases=["S-143.4"])
    definition.unlink(missing_ok=True)


def _wait_for_workflow_fixtures(*, env: dict[str, str], cwd: Path,
                                clock: Callable[[], float], sleep: Callable[[float], None]) -> None:
    deadline = clock() + 30
    while clock() < deadline:
        workflows = _workflow_definition_list_data(
            _json_cli(["workflow", "defs", "list", "--json"], env=env, cwd=cwd))
        names = {item["id"] for item in workflows}
        if {"hello", "journey-hello", "journey-fails", "journey-cron-target"}.issubset(names):
            return
        sleep(1)
    raise AssertionError("project workflow catalog did not discover the journey fixtures within 30s")


def _case_runs(*, env: dict[str, str], cwd: Path, workflow: str) -> list[dict]:
    result = _json_cli(["workflow", "runs", "list", f"--workflow={workflow}", "--limit=100", "--json"],
                       env=env, cwd=cwd)
    return _workflow_run_list_data(result, f"kb workflow runs list --workflow={workflow} --limit=100 --json")


def _wait_for_scheduled_run(*, env: dict[str, str], cwd: Path,
                            timeout_seconds: int = 125,
                            clock: Callable[[], float] = time.monotonic,
                            sleep: Callable[[float], None] = time.sleep) -> dict:
    deadline = clock() + timeout_seconds
    while clock() < deadline:
        runs = _case_runs(env=env, cwd=cwd, workflow="journey-cron-target")
        scheduled = [run for run in runs if (run.get("trigger") or {}).get("type") == "schedule"]
        if scheduled:
            run = scheduled[0]
            return _terminal_run(str(run.get("id")), env=env, cwd=cwd, timeout_seconds=180,
                                 clock=clock, sleep=sleep)
        sleep(2)
    raise AssertionError("enabled cron schedule did not create a scheduled workflow run within 125s")


def _cron_case(journey: Journey, *, env: dict[str, str], cwd: Path,
               clock: Callable[[], float] = time.monotonic,
               sleep: Callable[[float], None] = time.sleep) -> None:
    cron_dir = cwd / ".kb" / "crons"
    cron_dir.mkdir(parents=True, exist_ok=True)
    schedule_file = cron_dir / "journey-cron.yml"

    def enable_schedule() -> None:
        schedule_file.write_text(_schedule_yaml(True), encoding="utf-8")
        deadline = clock() + 30
        match = None
        while clock() < deadline:
            data = _case_json_cli("S-044.1", ["workflow", "crons", "list", "--json"], env=env, cwd=cwd)
            crons = _workflow_cron_list_data(data)["crons"]
            match = next((item for item in crons if item["id"] == "journey-cron"), None)
            if (match and match["source"] == "user"
                    and match["target"].get("workflow") == "journey-cron-target"
                    and match["enabled"] is True
                    and match.get("input") == {"message": "journey-cron-fired"}
                    and match.get("nextFireAt")):
                return
            sleep(1)
        raise AssertionError(f"runtime did not register enabled journey-cron with input and next fire time: {match!r}")

    journey.step("enable workflow cron schedule", "workflow", enable_schedule, cases=["S-044.1"])

    scheduled_run: dict = {}

    def observe_schedule() -> None:
        nonlocal scheduled_run
        with invocation_context(step_id="S-044.2"):
            scheduled_run = _wait_for_scheduled_run(env=env, cwd=cwd, clock=clock, sleep=sleep)
        if scheduled_run.get("status") != "success":
            raise AssertionError(f"scheduled workflow run ended {scheduled_run.get('status')!r}")
        metadata = _contract_object(scheduled_run.get("metadata"), "kb workflow runs view --json=all")
        if metadata.get("cronId") != "journey-cron":
            raise AssertionError("scheduled run metadata did not identify cron journey-cron")
        run_id = _contract_string(scheduled_run, "id", "kb workflow runs view --json=all")
        with invocation_context(step_id="S-044.2"):
            logs = _logs(run_id, env=env, cwd=cwd)
        if "journey-cron-fired" not in logs:
            raise AssertionError("scheduled workflow log did not contain journey-cron-fired")

    journey.step("observe scheduled workflow run and log", "workflow", observe_schedule, cases=["S-044.2"])

    def disable_and_confirm() -> None:
        disabled = _case_cli("S-044.3", ["workflow", "crons", "disable", "journey-cron"], env=env, cwd=cwd)
        if disabled.returncode != 0:
            raise AssertionError(f"`kb workflow crons disable journey-cron` failed: {' '.join(disabled.stdout.split())[-500:]}")
        deadline = clock() + 20
        while clock() < deadline:
            data = _case_json_cli("S-044.3", ["workflow", "crons", "list", "--json"], env=env, cwd=cwd)
            crons = _workflow_cron_list_data(data)["crons"]
            match = next((item for item in crons if item["id"] == "journey-cron"), None)
            if match is not None and match.get("enabled") is False:
                break
            sleep(1)
        else:
            raise AssertionError("workflow runtime did not report the schedule as disabled")

        if "enabled: false" not in schedule_file.read_text(encoding="utf-8"):
            raise AssertionError("disable command did not persist enabled: false in the cron file")
        with invocation_context(step_id="S-044.4"):
            baseline_ids = {str(run.get("id")) for run in _case_runs(env=env, cwd=cwd, workflow="journey-cron-target")}
        # Observe a complete cron interval after reload to prove the disabled schedule stays quiet.
        sleep(65)
        with invocation_context(step_id="S-044.4"):
            later_ids = {str(run.get("id")) for run in _case_runs(env=env, cwd=cwd, workflow="journey-cron-target")}
        if later_ids != baseline_ids:
            raise AssertionError("workflow cron created another run after its schedule was disabled")

    journey.step("disable cron and verify no later run", "workflow", disable_and_confirm, cases=["S-044.3", "S-044.4"])

    def enable_again() -> None:
        result = _case_cli("S-044.5", ["workflow", "crons", "enable", "journey-cron"], env=env, cwd=cwd)
        if result.returncode != 0 or "enabled: true" not in schedule_file.read_text(encoding="utf-8"):
            raise AssertionError("enable command did not restore enabled: true in the cron file")
        data = _case_json_cli("S-044.5", ["workflow", "crons", "list", "--json"], env=env, cwd=cwd)
        crons = _workflow_cron_list_data(data)["crons"]
        if not any(item["id"] == "journey-cron" and item["enabled"] is True for item in crons):
            raise AssertionError("cron list did not report journey-cron enabled")

    journey.step("enable cron again", "workflow", enable_again, cases=["S-044.5"])

    def invalid_expression() -> None:
        schedule_file.write_text(_schedule_yaml(True).replace("* * * * *", "not a cron"), encoding="utf-8")
        deadline = clock() + 30
        errors = []
        while clock() < deadline:
            data = _case_json_cli("S-044.6", ["workflow", "crons", "list", "--json"], env=env, cwd=cwd)
            errors = _workflow_cron_list_data(data)["errors"]
            if any(".kb/crons/journey-cron.yml" in error["file"] and "cron" in error["reason"].lower()
                   for error in errors):
                return
            sleep(1)
        raise AssertionError(f"invalid cron diagnostic omitted its file or reason: {errors!r}")

    journey.step("report invalid cron expression", "workflow", invalid_expression, cases=["S-044.6"])

    def unknown_workflow() -> None:
        schedule_file.write_text(_schedule_yaml(True).replace("journey-cron-target", "missing-workflow"), encoding="utf-8")
        deadline = clock() + 30
        errors = []
        while clock() < deadline:
            data = _case_json_cli("S-044.7", ["workflow", "crons", "list", "--json"], env=env, cwd=cwd)
            errors = _workflow_cron_list_data(data)["errors"]
            if any(".kb/crons/journey-cron.yml" in error["file"] and "missing-workflow" in error["reason"]
                   for error in errors):
                return
            sleep(1)
        raise AssertionError(f"unknown workflow diagnostic omitted its file or reason: {errors!r}")

    journey.step("report unknown workflow target", "workflow", unknown_workflow, cases=["S-044.7"])

    def refuse_plugin_enable() -> None:
        listed = _case_json_cli("S-044.8", ["workflow", "crons", "list", "--json"], env=env, cwd=cwd)
        crons = _workflow_cron_list_data(listed)["crons"]
        plugin = next((item for item in crons if item["source"] == "plugin"), None)
        if plugin is None:
            raise AssertionError("cron list did not include a plugin cron to verify read-only behavior")
        before = {key: plugin.get(key) for key in ("enabled", "schedule", "target", "input")}
        result = _case_cli("S-044.8", ["workflow", "crons", "enable", plugin["id"]], env=env, cwd=cwd)
        output = (result.stdout or "") + (result.stderr or "")
        if result.returncode == 0 or "plugin" not in output.lower() or "read-only" not in output.lower():
            raise AssertionError(f"plugin cron enable was not refused with its reason: {output!r}")
        after_list = _case_json_cli("S-044.8", ["workflow", "crons", "list", "--json"], env=env, cwd=cwd)
        after_crons = _workflow_cron_list_data(after_list)["crons"]
        after = next((item for item in after_crons if item["id"] == plugin["id"]), None)
        if after is None or {key: after.get(key) for key in before} != before:
            raise AssertionError("refused plugin cron enable changed the listed cron")

    journey.step("refuse enabling plugin cron", "workflow", refuse_plugin_enable, cases=["S-044.8"])
    schedule_file.unlink(missing_ok=True)


def run_workflow_journey(journey: Journey, *, env: dict[str, str], project: Path,
                         restart_host: Callable[[], None],
                         clock: Callable[[], float] = time.monotonic,
                         sleep: Callable[[float], None] = time.sleep) -> None:
    """Run each workflow release case in the registered project."""

    def install_plugin_cron_fixture() -> None:
        _json_cli(["marketplace", "install", "@kb-labs/steward", "--json"], env=env, cwd=project)
        restart_host()
        data = _json_cli(["workflow", "crons", "list", "--json"], env=env, cwd=project)
        crons = _workflow_cron_list_data(data)["crons"]
        if not any(item["source"] == "plugin" for item in crons):
            raise AssertionError("workflow cron list omitted the cron declared by installed @kb-labs/steward")

    if journey.mode == "secured":
        run_secured_cli_auth_step(journey, env=env, project=project)
    journey.step("install plugin cron fixture", "workflow", install_plugin_cron_fixture)
    _solo_workflow_case(journey, env=env, project=project, clock=clock, sleep=sleep)
    prepare_workflow_fixtures(project)

    def discover_fixtures() -> None:
        _wait_for_workflow_fixtures(env=env, cwd=project, clock=clock, sleep=sleep)
        lock_path = project / ".kb" / "marketplace.lock"
        lock = json.loads(lock_path.read_text()) if lock_path.exists() else {"plugins": {}}
        plugins = lock.get("plugins", {}) if isinstance(lock, dict) else None
        if not isinstance(plugins, dict) or "@kb-labs/workflow" in plugins:
            raise AssertionError("workflow definitions must be available without the workflow plugin installed")

    discovery = journey.step("discover installed project workflow definitions", "workflow",
                             discover_fixtures, cases=["S-006.3"])
    if discovery.status != "PASS":
        return
    successful_id = ""
    failed_id = ""

    _cancellation_case(journey, env=env, project=project, clock=clock, sleep=sleep)
    _live_progress_case(journey, env=env, project=project)
    _real_work_case(journey, env=env, project=project, clock=clock, sleep=sleep)
    _rerun_case(journey, env=env, project=project, clock=clock, sleep=sleep)

    def start_success() -> None:
        nonlocal successful_id
        data = _json_cli(["workflow", "run", "--workflow-id=journey-hello", '--input={"message":"hello"}', "--json"],
                         env=env, cwd=project)
        successful_id = _run_id(data)

    journey.step("start workflow with input", "workflow", start_success, cases=["S-007.1"])

    success_detail: dict = {}

    def inspect_success() -> None:
        nonlocal success_detail
        with invocation_context(step_id="S-056.1"):
            restart_fixture_detail = _terminal_run(successful_id, env=env, cwd=project, clock=clock, sleep=sleep)
        with invocation_context(step_id="S-007.2"):
            success_detail = _terminal_run(successful_id, env=env, cwd=project, clock=clock, sleep=sleep)
        if (restart_fixture_detail.get("status") != "success"
                or success_detail.get("status") != "success"
                or (success_detail.get("inputs") or {}).get("message") != "hello"):
            raise AssertionError(f"run did not complete with the submitted input: {success_detail!r}")

    journey.step("verify terminal status and submitted input", "workflow", inspect_success,
                 cases=["S-007.2", "S-056.1", "PC-002.5"])
    def inspect_success_logs() -> None:
        with invocation_context(step_id="S-007.3"):
            logs = _logs(successful_id, env=env, cwd=project)
        if "hello" not in logs:
            raise AssertionError("workflow logs did not contain the submitted value hello")
    journey.step("verify input appears in workflow log", "workflow", inspect_success_logs, cases=["S-007.3"])

    def start_failure() -> None:
        nonlocal failed_id
        data = _case_json_cli("S-029.1", ["workflow", "run", "--workflow-id=journey-fails", "--json"],
                              env=env, cwd=project)
        failed_id = _run_id(data)

    journey.step("start failing workflow", "workflow", start_failure, cases=["S-029.1"])

    failed_detail: dict = {}

    def inspect_failure() -> None:
        nonlocal failed_detail
        with invocation_context(step_id="S-029.2"):
            failed_detail = _terminal_run(failed_id, env=env, cwd=project, clock=clock, sleep=sleep)
        if failed_detail.get("status") != "failed":
            raise AssertionError(f"failing workflow ended with {failed_detail.get('status')!r}")
        steps = [step for job in _workflow_run_jobs(failed_detail, "kb workflow runs view --json=all")
                 for step in job["steps"]]
        failed = [step for step in steps if step.get("status") == "failed"]
        if (not failed or failed[0].get("name") != "Deliberate failure"
                or (failed[0].get("spec") or {}).get("id") != "deliberate-failure"):
            raise AssertionError(f"run detail did not identify the failed step and diagnostic: {failed_detail!r}")
        error = failed[0].get("error")
        error_message = error.get("message", "") if isinstance(error, dict) else str(error or "")
        if not error_message.strip():
            raise AssertionError("failed step detail did not include an error message")
        env["KB_STUDIO_DIAGNOSTIC_RUN_ID"] = failed_id

    journey.step("inspect failed step and error", "workflow", inspect_failure,
                 cases=["S-029.2"])

    def inspect_failure_history() -> None:
        with invocation_context(step_id="S-009.4"):
            detail = _terminal_run(failed_id, env=env, cwd=project, clock=clock, sleep=sleep)
        failed_steps = [step for job in _workflow_run_jobs(detail, "kb workflow runs view --json=all")
                        for step in job["steps"] if step.get("status") == "failed"]
        if detail.get("status") != "failed" or not failed_steps or not failed_steps[0].get("error"):
            raise AssertionError("failed run detail omitted the failure reason and failed step")
    journey.step("inspect failed run history details", "workflow", inspect_failure_history, cases=["S-009.4"])

    def inspect_failure_logs() -> None:
        with invocation_context(step_id="S-029.3"):
            logs = _logs(failed_id, env=env, cwd=project)
        if "journey-failure-diagnostic" not in logs:
            raise AssertionError("failed workflow logs omitted the failing command diagnostic")
        if any(marker in logs.lower() for marker in ("goroutine ", "traceback", "stack trace")):
            raise AssertionError("workflow logs exposed a raw service stack trace")

    journey.step("inspect failing command logs", "workflow", inspect_failure_logs,
                 cases=["S-029.3"])

    def inspect_history() -> None:
        with invocation_context(step_id="S-009.1"):
            runs = _case_runs(env=env, cwd=project, workflow="journey-hello")
        if not any(run.get("id") == successful_id and run.get("status") == "success" and run.get("createdAt") for run in runs):
            raise AssertionError("workflow history omitted the successful run ID, status, or time")
        with invocation_context(step_id="S-009.1"):
            failed_runs = _case_runs(env=env, cwd=project, workflow="journey-fails")
        if not any(run.get("id") == failed_id and run.get("status") == "failed" for run in failed_runs):
            raise AssertionError("workflow history omitted the failed run")

    journey.step("list recent workflow history", "workflow", inspect_history, cases=["S-009.1"])
    def inspect_selected_run() -> None:
        detail = _case_terminal_run("S-009.2", successful_id, env=env, cwd=project, clock=clock, sleep=sleep)
        if detail.get("status") != "success":
            raise AssertionError("selected workflow run was not successful")
    journey.step("inspect selected successful run", "workflow", inspect_selected_run, cases=["S-009.2"])

    def inspect_selected_run_logs() -> None:
        with invocation_context(step_id="S-009.3"):
            logs = _logs(successful_id, env=env, cwd=project)
        if "hello" not in logs:
            raise AssertionError("selected workflow run logs were empty")
    journey.step("inspect selected successful run logs", "workflow", inspect_selected_run_logs, cases=["S-009.3"])

    def restart_and_verify_project() -> None:
        with invocation_context(step_id="S-056.2"):
            restart_host()
            workflows = _case_json_cli("S-056.2", ["workflow", "defs", "list", "--json"], env=env, cwd=project)
        workflows = _workflow_definition_list_data(workflows)
        if not any(workflow["id"] == "journey-hello" for workflow in workflows):
            raise AssertionError("registered project workflow was unavailable after host restart")

    journey.step("restart host and verify project availability", "platform",
                 restart_and_verify_project, cases=["S-056.2"])

    def inspect_history_after_restart() -> None:
        runs = _case_json_cli("S-056.3", ["workflow", "runs", "list", "--limit=100", "--json"],
                              env=env, cwd=project)
        all_runs = _workflow_run_list_data(runs, "kb workflow runs list --limit=100 --json")
        if not any(run["id"] == successful_id and run["status"] == "success" for run in all_runs):
            raise AssertionError(f"workflow history after host restart omitted successful run {successful_id}")
        detail = _case_json_cli("S-056.3", ["workflow", "runs", "view", successful_id, "--json=all"],
                                env=env, cwd=project)
        detail = _workflow_run_detail_data(detail)
        if detail["status"] != "success":
            raise AssertionError(f"workflow detail after host restart lost terminal status for {successful_id}")
        with invocation_context(step_id="S-056.3"):
            logs = _logs(successful_id, env=env, cwd=project)
        if "hello" not in logs:
            raise AssertionError(f"workflow logs after host restart omitted known output for {successful_id}")

    journey.step("read workflow history and logs after restart", "workflow",
                 inspect_history_after_restart, cases=["S-056.3"])

    try:
        _cron_case(journey, env=env, cwd=project, clock=clock, sleep=sleep)
    finally:
        jobs_dir = project / ".kb" / "crons"
        (jobs_dir / "journey-cron.yml").unlink(missing_ok=True)
        try:
            jobs_dir.rmdir()
        except OSError:
            pass


def merge_workflow_result(service_report: Path, workflow_result: dict) -> dict:
    """Add workflow journey claims to the service result consumed by release coverage."""
    try:
        service_result = json.loads(service_report.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"cannot merge workflow journey into {service_report}: {error}") from error
    service_result.setdefault("steps", []).extend(workflow_result.get("steps", []))
    claims = {
        claim["claimId"]: claim
        for claim in service_result.get("case_run", {}).get("claims", [])
        if isinstance(claim, dict) and isinstance(claim.get("claimId"), str)
    }
    for claim in workflow_result.get("case_run", {}).get("claims", []):
        if isinstance(claim, dict) and isinstance(claim.get("claimId"), str):
            claims[claim["claimId"]] = claim
    service_result.setdefault("case_run", {})["claims"] = [claims[key] for key in sorted(claims)]
    if workflow_result.get("status") != "PASS":
        service_result["status"] = "FAIL"
        service_result["first_failure"] = service_result.get("first_failure") or workflow_result.get("first_failure")
    return write_report_json(service_report, service_result)
