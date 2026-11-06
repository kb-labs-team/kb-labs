"""Installed-platform journeys for adapter defaults and platform-only bindings."""
from __future__ import annotations

from kb_invocation import kb_command
from installed_fixture import layout_relative, layout_value

import json
import os
import re
import shlex
import shutil
import sqlite3
import tempfile
import urllib.request
from contextlib import closing
from pathlib import Path
from typing import Callable

from journey_resources import active_platform_root
from sdk_runtime_import_check import check_installed_runtime_imports
from service_steps import Journey
from marketplace_steps import _platform_snapshot
from platform_update_steps import _changed_paths
from invocations import (
    CompletedProcess,
    decode_ux_error_result,
    decode_ux_success_result,
    export_project_identity_to_child_environment,
    catalogued_error_hint,
    catalogued_error_message,
    open_http,
    read_kb_create_cli_result,
    read_ux_cli_result,
    read_ux_http_result,
    run_command,
    run_with_runner,
)

CommandRunner = Callable[..., CompletedProcess[str]]


def _run(runner: CommandRunner, command: list[str], cwd: Path, env: dict[str, str]) -> CompletedProcess[str]:
    result = run_with_runner(runner, command, cwd=str(cwd), env=env, timeout=300)
    if result.returncode != 0:
        detail = " ".join(f"{result.stdout or ''} {result.stderr or ''}".split())[-400:]
        raise RuntimeError(f"`{' '.join(command)}` exited {result.returncode}: {detail}")
    return result


def _json(result: CompletedProcess[str], command: list[str]) -> dict:
    try:
        if command[0] == "kb-create":
            value = read_kb_create_cli_result(command[1], result)
        else:
            value = read_ux_cli_result(result)
    except ValueError as error:
        raise RuntimeError(f"`{' '.join(command)}` did not return JSON") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"`{' '.join(command)}` returned a non-object JSON value")
    if value.get("ok") is True:
        return {"ok": True, **decode_ux_success_result(value)}
    return {"ok": False, "error": decode_ux_error_result(value)}


def _assert_required_upstreams_ready(readiness: object) -> None:
    if not isinstance(readiness, dict) or readiness.get("ready") is not True:
        raise RuntimeError("Gateway /ready did not report ready")
    components = readiness.get("components")
    if not isinstance(components, dict):
        raise RuntimeError("Gateway /ready did not report component readiness")
    upstreams = [(name, value) for name, value in components.items()
                 if isinstance(name, str) and name.startswith("upstream:")]
    if not upstreams:
        raise RuntimeError("Gateway /ready did not report required upstreams")
    unavailable = [name.removeprefix("upstream:") for name, value in upstreams
                   if not isinstance(value, dict) or value.get("ready") is not True]
    if unavailable:
        raise RuntimeError(
            "Gateway /ready reports required upstreams not ready: " + ", ".join(unavailable)
        )


def config(root: Path) -> dict:
    config_path = root / ".kb" / "kb.config.jsonc"
    if not config_path.exists():
        config_path = root / ".kb" / "kb.config.json"
    if not config_path.exists():
        return {}
    value = json.loads(config_path.read_text())
    return value if isinstance(value, dict) else {}


def _assert_no_project_adapter_config(project_root: Path) -> None:
    config_paths = [project_root / ".kb" / "kb.config.json",
                    project_root / ".kb" / "kb.config.jsonc"]
    present = [path.name for path in config_paths if path.is_file()]
    if present:
        raise RuntimeError("registered project has user-written adapter config: " + ", ".join(present))


def _assert_missing_gateway_dispatch_error(result: CompletedProcess[str]) -> None:
    if result.returncode == 0:
        raise RuntimeError("workflow dispatch without KB_GATEWAY_URL unexpectedly succeeded")
    try:
        envelope = read_ux_cli_result(result)
        error = decode_ux_error_result(envelope)
    except ValueError as failure:
        raise RuntimeError(f"workflow dispatch without KB_GATEWAY_URL returned no typed error: {failure}") from failure
    details = error.get("details")
    if (error.get("code") != "KB_HOST_SERVICE_ADDRESS_MISSING"
            or error.get("message") != catalogued_error_message("KB_HOST_SERVICE_ADDRESS_MISSING")
            or error.get("hint") != catalogued_error_hint("KB_HOST_SERVICE_ADDRESS_MISSING")
            or not isinstance(details, dict) or details.get("service") != "gateway"
            or not isinstance(error.get("correlationId"), str)
            or not error["correlationId"]):
        raise RuntimeError("workflow dispatch did not report the catalogued missing gateway address with correlation")


def write_config(root: Path, value: dict) -> None:
    config_path = root / ".kb" / "kb.config.jsonc"
    if not config_path.exists():
        config_path = root / ".kb" / "kb.config.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(value, indent=2) + "\n")


def _project_state_dir(project_root: Path, env: dict[str, str]) -> Path:
    kb_home = Path(env.get("KB_HOME", str(Path(env["HOME"]) / ".kb"))).resolve()
    registry_path = kb_home / "projects.json"
    try:
        projects = json.loads(registry_path.read_text()).get("projects", [])
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"could not read project registry {registry_path}") from error
    canonical = project_root.resolve()
    project = next((row for row in projects if isinstance(row, dict) and Path(row.get("path", "")).resolve() == canonical), None)
    if not project or not isinstance(project.get("id"), str):
        raise RuntimeError(f"project is not registered in {registry_path}: {canonical}")
    return kb_home / layout_value('sharedStateDirectory') / project["id"]


def _repository_tree(root: Path) -> dict[str, bytes | str]:
    snapshot: dict[str, bytes | str] = {}
    for path in sorted(root.rglob("*")):
        if ".git" in path.relative_to(root).parts:
            continue
        relative = str(path.relative_to(root))
        if path.is_symlink():
            snapshot[relative] = f"symlink:{os.readlink(path)}"
        elif path.is_file():
            snapshot[relative] = path.read_bytes()
        elif path.is_dir():
            snapshot[relative] = "directory"
    return snapshot


def _run_from_registered_project(
    runner: CommandRunner,
    command: list[str],
    cwd: Path,
    env: dict[str, str],
    **kwargs,
) -> CompletedProcess[str]:
    baseline = _repository_tree(cwd)
    result = run_with_runner(runner, command, cwd=str(cwd), env=env, **kwargs)
    if _repository_tree(cwd) != baseline:
        raise RuntimeError(f"{' '.join(command)} changed the registered project repository {cwd}")
    return result


def _restore_platform_adapter_fixture(
    config_path: Path,
    original_config: bytes | None,
    project_root: Path,
    platform_root: Path,
    env: dict[str, str],
    runner: CommandRunner,
) -> str | None:
    try:
        current_config = config_path.read_bytes() if config_path.exists() else None
        if current_config == original_config:
            return None
        if original_config is None:
            config_path.unlink(missing_ok=True)
        else:
            config_path.write_bytes(original_config)
        restart = ["kb-create", "restart", "--platform-root", str(platform_root), "--json"]
        result = _run(runner, restart, project_root, env)
        if _json(result, restart).get("ok") is not True:
            return "platform host did not restart after restoring its original adapter config"
        restored_config = config_path.read_bytes() if config_path.exists() else None
        changed_keys = _config_difference_keys(original_config, restored_config)
        if changed_keys:
            return "platform adapter config differs from its snapshot at keys: " + ", ".join(changed_keys)
        return None
    except Exception as error:
        return f"platform adapter config could not be restored: {error}"


def _config_difference_keys(original: bytes | None, current: bytes | None) -> list[str]:
    """Return changed JSON key paths without exposing config values."""
    if original is None or current is None:
        return [] if original == current else ["<config file>"]
    try:
        before = json.loads(original)
        after = json.loads(current)
    except json.JSONDecodeError:
        return ["<invalid JSON>"]

    return [path.removeprefix("config.") for path in _changed_paths(before, after, "config")]


def run_adapter_default_steps(journey: Journey, project_root: str | Path,
                              env: dict[str, str] | None = None,
                              runner: CommandRunner = run_command,
                              snapshot: dict[str, object] | None = None) -> None:
    """Run S-054 and S-048 using installed `kb` commands in both auth modes."""
    project_a = Path(project_root).resolve()
    base_env = dict(os.environ if env is None else env)
    registered_project_roots = {project_a}
    command_runner = runner
    def runner(command, **kwargs):
        options = dict(kwargs)
        timeout = options.pop("timeout", 300)
        options.pop("capture_output", None)
        text_mode = options.pop("text", True)
        options.pop("stdout", None)
        options.pop("stderr", None)
        cwd_value = options.get("cwd")
        cwd = Path(cwd_value).resolve() if cwd_value is not None else None
        if cwd in registered_project_roots:
            command_env = options.get("env") or base_env
            result = _run_from_registered_project(
                command_runner,
                command,
                cwd,
                command_env,
                timeout=timeout,
                **{key: value for key, value in options.items() if key not in {"cwd", "env", "timeout"}},
            )
        else:
            result = run_with_runner(command_runner, command, timeout=timeout, **options)
        stdout = result.stdout or ""
        stderr = result.stderr or ""
        if text_mode:
            if isinstance(stdout, bytes):
                stdout = stdout.decode(errors="replace")
            if isinstance(stderr, bytes):
                stderr = stderr.decode(errors="replace")
        elif isinstance(stdout, str):
            stdout = stdout.encode()
            stderr = stderr.encode() if isinstance(stderr, str) else stderr
        elif isinstance(stderr, str):
            stderr = stderr.encode()
        return CompletedProcess(command, result.returncode,
                                            stdout=stdout, stderr=stderr)
    export_project_identity_to_child_environment(base_env, project_root=str(project_a))
    project_state = _project_state_dir(project_a, base_env)
    platform_root = Path(base_env.get("KB_JOURNEY_PLATFORM_ROOT", str(Path(base_env["HOME"]) / "kb-platform"))).resolve()
    platform_content_root = active_platform_root(platform_root)
    project_b = Path(tempfile.mkdtemp(prefix="kb-adapter-project-b-", dir=base_env["HOME"]))
    project_b_registered = False
    platform_config_path = platform_content_root / layout_value('sharedRuntimePaths.kb_kb_config_jsonc.platformPath')
    if not platform_config_path.exists():
        platform_config_path = platform_root / ".kb" / "kb.config.json"
    original_platform_config = platform_config_path.read_bytes() if platform_config_path.exists() else None
    if snapshot is not None:
        snapshot["path"] = platform_config_path
        snapshot["contents"] = original_platform_config

    def cli(args: list[str], cwd: Path = project_a) -> CompletedProcess[str]:
        return _run(runner, kb_command(args), cwd, base_env)

    def list_adapters(cwd: Path = project_a) -> dict:
        command = ["adapter", "list", "--json"]
        return _json(cli(command, cwd), command)

    def rows_for(cwd: Path) -> dict[str, dict]:
        payload = list_adapters(cwd)
        rows = payload.get("adapters")
        if not isinstance(rows, list):
            raise RuntimeError("`kb adapter list --json` returned no adapters array")
        return {row["slot"]: row for row in rows if isinstance(row, dict) and isinstance(row.get("slot"), str)}

    def run_workflow(cwd: Path) -> tuple[str, Path, dict]:
        run_command = ["workflow", "run", "--workflow-id=e2e-hello", "--json"]
        payload = _json(cli(run_command, cwd), run_command)
        run_id = payload.get("runId")
        if not isinstance(run_id, str) or not run_id:
            raise RuntimeError("`kb workflow run --workflow-id=e2e-hello --json` returned no runId")
        watch_command = ["workflow", "runs", "watch", run_id]
        watched = _run(runner, kb_command([ *watch_command]), cwd, base_env)
        if watched.returncode != 0 or "Run SUCCESS." not in watched.stdout:
            detail = " ".join((watched.stderr or watched.stdout).split())[-300:]
            raise RuntimeError(f"workflow run {run_id} did not complete successfully: {detail}")
        row = rows_for(cwd).get("storage")
        if not row or row.get("mode") != "real" or row.get("implementation") != "@kb-labs/adapters-fs":
            raise RuntimeError("project does not report the built-in filesystem adapter for storage")
        base_dir = row.get("baseDir")
        if not isinstance(base_dir, str):
            raise RuntimeError("storage adapter list did not report its effective baseDir")
        record = Path(base_dir) / "workflows" / f"{run_id}.json"
        if not record.is_absolute():
            record = cwd / record
        if not record.is_file():
            raise RuntimeError(f"workflow run record is missing from the configured storage adapter: {record}")
        try:
            record_value = json.loads(record.read_text())
        except json.JSONDecodeError as error:
            raise RuntimeError(f"workflow run record is invalid JSON: {record}") from error
        if record_value.get("runId") != run_id or str(record_value.get("status", "")).lower() != "success":
            raise RuntimeError(f"workflow run record does not match successful run {run_id}: {record_value!r}")
        status_command = ["kb-create", "status", "--platform-root", str(platform_root), "--json"]
        host_status = _json(_run(runner, status_command, cwd, base_env), status_command)
        health_url = host_status.get("host", {}).get("healthUrl")
        if not isinstance(health_url, str) or not health_url:
            raise RuntimeError("`kb-create status --json` returned no host health URL after the workflow run")
        readiness_request = urllib.request.Request(health_url.rsplit("/", 1)[0] + "/ready")
        readiness_status, readiness_body, _ = open_http(
            urllib.request.urlopen, readiness_request, timeout=10, env=base_env)
        if readiness_status != 200:
            raise RuntimeError(f"GET {readiness_request.full_url} returned HTTP {readiness_status} after the workflow run")
        try:
            readiness_envelope = read_ux_http_result(readiness_body, readiness_status)
            readiness = decode_ux_success_result(readiness_envelope)
        except ValueError as error:
            raise RuntimeError(f"GET /ready returned an invalid UX result envelope: {error}") from error
        _assert_required_upstreams_ready(readiness)

        health_request = urllib.request.Request(health_url.rsplit("/", 1)[0] + "/health")
        health_status, health_body, _ = open_http(
            urllib.request.urlopen, health_request, timeout=10, env=base_env)
        if health_status != 200:
            raise RuntimeError(f"GET {health_request.full_url} returned HTTP {health_status} after the workflow run")
        try:
            health_envelope = read_ux_http_result(health_body, health_status)
            health = decode_ux_success_result(health_envelope)
        except ValueError as error:
            raise RuntimeError(f"GET /health returned an invalid UX result envelope: {error}") from error
        runtimes = health.get("projectRuntimes", {}).get("runtimes", []) if isinstance(health, dict) else []
        project_id = project_state.name
        if not any(isinstance(runtime, dict) and runtime.get("projectId") == project_id
                   and runtime.get(layout_value('sharedStateDirectory')) == "ready" for runtime in runtimes):
            raise RuntimeError(f"host health did not list project runtime {project_id} as ready after its first workflow request")
        return run_id, record, record_value

    def assert_default_list() -> None:
        rows = rows_for(project_a)
        if "storage" not in rows or rows["storage"].get("baseDir") != str(project_state / "storage"):
            raise RuntimeError(f"storage default path mismatch: expected {str(project_state / 'storage')!r}, received {rows.get('storage', {}).get('baseDir')!r}")
        if rows["storage"].get("networkRequired") is not False:
            raise RuntimeError("filesystem storage reports a network dependency")
        expected_defaults = {
            "logger": "@kb-labs/adapters-pino",
            "analytics": "@kb-labs/adapters-analytics-sqlite",
            "documentDatabase": "@kb-labs/adapters-sqlite",
            "kvStore": "@kb-labs/adapters-sqlite/kv",
            "eventBus": "@kb-labs/adapters-eventbus-cache",
            "llm": "@kb-labs/adapters-openai",
            "invoke": "InMemoryInvoke",
            "artifacts": "InMemoryArtifacts",
        }
        for slot, implementation in expected_defaults.items():
            if rows[slot].get("implementation") != implementation:
                raise RuntimeError(f"{slot} does not use its built-in default {implementation}")
        persistent_slots = ("storage", "cache", "logger", "analytics", "eventBus", "documentDatabase", "kvStore", "logs")
        for slot in persistent_slots:
            if rows[slot].get("mode") != "real":
                raise RuntimeError(f"persistent built-in slot {slot} fell back to {rows[slot].get('mode')}")
        if rows["cache"].get("implementation") != "@kb-labs/adapters-state-broker" or rows["cache"].get("networkRequired") is not False:
            raise RuntimeError("cache does not use the platform-local StateBroker default")
        if rows["logs"].get("implementation") != "HybridLogReader" or rows["logs"].get("mode") != "real":
            raise RuntimeError("logs are not backed by the installed local buffer and persistence adapters")
        if rows["notifier"].get("implementation") != "InMemoryNotifier":
            raise RuntimeError("notifier does not use the local in-process default")
        if rows["config"].get("mode") != "inmemory" or not rows["config"].get("implementation"):
            raise RuntimeError("config does not use its local in-process default")
        if rows["llm"].get("mode") != "real" or rows["llm"].get("credentialsStatus") != "missing" or rows["llm"].get("missingCredentials") != ["OPENAI_API_KEY"]:
            raise RuntimeError("implicit OpenAI LLM default does not report its missing credential")
        openai_package = platform_content_root / "node_modules" / "@kb-labs" / "adapters-openai" / "package.json"
        if not openai_package.is_file() or json.loads(openai_package.read_text()).get("name") != "@kb-labs/adapters-openai":
            raise RuntimeError("sealed base install does not include the implicit OpenAI LLM default")
        if (rows["vectorStore"].get("mode") != "real"
                or rows["vectorStore"].get("implementation") != "@kb-labs/adapters-sqlite/vector-store"):
            raise RuntimeError("SQLite vector store is not selected by the default pack")
        if (rows["embeddings"].get("mode") != "real"
                or rows["embeddings"].get("implementation") != "@kb-labs/adapters-openai/embeddings"
                or rows["embeddings"].get("credentialsStatus") != "missing"):
            raise RuntimeError("OpenAI embeddings default does not report its missing credential")
        if rows["snapshotManager"].get("mode") != "unconfigured":
            raise RuntimeError("snapshotManager is not left unconfigured")

    journey.step("list fresh-install built-in adapter defaults", "adapter", assert_default_list, cases=["S-054.1"])

    def assert_installed_defaults_without_project_config() -> None:
        _assert_no_project_adapter_config(project_a)
        assert_default_list()

    journey.step("list installed defaults without project adapter config", "adapter",
                 assert_installed_defaults_without_project_config, cases=["S-054.18"])

    def assert_missing_gateway_dispatch_is_actionable() -> None:
        command = ["workflow", "run", "--workflow-id=e2e-hello", "--json"]
        dispatch_env = base_env.copy()
        dispatch_env.pop("KB_GATEWAY_URL", None)
        result = runner(kb_command(command), cwd=str(project_a), env=dispatch_env, timeout=300)
        _assert_missing_gateway_dispatch_error(result)

    journey.step("report missing host gateway address for workflow dispatch", "adapter",
                 assert_missing_gateway_dispatch_is_actionable, cases=["S-054.19"])

    def assert_optional_openai_requirement_in_install_plan() -> None:
        receipt_path = active_platform_root(platform_root) / ".kb" / "v2" / "receipt.json"
        if not receipt_path.is_file():
            raise RuntimeError("fresh install did not write its V2 receipt")
        receipt = json.loads(receipt_path.read_text())
        artifacts = receipt.get("plan", {}).get("artifacts", [])
        openai = next((artifact for artifact in artifacts if artifact.get("package") == "@kb-labs/adapters-openai"), None)
        requirement = next((item for item in openai.get("config", []) if item.get("id") == "openai.apiKey"), None) if openai else None
        if not requirement or requirement.get("optional") is not True or requirement.get("severity") != "warning" or requirement.get("action") != "set OPENAI_API_KEY to enable LLM features":
            raise RuntimeError("fresh install plan did not retain the optional OpenAI credential warning metadata")
        if any(patch.get("environment") == "OPENAI_API_KEY" for patch in receipt.get("plan", {}).get("configPatches", [])):
            raise RuntimeError("fresh install plan unexpectedly requires an OpenAI secret input")

    journey.step("fresh install retains optional OpenAI warning metadata", "adapter",
                 assert_optional_openai_requirement_in_install_plan, cases=["S-054.15"])

    def assert_installed_sdk_and_plugin_runtime_imports() -> None:
        result = check_installed_runtime_imports(platform_content_root)
        if result.returncode != 0:
            detail = " ".join(f"{result.stdout} {result.stderr}".split())
            raise RuntimeError(detail or "installed runtime entrypoint import check exited without output")

    journey.step("import installed SDK and bundled plugin runtime entrypoints", layout_value('installerStateDirectory'),
                 assert_installed_sdk_and_plugin_runtime_imports, cases=["S-054.16"])

    def assert_installed_layout_cli_loads_defaults() -> None:
        rows = rows_for(project_a)
        if rows["storage"].get("implementation") != "@kb-labs/adapters-fs" or rows["storage"].get("mode") != "real":
            raise RuntimeError("installed-layout CLI did not load the sealed filesystem storage default")
        if rows["storage"].get("baseDir") != str(project_state / "storage"):
            raise RuntimeError("installed-layout CLI did not resolve storage beneath the registered project's platform state directory")
        if rows["kvStore"].get("implementation") != "@kb-labs/adapters-sqlite/kv":
            raise RuntimeError("installed-layout CLI did not load the sealed SQLite KV export subpath")

    journey.step("installed-layout CLI loads sealed adapter defaults", "adapter",
                 assert_installed_layout_cli_loads_defaults, cases=["S-054.12"])

    def assert_doctor() -> None:
        status_command = ["kb-create", "status", "--platform-root", str(platform_root), "--json"]
        host_status = _json(_run(runner, status_command, project_a, base_env), status_command)
        health_url = host_status.get("host", {}).get("healthUrl")
        if not isinstance(health_url, str) or not health_url:
            raise RuntimeError("`kb-create status --json` returned no host health URL")
        health_request = urllib.request.Request(health_url.rsplit("/", 1)[0] + "/health/adapters")
        health_status, health_body, _ = open_http(
            urllib.request.urlopen, health_request, timeout=10, env=base_env)
        if health_status != 200:
            raise RuntimeError(f"GET {health_request.full_url} returned HTTP {health_status}")
        try:
            runtime_adapters = decode_ux_success_result(read_ux_http_result(health_body, health_status))
        except (json.JSONDecodeError, ValueError) as error:
            raise RuntimeError(f"GET /health/adapters returned an invalid UX result envelope: {error}") from error
        if not isinstance(runtime_adapters, list):
            raise RuntimeError("GET /health/adapters returned no adapter list")
        expected_adapters = {row.get("slot"): row for row in runtime_adapters if isinstance(row, dict)}
        command = ["kb-create", "doctor", "--platform-root", str(platform_root), "--json"]
        # Missing OpenAI credentials are a doctor finding, so the command's
        # nonzero status is expected even while the installed host is healthy.
        result = runner(command, cwd=str(project_a), env=base_env, capture_output=True, text=True, timeout=300)
        payload = _json(result, command)
        if result.returncode != 0 or payload.get("ok") is not True:
            raise RuntimeError("doctor treated the optional OpenAI credential warning as an install failure")
        if not isinstance(payload.get("platform"), dict) or payload["platform"].get("ok") is not True:
            raise RuntimeError("`kb-create doctor --platform-root <platform-root> --json` reports a platform health failure")
        credential_warnings = [row for row in payload.get("findings", [])
                                if isinstance(row, dict) and row.get("code") == "KB_ADAPTER_CREDENTIALS_MISSING"]
        expected_actions = {
            "set OPENAI_API_KEY to enable LLM features",
            "set OPENAI_API_KEY to enable embeddings",
        }
        if ({row.get("action") for row in credential_warnings} != expected_actions
                or any(row.get("severity") != "warning" or "OPENAI_API_KEY" not in json.dumps(row)
                       for row in credential_warnings)):
            raise RuntimeError("doctor does not report both missing OpenAI credentials as actionable warnings")
        platform = payload.get("platform")
        statuses = platform.get("checks") if isinstance(platform, dict) else None
        if not isinstance(statuses, list):
            raise RuntimeError("`kb-create doctor --platform-root <platform-root> --json` returned no platform checks")
        adapter_statuses = {row.get("slot"): row for row in statuses if isinstance(row, dict) and isinstance(row.get("slot"), str)}
        if set(adapter_statuses) != set(expected_adapters):
            raise RuntimeError("doctor does not report every runtime adapter slot from /health/adapters")
        for slot, expected in expected_adapters.items():
            row = adapter_statuses[slot]
            if row.get("mode") != expected.get("mode") or row.get("implementation") != expected.get("implementation"):
                raise RuntimeError(f"doctor does not report mode and implementation for adapter slot {slot}")
        storage = next((row for row in statuses if isinstance(row, dict) and row.get("slot") == "storage"), None)
        if not storage or storage.get("implementation") != "@kb-labs/adapters-fs" or storage.get("mode") != "real":
            raise RuntimeError("doctor does not report the built-in filesystem storage default as loaded")
        for slot in ("cache", "logger", "analytics", "documentDatabase", "kvStore"):
            status = next((row for row in statuses if isinstance(row, dict) and row.get("slot") == slot), None)
            if not status or status.get("mode") != "real":
                raise RuntimeError(f"doctor does not report the local {slot} default as loaded")
        for slot in ("storage", "cache", "logger", "analytics", "eventBus", "documentDatabase", "kvStore"):
            status = next((row for row in statuses if isinstance(row, dict) and row.get("slot") == slot), None)
            if not status or status.get("mode") != "real":
                raise RuntimeError(f"doctor reports a persistent built-in slot {slot} in fallback mode")
        logs = next((row for row in statuses if isinstance(row, dict) and row.get("slot") == "logs"), None)
        if not logs or logs.get("mode") != "real" or logs.get("implementation") != "HybridLogReader":
            raise RuntimeError("doctor does not report the local HybridLogReader as loaded")
        text_command = ["kb-create", "doctor", "--platform-root", str(platform_root)]
        text_result = runner(text_command, cwd=str(project_a), env=base_env, capture_output=True, text=True, timeout=300)
        if (text_result.returncode != 0 or "Adapter storage: mode=real implementation=@kb-labs/adapters-fs" not in text_result.stdout
                or "Warnings:" not in text_result.stdout
                or any(action not in text_result.stdout for action in expected_actions)):
            raise RuntimeError("`kb-create doctor --platform-root <platform-root>` text output omits healthy storage or the optional credential warning")

    journey.step("doctor verifies filesystem default is loaded", "adapter", assert_doctor, cases=["S-054.2"])

    def assert_doctor_manifest_repair_is_explicit() -> None:
        manifest = platform_content_root / "node_modules" / "@kb-labs" / "gateway-app" / "kb-create.manifest.json"
        if not manifest.is_file():
            raise RuntimeError(f"the installed gateway artifact has no manifest projection to diagnose: {manifest}")
        manifest.unlink()
        doctor_command = ["kb-create", "doctor", "--platform-root", str(platform_root), "--json"]
        result = runner(doctor_command, cwd=str(project_a), env=base_env, capture_output=True, text=True, timeout=300)
        payload = _json(result, doctor_command)
        findings = payload.get("findings")
        if (result.returncode != 0 or payload.get("operation") != "doctor"
                or payload.get("status") != "unhealthy"
                or not isinstance(findings, list) or not any(
            isinstance(row, dict) and row.get("code") == "KB_INSTALL_MANIFEST_PROJECTION_INVALID" and
            row.get("component") == "@kb-labs/gateway-app" and "kb-create doctor --fix" in row.get("hint", "")
            for row in findings
        )):
            raise RuntimeError("read-only doctor did not report the missing gateway manifest projection")
        if manifest.exists():
            raise RuntimeError("plain doctor recreated the missing manifest projection")
        fix_command = ["kb-create", "doctor", "--platform-root", str(platform_root), "--fix", "--json"]
        fixed = runner(fix_command, cwd=str(project_a), env=base_env, capture_output=True, text=True, timeout=300)
        fix_payload = _json(fixed, fix_command)
        if fixed.returncode != 0 or fix_payload.get("operation") != "doctor-fix":
            raise RuntimeError("kb-create doctor --fix did not return its successful repair result")
        if not manifest.is_file():
            raise RuntimeError("kb-create doctor --fix did not restore the missing manifest projection")

    journey.step("doctor reports missing manifests read-only and repairs only with fix", layout_value('installerStateDirectory'),
                 assert_doctor_manifest_repair_is_explicit, cases=["S-054.13"])

    def assert_unbound_analytics_uses_manifest_default() -> None:
        config_file = active_platform_root(platform_root) / ".kb" / "kb.config.jsonc"
        original = config_file.read_bytes()
        analytics_db = project_state / "analytics" / "analytics.sqlite"
        analytics_db.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(analytics_db)) as database, database:
            database.execute("""
                CREATE TABLE events (
                    id TEXT PRIMARY KEY, schema TEXT NOT NULL DEFAULT 'kb.v1', type TEXT NOT NULL,
                    ts TEXT NOT NULL, ingest_ts TEXT, run_id TEXT, product TEXT, version TEXT,
                    actor_type TEXT, actor_id TEXT, actor_name TEXT, ctx TEXT, payload TEXT
                )
            """)
            database.execute(
                "INSERT INTO events (id, type, ts, payload) VALUES (?, ?, ?, ?)",
                ("restart-check", "journey.restart-check", "2026-10-02T00:00:00.000Z", "{\"check\":true}"),
            )
        config = json.loads(original)
        platform = config.setdefault("platform", {})
        adapters = platform.setdefault("adapters", {})
        options = platform.setdefault("adapterOptions", {})
        provider = adapters.pop("analytics", "@kb-labs/adapters-analytics-sqlite")
        options.pop("analytics", None)
        config_file.write_text(json.dumps(config, indent=2) + "\n")
        restart = ["kb-create", "restart", "--platform-root", str(platform_root), "--json"]
        try:
            restarted = _json(_run(runner, restart, project_a, base_env), restart)
            if restarted.get("ok") is not True:
                raise RuntimeError("could not restart the host with the missing persistent adapter binding")
            command = ["kb-create", "doctor", "--platform-root", str(platform_root), "--json"]
            result = runner(command, cwd=str(project_a), env=base_env,
                            capture_output=True, text=True, timeout=300)
            payload = _json(result, command)
            checks = payload.get("platform", {}).get("checks", [])
            finding = next((row for row in checks if isinstance(row, dict) and row.get("slot") == "analytics"), None)
            credentials_finding = any(
                isinstance(row, dict) and row.get("code") == "KB_ADAPTER_CREDENTIALS_MISSING"
                for row in payload.get("findings", [])
            )
            if result.returncode != 0 or payload.get("ok") is not True or payload.get("platform", {}).get("ok") is not True or not credentials_finding or not finding:
                raise RuntimeError("doctor did not accept the discovered SQLite analytics default")
            if finding.get("mode") != "real" or finding.get("implementation") != provider:
                raise RuntimeError("doctor did not report the manifest-discovered analytics provider")
            listed = rows_for(project_a)
            if listed["analytics"].get("implementation") != provider or listed["analytics"].get("mode") != "real":
                raise RuntimeError("kb adapter list did not show the discovered SQLite analytics provider")
            with closing(sqlite3.connect(analytics_db)) as database:
                event = database.execute(
                    "SELECT type, payload FROM events WHERE id = ?", ("restart-check",)
                ).fetchone()
            if event != ("journey.restart-check", "{\"check\":true}"):
                raise RuntimeError("the analytics database did not retain its readable event across restart")
        finally:
            config_file.write_bytes(original)
            _run(runner, restart, project_a, base_env)

    journey.step("an unbound analytics slot resolves its installed persistent default", "adapter",
                 assert_unbound_analytics_uses_manifest_default, cases=["S-054.10"])

    def assert_adapter_replacement_keeps_old_data() -> None:
        analytics_db = project_state / "analytics" / "analytics.sqlite"
        previous_data = analytics_db.read_bytes()
        replacement = "@kb-labs/adapters-analytics-file"
        install = kb_command([ "marketplace", "install", replacement, "--scope", "platform", "--json"])
        command = kb_command([ "adapter", "bind", "analytics", replacement, "--json"])
        sealed_platform_before = _platform_snapshot(platform_root)
        install_payload = _json(_run(runner, install, project_a, base_env), install)
        if install_payload.get("ok") is not True:
            raise RuntimeError("could not install the replacement analytics adapter")
        lock_path = active_platform_root(platform_root) / ".kb" / "marketplace.lock"
        try:
            lock = json.loads(lock_path.read_text())
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError("platform Marketplace lock is missing or invalid after adapter install") from error
        pin = lock.get("adapters", {}).get(replacement) if isinstance(lock, dict) else None
        if (not isinstance(pin, dict) or not isinstance(pin.get("version"), str)
                or not isinstance(pin.get("integrity"), str) or not pin["integrity"]):
            raise RuntimeError("platform Marketplace lock did not record the adapter's exact version and integrity")
        payload = _json(_run(runner, command, project_a, base_env), command)
        if payload.get("ok") is not True:
            raise RuntimeError("could not bind the replacement analytics adapter")
        listed = rows_for(project_a)
        if listed["analytics"].get("implementation") != replacement or listed["analytics"].get("mode") != "real":
            raise RuntimeError("adapter bind did not override the discovered analytics default")
        if analytics_db.read_bytes() != previous_data:
            raise RuntimeError("replacing analytics migrated or deleted the old SQLite database")
        if _platform_snapshot(platform_root) != sealed_platform_before:
            raise RuntimeError("adapter install changed the platform receipt or installed package versions")

    journey.step("platform adapter replacement leaves the old adapter data on disk", "adapter",
                 assert_adapter_replacement_keeps_old_data, cases=["S-054.11"])

    def assert_marketplace_requires_kb_create_pins() -> None:
        workspace_file = platform_content_root / "pnpm-workspace.yaml"
        receipt_file = active_platform_root(platform_root) / ".kb" / "v2" / "receipt.json"
        package_file = platform_content_root / "package.json"
        original_workspace = workspace_file.read_bytes()
        original_package = package_file.read_bytes()
        receipt = json.loads(receipt_file.read_text())
        artifacts = receipt.get("plan", {}).get("artifacts", [])
        sealed = next(((item.get("package"), item.get("sha256")) for item in artifacts
                       if isinstance(item, dict) and item.get("kind") != "binary"
                       and isinstance(item.get("package"), str) and isinstance(item.get("sha256"), str)
                       and isinstance(item.get("tarball"), str) and item.get("tarball")), None)
        if sealed is None:
            raise RuntimeError("the installed platform receipt contains no sealed package artifacts to check")
        name, _ = sealed
        text = original_workspace.decode("utf-8")
        override_line = re.compile(rf"(?m)^  (?:{re.escape(json.dumps(name))}|'{re.escape(name)}'|{re.escape(name)}):.*(?:\n|$)")
        without_pin, count = override_line.subn("", text, count=1)
        if count != 1:
            raise RuntimeError(f"kb-create did not write an override for sealed artifact {name}")
        before = _platform_snapshot(platform_root)
        workspace_file.write_text(without_pin)
        before_missing_pins = workspace_file.read_bytes()
        command = kb_command([ "marketplace", "install", "@kb-labs/adapters-analytics-file", "--scope", "platform", "--json"])
        try:
            result = runner(command, cwd=str(project_a), env=base_env,
                            capture_output=True, text=True, timeout=300)
            try:
                payload = read_ux_cli_result(result)
            except (json.JSONDecodeError, ValueError) as error:
                raise RuntimeError("marketplace did not return JSON for a platform missing sealed artifact pins") from error
            failure = decode_ux_error_result(payload)
            hint = failure.get("hint", "") if isinstance(failure, dict) else ""
            expected_hint_prefix = f'Run "kb-create update --platform-root {platform_root}" and retry "kb marketplace install @kb-labs/adapters-analytics-file@'
            if (result.returncode == 0 or not isinstance(failure, dict)
                    or failure.get("code") != "KB_MARKETPLACE_PLATFORM_ARTIFACT_PINS_MISSING"
                    or failure.get("message") != "The installed platform is missing kb-create's sealed artifact overrides. No package was installed."
                    or not hint.startswith(expected_hint_prefix)
                    or not hint.endswith(' --scope platform".')):
                raise RuntimeError("marketplace did not return the typed kb-create update hint for missing sealed artifact pins")
            if _platform_snapshot(platform_root) != before:
                raise RuntimeError("rejected adapter install changed the platform receipt or package versions")
            if workspace_file.read_bytes() != before_missing_pins or package_file.read_bytes() != original_package:
                raise RuntimeError("rejected adapter install changed the platform package manifest or pnpm config")
        finally:
            workspace_file.write_bytes(original_workspace)

    journey.step("marketplace install refuses a platform missing kb-create artifact pins", "adapter",
                 assert_marketplace_requires_kb_create_pins, cases=["S-054.14"])

    def assert_stopped_host_doctor() -> None:
        stop = ["kb-create", "stop", "--platform-root", str(platform_root), "--json"]
        start = ["kb-create", "start", "--platform-root", str(platform_root), "--json"]
        stopped = False
        try:
            stop_result = _run(runner, stop, project_a, base_env)
            stopped = _json(stop_result, stop).get("ok") is True
            if not stopped:
                raise RuntimeError("could not stop the installed host for stopped-host diagnostics")
            for command in (
                ["kb-create", "doctor", "--platform-root", str(platform_root), "--json"],
                ["kb-create", "doctor", "--platform-root", str(platform_root)],
            ):
                result = runner(command, cwd=str(project_a), env=base_env,
                                capture_output=True, text=True, timeout=300)
                if command[-1] == "--json":
                    payload = _json(result, command)
                    if (result.returncode != 0 or payload.get("operation") != "doctor"
                            or payload.get("status") != "unhealthy"):
                        raise RuntimeError("stopped-host doctor did not return an exit-0 unhealthy diagnosis")
                    checks = payload.get("platform", {}).get("checks", [])
                    adapter_check = next((item for item in checks if isinstance(item, dict) and item.get("id") == "adapters"), None)
                    if (not adapter_check or "cannot be checked" not in adapter_check.get("detail", "")
                            or _parse_run_hint(adapter_check.get("hint", "")) != [
                                "kb-create", "start", "--platform-root", str(platform_root),
                            ]):
                        raise RuntimeError("stopped-host JSON does not explain missing adapter status and exact start command")
                elif (result.returncode != 0 or "cannot be checked" not in result.stdout
                      or _next_shell_command(result.stdout) != [
                          "kb-create", "start", "--platform-root", str(platform_root),
                      ]):
                    raise RuntimeError("stopped-host text output omits the adapter limitation or exact start command")
        finally:
            if stopped:
                _run(runner, start, project_a, base_env)

    journey.step("doctor explains adapter status when host is stopped", "adapter",
                 assert_stopped_host_doctor, cases=["S-054.7"])

    journey.step("run project workflow through default storage", "workflow",
                 lambda: _save_run(run_workflow, project_a), cases=["S-054.3"])
    journey.step("confirm defaults have no network requirement", "adapter",
                 lambda: _assert_no_network_defaults(rows_for(project_a), assert_doctor), cases=["S-054.4"])

    journey.step("implicit OpenAI reports missing credentials on use", "adapter",
                 lambda: _assert_missing_llm(runner, base_env, project_a, cli), cases=["S-054.5", "S-051.5"])
    journey.step("implicit OpenAI list and doctor report its missing key", "adapter",
                 lambda: _assert_missing_openai_key(runner, base_env, project_a, platform_root, cli), cases=["S-054.8"])
    journey.step("implicit OpenAI embeddings report missing credentials on use", "adapter",
                 lambda: _assert_missing_embeddings(runner, base_env, project_a, platform_root, cli, rows_for),
                 cases=["S-054.24"])
    journey.step("SQLite vector default persists through host restart", "adapter",
                 lambda: _assert_vector_store_restart(runner, base_env, project_a, platform_root, cli, rows_for),
                 cases=["S-054.25"])
    def assert_missing_vector_store() -> None:
        install = ["marketplace", "install", "@kb-labs/mind", "--scope", "platform", "--json"]
        project_before = _repository_tree(project_a)
        if _json(cli(install), install).get("ok") is not True:
            raise RuntimeError("could not install the Mind plugin required by the vector-store adapter case")
        if _repository_tree(project_a) != project_before:
            raise RuntimeError("platform-scope Mind installation changed the registered project repository")
        _assert_missing_vector_store(runner, base_env, project_a, platform_root)
    journey.step("missing vector store returns a typed bind hint", "adapter",
                 assert_missing_vector_store, cases=["S-054.6"])

    try:
        add = ["project", "add", str(project_b), "--json"]
        project_b_baseline = _repository_tree(project_b)
        if _json(cli(add), add).get("ok") is not True:
            raise RuntimeError("could not register project B for adapter isolation check")
        if _repository_tree(project_b) != project_b_baseline:
            raise RuntimeError("project add changed the repository being registered for adapter isolation")
        project_b_registered = True
        registered_project_roots.add(project_b.resolve())

        def bind_platform_adapter() -> None:
            command = ["adapter", "bind", "storage", "@kb-labs/adapters-fs", "--json"]
            if _json(cli(command, platform_root), command).get("ok") is not True:
                raise RuntimeError("could not bind the filesystem adapter at platform scope")
            if config(active_platform_root(platform_root)).get("platform", {}).get("adapters", {}).get("storage") != "@kb-labs/adapters-fs":
                raise RuntimeError("platform config does not contain the storage binding")
            for project in (project_a, project_b):
                project_config = config(project)
                if "adapters" in project_config.get("platform", {}):
                    raise RuntimeError(f"project {project} contains adapter configuration")
                if rows_for(project).get("storage", {}).get("implementation") != "@kb-labs/adapters-fs":
                    raise RuntimeError(f"project {project} did not resolve the platform adapter")
        journey.step("bind the platform storage adapter", "adapter", bind_platform_adapter, cases=["S-048.1"])

        def set_platform_options() -> None:
            command = ["config", "set", "--scope", "platform", "platform.adapterOptions.storage", '{"baseDir":"storage"}', "--json"]
            if _json(cli(command, platform_root), command).get("ok") is not True:
                raise RuntimeError("could not set platform storage options")
            for project in (project_a, project_b):
                expected_base = Path(os.path.realpath(platform_content_root / ".kb" / "data")) / "storage"
                if rows_for(project).get("storage", {}).get("baseDir") != str(expected_base):
                    raise RuntimeError(f"project {project} did not use the platform storage options")
        journey.step("configure platform storage options", "adapter", set_platform_options,
                     cases=["S-048.2"], requires=("step:bind the platform storage adapter",))

        def reject_project_adapter_config() -> None:
            for key in ("platform.adapters.storage", "adapters.storage"):
                command = ["config", "set", "--scope", "project", key, "@kb-labs/adapters-fs", "--json"]
                result = runner(kb_command(command), cwd=str(project_a), env=base_env,
                                capture_output=True, text=True, timeout=300)
                payload = _json(result, command)
                error = payload.get("error")
                if result.returncode == 0 or not isinstance(error, dict) or error.get("code") != "KB_ADAPTER_PROJECT_SCOPE":
                    raise RuntimeError("project adapter config did not return KB_ADAPTER_PROJECT_SCOPE")
                if "platform config" not in str(error.get("hint", "")):
                    raise RuntimeError("project adapter scope error did not point to platform config")
        journey.step("reject project adapter configuration", "adapter", reject_project_adapter_config,
                     cases=["S-048.3"], requires=("step:configure platform storage options",))

        def attach_project_plugin() -> None:
            command = ["marketplace", "install", "@kb-labs/commit", "--scope", "project", "--json"]
            if _json(cli(command, project_a), command).get("ok") is not True:
                raise RuntimeError("could not attach a plugin to project A")
            for project, expected in ((project_a, True), (project_b, False)):
                plugins = ["marketplace", "plugins", "list", "--json"]
                result = _json(cli(plugins, project), plugins)
                contains = "@kb-labs/commit" in json.dumps(result)
                if contains is not expected:
                    raise RuntimeError(f"project {project} plugin attachment isolation is incorrect")
                if rows_for(project).get("storage", {}).get("implementation") != "@kb-labs/adapters-fs":
                    raise RuntimeError(f"project {project} adapter binding changed after plugin attachment")
        journey.step("attach a plugin to project A only", "plugin", attach_project_plugin,
                     cases=["S-048.4"], requires=("step:reject project adapter configuration",))

        def assert_platform_data_root_isolated() -> None:
            for option, value in (
                ("platform.adapterOptions.documentDatabase", {"filename": "database/kb.sqlite"}),
                ("platform.adapterOptions.analytics", {"dbPath": "analytics/analytics.sqlite"}),
            ):
                command = ["config", "set", "--scope", "platform", option, json.dumps(value), "--json"]
                if _json(cli(command, platform_root), command).get("ok") is not True:
                    raise RuntimeError(f"could not configure platform data path {option}")

            baseline = _repository_tree(project_a)
            for command in (["adapter", "list", "--json"], ["commit", "plan", "delete", "--json"]):
                result = cli(list(command), project_a)
                payload = _json(result, list(command))
                if result.returncode != 0 or payload.get("ok") is not True:
                    raise RuntimeError(f"project command {' '.join(command)} failed while checking platform data isolation")
                if _repository_tree(project_a) != baseline:
                    raise RuntimeError(f"{' '.join(command)} changed the registered project repository")

            data_root = Path(os.path.realpath(platform_content_root / ".kb" / "data"))
            for relative in ("database/kb.sqlite", "analytics/analytics.sqlite"):
                if not (data_root / relative).is_file():
                    raise RuntimeError(f"platform adapter output is missing under {data_root}: {relative}")

        journey.step("platform adapter data paths leave registered project unchanged", "adapter",
                     assert_platform_data_root_isolated, cases=["S-054.21"])
        if journey.steps[-1].status != "PASS":
            return

        def reject_invalid_platform_data_path() -> None:
            baseline = _repository_tree(project_a)
            for invalid_path, corrected in ((".kb/database/kb.sqlite", "database/kb.sqlite"),
                                            ("../outside.sqlite", "outside.sqlite")):
                command = ["config", "set", "--scope", "platform", "platform.adapterOptions.documentDatabase",
                           json.dumps({"filename": invalid_path}), "--json"]
                if _json(cli(command, platform_root), command).get("ok") is not True:
                    raise RuntimeError("could not set the invalid platform data path for validation")
                probe = ["adapter", "list", "--json"]
                result = runner(kb_command([ *probe]), cwd=str(project_a), env=base_env,
                                capture_output=True, text=True, timeout=300)
                payload = _json(result, probe)
                error = payload.get("error")
                if result.returncode == 0 or not isinstance(error, dict) or error.get("code") != "KB_CONFIG_INVALID":
                    raise RuntimeError("invalid platform data path did not return KB_CONFIG_INVALID")
                if corrected not in str(error.get("hint", "")):
                    raise RuntimeError("platform path error hint omitted its corrected value")
                if _repository_tree(project_a) != baseline:
                    raise RuntimeError("invalid platform data path changed the registered project repository")
            restore = ["config", "set", "--scope", "platform", "platform.adapterOptions.documentDatabase",
                       json.dumps({"filename": "database/kb.sqlite"}), "--json"]
            if _json(cli(restore, platform_root), restore).get("ok") is not True:
                raise RuntimeError("could not restore the valid platform database path")

        journey.step("reject platform adapter paths outside the data root", "adapter",
                     reject_invalid_platform_data_path, cases=["S-054.22"])
        if journey.steps[-1].status != "PASS":
            return

        def verify_project_configs() -> None:
            for project in (project_a, project_b):
                project_config = config(project)
                value = project_config.get("platform", {})
                if ("adapters" in value or "adapterOptions" in value or
                        "adapters" in project_config or "adapterOptions" in project_config):
                    raise RuntimeError(f"project {project} contains platform adapter settings")
        journey.step("verify adapter settings are absent from project configs", "adapter",
                     verify_project_configs, cases=["S-048.5"],
                     requires=("step:reject project adapter configuration",))

        def unbind_platform_storage_and_restore_default() -> None:
            command = ["adapter", "unbind", "storage", "--json"]
            if _json(cli(command, platform_root), command).get("ok") is not True:
                raise RuntimeError("could not unbind platform storage")
            platform_config = config(active_platform_root(platform_root)).get("platform", {})
            if "storage" in platform_config.get("adapters", {}) or "storage" in platform_config.get("adapterOptions", {}):
                raise RuntimeError("platform storage binding or options remain after unbind")
            row = rows_for(project_a).get("storage")
            default_base = project_state / "storage"
            if (not row or row.get("implementation") != "@kb-labs/adapters-fs" or
                    row.get("baseDir") != str(default_base)):
                raise RuntimeError("project did not resolve the built-in filesystem default after unbind")
            _, record, _ = run_workflow(project_a)
            if record.parent != default_base / "workflows" or not record.name.endswith(".json"):
                raise RuntimeError("workflow record was not written under the built-in storage default")
        journey.step("unbind platform storage and restore the built-in default", "adapter",
                     unbind_platform_storage_and_restore_default, cases=["S-048.6"])

        def platform_scope_works_without_project_registration() -> None:
            registry_file = Path(base_env["HOME"]) / ".kb" / "projects.json"
            registry_before = registry_file.read_bytes()
            commands = (
                ["adapter", "list", "--json"],
                ["adapter", "bind", "storage", "@kb-labs/adapters-fs", "--json"],
                ["config", "set", "--scope", "platform", "platform.adapterOptions.storage",
                 '{"baseDir":"storage"}', "--json"],
                ["config", "get", "--scope", "platform", "platform.adapterOptions.storage", "--json"],
                ["adapter", "unbind", "storage", "--json"],
            )
            results = []
            for command in commands:
                result = runner(kb_command(command), cwd=str(platform_root), env=base_env,
                                capture_output=True, text=True, timeout=300)
                payload = _json(result, command)
                if result.returncode != 0 or payload.get("ok") is not True:
                    raise RuntimeError(f"platform-scoped command failed outside registered projects: {' '.join(command)}")
                results.append(payload)
            if results[2].get("file") != str(platform_config_path):
                raise RuntimeError(
                    "platform config set did not name the installed platform config file: "
                    f"got {results[2]!r}, expected {str(platform_config_path)!r}"
                )
            if results[3].get("value") != {"baseDir": "storage"}:
                raise RuntimeError("platform config get did not read the value written outside registered projects")
            if registry_file.read_bytes() != registry_before:
                raise RuntimeError("platform-scoped commands changed project registration")

        journey.step("platform scope works outside registered projects", "adapter",
                     platform_scope_works_without_project_registration, cases=["S-048.7"])
    except Exception as error:
        journey.step("project adapter and plugin isolation checks", "adapter", lambda: str(error))
    finally:
        cleanup_errors: list[str] = []
        restore_error = _restore_platform_adapter_fixture(
            platform_config_path, original_platform_config, project_a, platform_root, base_env, runner,
        )
        if restore_error:
            cleanup_errors.append(restore_error)
        if project_b_registered:
            try:
                command = ["project", "remove", str(project_b), "--yes", "--json"]
                result = cli(command)
                if result.returncode != 0:
                    cleanup_errors.append(f"project B could not be unregistered: {(result.stderr or result.stdout).strip()}")
            except Exception as error:
                cleanup_errors.append(f"project B could not be unregistered: {error}")
        if project_b.exists():
            try:
                shutil.rmtree(project_b)
            except OSError as error:
                cleanup_errors.append(f"adapter project B fixture could not be removed: {error}")
        message = "; ".join(cleanup_errors) if cleanup_errors else None
        journey.step("restore adapter journey fixture state", "adapter", lambda: message, role="lifecycle")


def _save_run(run_workflow, project):
    result = run_workflow(project)
    if result[2].get("status", "").lower() != "success":
        raise RuntimeError("default workflow record is not successful")
    return None


def _assert_no_network_defaults(rows: dict[str, dict], assert_doctor) -> None:
    if any(row.get("networkRequired") is not False for row in rows.values()
           if row.get("mode") != "unknown" and not row.get("requiresConfiguration")
           and row.get("credentialsStatus") != "missing"):
        raise RuntimeError("a built-in default reports a network dependency")
    if rows.get("llm", {}).get("networkRequired") is not True:
        raise RuntimeError("the OpenAI LLM default does not report its external network requirement")
    assert_doctor()


def _next_shell_command(output: str) -> list[str]:
    marker = "Next: Run `"
    start = output.find(marker)
    if start < 0:
        return []
    hint_start = start + len("Next: ")
    hint_end = output.find("\n", hint_start)
    if hint_end < 0:
        hint_end = len(output)
    return _parse_run_hint(output[hint_start:hint_end])


def _parse_run_hint(hint: str) -> list[str]:
    prefix = "Run `"
    if not hint.startswith(prefix) or not hint.endswith("`."):
        return []
    return _parse_shell_command(hint[len(prefix):-2])


def _parse_shell_command(command: str) -> list[str]:
    return shlex.split(command)


def _assert_missing_llm(runner: CommandRunner, env: dict[str, str], project: Path, cli) -> None:
    config_path = project / ".kb" / "kb.config.json"
    original_config = config_path.read_bytes() if config_path.exists() else None
    tracked = runner(
        ["git", "ls-files", "-z"], cwd=str(project), env=env,
        capture_output=True, text=False, timeout=30,
    )
    if tracked.returncode != 0:
        raise RuntimeError("could not locate a tracked file for the LLM-dependent commit flow")
    candidates = [project / item.decode() for item in tracked.stdout.split(b"\0") if item]
    target = next((item for item in candidates if item.is_file() and item.suffix in {".md", ".txt"}), None)
    if target is None:
        raise RuntimeError("the project has no tracked text file to exercise commit generation")
    original_file = target.read_bytes()
    try:
        target.write_bytes(original_file + b"\n<!-- adapter-default-case -->\n")
        command = ["commit", "plan", "create", "--json"]
        result = runner(kb_command(command), cwd=str(project), env=env, capture_output=True, text=True, timeout=300)
        payload = _json(result, command)
        error = payload.get("error")
        if result.returncode == 0 or not isinstance(error, dict) or error.get("code") != "KB_ADAPTER_CREDENTIALS_MISSING":
            raise RuntimeError("implicit OpenAI LLM did not return KB_ADAPTER_CREDENTIALS_MISSING without a key")
        if not error.get("correlationId") or not error.get("hint") or error.get("retryable") is not False:
            raise RuntimeError("missing-credential platform error lost its envelope fields in the plugin handler")
    finally:
        target.write_bytes(original_file)
        if original_config is None:
            config_path.unlink(missing_ok=True)
        else:
            config_path.write_bytes(original_config)


def _assert_missing_openai_key(runner: CommandRunner, env: dict[str, str], project: Path, platform_root: Path, cli) -> None:
    rows_command = ["adapter", "list", "--json"]
    rows = _json(cli(rows_command), rows_command).get("adapters", [])
    llm = next((row for row in rows if isinstance(row, dict) and row.get("slot") == "llm"), None)
    if not isinstance(llm, dict) or llm.get("implementation") != "@kb-labs/adapters-openai" or llm.get("credentialsStatus") != "missing":
        raise RuntimeError("adapter list does not report the implicit OpenAI provider's missing credentials")
    command = ["commit", "plan", "create", "--json"]
    result = runner(kb_command([ *command]), cwd=str(project), env=env, capture_output=True, text=True, timeout=300)
    if result.returncode == 0:
        raise RuntimeError("bound OpenAI LLM unexpectedly generated a commit plan without an API key")
    payload = _json(result, command)
    error = payload.get("error")
    if not isinstance(error, dict) or error.get("code") != "KB_ADAPTER_CREDENTIALS_MISSING":
        raise RuntimeError("bound OpenAI LLM did not return KB_ADAPTER_CREDENTIALS_MISSING")
    message = str(error.get("message", ""))
    hint = str(error.get("hint", ""))
    expected_command = "kb config set --scope platform platform.adapterOptions.llm.apiKey '${OPENAI_API_KEY}' --allow-missing-env"
    if "OPENAI_API_KEY" not in message or expected_command not in hint or "No request was sent" not in hint:
        raise RuntimeError("missing-key error does not identify the key, setup command, and no-send guarantee")
    doctor_command = ["kb-create", "doctor", "--platform-root", str(platform_root), "--json"]
    doctor_result = runner(doctor_command, cwd=str(project), env=env, capture_output=True, text=True, timeout=300)
    doctor = _json(doctor_result, doctor_command)
    findings = doctor.get("findings")
    if not isinstance(findings, list) or not any(
        isinstance(row, dict) and row.get("code") == "KB_ADAPTER_CREDENTIALS_MISSING" and row.get("path") == "/platform/adapterOptions/llm/apiKey"
        for row in findings
    ):
        raise RuntimeError("kb-create doctor does not report the missing OpenAI API key")


def _assert_missing_vector_store(
    runner: CommandRunner,
    env: dict[str, str],
    project: Path,
    platform_root: Path,
) -> None:
    token = env.get("KB_JOURNEY_SERVICE_TOKEN")
    if not token:
        raise RuntimeError("installed journey has no service token for the platform adapter API")
    gateway = _installed_gateway_url(runner, env, project, platform_root)
    _platform_adapter_call(env, token, gateway, "upsert", [[{
        "id": "s054-vector-default-probe",
        "vector": [0, 1],
        "metadata": {"case": "S-054.6"},
    }], "default"])
    command = kb_command(["mind", "search", "--text", "adapter defaults", "--json"])
    result = runner(command, cwd=str(project), env=env, capture_output=True, text=True, timeout=300)
    try:
        error = decode_ux_error_result(read_ux_cli_result(result))
    except (json.JSONDecodeError, ValueError) as failure:
        raise RuntimeError("Mind search did not return the expected typed embeddings error") from failure
    details = error.get("details")
    if (result.returncode == 0 or error.get("code") != "KB_ADAPTER_CREDENTIALS_MISSING"
            or not isinstance(details, dict) or details.get("service") != "embeddings"):
        raise RuntimeError("Mind search did not reach the implicit embeddings provider")
    output = f"{result.stdout}\n{result.stderr}".lower()
    if ("traceback" in output or "goroutine " in output or "panic:" in output
            or "stack trace" in output or "\n    at " in output):
        raise RuntimeError("Mind search printed a stack trace for the missing embeddings credential")


def _assert_missing_embeddings(
    runner: CommandRunner,
    env: dict[str, str],
    project: Path,
    platform_root: Path,
    cli,
    rows_for,
) -> None:
    install = ["marketplace", "install", "@kb-labs/mind", "--scope", "platform", "--json"]
    if _json(cli(install), install).get("ok") is not True:
        raise RuntimeError("could not install the Mind plugin required to exercise embeddings")
    embeddings = rows_for(project).get("embeddings")
    if (not embeddings or embeddings.get("implementation") != "@kb-labs/adapters-openai/embeddings"
            or embeddings.get("credentialsStatus") != "missing"
            or embeddings.get("missingCredentials") != ["OPENAI_API_KEY"]):
        raise RuntimeError("adapter list did not report the implicit embeddings provider's missing key")
    token = env.get("KB_JOURNEY_SERVICE_TOKEN")
    if not token:
        raise RuntimeError("installed journey has no service token for the platform adapter API")
    gateway = _installed_gateway_url(runner, env, project, platform_root)
    _platform_adapter_call(env, token, gateway, "upsert", [[{
        "id": "s054-embeddings-credential-probe",
        "vector": [1, 0],
        "metadata": {"case": "S-054.24"},
    }], "default"])
    command = ["mind", "search", "--text", "adapter defaults", "--json"]
    result = runner(kb_command(command), cwd=str(project), env=env,
                    capture_output=True, text=True, timeout=300)
    try:
        error = decode_ux_error_result(read_ux_cli_result(result))
    except (json.JSONDecodeError, ValueError) as failure:
        raise RuntimeError("Mind search did not return the embeddings credential error envelope") from failure
    expected_command = "kb config set --scope platform platform.adapterOptions.embeddings.apiKey '${OPENAI_API_KEY}' --allow-missing-env"
    details = error.get("details")
    actions = error.get("actions")
    action = actions[0] if isinstance(actions, list) and actions else {}
    if (result.returncode == 0 or error.get("code") != "KB_ADAPTER_CREDENTIALS_MISSING"
            or not isinstance(details, dict) or details.get("credential") != "OPENAI_API_KEY"
            or details.get("service") != "embeddings" or details.get("command") != expected_command
            or not isinstance(action, dict) or action.get("command") != expected_command
            or "No request was sent" not in str(error.get("hint", ""))
            or "trace" in result.stdout.lower()):
        raise RuntimeError("Mind search did not report the typed, actionable missing embeddings credential")


def _installed_gateway_url(
    runner: CommandRunner,
    env: dict[str, str],
    project: Path,
    platform_root: Path,
) -> str:
    command = ["kb-create", "status", "--platform-root", str(platform_root), "--json"]
    status = _json(_run(runner, command, project, env), command)
    health_url = status.get("host", {}).get("healthUrl")
    if not isinstance(health_url, str) or not health_url:
        raise RuntimeError("installed host status returned no health URL for platform adapter API calls")
    return health_url.rsplit("/", 1)[0]


def _platform_adapter_call(
    env: dict[str, str],
    token: str,
    gateway_url: str,
    method: str,
    args: list[object],
) -> object:
    request = urllib.request.Request(
        f"{gateway_url}/platform/v1/vectorStore/{method}",
        data=json.dumps({"args": args}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    status, body, _ = open_http(urllib.request.urlopen, request, timeout=30, env=env)
    try:
        envelope = read_ux_http_result(body, status)
        data = decode_ux_success_result(envelope)
    except ValueError as failure:
        raise RuntimeError(f"vectorStore/{method} returned an invalid platform result") from failure
    if status != 200:
        raise RuntimeError(f"vectorStore/{method} returned HTTP {status}")
    return data


def _assert_vector_store_restart(
    runner: CommandRunner,
    env: dict[str, str],
    project: Path,
    platform_root: Path,
    cli,
    rows_for,
) -> None:
    rows = rows_for(project)
    vector_store = rows.get("vectorStore")
    if not vector_store or vector_store.get("implementation") != "@kb-labs/adapters-sqlite/vector-store":
        raise RuntimeError("adapter list did not report the SQLite vector-store default")
    token = env.get("KB_JOURNEY_SERVICE_TOKEN")
    if not token:
        raise RuntimeError("installed journey has no service token for the platform adapter API")

    record = {"id": "s054-vector-restart", "vector": [1, 0],
              "metadata": {"case": "S-054.25", "text": "persistent vector"}}

    project_before = _repository_tree(project)
    gateway = _installed_gateway_url(runner, env, project, platform_root)
    _platform_adapter_call(env, token, gateway, "upsert", [[record], "s054-project"])
    vector_database = _project_state_dir(project, env) / "vector-store" / "vectors.sqlite"
    if not vector_database.is_file():
        raise RuntimeError("SQLite vector store did not create its database beneath the registered project's durable state")
    restart = ["kb-create", "restart", "--platform-root", str(platform_root)]
    _run(runner, restart, project, env)
    results = _platform_adapter_call(
        env, token, _installed_gateway_url(runner, env, project, platform_root),
        "search", [[1, 0], 1, None, "s054-project"],
    )
    if (not isinstance(results, list) or len(results) != 1
            or results[0].get("id") != record["id"]
            or results[0].get("metadata") != record["metadata"]
            or results[0].get("score") != 1):
        raise RuntimeError("SQLite vector-store search did not return the original record after host restart")
    if _repository_tree(project) != project_before:
        raise RuntimeError("using the installed vector-store default changed the registered project repository")


def _assert_records(run_a, run_b, project_a: Path, project_b: Path) -> None:
    _assert_record_under(run_a, project_a / ".kb" / "data")
    _assert_record_under(run_b, project_b / ".kb" / "data")


def _assert_record_under(run, expected_root: Path) -> None:
    if not run[1].is_relative_to(expected_root):
        raise RuntimeError(f"workflow record is not under the expected storage root {expected_root}: {run[1]}")
