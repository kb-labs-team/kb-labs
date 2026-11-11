#!/usr/bin/env python3
"""One isolated end-user install journey; each invocation runs in a fresh container."""
from __future__ import annotations

from mcp_tool_names import DEFAULT_ENABLED_SERVICES, commit_tool, service_tool_names

from kb_invocation import kb_command, kb_login_shell, kb_login_shell_sequence
from installed_fixture import layout_relative, layout_value
from journey_values import journey_value

import json
import base64
import os
import re
import stat
import shutil
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Callable, Union

from studio_steps import (create_studio_access_tokens, create_studio_environment,
                          create_studio_member, run_studio_browser_step,
                          studio_playwright_output_directory)
from studio_fixture_steps import prepare_studio_fixtures
from platform_update_steps import run_platform_update_steps
from bootstrap_secret_steps import (register_install_password_absence_step,
                                    register_supplied_password_absence_step)
from platform_update_variant_steps import run_platform_update_variant_steps
from platform_channel_steps import run_platform_channel_steps
from installer_case_steps import (run_doctor_root_isolation_step,
                                  run_installer_case_steps, run_invalid_request_step,
                                  run_apply_scenario_step,
                                  run_uninstall_decline_step, run_missing_project_request_steps,
                                  commit_marketplace_install_record,
                                  add_installed_host_stop_case_step)
from installer_case_steps import parse_install_refusal
from journey_resources import case_catalog_root, journey_module, parse_shell_commands, resource_root, workspace_resource
from project_service_path import project_service_path
from release_index import channel_platform_version, stable_platform_version
from service_steps import (FlowGraph, Journey, JourneyContractError, record_candidate_provenance, record_runner_failure,
                           record_runner_exception, replay_steps)
from journey_dependencies import FLOW_GRAPH_STATE_PRODUCERS
from journey_selection import (JourneySelectionError, active_journey_selection,
                               read_journey_selection, use_journey_selection)
from workflow_steps import merge_workflow_result, prepare_workflow_fixtures, run_workflow_journey
from select_from_cases import fixture_group_declarations, journey_source_group_declaration
from steps.auth import (run_bootstrap_recovery_steps, run_cli_auth_forbidden, run_cli_auth_status,
                        run_cli_corrupt_session_file, run_local_auth_steps, run_secured_auth_steps)
from steps.accounts import (run_api_token_lifecycle_steps, run_cli_logout_steps, run_invite_lifecycle_steps,
                            run_last_admin_guard_steps, run_password_and_session_steps)
from platform_state_dump import PlatformStateDumpOnce, failure_dump_environment
from scoreboard import release_claims_for_case, write_scoreboards
from invocations import (
    CompletedProcess,
    TimeoutExpired,
    decode_ux_error_result,
    decode_ux_success_result,
    describe_cli_failure,
    catalogued_error_hint,
    invocation_context,
    open_http,
    print_report_text,
    read_kb_create_cli_result,
    read_ux_cli_result,
    read_ux_cli_stream,
    run_command,
    run_pty_command,
    start_background_command,
    store_report_secret,
    write_report_text,
)

INSTALLER = "/usr/local/share/kb-create/install.sh"
FRONT_DOOR = journey_value("KB_JOURNEY_FRONT_DOOR", "agent")
SCENARIO = journey_value("KB_JOURNEY_SCENARIO", "commit")
VARIANT = journey_value("KB_JOURNEY_VARIANT", "default")
REGISTRY = journey_value("KB_JOURNEY_REGISTRY", "http://verdaccio:4873")
BASE_ENV = MappingProxyType(os.environ.copy())
HOME = Path(tempfile.mkdtemp(prefix="kb-journey-home-"))
BIN = HOME / ".local" / "bin"
PLATFORM = HOME / "kb-platform"
PLATFORM_CURRENT = PLATFORM / layout_value('currentLink')
PROJECT = HOME / "fresh-project"
TIMES: dict[str, float] = {}
MAX_PNPM_RSS_MIB = 0.0
PLATFORM_SIZE_MIB: float | None = None
FIRST_FAILURE = ""
CASE_JOURNEY: Journey | None = None
SELECTED_CLAIM_COMPLETION_CHECKED = False
ACTIVE_OUTER_GRAPH: FlowGraph | None = None
ACTIVE_MAIN_ENV: dict[str, str] | None = None
ACTIVE_LAUNCHER: str | None = None
LAST_COMMAND_ENV: dict[str, str] = BASE_ENV.copy()
LAST_COMMAND_CWD: str | None = None


def marketplace_install_flags(env: dict[str, str]) -> list[str]:
    """Configure the journey npm mirror and translate Registry secrets to env references."""
    registry_url = env.get("KB_JOURNEY_MARKETPLACE_REGISTRY_URL", "")
    encoded_key = env.get("KB_JOURNEY_MARKETPLACE_PUBLIC_KEY_B64", "")
    if bool(registry_url) != bool(encoded_key):
        raise ValueError("journey Marketplace Registry URL and generated public key must be configured together")
    flags = []
    if registry_url:
        try:
            key = base64.b64decode(encoded_key, validate=True).decode("utf-8")
        except (ValueError, UnicodeDecodeError) as error:
            raise ValueError("journey Registry public key is not valid base64-encoded UTF-8") from error
        env["KB_JOURNEY_MARKETPLACE_PUBLIC_KEY"] = key
        store_report_secret(env, "KB_JOURNEY_MARKETPLACE_TOKEN",
                            "journey-registry-token-reference-test-value", "journey Marketplace Registry token")
        flags.extend(["--marketplace-registry-url", registry_url,
                      "--marketplace-registry-public-key-env", "KB_JOURNEY_MARKETPLACE_PUBLIC_KEY",
                      "--marketplace-registry-token-env", "KB_JOURNEY_MARKETPLACE_TOKEN"])
    flags.extend(["--marketplace-npm-url", REGISTRY])
    return flags


STATE_DUMP_GUARD = PlatformStateDumpOnce()
RUNNER_SCENARIOS = {
    "commit": {
        "installer": "commit",
        "secured_installer": "custom",
        "secured_marketplace_packages": ("@kb-labs/commit",),
        "command_help_paths": (("commit", "commit", "--help"),),
    },
    "explore": {
        "installer": "explore",
        "secured_installer": "custom",
        "secured_marketplace_packages": (),
        "command_help_paths": (),
    },
}


def runner_scenario(name: str, *, secured: bool) -> dict:
    """Describe what an installed runner scenario provisions and later exercises."""
    description = RUNNER_SCENARIOS.get(name)
    if description is None:
        raise ValueError(f"unknown journey scenario {name!r}")
    return {
        "installer": description["secured_installer"] if secured else description["installer"],
        "marketplace_packages": description["secured_marketplace_packages"] if secured else (),
        "command_help_paths": description["command_help_paths"],
    }
OUTER_GROUP_DEPENDENCIES = {
    "install": (),
    "host": ("platform-installed",),
    "auth": ("host-running",),
    "update": ("host-running", "platform-version-known", "project-registered"),
    "update-variants": ("host-running", "platform-version-known", "project-registered", "fixtures-installed"),
    "project": ("host-running", "platform-version-known"),
    "marketplace": ("host-running", "project-registered"),
    "marketplace-fixtures": ("host-running", "project-registered", "marketplace-available"),
    "adapters": ("host-running", "project-registered"),
    "plugin-author": ("host-running", "project-registered", "fixtures-installed", "session"),
    "workflow": ("host-running", "project-registered", "platform-version-known", "fixtures-installed", "adapter-defaults"),
    "analytics": ("host-running", "project-registered", "fixtures-installed"),
    "studio": ("host-running", "project-registered", "workflow-ready", "fixtures-installed", "adapter-defaults"),
    "uninstall": (),
}
OUTER_GROUP_PRODUCES = {
    group: tuple(state for state, producer in FLOW_GRAPH_STATE_PRODUCERS.items()
                 if producer == group)
    for group in dict.fromkeys(FLOW_GRAPH_STATE_PRODUCERS.values())
}
def block_outer_dependents(graph: FlowGraph, groups: list[str]) -> None:
    for group in groups:
        graph.flow(f"{group} flow", group, group,
                   lambda: None, record_empty_success=False)


def uninstall_shim_result_matches(payload: dict, install_root: Path) -> bool:
    action = payload.get("shimAction")
    if action == "removed":
        return True
    if action == "left":
        return payload.get("shimOwner") == str(install_root.resolve())
    return action == "left-foreign" and not payload.get("shimOwner")


def uninstall_human_summary_has_shim_result(output: str, install_root: Path) -> bool:
    return ("The kb command was removed." in output
            or f"The kb command remains with its owner at {install_root.resolve()}." in output
            or "The existing kb command was left untouched because its owner could not be verified." in output)


DOCTOR_ROOT_ISOLATION_GROUP = run_doctor_root_isolation_step
INSTALLER_CASE_GROUP = run_installer_case_steps
APPLY_SCENARIO_GROUP = run_apply_scenario_step
INVALID_REQUEST_GROUP = run_invalid_request_step
MISSING_PROJECT_REQUEST_GROUP = run_missing_project_request_steps
ISOLATED_FIXTURE_GROUPS = (DOCTOR_ROOT_ISOLATION_GROUP, INSTALLER_CASE_GROUP,
                           APPLY_SCENARIO_GROUP, INVALID_REQUEST_GROUP,
                           MISSING_PROJECT_REQUEST_GROUP)


def outer_selection_groups() -> dict[str, dict]:
    from service_runner import SERVICE_GROUPS
    groups = dict(SERVICE_GROUPS)
    for group, dependencies in OUTER_GROUP_DEPENDENCIES.items():
        spec = dict(groups.get(group, {}))
        spec["capabilities"] = set(spec.get("capabilities", ())) | {group}
        spec["depends_on"] = tuple(dict.fromkeys((*spec.get("depends_on", ()), *dependencies)))
        groups[group] = spec
    for group, produced_states in OUTER_GROUP_PRODUCES.items():
        spec = dict(groups.get(group, {}))
        spec["produces"] = produced_states
        groups[group] = spec
    for group, source in (
            ("marketplace-lifecycle", "e2e/journey/marketplace_steps.py"),
            ("update", "e2e/journey/platform_update_steps.py"),
            ("update-variants", "e2e/journey/platform_update_variant_steps.py")):
        resolved = journey_source_group_declaration(source, resource_root())
        spec = dict(groups.get(group, {}))
        spec["cases"] = tuple(sorted(set(spec.get("cases", ())) | set(resolved["cases"])))
        spec["steps"] = tuple(sorted(set(spec.get("steps", ())) | set(resolved["steps"])))
        groups[group] = spec
    fixture_specs = fixture_group_declarations(
        ISOLATED_FIXTURE_GROUPS,
        CASE_JOURNEY.runner_selector if CASE_JOURNEY is not None else "",
        resource_root(),
    )
    for name, declaration in fixture_specs.items():
        groups[f"isolated-fixture:{name}"] = declaration
    return groups


def journey_verdict_detail(result: dict) -> str:
    """Format a run verdict with the row that caused it, including BLOCKED-only results."""
    row = result.get("first_failure")
    if not row and result.get("status") == "BLOCKED":
        row = next((step for step in result.get("steps", []) if step.get("status") == "BLOCKED"), None)
    if not row:
        return f"journey returned {result.get('status', 'unknown')} without a failing row"
    return f"{row.get('name') or 'journey step'}: {row.get('message') or 'no failure message'}"


def confirmation_hint_matches_invocation(hint: str, invocation: list[str]) -> bool:
    """Check that a confirmation hint reruns this command with explicit consent."""
    prefix, separator, command_and_suffix = hint.partition("`")
    if prefix != "rerun " or not separator:
        return False
    command, closing, suffix = command_and_suffix.partition("`")
    if not closing or suffix:
        return False
    return parse_shell_commands(command) == [[Path(invocation[0]).name, *invocation[1:], "--yes"]]


def reject_unprepared_studio_flow() -> None:
    raise RuntimeError("Studio browser flow was selected without running its setup")


def export_graph_state_to_child_environment(graph: FlowGraph, env: dict[str, str]) -> None:
    """Serialize graph state once at the child-process boundary."""
    env["KB_JOURNEY_STATES"] = json.dumps(graph.states)


@dataclass(frozen=True)
class ProjectRegistration:
    project_id: str
    root: str
    name: str


@dataclass(frozen=True)
class ProjectBRootValid:
    project_id: str
    root: Path


@dataclass(frozen=True)
class ProjectBRootInvalid:
    diagnostic: dict


ProjectBRootHandoff = Union[ProjectBRootValid, ProjectBRootInvalid]


def project_registration_from_state(value: object) -> ProjectRegistration:
    """Parse a passed state value into the non-optional project contract."""
    project = value
    if (not isinstance(project, dict) or not isinstance(project.get("id"), str) or not project["id"]
            or not isinstance(project.get("root"), str) or not project["root"]
            or not isinstance(project.get("name"), str)):
        raise JourneyContractError("project-registered state passed without a valid project result")
    return ProjectRegistration(project_id=project["id"], root=project["root"], name=project["name"])


def project_b_fixture_from_state(graph: FlowGraph) -> ProjectBRootHandoff:
    """Resolve the fixtures-installed state to a validated Project B handoff."""
    state = graph.states.get("fixtures-installed")
    value = state.get("value") if state else None
    project_id = value.get("projectBId") if isinstance(value, dict) else None
    serialized_root = value.get("projectBRoot") if isinstance(value, dict) else None
    if state is None or state.get("passed") is not True or "value" not in state:
        return invalid_project_b_root(serialized_root, graph.state_failure("fixtures-installed"))
    return validate_project_b_root(project_id, serialized_root)


def invalid_project_b_root(serialized_value: object, reason: str, *,
                           realpath: str | None = None, mode: int | None = None,
                           owner: dict[str, int] | None = None) -> ProjectBRootInvalid:
    diagnostic = {
        "code": "PROJECT_B_ROOT_INVALID",
        "serializedValue": serialized_value,
        "realpath": realpath,
        "mode": mode,
        "owner": owner,
        "reason": reason,
    }
    return ProjectBRootInvalid(diagnostic)


def validate_project_b_root(project_id: object, serialized_value: object) -> ProjectBRootHandoff:
    """Validate the fixture's host-visible Project B identity and root at handoff."""
    if not isinstance(serialized_value, str) or not serialized_value:
        return invalid_project_b_root(serialized_value, "must be a non-empty directory path")

    candidate = Path(serialized_value)
    try:
        resolved = candidate.resolve(strict=True)
        info = resolved.stat()
        metadata = {
            "realpath": str(resolved),
            "mode": stat.S_IMODE(info.st_mode),
            "owner": {"uid": info.st_uid, "gid": info.st_gid},
        }
        if not stat.S_ISDIR(info.st_mode):
            return invalid_project_b_root(serialized_value, "not a directory", **metadata)
        if not os.access(resolved, os.W_OK):
            return invalid_project_b_root(serialized_value, "not writable", **metadata)
        if not isinstance(project_id, str) or not project_id:
            return invalid_project_b_root(serialized_value, "fixture state has no registered Project B ID", **metadata)
        return ProjectBRootValid(project_id=project_id, root=resolved)
    except OSError as error:
        reason = "missing or inaccessible"
        if error.errno not in (None, 2, 13):
            reason = f"filesystem error: {error.strerror}"
        return invalid_project_b_root(serialized_value, reason)


def invalidate_project_b_handoff(graph: FlowGraph, handoff: ProjectBRootHandoff) -> None:
    if isinstance(handoff, ProjectBRootInvalid):
        graph.invalidate_state(
            "fixtures-installed",
            group="journey",
            step="Project B fixture handoff",
            evidence=json.dumps(handoff.diagnostic, sort_keys=True),
        )


def cleanup_partial_install(graph: FlowGraph, env: dict[str, str], launcher: str) -> None:
    if (PLATFORM_CURRENT / ".kb" / "v2" / "receipt.json").is_file():
        _run_final_uninstall(graph, env, launcher)


def probe_platform_state(graph: FlowGraph, env: dict[str, str], launcher: str,
                         expected_version: str | None = None, *,
                         mutator_group: str = "install", mutator_step: str = "platform bootstrap",
                         include_installed: bool = True, include_version: bool = True,
                         include_host: bool = True, required: bool = False) -> None:
    receipt_path = PLATFORM_CURRENT / ".kb/v2/receipt.json"

    def version_probe() -> str | None:
        try:
            receipt = json.loads(receipt_path.read_text())
            actual = receipt.get("plan", {}).get("serviceGraph", {}).get("platformVersion")
        except (OSError, json.JSONDecodeError, AttributeError):
            return "active platform receipt is missing or unreadable"
        if not isinstance(actual, str) or not actual:
            return "active platform receipt has no platform version"
        if expected_version is not None and actual != expected_version:
            return f"active receipt version is {actual}; expected {expected_version}"
        graph.states["expected-platform-version"] = actual
        return None

    if include_installed:
        graph.probe_state("platform-installed", "install", "platform bootstrap",
                          lambda: None if receipt_path.is_file() else "installed V2 receipt is missing",
                          required=required)
    if include_version:
        graph.probe_state("platform-version-known", mutator_group, mutator_step,
                          version_probe, required=required)

    if include_host:
        graph.probe_state("host-running", mutator_group, mutator_step,
                          lambda: host_running_probe(env, launcher), required=required)


def host_running_probe(env: dict[str, str], launcher: str) -> str | None:
    """Verify the installed host before scheduling any state that depends on it."""
    result, _ = run([launcher, "status", "--platform-root", str(PLATFORM), "--json"], env=env, timeout=120)
    try:
        payload = decode_ux_success_result(read_kb_create_cli_result("status", result))
        if (result.returncode != 0 or payload.get("running") is not True
                or payload.get("reachable") is not True):
            return f"kb-create status reports running={payload.get('running')!r}, reachable={payload.get('reachable')!r}"
    except (json.JSONDecodeError, ValueError, AttributeError) as error:
        return f"kb-create status could not establish host health: {error}"
    status, _, _ = open_http(urllib.request.urlopen,
                             urllib.request.Request("http://127.0.0.1:4000/ready"),
                             timeout=10, env=env)
    return None if status == 200 else f"gateway /ready returned HTTP {status}"


def reestablish_host_and_session(graph: FlowGraph, mutation: str,
                                 host_probe: Callable[[], str | None],
                                 login: Callable[[], None]) -> None:
    """Restore the host state before signing in and publishing the dependent session state."""
    graph.probe_state("host-running", "host", mutation, host_probe)
    if graph.states.get("host-running", {}).get("passed") is not True:
        return
    login()
    graph.probe_state("session", "auth", "fresh admin CLI login", lambda: None)


def establish_initial_secured_session(graph: FlowGraph, login: Callable[[], None]) -> None:
    """Sign in before any secured project probe can invoke protected CLI commands."""
    login()
    graph.probe_state("session", "auth", "secured administrator login", lambda: None)


def establish_project_registration(graph: FlowGraph, project_root: Path, env: dict[str, str]) -> None:
    """Acquire and verify installed project identity as the project-registered state value."""
    project: dict[str, str] = {}
    flow_name = "verify installed project registration"

    def inspect_current_project() -> str | None:
        project_show, _ = run(kb_login_shell(["project", "show", "--json"]),
                              env=env, cwd=project_root, timeout=90)
        try:
            payload = decode_ux_success_result(read_ux_cli_result(project_show))
            project_id = find_project_id(payload)
            details = payload.get("project", payload) if isinstance(payload, dict) else {}
            project["name"] = str(details.get("name") or "") if isinstance(details, dict) else ""
            project["id"] = project_id
        except (json.JSONDecodeError, ValueError):
            project["id"] = ""
        if project_show.returncode != 0:
            return f"kb project show exited {project_show.returncode}: {' '.join(project_show.stdout.split())[-500:]}"
        if not project.get("id"):
            return "kb project show did not find the project registered by installation"
        return None

    graph.flow(flow_name, "project", "projects", inspect_current_project,
               role="lifecycle", record_empty_success=False)

    def verify_registration() -> str | None:
        flow_status, flow_message = graph.journey.flows[flow_name]
        if flow_status != "PASS":
            return flow_message
        listed, _ = run(kb_command([ "project", "list", "--json"], executable=str(BIN / "kb")),
                        env=env, cwd=project_root, timeout=90)
        try:
            payload = decode_ux_success_result(read_ux_cli_result(listed))
        except (json.JSONDecodeError, ValueError) as error:
            return f"kb project list could not verify project registration: {error}"
        if listed.returncode != 0:
            return f"kb project list exited {listed.returncode}: {' '.join(listed.stdout.split())[-500:]}"
        if project["id"] not in json.dumps(payload):
            return f"kb project list did not contain registered ID {project['id']}"
        return None

    graph.probe_state("project-registered", "project", "kb project show/list", verify_registration,
                      after_flow=flow_name,
                      value=lambda: {"id": project["id"], "root": str(project_root.resolve()),
                                     "name": project.get("name", "")})


def record_case(name: str, passed: bool, message: str, *, cases: list[str],
                requires: tuple[str, ...] = (), details: dict | None = None,
                runners: tuple[str, ...] = ()) -> None:
    if CASE_JOURNEY is None:
        return
    CASE_JOURNEY.step(name, "platform.install", lambda: None if passed else message, cases=cases,
                      requires=requires, details=(lambda: details) if details is not None else None,
                      runners=runners)


def handle_json_install_failure(operation: str, result: CompletedProcess) -> bool:
    if operation != "install" or result.returncode == 0:
        return False
    refusal = parse_install_refusal(result)
    if refusal is None:
        fail("kb-create install --json: failed without a parseable product error envelope")
        return True
    message = (f"{refusal['code']}: {refusal['message']}; "
               f"cause={refusal.get('cause', '')}; hint={refusal.get('hint', '')}")
    record_case("JSON install progress", False, message,
                cases=["PC-001.17", "S-203.10", "S-203.13"],
                details={"productEnvelope": refusal})
    fail(f"kb-create install --json: {message}")
    return True


def run(args: list[str], *, env=None, cwd=None, timeout=900, input_text=None):
    global MAX_PNPM_RSS_MIB, LAST_COMMAND_ENV, LAST_COMMAND_CWD
    LAST_COMMAND_ENV = dict(env or BASE_ENV)
    LAST_COMMAND_CWD = str(cwd) if cwd else str(Path.cwd())
    child_env = env or BASE_ENV
    started = time.monotonic()
    result = run_command(args, cwd=cwd or Path.cwd(), env=child_env, timeout=timeout,
                         input=input_text,
                         monitor_process=lambda pid: _sample_pnpm_rss_for_run(pid))
    duration = time.monotonic() - started
    return CompletedProcess(args, result.returncode,
                                       stdout=result.stdout or "",
                                       stderr=result.stderr or ""), duration


def installer_command(args: list[str], *, env: Mapping[str, str], secret: str,
                      input: str | None = None) -> CompletedProcess[str]:
    installer_env = dict(env)
    if "--secret-env" in args:
        store_report_secret(installer_env, "KB_JOURNEY_ADMIN_PASSWORD", secret,
                            "installer scenario password")
    return run(args, env=installer_env, timeout=1200, input_text=input)[0]


def _sample_pnpm_rss_for_run(pid: int) -> None:
    global MAX_PNPM_RSS_MIB
    MAX_PNPM_RSS_MIB = max(MAX_PNPM_RSS_MIB, sample_pnpm_rss(pid))


def run_tty_confirmation(args: list[str], *, env=None, timeout=900):
    confirmed = False
    def respond(transcript: str):
        nonlocal confirmed
        if not confirmed and "Continue? [y/N]" in transcript:
            confirmed = True
            return "y\n"
        return None
    return run_pty_command(args, env=env or BASE_ENV, timeout=timeout, on_output=respond)


def sample_pnpm_rss(_root_pid: int) -> float:
    peak_kib = 0
    for proc_root in Path("/proc").iterdir():
        if not proc_root.name.isdigit():
            continue
        try:
            command = (proc_root / "cmdline").read_bytes().replace(b"\0", b" ").lower()
            if b"pnpm" not in command:
                continue
            for line in (proc_root / "status").read_text().splitlines():
                if line.startswith("VmRSS:"):
                    peak_kib = max(peak_kib, int(line.split()[1]))
                    break
        except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError, OSError):
            continue
    return peak_kib / 1024


def fail(message: str):
    global FIRST_FAILURE
    if not FIRST_FAILURE:
        FIRST_FAILURE = message


def write_journey_diagnostic(message: str, *, env=None) -> None:
    report = Path(journey_value("KB_JOURNEY_SUMMARY", "/summary/journey-summary.md"))
    write_report_text(report.with_name("journey-diagnostics.log"), message,
                      env=env or BASE_ENV, append=True)


def log_group_exception(group: str) -> None:
    write_journey_diagnostic(f"\n== unexpected exception in {group} ==\n{traceback.format_exc()}")


def configure_secured_platform(
    env: dict[str, str], launcher: str, *, configure_oidc: bool = False, run_command=run,
) -> tuple[str, CompletedProcess] | None:
    """Apply secured journey config through the authenticated CLI session."""
    home = Path(env["HOME"])
    settings = []
    if configure_oidc:
        settings.append(("gateway.auth.providers", json.dumps({
            "email-password": {"type": "email-password"},
            "corp": {
                "type": "oidc",
                "issuer": "https://idp-stub:9443",
                "clientId": "kb-gateway",
                "clientSecretEnv": "OIDC_CORP_CLIENT_SECRET",
                "scopes": ["openid", "email"],
                "pkce": True,
            },
        })))
    if not settings:
        return None
    for key, value in settings:
        configured, _ = run_command(
            kb_login_shell(["config", "set", "--scope", "platform", key, value, "--json"]),
            env=env, cwd=home, timeout=90,
        )
        if configured.returncode != 0:
            return key, configured
    restarted, _ = run_command(
        [launcher, "restart", "--platform-root", env["KB_JOURNEY_PLATFORM_ROOT"]],
        env=env, cwd=home, timeout=180,
    )
    if restarted.returncode != 0:
        return "kb-create restart", restarted
    return None


def login_and_configure_secured_admin(
    env: dict[str, str], launcher: str, *, configure_oidc: bool = False, run_command=run,
) -> tuple[str, CompletedProcess] | None:
    """Sign in the bootstrap admin before making authenticated platform config changes."""
    project = PROJECT
    login, _ = run_command(
        kb_login_shell(["auth", "login", "--gateway-url", "http://127.0.0.1:4000", "--email",
                        env["KB_JOURNEY_ADMIN_EMAIL"], "--password", env["KB_JOURNEY_ADMIN_PASSWORD"]]),
        env=env, cwd=project, timeout=90,
    )
    if login.returncode != 0:
        return "kb auth login", login
    return configure_secured_platform(env, launcher, configure_oidc=configure_oidc, run_command=run_command)


def dump_failure_state() -> None:
    report = Path(journey_value("KB_JOURNEY_SUMMARY", "/summary/journey-summary.md"))
    mode = "secured" if VARIANT.endswith("secured") else "local"
    STATE_DUMP_GUARD.dump(
        PLATFORM, report.parent, mode=mode, front=FRONT_DOOR, scenario=SCENARIO,
        variant=VARIANT, first_failure=FIRST_FAILURE or "journey reported FAIL",
        env=failure_dump_environment(ACTIVE_MAIN_ENV, LAST_COMMAND_ENV, BASE_ENV),
        cwd=LAST_COMMAND_CWD, admin_password="JourneyPassw0rd!" if mode == "secured" else "",
    )


def failure_exit() -> int:
    dump_failure_state()
    return 1


def capture_case_failure() -> None:
    if CASE_JOURNEY is None or CASE_JOURNEY.result().status != "FAIL" or FIRST_FAILURE:
        return
    first = CASE_JOURNEY.result().first_failure or {}
    fail(f"{first.get('name', 'journey step')}: {first.get('message', 'reported FAIL')}")


def check_selected_claim_completion(journey_results: list[dict]) -> list[str]:
    """Fail the run if selected claims were not recorded by any of its journeys."""
    missing = (CASE_JOURNEY.missing_selected_claims(journey_results)
               if CASE_JOURNEY is not None else [])
    if missing:
        fail("selected claim steps did not execute: " + ", ".join(missing)
             + "; the selected runner did not call their registered step functions")
    return missing


def check_selected_step_completion(journey_results: list[dict], selected_steps: dict[str, list[str]]) -> list[str]:
    """Fail if a resolver-selected owning or prerequisite step produced no journey row."""
    recorded = {
        step.get("name")
        for result in journey_results
        for step in result.get("steps", [])
        if isinstance(step.get("name"), str)
    }
    missing = sorted(set(selected_steps) - recorded)
    for name in missing:
        claims = ", ".join(sorted(selected_steps[name])) or "selected claim"
        message = f"selected step never ran: {name} (claim {claims})"
        if CASE_JOURNEY is not None:
            CASE_JOURNEY.step(message, "journey.selection", lambda message=message: message,
                              cases=selected_steps[name], role="lifecycle")
        fail(message)
    return missing


class OrderedPromptResponder:
    """Answer only when the PTY owner observes a real terminal read."""

    def __init__(self, expectations: list[tuple[str, str]]):
        self.expectations = [(re.compile(pattern, re.I), answer) for pattern, answer in expectations]
        self.position = 0
        self.cursor = 0

    def __call__(self, transcript: str) -> str | None:
        visible = self._normalize_redraws(transcript[self.cursor:])
        if self.position >= len(self.expectations):
            raise RuntimeError(f"unexpected wizard prompt output {visible!r}; no prompt was expected")
        pattern, answer = self.expectations[self.position]
        if not pattern.search(visible):
            raise RuntimeError(
                f"unexpected wizard prompt {visible!r}; expected prompt {pattern.pattern!r}")
        self.position += 1
        self.cursor = len(transcript)
        return answer + "\n"

    @staticmethod
    def _normalize_redraws(output: str) -> str:
        rows: list[str] = []
        line = ""
        output = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output)
        offset = 0
        while offset < len(output):
            character = output[offset]
            if character == "\r":
                if offset + 1 < len(output) and output[offset + 1] == "\n":
                    if line:
                        rows.append(line)
                    line = ""
                    offset += 1
                else:
                    line = ""
            elif character == "\n":
                if line:
                    rows.append(line)
                line = ""
            else:
                line += character
            offset += 1
        if line:
            rows.append(line)
        return "\n".join(rows).strip()

    def finish(self, transcript: str) -> None:
        missing = [pattern.pattern for pattern, _ in self.expectations[self.position:]]
        if missing:
            tail = self._normalize_redraws(transcript[self.cursor:])
            raise RuntimeError(
                f"installer exited before expected prompt {missing[0]!r}; last output was {tail!r}")


def require(result, expected=0, step="command"):
    if result.returncode != expected:
        excerpt = " ".join(result.stdout.split())[-700:]
        fail(f"{step}: exit {result.returncode}; {excerpt or 'no output'}")
        return False
    return True


def mcp_rpc(url: str, method: str, request_id: int, params=None, token=None):
    payload = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        payload["params"] = params
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                 **({"Authorization": f"Bearer {token}"} if token else {})},
        method="POST",
    )
    try:
        status, raw, _ = open_http(urllib.request.urlopen, request, timeout=30, env=os.environ)
        if status >= 400:
            raise RuntimeError(f"MCP {method} returned HTTP {status}")
        body = raw.decode()
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"MCP {method} returned HTTP {error.code}") from error
    if any(line.startswith("data:") for line in body.splitlines()):
        body = "\n".join(line[5:].strip() for line in body.splitlines() if line.startswith("data:"))
    return json.loads(body)


def verify_project_mcp(env: dict[str, str], local: bool, enabled_service_ids: frozenset[str] = DEFAULT_ENABLED_SERVICES):
    registered, _ = run(kb_login_shell(["project", "add", "--json"]),
                        env=env, cwd=PROJECT, timeout=180)
    if not require(registered, step="register project for MCP"):
        return
    try:
        project = decode_ux_success_result(read_ux_cli_result(registered))["project"]
        project_id = project["id"]
        url = f"http://127.0.0.1:4000{project_service_path(project_id, 'mcp')}"
        token = None
        if not local:
            try:
                mcp_rpc(url, "tools/list", 0)
            except RuntimeError as error:
                if "HTTP 401" not in str(error):
                    raise
            else:
                raise RuntimeError("secured MCP accepted a request without a token")
            token = env.get("KB_MCP_TOKEN")
            if not token:
                raise RuntimeError("secured MCP journey needs KB_MCP_TOKEN from gateway login")
        initialized = mcp_rpc(url, "initialize", 1, {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "kb-labs-journey", "version": "1.0.0"},
        }, token)
        if "result" not in initialized:
            raise RuntimeError("initialize returned no result")
        listed = mcp_rpc(url, "tools/list", 2, token=token)
        tools = listed.get("result", {}).get("tools", [])
        names = {tool.get("name") for tool in tools}
        expected = {commit_tool("commit commit"), *service_tool_names(enabled_service_ids), "kb-labs__mcp_diagnostics"}
        if not expected.issubset(names):
            raise RuntimeError(f"tools/list missing expected tools: expected={sorted(expected)} served={sorted(names)[:50]}")
        called = mcp_rpc(url, "tools/call", 3, {"name": "kb-labs__mcp_diagnostics", "arguments": {}}, token)
        content = called.get("result", {}).get("content", [])
        text = "\n".join(item.get("text", "") for item in content)
        if called.get("result", {}).get("isError") or "loaded cleanly" not in text:
            raise RuntimeError(f"diagnostics call had unexpected result: {text}")
    except (KeyError, ValueError, RuntimeError, urllib.error.URLError) as error:
        fail(f"project MCP journey: {error}")


def pty_install(command: list[str], env: dict[str, str], choice: str = "", access_mode: str = "local"):
    global MAX_PNPM_RSS_MIB
    expectations = [(r"Project directory", str(PROJECT)), (r"Platform channel", "stable")]
    if choice:
        expectations.append((r"(?:scenario|journey|setup)", choice))
    if access_mode == "secured":
        expectations.extend([
            (r"Studio access", "secured"),
            (r"Admin email", "journey-admin@example.test"),
            (r"Admin tenant", "journey"),
            (r"Admin password", "JourneyPassw0rd!"),
            (r"Confirm admin password", "JourneyPassw0rd!"),
        ])
    prompt_responder = OrderedPromptResponder(expectations)
    apply_started = None
    started = time.monotonic()
    def respond(transcript: str):
        nonlocal apply_started
        global MAX_PNPM_RSS_MIB
        new_text = transcript[prompt_responder.cursor:]
        if apply_started is None and re.search(r"Applying installation", new_text, re.I):
            apply_started = time.monotonic()
        return None
    prompt_env = dict(env)
    result, duration = run_pty_command(command, env=prompt_env, timeout=900, on_output=respond,
                                       on_read_ready=prompt_responder,
                                       monitor_process=_sample_pnpm_rss_for_run,
                                       start_new_session=True, raise_on_timeout=False)
    prompt_responder.finish(result.stdout)
    return result.returncode, result.stdout, duration, apply_started - started if apply_started else None


def human_text_is_clean(output: str):
    if re.search(r'\{\s*"ok"\s*:|"(?:code|error)"\s*:', output):
        fail("human output contains a raw JSON object")
    if "goroutine " in output or re.search(r"(?m)^panic:", output) or "stack trace" in output.lower():
        fail("human output contains a stack trace")


def finalize_run(passed: bool) -> int:
    global SELECTED_CLAIM_COMPLETION_CHECKED
    report = Path(journey_value("KB_JOURNEY_SUMMARY", "/summary/journey-summary.md"))
    if CASE_JOURNEY is not None and not SELECTED_CLAIM_COMPLETION_CHECKED:
        SELECTED_CLAIM_COMPLETION_CHECKED = True
        journey_results = [journey.result().__dict__ for journey in Journey.run_instances()]
        mode = CASE_JOURNEY.mode
        service_report = report.with_name(f"service-{mode}.json")
        if service_report.is_file():
            try:
                journey_results.append(json.loads(service_report.read_text(encoding="utf-8")))
            except (OSError, UnicodeError, json.JSONDecodeError) as error:
                fail(f"service runner result could not be read for selected claim completion: {error}")
        selected_owning_steps = CASE_JOURNEY.selected_owning_steps if CASE_JOURNEY is not None else {}
        missing_selected_steps = check_selected_step_completion(journey_results, selected_owning_steps)
        missing_selected = check_selected_claim_completion(journey_results)
        passed = passed and not missing_selected and not missing_selected_steps and not FIRST_FAILURE
    root_size = PLATFORM_SIZE_MIB
    if root_size is None:
        root_size = 0.0
        if PLATFORM.exists():
            root_size = sum(p.stat().st_size for p in PLATFORM.rglob("*") if p.is_file()) / (1024 * 1024)
    title = f"{FRONT_DOOR}/{SCENARIO}" if VARIANT == "default" else VARIANT
    lines = [f"| {title} | {'PASS' if passed else 'FAIL'} | {FIRST_FAILURE or 'all assertions passed'} | "
             f"{TIMES.get('install.sh', 0):.1f}s | {TIMES.get('questions', 0):.1f}s | "
             f"{TIMES.get('apply', 0):.1f}s | {TIMES.get('start', 0):.1f}s | "
             f"{TIMES.get('first command', 0):.1f}s | "
             f"{sum(TIMES.values()):.1f}s | {root_size:.1f} MiB | {MAX_PNPM_RSS_MIB:.1f} MiB |"]
    report.parent.mkdir(parents=True, exist_ok=True)
    if CASE_JOURNEY is not None:
        CASE_JOURNEY.write_json(report.with_name(
            f"installer-case-{CASE_JOURNEY.mode}-{FRONT_DOOR}-{SCENARIO}-{VARIANT}.json"))
    if not report.exists():
        write_report_text(report,
                          "| Journey | Result | First broken step | install.sh | questions | apply | start | first command | total | platform root | peak pnpm RSS |\n"
                          "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|\n",
                          env=BASE_ENV)
    write_report_text(report, "\n".join(lines) + "\n", env=BASE_ENV, append=True)
    if (not passed and BASE_ENV.get("KB_JOURNEY_SERVICE_PROFILE") == "nightly"
            and (VARIANT.endswith("secured") or SCENARIO == "explore")):
        mode = "secured" if VARIANT.endswith("secured") else "local"
        service_report = report.with_name(f"service-{mode}.json")
        if not service_report.exists():
            record_runner_failure(service_report, mode, FIRST_FAILURE)
    if not passed:
        candidates = sorted((PLATFORM / layout_value('sharedStateDirectory') / "diagnostics").glob("*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
        logs = sorted((PLATFORM / layout_value('sharedStateDirectory') / "logs").glob("*.log"), key=lambda path: path.stat().st_mtime, reverse=True)
        for path in [*candidates[:1], *logs[:1]]:
            write_journey_diagnostic(
                f"\n== {title}: {path.name} ==\n{path.read_text(errors='replace')[-5000:]}\n",
                env=BASE_ENV,
            )
        for path in [PLATFORM / "node_modules/.bin/kb", PLATFORM / "node_modules/@kb-labs/cli-bin", PLATFORM / "node_modules/@kb-labs/cli-bin/dist/bin.js", BIN / "kb"]:
            try:
                target = os.readlink(path)
            except OSError:
                target = ""
            write_journey_diagnostic(
                f"tree {path}: exists={path.exists()} symlink={path.is_symlink()} target={target!r} resolved={path.resolve(strict=False)}\n",
                env=BASE_ENV,
            )
            if path.is_file() and path.name in {"kb", "bin.js"}:
                write_journey_diagnostic(f"file {path}: {path.read_text(errors='replace')[:3000]}\n",
                                          env=BASE_ENV)
    write_scoreboards(report.parent, case_catalog_root())
    print_report_text("\n".join(lines), env=BASE_ENV, flush=True)
    return 0 if passed else failure_exit()


def extract_request(payload):
    if isinstance(payload, dict):
        if payload.get("schema") == "kb.create/v2" and "platformRoot" in payload:
            return payload
        for value in payload.values():
            found = extract_request(value)
            if found is not None:
                return found
    elif isinstance(payload, list):
        for value in payload:
            found = extract_request(value)
            if found is not None:
                return found
    return None


def find_project_id(payload):
    if isinstance(payload, dict):
        for key in ("projectId", "project_id", "id"):
            value = payload.get(key)
            if isinstance(value, str) and value.startswith("prj_"):
                return value
        for value in payload.values():
            found = find_project_id(value)
            if found:
                return found
    elif isinstance(payload, list):
        for value in payload:
            found = find_project_id(value)
            if found:
                return found
    return ""


def verify_listener_ownership():
    result, _ = run(["ss", "-H", "-ltnp"], timeout=20)
    if not require(result, step="list platform listeners"):
        return
    pids = set(re.findall(r"pid=(\d+)", result.stdout))
    if not pids:
        fail("platform is running but exposes no owned listening process")
        return
    for pid in pids:
        cmdline = Path(f"/proc/{pid}/cmdline")
        try:
            command = cmdline.read_bytes().replace(b"\0", b" ").decode(errors="replace")
        except OSError:
            fail(f"listener pid {pid} disappeared before ownership could be checked")
            continue
        try:
            cwd = os.readlink(f"/proc/{pid}/cwd")
        except OSError:
            cwd = ""
        if str(PLATFORM) not in command and not cwd.startswith(str(PLATFORM)):
            fail(f"listener pid {pid} is not running from this platform root: {command[:240]}")


def uninstall_removed_platform_root():
    receipt = PLATFORM_CURRENT / ".kb" / "v2" / "receipt.json"
    snapshots = PLATFORM / layout_value('sharedStateDirectory') / "snapshots"
    layout = json.loads(workspace_resource("tools", "kb-create", "v2", "contracts", "platform-layout.json").read_text())
    roots = layout.get("versionRoots", {})
    versions = PLATFORM / roots.get("path", layout_value('versionRoots.path'))
    return not PLATFORM.exists() and not versions.exists() and not receipt.exists() and not snapshots.exists()


def restart_host(launcher: str, env: dict[str, str]) -> str:
    result, _ = run([launcher, "restart", "--platform-root", str(PLATFORM), "--json"], env=env, timeout=180)
    try:
        payload = decode_ux_success_result(read_kb_create_cli_result("restart", result))
    except json.JSONDecodeError:
        payload = {}
    restarted = (result.returncode == 0 and payload.get("operation") == "restart"
                 and payload.get("host", {}).get("pid", 0) > 0)
    record_case("restart host", restarted,
               "restart JSON did not report a started host process", cases=["PC-004.1"])
    if not restarted:
        raise RuntimeError("host restart failed during secured auth journey")
    return "http://127.0.0.1:4000"


def restart_shared_host(graph: FlowGraph, launcher: str, env: dict[str, str], step: str) -> str:
    """Declare the shared host mutation and re-establish its health state."""
    graph.invalidate_state("host-running", group="host", step=step,
                          evidence=f"{step} restarted the shared platform host")
    restarted_url = restart_host(launcher, env)
    probe_platform_state(graph, env, launcher, mutator_group="host", mutator_step=step,
                         include_installed=False, include_version=False)
    if graph.states.get("host-running", {}).get("passed") is not True:
        raise RuntimeError(f"shared platform host was not healthy after {step}: {graph.state_failure('host-running')}")
    return restarted_url


def run_workflow_with_host_boundary(graph: FlowGraph, *, env: dict[str, str], launcher: str,
                                    action: Callable[[], object]) -> object:
    """Re-establish the shared-host prerequisite after workflow cases mutate its lifecycle."""
    try:
        return action()
    finally:
        probe_platform_state(graph, env, launcher, mutator_group="workflow",
                             mutator_step="workflow case host boundary",
                             include_installed=False, include_version=False)


def verify_broken_install_doctor(launcher: str, env: dict[str, str]) -> None:
    receipt = PLATFORM_CURRENT / ".kb" / "v2" / "receipt.json"
    hidden_receipt = receipt.with_name("receipt.journey-hidden.json")
    if not receipt.is_file() or hidden_receipt.exists():
        fail("broken-install doctor fixture requires one active receipt")
        return
    os.replace(receipt, hidden_receipt)
    try:
        result, _ = run([launcher, "doctor", "--platform-root", str(PLATFORM), "--json"], env=env, timeout=120)
        try:
            diagnostic = decode_ux_error_result(read_kb_create_cli_result("doctor", result))
        except (json.JSONDecodeError, AttributeError):
            diagnostic = {}
        human, _ = run([launcher, "doctor", "--platform-root", str(PLATFORM)], env=env, timeout=120)
        human_output = human.stdout + human.stderr
        typed_ok = (result.returncode == 1 and diagnostic.get("code") == "KB_INSTALL_RECEIPT_UNAVAILABLE"
                    and diagnostic.get("hint") and diagnostic.get("correlationId")
                    and "KB_INSTALL_RECEIPT_UNAVAILABLE" in human_output
                    and "correlationId" in human_output)
        record_case("doctor reports missing receipt", typed_ok,
                    "doctor did not return the typed missing-receipt diagnostic in both modes",
                    cases=["PC-003.2", "S-203.11"])
    finally:
        os.replace(hidden_receipt, receipt)
    restored, _ = run([launcher, "doctor", "--platform-root", str(PLATFORM), "--json"], env=env, timeout=120)
    restored_message = "doctor did not return a healthy result after restoring the receipt"
    try:
        restored_payload = decode_ux_success_result(read_kb_create_cli_result("doctor", restored))
    except (json.JSONDecodeError, ValueError):
        restored_payload = {}
        restored_message = describe_cli_failure("kb-create doctor", restored.stdout, restored.stderr,
                                                restored.returncode)
    restored_ok = (restored.returncode == 0 and restored_payload.get("installed") is True and restored_payload.get("running") is True
                   and restored_payload.get("reachable") is True
                   and restored_payload.get("platform", {}).get("ok") is True)
    record_case("doctor recovers after receipt restore", restored_ok,
               restored_message, cases=["PC-003.3"])



def run_uninstall_group(graph: FlowGraph, env: dict[str, str], launcher: str) -> bool:
    global PLATFORM_SIZE_MIB
    mode = "secured" if VARIANT.endswith("secured") else "local"
    if PLATFORM.exists():
        owned_tree = (PLATFORM / layout_value('versionRoots.path'), PLATFORM / layout_value('sharedStateDirectory'))
        PLATFORM_SIZE_MIB = sum(p.stat().st_size for tree in owned_tree for p in tree.rglob("*") if p.is_file()) / (1024 * 1024)
    uninstall_args = [launcher, "uninstall", "--platform-root", str(PLATFORM), "--registry", REGISTRY]
    scope_is_separate = PLATFORM.resolve() != PROJECT.resolve() and PLATFORM.exists() and PROJECT.is_dir()
    record_case("inspect uninstall scope", scope_is_separate,
                "platform root is not separate from the project directory", cases=["S-050.1"])
    capture_case_failure()
    if FIRST_FAILURE:
        dump_failure_state()
    refusal_invocation = [*uninstall_args, "--json"]
    refused, _ = run(refusal_invocation, env=env, timeout=120)
    try:
        refusal_payload = read_kb_create_cli_result("uninstall", refused)
    except json.JSONDecodeError:
        refusal_payload = {}
    refusal_error = decode_ux_error_result(refusal_payload)
    refusal_ok = (refused.returncode == 2 and refusal_error.get("code") == "KB_INSTALL_CONFIRMATION_REQUIRED"
                  and confirmation_hint_matches_invocation(refusal_error.get("hint", ""), refusal_invocation)
                  and (PLATFORM_CURRENT / ".kb/v2/receipt.json").is_file())
    record_case("non-TTY uninstall requires confirmation", refusal_ok,
                "non-TTY uninstall did not require --yes or left the receipt unchanged", cases=["S-050.4"])
    capture_case_failure()
    if FIRST_FAILURE:
        dump_failure_state()

    declined_journey = run_uninstall_decline_step(
        mode=mode, args=uninstall_args, receipt_path=PLATFORM_CURRENT / ".kb/v2/receipt.json",
        run_pty=lambda args, on_output: run_pty_command(args, env=env, timeout=120, on_output=on_output),
    )
    declined_step = declined_journey.steps[0]
    CASE_JOURNEY.step(declined_step.name, declined_step.capability,
                      lambda: None if declined_step.status == "PASS" else declined_step.message,
                      cases=declined_step.cases)
    capture_case_failure()
    if FIRST_FAILURE:
        dump_failure_state()

    if FRONT_DOOR == "human":
        result, _ = run_tty_confirmation(uninstall_args, env=env, timeout=180)
    else:
        result, _ = run([*uninstall_args, "--yes", "--json"], env=env, timeout=180)
    if require(result, step="kb-create uninstall"):
        if FRONT_DOOR == "human":
            prompt_ok = all(fragment in result.stdout for fragment in
                            (str(PLATFORM), "services", "receipt", "snapshots", "Project files are kept"))
            record_case("human uninstall confirmation prompt", prompt_ok,
                       "uninstall prompt omitted its root, artifacts, receipt, snapshots, or project preservation",
                       cases=["S-050.2"], runners=("human:default", "human:nondefault"))
            human_uninstall_ok = (result.returncode == 0 and "uninstall" in result.stdout.lower()
                                  and uninstall_human_summary_has_shim_result(result.stdout, PLATFORM))
            record_case("human confirmed uninstall", human_uninstall_ok,
                       "confirmed human uninstall omitted its shim disposition or completion summary",
                       cases=["S-050.5"], runners=("human:default", "human:nondefault"))
        else:
            try:
                uninstall_payload = decode_ux_success_result(read_kb_create_cli_result("uninstall", result))
            except json.JSONDecodeError:
                uninstall_payload = {}
            uninstall_ok = (result.returncode == 0 and uninstall_payload.get("operation") == "uninstall"
                            and bool(uninstall_payload.get("snapshot")) and bool(uninstall_payload.get("logPath"))
                            and uninstall_shim_result_matches(uninstall_payload, PLATFORM))
            record_case("agent confirmed uninstall", uninstall_ok,
                       "agent uninstall result omitted operation, snapshot, logPath, or shim disposition/owner",
                       cases=["S-050.6"],
                       runners=("agent:commit", "agent-secured:commit"))
        alive = [p for p in graph.resources if p.poll() is None]
        listeners, _ = run(["ss", "-H", "-ltnp"], timeout=20)
        platform_pids = set()
        for pid in re.findall(r"pid=(\d+)", listeners.stdout):
            try:
                command = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
                cwd = os.readlink(f"/proc/{pid}/cwd")
                if str(PLATFORM) in command or cwd.startswith(str(PLATFORM)):
                    platform_pids.add(pid)
            except OSError:
                continue
        if platform_pids:
            fail(f"uninstall left platform listeners: {', '.join(sorted(platform_pids))}")
        if alive or platform_pids or not uninstall_removed_platform_root() or (BIN / "kb").exists():
            fail("uninstall left a platform process, listening port, shim, platform root, receipt, or snapshots")
        project_preserved = (PROJECT.is_dir() and (PROJECT / "note.txt").is_file()
                             and (PROJECT / "note.txt").read_text() == "journey first value\n")
        record_case("project files survive uninstall", project_preserved,
                    "platform uninstall removed or changed the separate project fixture", cases=["S-050.7"])
    capture_case_failure()
    return not FIRST_FAILURE


def _run_final_uninstall(graph: FlowGraph, env: dict[str, str], launcher: str) -> bool:
    status = graph.flow(
        "uninstall platform", "uninstall", "platform.uninstall",
        lambda: run_uninstall_group(graph, env, launcher),
        cases=["S-050.1", "S-050.4", "S-050.6", "S-050.7"], role="lifecycle",
        plan_phase="teardown",
    )
    if status == "SKIPPED":
        return not FIRST_FAILURE
    if status != "PASS":
        fail("uninstall platform group failed; inspect its FAIL/BLOCKED journey rows and journey-diagnostics.log")
    return status == "PASS" and not FIRST_FAILURE

def _main(*, update_variant_runner=None):
    global FIRST_FAILURE, CASE_JOURNEY, SELECTED_CLAIM_COMPLETION_CHECKED
    global ACTIVE_OUTER_GRAPH, ACTIVE_MAIN_ENV, ACTIVE_LAUNCHER
    STATE_DUMP_GUARD.reset()
    Journey.reset_run_registry()
    FIRST_FAILURE = ""
    SELECTED_CLAIM_COMPLETION_CHECKED = False
    env = dict(BASE_ENV)
    env["HOME"] = str(HOME)
    env["KB_JOURNEY_HOME_LABEL"] = "main"
    # The entrypoint's crash handler runs outside this module's global namespace
    # (runpy returns a separate dict), so publish the active install HOME there.
    os.environ["HOME"] = str(HOME)
    os.environ["KB_JOURNEY_HOME_LABEL"] = "main"
    env["KB_JOURNEY_INVOCATIONS"] = str(Path(journey_value("KB_JOURNEY_SUMMARY", "/summary/journey-summary.md")).resolve().parent)
    os.environ["KB_JOURNEY_INVOCATIONS"] = env["KB_JOURNEY_INVOCATIONS"]
    env["PATH"] = "/usr/local/bin:/usr/bin:/bin"
    marketplace_flags = marketplace_install_flags(env)
    (HOME / ".profile").write_text("if [ -f ~/.bashrc ]; then . ~/.bashrc; fi\n")
    (HOME / ".bash_profile").write_text("if [ -f ~/.profile ]; then . ~/.profile; fi\n")
    (HOME / ".npmrc").write_text(f"registry={REGISTRY}\n")
    env["KB_CREATE_DOWNLOAD_BASE_URL"] = BASE_ENV["KB_CREATE_DOWNLOAD_BASE_URL"]
    mode = "secured" if VARIANT.endswith("secured") else "local"
    scenario_setup = runner_scenario(SCENARIO, secured=mode == "secured")
    CASE_JOURNEY = Journey(mode, f"installer-{mode}-{FRONT_DOOR}-{SCENARIO}-{VARIANT}")
    diagnostics = Path(journey_value("KB_JOURNEY_SUMMARY", "/summary/journey-summary.md")).with_name(
        "journey-diagnostics.log")
    selection_groups = outer_selection_groups()
    outer_graph = FlowGraph(CASE_JOURNEY, OUTER_GROUP_DEPENDENCIES,
                            diagnostics_path=diagnostics, groups=selection_groups)
    project_b_handoff: ProjectBRootHandoff | None = None

    def produce_project_registration_state() -> None:
        establish_project_registration(outer_graph, PROJECT, env)
        capture_case_failure()

    outer_graph.register_state_producer("project-registered", produce_project_registration_state)
    ACTIVE_OUTER_GRAPH = outer_graph
    ACTIVE_MAIN_ENV = env
    # Agent flows pass --registry explicitly. Human `install` uses the package
    # manager's normal registry setting, so point that setting at the isolated
    # journey registry as well.
    env["NPM_CONFIG_REGISTRY"] = REGISTRY
    env.pop("KB_PLATFORM_ROOT", None)
    env.pop("KB_HOME", None)
    env.pop("KB_NET_OFFSET", None)
    env["NO_COLOR"] = "1"

    if VARIANT == "wrong-node":
        fake_bin = HOME / "fake-bin"
        fake_bin.mkdir()
        fake_node = fake_bin / "node"
        fake_node.write_text("#!/bin/sh\necho v22.11.0\n")
        fake_node.chmod(0o755)
        env["PATH"] = f"{fake_bin}:{env['PATH']}"
        result, duration = run([INSTALLER, "--version", "journey-candidate"], env=env, timeout=90)
        TIMES["install.sh"] = duration
        # The prerequisite is evaluated by kb-create install; install.sh itself only downloads.
        (BIN / "kb-create").exists() and None
        launcher, _ = run([str(BIN / "kb-create"), "install"], env=env, timeout=90) if (BIN / "kb-create").exists() else (result, 0)
        node_engine_helper = workspace_resource("core", "plugin-runtime", "src", "platform-resolve", "node-engine.mjs")
        root_manifest = workspace_resource("package.json")
        policy_result = run_command(
            ["node", str(node_engine_helper), "--required-major", str(root_manifest)], env=BASE_ENV,
        )
        if policy_result.returncode != 0:
            fail(f"cannot read the workspace Node policy: {policy_result.stderr.strip()[:300]}")
        required_major = policy_result.stdout.strip()
        expected_hint = catalogued_error_hint(
            "KB_NODE_VERSION_UNSUPPORTED", requiredMajor=required_major, actualVersion="22.11.0",
        )
        passed = "KB_NODE_VERSION_UNSUPPORTED" in launcher.stdout and expected_hint in launcher.stdout
        if not passed:
            fail(f"wrong Node major: expected the catalogued unsupported-major diagnostic; {launcher.stdout.strip()[:300]}")
        return finalize_run(passed)

    if VARIANT == "occupied-port":
        listener_command = ["python3", "-u", "-c", "import http.server; s=http.server.HTTPServer(('0.0.0.0',4000),http.server.SimpleHTTPRequestHandler); print('ready', flush=True); s.serve_forever()"]
        listener = start_background_command(listener_command, env=env)
        outer_graph.resources.append(listener)
        if not listener.wait_for_output("ready", 5):
            fail("port collision fixture failed to bind port 4000")
    if VARIANT == "relative-path":
        FRONT = "agent"
    else:
        FRONT = FRONT_DOOR

    started = time.monotonic()
    result, elapsed = run([INSTALLER, "--version", "journey-candidate"], env=env, timeout=90)
    TIMES["install.sh"] = elapsed
    if not require(result, step="install.sh"):
        return finalize_run(False)
    if not (BIN / "kb-create").exists():
        fail("install.sh: kb-create binary was not installed")
        return finalize_run(False)

    launcher = str(BIN / "kb-create")
    env["KB_JOURNEY_KB_CREATE_PATH"] = launcher
    ACTIVE_LAUNCHER = launcher
    version, _ = run([launcher, "--version"], env=env, timeout=30)
    version_ok = version.returncode == 0 and re.fullmatch(r"kb-create [^\s]+\s*", version.stdout) is not None
    candidate = {}
    identity, _ = run([launcher, "version", "--json"], env=env, timeout=30)
    if identity.returncode == 0:
        try:
            envelope = read_kb_create_cli_result("version", identity)
            data = decode_ux_success_result(envelope)
            if envelope.get("ok") is True and isinstance(data, dict):
                candidate = {key: value for key, value in data.items() if isinstance(value, str)}
            else:
                candidate["identityError"] = "version --json returned no success data"
        except ValueError as error:
            candidate["identityError"] = f"version --json returned invalid JSON: {error}"
    else:
        candidate["identityError"] = (
            f"version --json exited {identity.returncode}: {' '.join(identity.stdout.split())[:300]}")
    provenance = record_candidate_provenance(
        CASE_JOURNEY, journey_value("KB_JOURNEY_GIT_REVISION", ""), candidate)
    if provenance.status != "PASS":
        fail(provenance.message or "candidate provenance check failed")
        return finalize_run(False)
    record_case("launcher version", version_ok,
               "kb-create --version did not print the launcher version", cases=["PC-001.1"])
    if VARIANT == "occupied-port":
        args = [launcher, "apply", "--json", "--index", str(HOME / ".local/share/kb-create/release-index.json"),
                "--platform-root", str(PLATFORM), "--scenario", "commit", "--registry", REGISTRY]
        result, elapsed = run(args, env=env, timeout=90)
        TIMES["apply"] = elapsed
        passed = result.returncode != 0 and "KB_INSTALL_PORT_IN_USE" in result.stdout and "4000" in result.stdout
        if not passed:
            fail(f"port conflict: expected KB_INSTALL_PORT_IN_USE for port 4000; {' '.join(result.stdout.split())[-500:]}")
        return finalize_run(passed)
    first_admin_shown_once = False
    install_plan_summary_ok = False
    install_marketplace_ok = False
    if FRONT == "human" and not VARIANT.endswith("secured"):
        PROJECT.mkdir(parents=True, exist_ok=True)
        choice = "commit" if VARIANT == "human-nondefault" else ""
        access_mode = "secured" if VARIANT.endswith("secured") else "local"
        code, output, duration, apply_offset = pty_install(
            [launcher, "install", "--registry", REGISTRY, *marketplace_flags], env, choice, access_mode
        )
        TIMES["questions"] = apply_offset if apply_offset is not None else duration
        if apply_offset is not None:
            TIMES["apply"] = duration - apply_offset
        if VARIANT.startswith("human-"):
            write_journey_diagnostic(
                f"\n== {FRONT}/{SCENARIO}: install-pty (access={access_mode}, exit {code}) ==\n{output[-12000:]}\n",
                env=env,
            )
        human_text_is_clean(output)
        if code != 0:
            fail(f"kb-create install: exit {code}; {' '.join(output.split())[-2000:]}")
        if not re.search(r"(?i)install|download|configure|verify|starting", output):
            fail("kb-create install: terminal showed no progress")
        if not re.search(r"(?i)next|success|installed|ready", output):
            fail("kb-create install: terminal showed no success and next steps")
        human_install_ok = (code == 0 and "Set up KB Labs" in output
                            and re.search(r"Plan: platform [^,]+ at [^,]+, \d+ artifacts", output) is not None
                            and "Applying installation" in output
                            and f"; project {PROJECT.resolve()}" in output
                            and str(PROJECT.resolve()) in output
                            and not (PROJECT / ".kb").exists()
                            and "Verification: platform installed" in output
                            and re.search(r"(?i)next|success|installed|ready", output) is not None)
        if FRONT == "human" and not VARIANT.endswith("secured"):
            record_case("human interactive install",
                       human_install_ok, "interactive install did not show a plan and success result",
                       cases=["S-040.1", "S-040.2", "S-187.1", "S-187.2", "S-187.3", "S-203.10"],
                       requires=("step:candidate provenance",),
                       runners=("human:default", "human:nondefault"))
    else:
        operation = "plan" if VARIANT in {"input", "relative-path"} else "install"
        PROJECT.mkdir(parents=True, exist_ok=True)
        install_scenario = scenario_setup["installer"]
        args = [launcher, operation, "--json", "--index", str(HOME / ".local/share/kb-create/release-index.json"),
                "--platform-root", str(PLATFORM), "--service-profile", "default", "--scenario", install_scenario,
                "--registry", REGISTRY, *marketplace_flags, "--project-root", str(PROJECT)]
        if VARIANT.endswith("secured"):
            answers = json.dumps({
                "access.mode": "secured",
                "admin.email": "journey-admin@example.test",
                "admin.tenant": "journey",
            })
            args.extend(["--scenario-answers", answers])
        if VARIANT == "relative-path":
            args[args.index(str(PLATFORM))] = os.path.relpath(PLATFORM, Path.cwd())
        result, elapsed = run(args, env=env, timeout=1200)
        TIMES["apply"] = elapsed
        if VARIANT == "relative-path":
            try:
                payload = decode_ux_success_result(read_kb_create_cli_result("apply", result))
                root = payload.get("plan", {}).get("request", {}).get("platformRoot", "")
            except json.JSONDecodeError:
                root = ""
            passed = result.returncode == 0 and Path(root).is_absolute() and root == str(PLATFORM.resolve())
            if not passed:
                fail(f"relative platform root: expected a successful plan with an absolute normalized root; {' '.join(result.stdout.split())[-500:]}")
            return finalize_run(passed)
        if handle_json_install_failure(operation, result):
            return finalize_run(False)
        if not require(result, step=f"kb-create {operation} --json"):
            cleanup_partial_install(outer_graph, env, launcher)
            return finalize_run(False)
        if operation == "install":
            try:
                records = read_ux_cli_stream(result)
            except json.JSONDecodeError:
                records = []
            terminal = records[-1] if records else {}
            stream_meta = terminal.get("meta", {}).get("stream", {}) if isinstance(terminal, dict) else {}
            result_records = [record for record in records if isinstance(record, dict)
                              and record.get("meta", {}).get("stream", {}).get("result") is True]
            install_receipt = result_records[0].get("data", {}).get("receipt", {}) if len(result_records) == 1 else {}
            install_plan = install_receipt.get("plan", {}) if isinstance(install_receipt, dict) else {}
            install_marketplace_ok = commit_marketplace_install_record(install_receipt) is not None
            install_plan_summary_ok = (isinstance(install_plan, dict)
                                       and bool(install_plan.get("serviceGraph", {}).get("platformVersion"))
                                       and bool(install_plan.get("artifacts")))
            install_ok = (result.returncode == 0 and bool(records)
                          and terminal.get("ok") is True and terminal.get("data", "not-null") is None
                          and stream_meta.get("terminal") is True and stream_meta.get("exitCode") == 0
                          and len(result_records) == 1
                          and result_records[0].get("ok") is True
                          and isinstance(result_records[0].get("data"), dict)
                          and install_plan_summary_ok)
            record_case("JSON install progress", install_ok,
                       "install stream omitted progress or its terminal success record",
                       cases=["S-203.10", "S-203.13"],
                       runners=("agent:commit", "agent-secured:commit", "service-local:explore",
                                "service-secured:explore"))
            if not install_ok:
                fail("kb-create install --json: stream did not finish successfully")
            if VARIANT.endswith("secured"):
                credentials = [
                    record.get("data", {}).get("firstAdmin")
                    for record in result_records
                    if isinstance(record.get("data"), dict)
                    and isinstance(record["data"].get("firstAdmin"), dict)
                ]
                if len(credentials) == 1:
                    credential = credentials[0]
                    password = credential.get("password", "")
                    store_report_secret(env, "KB_JOURNEY_ADMIN_PASSWORD", password,
                                        "installed first-admin password")
                    first_admin_shown_once = (
                        credential.get("email") == "journey-admin@example.test"
                        and credential.get(layout_value('sharedStateDirectory')) == "disclosed"
                        and bool(password)
                        and result.stdout.count(password) == 1
                    )
                    if first_admin_shown_once:
                        env["KB_JOURNEY_ADMIN_EMAIL"] = credential["email"]
                if not first_admin_shown_once:
                    fail("secured install did not return exactly one firstAdmin credential with state=disclosed")
                else:
                    register_install_password_absence_step(
                        CASE_JOURNEY, PLATFORM,
                        (("kb-home", Path(env.get("KB_HOME", str(Path(env["HOME"]) / ".kb")))),
                         ("bin", BIN)), password)
            payload = {}
        else:
            try:
                envelope = read_kb_create_cli_result(operation, result)
            except json.JSONDecodeError:
                fail(f"kb-create {operation} --json: output was not valid JSON")
                cleanup_partial_install(outer_graph, env, launcher)
                return finalize_run(False)
            payload = envelope.get("data") if isinstance(envelope, dict) else None
            if envelope.get("ok") is not True or not isinstance(payload, dict):
                fail(f"kb-create {operation} --json: result did not contain a success data object")
                cleanup_partial_install(outer_graph, env, launcher)
                return finalize_run(False)
        if operation == "plan":
            plan_payload = payload.get("plan", {})
            plan_ok = (result.returncode == 0
                       and plan_payload.get("request", {}).get("platformRoot") == str(PLATFORM)
                       and bool(plan_payload.get("artifacts")) and bool(plan_payload.get("serviceGraph")))
            record_case("agent plan", plan_ok,
                       "plan omitted the isolated root, resolved artifacts, or service graph", cases=["PC-001.3"],
                       requires=("step:launcher version",),
                       runners=("agent-input:commit", "agent-relative:commit"))
        elif operation == "install":
            if FRONT_DOOR == "agent":
                record_case("agent JSON install", install_ok,
                            "agent install stream omitted progress or terminal success", cases=["S-203.10"],
                            runners=("agent:commit", "agent-secured:commit", "service-local:explore"))
        if VARIANT.endswith("secured"):
            env.setdefault("KB_JOURNEY_ADMIN_EMAIL", "journey-admin@example.test")
        if VARIANT == "input":
            request = extract_request(payload)
            if request is None:
                fail("kb-create apply --json: launcher output contained no kb.create/v2 request")
            else:
                request_file = HOME / "launcher-request.json"
                request_file.write_text(json.dumps(request) + "\n")
                args = [launcher, "apply", "--json", "--index", str(HOME / ".local/share/kb-create/release-index.json"),
                        "--input", str(request_file), "--registry", REGISTRY]
                result, elapsed = run(args, env=env, timeout=1200)
                TIMES["apply"] += elapsed
                if not require(result, step="kb-create apply --input launcher request"):
                    cleanup_partial_install(outer_graph, env, launcher)
                    return finalize_run(False)
                try:
                    read_kb_create_cli_result("apply", result)
                    if result.returncode != 0:
                        fail("kb-create apply --input: result did not report ok=true")
                except json.JSONDecodeError:
                    fail("kb-create apply --input: output was not one JSON document")

    outer_graph.flow("installed platform bootstrap", "install", "platform.install", lambda: None,
                     skip_note="the install operation ran earlier; this flow is only a selection marker")
    capture_case_failure()
    if FIRST_FAILURE:
        first = CASE_JOURNEY.result().first_failure or {}
        if (PLATFORM_CURRENT / ".kb" / "v2" / "receipt.json").is_file():
            _run_final_uninstall(outer_graph, env, launcher)
        return finalize_run(False)

    installed_status, _ = run([launcher, "status", "--platform-root", str(PLATFORM), "--json"],
                              env=env, timeout=120)
    try:
        installed_payload = decode_ux_success_result(read_kb_create_cli_result("status", installed_status))
        installed_state = installed_payload.get("host", {})
        install_running = (installed_status.returncode == 0 and installed_payload.get("installed") is True
                           and installed_payload.get("running") is True and installed_payload.get("reachable") is True
                           and installed_state.get(layout_value('sharedStateDirectory')) == "running")
    except (json.JSONDecodeError, AttributeError):
        install_running = False
    if FRONT_DOOR == "agent":
        record_case("post-install running status", install_running,
                    "successful install did not leave a running, reachable host", cases=["S-039.2"],
                    runners=("agent:commit", "agent-secured:commit"))
    else:
        record_case("post-install running status", install_running,
                    "successful install did not leave a running, reachable host", cases=["S-040.3"],
                    requires=("step:candidate provenance",),
                    runners=("human:default", "human:nondefault"))
    record_case("clean install leaves a running host and reports its resolved plan",
                install_running and install_plan_summary_ok and install_marketplace_ok
                and (mode != "secured" or first_admin_shown_once),
                "install did not leave a reachable host, return its Commit Marketplace receipt and resolved plan, or return the secured credential exactly once",
                cases=["PC-001.2"], requires=("step:candidate provenance",),
                runners=("agent:commit", "agent-secured:commit", "service-local:explore",
                         "service-secured:explore"))
    installed_doctor, _ = run([launcher, "doctor", "--platform-root", str(PLATFORM), "--json"],
                              env=env, timeout=120)
    try:
        installed_health = decode_ux_success_result(read_kb_create_cli_result("doctor", installed_doctor))
        install_healthy = (installed_doctor.returncode == 0 and installed_health.get("installed") is True
                           and installed_health.get("running") is True and installed_health.get("reachable") is True
                           and installed_health.get("platform", {}).get("ok") is True)
    except (json.JSONDecodeError, AttributeError):
        install_healthy = False
    record_case("post-install healthy doctor", install_healthy,
                "successful install did not pass the healthy doctor check", cases=["PC-001.6"])

    probe_platform_state(outer_graph, env, launcher, include_host=False)

    def start_host_group() -> None:
        stopped, _ = run([launcher, "stop", "--platform-root", str(PLATFORM), "--json"], env=env, timeout=120)
        if not require(stopped, step="kb-create stop before start lifecycle check"):
            return
        result, elapsed = run([launcher, "start", "--platform-root", str(PLATFORM)], env=env, timeout=300)
        TIMES["start"] = elapsed
        started = require(result, step="kb-create start")
        record_case("start host", started,
                    "kb-create start did not start the configured host", cases=["PC-002.1"])

    host_status = outer_graph.flow("start platform host", "host", "platform.host", start_host_group,
                                   cases=["PC-002.1"])
    probe_platform_state(outer_graph, env, launcher, mutator_group="host", mutator_step="kb-create start/status",
                         include_installed=False, include_version=False)
    capture_case_failure()
    host_state_needed = not outer_graph.selection_active or "host-running" in outer_graph.needed_states
    if host_state_needed and outer_graph.states.get("host-running", {}).get("passed") is not True:
        block_outer_dependents(outer_graph, ["auth", "update", "project", "marketplace",
                                             "marketplace-fixtures", "adapters", "plugin-author",
                                             "workflow", "analytics", "studio"])
        _run_final_uninstall(outer_graph, env, launcher)
        return finalize_run(False)

    if mode == "secured":
        from service_runner import restore_secured_cli_login
        establish_initial_secured_session(
            outer_graph, lambda: restore_secured_cli_login(BIN / "kb", env))

    verify_listener_ownership()

    # New shell with the installed profile proves user-facing PATH and runtime isolation.
    PROJECT.mkdir(exist_ok=True)
    for package in scenario_setup["marketplace_packages"]:
        login, _ = run(kb_login_shell(["auth", "login", "--gateway-url", "http://127.0.0.1:4000",
                                      "--email", env["KB_JOURNEY_ADMIN_EMAIL"], "--password-stdin"]),
                       env=env, cwd=PROJECT, timeout=90,
                       input_text=env["KB_JOURNEY_ADMIN_PASSWORD"] + "\n")
        if not require(login, step="secured runner administrator login"):
            return finalize_run(False)
        install, _ = run(kb_login_shell(["marketplace", "install", package, "--scope", "platform", "--json"]),
                         env=env, cwd=PROJECT, timeout=300)
        if not require(install, step=f"marketplace install {package} for secured runner scenario"):
            return finalize_run(False)
    run(["git", "init", "-q"], env=env, cwd=PROJECT)
    (PROJECT / "note.txt").write_text("journey first value\n")
    run(["git", "add", "note.txt"], env=env, cwd=PROJECT)
    help_commands = [["--help"]]
    if FRONT == "agent":
        help_commands.extend(RUNNER_SCENARIOS[SCENARIO]["command_help_paths"])
    result, elapsed = run(kb_login_shell_sequence(help_commands), env=env, cwd=PROJECT, timeout=180)
    TIMES["first command"] = elapsed
    if not require(result, step="new login shell kb --help"):
        write_journey_diagnostic(f"\n== {FRONT_DOOR}/{SCENARIO}: first-command-output ==\n{result.stdout[-5000:]}\n", env=env)
    else:
        if FRONT == "agent" and scenario_setup["command_help_paths"]:
            result, elapsed = run(kb_login_shell(["commit", "commit", "--dry-run", "--json"]),
                                  env=env, cwd=PROJECT, timeout=300)
            TIMES["first command"] += elapsed
            if not require(result, step="kb commit first value"):
                write_journey_diagnostic(f"\n== {FRONT_DOOR}/{SCENARIO}: first-value-output ==\n{result.stdout[-5000:]}\n", env=env)
        status, _ = run(["git", "status", "--porcelain"], env=env, cwd=PROJECT)
        clean_repo = not (PROJECT / ".kb").exists() and status.stdout.strip() in {"?? note.txt", "A  note.txt"}
        record_case("first CLI commands leave fresh repository untouched", clean_repo,
                    f"project gained KB Labs files: {status.stdout.strip()}", cases=["S-054.17"])
        if not clean_repo:
            fail(f"project gained KB Labs files: {status.stdout.strip()}")

    if FRONT == "agent" and SCENARIO == "commit":
        verify_project_mcp(env, env.get("KB_ACCESS_MODE", "local") == "local", DEFAULT_ENABLED_SERVICES)

    update_group_selected = outer_graph.group_selected("update")
    update_journey = update_group_selected and (
        outer_graph.selection_active
        or (SCENARIO == "commit" and VARIANT in {"default", "input"})
        or VARIANT.endswith("secured")
    )
    if not update_journey and outer_graph.selection_active and not update_group_selected:
        outer_graph.skip_unselected("platform update journey", "platform.update")
    if update_journey:
        update_gate = outer_graph.flow(
            "platform update prerequisites", "update", "platform.update", lambda: None,
            cases=outer_graph.groups.get("update", {}).get("cases", ()),
            record_empty_success=False,
        )
        update_journey = update_gate != "BLOCKED"
    if update_journey:
        try:
            receipt_path = PLATFORM_CURRENT / ".kb" / "v2" / "receipt.json"
            active = json.loads(receipt_path.read_text())
            request = active["plan"]["request"]
            stable_request = json.loads(json.dumps(request))
            base_version = active["plan"]["serviceGraph"]["platformVersion"]
            request_file = HOME / "platform-update-request.json"
            request_file.write_text(json.dumps(request) + "\n")
            update_index = HOME / "release-index-update.json"
            update_url = BASE_ENV["KB_CREATE_DOWNLOAD_BASE_URL"].rstrip("/") + "/journey-candidate/release-index-update.json"
            update_status, update_body, _ = open_http(
                urllib.request.urlopen, urllib.request.Request(update_url), timeout=30, env=env)
            if update_status != 200:
                raise RuntimeError(f"GET {update_url} returned HTTP {update_status}")
            update_index.write_bytes(update_body)
            updated_version = stable_platform_version(json.loads(update_index.read_text()))
            request.setdefault("platform", {})["version"] = updated_version
            request["platform"].pop("channel", None)
            request["sdk"] = {"version": updated_version}
            request_file.write_text(json.dumps(request) + "\n")
        except (KeyError, OSError, ValueError, urllib.error.URLError) as error:
            fail(f"platform update candidate: could not load installed V2 request and second sealed index: {error}")
        else:
            access_mode = "secured" if VARIANT.endswith("secured") else "local"

            def update_command(args):
                result, _ = run(args, env=env, cwd=PROJECT, timeout=1200)
                return result

            verify_admin = None
            expire_admin_session = None
            if access_mode == "secured":
                admin_email = env.get("KB_JOURNEY_ADMIN_EMAIL", "journey-admin@example.test")
                admin_password = env.get("KB_JOURNEY_ADMIN_PASSWORD", "")

                def verify_admin():
                    result, _ = run(kb_command([ "auth", "login", "--gateway-url",
                                     "http://127.0.0.1:4000", "--email", admin_email,
                                     "--password-stdin"], executable=str(BIN / "kb")),
                                    env=env, cwd=PROJECT, timeout=90,
                                    input_text=admin_password + "\n")
                    return result

                def expire_admin_session():
                    status, _ = run(kb_command([ "auth", "status", "--json"], executable=str(BIN / "kb")),
                                    env=env, cwd=PROJECT, timeout=30)
                    envelope = json.loads(status.stdout)
                    session_path = envelope.get("data", {}).get("session", {}).get("path")
                    if not session_path:
                        raise RuntimeError("kb auth status omitted session.path")
                    session_file = Path(session_path)
                    session = json.loads(session_file.read_text())
                    session["expiresAt"] = 0
                    session_file.write_text(json.dumps(session) + "\n")

            platform_report = Path(journey_value("KB_JOURNEY_SUMMARY", "/summary/journey-summary.md")).with_name(
                f"platform-update-{access_mode}.json")
            try:
                platform_journey = run_platform_update_steps(
                    mode=access_mode,
                    launcher=launcher,
                    kb_binary=str(BIN / "kb"),
                    platform_root=PLATFORM,
                    update_index=update_index,
                    request_file=request_file,
                    base_version=str(base_version),
                    updated_version=str(updated_version),
                    run_command=update_command,
                    verify_user=verify_admin,
                    expire_user_session=expire_admin_session,
                    bootstrap_password=env.get("KB_JOURNEY_ADMIN_PASSWORD") if access_mode == "secured" else None,
                    bootstrap_outside_roots=(("kb-home", Path(env.get("KB_HOME", str(Path(env["HOME"]) / ".kb")))),
                                             ("bin", BIN)),
                    parent_journey=CASE_JOURNEY,
                )
                update_result = platform_journey.write_json(platform_report)
            except Exception as error:
                log_group_exception("platform update/rollback")
                fail(f"platform update/rollback group: {error}")
            else:
                if update_result.status != "PASS":
                    first = update_result.first_failure or {}
                    fail(f"platform update journey: {first.get('name', 'step')}: {first.get('message', '')}")
                else:
                    canary_index = HOME / "release-index-canary.json"
                    canary_url = BASE_ENV["KB_CREATE_DOWNLOAD_BASE_URL"].rstrip("/") + "/journey-candidate/release-index-canary.json"
                    try:
                        canary_status, canary_body, _ = open_http(
                            urllib.request.urlopen, urllib.request.Request(canary_url), timeout=30, env=env)
                        if canary_status != 200:
                            raise RuntimeError(f"GET {canary_url} returned HTTP {canary_status}")
                        canary_index.write_bytes(canary_body)
                        canary_version = channel_platform_version(json.loads(canary_index.read_text()), "canary")
                        channel_request = HOME / "platform-channel-request.json"
                        channel_request.write_text(json.dumps(stable_request) + "\n")
                        channel_report = Path(journey_value("KB_JOURNEY_SUMMARY", "/summary/journey-summary.md")).with_name(
                            f"platform-channels-{access_mode}.json")
                        channel_journey = run_platform_channel_steps(
                            mode=access_mode, launcher=launcher, platform_root=PLATFORM,
                            stable_index=HOME / ".local/share/kb-create/release-index.json",
                            canary_index=canary_index, request_file=channel_request,
                            stable_version=str(base_version), canary_version=str(canary_version),
                            fresh_root=HOME / "canary-fresh", project_root=PROJECT,
                            run_command=update_command,
                        )
                        channel_result = channel_journey.write_json(channel_report)
                        if channel_result.status != "PASS":
                            first = channel_result.first_failure or {}
                            fail(f"platform channel journey: {first.get('name', 'step')}: {first.get('message', '')}")
                    except (KeyError, OSError, ValueError, urllib.error.URLError) as error:
                        fail(f"platform channel candidate: could not load sealed canary index: {error}")
                    except Exception as error:
                        log_group_exception("platform channel change")
                        fail(f"platform channel change group: {error}")

    probe_platform_state(outer_graph, env, launcher,
                         mutator_group="host" if update_journey else "install",
                         mutator_step="verify state after update/rollback/channel" if update_journey else "platform bootstrap",
                         include_installed=False, required=update_journey)

    for command, key in (("status", ""), ("doctor", "")):
        result, _ = run([launcher, command, "--platform-root", str(PLATFORM), "--json"], env=env, timeout=120)
        if not require(result, step=f"kb-create {command}"):
            write_journey_diagnostic(f"\n== {FRONT_DOOR}/{SCENARIO}: {command}-output ==\n{result.stdout[-5000:]}\n", env=env)
            if command == "doctor":
                diagnostic, _ = run([launcher, command, "--platform-root", str(PLATFORM), "--json"], env=env, timeout=120)
                write_journey_diagnostic(f"\n== {FRONT_DOOR}/{SCENARIO}: doctor-json (exit {diagnostic.returncode}) ==\n{(diagnostic.stdout or '')[-12000:]}\n{(diagnostic.stderr or '')[-4000:]}\n", env=env)
        elif command == "doctor":
            try:
                health = decode_ux_success_result(read_kb_create_cli_result("doctor", result))
                passed = (result.returncode == 0 and health.get("installed") is True and health.get("running") is True
                          and health.get("reachable") is True and health.get("platform", {}).get("ok") is True)
            except json.JSONDecodeError:
                passed = False
            if not passed:
                fail(f"kb-create doctor: expected healthy JSON report; {' '.join(result.stdout.split())[-1000:]}")
            record_case("healthy doctor", passed,
                       "doctor JSON did not report a healthy installation and platform",
                       cases=["PC-001.6", "PC-003.1", "S-039.3"])
            if FRONT_DOOR == "human" and not VARIANT.endswith("secured"):
                record_case("human install doctor", passed,
                           "doctor JSON did not report a healthy installation", cases=["S-040.4"],
                           runners=("human:default", "human:nondefault"))
            if mode == "secured":
                record_case("post-restart doctor", passed,
                           "doctor JSON did not report a healthy platform after restart", cases=["PC-004.3"],
                           runners=("agent-secured:commit", "service-secured:explore"))
        elif key and not re.search(key, result.stdout, re.I | re.S):
            write_journey_diagnostic(f"\n== {FRONT_DOOR}/{SCENARIO}: {command}-output ==\n{result.stdout[-5000:]}\n", env=env)
            fail(f"kb-create {command}: expected human summary '{key}'")
        if command == "status":
            try:
                status_payload = decode_ux_success_result(read_kb_create_cli_result("status", result))
                active_receipt = json.loads((PLATFORM_CURRENT / ".kb/v2/receipt.json").read_text())
                host_status = status_payload.get("host", {})
                installation = status_payload.get("installation", {})
                status_ok = (result.returncode == 0 and status_payload.get("installed") is True
                             and status_payload.get("running") is True and status_payload.get("reachable") is True
                             and host_status.get(layout_value('sharedStateDirectory')) == "running"
                             and installation.get("receiptId") == active_receipt.get("id"))
            except (json.JSONDecodeError, AttributeError, OSError):
                status_ok = False
            if not status_ok:
                fail("kb-create status: expected running/reachable JSON and active receipt ID")
            for status_root in (PLATFORM, PLATFORM_CURRENT, PLATFORM_CURRENT.resolve()):
                spelling_result = run_command([launcher, "status", "--platform-root", str(status_root), "--json"])
                try:
                    spelling_status = decode_ux_success_result(
                        read_kb_create_cli_result("status", spelling_result))
                    spelling_installation = spelling_status.get("installation", {})
                    spelling_ok = (spelling_result.returncode == 0
                                   and spelling_status.get("running") is True
                                   and spelling_status.get("reachable") is True
                                   and spelling_status.get("host", {}).get(layout_value('sharedStateDirectory')) == "running"
                                   and spelling_installation.get("receiptId") == active_receipt.get("id"))
                except (ValueError, json.JSONDecodeError, AttributeError):
                    spelling_ok = False
                if not spelling_ok:
                    fail(f"kb-create status did not identify the running installation through {status_root}")
            record_case("running status", status_ok,
                       "status JSON did not report a running host and active receipt",
                       cases=["PC-001.7", "PC-002.2"])
            if FRONT_DOOR == "agent":
                record_case("agent status", status_ok,
                           "status JSON did not match the apply receipt", cases=["S-039.2"],
                           runners=("agent:commit", "agent-secured:commit", "service-local:explore"))
            if FRONT_DOOR == "human" and not VARIANT.endswith("secured"):
                record_case("human install status", status_ok,
                           "status JSON did not report a running installation", cases=["S-040.3"],
                           requires=("step:candidate provenance",),
                           runners=("human:default", "human:nondefault"))
            if mode == "secured":
                record_case("post-restart status", status_ok,
                           "status JSON did not report a running host after restart", cases=["PC-004.2"],
                           runners=("agent-secured:commit", "service-secured:explore"))

    verify_broken_install_doctor(launcher, env)

    if FRONT_DOOR == "agent" and (VARIANT == "default" or VARIANT.endswith("secured")):
        stable_index = HOME / ".local/share/kb-create/release-index.json"
        canary_index = HOME / "release-index-canary.json"
        if not canary_index.is_file():
            canary_url = BASE_ENV["KB_CREATE_DOWNLOAD_BASE_URL"].rstrip("/") + "/journey-candidate/release-index-canary.json"
            with invocation_context(step_id="installer.fixture.canary-index"):
                canary_status, canary_body, _ = open_http(
                    urllib.request.urlopen, urllib.request.Request(canary_url), timeout=30, env=env)
            if canary_status != 200:
                raise RuntimeError(f"GET {canary_url} returned HTTP {canary_status}")
            canary_index.write_bytes(canary_body)
        installer_secret = env.get("KB_JOURNEY_ADMIN_PASSWORD", "JourneyInstallSecret1!")
        store_report_secret(env, "KB_JOURNEY_ADMIN_PASSWORD", installer_secret,
                            "installer first-admin password")
        def root_isolation_command(args: list[str]):
            installer_env = env.copy()
            if "--secret-env" in args:
                store_report_secret(installer_env, "KB_JOURNEY_ADMIN_PASSWORD", installer_secret,
                                    "root-isolation installer password")
            return run(args, env=installer_env, timeout=1200)[0]
        fixture_env = env
        def installer_command_for_fixture(args: list[str], *, input: str | None = None,
                                          env: Mapping[str, str] | None = None):
            return installer_command(args, env=env if env is not None else fixture_env,
                                     secret=installer_secret, input=input)
        fixture_groups = ISOLATED_FIXTURE_GROUPS
        fixture_group_keys = {group: f"isolated-fixture:{group.__name__}" for group in fixture_groups}
        selected_groups = tuple(group for group in fixture_groups
                                if outer_graph.group_selected(fixture_group_keys[group]))

        installer_case_journey = None
        if selected_groups:
            outer_graph.invalidate_state(
                "host-running", group="host", step="isolated installer fixture host cycle",
                evidence="isolated installer fixtures stop and restart the shared platform host",
            )
            stopped, _ = run([launcher, "stop", "--platform-root", str(PLATFORM), "--json"], env=env, timeout=120)
            if stopped.returncode != 0:
                raise RuntimeError(f"could not stop the main host before isolated installer fixtures: {stopped.stderr or stopped.stdout}")
        try:
            candidate_base = BASE_ENV["KB_CREATE_DOWNLOAD_BASE_URL"].rstrip("/") + "/journey-candidate/"

            def run_installer_case_group():
                container_update_indexes = {}
                for key, filename in (("update", "release-index-update.json"),
                                      ("jump", "release-index-update-jump.json")):
                    status, body, _ = open_http(urllib.request.urlopen,
                        urllib.request.Request(candidate_base + filename), timeout=30, env=env)
                    if status != 200:
                        raise RuntimeError(f"GET {candidate_base + filename} returned HTTP {status}")
                    path = HOME / f"container-{filename}"
                    path.write_bytes(body)
                    container_update_indexes[key] = path
                fixture_journey = run_installer_case_steps(
                    mode=mode, launcher=launcher, stable_index=stable_index,
                    update_index=container_update_indexes["update"],
                    jump_index=container_update_indexes["jump"], canary_index=canary_index,
                    platform_root=PLATFORM, secret_value=installer_secret, registry=REGISTRY,
                    run_command=installer_command_for_fixture)
                register_supplied_password_absence_step(
                    fixture_journey, Path(env["HOME"]), installer_secret)
                return fixture_journey

            fixture_actions = {
                DOCTOR_ROOT_ISOLATION_GROUP: lambda: run_doctor_root_isolation_step(
                    mode=mode, launcher=launcher, stable_index=stable_index, platform_root=PLATFORM,
                    run_command=root_isolation_command),
                INSTALLER_CASE_GROUP: run_installer_case_group,
                APPLY_SCENARIO_GROUP: lambda: run_apply_scenario_step(
                    mode=mode, launcher=launcher, stable_index=stable_index,
                    platform_root=PLATFORM, run_command=installer_command_for_fixture),
                INVALID_REQUEST_GROUP: lambda: run_invalid_request_step(
                    mode=mode, launcher=launcher, stable_index=stable_index,
                    platform_root=PLATFORM, run_command=installer_command_for_fixture),
                MISSING_PROJECT_REQUEST_GROUP: lambda: run_missing_project_request_steps(
                    mode=mode, launcher=launcher, stable_index=stable_index,
                    home=HOME, run_command=installer_command_for_fixture),
            }

            def execute_fixture_group(group):
                nonlocal installer_case_journey
                fixture_journey = fixture_actions[group]()
                if group is INSTALLER_CASE_GROUP:
                    installer_case_journey = fixture_journey
                replay_steps(fixture_journey, CASE_JOURNEY)

            for group in fixture_groups:
                key = fixture_group_keys[group]
                outer_graph.flow(
                    group.__name__, key, "journey.installer-fixture",
                    lambda group=group: execute_fixture_group(group),
                    cases=outer_graph.groups[key].get("cases", ()),
                    record_empty_success=False,
                )
        finally:
            if selected_groups:
                body_error = sys.exc_info()[1]
                started, _ = run([launcher, "start", "--platform-root", str(PLATFORM), "--json"],
                                 env=env, timeout=180)
                if started.returncode != 0:
                    restart_failure = ("could not restart the main host after isolated installer fixtures: "
                                       f"{' '.join((started.stderr or started.stdout).split())[-500:]}")
                    CASE_JOURNEY.step("restart the main host after isolated installer fixtures",
                                      "journey.orchestration", lambda: restart_failure)
                    if body_error is None:
                        raise RuntimeError(restart_failure)
                else:
                    probe_platform_state(outer_graph, env, launcher,
                                         mutator_group="host",
                                         mutator_step="isolated installer fixture host cycle",
                                         include_installed=False, include_version=False)
        if installer_case_journey is not None:
            installer_case_report = Path(journey_value("KB_JOURNEY_SUMMARY", "/summary/journey-summary.md")).with_name(
                f"installer-cases-{mode}.json")
            installer_case_journey.write_json(installer_case_report)
    elif outer_graph.selection_active:
        for group in ISOLATED_FIXTURE_GROUPS:
            key = f"isolated-fixture:{group.__name__}"
            outer_graph.flow(group.__name__, key, "journey.installer-fixture", lambda: None,
                             cases=outer_graph.groups[key].get("cases", ()),
                             record_empty_success=False)

    local_service_journey = FRONT == "agent" and SCENARIO == "explore" and VARIANT == "default"
    secured_service_journey = FRONT == "human" and VARIANT.endswith("secured")
    if BASE_ENV.get("KB_JOURNEY_SERVICE_PROFILE") == "nightly" and (local_service_journey or secured_service_journey):
        mode = "secured" if secured_service_journey else "local"
        service_env = env.copy()
        service_env["KB_JOURNEY_CLI_PATH"] = str(BIN / "kb")
        service_env["KB_JOURNEY_PLATFORM_ROOT"] = str(PLATFORM)
        if mode == "secured":
            service_env["KB_JOURNEY_ADMIN_EMAIL"] = "journey-admin@example.test"
            store_report_secret(service_env, "KB_JOURNEY_ADMIN_PASSWORD",
                                env["KB_JOURNEY_ADMIN_PASSWORD"], "service journey admin password")
            oauth_claims = release_claims_for_case(
                "S-109", case_catalog_root())
            configured = login_and_configure_secured_admin(
                service_env, launcher, configure_oidc=bool(oauth_claims))
            if configured is not None:
                step, result = configured
                fail(f"secured service journey setup: `{step}` exited {result.returncode}; {' '.join(result.stdout.split())[-400:]}")
            if oauth_claims:
                probe_platform_state(outer_graph, env, launcher, mutator_group="auth",
                                     mutator_step="secured auth provider configuration",
                                     include_installed=False,
                                     include_version=False)
        workflow_dir = PROJECT / ".kb" / "workflows"
        workflow_dir.mkdir(parents=True, exist_ok=True)
        (workflow_dir / "e2e-hello.yml").write_text(
            "name: e2e-hello\nversion: 1.0.0\ndescription: Installed service journey smoke workflow\n"
            "on:\n  manual: true\njobs:\n  smoke:\n    runsOn: local\n    steps:\n"
            "      - name: Say hello\n        id: hello\n        uses: builtin:shell\n"
            "        with:\n          command: echo hello-workflow\n",
            encoding="utf-8",
        )
        if outer_graph.states.get("project-registered") is None:
            establish_project_registration(outer_graph, PROJECT, env)
        capture_case_failure()
        def lint_workflow_fixture() -> str | None:
            lint, _ = run(kb_login_shell(["workflow", "lint", "--json"]),
                          env=service_env, cwd=PROJECT, timeout=120)
            return None if lint.returncode == 0 else (
                f"`kb workflow lint --json` exited {lint.returncode}; {' '.join(lint.stdout.split())[-500:]}")
        outer_graph.flow("workflow fixture lint", "workflow", "workflow", lint_workflow_fixture,
                         cases=["S-002.1"],
                         runners=("service-local:explore", "service-secured:explore"))
        capture_case_failure()
        outer_graph.probe_state(
            "workflow-ready", "project", "workflow fixture preparation",
            lambda: None if (workflow_dir / "e2e-hello.yml").is_file()
            else "workflow fixture e2e-hello.yml is missing",
        )
        auth_report = Path(journey_value("KB_JOURNEY_SUMMARY", "/summary/journey-summary.md")).with_name(f"service-auth-{mode}.json")
        auth_journey = Journey(mode, f"auth-{mode}", parent=CASE_JOURNEY)
        if mode == "secured":
            from secured_connection_steps import register_secured_connection_steps
            register_secured_connection_steps(auth_journey, service_env)

        def run_auth_flow():
            if mode == "local":
                run_local_auth_steps("http://127.0.0.1:4000")
            else:
                def restart_auth_host() -> str:
                    mutation = "admin invite, reset, and restart persistence"
                    return restart_shared_host(outer_graph, launcher, env, mutation)

                run_secured_auth_steps(
                    "http://127.0.0.1:4000",
                    service_env["KB_JOURNEY_ADMIN_EMAIL"],
                    service_env["KB_JOURNEY_ADMIN_PASSWORD"],
                    "auth-reset-member@example.test",
                    restart_auth_host,
                )
            return None

        auth_capability = "auth.local" if mode == "local" else "auth.invite-reset"
        if mode == "local":
            auth_journey.step("local identity", auth_capability, run_auth_flow, cases=["S-041.1"],
                              requires=("flow:start platform host",),
                              runners=("service-local:explore",))
            auth_journey.step("local CLI status", "auth.local",
                              lambda: run_cli_auth_status(str(BIN / "kb"), env, authenticated=False),
                              cases=["S-041.5"], runners=("service-local:explore",))
        else:
            auth_journey.step(
                "corrupt saved CLI session returns the repair envelope", "auth.accounts",
                lambda: run_cli_corrupt_session_file(str(BIN / "kb"), service_env),
                cases=["S-041.18"], runners=("service-secured:explore",),
            )
            auth_journey.step("admin invite, reset, and restart persistence", auth_capability, run_auth_flow,
                              cases=["S-041.2", "S-041.3", "S-104.6"],
                              runners=("service-secured:explore",))

            def bootstrap_admin_status():
                if not first_admin_shown_once:
                    raise AssertionError("secured install did not disclose a first administrator credential exactly once")
                installed, _ = run([launcher, "status", "--platform-root", str(PLATFORM), "--json"],
                                   env=service_env, timeout=120)
                status_result = read_kb_create_cli_result("status", installed)
                status_payload = decode_ux_success_result(status_result)
                if status_payload.get("bootstrapCompleted") is not True:
                    raise AssertionError("kb-create status did not report completed first-administrator bootstrap")
                run_cli_auth_status(str(BIN / "kb"), service_env, authenticated=True,
                                    email=service_env["KB_JOURNEY_ADMIN_EMAIL"],
                                    password=service_env["KB_JOURNEY_ADMIN_PASSWORD"],
                                    base_url="http://127.0.0.1:4000")
                status, raw, _ = open_http(
                    urllib.request.urlopen,
                    urllib.request.Request("http://127.0.0.1:4000/health/auth"),
                    timeout=30,
                    env=service_env,
                )
                readiness = json.loads(raw)
                data = readiness.get("data", {})
                if status != 200 or data.get("ok") is not True or data.get("activeAdmins", 0) < 1:
                    raise AssertionError("secured install did not prove a usable active administrator")

            auth_journey.step(
                "bootstrap administrator CLI status", "auth.accounts",
                bootstrap_admin_status,
                cases=["S-100.1", "S-100.5"], runners=("service-secured:explore",),
            )
            recovered_password = "JourneyRecovered123!"

            def store_recovered_password(password: str) -> None:
                store_report_secret(service_env, "KB_JOURNEY_ADMIN_PASSWORD", password,
                                    "recovered journey admin password")

            def bootstrap_admin_recovery():
                removed, _ = run(kb_command([ "project", "remove", str(PROJECT), "--yes", "--json"], executable=str(BIN / "kb")),
                                 env=env, cwd=PROJECT, timeout=90)
                if removed.returncode != 0:
                    raise RuntimeError(f"could not prepare the no-project recovery case: {' '.join(removed.stdout.split())[-400:]}")
                mutation = "bootstrap administrator recovery"
                outer_graph.invalidate_state(
                    "project-registered", group="auth", step=mutation,
                    evidence="the recovery case removed the shared journey project",
                )
                outer_graph.invalidate_state(
                    "session", group="auth", step=mutation,
                    evidence="bootstrap recovery revokes every saved platform session",
                )
                outer_graph.invalidate_state(
                    "host-running", group="auth", step=mutation,
                    evidence="the recovery case stops and restarts the shared platform host",
                )
                run_bootstrap_recovery_steps(
                    launcher, str(PLATFORM), service_env["KB_JOURNEY_ADMIN_EMAIL"],
                    service_env["KB_JOURNEY_ADMIN_PASSWORD"], recovered_password, env, run,
                    on_valid_password=store_recovered_password,
                )
                from service_runner import restore_secured_cli_login
                reestablish_host_and_session(
                    outer_graph, mutation,
                    lambda: host_running_probe(env, launcher),
                    lambda: restore_secured_cli_login(BIN / "kb", service_env),
                )
                added, _ = run(kb_command([ "project", "add", "--json"], executable=str(BIN / "kb")),
                               env=service_env, cwd=PROJECT, timeout=90)
                if added.returncode != 0:
                    raise RuntimeError(f"could not restore the journey project after recovery: {' '.join(added.stdout.split())[-400:]}")
                establish_project_registration(outer_graph, PROJECT, service_env)

            auth_journey.step(
                "bootstrap administrator recovery", "auth.accounts",
                bootstrap_admin_recovery,
                cases=["S-100.2", "S-100.3", "S-100.4"],
                runners=("service-secured:explore",),
            )
            auth_journey.step(
                "tenant API token lifecycle",
                "auth.accounts",
                lambda: run_api_token_lifecycle_steps(
                    "http://127.0.0.1:4000",
                    service_env["KB_JOURNEY_ADMIN_EMAIL"],
                    service_env["KB_JOURNEY_ADMIN_PASSWORD"],
                    "auth-reset-member@example.test",
                    "JourneyReplacement123!",
                ),
                cases=["S-103.1", "S-103.2", "S-103.3", "S-103.4", "S-103.5"],
                requires=("state:host-running", "state:project-registered", "state:session"),
                runners=("service-secured:explore",),
            )
            auth_journey.step(
                "last active administrator cannot be disabled or demoted",
                "auth.accounts",
                lambda: run_last_admin_guard_steps(
                    "http://127.0.0.1:4000", service_env["KB_JOURNEY_ADMIN_EMAIL"],
                    service_env["KB_JOURNEY_ADMIN_PASSWORD"],
                ),
                cases=["S-104.7"],
                requires=("state:host-running", "state:project-registered", "state:session"),
                runners=("service-secured:explore",),
            )
            auth_journey.step(
                "revoke pending invites and reject invalid activation tokens",
                "auth.accounts",
                lambda: run_invite_lifecycle_steps(
                    "http://127.0.0.1:4000", service_env["KB_JOURNEY_ADMIN_EMAIL"],
                    service_env["KB_JOURNEY_ADMIN_PASSWORD"],
                ),
                cases=["S-105.1", "S-105.2", "S-105.3", "S-105.4"],
                requires=("state:host-running", "state:project-registered", "state:session"),
                runners=("service-secured:explore",),
            )
            auth_journey.step(
                "member CLI login and token listing", "auth.accounts",
                lambda: run_cli_auth_status(str(BIN / "kb"), service_env, authenticated=True,
                                            email="auth-reset-member@example.test",
                                            password="JourneyReplacement123!",
                                            base_url="http://127.0.0.1:4000"),
                cases=["S-041.6"], requires=("state:host-running", "state:project-registered", "state:session"),
                runners=("service-secured:explore",),
            )
            auth_journey.step(
                "member reset-link command returns the shared permission envelope", "auth.accounts",
                lambda: run_cli_auth_forbidden(str(BIN / "kb"), service_env),
                cases=["S-041.9"], requires=("state:host-running", "state:project-registered", "state:session"),
                runners=("service-secured:explore",),
            )
            auth_journey.step(
                "change password and manage browser sessions", "auth.accounts",
                lambda: run_password_and_session_steps(
                    "http://127.0.0.1:4000", "auth-reset-member@example.test", "JourneyReplacement123!"),
                cases=["S-101.1", "S-101.2", "S-101.3", "S-102.1", "S-102.2"],
                requires=("state:host-running", "state:project-registered", "state:session"),
                runners=("service-secured:explore",),
            )
            auth_journey.step(
                "CLI logout clears saved session", "auth.accounts",
                lambda: run_cli_logout_steps(str(BIN / "kb"), service_env),
                cases=["S-102.3"], requires=("state:host-running", "state:project-registered", "state:session"),
                runners=("service-secured:explore",),
            )
        auth_result = auth_journey.write_json(auth_report)
        if auth_result.status != "PASS":
            fail(f"{mode} auth journey: {auth_result.first_failure}")
            first = auth_result.first_failure or {}
        if mode == "secured":
            def session_probe() -> str | None:
                login, _ = run(kb_command([ "auth", "login", "--gateway-url",
                                "http://127.0.0.1:4000", "--email",
                                service_env["KB_JOURNEY_ADMIN_EMAIL"], "--password",
                                service_env["KB_JOURNEY_ADMIN_PASSWORD"]], executable=str(BIN / "kb")),
                               env=service_env, cwd=PROJECT, timeout=90)
                return None if login.returncode == 0 else "fresh admin login was rejected after the auth journey"
            outer_graph.probe_state("session", "auth", "fresh admin login", session_probe)
        else:
            outer_graph.probe_state("session", "auth", "local auth mode", lambda: None)
        prepare_workflow_fixtures(PROJECT)
        service_report = Path(journey_value("KB_JOURNEY_SUMMARY", "/summary/journey-summary.md")).with_name(f"service-{mode}.json")
        studio_fixture_file = service_report.with_name("studio-analytics-fixtures.json")
        project_fixture_file = service_report.with_name(f"project-fixtures-{mode}.json")
        studio_fixture_file.unlink(missing_ok=True)
        project_fixture_file.unlink(missing_ok=True)
        service_env["KB_JOURNEY_STUDIO_FIXTURE_FILE"] = str(studio_fixture_file)
        service_env["KB_JOURNEY_PROJECT_FIXTURES_FILE"] = str(project_fixture_file)
        export_graph_state_to_child_environment(outer_graph, service_env)
        service_env["KB_JOURNEY_NEEDED_STATES"] = ",".join(sorted(outer_graph.needed_states))
        result, elapsed = run(["python3", str(journey_module("service_runner.py")), "--mode", mode, "--output", str(service_report)],
                             env=service_env, timeout=900)
        TIMES[f"{mode} service journeys"] = elapsed
        if service_report.exists():
            try:
                service_payload = json.loads(service_report.read_text())
                service_states = service_payload.get("states", {})
                if isinstance(service_states, dict):
                    outer_graph.states.update(service_states)
                else:
                    fail("service runner result states field was not an object")
            except (OSError, json.JSONDecodeError) as error:
                fail(f"service runner result could not provide state probes: {error}")
        if result.returncode != 0:
            try:
                service_result = json.loads(service_report.read_text())
                detail = journey_verdict_detail(service_result)
            except (OSError, json.JSONDecodeError):
                excerpt = " ".join(result.stdout.split())[-1500:]
                detail = f"service_runner exited {result.returncode} without a result JSON; {excerpt or 'no output'}"
            fail(f"{mode} service journey: {detail}")

        if not service_report.exists():
            block_outer_dependents(outer_graph, ["marketplace", "marketplace-fixtures", "adapters",
                                                 "plugin-author", "workflow", "analytics", "studio"])
            _run_final_uninstall(outer_graph, env, launcher)
            return finalize_run(False)
        fixture_state_needed = (not outer_graph.selection_active
                                or "fixtures-installed" in outer_graph.needed_states)
        project_b_consumers_selected = (
            not outer_graph.selection_active
            or bool(outer_graph.selected_groups & {"workflow", "studio"})
            or outer_graph.group_selected("update-variants")
        )
        if fixture_state_needed or project_b_consumers_selected:
            project_b_handoff = project_b_fixture_from_state(outer_graph)
            if isinstance(project_b_handoff, ProjectBRootInvalid):
                handoff_diagnostic = json.dumps(project_b_handoff.diagnostic, sort_keys=True)
                fail(handoff_diagnostic)
                invalidate_project_b_handoff(outer_graph, project_b_handoff)
                export_graph_state_to_child_environment(outer_graph, service_env)
        workflow_journey = Journey(mode, f"workflow-{mode}")
        def restart_for_workflow_history() -> None:
            restart_shared_host(outer_graph, launcher, env, "workflow history checkpoint")

        workflow_claims = ([f"S-002.{step}" for step in range(1, 7)]
                           + [f"S-008.{step}" for step in range(1, 5)]
                           + [f"S-027.{step}" for step in range(1, 4)]
                           + [f"S-028.{step}" for step in range(1, 4)]
                           + [f"S-143.{step}" for step in range(1, 5)])
        outer_graph.flow(
            "workflow execution journey", "workflow", "workflow",
            lambda: run_workflow_with_host_boundary(
                outer_graph, env=env, launcher=launcher,
                action=lambda: run_workflow_journey(
                    workflow_journey,
                    env=service_env,
                    project=PROJECT,
                    restart_host=restart_for_workflow_history,
                ),
            ),
            cases=workflow_claims, record_empty_success=False,
            runners=("service-local:explore", "service-secured:explore"),
        )
        if isinstance(project_b_handoff, ProjectBRootValid):
            project_b_fixture_root = project_b_handoff.root
            prepare_workflow_fixtures(project_b_fixture_root)
            definitions_deadline = time.monotonic() + 30
            healthy_workflow_ready = False
            while time.monotonic() < definitions_deadline:
                with invocation_context(step_id="journey.setup"):
                    definitions_result, _ = run(kb_login_shell(["workflow", "defs", "list", "--json"]),
                                                env=service_env, cwd=project_b_fixture_root, timeout=90)
                try:
                    definitions_data = decode_ux_success_result(
                        read_ux_cli_result(definitions_result))
                    healthy_workflow_ready = isinstance(definitions_data, list) and any(
                        isinstance(item, dict) and item.get("id") == "journey-hello" for item in definitions_data)
                except json.JSONDecodeError:
                    healthy_workflow_ready = False
                if healthy_workflow_ready:
                    break
                time.sleep(1)
            healthy_result = None
            if healthy_workflow_ready:
                with invocation_context(step_id="journey.setup"):
                    healthy_result, _ = run(
                        kb_login_shell(["workflow", "run", "--workflow-id=journey-hello",
                                        '--input={"message":"studio-healthy-project"}', "--json"]),
                        env=service_env, cwd=project_b_fixture_root, timeout=120)
            try:
                healthy_data = (decode_ux_success_result(
                    read_ux_cli_result(healthy_result)) if healthy_result else {})
                healthy_run_id = healthy_data.get("runId", "") if isinstance(healthy_data, dict) else ""
            except json.JSONDecodeError:
                healthy_run_id = ""
            if healthy_result is not None and healthy_result.returncode == 0 and isinstance(healthy_run_id, str) and healthy_run_id:
                healthy_deadline = time.monotonic() + 180
                while time.monotonic() < healthy_deadline:
                    with invocation_context(step_id="journey.setup"):
                        viewed, _ = run(kb_login_shell(["workflow", "runs", "view", healthy_run_id, "--json=all"]),
                                        env=service_env,
                                        cwd=project_b_fixture_root, timeout=90)
                    try:
                        detail = decode_ux_success_result(read_ux_cli_result(viewed))
                    except json.JSONDecodeError:
                        detail = {}
                    if isinstance(detail, dict) and detail.get("status") in {"success", "failed", "cancelled"}:
                        if detail.get("status") == "success":
                            service_env["KB_STUDIO_HEALTHY_PROJECT_RUN_ID"] = healthy_run_id
                        break
                    time.sleep(2)
        workflow_result = workflow_journey.result()
        merge_workflow_result(service_report, workflow_result.__dict__)
        if workflow_result.status != "PASS":
            fail(f"{mode} workflow journey: {workflow_result.first_failure}")
            first = workflow_result.first_failure or {}

        oauth_claims = (release_claims_for_case("S-109", case_catalog_root())
                        if mode == "secured" else [])

        run_studio_browser_group = reject_unprepared_studio_flow
        if isinstance(project_b_handoff, ProjectBRootValid) and (
                not outer_graph.selection_active or "studio" in outer_graph.selected_groups):
            project_state = outer_graph.states.get("project-registered")
            if project_state is not None and project_state.get("passed") is True:
                project_result = project_registration_from_state(
                    outer_graph.state_value_if_passed("project-registered"))
                project_id = project_result.project_id
                project_name = project_result.name
                studio_env = create_studio_environment(
                    service_env,
                    mode=mode,
                    project_id=project_id,
                    project_name=project_name,
                    project_root=str(PROJECT),
                    kb_bin=str(BIN / "kb"),
                )
                studio_env["KB_STUDIO_PLAYWRIGHT_OUTPUT_DIR"] = str(
                    studio_playwright_output_directory(service_report))
                for key in ("KB_STUDIO_OAUTH_JOURNEY", "KB_STUDIO_OIDC_PROVIDER_ID",
                            "KB_STUDIO_OIDC_PROVIDER_NAME", "KB_STUDIO_OIDC_EMAIL"):
                    studio_env.pop(key, None)
                if mode == "secured":
                    if oauth_claims:
                        studio_env["KB_STUDIO_OAUTH_JOURNEY"] = "1"
                        studio_env["KB_STUDIO_OIDC_PROVIDER_ID"] = "corp"
                        studio_env["KB_STUDIO_OIDC_PROVIDER_NAME"] = "corp"
                        studio_env["KB_STUDIO_OIDC_EMAIL"] = service_env["KB_JOURNEY_ADMIN_EMAIL"]
                cron_id = "studio-a"
                (PROJECT / ".kb" / "crons").mkdir(parents=True, exist_ok=True)
                (PROJECT / ".kb" / "crons" / f"{cron_id}.yml").write_text(
                    "schedule: '0 0 * * *'\nworkflow: journey-hello\ninput:\n  message: studio-a\nenabled: true\n",
                    encoding="utf-8")
                project_a_plugin_cron_ids = []
                project_a_user_cron_ids = []
                project_a_cron_error = "project A cron list did not contain the fixture user and plugin crons"
                cron_list_deadline = time.monotonic() + 30
                while time.monotonic() < cron_list_deadline:
                    project_a_cron_list, _ = run(
                        kb_login_shell(["workflow", "crons", "list", "--json"]),
                        env=studio_env, cwd=PROJECT, timeout=120)
                    try:
                        cron_payload = decode_ux_success_result(
                            read_ux_cli_result(project_a_cron_list))
                        project_a_crons = cron_payload["crons"]
                        project_a_plugin_cron_ids = [str(cron["id"]) for cron in project_a_crons
                                                     if isinstance(cron, dict) and cron.get("source") == "plugin"]
                        project_a_user_cron_ids = [str(cron["id"]) for cron in project_a_crons
                                                   if isinstance(cron, dict) and cron.get("source") == "user"]
                        if (project_a_cron_list.returncode == 0 and project_a_plugin_cron_ids
                                and cron_id in project_a_user_cron_ids):
                            break
                    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
                        project_a_cron_error = str(error)
                    time.sleep(1)
                else:
                    fail(f"Studio schedule journey could not list project A crons: {project_a_cron_error}")
                project_b_root = project_b_handoff.root
                (project_b_root / ".kb" / "workflows").mkdir(parents=True, exist_ok=True)
                (project_b_root / ".kb" / "crons").mkdir(parents=True, exist_ok=True)
                (project_b_root / ".kb" / "workflows" / "studio-b-workflow.yml").write_text(
                    "name: studio-b-workflow\nversion: 1.0.0\non:\n  manual: true\njobs:\n  smoke:\n    runsOn: local\n    steps:\n"
                    "      - name: Log B\n        id: log-b\n        uses: builtin:shell\n        with:\n          command: 'echo studio-b'\n",
                    encoding="utf-8")
                (project_b_root / ".kb" / "crons" / "studio-b.yml").write_text(
                    "schedule: '0 0 * * *'\nworkflow: studio-b-workflow\nenabled: true\n", encoding="utf-8")
                studio_env.update({
                    "KB_STUDIO_CRON_PROJECT_ROOT": str(PROJECT),
                    "KB_STUDIO_CRON_ID": cron_id,
                    "KB_STUDIO_PROJECT_A_PLUGIN_CRON_IDS": ",".join(project_a_plugin_cron_ids),
                    "KB_STUDIO_PROJECT_A_USER_CRON_IDS": ",".join(project_a_user_cron_ids),
                    "KB_STUDIO_PROJECT_B_ID": project_b_handoff.project_id,
                    "KB_STUDIO_PROJECT_B_CRON_ID": "studio-b",
                    "KB_STUDIO_PLAYWRIGHT_JSON": str(service_report.with_name(f"studio-playwright-{mode}.json")),
                    "KB_STUDIO_PROJECT_A_NAME": project_name,
                    "KB_STUDIO_PROJECT_B_NAME": project_b_root.name,
                })
                try:
                    studio_env.update(prepare_studio_fixtures(
                        service_env,
                        project_b_id=project_b_handoff.project_id,
                        project_a=PROJECT,
                        project_b=project_b_root,
                    ))
                except (RuntimeError, OSError, TimeoutExpired) as error:
                    fail(f"Studio fixture setup: {error}")
                if service_env.get("KB_STUDIO_DIAGNOSTIC_RUN_ID") and service_env.get("KB_STUDIO_HEALTHY_PROJECT_RUN_ID"):
                    studio_env["KB_STUDIO_DIAGNOSTIC_PROJECT"] = project_name
                    studio_env["KB_STUDIO_DIAGNOSTIC_RUN_ID"] = service_env["KB_STUDIO_DIAGNOSTIC_RUN_ID"]
                    studio_env["KB_STUDIO_HEALTHY_PROJECT_RUN_ID"] = service_env["KB_STUDIO_HEALTHY_PROJECT_RUN_ID"]
                if studio_fixture_file.is_file():
                    analytics_fixture = json.loads(studio_fixture_file.read_text())
                    analytics_fields = {
                        "eventType": "KB_STUDIO_ANALYTICS_EVENT_TYPE",
                        "source": "KB_STUDIO_ANALYTICS_SOURCE",
                        "model": "KB_STUDIO_ANALYTICS_MODEL",
                        "eventId": "KB_STUDIO_ANALYTICS_EVENT_ID",
                    }
                    if all(isinstance(analytics_fixture.get(key), str) and analytics_fixture[key]
                           for key in analytics_fields):
                        studio_env.update({target: analytics_fixture[key]
                                           for key, target in analytics_fields.items()})
                    project_event_fields = {
                        "projectAEvent": "KB_STUDIO_PROJECT_A_EVENT",
                        "projectBEvent": "KB_STUDIO_PROJECT_B_EVENT",
                    }
                    if all(isinstance(analytics_fixture.get(key), str) and analytics_fixture[key]
                           for key in project_event_fields):
                        studio_env.update({target: analytics_fixture[key]
                                           for key, target in project_event_fields.items()})
                try:
                    recorded_service_result = json.loads(service_report.read_text())
                    studio_shell = next((step for step in recorded_service_result.get("steps", [])
                                         if step.get("capability") == "studio" and step.get("name") == "Studio shell"), None)
                    studio_shell_passed = studio_shell is not None and studio_shell.get("status") == "PASS"
                except (OSError, json.JSONDecodeError):
                    studio_shell_passed = False
                if mode == "secured":
                    try:
                        with invocation_context(step_id="journey.setup"):
                            member_email, member_password = create_studio_member(
                                "http://127.0.0.1:4000", service_env["KB_JOURNEY_ADMIN_EMAIL"],
                                service_env["KB_JOURNEY_ADMIN_PASSWORD"])
                        studio_env["KB_STUDIO_MEMBER_EMAIL"] = member_email
                        store_report_secret(studio_env, "KB_STUDIO_MEMBER_PASSWORD", member_password,
                                            "Studio member password")
                        with invocation_context(step_id="journey.setup"):
                            admin_token, member_token = create_studio_access_tokens(
                                "http://127.0.0.1:4000", service_env["KB_JOURNEY_ADMIN_EMAIL"],
                                service_env["KB_JOURNEY_ADMIN_PASSWORD"], member_email, member_password,
                                env=service_env)
                        store_report_secret(studio_env, "KB_STUDIO_ADMIN_TOKEN", admin_token,
                                            "Studio admin access token")
                        store_report_secret(studio_env, "KB_STUDIO_MEMBER_TOKEN", member_token,
                                            "Studio member access token")
                        required_studio_credentials = (
                            "KB_STUDIO_ADMIN_EMAIL", "KB_STUDIO_ADMIN_PASSWORD",
                            "KB_STUDIO_MEMBER_EMAIL", "KB_STUDIO_MEMBER_PASSWORD",
                        )
                        missing_studio_credentials = [key for key in required_studio_credentials
                                                      if not studio_env.get(key)]
                        if missing_studio_credentials:
                            raise RuntimeError(
                                "secured Studio test setup did not export "
                                + ", ".join(missing_studio_credentials)
                                + "; provide journey admin credentials and rerun the secured journey"
                            )
                    except (KeyError, RuntimeError, urllib.error.URLError, ValueError) as error:
                        fail(f"Studio secured member setup: {error}")
                def run_studio_browser_group(studio_cases: tuple[str, ...]) -> str | None:
                    studio_claims = ",".join([*studio_cases, *oauth_claims])
                    with invocation_context(step_id=studio_claims):
                        studio_passed, studio_elapsed, studio_message = run_studio_browser_step([
                            "/opt/kb-studio-playwright/node_modules/.bin/playwright", "test",
                            "--config=/opt/kb-studio-playwright/playwright.config.mjs",
                        ], studio_env, service_report, mode, studio_shell_passed,
                            cases=list(studio_cases), timeout=660)
                    TIMES["Studio browser journey"] = studio_elapsed
                    return None if studio_passed else studio_message
        else:
            run_studio_browser_group = lambda _studio_cases: reject_unprepared_studio_flow()
        if project_b_handoff is None:
            if outer_graph.group_selected("studio"):
                raise JourneyContractError("Studio selection has no Project B fixture handoff result")
            studio_case_action = lambda _studio_cases: reject_unprepared_studio_flow()
        elif isinstance(project_b_handoff, ProjectBRootInvalid):
            studio_case_action = lambda _studio_cases: json.dumps(
                project_b_handoff.diagnostic, sort_keys=True)
        else:
            studio_case_action = run_studio_browser_group
        outer_graph.flow(
            "Studio browser journey", "studio", "studio", None,
            cases=[
                "S-106.1", "S-106.2", "S-106.3", "S-106.4", "S-106.5", "S-106.6",
                "S-107.1", "S-107.2", "S-107.3",
            ], runners=("service-local:explore", "service-secured:explore"),
            case_action=studio_case_action,
        )
        capture_case_failure()
    update_variants_selected = outer_graph.group_selected("update-variants")
    variant_gate = "SKIPPED"
    if update_variants_selected:
        if project_b_handoff is None:
            project_b_handoff = project_b_fixture_from_state(outer_graph)
            if isinstance(project_b_handoff, ProjectBRootInvalid):
                fail(json.dumps(project_b_handoff.diagnostic, sort_keys=True))
                invalidate_project_b_handoff(outer_graph, project_b_handoff)
        if isinstance(project_b_handoff, ProjectBRootValid):
            variant_action = lambda: None
        elif isinstance(project_b_handoff, ProjectBRootInvalid):
            variant_action = lambda: json.dumps(project_b_handoff.diagnostic, sort_keys=True)
        else:
            raise JourneyContractError("update variants have no Project B fixture handoff result")
        variant_gate = outer_graph.flow(
            "platform update variant prerequisites", "update-variants", "platform.update",
            variant_action,
            cases=outer_graph.groups.get("update-variants", {}).get("cases", ()),
        )
        update_variants_selected = variant_gate == "PASS"
    else:
        outer_graph.skip_unselected("platform update variant prerequisites", "platform.update")
    if update_variants_selected:
        try:
            candidate_base = BASE_ENV["KB_CREATE_DOWNLOAD_BASE_URL"].rstrip("/") + "/journey-candidate/"
            variant_indexes = {}
            for key, filename in (("base", "release-index.json"),
                                  ("update", "release-index-update.json"),
                                  ("patch", "release-index-update.json"),
                                  ("minor", "release-index-update-minor.json"),
                                  ("jump", "release-index-update-jump.json"),
                                  ("next", "release-index-update.json"),
                                  ("bad_checksum", "release-index-update-bad-checksum.json"),
                                  ("config_failure", "release-index-update-config-failure.json"),
                                  ("doctor_failure", "release-index-update-doctor-failure.json"),
                                  ("failed_host", "release-index-update-failed-host.json"),
                                  ("healthy_host", "release-index-update-healthy-host.json")):
                status, body, _ = open_http(urllib.request.urlopen,
                    urllib.request.Request(candidate_base + filename), timeout=30, env=env)
                if status != 200:
                    raise RuntimeError(f"GET {candidate_base + filename} returned HTTP {status}")
                path = HOME / filename
                path.write_bytes(body)
                variant_indexes[key] = path
            variant_request = HOME / "platform-update-variant-request.json"
            active_receipt = json.loads((PLATFORM_CURRENT / ".kb/v2/receipt.json").read_text())
            variant_request.write_text(json.dumps(active_receipt["plan"]["request"]) + "\n")
            if not isinstance(project_b_handoff, ProjectBRootValid):
                raise JourneyContractError("update variants reached execution without a valid Project B root handoff")
            project_b_path = project_b_handoff.root
            def variant_run(args, cwd):
                result, _ = run(args, env=service_env, cwd=cwd, timeout=1200)
                return result
            def variant_run_interactive(args, cwd):
                answered = False
                def choose_proceed(transcript):
                    nonlocal answered
                    lowered = transcript.lower()
                    if not answered and any(word in lowered for word in ("wait or", "proceed?", "wait?")):
                        answered = True
                        return "n\n"
                    return None
                result, _ = run_pty_command(args, env=service_env, cwd=cwd, timeout=120,
                                            on_output=choose_proceed)
                return result
            variant_report = Path(journey_value("KB_JOURNEY_SUMMARY", "/summary/journey-summary.md")).with_name(
                f"platform-update-variants-{mode}.json")
            variant_journey = (update_variant_runner or run_platform_update_variant_steps)(
                mode=mode, launcher=launcher, kb_binary=str(BIN / "kb"), platform_root=PLATFORM,
                project_a=PROJECT, project_b=project_b_path, request_file=variant_request,
                base_index=variant_indexes["base"], update_index=variant_indexes["update"],
                patch_index=variant_indexes["patch"], minor_index=variant_indexes["minor"],
                jump_index=variant_indexes["jump"], next_index=variant_indexes["next"],
                bad_checksum_index=variant_indexes["bad_checksum"],
                config_failure_index=variant_indexes["config_failure"],
                doctor_failure_index=variant_indexes["doctor_failure"],
                failed_host_index=variant_indexes["failed_host"],
                healthy_host_index=variant_indexes["healthy_host"],
                run=variant_run, run_interactive=variant_run_interactive,
                mcp_token=service_env.get("KB_MCP_TOKEN"),
                case_journey=CASE_JOURNEY,
            )
            variant_result = variant_journey.write_json(variant_report)
            if variant_result.status != "PASS":
                first = variant_result.first_failure or {}
                fail(f"platform update variant journey: {first.get('name', 'step')}: {first.get('message', '')}")
        except Exception as error:
            log_group_exception("platform update variants")
            fail(f"platform update variants: {error}")
    elif outer_graph.selection_active and variant_gate != "BLOCKED":
        outer_graph.skip_unselected("platform update variant journey", "platform.update")
    add_installed_host_stop_case_step(
        outer_graph.journey, PLATFORM, env,
        runner=lambda command, **options: run(
            command, env=options.get("env"), cwd=options.get("cwd"),
            timeout=options.get("timeout", 120),
        )[0],
    )
    passed = _run_final_uninstall(outer_graph, env, launcher)
    return finalize_run(passed)


def main(*, update_variant_runner=None):
    """Validate the shell/container selection contract before any journey step runs."""
    selection = active_journey_selection() or read_journey_selection(os.environ, strict=True)
    with use_journey_selection(selection):
        return _main(update_variant_runner=update_variant_runner)


def cleanup() -> None:
    graph = ACTIVE_OUTER_GRAPH
    for process in graph.resources if graph is not None else ():
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
    shutil.rmtree(HOME, ignore_errors=True)


if __name__ == "__main__":
    exit_code = 0
    try:
        exit_code = main()
    except Exception as error:
        if CASE_JOURNEY is not None:
            diagnostics = Path(journey_value("KB_JOURNEY_SUMMARY", "/summary/journey-summary.md")).with_name(
                "journey-diagnostics.log")
            record_runner_exception(CASE_JOURNEY, error, diagnostics, env=BASE_ENV)
        else:
            log_group_exception("outer journey orchestration")
        fail(f"outer journey orchestration: {error}")
        if (ACTIVE_OUTER_GRAPH is not None and ACTIVE_MAIN_ENV is not None and ACTIVE_LAUNCHER
                and (PLATFORM_CURRENT / ".kb" / "v2" / "receipt.json").is_file()):
            _run_final_uninstall(ACTIVE_OUTER_GRAPH, ACTIVE_MAIN_ENV, ACTIVE_LAUNCHER)
        exit_code = finalize_run(False)
    finally:
        cleanup()
    raise SystemExit(exit_code)
