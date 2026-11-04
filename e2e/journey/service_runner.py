#!/usr/bin/env python3
"""Probe fresh-install service capabilities and emit machine-readable results."""
from __future__ import annotations

from mcp_tool_names import DEFAULT_ENABLED_SERVICES, commit_tool, service_family_tool_names, service_tool_names

from kb_invocation import kb_command
from installed_fixture import layout_relative, layout_value
from journey_values import MissingJourneyState, journey_value

from project_service_path import project_service_path
from journey_resources import resource_root

import argparse
from contextlib import ExitStack
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import shutil
import tempfile
import traceback
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from urllib.request import build_opener, HTTPCookieProcessor

from service_steps import FlowGraph, Journey, JourneyResult
from select_from_cases import journey_source_group_declaration
from journey_dependencies import Dependency
from invocations import (
    CalledProcessError,
    CompletedProcess,
    decode_ux_error_result,
    decode_ux_success_result,
    export_project_identity_to_child_environment,
    open_http,
    print_report_text,
    read_ux_cli_result,
    read_ux_http_result,
    run_command,
    run_with_runner,
    store_report_secret,
    write_report_json,
    write_report_text,
)
from plugin_author_steps import run_plugin_author_flow
from marketplace_steps import (prepare_commit_project_fixture, prepare_registry_commit_project_fixture,
                               run_marketplace_steps, run_ordered_source_journey_steps)
from marketplace_steps import _registry_version, _output
from dispatch_registry import MARKETPLACE_REGISTRY_LANE, lane_for_runner
from adapter_defaults_steps import _config_difference_keys, run_adapter_default_steps
from analytics_steps import run_analytics_steps
from gateway_steps import run_adapter_catalog_step, run_gateway_steps
from installed_cli_contract_steps import run_installed_cli_contract_steps
from worktree_steps import run_worktree_steps
from project_identity_steps import (run_project_identity_steps, run_project_registration_case_steps,
                                    run_project_registry_corruption_case_step, run_project_registry_steps)
from workspace_steps import run_workspace_cli_steps, workspace_checkout_problem
from plugin_isolation_steps import run_project_plugin_availability_steps
from unexpected_error_steps import run_unexpected_error_steps
from mcp_project_steps import (
    apply_commit_plan,
    commit_tool_schema,
    invalid_arguments,
    local_auth,
    mcp_ux_result_contract,
    opaque_host_credential_mcp_rejection,
    project_isolation,
    project_plugin_catalog_isolation,
    project_readonly_tool_isolation,
    run_agent_session_steps,
    secured_auth,
    secured_project_catalog_isolation,
    unknown_tool,
)
from platform_state_dump import archive_service_logs
from journey_resources import journey_module, active_platform_root


BASE_URL = journey_value("KB_JOURNEY_BASE_URL", "http://127.0.0.1:4000").rstrip("/")
ADMIN_EMAIL = journey_value("KB_JOURNEY_ADMIN_EMAIL", "admin@example.com")
ADMIN_PASSWORD = journey_value("KB_JOURNEY_ADMIN_PASSWORD", "")
HTTP = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))


def repository_git_status(project: Path) -> str | None:
    result = run_command(
        ["git", "status", "--porcelain", "--untracked-files=all"], cwd=project,
        capture_output=True, text=True, check=False, timeout=30,
    )
    if result.returncode != 0:
        return None
    return result.stdout


def _adapter_defaults_probe_error(journey: Journey, snapshot: dict[str, object],
                                  platform_root: Path) -> str | None:
    cleanup = next((step for step in reversed(journey.steps)
                    if step.name == "restore adapter journey fixture state"), None)
    if cleanup is None:
        flow = next((step for step in reversed(journey.steps)
                     if step.name == "adapter defaults flow"), None)
        if flow is not None and flow.status != "PASS":
            return f"BLOCKED: adapter defaults cleanup did not run because {flow.name} ended {flow.status}: {flow.message}"
        return "BLOCKED: adapter defaults flow did not run; platform fixture state was not changed"
    if cleanup.status != "PASS":
        return f"adapter fixture cleanup ended {cleanup.status}: {cleanup.message}"
    snapshot_path = snapshot.get("path")
    original_contents = snapshot.get("contents")
    if not isinstance(snapshot_path, Path) or (original_contents is not None and not isinstance(original_contents, bytes)):
        return "adapter defaults flow did not capture the original platform config"
    restored_contents = snapshot_path.read_bytes() if snapshot_path.is_file() else None
    changed_keys = _config_difference_keys(original_contents, restored_contents)
    if changed_keys:
        return "platform adapter config differs from its snapshot at keys: " + ", ".join(changed_keys)
    config_path = active_platform_root(platform_root) / ".kb" / "kb.config.jsonc"
    if not config_path.is_file():
        config_path = active_platform_root(platform_root) / ".kb" / "kb.config.json"
    try:
        value = json.loads(config_path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        return f"platform adapter config is missing or unreadable after the adapter journey: {error}"
    platform_config = value.get("platform", {})
    if not isinstance(platform_config, dict):
        return "restored platform adapter config has no platform object"
    return None


def project_plugin_settings_isolation(service_token: str) -> str | None:
    """Prove a CLI project override changes only its registered project."""
    cli = journey_value("KB_JOURNEY_CLI_PATH", "")
    if not cli or not Path(cli).is_file():
        return "BLOCKED: provide KB_JOURNEY_CLI_PATH for project settings checks"

    def run_cli(cwd: Path, *args: str) -> CompletedProcess[str]:
        return run_command(
            kb_command([ *args], executable=cli), cwd=cwd, env=os.environ.copy(), capture_output=True,
            text=True, check=False, timeout=90,
        )

    def project_id(result: CompletedProcess[str]) -> str:
        try:
            payload = decode_ux_success_result(read_ux_cli_result(result))
        except (json.JSONDecodeError, ValueError):
            return ""
        queue = [payload]
        while queue:
            item = queue.pop(0)
            if isinstance(item, dict):
                project = item.get("project")
                if isinstance(project, dict) and isinstance(project.get("id"), str):
                    return project["id"]
                queue.extend(item.values())
            elif isinstance(item, list):
                queue.extend(item)
        return ""

    def remove_project(project: Path, identifier: str) -> None:
        run_cli(project, "project", "remove", identifier, "--yes", "--json")

    with tempfile.TemporaryDirectory(prefix="kb-project-plugin-settings-") as temp, ExitStack() as cleanup:
        root = Path(temp)
        projects = [root / "project-a", root / "project-b"]
        ids: list[str] = []
        repository_baselines: dict[Path, str] = {}
        for project in projects:
            project.mkdir()
            initialized = run_command(
                ["git", "init", "--quiet", str(project)], capture_output=True,
                text=True, check=False, timeout=30,
            )
            if initialized.returncode != 0:
                return f"could not initialize disposable settings fixture: {initialized.stderr.strip()}"
            status = repository_git_status(project)
            if status is None:
                return f"could not capture the clean {project.name} repository tree"
            repository_baselines[project] = status
            registered = run_cli(project, "project", "add", str(project), "--json")
            if registered.returncode != 0:
                return f"kb project add failed for {project.name}: {(registered.stderr or registered.stdout).strip()}"
            identifier = project_id(registered)
            if not identifier:
                return f"kb project add returned no project ID for {project.name}"
            ids.append(identifier)
            cleanup.callback(remove_project, project, identifier)
            commit_install = install_project_commit_plugin(str(project), cli, os.environ)
            if commit_install.returncode != 0:
                return f"could not install Commit in {project.name}: {(commit_install.stderr or commit_install.stdout).strip()}"

        scopes = '[{"id":"journey-shared","label":"Shared","path":"."}]'
        manifest_default = run_cli(projects[0], "config", "get", "plugins.commit.llm.maxTokens", "--json")
        try:
            default_payload = decode_ux_success_result(
                read_ux_cli_result(manifest_default))
        except (json.JSONDecodeError, ValueError):
            return "config get did not return JSON for the manifest default"
        if (manifest_default.returncode != 0 or not isinstance(default_payload, dict)
                or default_payload.get("value") != 2000 or default_payload.get("layer") != "manifest"):
            return "config get did not return the Commit manifest default with manifest provenance"
        platform_tokens = run_cli(projects[0], "config", "set", "--scope", "platform",
                                  "plugins.commit.llm.maxTokens", "1900", "--json")
        if platform_tokens.returncode != 0:
            return f"could not set the platform Commit token default: {(platform_tokens.stderr or platform_tokens.stdout).strip()}"
        platform_token_read = run_cli(projects[1], "config", "get", "plugins.commit.llm.maxTokens", "--json")
        try:
            platform_token_payload = decode_ux_success_result(
                read_ux_cli_result(platform_token_read))
        except (json.JSONDecodeError, ValueError):
            return "config get did not return JSON for the platform setting"
        if (platform_token_read.returncode != 0 or not isinstance(platform_token_payload, dict)
                or platform_token_payload.get("value") != 1900 or platform_token_payload.get("layer") != "platform"):
            return "the platform token setting did not override the Commit manifest default"
        project_tokens = run_cli(projects[0], "config", "set", "plugins.commit.llm.maxTokens", "1800", "--json")
        if project_tokens.returncode != 0:
            return f"could not set Project A's token override: {(project_tokens.stderr or project_tokens.stdout).strip()}"
        project_token_read = run_cli(projects[0], "config", "get", "plugins.commit.llm.maxTokens", "--json")
        try:
            project_token_payload = decode_ux_success_result(
                read_ux_cli_result(project_token_read))
        except (json.JSONDecodeError, ValueError):
            return "config get did not return JSON for the project setting"
        if (project_token_read.returncode != 0 or not isinstance(project_token_payload, dict)
                or project_token_payload.get("value") != 1800 or project_token_payload.get("layer") != "project"):
            return "the project token setting did not override the platform Commit default"

        platform_default = run_cli(projects[0], "config", "set", "--scope", "platform",
                                   "plugins.commit.scope.scopes", scopes, "--json")
        if platform_default.returncode != 0:
            return f"could not set the platform Commit default: {(platform_default.stderr or platform_default.stdout).strip()}"
        project_override = '[{"id":"journey-a","label":"Project A","path":"."}]'
        configured = run_cli(projects[0], "config", "set", "plugins.commit.scope.scopes",
                             project_override, "--json")
        if configured.returncode != 0:
            return f"could not set Project A's Commit override: {(configured.stderr or configured.stdout).strip()}"

        def effective_scopes(project: Path) -> tuple[object, str | None, str | None, str | None]:
            result = run_cli(project, "config", "get", "plugins.commit.scope.scopes", "--json")
            try:
                payload = decode_ux_success_result(read_ux_cli_result(result))
            except (json.JSONDecodeError, ValueError):
                return None, None, None, f"config get returned invalid JSON in {project.name}"
            if result.returncode != 0 or not isinstance(payload, dict):
                return None, None, None, f"config get failed in {project.name}: {(result.stderr or result.stdout).strip()}"
            return payload.get("value"), payload.get("layer"), payload.get("source"), None

        a_value, a_layer, _, error = effective_scopes(projects[0])
        if error:
            return error
        b_value, b_layer, _, error = effective_scopes(projects[1])
        if error:
            return error
        if not isinstance(a_value, list) or a_value[0].get("id") != "journey-a" or a_layer != "project":
            return "Project A config get did not return its project value and provenance"
        if not isinstance(b_value, list) or b_value[0].get("id") != "journey-shared" or b_layer != "platform":
            return "Project B config get did not return the inherited platform value and provenance"

        for project in projects:
            status = repository_git_status(project)
            if status is None:
                return f"could not inspect {project.name} repository tree after the settings flow"
            if status != repository_baselines[project] or (project / ".kb").exists():
                return f"project settings commands changed {project.name}'s repository tree"

        # Legacy repository config and overlays are deliberately ignored; scenario overlays live in platform state.
        legacy_dir = projects[0] / ".kb"
        legacy_dir.mkdir()
        legacy_file = legacy_dir / "kb.config.json"
        legacy_file.write_text(json.dumps({"plugins": {"commit": {"scope": {"scopes": [
            {"id": "legacy-repository", "label": "Legacy", "path": "."},
        ]}}}}) + "\n")
        repository_overlay_dir = legacy_dir / "overlays"
        repository_overlay_dir.mkdir()
        repository_overlay_file = repository_overlay_dir / "conflict.jsonc"
        repository_overlay_file.write_text(json.dumps({"plugins": {"commit": {"scope": {"scopes": [
            {"id": "legacy-overlay", "label": "Legacy overlay", "path": "."},
        ]}}}}) + "\n")
        legacy_value, _, _, error = effective_scopes(projects[0])
        if error:
            return error
        if not isinstance(legacy_value, list) or legacy_value[0].get("id") != "journey-a":
            return "config get read the legacy repository config instead of platform-owned project settings"
        if json.loads(legacy_file.read_text())["plugins"]["commit"]["scope"]["scopes"][0]["id"] != "legacy-repository":
            return "config get modified the legacy repository config"
        if json.loads(repository_overlay_file.read_text())["plugins"]["commit"]["scope"]["scopes"][0]["id"] != "legacy-overlay":
            return "config get modified the repository overlay"

        outside = run_cli(root, "config", "get", "plugins.commit.scope.scopes", "--json")
        try:
            outside_payload = decode_ux_error_result(read_ux_cli_result(outside))
        except (json.JSONDecodeError, ValueError):
            return "config get outside registered projects returned invalid JSON"
        outside_error = outside_payload
        if (outside.returncode == 0 or not isinstance(outside_error, dict)
                or outside_error.get("code") != "KB_PROJECT_UNKNOWN"
                or not isinstance(outside_error.get("hint"), str)
                or "kb project add" not in outside_error["hint"]):
            return "config get outside registered projects did not return KB_PROJECT_UNKNOWN with the registration hint"

        outside_platform_write = run_cli(
            root, "config", "set", "--scope", "platform", "plugins.commit.scope.scopes", scopes, "--json",
        )
        if outside_platform_write.returncode != 0:
            return f"platform-scoped config set required a project: {(outside_platform_write.stderr or outside_platform_write.stdout).strip()}"
        outside_platform_read = run_cli(
            root, "config", "get", "plugins.commit.scope.scopes", "--scope", "platform", "--json",
        )
        try:
            outside_platform_payload = decode_ux_success_result(
                read_ux_cli_result(outside_platform_read))
        except (json.JSONDecodeError, ValueError):
            return "platform-scoped config get outside registered projects returned invalid JSON"
        if (outside_platform_read.returncode != 0 or not isinstance(outside_platform_payload, dict)
                or outside_platform_payload.get("value") != json.loads(scopes)
                or outside_platform_payload.get("layer") != "platform"):
            return "platform-scoped config get outside registered projects did not read only the platform layer"

        for project in projects:
            shutil.rmtree(project / ".kb", ignore_errors=True)
            files = sorted(path.name for path in project.iterdir() if path.name != ".git")
            if files:
                return f"configuring Commit settings created repository files in {project.name}: {', '.join(files)}"

        a_status, a_body, _ = request(
            project_service_path(ids[0], "rest", "plugins/commit/scopes"),
            token=service_token,
        )
        b_status, b_body, _ = request(
            project_service_path(ids[1], "rest", "plugins/commit/scopes"),
            token=service_token,
        )

        def scope_ids(status: int, body: object, project_name: str) -> tuple[set[str], str | None]:
            if status != 200:
                return set(), f"Commit settings for {project_name} returned HTTP {status}"
            try:
                value = decode_ux_success_result(body)
            except ValueError as error:
                return set(), f"Commit settings for {project_name} returned an invalid UX success envelope: {error}"
            options = value.get("options") if isinstance(value, dict) else None
            if not isinstance(options, list):
                return set(), f"Commit settings for {project_name} returned no scope options"
            return {str(option.get("value")) for option in options if isinstance(option, dict)}, None

        a_scopes, error = scope_ids(a_status, a_body, "Project A")
        if error:
            return error
        b_scopes, error = scope_ids(b_status, b_body, "Project B")
        if error:
            return error
        if "journey-a" not in a_scopes:
            return "Project A's Commit scope selector did not use the project override"
        if "journey-shared" not in b_scopes or "journey-a" in b_scopes:
            return "Project B's Commit scope selector did not retain only the platform default"

        for project in projects:
            status = run_command(
                ["git", "status", "--porcelain", "--untracked-files=all"], cwd=project,
                capture_output=True, text=True, check=False, timeout=30,
            )
            if status.returncode != 0:
                return f"could not inspect {project.name} working tree: {status.stderr.strip()}"
            if status.stdout.strip():
                return f"configuring Commit settings changed {project.name}: {status.stdout.strip()}"

    return None


class JourneyResponseError(ValueError):
    def __init__(self, call_kind: str, media_type: str, step: str, reason: str):
        self.call_kind = call_kind
        self.media_type = media_type
        self.journey_step = step
        self.reason = reason
        shown_media_type = media_type or "<missing>"
        super().__init__(
            f"journey step {step!r} received media type {shown_media_type!r}, "
            f"which is invalid for {call_kind}: {reason}"
        )


HTTP_RESPONSE_MEDIA_TYPES: dict[str, frozenset[str] | None] = {
    "ux": frozenset({"application/json"}),
    "mcp": frozenset({"application/json", "text/event-stream"}),
    "raw": None,
}


def _decode_mcp_response(raw: bytes, content_type: str, *, step: str) -> dict:
    try:
        if content_type == "application/json":
            parsed = json.loads(raw)
        else:
            data = "\n".join(
                line[5:].strip() for line in raw.decode("utf-8").splitlines()
                if line.startswith("data:")
            )
            parsed = json.loads(data)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise JourneyResponseError("mcp", content_type, step, "body is not valid MCP JSON") from error
    if not isinstance(parsed, dict):
        raise JourneyResponseError("mcp", content_type, step, "body is not an MCP object")
    return parsed


def request(path: str, *, method="GET", payload=None, token="", accept=None,
            response_kind="ux", step: str | None = None) -> tuple[int, object, dict[str, str]]:
    """Build, send, and decode one HTTP exchange at its declared response boundary."""
    if response_kind not in HTTP_RESPONSE_MEDIA_TYPES:
        raise ValueError(f"unsupported HTTP response kind: {response_kind}")
    step = step or f"{method} {path}"
    if accept is None:
        accept = "application/json, text/event-stream" if response_kind == "mcp" else "application/json"
    body = json.dumps(payload).encode() if payload is not None else None
    headers = {"Accept": accept}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(BASE_URL + path, data=body, headers=headers, method=method)
    try:
        status, raw, response_headers = open_http(HTTP.open, req, timeout=15, env=os.environ)
    except (urllib.error.URLError, TimeoutError) as error:
        raise RuntimeError(f"gateway is unreachable at {BASE_URL}: {error}; start it with `kb-create start`") from error
    if response_kind == "raw":
        return status, raw, response_headers
    content_type_header = response_headers.get("Content-Type", response_headers.get("content-type", ""))
    media_type = content_type_header.split(";", 1)[0].strip().lower()
    allowed_media_types = HTTP_RESPONSE_MEDIA_TYPES[response_kind]
    if allowed_media_types is not None and media_type not in allowed_media_types:
        raise JourneyResponseError(
            response_kind,
            media_type,
            step,
            f"allowed media types are {', '.join(sorted(allowed_media_types))}",
        )
    if response_kind == "ux":
        try:
            envelope = read_ux_http_result(raw, status)
            parsed = (decode_ux_success_result(envelope) if 200 <= status < 300
                      else decode_ux_error_result(envelope))
        except ValueError as error:
            raise JourneyResponseError("ux", media_type, step, f"body is not a UX JSON envelope: {error}") from error
        return status, parsed, response_headers
    try:
        parsed = _decode_mcp_response(raw, media_type, step=step)
    except JourneyResponseError:
        raise
    return status, parsed, response_headers


def request_mcp(path: str, *, step: str, method="POST", payload=None, token="",
                accept="application/json, text/event-stream") -> tuple[int, object, dict[str, str]]:
    return request(path, method=method, payload=payload, token=token,
                   accept=accept, response_kind="mcp", step=step)


def request_raw(path: str, *, accept="application/json") -> tuple[int, bytes, dict[str, str]]:
    status, body, headers = request(path, accept=accept, response_kind="raw")
    return status, body, headers


def expect_html(path: str, capability: str) -> str | None:
    status, body, headers = request_raw(path, accept="text/html")
    content_type = headers.get("Content-Type", headers.get("content-type", ""))
    if status != 200:
        return f"{capability} unavailable: GET {path} returned HTTP {status}"
    if not content_type.lower().startswith("text/html") or b"<html" not in body.lower():
        return f"{capability} returned HTTP 200 without an HTML document"
    return None


def request_ux_success(path: str, *, token="") -> tuple[int, object, dict[str, str]]:
    """Read a Gateway health-style success response through the UX envelope."""
    status, body, headers = request(path, token=token)
    return status, body, headers


def expect(path: str, expected: set[int], capability: str, *, method="GET", payload=None, token=""):
    status, body, _ = request(path, method=method, payload=payload, token=token)
    if status not in expected:
        detail = body.get("message", body.get("error", "")) if isinstance(body, dict) else ""
        reason = f"{capability} unavailable: {method} {path} returned HTTP {status}"
        if detail:
            reason += f" ({detail})"
        reason += f"; build and start the capability, then rerun `python3 {journey_module('service_runner.py')}`"
        return reason
    return None


def expect_json(path: str, capability: str, *, token="") -> str | None:
    try:
        status, body, _ = request_ux_success(path, token=token)
    except ValueError as error:
        return f"{capability} returned an invalid UX result envelope: {error}"
    if status != 200:
        detail = body.get("message", body.get("error", "")) if isinstance(body, dict) else ""
        suffix = f" ({detail})" if detail else ""
        return f"{capability} unavailable: GET {path} returned HTTP {status}{suffix}"
    if not isinstance(body, dict):
        return f"{capability} returned HTTP 200 without a JSON object"
    return None


def expect_project_service_health(path: str, service_id: str, *, token="") -> str | None:
    try:
        status, payload, _ = request_ux_success(path, token=token)
    except ValueError as error:
        return f"project service {service_id} health returned an invalid UX result envelope: {error}"
    if status != 200 or not isinstance(payload, dict):
        return f"project service {service_id} health returned HTTP {status} without a health payload"
    health_status = payload.get("status")
    if payload.get("ready") is False or health_status == "unhealthy":
        return f"project service {service_id} reported unhealthy status {health_status!r}"
    if health_status not in {"healthy", "ok", "degraded", "ready"} and payload.get("ready") is not True:
        return f"project service {service_id} health payload has no recognized status"
    return None


def service_check(name, capability, check, *, cases=(), requires=(), runners=()):
    return name, capability, check, list(cases), tuple(requires), tuple(runners)


def _checks(mode: str, graph: FlowGraph | None = None):
    def project_data() -> dict:
        value = graph.state_value_if_passed("project-registered") if graph is not None else None
        if not isinstance(value, dict):
            reason = graph.state_failure("project-registered") if graph is not None else "FlowGraph is unavailable"
            raise MissingJourneyState("project-registered", reason)
        return value

    def project_id() -> str:
        value = project_data().get("id")
        if not isinstance(value, str) or not value:
            raise MissingJourneyState("project-registered")
        return value

    pid = project_id
    auth_token = lambda: service_api_token(graph)

    def platform_readiness() -> str | None:
        gateway_error = expect_json("/ready", "gateway readiness")
        workflow_error = expect_project_service_health(
            project_service_path(project_id(), "workflow", "health"), "workflow", token=auth_token())
        errors = [error for error in (gateway_error, workflow_error) if error]
        return "; ".join(errors) if errors else None

    yield service_check("platform readiness (gateway + project workflow)", "gateway", platform_readiness,
                        cases=["PC-002.3"])

    project = lambda: expect(f"/api/v1/projects/{project_id()}", {200}, "project registry lookup", token=auth_token())
    yield service_check("project registration", "projects", project)
    def project_runtime_identity() -> str | None:
        registered_project = project_data()
        pid_value = project_id()
        project_root = registered_project.get("root")
        if not isinstance(project_root, str) or not project_root:
            raise MissingJourneyState("project-registered")
        expected_root = str(Path(project_root).resolve())
        try:
            registry_status, registered_project, _ = request_ux_success(
                f"/api/v1/projects/{pid_value}", token=auth_token())
        except ValueError as error:
            return f"project registry returned an invalid UX result envelope: {error}"
        if registry_status != 200 or not isinstance(registered_project, dict):
            return f"project registry could not verify registered project {pid_value} and its canonical path"
        if registered_project.get("path") != expected_root:
            return f"project registry path for {pid_value} did not match canonical root {expected_root}"
        try:
            health_status, health_body, _ = request_ux_success("/health", token=auth_token())
        except ValueError as error:
            return f"host health returned an invalid UX result envelope: {error}"
        runtimes = health_body.get("projectRuntimes", {}).get("runtimes", []) if isinstance(health_body, dict) else []
        if health_status != 200 or not any(
            isinstance(runtime, dict)
            and runtime.get("projectId") == pid_value
            and runtime.get(layout_value('sharedStateDirectory')) == "ready"
            for runtime in runtimes
        ):
            return f"host health did not list registered project {pid_value} as a ready runtime"
        path = project_service_path(pid_value, "rest", "health")
        try:
            status, body, _ = request_ux_success(path, token=auth_token())
        except ValueError as error:
            return f"registered project runtime REST health returned an invalid UX result envelope: {error}"
        if status != 200:
            return f"registered project runtime REST health returned HTTP {status} at {path}"
        if not isinstance(body, dict):
            return "registered project runtime REST health returned no JSON object"
        if body.get("status") not in {"healthy", "degraded"}:
            return "registered project runtime REST health payload has no recognized status"
        return None
    yield service_check("registered project runtime identity", "projects", project_runtime_identity,
                        cases=["PC-002.8", "S-124.11", "S-124.13"])
    def project_settings_check():
        return project_plugin_settings_isolation(auth_token())
    yield service_check("project plugin settings isolation and clean repositories", "projects",
                        project_settings_check,
                        cases=["S-204.1", "S-204.2", "S-204.8", "S-204.9", "S-204.10", "S-204.11"])
    yield service_check("workflow discovery", "workflow", lambda: discover_workflow(pid(), auth_token()))
    yield service_check("workflow execution endpoint", "workflow", lambda: expect(
        project_service_path(pid(), "workflow", "workflows/e2e-hello/runs"), {200, 201, 202},
        "project-aware workflow run endpoint", method="POST", payload={"trigger": {"type": "manual"}}, token=auth_token()))
    yield service_check("project-scoped MCP initialize", "mcp", lambda: mcp_initialize(pid(), auth_token()),
                        cases=["S-045.1"])
    yield service_check("project-scoped MCP tools/list", "mcp", lambda: mcp_probe(
        pid(), auth_token(), DEFAULT_ENABLED_SERVICES),
                        cases=["S-045.2"])
    yield service_check("project-scoped MCP diagnostics", "mcp", lambda: mcp_diagnostics(pid(), auth_token()),
                        cases=["S-045.3"])
    if mode == "local":
        yield service_check("project MCP tokenless local access", "mcp", lambda: local_auth(
            pid(), DEFAULT_ENABLED_SERVICES),
                            cases=["S-045.4"], runners=("service-local:explore",))
    else:
        yield service_check("project MCP secured missing and invalid token rejection", "mcp",
                            lambda: secured_auth(pid()), cases=["S-045.5", "S-140.6"],
                            runners=("service-secured:explore",))
        yield service_check("project MCP refuses host-registration credentials", "mcp",
                            lambda: opaque_host_credential_mcp_rejection(pid(), auth_token()),
                            cases=["S-045.10"], runners=("service-secured:explore",))
    yield service_check("project MCP commit schema", "mcp", lambda: commit_tool_schema(pid(), auth_token()),
                        cases=["S-140.1"])
    project_root = (service_project(graph)["root"]
                    if graph is not None and graph.states.get("project-registered", {}).get("passed") is True
                    else "")
    if project_root:
        yield service_check("project MCP commit mutation", "mcp",
                            lambda: apply_commit_plan(pid(), auth_token(), project_root), cases=["S-140.2"])
    else:
        yield service_check("project MCP commit mutation", "mcp",
                            lambda: "BLOCKED: project-registered state must provide the disposable commit fixture root",
                            cases=["S-140.2"])
    yield service_check("project MCP unknown tool error", "mcp", lambda: unknown_tool(pid(), auth_token()),
                        cases=["S-140.3"])
    yield service_check("project MCP invalid argument error", "mcp", lambda: invalid_arguments(pid(), auth_token()),
                        cases=["S-140.4"])
    if mode == "secured":
        yield service_check("MCP UX result contract from live registry", "mcp",
                            lambda: mcp_ux_result_contract(pid(), auth_token(), secured=True),
                            cases=["S-203.2", "S-045.6", "S-140.7"],
                            runners=("service-secured:explore",))
    else:
        yield service_check("MCP UX result contract from live registry", "mcp",
                            lambda: mcp_ux_result_contract(pid(), auth_token(), secured=False),
                            cases=["S-203.2"], runners=("service-local:explore",))
    project_b = {}
    if graph is not None and graph.states.get("fixtures-installed", {}).get("passed") is True:
        project_b = service_project_b(graph)
    project_b_id = project_b.get("projectBId", "")
    project_b_root = project_b.get("projectBRoot", "")
    if project_b_id and project_b_root:
        yield service_check("project MCP cross-project isolation", "mcp",
                            lambda: project_isolation(pid(), project_b_id, project_b_root, auth_token()),
                            cases=["S-140.5"])
        yield service_check("project plugin catalog isolation", "mcp",
                            lambda: project_plugin_catalog_isolation(pid(), project_b_id, auth_token()),
                            cases=["S-199.3"])
        yield service_check("project MCP read-only tool isolation", "mcp",
                            lambda: project_readonly_tool_isolation(pid(), project_b_id, auth_token()),
                            cases=["S-199.4"])
        if mode == "secured":
            yield service_check("secured project MCP catalog selection", "mcp",
                                lambda: secured_project_catalog_isolation(pid(), project_b_id, auth_token()),
                                cases=["S-199.5"], runners=("service-secured:explore",))
    else:
        yield service_check("project MCP cross-project isolation", "mcp",
                            lambda: "BLOCKED: fixtures-installed state did not provide a registered project B",
                            cases=["S-140.5"])
        yield service_check("project plugin catalog isolation", "mcp",
                            lambda: "BLOCKED: fixtures-installed state did not provide a registered project B",
                            cases=["S-199.3"])
        yield service_check("project MCP read-only tool isolation", "mcp",
                            lambda: "BLOCKED: fixtures-installed state did not provide a registered project B",
                            cases=["S-199.4"])
        if mode == "secured":
            yield service_check("secured project MCP catalog selection", "mcp",
                                lambda: "BLOCKED: fixtures-installed state did not provide a registered project B",
                                cases=["S-199.5"], runners=("service-secured:explore",))
    yield service_check("Studio shell", "studio", lambda: expect_html("/", "Studio shell"))
    yield service_check("Studio project API", "studio", lambda: expect("/api/v1/projects", {200}, "Studio project API", token=auth_token()))
    yield service_check("marketplace registry", "marketplace", lambda: expect(project_service_path(pid(), "rest", "plugins/registry"), {200}, "marketplace registry", token=auth_token()))


def checks(mode: str, graph: FlowGraph | None = None):
    """Return a reusable declaration list for this service mode."""
    return list(_checks(mode, graph))


def service_api_token(graph: FlowGraph | None) -> str | None:
    """Read the HTTP credential from its established state; local mode stores no credential."""
    if graph is None:
        raise MissingJourneyState("service-api-session")
    state = graph.states.get("service-api-session")
    if state is None or state.get("passed") is not True:
        raise MissingJourneyState("service-api-session", graph.state_failure("service-api-session"))
    if "value" not in state:
        raise MissingJourneyState("service-api-session", graph.state_failure("service-api-session"))
    value = graph.state_value_if_passed("service-api-session")
    if value is None or isinstance(value, str):
        return value
    raise MissingJourneyState("service-api-session", graph.state_failure("service-api-session"))


def service_project_b(graph: FlowGraph | None) -> dict:
    if graph is None:
        raise MissingJourneyState("fixtures-installed")
    value = graph.state_value_if_passed("fixtures-installed")
    if not isinstance(value, dict):
        raise MissingJourneyState("fixtures-installed", graph.state_failure("fixtures-installed"))
    return value


def export_project_state_to_child_environment(graph: FlowGraph) -> None:
    """Publish registered project identities for CLI subprocesses only."""
    project_state = graph.states.get("project-registered", {})
    fixture_state = graph.states.get("fixtures-installed", {})
    project = graph.state_value_if_passed("project-registered") if project_state.get("passed") is True else None
    fixtures = graph.state_value_if_passed("fixtures-installed") if fixture_state.get("passed") is True else None
    export_project_identity_to_child_environment(
        os.environ,
        project_id=project.get("id", "") if isinstance(project, dict) else "",
        project_root=project.get("root", "") if isinstance(project, dict) else "",
        project_b_id=fixtures.get("projectBId", "") if isinstance(fixtures, dict) else "",
        project_b_root=fixtures.get("projectBRoot", "") if isinstance(fixtures, dict) else "",
    )


def prepare_service_api_session(graph: FlowGraph, mode: str) -> None:
    """Probe the independent HTTP credential used by service-runner API requests.

    The CLI session is restored separately because auth journey steps can log the CLI out;
    this state is the runner's HTTP bearer credential and has its own lifetime.
    """
    acquired: dict[str, str | None] = {"token": None}

    def acquire() -> str | None:
        if mode == "local":
            return None
        if not ADMIN_PASSWORD:
            return "secured profile needs KB_JOURNEY_ADMIN_PASSWORD; provide test credentials in the isolated journey container"
        store_report_secret(os.environ, "KB_JOURNEY_ADMIN_PASSWORD", ADMIN_PASSWORD,
                            "service runner admin password")
        status, body, _ = request("/auth/login/cli", method="POST",
                                  payload={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
        if status not in {200, 201}:
            return f"POST /auth/login/cli returned HTTP {status}; check the isolated secured install credentials"
        if not isinstance(body, dict):
            return "POST /auth/login/cli returned a non-JSON response"
        token = body.get("accessToken") or body.get("token")
        if not token:
            return "POST /auth/login/cli returned no access token"
        token = str(token)
        store_report_secret(os.environ, "KB_JOURNEY_SERVICE_TOKEN", token,
                            "secured service admin access token")
        acquired["token"] = token
        me_status, _, _ = request("/auth/me", token=token)
        if me_status != 200:
            return f"service API token did not authenticate /auth/me (HTTP {me_status})"
        return None

    graph.probe_state("service-api-session", "auth", "service API login", acquire,
                      value=lambda: acquired["token"])


def service_project(graph: FlowGraph) -> dict[str, str] | None:
    value = graph.state_value_if_passed("project-registered")
    if value is None:
        return None
    if (not isinstance(value, dict)
            or not isinstance(value.get("id"), str) or not value["id"]
            or not isinstance(value.get("root"), str) or not value["root"]):
        raise MissingJourneyState("project-registered", graph.state_failure("project-registered"))
    return value


def declared_capabilities(mode: str) -> set[str]:
    """Return every capability the selected service profile promises to check."""
    capabilities = {capability for _, capability, _, _, _, _ in checks(mode)}
    capabilities.add("auth.local" if mode == "local" else "auth.invite-reset")
    capabilities.add("plugin-author")
    return capabilities


def discover_workflow(project_id: str, token: str) -> str | None:
    path = project_service_path(project_id, "workflow", "workflows")
    status, body, _ = request(path, token=token)
    if status != 200:
        return f"project-aware workflow discovery unavailable: GET {path} returned HTTP {status}"
    data = body.get("data", body) if isinstance(body, dict) else body
    workflows = data.get("workflows", []) if isinstance(data, dict) else data
    if not isinstance(workflows, list) or not any(
        isinstance(item, dict) and (item.get("name") == "e2e-hello" or item.get("id") == "e2e-hello")
        for item in workflows
    ):
        return "project-aware workflow catalog does not include the e2e-hello fixture from .kb/workflows/e2e-hello.yml"
    return None


def mcp_initialize(project_id: str, token: str) -> str | None:
    route = project_service_path(project_id, "mcp")
    status, body, _ = request_mcp(route, token=token, step="project-scoped MCP initialize",
                                  accept="application/json, text/event-stream", payload={
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                   "clientInfo": {"name": "kb-labs-journey", "version": "1.0.0"}},
    })
    if status != 200:
        return f"project-scoped MCP initialize unavailable: POST {route} returned HTTP {status}; enable the project MCP runtime and rerun the service journey"
    result = body.get("result") if isinstance(body, dict) else None
    if not isinstance(result, dict) or result.get("protocolVersion") != "2025-03-26":
        return "project-scoped MCP initialize returned no result for protocol version 2025-03-26"
    return None


def mcp_probe(project_id: str, token: str, enabled_service_ids: frozenset[str]) -> str | None:
    route = project_service_path(project_id, "mcp")
    status, body, _ = request_mcp(route, token=token, step="project-scoped MCP tools/list",
                                  accept="application/json, text/event-stream", payload={
        "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {},
    })
    if status != 200:
        return f"project-scoped MCP tools/list unavailable: POST {route} returned HTTP {status}; enable the project MCP runtime and rerun the service journey"
    if not isinstance(body, dict) or not isinstance(body.get("result"), dict):
        return "project-scoped MCP tools/list returned no JSON-RPC result"
    tools = body["result"].get("tools")
    if not isinstance(tools, list) or not tools:
        return "project-scoped MCP tools/list returned no project tools"
    names = {tool.get("name") for tool in tools if isinstance(tool, dict)}
    expected_services = service_tool_names(enabled_service_ids)
    served_services = service_family_tool_names(names)
    if expected_services != served_services:
        return f"project-scoped MCP service catalog mismatch: expected={sorted(expected_services)} served={sorted(served_services)[:50]}"
    expected = {commit_tool("commit commit"), "kb-labs__mcp_diagnostics"}
    if not expected <= names:
        return f"project-scoped MCP tools/list mismatch: expected={sorted(expected)} served={sorted(names)[:50]}"
    if any(not isinstance(tool, dict) or not isinstance(tool.get("name"), str)
           or not isinstance(tool.get("inputSchema"), dict) for tool in tools):
        return "project-scoped MCP tools/list returned a tool without its name or input schema"
    return None


def mcp_diagnostics(project_id: str, token: str) -> str | None:
    status, body, _ = request_mcp(project_service_path(project_id, "mcp"), token=token,
                                  step="project-scoped MCP diagnostics",
                                  accept="application/json, text/event-stream", payload={
        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": {"name": "kb-labs__mcp_diagnostics", "arguments": {}},
    })
    if status != 200:
        return f"project-scoped MCP diagnostics unavailable: HTTP {status}"
    result = body.get("result") if isinstance(body, dict) else None
    content = result.get("content", []) if isinstance(result, dict) else []
    text = "\n".join(item.get("text", "") for item in content if isinstance(item, dict))
    if not isinstance(result, dict) or result.get("isError") or "loaded cleanly" not in text:
        return "project-scoped MCP diagnostics did not report that the project loaded cleanly"
    return None


SERVICE_GROUPS = {
    "cli": {"capabilities": {"cli"}, "depends_on": ()},
    "platform": {"capabilities": {"gateway"}, "depends_on": ("host-running", "project-registered", "service-api-session")},
    "auth": {"capabilities": {"auth.local", "auth.secured"}, "depends_on": ("host-running",),
             "produces": ("session",)},
    "projects": {"capabilities": {"projects"}, "depends_on": ("host-running", "project-registered", "service-api-session")},
    "workflow": {"capabilities": {"workflow"}, "depends_on": ("host-running", "project-registered", "service-api-session")},
    "marketplace-fixture-producer": {"capabilities": set(),
                                     "depends_on": ("host-running", "project-registered"),
                                     "produces": ("marketplace-available",)},
    "marketplace": {"capabilities": {"marketplace"},
                     "depends_on": ("host-running", "project-registered", "service-api-session")},
    "marketplace-lifecycle": {"capabilities": set(),
                              "depends_on": ("host-running", "project-registered", "marketplace-available", "service-api-session")},
    "marketplace-registry": {"capabilities": {"marketplace-registry"},
                             "depends_on": ("host-running", "project-registered", "service-api-session")},
    "marketplace-fixtures": {"capabilities": set(),
                             "depends_on": ("host-running", "project-registered", "marketplace-available"),
                             "produces": ("fixtures-installed",)},
    "mcp": {"capabilities": {"mcp"}, "depends_on": ("host-running", "project-registered", "fixtures-installed", "service-api-session")},
    "studio": {"capabilities": {"studio"}, "depends_on": ("host-running", "project-registered", "service-api-session")},
    "analytics": {"capabilities": {"analytics"}, "depends_on": ("host-running", "project-registered", "fixtures-installed", "service-api-session")},
    "gateway-extra": {"capabilities": {"gateway-extra"}, "depends_on": ("host-running", "session", "service-api-session")},
    "agent-session": {"capabilities": {"agent-session"},
                       "depends_on": ("host-running", "project-registered", "agent-plugin-installed", "service-api-session"),
                       "produces": ("agent-plugin-installed",)},
    "project-registry": {"capabilities": {"project-registry"}, "depends_on": ("host-running", "project-registered")},
    "project-identity": {"capabilities": {"project-identity"}, "depends_on": ("host-running", "project-registered")},
    "workspace": {"capabilities": {"workspace"}, "depends_on": ("host-running",)},
    "plugin-availability": {"capabilities": {"plugin-availability"},
                            "depends_on": ("project-registered", "fixtures-installed")},
    "adapters": {"capabilities": {"adapter"}, "depends_on": ("host-running", "project-registered"),
                 "produces": ("adapter-defaults",)},
    "plugin-author": {"capabilities": {"plugin-author"},
                       "depends_on": ("host-running", "project-registered", "fixtures-installed", "session")},
    "worktree": {"capabilities": {"worktree"}, "depends_on": ("host-running", "project-registered")},
}


def service_selection_groups(root: Path | None = None, runner_selector: str = "") -> dict[str, dict]:
    """Attach resolver-owned marketplace registrations to the service graph."""
    groups = {name: dict(spec) for name, spec in SERVICE_GROUPS.items()}
    source_root = root or resource_root()
    declaration = journey_source_group_declaration(
        "e2e/journey/marketplace_steps.py", source_root, runner_selector)
    group_name = ("marketplace-registry" if runner_selector
                  and lane_for_runner(runner_selector) == MARKETPLACE_REGISTRY_LANE
                  else "marketplace-lifecycle")
    group = dict(groups[group_name])
    group["cases"] = tuple(sorted(set(group.get("cases", ())) | set(declaration["cases"])))
    group["steps"] = tuple(sorted(set(group.get("steps", ())) | set(declaration["steps"])))
    groups[group_name] = group
    return groups
STATE_PRODUCERS = {
    state: group for group, spec in SERVICE_GROUPS.items()
    for state in spec.get("produces", ())
}


def run_grouped_service_steps(journey: Journey, steps, mode: str = "local", groups=None,
                              states=None, graph: FlowGraph | None = None) -> None:
    """Run declared capability groups, gating only on explicit state probes."""
    group_specs = groups or SERVICE_GROUPS
    capability_groups = {
        capability: group
        for group, spec in group_specs.items()
        for capability in spec["capabilities"]
    }
    flow_graph = graph or FlowGraph(
        journey, {name: spec["depends_on"] for name, spec in group_specs.items()}, states=states,
        groups=group_specs)
    for name, capability, check, cases, requires, runners in steps:
        group = capability_groups.get(capability, capability)
        flow_graph.dispatch_step(name, group, capability, check, cases=cases, requires=requires, runners=runners)


def run_service_steps(journey: Journey, steps, mode: str = "local", states=None,
                      graph: FlowGraph | None = None) -> None:
    """Run capability checks through Journey so raised checks are recorded."""
    run_grouped_service_steps(journey, steps, mode, states=states, graph=graph)


def configure_installed_cli_path() -> None:
    """Expose the isolated installed platform binaries to subprocess flows."""
    bin_dir = str(Path.home() / ".local" / "bin")
    current = os.environ.get("PATH", "").split(os.pathsep)
    if bin_dir not in current:
        os.environ["PATH"] = os.pathsep.join([bin_dir, *current])


def restore_secured_cli_login(kb_path: str | Path, env: dict[str, str], *, runner=run_command) -> None:
    """Restore the CLI session after the auth journey intentionally logs out."""
    email = env.get("KB_JOURNEY_ADMIN_EMAIL", "").strip()
    password = env.get("KB_JOURNEY_ADMIN_PASSWORD", "")
    if not email or not password:
        raise RuntimeError("secured service journey needs admin credentials; rerun with KB_JOURNEY_ADMIN_EMAIL and KB_JOURNEY_ADMIN_PASSWORD")
    command = kb_command([ "auth", "login", "--gateway-url",
               env.get("KB_JOURNEY_BASE_URL", BASE_URL), "--email", email,
               "--password-stdin"], executable=str(kb_path))
    result = run_with_runner(runner, command, cwd=env.get("HOME"), env=env, timeout=90,
                             input=password + "\n")
    if result.returncode != 0:
        detail = " ".join((result.stdout + " " + result.stderr).split())
        suffix = f"; {detail}" if detail else ""
        raise RuntimeError(f"`kb auth login` failed while restoring the secured service journey session{suffix}")


def _run_installed_flows(journey: Journey, project_root: str, registry: str, graph: FlowGraph) -> None:
    env = os.environ.copy()
    graph.flow(
        "installed CLI help and unknown-command contract",
        "cli",
        "cli",
        lambda: run_installed_cli_contract_steps(journey, env),
        cases=["S-258.1"],
        record_empty_success=False,
    )
    graph.flow(
        "unexpected CLI error trail",
        "unexpected-error-trail",
        "cli",
        lambda: run_unexpected_error_steps(journey, mode=journey.mode, env=env),
        cases=["S-203.26"],
        record_empty_success=False,
    )
    project_id = service_project(graph)["id"]
    cli_path = Path.home() / ".local/bin/kb"
    graph.flow("project registry and current-project flows", "project-registry", "projects",
               lambda: (run_project_registry_steps(journey, str(cli_path), env, registry),
                        run_project_registration_case_steps(journey, str(cli_path), env),
                        run_project_registry_corruption_case_step(
                            journey, str(cli_path), env,
                            Path(journey_value("KB_JOURNEY_PLATFORM_ROOT", required=True)),
                            project_id,
                            service_api_token(graph) or "",
                            lambda path, token: request(path, token=token))),
               cases=["S-043.1", "S-196.1", "S-124.1", "S-124.2", "S-124.3", "S-124.4",
                      "S-124.5", "S-124.6", "S-124.8", "S-124.9", "S-124.12", "S-051.1"],
               record_empty_success=False)
    workspace_root = Path(journey_value("KB_JOURNEY_WORKSPACE_ROOT", resource_root()))

    def run_workspace_flows() -> None:
        problem = workspace_checkout_problem(workspace_root)
        if problem:
            journey.step(
                "workspace checkout is staged and built",
                "workspace-cli",
                lambda: problem,
                cases=[
                    "S-179.2", "S-179.3", "S-179.4", "S-179.5", "S-179.13", "S-179.33",
                    "S-142.5", "S-203.1", "S-203.19", "S-204.7",
                ],
            )
            return
        run_project_identity_steps(journey, workspace_root)
        run_workspace_cli_steps(journey, workspace_root, prechecked=True)

    graph.flow("workspace CLI flows", "workspace", "workspace",
               run_workspace_flows,
               cases=["S-179.2", "S-179.3", "S-179.4", "S-179.5", "S-179.13", "S-179.33",
                      "S-142.5", "S-203.1", "S-203.19", "S-204.7"], record_empty_success=False)
    project_b_root = (service_project_b(graph).get("projectBRoot", "")
                      if graph.states.get("fixtures-installed", {}).get("passed") is True else "")
    def run_project_plugin_availability() -> str | None:
        if not project_b_root:
            return "project B fixture handoff did not provide a registered project root"
        return run_project_plugin_availability_steps(
            journey, str(cli_path), Path(project_root), Path(project_b_root), env)

    graph.flow("project plugin availability", "plugin-availability", "plugins",
               run_project_plugin_availability,
               cases=["S-197.3", "S-197.5"], record_empty_success=False)
    adapter_fixture_snapshot: dict[str, object] = {}
    graph.flow("adapter defaults flow", "adapters", "adapter",
               lambda: run_adapter_default_steps(journey, project_root, env,
                                                 snapshot=adapter_fixture_snapshot),
               cases=["S-054.1", "S-048.1"], record_empty_success=False)
    platform_root = Path(env.get("KB_JOURNEY_PLATFORM_ROOT", project_root))
    graph.probe_state("adapter-defaults", "adapters", "restore original platform adapter fixture state",
                      lambda: _adapter_defaults_probe_error(journey, adapter_fixture_snapshot, platform_root),
                      after_flow="adapter defaults flow")
    graph.flow("plugin author flow", "plugin-author", "plugin-author",
               lambda: run_plugin_author_flow(journey, Path(project_root),
                                              Path.home() / ".local/bin/kb", registry,
                                              base_env=env),
               cases=["S-014.1", "S-015.1", "S-003.1"], record_empty_success=False)
    graph.flow("worktree workflow identity flow", "worktree", "workflow",
               lambda: run_worktree_steps(journey, Path.home() / ".local/bin/kb",
                                          platform_root=os.environ.get("KB_PLATFORM_ROOT", str(Path.home() / "kb-platform")),
                                          env=env),
               cases=["S-198.5"], record_empty_success=False)


def _find_project_id(payload: object) -> str:
    if isinstance(payload, dict):
        for key in ("projectId", "project_id", "id"):
            value = payload.get(key)
            if isinstance(value, str) and value.startswith("prj_"):
                return value
        for value in payload.values():
            found = _find_project_id(value)
            if found:
                return found
    elif isinstance(payload, list):
        for value in payload:
            found = _find_project_id(value)
            if found:
                return found
    return ""


def _find_project_registration(payload: object) -> tuple[str, str]:
    if isinstance(payload, dict):
        project = payload.get("project")
        if isinstance(project, dict):
            project_id = project.get("id")
            project_root = project.get("path")
            if (isinstance(project_id, str) and project_id.startswith("prj_")
                    and isinstance(project_root, str) and Path(project_root).is_absolute()
                    and str(Path(project_root).resolve()) == project_root):
                return project_id, project_root
        for value in payload.values():
            found_id, found_root = _find_project_registration(value)
            if found_id and found_root:
                return found_id, found_root
    elif isinstance(payload, list):
        for value in payload:
            found_id, found_root = _find_project_registration(value)
            if found_id and found_root:
                return found_id, found_root
    return "", ""


def _write_mcp_commit_plan(project_root: Path, env: dict[str, str]) -> dict[str, object]:
    """Prepare the staged note commit required by S-140.2 in the isolated KB state."""
    def git(*args: str) -> CompletedProcess[str]:
        command = ["git", "-C", str(project_root), *args]
        result = run_command(command, cwd=project_root, env=env, timeout=30)
        if result.returncode != 0:
            raise CalledProcessError(result.returncode, command,
                                                output=result.stdout, stderr=result.stderr)
        return result

    git("config", "user.name", "KB Labs Journey")
    git("config", "user.email", "journey@example.com")

    def git_files(*args: str) -> list[str]:
        result = git(*args)
        return [line for line in result.stdout.splitlines() if line]

    status = {
        "staged": git_files("diff", "--cached", "--name-only"),
        "unstaged": git_files("diff", "--name-only"),
        "untracked": git_files("ls-files", "--others", "--exclude-standard"),
    }
    files = [*status["staged"], *status["unstaged"], *status["untracked"]]
    if not status["staged"]:
        raise RuntimeError("S-140.2 requires a staged project A change before preparing the Commit plan")

    project_id = "prj_" + hashlib.sha256(str(project_root.resolve()).encode("utf-8")).hexdigest()[:16]
    kb_home_override = env.get("KB_HOME", "").strip()
    kb_home = Path(kb_home_override) if kb_home_override else Path(env["HOME"]) / ".kb"
    kb_home = kb_home.expanduser().resolve()
    plan_path = (kb_home / layout_value('sharedStateDirectory') / project_id / "commit" / "plans" / "root" /
                 layout_value('currentLink') / "plan.json")
    plan_path.parent.mkdir(parents=True, exist_ok=True)
    plan = {
        "schemaVersion": "1.0",
        "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "repoRoot": str(project_root.resolve()),
        "gitStatus": status,
        "commits": [{
            "id": "journey-commit",
            "type": "chore",
            "message": "Add journey fixture",
            "files": files,
            "releaseHint": "none",
            "breaking": False,
        }],
        "metadata": {"totalFiles": len(files), "totalCommits": 1, "llmUsed": False},
    }
    plan_path.write_text(json.dumps(plan, indent=2) + "\n")
    return {"path": str(plan_path), "planId": "journey-commit", "totalCommits": len(plan["commits"])}


def prepare_mcp_projects(project_root: str, registry: str, env: dict[str, str],
                         runner=run_command) -> tuple[str, str, dict[str, object]]:
    """Install the project fixture plugins into A and register clean project B."""
    command_runner = runner
    def runner(command, **kwargs):
        options = dict(kwargs)
        timeout = options.pop("timeout", 120)
        options.pop("capture_output", None)
        options.pop("text", None)
        return run_with_runner(command_runner, command, timeout=timeout, **options)
    project_a = Path(project_root).resolve()
    package = "@kb-labs/commit"
    install = kb_command([ "marketplace", "install", package, "--json"])
    installed = runner(install, cwd=str(project_a), env=env, capture_output=True,
                       text=True, timeout=300)
    _output(installed, install)
    plan_preparation_result = _write_mcp_commit_plan(project_a, env)

    home = Path(env["HOME"])
    project_b = home / "project-b-mcp"
    project_b.mkdir(parents=True, exist_ok=False)
    result = run_command(["git", "init", "-q", str(project_b)], cwd=project_b.parent,
                         env=env, timeout=30)
    if result.returncode != 0:
        raise CalledProcessError(result.returncode,
                                            ["git", "init", "-q", str(project_b)],
                                            output=result.stdout, stderr=result.stderr)
    register = kb_command([ "project", "add", str(project_b), "--json"])
    result = runner(register, cwd=str(project_b), env=env, capture_output=True,
                    text=True, timeout=120)
    raw = _output(result, register)
    try:
        payload = decode_ux_success_result(read_ux_cli_result(result))
    except (json.JSONDecodeError, ValueError) as error:
        raise RuntimeError("registering MCP isolation project B returned invalid JSON") from error
    project_b_id, project_b_root = _find_project_registration(payload)
    if not project_b_id or not project_b_root:
        raise RuntimeError("registering MCP isolation project B returned no project ID and canonical path")
    review_package = "@kb-labs/review"
    review_version = _registry_version(review_package, registry, project_b, env, runner)
    review_install = kb_command([ "marketplace", "install", f"{review_package}@{review_version}", "--json"])
    review_installed = runner(review_install, cwd=str(project_b), env=env, capture_output=True,
                              text=True, timeout=300)
    _output(review_installed, review_install)
    lock_path = project_b / ".kb" / "marketplace.lock"
    if lock_path.exists():
        lock = json.loads(lock_path.read_text())
        if "@kb-labs/commit" in lock.get("plugins", {}):
            raise RuntimeError("MCP isolation project B unexpectedly has the Commit plugin installed")
        if "@kb-labs/review" not in lock.get("plugins", {}):
            raise RuntimeError("MCP isolation project B does not have its Review fixture plugin installed")
    return project_b_id, project_b_root, plan_preparation_result


def _prepare_mcp_projects(project_id: str, project_root: str, registry: str, env: dict[str, str],
                          runner=run_command) -> tuple[str, str]:
    project_b_id, project_b_root, plan_preparation_result = prepare_mcp_projects(project_root, registry, env, runner)
    fixture_path = env.get("KB_JOURNEY_PROJECT_FIXTURES_FILE", "")
    if fixture_path:
        output_path = Path(fixture_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps({
            "projectAId": project_id,
            "projectARoot": str(Path(project_root).resolve()),
            "projectBId": project_b_id,
            "projectBRoot": project_b_root,
            "commitPlanPreparationResult": plan_preparation_result,
        }), encoding="utf-8")
    return project_b_id, project_b_root


def install_project_commit_plugin(project_root: str, executable: str, env: dict[str, str], runner=run_command):
    """Install Commit into a settings project before reading its manifest defaults."""
    command = kb_command(["marketplace", "install", "@kb-labs/commit", "--scope", "project", "--json"],
                         executable=executable)
    return run_with_runner(runner, command, cwd=str(Path(project_root).resolve()), env=env,
                           capture_output=True, text=True, timeout=300)


def install_project_agents_plugin(project_root: str, registry: str, env: dict[str, str], runner=run_command) -> None:
    """Install the real Agents fixture before exercising its project REST routes."""
    package = "@kb-labs/agents"
    command_runner = runner

    def run(command, **kwargs):
        options = dict(kwargs)
        timeout = options.pop("timeout", 120)
        options.pop("capture_output", None)
        options.pop("text", None)
        return run_with_runner(command_runner, command, timeout=timeout, **options)

    version = _registry_version(package, registry, Path(project_root).resolve(), env, run)
    install = kb_command([ "marketplace", "install", f"{package}@{version}", "--json"])
    result = run(install, cwd=str(Path(project_root).resolve()), env=env,
                 capture_output=True, text=True, timeout=300)
    _output(result, install)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["local", "secured"], required=True)
    parser.add_argument("--output", default="service-journey.json")
    parser.add_argument("--run-id")
    args = parser.parse_args()
    os.environ.setdefault("KB_JOURNEY_INVOCATIONS", str(Path(args.output).resolve().parent))
    journey = Journey(args.mode, args.run_id or str(uuid.uuid4()))
    inherited_states = json.loads(journey_value("KB_JOURNEY_STATES", "{}"))
    service_groups = service_selection_groups(runner_selector=journey.runner_selector)
    graph = FlowGraph(
        journey, {name: spec["depends_on"] for name, spec in service_groups.items()},
        diagnostics_path=Path(args.output).resolve().with_name("journey-diagnostics.log"),
        states=inherited_states, state_producers=STATE_PRODUCERS, groups=service_groups,
    )
    try:
        configure_installed_cli_path()
        if args.mode == "secured":
            graph.probe_state("session", "auth", "fresh secured CLI login",
                              lambda: restore_secured_cli_login(
                                  Path.home() / ".local/bin/kb", os.environ.copy()))
        prepare_service_api_session(graph, args.mode)
        project_state = graph.states.get("project-registered", {})
        project_id = ""
        project_root = ""
        if project_state.get("passed") is True:
            registered_project = service_project(graph)
            if registered_project is not None:
                project_id = registered_project["id"]
                project_root = registered_project["root"]
        registry = journey_value("KB_JOURNEY_REGISTRY", "http://verdaccio:4873")
        env = os.environ.copy()
        fixture_entry: dict | None = None
        def produce_commit_fixture() -> str | None:
            if not project_root:
                return "project-registered state did not provide a project root"
            nonlocal fixture_entry
            fixture_entry = prepare_commit_project_fixture(journey, project_root, registry, env)

        graph.flow("produce Commit project fixture", "marketplace-fixture-producer", "marketplace-fixtures",
                   produce_commit_fixture,
                   record_empty_success=False)
        project_lock = Path(project_root) / ".kb" / "marketplace.lock"
        def marketplace_probe() -> str | None:
            if not project_root:
                return "project-registered state did not provide a project root"
            try:
                lock = json.loads(project_lock.read_text())
            except (OSError, json.JSONDecodeError) as error:
                return f"project plugin lock is missing or unreadable: {error}"
            entry = lock.get("plugins", {}).get("@kb-labs/commit")
            return None if isinstance(entry, dict) and entry.get("package") == "@kb-labs/commit" and entry.get("version") else "Commit fixture is absent from the project marketplace lock"
        graph.probe_state("marketplace-available", "marketplace-fixture-producer", "Commit project fixture",
                          marketplace_probe)

        def prepare_mcp_fixtures() -> str | None:
            if not project_root:
                return "project-registered state did not provide a project root"
            return _prepare_mcp_projects(project_id, project_root, registry, env)

        graph.flow("prepare MCP project fixtures", "marketplace-fixtures", "mcp",
                   prepare_mcp_fixtures,
                   record_empty_success=False)
        fixture_file = env.get("KB_JOURNEY_PROJECT_FIXTURES_FILE", "")
        def fixtures_probe() -> str | None:
            if not fixture_file:
                return "project fixture handoff file path was not configured"
            try:
                fixtures = json.loads(Path(fixture_file).read_text())
            except (OSError, json.JSONDecodeError) as error:
                return f"project fixture handoff is missing or unreadable: {error}"
            required = ("projectAId", "projectARoot", "projectBId", "projectBRoot")
            return None if all(fixtures.get(key) for key in required) else "project fixture handoff omitted a registered project field"
        graph.probe_state("fixtures-installed", "marketplace-fixtures", "project fixture handoff",
                          fixtures_probe,
                          value=lambda: json.loads(Path(fixture_file).read_text(encoding="utf-8")))
        def marketplace_lifecycle() -> str | None:
            if not project_root:
                return "project-registered state did not provide a project root"
            flow_env = env.copy()
            token = service_api_token(graph)
            if token is not None:
                store_report_secret(flow_env, "KB_JOURNEY_SERVICE_TOKEN", token,
                                    "marketplace lifecycle service API bearer")
            flow_env["KB_JOURNEY_PLATFORM_ROOT"] = journey_value("KB_JOURNEY_PLATFORM_ROOT", required=True)
            flow_env["KB_JOURNEY_REGISTRY"] = journey_value("KB_JOURNEY_REGISTRY", "http://verdaccio:4873")
            run_marketplace_steps(journey, project_root, project_id, registry, flow_env,
                                  fixture_entry=fixture_entry)

        graph.flow("marketplace lifecycle assertions", "marketplace-lifecycle", "marketplace",
                   marketplace_lifecycle,
                   record_empty_success=False)

        def registry_marketplace_lane() -> str | None:
            if not project_root:
                return "project-registered state did not provide the Registry lane project root"
            flow_env = env.copy()
            token = service_api_token(graph)
            if token is not None:
                store_report_secret(flow_env, "KB_JOURNEY_SERVICE_TOKEN", token,
                                    "Registry Marketplace lane service API bearer")
            flow_env["KB_JOURNEY_PLATFORM_ROOT"] = journey_value("KB_JOURNEY_PLATFORM_ROOT", required=True)
            flow_env["KB_JOURNEY_REGISTRY"] = journey_value("KB_JOURNEY_REGISTRY", "http://verdaccio:4873")
            # This runner has its own installed project/platform lifecycle; its Marketplace lock is not the shared npm fixture lock.
            entry = prepare_registry_commit_project_fixture(journey, project_root, registry, flow_env, run_command)
            if entry is None:
                return "Registry lane did not capture the verified Commit provenance entry"
            run_ordered_source_journey_steps(journey, project_root, flow_env, run_command)
            return None

        graph.flow("Registry ordered-source Marketplace assertions", "marketplace-registry",
                   "marketplace-registry", registry_marketplace_lane, record_empty_success=False)
        export_project_state_to_child_environment(graph)
        declared_steps = list(checks(args.mode, graph))
        run_service_steps(journey, declared_steps, args.mode, graph=graph)
        def install_project_agent_plugin() -> str | None:
            if not project_root:
                return "project-registered state did not provide a project root"
            install_project_agents_plugin(project_root, registry, os.environ.copy())
            return None

        graph.probe_state(
            "agent-plugin-installed", "agent-session", "project Agents plugin",
            install_project_agent_plugin,
        )

        def run_project_agent_session() -> str | None:
            if not project_id:
                return "project-registered state did not provide a project ID"
            return run_agent_session_steps(
                journey, project_id, service_api_token(graph),
                journey_value("KB_JOURNEY_AGENT_ID", "orchestrator"))

        graph.flow("project agent session flows", "agent-session", "agent-session",
                   run_project_agent_session,
                   cases=["S-141.1", "S-141.2"], record_empty_success=False)
        graph.flow("analytics extras", "analytics", "analytics",
                   lambda: run_analytics_steps(
                       journey, token=service_api_token(graph), project_id=project_id,
                       project_root=project_root,
                       project_b_id=(service_project_b(graph).get("projectBId", "")
                                     if graph.states.get("fixtures-installed", {}).get("passed") is True else ""),
                       project_b_root=(service_project_b(graph).get("projectBRoot", "")
                                       if graph.states.get("fixtures-installed", {}).get("passed") is True else "")),
                   cases=["S-191.1", "S-201.3"], record_empty_success=False)
        graph.flow("gateway extras", "gateway-extra", "gateway-extra",
                   lambda: run_gateway_steps(
                       journey, token=service_api_token(graph), project_id=project_id,
                       project_root=project_root,
                       project_b_id=(service_project_b(graph).get("projectBId", "")
                                     if graph.states.get("fixtures-installed", {}).get("passed") is True else ""),
                       project_b_root=(service_project_b(graph).get("projectBRoot", "")
                                       if graph.states.get("fixtures-installed", {}).get("passed") is True else "")),
                   cases=["S-017.1", "S-017.2", "S-017.3", "S-017.4", "S-017.5",
                          "S-018.1", "S-018.2", "S-018.3", "S-189.2",
                          "S-189.3", "S-189.4", "S-189.5", "S-189.6", "S-189.7", "S-190.1", "S-190.2"],
                   record_empty_success=False)
        graph.dispatch_step("discover platform adapter method catalog", "gateway-extra", "gateway-extra",
                   lambda: run_adapter_catalog_step(
                       journey, token=service_api_token(graph)),
                   cases=["S-189.1"])
        if project_root:
            _run_installed_flows(journey, project_root, registry, graph)
        else:
            reason = ("blocked by state project-registered: "
                      + graph.state_failure("project-registered"))
            journey.blocked("marketplace and adapter user flows", "marketplace", reason,
                            cases=["S-010.1", "S-054.1"])
            journey.blocked("plugin author flow", "plugin-author", reason,
                            cases=["S-014.1", "S-015.1"])
    except Exception as error:
        diagnostics = Path(args.output).resolve().with_name("journey-diagnostics.log")
        write_report_text(diagnostics,
                          "\n== unexpected exception in service runner ==\n" + traceback.format_exc(),
                          append=True, env=os.environ)
        journey.step("service runner", "journey.runner", lambda: str(error) or error.__class__.__name__,
                      role="lifecycle")
    finally:
        kb_home = Path(os.getenv("KB_HOME", str(Path.home() / ".kb")))
        def archive_logs() -> None:
            archive_service_logs(
                kb_home, Path(args.output).resolve().parent,
                platform_root=journey_value("KB_JOURNEY_PLATFORM_ROOT", required=True),
                mode=args.mode, run_id=journey.run_id,
            )

        journey.step(
            "archive runtime service logs",
            "journey.diagnostics",
            archive_logs,
            role="lifecycle",
        )
        result = journey.result()
        output_payload = {**result.__dict__, "states": graph.states}
        output_payload = write_report_json(args.output, output_payload, env=os.environ)
    print_report_text(json.dumps(output_payload, indent=2), env=os.environ)
    return journey_result_exit_code(result)


def journey_result_exit_code(result: JourneyResult) -> int:
    return 0 if result.status == "PASS" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print_report_text(f"Service journey runner failed: {error.__class__.__name__}: {error}",
                          stream=sys.stderr, flush=True)
        raise SystemExit(1)
