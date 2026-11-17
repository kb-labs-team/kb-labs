"""Installed Steward jobs verified through the public platform storage API."""
from __future__ import annotations

import json
import os
import urllib.request
from collections.abc import Callable
from datetime import datetime, timezone

from invocations import invocation_context, open_http, read_ux_cli_result, read_ux_http_result, run_command
from journey_values import journey_value
from kb_invocation import kb_command
from service_steps import Journey

STEWARD_COLLECTIONS = (
    "projects", "resources", "people", "companies", "project_members",
    "commitments", "events", "topics",
)


def _run_job(handler: str, *, project_root: str, env: dict[str, str], runner) -> dict:
    command = kb_command(["workflow", "job", "run", f"--handler=plugin:@kb-labs/steward/job/{handler}",
                          "--wait", "--json"], executable=env.get("KB_JOURNEY_CLI_PATH", "kb"))
    result = runner(command, cwd=project_root, env=env, timeout=180, capture_output=True,
                    text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"job {handler} failed: {' '.join((result.stdout or '').split())[-500:]}")
    payload = read_ux_cli_result(result)
    if payload.get("ok") is not True:
        raise RuntimeError(f"job {handler} returned unsuccessful CLI envelope")
    data = payload.get("data")
    if not isinstance(data, dict) or data.get("status") != "success":
        raise RuntimeError(f"job {handler} did not report final success: {data!r}")
    return data


def _date_key() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _read_storage(key: str, *, env: dict[str, str], opener) -> bytes:
    base_url = env.get("KB_JOURNEY_BASE_URL", "http://127.0.0.1:4000").rstrip("/")
    request = urllib.request.Request(
        f"{base_url}/platform/v1/storage/read",
        data=json.dumps({"args": [key]}).encode("utf-8"),
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {env['KB_JOURNEY_SERVICE_TOKEN']}",
        },
        method="POST",
    )
    status, body, _ = open_http(opener, request, timeout=60, env=env)
    envelope = read_ux_http_result(body, status)
    if status != 200:
        raise RuntimeError(f"platform storage read failed for {key}: HTTP {status} {envelope.get('error')!r}")
    value = envelope.get("data")
    if isinstance(value, str):
        return value.encode("utf-8")
    if isinstance(value, dict) and value.get("type") == "Buffer" and isinstance(value.get("data"), list):
        try:
            return bytes(value["data"])
        except (TypeError, ValueError) as error:
            raise RuntimeError(f"platform storage returned invalid Buffer JSON for {key}") from error
    raise RuntimeError(f"platform storage returned unsupported read value for {key}: {type(value).__name__}")


def _review(content: bytes, *, stale_marker: str, upcoming_marker: str, project_marker: str,
            expected_backup: str) -> str:
    text = content.decode("utf-8")
    sections = text.split("## ")
    stale = next((section for section in sections if section.startswith("Stale commitments")), "")
    upcoming = next((section for section in sections if section.startswith("Upcoming")), "")
    projects = next((section for section in sections if section.startswith("Active projects")), "")
    missing = []
    if expected_backup not in text:
        missing.append(f"backup status {expected_backup!r}")
    if stale_marker not in stale:
        missing.append(f"stale commitment {stale_marker!r} in stale section")
    if upcoming_marker not in upcoming:
        missing.append(f"upcoming commitment {upcoming_marker!r} in upcoming section")
    if project_marker not in projects:
        missing.append(f"project {project_marker!r} in active projects section")
    if missing:
        raise RuntimeError(f"Steward review artifact is missing expected content: {missing}")
    return text


def _backup(content: bytes, *, project_marker: str, stale_marker: str, upcoming_marker: str) -> dict:
    try:
        snapshot = json.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Steward backup artifact is not readable JSON: {error}") from error
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("exportedAt"), (int, float)):
        raise RuntimeError("Steward backup must contain numeric exportedAt")
    collections = snapshot.get("collections")
    if not isinstance(collections, dict) or any(name not in collections for name in STEWARD_COLLECTIONS):
        raise RuntimeError("Steward backup is missing a declared collection")
    projects = collections.get("projects")
    commitments = collections.get("commitments")
    if not isinstance(projects, list) or not any(project_marker in json.dumps(item) for item in projects):
        raise RuntimeError("Steward backup does not contain the seeded project")
    if not isinstance(commitments, list) or not any(stale_marker in json.dumps(item) for item in commitments):
        raise RuntimeError("Steward backup does not contain the seeded stale commitment")
    if not any(upcoming_marker in json.dumps(item) for item in commitments):
        raise RuntimeError("Steward backup does not contain the seeded upcoming commitment")
    return snapshot


def run_steward_artifact_steps(
    journey: Journey,
    *,
    project_root: str,
    env: dict[str, str] | None = None,
    runner=run_command,
    opener=None,
    storage_reader: Callable[..., bytes] | None = None,
) -> None:
    """Run registered jobs and independently read their objects through Gateway."""
    env = dict(os.environ if env is None else env)
    marker = journey_value("KB_JOURNEY_S301_DATA_MARKER", f"s301-{journey.run_id}", state=env)
    project_marker = f"{marker} project"
    stale_marker = f"{marker} stale commitment"
    upcoming_marker = f"{marker} upcoming commitment"
    if not env.get("KB_JOURNEY_SERVICE_TOKEN"):
        raise RuntimeError("S-301 requires KB_JOURNEY_SERVICE_TOKEN with platform settings read permission")
    from urllib.request import urlopen
    opener = opener or urlopen
    read_storage = storage_reader or _read_storage

    def review_before_export() -> str | None:
        try:
            with invocation_context(step_id="S-301.1"):
                _run_job("daily-review", project_root=project_root, env=env, runner=runner)
            review_bytes = read_storage(f"steward/reviews/{_date_key()}.md", env=env, opener=opener)
            _review(review_bytes, stale_marker=stale_marker, upcoming_marker=upcoming_marker,
                    project_marker=project_marker, expected_backup="last backup: never")
            return None
        except Exception as error:
            return str(error)

    journey.step("run Steward daily review and inspect its persisted Markdown", "steward-artifacts",
                 review_before_export, cases=["S-301.1"])

    def backup() -> str | None:
        try:
            with invocation_context(step_id="S-301.2"):
                _run_job("export-backup", project_root=project_root, env=env, runner=runner)
            backup_bytes = read_storage(f"steward/exports/{_date_key()}.json", env=env, opener=opener)
            _backup(backup_bytes, project_marker=project_marker, stale_marker=stale_marker,
                    upcoming_marker=upcoming_marker)
            return None
        except Exception as error:
            return str(error)

    journey.step("run Steward export and inspect every backed-up collection", "steward-artifacts",
                 backup, cases=["S-301.2"])

    def review_after_backup() -> str | None:
        try:
            with invocation_context(step_id="S-301.3"):
                _run_job("daily-review", project_root=project_root, env=env, runner=runner)
            review_bytes = read_storage(f"steward/reviews/{_date_key()}.md", env=env, opener=opener)
            _review(review_bytes, stale_marker=stale_marker, upcoming_marker=upcoming_marker,
                    project_marker=project_marker, expected_backup="last backup: 0d ago")
            backup_bytes = read_storage(f"steward/exports/{_date_key()}.json", env=env, opener=opener)
            _backup(backup_bytes, project_marker=project_marker, stale_marker=stale_marker,
                    upcoming_marker=upcoming_marker)
            return None
        except Exception as error:
            return str(error)

    journey.step("confirm the next review sees the successful backup", "steward-artifacts",
                 review_after_backup, cases=["S-301.3"])
