"""Bounded, secret-redacted snapshot of an installed journey platform."""
from __future__ import annotations

from invocations import CompletedProcess, TimeoutExpired
from installed_fixture import installed_path, layout_relative, layout_value

import hashlib
import json
import os
import re
import shutil
import sqlite3
import time
from pathlib import Path
from typing import Mapping
from typing import Any

from journey_resources import active_platform_root, installer_record_path
from kb_invocation import kb_command, kb_shell_text
import redaction
import jsonl

MAX_DUMP_BYTES = 5 * 1024 * 1024
CONTENT_BUDGET = MAX_DUMP_BYTES - 64 * 1024
MAX_FILE_BYTES = 1024 * 1024
TAIL_LINES = 400
UNKNOWN_COMMAND = re.compile(r"Unknown command:\s*([^\n\r]+)")
SERVICE_LOG_BUDGET = 2 * 1024 * 1024


def failure_dump_environment(active_main: Mapping[str, str] | None,
                             last_command: Mapping[str, str] | None,
                             fallback: Mapping[str, str]) -> Mapping[str, str]:
    """Keep failure dumps pointed at the main install after fixture commands."""
    if fallback.get("KB_JOURNEY_HOME_LABEL") == "main" and fallback.get("HOME"):
        return fallback
    return active_main or last_command or fallback


class PlatformStateDumpOnce:
    """Ensure one runner invocation writes at most one platform snapshot."""

    def __init__(self) -> None:
        self._dumped = False

    def reset(self) -> None:
        self._dumped = False

    def dump(self, *args: Any, **kwargs: Any) -> Path | None:
        if self._dumped:
            return None
        self._dumped = True
        return dump_platform_state(*args, **kwargs)


def _write_evidence_text(target: Path, value: str, *, env: Mapping[str, str] | None = None,
                         secrets: tuple[str, ...] = (), append: bool = False) -> str:
    from invocations import write_report_text
    return write_report_text(target, value, env=env, secrets=secrets, append=append)


def _write_evidence_json(target: Path, value: Any, *, env: Mapping[str, str] | None = None,
                         secrets: tuple[str, ...] = ()) -> Any:
    from invocations import write_report_json
    return write_report_json(target, value, env=env, secrets=secrets)


def _safe_copy(source: Path, target: Path, admin_password: str, *, tail: bool = False) -> int:
    try:
        if not source.is_file():
            return 0
        size = source.stat().st_size
        if size > MAX_FILE_BYTES and not tail:
            return 0
        content = source.read_text(errors="replace")
        if tail:
            content = "\n".join(content.splitlines()[-TAIL_LINES:]) + "\n"
            # A pathological single line must not defeat the per-file and dump caps.
            content = content[-MAX_FILE_BYTES:]
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.suffix.lower() == ".json":
            try:
                _write_evidence_json(target, redaction.redact_json(json.loads(content)), secrets=(admin_password,))
                return target.stat().st_size
            except json.JSONDecodeError:
                pass
        _write_evidence_text(target, redaction.redact_text(content, secrets=(admin_password,)), secrets=(admin_password,))
        return target.stat().st_size
    except OSError:
        return 0


def _write_state_fingerprints(source: Path, target: Path) -> int:
    """Record one-way fingerprints for every opaque shared-state file."""
    try:
        fingerprints = {}
        for path in sorted(source.rglob("*")):
            if path.is_file():
                relative = path.relative_to(source).as_posix()
                fingerprints[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        if not fingerprints:
            return 0
        target.parent.mkdir(parents=True, exist_ok=True)
        _write_evidence_json(target, fingerprints)
        return target.stat().st_size
    except OSError:
        return 0


def _registered_project_state(project_root: Path, env: Mapping[str, str] | None) -> Path | None:
    command_env = dict(env or os.environ)
    home = Path(command_env.get("KB_HOME", str(Path(command_env.get("HOME", str(Path.home()))) / ".kb")))
    try:
        projects = json.loads((home / "projects.json").read_text()).get("projects", [])
    except (OSError, json.JSONDecodeError, AttributeError):
        return None
    project = next((row for row in projects if isinstance(row, dict)
                    and isinstance(row.get("id"), str)
                    and Path(row.get("path", "")).resolve() == project_root.resolve()), None)
    return home / layout_value('sharedStateDirectory') / project["id"] if project else None


def _write_auth_state_probe(platform_root: Path, target: Path) -> int:
    """Write aggregate session health and database identity without credential material."""
    active = active_platform_root(platform_root)
    config_path = active / layout_value('sharedRuntimePaths.kb_kb_config_jsonc.platformPath')
    try:
        config = json.loads(config_path.read_text())
        filename = config["platform"]["adapterOptions"]["documentDatabase"]["filename"]
        database = Path(filename)
        if not database.is_absolute():
            database = active / ".kb" / "data" / database
        stat = database.stat()
        connection = sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True, timeout=1)
        try:
            families = [json.loads(row[0]) for row in connection.execute(
                "SELECT data FROM doc_session_families")]
            refreshes = [json.loads(row[0]) for row in connection.execute(
                "SELECT data FROM doc_refresh_tokens")]
        finally:
            connection.close()
        refresh_by_family: dict[str, list[dict[str, Any]]] = {}
        for refresh in refreshes:
            refresh_by_family.setdefault(str(refresh.get("familyId", "")), []).append(refresh)
        users: dict[str, dict[str, Any]] = {}
        now_ms = time.time_ns() // 1_000_000
        for family in families:
            user_id = str(family.get("userId", "unknown"))
            family_refreshes = refresh_by_family.get(str(family.get("familyId", "")), [])
            active = any(not item.get("consumedAt") and item.get("expiresAt", 0) > now_ms
                         for item in family_refreshes)
            user = users.setdefault(user_id, {"sessionFamilyCount": 0, "active": 0, "inactive": 0})
            user["sessionFamilyCount"] += 1
            user["active" if active else "inactive"] += 1
        payload = {
            "sessionStorePath": str(database),
            "databaseFile": {"device": stat.st_dev, "inode": stat.st_ino,
                             "sizeBytes": stat.st_size, "modifiedTimeNs": stat.st_mtime_ns},
            "users": users,
        }
        target.parent.mkdir(parents=True, exist_ok=True)
        _write_evidence_json(target, payload)
        return target.stat().st_size
    except (OSError, sqlite3.Error, KeyError, TypeError, ValueError) as error:
        target.parent.mkdir(parents=True, exist_ok=True)
        _write_evidence_json(target, {"available": False, "reason": error.__class__.__name__})
        return target.stat().st_size


def archive_service_logs(kb_home: str | Path, reports_dir: str | Path, *, platform_root: str | Path,
                         mode: str, run_id: str) -> Path:
    """Copy bounded structured service logs from installed runtime state to the run report."""
    home = Path(kb_home)
    destination = Path(reports_dir) / f"service-logs-{mode}-{run_id}"
    destination.mkdir(parents=True, exist_ok=True)
    used = 0
    platform_database = active_platform_root(Path(platform_root)) / ".kb" / "data" / "database" / "kb.sqlite"
    databases = {*home.glob(layout_relative('sharedStateDirectory', '*/database/kb.sqlite')), platform_database}
    for database in sorted(databases):
        try:
            connection = sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True, timeout=1)
            try:
                rows = connection.execute(
                    "SELECT id, data FROM doc_logs ORDER BY updated_at DESC LIMIT 400"
                ).fetchall()
            finally:
                connection.close()
        except sqlite3.Error:
            continue
        grouped: dict[str, list[dict[str, Any]]] = {}
        for row_id, serialized in rows:
            try:
                record = json.loads(serialized)
            except (TypeError, json.JSONDecodeError):
                continue
            if not isinstance(record, dict):
                continue
            fields = record.get("fields")
            fields = fields if isinstance(fields, dict) else {}
            service = str(fields.get("serviceId") or fields.get("service_id") or record.get("source", ""))
            app_id = str(fields.get("appId") or fields.get("app_id") or "")
            component = str(fields.get("component") or "")
            application_id = str(fields.get("applicationId") or fields.get("application_id") or "")
            normalized = f"{service} {app_id} {component} {application_id} {record.get('source', '')}".lower()
            category = next((candidate for needle, candidate in (
                ("cli", "cli"),
                ("workflow", "workflow-daemon"), ("project-runtime", "project-runtime"),
                ("gateway", "gateway"), ("host", "host"),
            ) if needle in normalized), None)
            if category is None:
                continue
            record.setdefault("logId", row_id)
            grouped.setdefault(category, []).append(record)
        for category, records in grouped.items():
            target = destination / database.parents[1].name / f"{category}.jsonl"
            encoded_records = []
            category_bytes = 0
            for record in records:
                line = jsonl.encode_jsonl_record(record)
                if used + category_bytes + len(line) > SERVICE_LOG_BUDGET:
                    break
                encoded_records.append(line)
                category_bytes += len(line)
            encoded = b"".join(encoded_records)
            if encoded:
                rendered = _write_evidence_text(target, encoded.decode(errors="replace"))
                used += len(rendered.encode())
            if used >= SERVICE_LOG_BUDGET:
                return destination
    return destination


def _command(output: Path, label: str, args: list[str], *, env: Mapping[str, str], cwd: Path,
             admin_password: str, timeout: int = 30, budget: int = MAX_DUMP_BYTES,
             result_sink: list[CompletedProcess[str]] | None = None) -> int:
    try:
        from invocations import run_command
        result = run_command(args, cwd=cwd, env=env, timeout=timeout)
        if result_sink is not None:
            result_sink.append(result)
        body = f"exit_code: {result.returncode}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    except (OSError, TimeoutExpired) as error:
        body = f"error: {error.__class__.__name__}: {error}"
    encoded = f"{label}\n{body}\n".encode()
    if len(encoded) > budget:
        encoded = encoded[:budget]
    output.parent.mkdir(parents=True, exist_ok=True)
    rendered = _write_evidence_text(output, encoded.decode(errors="replace"), secrets=(admin_password,))
    return len(rendered.encode())


def dump_platform_state(platform_root: str | Path, reports_dir: str | Path, *, mode: str,
                        front: str, scenario: str, variant: str, first_failure: str,
                        env: Mapping[str, str] | None = None, cwd: str | Path | None = None,
                        admin_password: str = "") -> Path:
    """Write a platform snapshot, or an explicit diagnosis when no valid root exists."""
    root = Path(platform_root)
    reports = Path(reports_dir)
    destination = reports / f"platform-state-{mode}-{front}-{scenario}-{variant}"
    try:
        active = active_platform_root(root)
    except (FileNotFoundError, ValueError) as error:
        destination.mkdir(parents=True, exist_ok=True)
        diagnosis = {
            "schema": "kb.journey.install-root-diagnosis/v1",
            "platformRoot": str(root),
            "layoutError": str(error),
            "firstFailure": first_failure,
        }
        _write_evidence_text(
            destination / "install-root-diagnosis.json",
            json.dumps(diagnosis, indent=2) + "\n",
            env=env,
            secrets=(admin_password,) if admin_password else (),
        )
        return destination
    try:
        destination.mkdir(parents=True, exist_ok=True)
        used = 0
        entries: list[str] = []

        def add(source: Path, relative: Path, *, tail: bool = False) -> None:
            nonlocal used
            if used >= CONTENT_BUDGET:
                return
            written = _safe_copy(source, destination / relative, admin_password, tail=tail)
            if written and used + written <= CONTENT_BUDGET:
                used += written
                entries.append(f"- `{relative}` ({written} bytes)")
            elif written:
                (destination / relative).unlink(missing_ok=True)

        for relative in (Path(layout_value('versionStatePaths.kb_marketplace_lock')), Path(layout_value('sharedRuntimePaths.kb_kb_config_jsonc.platformPath')),
                         Path('.kb/v2/receipt.json')):
            source = installed_path(root, 'currentLink', '.kb/v2/receipt.json') if relative == Path('.kb/v2/receipt.json') else active / relative
            add(source, relative)
        fingerprint_bytes = _write_state_fingerprints(
            root / layout_value('sharedStateDirectory'), destination / "shared-state-fingerprints.json"
        )
        if fingerprint_bytes and used + fingerprint_bytes <= CONTENT_BUDGET:
            used += fingerprint_bytes
            entries.append(f"- `shared-state-fingerprints.json` ({fingerprint_bytes} bytes)")
        elif fingerprint_bytes:
            (destination / "shared-state-fingerprints.json").unlink(missing_ok=True)
        auth_probe_bytes = _write_auth_state_probe(root, destination / "auth-state-probe.json")
        if auth_probe_bytes and used + auth_probe_bytes <= CONTENT_BUDGET:
            used += auth_probe_bytes
            entries.append(f"- `auth-state-probe.json` ({auth_probe_bytes} bytes)")
        elif auth_probe_bytes:
            (destination / "auth-state-probe.json").unlink(missing_ok=True)
        snapshots = installer_record_path(root, "snapshots")
        for source in sorted(snapshots.glob("*.json")):
            add(source, Path(layout_value("installerRecords.snapshots")) / source.name)
        receipt_path = installed_path(root, 'currentLink', '.kb/v2/receipt.json')
        provenance_path = active / ".kb/v2/installed-provenance.json"
        if provenance_path.is_file():
            add(provenance_path, Path("installed-package-provenance.json"))
        try:
            receipt_value = json.loads(receipt_path.read_text())
            artifacts = receipt_value.get("plan", {}).get("artifacts", [])
            artifact_manifests = []
            for artifact in artifacts:
                package = artifact.get("package")
                if not isinstance(package, str) or not package:
                    continue
                manifest_path = active / "node_modules" / Path(*package.split("/")) / "kb-create.manifest.json"
                artifact_manifests.append({
                    "id": artifact.get("id"),
                    "package": package,
                    "version": artifact.get("version"),
                    "manifestExists": manifest_path.is_file(),
                })
            if artifact_manifests:
                target = destination / "receipt-artifact-manifests.json"
                encoded = json.dumps(artifact_manifests, indent=2) + "\n"
                if used + len(encoded.encode()) <= CONTENT_BUDGET:
                    _write_evidence_json(target, artifact_manifests, env=env)
                    used += target.stat().st_size
                    entries.append(f"- `receipt-artifact-manifests.json` ({target.stat().st_size} bytes)")
        except (OSError, json.JSONDecodeError, AttributeError, TypeError):
            pass
        for directory in ("logs", "diagnostics"):
            files = sorted((active / ".kb" / directory).glob("*"),
                           key=lambda path: path.stat().st_mtime if path.exists() else 0, reverse=True)
            for source in files[:3]:
                add(source, Path(".kb") / directory / source.name, tail=directory == "logs")

        # Workflow state belongs to the registered project, which is a sibling
        # of the installed platform in the journey container. Keep the search
        # shallow and targeted so diagnostics never copy unrelated user files.
        evidence_roots = [root]
        try:
            evidence_roots.extend(
                candidate for candidate in root.parent.iterdir()
                if candidate.is_dir() and candidate != root
            )
        except OSError:
            pass
        for evidence_root in evidence_roots:
            evidence_prefix = Path("workflow-evidence") / evidence_root.name
            project_state = _registered_project_state(evidence_root, env)
            workflow_records = project_state / "storage" / "workflows" if project_state else None
            try:
                records = sorted(workflow_records.glob("*.json"),
                                 key=lambda path: path.stat().st_mtime, reverse=True)
            except (OSError, AttributeError):
                records = []
            for source in records[:20]:
                add(source, evidence_prefix / "project-state" / "storage" / "workflows" / source.name)

            for directory in ("logs", "diagnostics"):
                log_root = project_state / directory if project_state else None
                try:
                    logs = sorted(
                        (path for path in log_root.glob("*")
                         if path.is_file() and re.search(r"workflow|daemon", path.name, re.I)),
                        key=lambda path: path.stat().st_mtime,
                        reverse=True,
                    )
                except (OSError, AttributeError):
                    logs = []
                for source in logs[:3]:
                    add(source, evidence_prefix / "project-state" / directory / source.name, tail=True)

        packages = []
        scope = active / "node_modules" / "@kb-labs"
        try:
            for package in sorted(scope.iterdir()):
                manifest = package / "package.json"
                if manifest.is_file():
                    try:
                        data = json.loads(manifest.read_text())
                    except (OSError, json.JSONDecodeError):
                        continue
                    packages.append(f"{package.name}@{data.get('version', 'unknown')}")
        except OSError:
            pass
        if packages:
            listing = "\n".join(packages) + "\n"
            target = destination / "kb-labs-packages.txt"
            if used + len(listing.encode()) <= CONTENT_BUDGET:
                _write_evidence_text(target, listing, env=env)
                used += target.stat().st_size
                entries.append(f"- `kb-labs-packages.txt` ({target.stat().st_size} bytes)")

        command_env = dict(env or os.environ)
        command_cwd = Path(cwd) if cwd else root
        kb_executable = shutil.which("kb", path=command_env.get("PATH"))
        if not kb_executable and (root.parent / ".local" / "bin" / "kb").is_file():
            kb_executable = str(root.parent / ".local" / "bin" / "kb")
        kb_executable = kb_executable or "kb"
        for scope in ("platform", "project"):
            target = destination / f"kb-marketplace-plugins-{scope}.txt"
            command_args = ["marketplace", "plugins", "list", "--scope", scope, "--json"]
            args = kb_command(command_args, executable=kb_executable)
            used += _command(target, "$ " + kb_shell_text(command_args), args,
                             env=command_env, cwd=command_cwd, admin_password=admin_password,
                             budget=CONTENT_BUDGET - used)
            entries.append(f"- `{target.name}` ({target.stat().st_size} bytes)")
        unknown = UNKNOWN_COMMAND.search(first_failure)
        if unknown and used < CONTENT_BUDGET:
            command = unknown.group(1).strip().strip("'\"` ")
            target = destination / "kb-command-diagnostic.txt"
            command_args = ["diag", "--command", command, "--json"]
            args = kb_command(command_args, executable=kb_executable)
            used += _command(target, "$ " + kb_shell_text(command_args), args,
                             env=command_env, cwd=command_cwd, admin_password=admin_password,
                             budget=CONTENT_BUDGET - used)
            entries.append(f"- `kb-command-diagnostic.txt` ({target.stat().st_size} bytes)")

        launcher = shutil.which("kb-create", path=command_env.get("PATH"))
        if not launcher and (root.parent / ".local" / "bin" / "kb-create").is_file():
            launcher = str(root.parent / ".local" / "bin" / "kb-create")
        launcher = launcher or "kb-create"
        doctor_results: list[CompletedProcess[str]] = []
        for name in ("status", "doctor"):
            if used >= CONTENT_BUDGET:
                break
            target = destination / f"kb-create-{name}.txt"
            args = [launcher, name, "--platform-root", str(root), "--json"]
            used += _command(target, "$ kb-create " + " ".join(args[1:]), args,
                             env=command_env, cwd=command_cwd, admin_password=admin_password,
                             budget=CONTENT_BUDGET - used,
                             result_sink=doctor_results if name == "doctor" else None)
            entries.append(f"- `{target.name}` ({target.stat().st_size} bytes)")

        host_state_missing = "Doctor did not report retention.hostState; host log sources are unavailable."
        try:
            from invocations import decode_ux_success_result, read_kb_create_cli_result
            result = doctor_results[-1]
            doctor_data = decode_ux_success_result(
                read_kb_create_cli_result("doctor", result))
            retention = doctor_data.get("retention", {})
            host_state_value = retention.get("hostState")
            if isinstance(host_state_value, str) and host_state_value:
                host_state = Path(host_state_value)
                logs = sorted(path for path in host_state.rglob("*.log") if path.is_file())
                if not logs:
                    host_state_missing = f"Doctor reported hostState `{host_state}` but it contains no log files."
                else:
                    host_state_missing = ""
                    for source in logs:
                        if used >= CONTENT_BUDGET:
                            break
                        relative = Path("installer-host-state") / source.relative_to(host_state)
                        add(source, relative, tail=True)
        except (IndexError, OSError, json.JSONDecodeError, AttributeError, TypeError, ValueError):
            pass
        if host_state_missing:
            entries.append(f"- Missing host log evidence: {host_state_missing}")

        if used < CONTENT_BUDGET:
            target = destination / "kb-adapter-list.txt"
            used += _command(target, "$ " + kb_shell_text(["adapter", "list", "--json"]),
                             kb_command(["adapter", "list", "--json"], executable=kb_executable),
                             env=command_env, cwd=command_cwd, admin_password=admin_password,
                             budget=CONTENT_BUDGET - used)
            entries.append(f"- `kb-adapter-list.txt` ({target.stat().st_size} bytes)")

        if not root.exists():
            entries.append("- Platform root was already removed; only remaining runner evidence was captured.")
        if used > CONTENT_BUDGET:
            raise AssertionError("platform state dump exceeded its size cap")
        failure_excerpt = first_failure[:20_000]
        revision = command_env.get("KB_JOURNEY_GIT_REVISION", "unknown")
        index = "# Platform state dump\n\nJourney git revision: " + revision
        index += "\n\nFirst failure: " + failure_excerpt
        index += "\n\nFiles:\n" + ("\n".join(entries) if entries else "- No platform files or commands were available.") + "\n"
        _write_evidence_text(destination / "index.md", index, env=command_env,
                             secrets=(admin_password,))
    except Exception as error:  # diagnostics must never mask the journey failure
        try:
            destination.mkdir(parents=True, exist_ok=True)
            _write_evidence_text(
                destination / "index.md",
                "# Platform state dump\n\nDump failed: "
                + f"{error.__class__.__name__}: {error}\n",
                env=env, secrets=(admin_password,),
            )
        except OSError:
            pass
    return destination
