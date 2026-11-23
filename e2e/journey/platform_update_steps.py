"""Installed-platform update and rollback journey steps."""
from __future__ import annotations

from kb_invocation import kb_command
from installed_fixture import layout_relative, layout_value

import hashlib
import json
import os
import secrets as secure_random
from pathlib import Path
from typing import Callable

from service_steps import Journey
from bootstrap_secret_steps import password_absence_failure
from journey_resources import (active_platform_root, current_link_path,
                               parse_shell_commands, shared_runtime_file_fingerprints,
                               snapshot_state_tree)
from invocations import (
    CompletedProcess,
    decode_ux_error_result,
    decode_ux_success_result,
    read_kb_create_cli_result,
    read_ux_cli_result,
    run_command as invoke_command,
    run_with_runner,
)
from service_port_assertions import assert_service_ports_preserved


CommandRunner = Callable[[list[str]], CompletedProcess]


def _json_command(run_command: CommandRunner, args: list[str], label: str,
                  *, after_run: Callable[[], None] | None = None) -> dict:
    result = run_command(args)
    if after_run is not None:
        after_run()
    try:
        value = read_kb_create_cli_result(args[1], result)
        if result.returncode != 0:
            error = decode_ux_error_result(value)
            raise RuntimeError(f"{label}: {error!r}{_log_tail(args[1], result)}")
        payload = decode_ux_success_result(value)
    except ValueError as error:
        raise RuntimeError(f"{label}: expected a valid ADR-0049 result: {error}") from error
    if not isinstance(payload, dict):
        raise RuntimeError(f"{label}: result envelope did not contain an object payload")
    return payload


def _log_tail(command: str, result: CompletedProcess[str]) -> str:
    """The end of the operation log named by a failed launcher result, so the journey report shows the cause."""
    try:
        envelope = read_kb_create_cli_result(command, result)
        payload = decode_ux_error_result(envelope) if result.returncode else decode_ux_success_result(envelope)
        log_path = payload.get("logPath")
        text = Path(log_path).read_text(encoding="utf-8", errors="replace") if log_path else ""
    except (ValueError, AttributeError, OSError, TypeError):
        return ""
    return f"; operation log tail: {' '.join(text.split())[-1500:]}" if text else ""


def _hash(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except FileNotFoundError:
        return None


def _outside_install_snapshot(install_root: Path) -> dict[str, str]:
    snapshot: dict[str, str] = {}

    for path in install_root.parent.iterdir():
        if path == install_root:
            continue
        if path.is_symlink():
            snapshot[str(path)] = "symlink:" + str(path.readlink())
        elif path.is_file():
            snapshot[str(path)] = f"file:{path.stat().st_mode:o}:sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"
        elif path.is_dir():
            snapshot[str(path)] = f"directory:{path.stat().st_mode:o}"
            for child in sorted(path.rglob("*")):
                if child.is_symlink():
                    value = "symlink:" + str(child.readlink())
                elif child.is_file():
                    value = f"file:{child.stat().st_mode:o}:sha256:{hashlib.sha256(child.read_bytes()).hexdigest()}"
                elif child.is_dir():
                    value = f"directory:{child.stat().st_mode:o}"
                else:
                    continue
                snapshot[str(child)] = value
    return snapshot


def _outside_install_changes(before: dict[str, str], after: dict[str, str]) -> list[dict[str, str | None]]:
    return [{"path": path, "before": before.get(path), "after": after.get(path)}
            for path in sorted(before.keys() | after.keys()) if before.get(path) != after.get(path)]


def _assert_outside_install_unchanged(install_root: Path, before: dict[str, str], operation: str) -> None:
    changes = _outside_install_changes(before, _outside_install_snapshot(install_root))
    if changes:
        detail = "; ".join(
            f"{change['path']} (before={change['before'] or '<absent>'}; after={change['after'] or '<absent>'})"
            for change in changes
        )
        raise RuntimeError(f"{operation} changed paths outside the installation container: {detail}")


def _changed_paths(previous: object, current: object, prefix: str = "plan") -> list[str]:
    if isinstance(previous, dict) and isinstance(current, dict):
        return [path for key in sorted(set(previous) | set(current))
                for path in _changed_paths(previous.get(key), current.get(key), f"{prefix}.{key}")]
    if isinstance(previous, list) and isinstance(current, list):
        paths = [path for index, (left, right) in enumerate(zip(previous, current))
                 for path in _changed_paths(left, right, f"{prefix}[{index}]")]
        if len(previous) != len(current):
            paths.append(f"{prefix}.length")
        return paths
    return [] if previous == current else [prefix]


def run_platform_update_steps(
    *,
    mode: str,
    launcher: str,
    kb_binary: str,
    platform_root: Path,
    update_index: Path,
    request_file: Path,
    base_version: str,
    updated_version: str,
    run_command: CommandRunner = invoke_command,
    verify_user: Callable[[], CompletedProcess] | None = None,
    expire_user_session: Callable[[], None] | None = None,
    bootstrap_password: str | None = None,
    bootstrap_outside_roots: tuple[tuple[str, Path], ...] = (),
    parent_journey: Journey | None = None,
) -> Journey:
    command_runner = run_command
    def run_command(args: list[str]) -> CompletedProcess:
        result = run_with_runner(command_runner, args)
        return CompletedProcess(args, result.returncode,
                                            stdout=(result.stdout or "") + (result.stderr or ""),
                                            stderr=result.stderr)
    """Update the running installation, exercise a project command, and roll back."""
    journey = Journey(mode, f"platform-update-{mode}", parent=parent_journey)
    root = str(platform_root)
    receipt_path = platform_root / layout_relative('currentLink', '.kb/v2/receipt.json')
    config_paths = [platform_root / layout_relative('currentLink', layout_value('sharedRuntimePaths.kb_kb_config_jsonc.platformPath'))]
    snapshot_id = ""
    runtime_log_path = platform_root / layout_relative('currentLink', layout_relative('sharedRuntimePaths.kb_logs.platformPath', 'post-update-before-restart.log'))
    updated_plan_hash = ""
    updated_plan: dict = {}
    pending_restart_services: list[dict] = []
    pending_restart_object: dict = {}
    config_checkpoints: dict[str, str | None] = {}
    shared_file_fingerprints_before: tuple[str | None, ...] | None = None
    saved_user_session_established = False
    saved_session_succeeded_after_update = False
    installation_id = ""
    gateway_url = ""
    initial_plan: dict = {}
    running_tree_before: Path | None = None
    running_lock_before: bytes | None = None

    def checkpoint_details() -> dict[str, dict[str, str | None]]:
        return {"configSha256": dict(config_checkpoints)}

    def record_config_checkpoint(name: str) -> None:
        digest = _hash(config_paths[0])
        config_checkpoints[name] = digest

    def assert_shared_file_fingerprints(checkpoint: str) -> None:
        if shared_file_fingerprints_before is None:
            raise RuntimeError("shared-state file fingerprint is unavailable before update")
        config_state_path = layout_value('sharedRuntimePaths.kb_kb_config_jsonc.statePath')
        if shared_runtime_file_fingerprints(
            platform_root, exclude_state_paths=frozenset({config_state_path}),
        ) != shared_file_fingerprints_before:
            raise RuntimeError(f"shared-state file fingerprints changed at {checkpoint}")

    def assert_platform_storage_choice(stage: str) -> None:
        command = kb_command(
            ["config", "get", "--scope", "platform", "platform.adapterOptions.storage", "--json"],
            executable=kb_binary,
        )
        result = run_command(command)
        try:
            envelope = read_ux_cli_result(result)
            if result.returncode != 0:
                failure = decode_ux_error_result(envelope)
                raise RuntimeError(f"platform storage config could not be read {stage}: {failure!r}")
            payload = decode_ux_success_result(envelope)
        except ValueError as error:
            raise RuntimeError(f"platform config get returned an invalid UX result {stage}: {error}") from error
        if (not isinstance(payload, dict) or payload.get("scope") != "platform"
                or payload.get("found") is not True
                or payload.get("value") != {"baseDir": "case-storage"}
                or payload.get("layer") != "platform"):
            raise RuntimeError(f"platform storage user choice changed {stage}: {payload!r}")

    def save_known_good_state() -> None:
        nonlocal saved_user_session_established, installation_id, gateway_url, initial_plan
        nonlocal shared_file_fingerprints_before, running_tree_before, running_lock_before
        config_command = kb_command(
            ["config", "set", "--scope", "platform", "platform.adapterOptions.storage",
             '{"baseDir":"case-storage"}', "--json"],
            executable=kb_binary,
        )
        configured = run_command(config_command)
        try:
            config_envelope = read_ux_cli_result(configured)
            if configured.returncode != 0:
                failure = decode_ux_error_result(config_envelope)
                raise RuntimeError(f"platform config set failed before update: {failure!r}")
            config_result = decode_ux_success_result(config_envelope)
        except ValueError as error:
            raise RuntimeError(f"platform config set returned an invalid UX result: {error}") from error
        if not isinstance(config_result, dict):
            raise RuntimeError("platform config set did not confirm the user choice")
        reported_config = config_result.get("file")
        if not isinstance(reported_config, str) or Path(reported_config).resolve() != config_paths[0].resolve():
            raise RuntimeError("platform config set did not identify the installed platform config file")
        assert_platform_storage_choice("after config set")
        config_state_path = layout_value('sharedRuntimePaths.kb_kb_config_jsonc.statePath')
        shared_file_fingerprints_before = shared_runtime_file_fingerprints(
            platform_root, exclude_state_paths=frozenset({config_state_path}),
        )
        running_tree_before = active_platform_root(platform_root)
        running_lock_before = (running_tree_before / layout_value('versionStatePaths.kb_marketplace_lock')).read_bytes()
        receipt = json.loads(receipt_path.read_text())
        installation_id = str(receipt.get("installationId") or "")
        gateway_url = str(receipt.get("verification", {}).get("hostHealthUrl") or "")
        initial_plan = receipt.get("plan", {})
        if not installation_id:
            raise RuntimeError("active receipt has no stable installationId")
        if not gateway_url:
            raise RuntimeError("active receipt has no stable Gateway health URL")
        actual = receipt.get("plan", {}).get("serviceGraph", {}).get("platformVersion")
        if actual != base_version:
            raise RuntimeError(f"active receipt is {actual!r}, expected version {base_version}")
        status = _json_command(run_command, [launcher, "status", "--platform-root", root, "--json"], "initial status")
        if status.get("running") is not True or status.get("reachable") is not True:
            raise RuntimeError("initial kb-create status did not confirm a running, reachable host")
        before_update = _hash(config_paths[0])
        config_checkpoints["beforeUpdate"] = before_update
        if before_update is None:
            raise RuntimeError(f"generated platform config is missing: {config_paths[0]}")
        if verify_user is not None:
            login = verify_user()
            if login.returncode != 0:
                raise RuntimeError(f"initial admin login failed: {' '.join(login.stdout.split())[-400:]}")
            saved_user_session_established = True
            protected = run_command(kb_command([ "project", "list", "--json"], executable=kb_binary))
            try:
                protected_result = read_ux_cli_result(protected)
                if protected.returncode != 0:
                    failure = decode_ux_error_result(protected_result)
                    raise RuntimeError(f"saved session failed its pre-update project request: {failure!r}")
                payload = decode_ux_success_result(protected_result)
            except ValueError as error:
                raise RuntimeError(f"pre-update project request returned an invalid UX result: {error}") from error
            if not isinstance(payload, dict) or not isinstance(payload.get("projects"), list):
                raise RuntimeError("pre-update project request did not return a projects payload")
            if expire_user_session is not None:
                expire_user_session()

    journey.step("save installed receipt, config, and host status", "platform.update", save_known_good_state,
                 cases=["S-023.1"], details=checkpoint_details,
                 requires=("step:candidate provenance", "step:launcher version",
                           "flow:start platform host", "step:start host",
                           "state:project-registered"))

    def plan_new_release() -> None:
        index = json.loads(update_index.read_text())
        releases = [release for release in index.get("platforms", [])
                    if release.get("version") == updated_version]
        if not releases or not isinstance(releases[0].get("releaseNotes"), str):
            raise RuntimeError("sealed platform release omitted markdown releaseNotes")
        plan = _json_command(run_command, [launcher, "plan", "--json", "--index", str(update_index),
                                          "--input", str(request_file)], "plan update")
        graph = plan.get("plan", {}).get("serviceGraph", {})
        if graph.get("platformVersion") != updated_version:
            raise RuntimeError(f"update plan did not resolve platform {updated_version}: {graph.get('platformVersion')!r}")
        summary = plan.get("updateSummary")
        if not isinstance(summary, dict):
            raise RuntimeError("update plan omitted its comparison with the installed receipt")
        if not summary.get("components") or not isinstance(summary.get("downloadBytes"), int):
            raise RuntimeError("update plan omitted component versions or its download byte estimate")
        if not isinstance(summary.get("addedPackages"), list) or not isinstance(summary.get("removedPackages"), list):
            raise RuntimeError("update plan omitted added and removed package names")
        notes = summary.get("releaseNotes")
        if not isinstance(notes, list) or not notes or any(not item.get("notes") for item in notes):
            raise RuntimeError("update plan omitted notes for an intervening release")

    journey.step("plan the newer sealed release", "platform.update", plan_new_release,
                 cases=["S-023.2", "S-214.10"],
                 requires=("step:save installed receipt, config, and host status",))

    def update() -> None:
        nonlocal snapshot_id, updated_plan_hash, updated_plan, pending_restart_services, pending_restart_object
        outside_before_update = _outside_install_snapshot(platform_root)
        result = _json_command(run_command, [launcher, "update", "--platform-root", root, "--json", "--index", str(update_index),
                                            "--input", str(request_file)], "update platform",
                                    after_run=lambda: _assert_outside_install_unchanged(
                                        platform_root, outside_before_update, "update"))
        snapshot = result.get("snapshot")
        receipt = result.get("receipt")
        if not isinstance(snapshot, dict) or not snapshot.get("id"):
            raise RuntimeError("update did not return ok=true and a recovery snapshot ID")
        if not isinstance(receipt, dict) or receipt.get("plan", {}).get("serviceGraph", {}).get("platformVersion") != updated_version:
            raise RuntimeError(f"update receipt does not identify platform {updated_version}")
        summary = result.get("updateSummary")
        if not isinstance(summary, dict):
            raise RuntimeError("update result omitted its component and release-note summary")
        components = summary.get("components")
        if not isinstance(components, list) or not components:
            raise RuntimeError("update result omitted component versions")
        if any(not isinstance(item, dict) or not isinstance(item.get("fromVersion"), str)
               or not isinstance(item.get("toVersion"), str) for item in components):
            raise RuntimeError("update result component summary omitted from/to versions")
        release_notes = summary.get("releaseNotes")
        if not isinstance(release_notes, list) or not release_notes or any(
                not isinstance(item, dict) or not item.get("notes") for item in release_notes):
            raise RuntimeError("update result omitted notes for an intervening release")
        updated_plan_hash = str(receipt.get("plan", {}).get("planHash") or "")
        if not updated_plan_hash:
            raise RuntimeError("update receipt did not include its resolved plan hash")
        updated_plan = receipt["plan"]
        assert_service_ports_preserved(initial_plan, updated_plan, "same-port update")
        if result.get("hostRestarted") is not False:
            raise RuntimeError("update stopped or restarted a running host")
        pending = result.get("pendingRestart")
        if not isinstance(pending, dict) or not isinstance(pending.get("services"), list) or not pending["services"]:
            raise RuntimeError("update omitted pendingRestart.services")
        if set(pending) != {"services", "installedVersion", "command"}:
            raise RuntimeError("update pendingRestart does not match the exact contract shape")
        if any(not isinstance(item, dict) or set(item) != {"id", "runningVersion"}
               for item in pending["services"]):
            raise RuntimeError("update pendingRestart service entries do not match the exact contract shape")
        if pending.get("installedVersion") != updated_version or not pending.get("command"):
            raise RuntimeError("update pendingRestart omitted installedVersion or command")
        pending_restart_services = pending["services"]
        pending_restart_object = pending
        if any(not item.get("id") or item.get("runningVersion") != base_version for item in pending_restart_services):
            raise RuntimeError("update pendingRestart did not identify each old running service version")
        if not result.get("logPath"):
            raise RuntimeError("update result did not include its operation log path")
        assert_shared_file_fingerprints("successful update before restart")
        if running_tree_before is None or (running_tree_before / layout_value('versionStatePaths.kb_marketplace_lock')).read_bytes() != running_lock_before:
            raise RuntimeError("successful update changed the still-running version's marketplace lock")
        post_update_status = _json_command(run_command, [launcher, "status", "--platform-root", root, "--json"],
                                           "status after update before restart")
        if post_update_status.get("runningVersion") != base_version or post_update_status.get("installedVersion") != updated_version:
            raise RuntimeError("old host stopped serving after update activation")
        snapshot_id = str(snapshot["id"])
        runtime_log_path.parent.mkdir(parents=True, exist_ok=True)
        runtime_log_path.write_text("runtime history written after update and before restart\n", encoding="utf-8")
        record_config_checkpoint("afterUpdateBeforeRestart")
        outside_before_repeat = _outside_install_snapshot(platform_root)
        human = run_command([launcher, "update", "--platform-root", root, "--index", str(update_index), "--input", str(request_file)])
        _assert_outside_install_unchanged(platform_root, outside_before_repeat, "repeat update")
        if human.returncode != 0 or "already up to date" not in human.stdout.lower():
            raise RuntimeError("human repeated update did not show its already-current summary")

    journey.step("stage update and leave the running host on its current version", "platform.update", update,
                 cases=["S-023.3", "S-023.7", "S-024.1", "S-203.10"], details=checkpoint_details,
                 requires=("step:plan the newer sealed release",))


    def verify_updated_install() -> None:
        receipt = json.loads(receipt_path.read_text())
        if receipt.get("installationId") != installation_id:
            raise RuntimeError("installationId changed during update")
        if receipt.get("verification", {}).get("hostHealthUrl") != gateway_url:
            raise RuntimeError("Gateway address changed during update")
        assert_service_ports_preserved(initial_plan, receipt.get("plan", {}), "update")
        version = receipt.get("plan", {}).get("serviceGraph", {}).get("platformVersion")
        if version != updated_version:
            raise RuntimeError(f"active receipt is {version!r}, expected {updated_version}")
        status = _json_command(run_command, [launcher, "status", "--platform-root", root, "--json"], "updated status")
        if status.get("running") is not True or status.get("reachable") is not True:
            raise RuntimeError("kb-create status did not confirm the old host is still healthy")
        if status.get("runningVersion") != base_version or status.get("installedVersion") != updated_version:
            raise RuntimeError("kb-create status did not distinguish running and installed versions")
        pending = status.get("pendingRestart")
        if not isinstance(pending, dict) or pending.get("installedVersion") != updated_version:
            raise RuntimeError("kb-create status did not report the pending restart object")
        if pending != pending_restart_object:
            raise RuntimeError("kb-create status pendingRestart differs from the update result")
        for status_root in (platform_root, platform_root / layout_value('currentLink'), (platform_root / layout_value('currentLink')).resolve()):
            spelling_status = _json_command(
                run_command, [launcher, "status", "--platform-root", str(status_root), "--json"],
                f"updated status through {status_root}")
            if (spelling_status.get("running") is not True
                    or spelling_status.get("runningVersion") != base_version
                    or spelling_status.get("installedVersion") != updated_version
                    or spelling_status.get("pendingRestart") != pending_restart_object):
                raise RuntimeError(f"status through {status_root} lost the running old host or pending restart")
        doctor_status = _json_command(run_command, [launcher, "doctor", "--platform-root", root, "--json"],
                                      "doctor before restart")
        if doctor_status.get("pendingRestart") != pending_restart_object:
            raise RuntimeError("kb-create doctor pendingRestart differs from the update result")
        for command_name, label in (("status", "status"), ("doctor", "doctor")):
            human = run_command([launcher, command_name, "--platform-root", root])
            human_output = human.stdout or ""
            if human.returncode != 0 or pending_restart_object["command"] not in human_output:
                raise RuntimeError(f"human {label} output omitted the pending-restart command")
            for service in pending_restart_services:
                if service["id"] not in human_output:
                    raise RuntimeError(f"human {label} output omitted service {service['id']!r}")
        assert_platform_storage_choice("after update")
        _json_command(run_command, kb_command(["adapter", "list", "--json"], executable=kb_binary),
                      "adapter list after update")

    journey.step("verify installed version and pending restart while old host serves", "platform.update", verify_updated_install,
                 cases=["S-023.4", "PC-001.13"],
                 requires=("step:stage update and leave the running host on its current version",))

    def project_command() -> None:
        nonlocal saved_session_succeeded_after_update
        result = run_command(kb_command([ "project", "list", "--json"], executable=kb_binary))
        try:
            envelope = read_ux_cli_result(result)
            if result.returncode != 0:
                failure = decode_ux_error_result(envelope)
                raise RuntimeError(f"project list after update was rejected: {failure!r}")
            payload = decode_ux_success_result(envelope)
        except ValueError as error:
            raise RuntimeError(f"project list after update returned an invalid UX result: {error}") from error
        if not isinstance(payload, dict) or not isinstance(payload.get("projects"), list):
            raise RuntimeError("project list after update did not return a projects payload")
        saved_session_succeeded_after_update = True

    journey.step("run the core project list command after update", "platform.update", project_command,
                 cases=["S-023.4", "S-023.5"])

    if verify_user is not None:
        def login_after_update() -> None:
            login = verify_user()
            if login.returncode != 0:
                raise RuntimeError(f"existing admin login failed after update: {' '.join(login.stdout.split())[-400:]}")

        journey.step("existing admin can log in after update", "platform.update", login_after_update,
                     cases=["S-023.4"])

    def repeat_update() -> None:
        receipt_before = receipt_path.read_bytes()
        preview = _json_command(run_command, [launcher, "plan", "--json", "--index", str(update_index),
                                              "--input", str(request_file)], "repeat update plan")
        preview_plan = preview.get("plan", {})
        preview_hash = str(preview_plan.get("planHash") or "")
        if preview_hash != updated_plan_hash:
            changed_fields = _changed_paths(updated_plan, preview_plan)
            raise RuntimeError(
                f"repeat update plan drift before mutation: first={updated_plan_hash!r}, "
                f"preview={preview_hash!r}, changed fields={changed_fields}"
            )
        outside_before_repeat = _outside_install_snapshot(platform_root)
        result = _json_command(run_command, [launcher, "update", "--platform-root", root, "--json", "--index", str(update_index),
                                            "--input", str(request_file)], "repeat update",
                                    after_run=lambda: _assert_outside_install_unchanged(
                                        platform_root, outside_before_repeat, "equal-version update"))
        receipt = result.get("receipt")
        snapshot = result.get("snapshot")
        if not isinstance(receipt, dict):
            raise RuntimeError("repeat update did not return its current receipt")
        plan = receipt.get("plan", {})
        if plan.get("serviceGraph", {}).get("platformVersion") != updated_version:
            raise RuntimeError("repeat update changed the resolved platform version")
        repeated_plan_hash = str(plan.get("planHash") or "")
        if repeated_plan_hash != updated_plan_hash:
            changed_fields = _changed_paths(updated_plan, plan)
            raise RuntimeError(
                f"repeat update changed the resolved plan hash: first={updated_plan_hash!r}, "
                f"repeat={repeated_plan_hash!r}, changed fields={changed_fields}"
            )
        if result.get("alreadyUpToDate") is not True:
            raise RuntimeError("repeat update did not report that the platform is already up to date")
        if result.get("hostRestarted") is not False:
            raise RuntimeError("already-current update restarted services")
        receipt_after = receipt_path.read_bytes()
        if receipt_after != receipt_before:
            raise RuntimeError("already-current update changed the installed receipt bytes")

    journey.step("repeat the update without version drift", "platform.update", repeat_update,
                 cases=["S-023.6"])

    def restart_updated_host() -> None:
        outside_before_restart = _outside_install_snapshot(platform_root)
        result = _json_command(run_command, [launcher, "restart", "--platform-root", root, "--json"],
                               "restart after update", after_run=lambda: _assert_outside_install_unchanged(
                                   platform_root, outside_before_restart, "restart"))
        if result.get("operation") != "restart" or result.get("runningVersion") != updated_version:
            raise RuntimeError("explicit restart did not bring up the installed version")
        status = _json_command(run_command, [launcher, "status", "--platform-root", root, "--json"],
                               "status after update restart")
        if status.get("runningVersion") != updated_version or status.get("pendingRestart") is not None:
            raise RuntimeError("status did not clear the pending restart after restart")
        if runtime_log_path.read_text(encoding="utf-8") != "runtime history written after update and before restart\n":
            raise RuntimeError("runtime log history written before restart was lost")
        assert_shared_file_fingerprints("updated host restart")
        record_config_checkpoint("afterUpdateRestart")

    journey.step("explicitly restart services onto the installed version", "platform.restart",
                 restart_updated_host, cases=["S-023.8", "S-023.10"],
                 requires=("step:verify installed version and pending restart while old host serves",))

    def rollback() -> None:
        if not snapshot_id:
            raise RuntimeError("update did not produce a snapshot ID for rollback")
        outside_before_rollback = _outside_install_snapshot(platform_root)
        human = run_command([launcher, "rollback", "--platform-root", root,
                             "--snapshot", snapshot_id, "--yes"])
        _assert_outside_install_unchanged(platform_root, outside_before_rollback, "rollback")
        if human.returncode != 0 or "Platform rollback completed." not in human.stdout:
            raise RuntimeError("human rollback did not show its completion summary")
        outside_before_json_rollback = _outside_install_snapshot(platform_root)
        result = _json_command(run_command, [launcher, "rollback", "--platform-root", root,
                                            "--snapshot", snapshot_id, "--yes", "--json"], "rollback platform",
                               after_run=lambda: _assert_outside_install_unchanged(
                                   platform_root, outside_before_json_rollback, "JSON rollback"))
        snapshot = result.get("snapshot")
        if not isinstance(snapshot, dict) or not snapshot.get("id"):
            raise RuntimeError("rollback did not return ok=true and the restored snapshot")
        if result.get("hostRestarted") is not True or not result.get("logPath"):
            raise RuntimeError("rollback did not report host restart and an operation log")
        assert_shared_file_fingerprints("successful rollback")
        record_config_checkpoint("afterRollbackHostRestart")

    journey.step("roll back to version N with explicit non-TTY confirmation", "platform.rollback", rollback,
                 cases=["S-024.2", "S-203.10"], details=checkpoint_details,
                 requires=("step:explicitly restart services onto the installed version",))

    def reject_unknown_snapshot() -> None:
        before = receipt_path.read_bytes()
        result = run_command([launcher, "rollback", "--platform-root", root, "--snapshot",
                              "missing-journey-snapshot", "--yes", "--json"])
        if result.returncode == 0:
            raise RuntimeError("rollback unexpectedly accepted an unknown snapshot")
        try:
            envelope = read_kb_create_cli_result("rollback", result)
            error = decode_ux_error_result(envelope)
        except ValueError as error:
            raise RuntimeError(f"unknown-snapshot rollback returned an invalid ADR-0049 result: {error}") from error
        if not isinstance(error, dict) or not error.get("code") or not error.get("hint") or not error.get("correlationId"):
            raise RuntimeError("unknown-snapshot rollback omitted its structured recovery error or hint")
        if receipt_path.read_bytes() != before:
            raise RuntimeError("unknown-snapshot rollback changed the active receipt")
        assert_shared_file_fingerprints("rejected missing-snapshot rollback")
        record_config_checkpoint("afterMissingSnapshotRecovery")

    journey.step("reject a missing snapshot without changing the active install", "platform.rollback",
                 reject_unknown_snapshot, cases=["S-024.4", "S-203.11"], details=checkpoint_details,
                 requires=("step:roll back to version N with explicit non-TTY confirmation",))

    def verify_rollback() -> str | None:
        receipt = json.loads(receipt_path.read_text())
        if receipt.get("installationId") != installation_id:
            raise RuntimeError("installationId changed during rollback")
        if receipt.get("verification", {}).get("hostHealthUrl") != gateway_url:
            raise RuntimeError("Gateway address changed during rollback")
        assert_service_ports_preserved(initial_plan, receipt.get("plan", {}), "rollback")
        version = receipt.get("plan", {}).get("serviceGraph", {}).get("platformVersion")
        if version != base_version:
            raise RuntimeError(f"restored receipt is {version!r}, expected {base_version}")
        status = _json_command(run_command, [launcher, "status", "--platform-root", root, "--json"], "restored status")
        if status.get("running") is not True or status.get("reachable") is not True:
            raise RuntimeError("kb-create status did not confirm the restored host")
        assert_shared_file_fingerprints("restored platform verification")
        assert_platform_storage_choice("after rollback")
        if verify_user is not None:
            if not saved_user_session_established:
                raise RuntimeError("saved user session was not established before update")
            if not saved_session_succeeded_after_update:
                raise RuntimeError("saved user session did not run a protected command successfully after update")
        command = run_command(kb_command([ "project", "list", "--json"], executable=kb_binary))
        try:
            envelope = read_ux_cli_result(command)
            if command.returncode != 0:
                failure = decode_ux_error_result(envelope)
                raise RuntimeError(f"project list after rollback was rejected: {failure!r}")
            payload = decode_ux_success_result(envelope)
        except ValueError as error:
            raise RuntimeError(f"project list after rollback returned an invalid UX result: {error}") from error
        if not isinstance(payload, dict) or not isinstance(payload.get("projects"), list):
            raise RuntimeError("project list after rollback did not return a projects payload")
        _json_command(run_command, kb_command([ "adapter", "list", "--json"], executable=kb_binary), "adapter list after rollback")

    journey.step("verify restored receipt, config, host, and project command", "platform.rollback", verify_rollback,
                 cases=["S-024.3", "S-041.4", "PC-001.14"] if verify_user is not None else ["S-024.3", "PC-001.14"],
                 details=checkpoint_details,
                 requires=("step:save installed receipt, config, and host status",
                           "step:roll back to version N with explicit non-TTY confirmation",
                           "step:reject a missing snapshot without changing the active install"))

    if mode == "secured":
        journey.step(
            "verify disclosed bootstrap credential absent after update and rollback", "platform.install",
            lambda: password_absence_failure(platform_root, bootstrap_outside_roots, bootstrap_password),
            cases=["S-100.1"], runners=("service-secured:explore",),
            requires=("step:verify restored receipt, config, host, and project command",),
        )

    if verify_user is not None:
        def login_after_rollback() -> None:
            login = verify_user()
            if login.returncode != 0:
                raise RuntimeError(f"existing admin login failed after rollback: {' '.join(login.stdout.split())[-400:]}")

        journey.step("existing admin can log in after rollback", "platform.rollback", login_after_rollback,
                     cases=["S-024.3"])

    def doctor() -> None:
        result = _json_command(run_command, [launcher, "doctor", "--platform-root", root, "--json"], "doctor")
        if result.get("platform", {}).get("ok") is not True:
            raise RuntimeError("kb-create doctor did not report a healthy restored platform")

    journey.step("diagnose the restored platform", "platform.rollback", doctor, cases=["S-024.5", "S-203.10"])

    def restart_and_verify_identity() -> None:
        result = _json_command(run_command, [launcher, "restart", "--platform-root", root, "--json"], "restart platform")
        host = result.get("host")
        if result.get("operation") != "restart" or not isinstance(host, dict) or not isinstance(host.get("pid"), int) or host["pid"] <= 0:
            raise RuntimeError("restart did not return operation=restart and a running host PID")
        receipt = json.loads(receipt_path.read_text())
        if receipt.get("installationId") != installation_id:
            raise RuntimeError("installationId changed during restart")
        if receipt.get("verification", {}).get("hostHealthUrl") != gateway_url:
            raise RuntimeError("Gateway address changed during restart")
        assert_service_ports_preserved(initial_plan, receipt.get("plan", {}), "restart")
        _json_command(run_command, kb_command([ "adapter", "list", "--json"], executable=kb_binary), "adapter list after restart")

    journey.step("restart the installed host and run an adapter command", "platform.restart",
                 restart_and_verify_identity, cases=["PC-001.15"])
    def update_secret_policy() -> None:
        secret = "gateway.jwtSecret"
        env_name = "KB_X10_UPDATE_SECRET"
        previous = os.environ.get(env_name)
        original = secure_random.token_hex(32)
        changed = original + "-changed"
        try:
            os.environ[env_name] = original
            stopped = run_command([launcher, "stop", "--platform-root", root, "--json"])
            if stopped.returncode != 0:
                raise RuntimeError("the journey could not stop its host before seeding the known secret")
            seeded = run_command([launcher, "apply", "--platform-root", root, "--json", "--index",
                                  str(update_index), "--input", str(request_file),
                                  "--secret-env", f"{secret}={env_name}"])
            if seeded.returncode != 0:
                restored = run_command([launcher, "start", "--platform-root", root, "--json"])
                if restored.returncode != 0:
                    raise RuntimeError("secret seeding failed and the stopped host could not be restored: "
                                       + " ".join((restored.stderr or restored.stdout).split())[-500:])
                raise RuntimeError("the journey could not seed its known secret through apply")
            restored = run_command([launcher, "start", "--platform-root", root, "--json"])
            if restored.returncode != 0:
                raise RuntimeError("the host could not be restored after seeding the known secret: "
                                   + " ".join((restored.stderr or restored.stdout).split())[-500:])
            identical = run_command([launcher, "update", "--platform-root", root, "--json", "--index", str(update_index),
                                     "--input", str(request_file), "--secret-env", f"{secret}={env_name}"])
            if identical.returncode != 0:
                raise RuntimeError("an identical stored --secret-env value was not accepted")
            shared_before = snapshot_state_tree(platform_root / layout_value('sharedStateDirectory'))
            os.environ[env_name] = changed
            refused = run_command([launcher, "update", "--platform-root", root, "--json", "--index", str(update_index),
                                   "--input", str(request_file), "--secret-env", f"{secret}={env_name}"])
            try:
                envelope = read_kb_create_cli_result("update", refused)
                failure = decode_ux_error_result(envelope)
            except ValueError as error:
                raise RuntimeError(f"changed update secret did not return a typed refusal: {error}") from error
            if refused.returncode == 0 or failure.get("code") != "KB_UPDATE_SECRET_REFUSED":
                raise RuntimeError("changed --secret-env value was not refused with KB_UPDATE_SECRET_REFUSED")
            if snapshot_state_tree(platform_root / layout_value('sharedStateDirectory')) != shared_before:
                raise RuntimeError("refused update-time secret change modified shared runtime state")
            hint = failure.get("hint")
            if not isinstance(hint, str) or hint.count("`") < 2:
                raise RuntimeError("secret refusal did not provide an executable stop/apply command")
            commands = parse_shell_commands(hint.split("`", 2)[1])
            if len(commands) != 2:
                raise RuntimeError("secret refusal hint did not contain the exact stop/apply sequence")
            for argv in commands:
                if not argv or argv[0] != "kb-create":
                    raise RuntimeError("secret refusal hint command did not start with kb-create")
                argv[0] = launcher
                executed = run_command(argv)
                if executed.returncode != 0:
                    raise RuntimeError(f"the suggested next command failed ({argv[1]}): {executed.stderr.strip()}")
            status = _json_command(run_command, [launcher, "status", "--platform-root", root, "--json"], "status after secret apply")
            doctor = _json_command(run_command, [launcher, "doctor", "--platform-root", root, "--json"], "doctor after secret apply")
            try:
                active_root = active_platform_root(platform_root)
            except (FileNotFoundError, ValueError) as error:
                raise RuntimeError(f"the suggested apply command left no valid active platform root: {error}") from error
            if (not current_link_path(platform_root).is_symlink()
                    or not (current_link_path(platform_root) / '.kb/v2/receipt.json').is_file()
                    or status.get("running") is not True or status.get("reachable") is not True
                    or doctor.get("platform", {}).get("ok") is not True):
                raise RuntimeError("the suggested apply command did not leave a healthy installed host")
            repeated = _json_command(run_command, [launcher, "update", "--platform-root", root, "--json",
                                                   "--index", str(update_index), "--input", str(request_file),
                                                   "--secret-env", f"{secret}={env_name}"], "update with applied secret")
            if repeated.get("alreadyUpToDate") is not True:
                raise RuntimeError("update with the newly stored secret was not an up-to-date no-op")
        finally:
            if previous is None:
                os.environ.pop(env_name, None)
            else:
                os.environ[env_name] = previous

    journey.step("refuse update-time installation secret changes", "platform.update", update_secret_policy,
                 cases=["S-023.18"])


    return journey
