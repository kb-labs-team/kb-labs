"""Installed update variants that exercise sealed releases and preserved state."""
from __future__ import annotations

from kb_invocation import kb_command
from installed_fixture import layout_relative, layout_value, preserved_user_state_files

from project_service_path import project_service_path
from redaction import redact_text

import hashlib
import json
import os
from contextlib import closing
import sqlite3
from pathlib import Path
from typing import Callable
from urllib.request import Request, urlopen

from invocations import (
    CompletedProcess,
    catalogued_error_hint,
    catalogued_error_message,
    decode_ux_error_result,
    decode_ux_success_result,
    read_kb_create_cli_result,
    start_background_command,
)
from service_steps import Journey, StructuredJourneyError
from journey_resources import active_platform_root, shared_runtime_file_fingerprints, snapshot_state_tree
from service_port_assertions import service_ports


Run = Callable[[list[str], Path], CompletedProcess]
InteractiveRun = Callable[[list[str], Path], CompletedProcess]


def _payload(result: CompletedProcess, label: str) -> dict:
    value = read_kb_create_cli_result(result.args[1], result)
    if result.returncode:
        error = decode_ux_error_result(value)
        if isinstance(error, dict):
            raise StructuredJourneyError(error)
        raise RuntimeError(f"{label}: expected a structured error")
    payload = decode_ux_success_result(value)
    if not isinstance(payload, dict):
        raise RuntimeError(f"{label}: expected an object result")
    return payload


def _target(index: Path) -> str:
    value = json.loads(index.read_text())
    return value["channels"]["stable"]


def _install_vibeproxy_adapter(kb_binary: str, run: Run, cwd: Path) -> None:
    result = run(kb_command(["marketplace", "install", "@kb-labs/adapters-vibeproxy",
                             "--scope", "platform", "--json"], executable=kb_binary), cwd)
    _payload(result, "install VibeProxy adapter for update preservation")


def _request_for(source: Path, version: str, target: Path) -> None:
    request = json.loads(source.read_text())
    request.setdefault("platform", {})["version"] = version
    request["platform"].pop("channel", None)
    request["sdk"] = {"version": version}
    target.write_text(json.dumps(request) + "\n")


def _component_version(payload: dict) -> str | None:
    return payload.get("installedVersion") or payload.get("platformVersion")


def _file_fingerprints(root: Path, projects: tuple[Path, ...]) -> dict[str, str]:
    result = {}
    paths = list(preserved_user_state_files(root))
    paths.extend(project / ".kb" / name for project in projects
                 for name in ("marketplace.lock.json", "project.json", "kb.config.jsonc"))
    for path in paths:
        if path.is_file():
            result[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def _database_rows(root: Path) -> dict[str, dict[str, int]]:
    rows: dict[str, dict[str, int]] = {}
    for path in root.rglob("*.sqlite"):
        if not path.is_file():
            continue
        uri = f"file:{path}?mode=ro"
        try:
            with closing(sqlite3.connect(uri, uri=True, timeout=1)) as connection:
                tables = [row[0] for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
                rows[str(path)] = {table: int(connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
                                   for table in tables}
        except sqlite3.Error as error:
            raise RuntimeError(f"cannot verify persisted SQLite rows in {path}: {error}") from error
    return rows


def _retains_rows(before: dict[str, dict[str, int]], after: dict[str, dict[str, int]]) -> bool:
    return all(path in after and all(after[path].get(table, -1) >= count
                                     for table, count in tables.items())
               for path, tables in before.items())


def _error(result: CompletedProcess, label: str) -> dict:
    value = read_kb_create_cli_result(result.args[1], result)
    if result.returncode == 0:
        raise RuntimeError(f"{label}: expected a typed failure but command succeeded")
    return decode_ux_error_result(value)


def run_platform_update_variant_steps(
    *, mode: str, launcher: str, kb_binary: str, platform_root: Path,
    project_a: Path, project_b: Path, request_file: Path,
    base_index: Path, update_index: Path, patch_index: Path, minor_index: Path, jump_index: Path,
    next_index: Path, bad_checksum_index: Path, config_failure_index: Path,
    doctor_failure_index: Path, failed_host_index: Path, healthy_host_index: Path,
    run: Run, run_interactive: InteractiveRun, mcp_token: str | None = None,
    case_journey: Journey | None = None,
) -> Journey:
    journey = case_journey or Journey(mode, f"platform-update-variants-{mode}")
    def claim_step(name: str, capability: str, check: Callable[[], str | None], *, cases: list[str],
                   requires: tuple[str, ...]):
        return journey.step(name, capability, check, cases=cases, requires=requires)

    root = str(platform_root)
    def capture_shared_update_state():
        running_tree = active_platform_root(platform_root)
        return (snapshot_state_tree(platform_root / layout_value('sharedStateDirectory')),
                shared_runtime_file_fingerprints(platform_root), running_tree,
                (running_tree / layout_value('versionStatePaths.kb_marketplace_lock')).read_bytes(),
                (running_tree / layout_value('sharedRuntimePaths.kb_kb_config_jsonc.platformPath')).read_bytes())

    def assert_shared_update_state_unchanged(label: str, before) -> None:
        state_before, runtime_fingerprints_before, running_tree, lock_before, config_before = before
        if snapshot_state_tree(platform_root / layout_value('sharedStateDirectory')) != state_before:
            raise RuntimeError(f"{label} changed the shared state tree")
        if shared_runtime_file_fingerprints(platform_root) != runtime_fingerprints_before:
            raise RuntimeError(f"{label} changed shared runtime file projections")
        if ((running_tree / layout_value('versionStatePaths.kb_marketplace_lock')).read_bytes() != lock_before
                or (running_tree / layout_value('sharedRuntimePaths.kb_kb_config_jsonc.platformPath')).read_bytes() != config_before):
            raise RuntimeError(f"{label} changed the still-running version's lock or config view")
    request = platform_root / layout_value('sharedStateDirectory') / "update-variant-request.json"
    receipt_path = platform_root / layout_relative('currentLink', '.kb/v2/receipt.json')
    initial_receipt = json.loads(receipt_path.read_text())
    baseline_version = initial_receipt["plan"]["serviceGraph"]["platformVersion"]
    before_files: dict[str, str] = {}
    before_rows: dict[str, dict[str, int]] = {}
    before_services: dict[str, bool] = {}
    before_project_settings: dict[str, dict] = {}
    workflow_id = ""
    workflow_job_id = ""
    workflow_marker = project_a / ".kb/workflows/update-variant.marker"
    workflow_file = project_a / ".kb/workflows/update-variant.yml"
    def cli(args: list[str], cwd: Path = project_a) -> CompletedProcess:
        return run(args, cwd)

    def save_preservation_fixture() -> None:
        nonlocal before_services
        _install_vibeproxy_adapter(kb_binary, run, project_a)
        for project in (project_a, project_b):
            installed = cli(kb_command([ "marketplace", "install", "@kb-labs/commit", "--json"], executable=kb_binary), project)
            _payload(installed, f"install preservation plugin in {project}")
            setting = [{"id": f"update-{project.name}", "label": f"{project.name} update scope", "path": "."}]
            configured = cli(kb_command([ "config", "set", "plugins.commit.scope.scopes",
                              json.dumps(setting), "--json"], executable=kb_binary), project)
            _payload(configured, f"set per-project plugin settings in {project}")
            before_project_settings[str(project)] = setting
        config = cli(kb_command([ "config", "set", "--scope", "platform", "platform.adapters.llm",
                      "@kb-labs/adapters-vibeproxy", "--json"], executable=kb_binary))
        _payload(config, "configure non-default adapter")
        secret = cli(kb_command([ "config", "set", "--scope", "platform", "platform.adapterOptions.llm.apiKey",
                      "${VIBEPROXY_API_KEY}", "--json"], executable=kb_binary))
        _payload(secret, "configure adapter secret reference")
        project_payload = _payload(cli(kb_command([ "project", "list", "--json"], executable=kb_binary)), "list registered projects")
        projects = project_payload.get("projects", [])
        if len(projects) < 2:
            raise RuntimeError("preservation fixture needs two registered projects")
        initial_services = initial_receipt.get("plan", {}).get("serviceGraph", {}).get("services")
        if not isinstance(initial_services, list) or not initial_services or any(
                not isinstance(service, dict) or not service.get("id") or "required" not in service
                for service in initial_services):
            raise RuntimeError("active receipt omitted its selected service graph")
        before_services = {service["id"]: service["required"] for service in initial_services}
        before_files.update(_file_fingerprints(platform_root, (project_a, project_b)))
        before_rows.update(_database_rows(platform_root.parent))
        if not before_rows:
            raise RuntimeError("preservation fixture has no persisted SQLite rows to compare")
        if not any(count > 0 for tables in before_rows.values() for count in tables.values()):
            raise RuntimeError("preservation fixture has no populated SQLite row to preserve")

    def prepare_preservation_fixture() -> None:
        save_preservation_fixture()

    claim_step("prepare update preservation baseline", "platform.update", prepare_preservation_fixture,
               cases=[], requires=("state:project-registered",))

    def plan_multi_release_notes() -> None:
        target = _target(jump_index)
        _request_for(request_file, target, request)
        index_payload = json.loads(jump_index.read_text())
        platform_entries = index_payload.get("platforms", [])
        target_entries = [entry for entry in platform_entries if entry.get("version") == target]
        if not target_entries or not isinstance(target_entries[0].get("releaseNotes"), str):
            raise RuntimeError("multi-release sealed index omitted target platform release notes")
        plan = _payload(cli([launcher, "plan", "--json", "--index", str(jump_index),
                             "--input", str(request)]), "plan N+2 release notes")
        notes = plan.get("updateSummary", {}).get("releaseNotes")
        expected_versions = [_target(index) for index in (update_index, jump_index)]
        if not isinstance(notes, list) or [item.get("version") for item in notes] != expected_versions or any(
                not isinstance(item.get("notes"), str) or not item["notes"] for item in notes):
            raise RuntimeError("N+2 plan did not list every intervening release note from the sealed index")

    claim_step("plan N+2 and show its sealed release notes", "platform.update",
                 plan_multi_release_notes, cases=["S-023.2", "S-214.10"],
                 requires=("step:candidate provenance", "step:launcher version",
                           "flow:start platform host", "step:start host",
                           "state:project-registered"))

    def refuse_bad_checksum() -> None:
        target = _target(bad_checksum_index)
        _request_for(request_file, target, request)
        before_receipt = hashlib.sha256(receipt_path.read_bytes()).hexdigest()
        before_config = hashlib.sha256((platform_root / layout_relative('currentLink', layout_value('sharedRuntimePaths.kb_kb_config_jsonc.platformPath'))).read_bytes()).hexdigest()
        shared_before = capture_shared_update_state()
        result = cli([launcher, "update", "--platform-root", root, "--json", "--index",
                      str(bad_checksum_index), "--input", str(request)])
        if result.returncode != 1:
            raise RuntimeError(f"bad-checksum update exited {result.returncode}; expected operation-failure status 1")
        error = _error(result, "bad-checksum update")
        expected_code = "KB_INSTALL_APPLY_FAILED"
        if (error.get("code") != expected_code
                or error.get("message") != catalogued_error_message(expected_code)
                or error.get("hint") != catalogued_error_hint(expected_code)):
            raise RuntimeError("bad-checksum update did not return the exact catalogued apply failure")
        if hashlib.sha256(receipt_path.read_bytes()).hexdigest() != before_receipt:
            raise RuntimeError("checksum failure changed the active receipt")
        if hashlib.sha256((platform_root / layout_relative('currentLink', layout_value('sharedRuntimePaths.kb_kb_config_jsonc.platformPath'))).read_bytes()).hexdigest() != before_config:
            raise RuntimeError("checksum failure changed generated config")
        assert_shared_update_state_unchanged("checksum failure", shared_before)
        status = _payload(cli([launcher, "status", "--platform-root", root, "--json"]), "status after checksum failure")
        if status.get("runningVersion") != baseline_version or status.get("installedVersion") != baseline_version:
            raise RuntimeError("checksum failure did not leave the old host and receipt on N")

    claim_step("reject corrupted sealed binary without changing N", "platform.update", refuse_bad_checksum,
                 cases=["S-023.12"],
                 requires=("step:candidate provenance", "step:launcher version",
                           "flow:start platform host", "step:start host",
                           "state:project-registered"))

    def reject_staged_config_and_doctor_failures() -> None:
        for label, index in (("config", config_failure_index), ("doctor", doctor_failure_index)):
            target = _target(index)
            _request_for(request_file, target, request)
            receipt_hash = hashlib.sha256(receipt_path.read_bytes()).hexdigest()
            config_path = platform_root / layout_relative('currentLink', layout_value('sharedRuntimePaths.kb_kb_config_jsonc.platformPath'))
            config_hash = hashlib.sha256(config_path.read_bytes()).hexdigest()
            shared_before = capture_shared_update_state()
            result = cli([launcher, "update", "--platform-root", root, "--index", str(index),
                          "--input", str(request), "--json"])
            if result.returncode != 1:
                raise RuntimeError(f"staged {label} verification exited {result.returncode}; expected operation-failure status 1")
            error = _error(result, f"staged {label} verification")
            if not error.get("code") or not error.get("hint"):
                raise RuntimeError(f"staged {label} verification failure omitted its typed error and hint")
            if label == "config" and error["code"] != "KB_INSTALL_CONFIG_REQUIRED":
                raise RuntimeError("update without the newly required configuration did not return KB_INSTALL_CONFIG_REQUIRED")
            if hashlib.sha256(receipt_path.read_bytes()).hexdigest() != receipt_hash:
                raise RuntimeError(f"staged {label} failure changed the active receipt")
            if hashlib.sha256(config_path.read_bytes()).hexdigest() != config_hash:
                raise RuntimeError(f"staged {label} failure changed generated config")
            assert_shared_update_state_unchanged(f"staged {label} failure", shared_before)
            status = _payload(cli([launcher, "status", "--platform-root", root, "--json"]),
                              f"status after staged {label} failure")
            if status.get("runningVersion") != baseline_version or status.get("installedVersion") != baseline_version:
                raise RuntimeError(f"staged {label} failure changed the installed or running version")

    claim_step("reject staged config and doctor failures without changing N", "platform.update",
                 reject_staged_config_and_doctor_failures, cases=["S-023.12"],
                 requires=("step:candidate provenance", "step:launcher version",
                           "flow:start platform host", "step:start host",
                           "state:project-registered"))

    def missing_cli_version_owner_fails() -> None:
        unavailable = receipt_path.with_name(receipt_path.name + '.unavailable')
        receipt_path.rename(unavailable)
        try:
            offline_command = cli(kb_command(["commit", "plan", "delete", "--json"], executable=kb_binary))
            _payload(offline_command, "non-version CLI command without platform receipt")
            for args in ([kb_binary, "--version", "--json"], [kb_binary, "version", "--json"]):
                result = cli(list(args))
                error = _error(result, "CLI version without installed receipt")
                code = "KB_CLI_PLATFORM_VERSION_UNAVAILABLE"
                if (result.returncode != 1 or error.get("code") != code
                        or error.get("message") != catalogued_error_message(code)
                        or error.get("hint") != catalogued_error_hint(code)):
                    raise RuntimeError("CLI version surfaces did not return the catalogued missing-owner failure")
        finally:
            unavailable.rename(receipt_path)

    claim_step("refuse CLI version when the platform receipt is missing", "platform.update",
               missing_cli_version_owner_fails, cases=["S-023.9"],
               requires=("step:candidate provenance", "step:launcher version",
                         "flow:start platform host", "step:start host"))

    def kill_during_staging() -> None:
        target = _target(next_index)
        _request_for(request_file, target, request)
        process = start_background_command([launcher, "update", "--platform-root", root, "--index",
                                             str(next_index), "--input", str(request), "--json"],
                                            cwd=project_a)
        if not process.wait_for_output("stage", timeout=120):
            process.terminate()
            process.wait(timeout=15)
            raise RuntimeError("update emitted no staged phase for deterministic interruption")
        if process.process.poll() is None:
            process.process.kill()
        process.wait(timeout=15)
        if process.process.returncode != -9:
            raise RuntimeError("update completed before the journey observed the staged phase; no staged kill was proved")
        status_result = cli([launcher, "status", "--platform-root", root, "--json"])
        doctor_result = cli([launcher, "doctor", "--platform-root", root, "--json"])
        status = _payload(status_result, "status after killed update")
        doctor = _payload(doctor_result, "doctor after killed update")
        if status.get("status") == "healthy" and status.get("installedVersion") == target:
            raise RuntimeError("half-installed target reports healthy after process termination")
        if not doctor.get("operationRecovery") and not doctor.get("pendingOperation"):
            raise RuntimeError("doctor did not diagnose or recover the interrupted staged operation")

    claim_step("kill update during staged verification and recover on next command", "platform.update",
                 kill_during_staging, cases=["S-023.13"],
                 requires=("step:candidate provenance", "step:launcher version",
                           "flow:start platform host", "step:start host",
                           "state:project-registered"))


    def start_long_workflow() -> None:
        nonlocal workflow_id
        workflow_file.parent.mkdir(parents=True, exist_ok=True)
        workflow_file.write_text(
            "name: update-variant\nversion: 1.0.0\non:\n  manual: true\njobs:\n  wait:\n    runsOn: local\n    steps:\n"
            f"      - name: Wait for update restart\n        id: wait\n        uses: builtin:shell\n        with:\n          command: 'while [ ! -f {workflow_marker} ]; do echo update-work-in-flight; sleep 1; done'\n",
            encoding="utf-8")
        _payload(cli(kb_command([ "workflow", "lint", "--json"], executable=kb_binary)), "lint long workflow fixture")
        started = _payload(cli(kb_command([ "workflow", "run", "--workflow-id=update-variant", "--json"], executable=kb_binary)),
                           "start long workflow through workflow API")
        workflow_id = str(started.get("runId") or started.get("id") or "")
        if not workflow_id:
            raise RuntimeError("workflow API omitted the active run id")

    def update_while_work_is_active() -> None:
        nonlocal workflow_job_id
        start_long_workflow()
        target = _target(next_index)
        _request_for(request_file, target, request)
        result = cli([launcher, "update", "--platform-root", root, "--json", "--index",
                      str(next_index), "--input", str(request)])
        payload = _payload(result, "update with active workflow")
        if payload.get("hostRestarted") is not False:
            raise RuntimeError("update interrupted or restarted active workflow service")
        pending = payload.get("pendingRestart")
        if (not isinstance(pending, dict) or pending.get("installedVersion") != target
                or not pending.get("services") or not pending.get("command")):
            raise RuntimeError("update omitted the pending restart contract while workflow work was active")
        detail = _payload(cli(kb_command([ "workflow", "runs", "view", workflow_id, "--json"], executable=kb_binary)),
                          "active workflow after update")
        if detail.get("status") not in {"queued", "running"}:
            raise RuntimeError("update interrupted the active workflow run")
        jobs = detail.get("jobs")
        if not isinstance(jobs, list) or not jobs:
            raise RuntimeError("active workflow response omitted its running job records")
        active_jobs = [job for job in jobs if job.get("status") in {"queued", "running"}]
        if not active_jobs or not active_jobs[0].get("id"):
            raise RuntimeError("workflow API did not identify an active job")
        workflow_job_id = str(active_jobs[0]["id"])

    claim_step("update without interrupting active workflow work", "platform.update",
                 update_while_work_is_active, cases=["S-023.14"],
                 requires=("step:candidate provenance", "step:launcher version",
                           "flow:start platform host", "step:start host",
                           "state:project-registered"))

    def refuse_restart_with_work() -> None:
        result = cli([launcher, "restart", "--platform-root", root, "--json"])
        error = _error(result, "restart with active workflow")
        details = error.get("details")
        if error.get("code") != "KB_RESTART_WORK_IN_FLIGHT" or not isinstance(details, dict):
            raise RuntimeError("restart did not refuse active work with KB_RESTART_WORK_IN_FLIGHT details")
        items = details.get("items")
        if not isinstance(items, list) or not any(
                item.get("kind") == "workflow" and item.get("id") == workflow_id
                and item.get("owningService") == "workflow" for item in items) or not any(
                item.get("kind") == "job" and item.get("id") == workflow_job_id
                and item.get("owningService") == "workflow" for item in items):
            raise RuntimeError("restart refusal omitted active workflow/job kind, id, or owning service")
        if "--interrupt" not in str(error.get("hint")) or "wait" not in str(error.get("hint")).lower():
            raise RuntimeError("restart refusal hint did not offer waiting or --interrupt")
        interactive = run_interactive([launcher, "restart", "--platform-root", root], project_a)
        transcript = interactive.stdout.lower()
        if not any(word in transcript for word in ("wait", "proceed", "interrupt")):
            raise RuntimeError("interactive restart did not ask whether to wait or proceed")
        still_pending = _payload(cli([launcher, "status", "--platform-root", root, "--json"]),
                                 "status after declining interactive restart")
        if still_pending.get("pendingRestart") is None:
            raise RuntimeError("declining the interactive restart unexpectedly cleared pendingRestart")
        result = _payload(cli([launcher, "restart", "--platform-root", root, "--interrupt", "--json"]),
                          "restart with explicit interruption")
        status = _payload(cli([launcher, "status", "--platform-root", root, "--json"]),
                          "status after interrupt restart")
        if result.get("operation") != "restart" or status.get("pendingRestart") is not None:
            raise RuntimeError("--interrupt did not restart the installed version and clear pendingRestart")
        workflow_marker.write_text("proceed\n")

    claim_step("refuse restart with workflow work and identify its owner", "platform.restart",
                 refuse_restart_with_work, cases=["S-023.8", "S-194.7"],
                 requires=("step:candidate provenance", "step:launcher version",
                           "flow:start platform host", "step:start host",
                           "state:project-registered"))


    def update_stopped_to_jump() -> None:
        _payload(cli([launcher, "stop", "--platform-root", root, "--json"]), "stop before jump update")
        for label, index in (("patch", patch_index), ("minor", minor_index), ("N+2", jump_index)):
            target = _target(index)
            _request_for(request_file, target, request)
            result = _payload(cli([launcher, "update", "--platform-root", root, "--json", "--index",
                                   str(index), "--input", str(request)]), f"stopped-host {label} update")
            if result.get("pendingRestart") is not None:
                raise RuntimeError(f"stopped-host {label} update unexpectedly reported a pending restart")
            status = _payload(cli([launcher, "status", "--platform-root", root, "--json"]),
                              f"status after stopped-host {label} update")
            if status.get("running") is True or status.get("installedVersion") != target:
                raise RuntimeError(f"stopped-host {label} update started services or did not install its target")
            _payload(cli([launcher, "start", "--platform-root", root, "--json"]), f"start after {label} update")
            status = _payload(cli([launcher, "status", "--platform-root", root, "--json"]), f"status after {label} start")
            if status.get("runningVersion") != target or status.get("installedVersion") != target:
                raise RuntimeError(f"start did not bring up unified {label} target")
            cli_version = ""
            for executable in (kb_binary, str(platform_root / layout_relative('currentLink', '.kb/v2/bin/kb-create'))):
                version = cli(kb_command([ "--version"], executable=executable))
                if version.returncode or target not in version.stdout:
                    raise RuntimeError(f"{executable} --version did not report unified target {target}")
                if executable == kb_binary:
                    cli_version = version.stdout.strip().splitlines()[0].removeprefix("KB Labs CLI v")
            for args in (["--version", "--json"], ["--json", "--version"]):
                version_json = cli(kb_command(args, executable=kb_binary))
                if version_json.returncode:
                    raise RuntimeError(f"kb {' '.join(args)} failed after update")
                if _payload(version_json, f"kb {' '.join(args)}").get("version") != target:
                    raise RuntimeError(f"kb {' '.join(args)} did not report unified target {target}")
            version_command = cli(kb_command(["version", "--json"], executable=kb_binary))
            if version_command.returncode:
                raise RuntimeError("kb version --json failed after update")
            if _payload(version_command, "kb version --json after update").get("version") != target:
                raise RuntimeError("kb version --json did not report unified target")
            service_port_map = service_ports(json.loads(receipt_path.read_text()))
            if "rest" not in service_port_map:
                raise RuntimeError("active receipt omitted the REST service port")
            with urlopen(f"http://127.0.0.1:{service_port_map['rest']}/api/v1/health", timeout=20) as response:
                health = json.loads(response.read())
            health_version = health.get("version", {}).get("kbLabs")
            if health_version != cli_version or health_version != status.get("installedVersion"):
                raise RuntimeError("REST health, kb --version, and kb-create status disagree on the installed platform version")
            _payload(cli([launcher, "stop", "--platform-root", root, "--json"]), f"stop after {label} update")
        _payload(cli([launcher, "start", "--platform-root", root, "--json"]), "start N+2 host for follow-up checks")

    claim_step("update stopped host through patch, minor, and N+2 releases", "platform.update",
                 update_stopped_to_jump, cases=["S-023.9"],
                 requires=("step:candidate provenance", "step:launcher version",
                           "flow:start platform host", "step:start host",
                           "state:project-registered"))

    def verify_preservation_matrix() -> None:
        after_files = _file_fingerprints(platform_root, (project_a, project_b))
        changed = [path for path, digest in before_files.items() if after_files.get(path) != digest]
        if changed:
            raise RuntimeError(f"update changed preserved config, secret, plugin, project, or SQLite files: {changed}")
        after_rows = _database_rows(platform_root.parent)
        if not _retains_rows(before_rows, after_rows):
            raise RuntimeError("update lost one or more persisted SQLite table rows")
        updated_receipt = json.loads(receipt_path.read_text())
        services = updated_receipt.get("plan", {}).get("serviceGraph", {}).get("services")
        after_services = ({service["id"]: service["required"] for service in services}
                          if isinstance(services, list) and all(
                              isinstance(service, dict) and service.get("id") and "required" in service
                              for service in services) else {})
        if after_services != before_services:
            raise RuntimeError("selected service identities or required states changed after update")
        projects = _payload(cli(kb_command([ "project", "list", "--json"], executable=kb_binary)), "projects after update").get("projects", [])
        if len(projects) < 2:
            raise RuntimeError("one or more registered projects disappeared after update")
        for project in (project_a, project_b):
            result = cli(kb_command(["commit", "plan", "show", "--help"], executable=kb_binary), project)
            if result.returncode:
                raise RuntimeError(f"compatible project plugin command disappeared after update: {result.stdout}")
            settings = _payload(cli(kb_command([ "config", "get", "plugins.commit.scope.scopes", "--json"], executable=kb_binary), project),
                                f"read project plugin settings in {project}")
            if settings.get("value") != before_project_settings[str(project)]:
                raise RuntimeError(f"project plugin settings changed after update in {project}")

    claim_step("verify project plugins, adapters, services, config, secrets, and persisted rows", "platform.update",
                 verify_preservation_matrix, cases=["S-023.10"],
                 requires=("step:candidate provenance", "step:launcher version",
                           "flow:start platform host", "step:start host",
                           "step:prepare update preservation baseline",
                           "state:project-registered"))

    def verify_clients() -> None:
        try:
            verify_clients_after_update()
        except Exception as error:
            host_log = platform_root / layout_value('hostStateDirectory') / 'host.log'
            tail = host_log.read_text(errors='replace')[-16000:] if host_log.is_file() else 'host.log unavailable'
            raise RuntimeError(f"{error}; host log tail: {redact_text(tail)}") from error

    def verify_clients_after_update() -> None:
        with urlopen("http://127.0.0.1:3000/", timeout=20) as response:
            html = response.read().decode("utf-8", errors="replace")
            status_code = response.status
        if status_code != 200 or "<script" not in html or "<link" not in html:
            raise RuntimeError("Studio did not serve its active version HTML and asset references")
        for reference in __import__("re").findall(r'(?:src|href)="([^"]+\.(?:js|css))"', html):
            asset_url = reference if reference.startswith("http") else f"http://127.0.0.1:3000/{reference.lstrip('/')}"
            with urlopen(asset_url, timeout=20) as asset:
                if asset.status != 200 or not asset.read(256):
                    raise RuntimeError(f"Studio referenced a missing or empty asset: {asset_url}")
        project_id = json.loads(cli(kb_command([ "project", "show", "--json"], executable=kb_binary), project_a).stdout).get("data", {}).get("project", {}).get("id")
        if not project_id:
            raise RuntimeError("project show did not identify project MCP endpoint")
        request = Request(f"http://127.0.0.1:4000{project_service_path(project_id, 'mcp')}",
                          data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                           "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                                                      "clientInfo": {"name": "update-journey", "version": "1"}}}).encode(),
                          headers={"Content-Type": "application/json"})
        if mcp_token:
            request.add_header("Authorization", f"Bearer {mcp_token}")
        with urlopen(request, timeout=20) as response:
            initialized = json.loads(response.read())
        if "result" not in initialized:
            raise RuntimeError("project MCP initialize failed after update")
        list_request = Request(f"http://127.0.0.1:4000{project_service_path(project_id, 'mcp')}",
                               data=json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list",
                                                "params": {}}).encode(),
                               headers={"Content-Type": "application/json"})
        if mcp_token:
            list_request.add_header("Authorization", f"Bearer {mcp_token}")
        with urlopen(list_request, timeout=20) as response:
            listed = json.loads(response.read())
        tools = listed.get("result", {}).get("tools", [])
        if not tools:
            raise RuntimeError("project MCP did not list any tools after update")
        safe_call = next(((tool, key) for tool in tools
                          for key, schema in tool.get("inputSchema", {}).get("properties", {}).items()
                          if isinstance(schema, dict) and schema.get("type") == "boolean"
                          and "plan only" in str(schema.get("description", "")).lower()), None)
        if safe_call is None:
            raise RuntimeError("project MCP exposed no tool with a declared no-mutation plan option")
        tool, dry_run_flag = safe_call
        call_request = Request(f"http://127.0.0.1:4000{project_service_path(project_id, 'mcp')}",
                               data=json.dumps({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                                                "params": {"name": tool["name"],
                                                           "arguments": {dry_run_flag: True}}}).encode(),
                               headers={"Content-Type": "application/json"})
        if mcp_token:
            call_request.add_header("Authorization", f"Bearer {mcp_token}")
        with urlopen(call_request, timeout=90) as response:
            called = json.loads(response.read())
        if called.get("error") or called.get("result", {}).get("isError") is True:
            raise RuntimeError(f"project MCP dry-run tool failed: {called.get('error') or called['result']}")

    claim_step("verify fresh Studio assets and project MCP after update", "platform.update",
                 verify_clients, cases=["S-023.11"],
                 requires=("step:candidate provenance", "step:launcher version",
                           "flow:start platform host", "step:start host",
                           "state:project-registered"))

    def recover_failed_host() -> None:
        v1 = _target(jump_index)
        v2 = _target(minor_index)
        target = _target(failed_host_index)
        _request_for(request_file, v2, request)
        second = _payload(cli([launcher, "update", "--platform-root", root, "--json", "--index",
                              str(minor_index), "--input", str(request)]), "install pending v2")
        first_snapshot = second.get("snapshot", {}).get("id")
        if not first_snapshot:
            raise RuntimeError("first update omitted its rollback snapshot ID")
        if second.get("pendingRestart", {}).get("installedVersion") != v2:
            raise RuntimeError("second update did not leave v1 running with v2 pending")
        status = _payload(cli([launcher, "status", "--platform-root", root, "--json"]), "status after v2")
        if status.get("runningVersion") != v1 or status.get("installedVersion") != v2:
            raise RuntimeError("v2 update changed the running v1 host")
        _request_for(request_file, target, request)
        updated = _payload(cli([launcher, "update", "--platform-root", root, "--json", "--index",
                                str(failed_host_index), "--input", str(request)]), "install failed-host candidate")
        if not isinstance(updated.get("pendingRestart"), dict):
            raise RuntimeError("failed-host update omitted the pending restart before health verification")
        before_restart = _payload(cli([launcher, "doctor", "--platform-root", root, "--json"]),
                                  "doctor after v3 update")
        retained = before_restart.get("retention", {}).get(layout_value('versionRoots.path'), [])
        retained_versions = {item.get("version") for item in retained if isinstance(item, dict)}
        if retained_versions != {v1, target}:
            raise RuntimeError(f"repeated update did not retain running v1 and active v3 while pruning v2: {retained}")
        error = _error(cli([launcher, "restart", "--platform-root", root, "--json"]),
                       "restart failed-host candidate")
        if error.get("code") != "KB_UPDATE_HOST_NOT_HEALTHY":
            raise RuntimeError(f"failed-host restart returned {error.get('code')!r}, expected KB_UPDATE_HOST_NOT_HEALTHY")
        details = error.get("details")
        if not isinstance(details, dict) or not details.get("snapshotId") or not details.get("logPath"):
            raise RuntimeError("health failure omitted its recovery snapshot or operation log")
        status = _payload(cli([launcher, "status", "--platform-root", root, "--json"]), "status after auto rollback")
        doctor = _payload(cli([launcher, "doctor", "--platform-root", root, "--json"]), "doctor after auto rollback")
        if status.get("runningVersion") != v1 or doctor.get("platform", {}).get("ok") is not True:
            raise RuntimeError("automatic recovery did not restore the last-healthy v1 root")
        healthy_target = _target(healthy_host_index)
        _request_for(request_file, healthy_target, request)
        healthy = _payload(cli([launcher, "update", "--platform-root", root, "--json", "--index",
                                str(healthy_host_index), "--input", str(request)]), "install healthy next release")
        if healthy.get("pendingRestart", {}).get("installedVersion") != healthy_target:
            raise RuntimeError("healthy next release update omitted pending restart")
        _payload(cli([launcher, "restart", "--platform-root", root, "--json"]), "restart healthy next release")
        status = _payload(cli([launcher, "status", "--platform-root", root, "--json"]),
                          "status after healthy next release")
        if status.get("runningVersion") != healthy_target or status.get("installedVersion") != healthy_target:
            raise RuntimeError("healthy next release did not become the running version")
        after_healthy = _payload(cli([launcher, "doctor", "--platform-root", root, "--json"]),
                                  "doctor after healthy next release restart")
        healthy_versions = after_healthy.get("retention", {}).get(layout_value('versionRoots.path'), [])
        if {item.get("version") for item in healthy_versions if isinstance(item, dict)} != {v2}:
            raise RuntimeError("successful newer health check did not prune last-healthy v1")
        rolled_back = _payload(cli([launcher, "rollback", "--platform-root", root, "--snapshot", first_snapshot,
                                    "--yes", "--json"]), "rollback snapshot after its source root was pruned")
        if rolled_back.get("hostRestarted") is not True:
            raise RuntimeError("rollback from the installer-owned snapshot did not restart the restored host")
        restored = _payload(cli([launcher, "status", "--platform-root", root, "--json"]),
                            "status after rollback from a pruned root snapshot")
        if restored.get("runningVersion") != v1 or restored.get("installedVersion") != v1:
            raise RuntimeError("rollback did not restore the snapshot version after its version root was pruned")
        if not _retains_rows(before_rows, _database_rows(platform_root.parent)):
            raise RuntimeError("automatic recovery lost persisted platform data")

    claim_step("retain last healthy root through repeated updates and restart recovery", "platform.rollback",
                 recover_failed_host, cases=["S-023.15", "S-024.6", "S-024.7"],
                 requires=("step:candidate provenance", "step:launcher version",
                           "flow:start platform host", "step:start host",
                           "step:prepare update preservation baseline",
                           "state:project-registered"))

    def verify_retention_and_disk_use() -> None:
        result = cli([launcher, "doctor", "--platform-root", root, "--json"])
        payload = _payload(result, "doctor retention report")
        retention = payload.get("retention")
        if not isinstance(retention, dict):
            raise RuntimeError("doctor omitted retained version and snapshot disk-use report")
        snapshots = retention.get("snapshots")
        versions = retention.get(layout_value('versionRoots.path'))
        if not isinstance(snapshots, list) or len(snapshots) > 2 or not isinstance(versions, list) or len(versions) != 1:
            raise RuntimeError("doctor retention report does not prune the former last-healthy root after successful restart")
        if any(not isinstance(item, dict) or not isinstance(item.get("diskUsageBytes"), int) for item in snapshots + versions):
            raise RuntimeError("doctor retention report omitted diskUsageBytes for a retained item")

    claim_step("verify version and recovery snapshot retention with disk use", "platform.doctor",
                 verify_retention_and_disk_use, cases=["S-023.15"],
                 requires=("step:candidate provenance", "step:launcher version",
                           "flow:start platform host", "step:start host",
                           "state:project-registered"))
    return journey
