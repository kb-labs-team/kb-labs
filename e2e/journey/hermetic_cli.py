"""Run host-side journey CLI commands without reading the caller's KB state."""
from __future__ import annotations

import os
import json
import sys
import subprocess
import tempfile
from pathlib import Path
from typing import Callable, Mapping
from urllib.parse import urlsplit

from installed_fixture import configure_hermetic_cli_fixture
from kb_invocation import kb_command

from invocations import (
    CompletedProcess,
    decode_ux_success_result,
    print_report_text,
    read_ux_cli_result,
    run_command,
)


def run_hermetic_cli(
    command: list[str],
    *,
    cwd: str | Path | None = None,
    env: Mapping[str, str] | None = None,
    runner: Callable[..., CompletedProcess[str]] | None = None,
    timeout: float = 300,
    workspace_root: Path | None = None,
    installed_platform_root: Path | None = None,
    project_root: Path | None = None,
    gateway_login: tuple[str, str, str] | None = None,
    gateway_machine_login: tuple[str, str, str] | None = None,
    redact_output: bool = False,
    register_project: bool = False,
    forbid_secret_in_files: str | None = None,
    require_extension_store_entry: tuple[str, str] | None = None,
    server_kb_home: Path | None = None,
) -> CompletedProcess[str]:
    """Run a host-side CLI with fresh HOME and explicit local access mode."""
    if workspace_root is not None:
        workspace_root = Path(workspace_root).resolve()
        if not workspace_root.is_dir():
            raise FileNotFoundError(f"Journey workspace is missing at {workspace_root}")
    child_env = dict(os.environ if env is None else env)
    with tempfile.TemporaryDirectory(prefix="kb-journey-home-") as home:
        fixture_env = configure_hermetic_cli_fixture(
            Path(home), env=child_env, workspace_root=workspace_root,
            installed_platform_root=installed_platform_root)
        if project_root is not None:
            fixture_env["KB_PROJECT_ROOT"] = str(Path(project_root).resolve())
        fixture_cwd = fixture_env["KB_PROJECT_ROOT"] if workspace_root is not None else cwd
        if project_root is not None:
            fixture_cwd = str(Path(project_root).resolve())
        if gateway_login is not None:
            gateway_url, email, password = gateway_login
            if not gateway_url or not email or not password:
                raise ValueError("isolated Gateway login requires a URL, email, and password")
            executable = command[:2] if command and Path(command[0]).name == "node" and len(command) > 1 else command[:1]
            login = run_command(
                [*executable, "auth", "login", "--gateway-url", gateway_url,
                 "--email", email, "--password-stdin"],
                cwd=fixture_cwd, env=fixture_env, runner=runner, timeout=min(timeout, 90),
                input=password + "\n",
            )
            session_path = Path(fixture_env["KB_HOME"]) / "session.json"
            session_origin = urlsplit(gateway_url)
            try:
                stored = json.loads(session_path.read_text(encoding="utf-8"))
                sessions = stored.get("sessions", []) if isinstance(stored, dict) else []
                has_matching_session = any(
                    isinstance(session, dict)
                    and urlsplit(str(session.get("gatewayUrl", ""))).scheme == session_origin.scheme
                    and urlsplit(str(session.get("gatewayUrl", ""))).netloc == session_origin.netloc
                    and isinstance(session.get("accessToken"), str) and bool(session["accessToken"])
                    and isinstance(session.get("refreshToken"), str) and bool(session["refreshToken"])
                    for session in sessions
                )
            except (OSError, json.JSONDecodeError, AttributeError):
                has_matching_session = False
            if (login.returncode != 0 or password in login.stdout or password in login.stderr
                    or not session_path.is_file() or session_path.stat().st_mode & 0o777 != 0o600
                    or not has_matching_session):
                raise RuntimeError("isolated Gateway login did not create a private CLI session")
        if gateway_machine_login is not None:
            gateway_url, client_id, client_secret = gateway_machine_login
            if not gateway_url or not client_id or not client_secret:
                raise ValueError("isolated Gateway machine login requires a URL and credentials")
            executable = command[:2] if command and Path(command[0]).name == "node" and len(command) > 1 else command[:1]
            try:
                login = run_command(
                    [*executable, "auth", "login", "--gateway-url", gateway_url,
                     "--client-id", client_id, "--client-secret", client_secret],
                    cwd=fixture_cwd, env=fixture_env, runner=runner, timeout=min(timeout, 90),
                )
            except (OSError, subprocess.TimeoutExpired):
                raise RuntimeError("isolated Gateway machine login failed; credentials are redacted") from None
            credential_path = Path(fixture_env["KB_HOME"]) / "credentials.json"
            if (login.returncode != 0 or client_secret in login.stdout or client_secret in login.stderr
                    or not credential_path.is_file() or credential_path.stat().st_mode & 0o777 != 0o600):
                raise RuntimeError("isolated Gateway machine login did not create private CLI credentials")
        if register_project:
            if project_root is None:
                raise ValueError("hermetic project registration requires a project root")
            register = kb_command(["project", "add", str(Path(project_root).resolve()), "--json"])
            registered = run_command(register, cwd=fixture_cwd, env=fixture_env,
                                     runner=runner, timeout=min(timeout, 120))
            if registered.returncode != 0:
                raise RuntimeError("installed kb could not register the hermetic consumer project")
            try:
                data = decode_ux_success_result(read_ux_cli_result(registered))
                result = data if isinstance(data, dict) else None
                record = result.get("project") if isinstance(result, dict) else None
            except (ValueError, AttributeError):
                record = None
            if not isinstance(record, dict) or record.get("path") != str(Path(project_root).resolve()):
                raise RuntimeError("installed kb project registration returned no matching consumer root")
        try:
            result = run_command(command, cwd=fixture_cwd, env=fixture_env, runner=runner,
                                 timeout=timeout, redact_output=redact_output)
        except (OSError, subprocess.TimeoutExpired):
            if redact_output:
                raise RuntimeError("sensitive hermetic CLI command failed; inspect redacted invocation evidence") from None
            raise
        if forbid_secret_in_files:
            secret = forbid_secret_in_files.encode()
            roots = [Path(server_kb_home).resolve() if server_kb_home is not None
                     else Path(fixture_env["KB_HOME"])]
            if project_root is not None:
                roots.append(Path(project_root).resolve() / ".kb")
            for root in roots:
                if not root.exists():
                    continue
                for path in root.rglob("*"):
                    if path.is_file():
                        try:
                            if secret in path.read_bytes():
                                raise RuntimeError("sensitive CLI credential was persisted in project or extension-store files")
                        except OSError:
                            continue
        if require_extension_store_entry is not None:
            package_name, version = require_extension_store_entry
            entry_key = f"{package_name.replace('/', '+')}@{version}"
            store_home = Path(server_kb_home).resolve() if server_kb_home is not None else Path(fixture_env["KB_HOME"])
            entry_dir = store_home / "store" / "entries" / entry_key
            try:
                entry = json.loads((entry_dir / "entry.json").read_text(encoding="utf-8"))
                package_root = entry_dir / "node_modules" / Path(*package_name.split("/"))
            except (OSError, json.JSONDecodeError) as error:
                raise RuntimeError("Marketplace install did not create a valid ExtensionStore entry") from error
            if (not isinstance(entry, dict) or entry.get("name") != package_name
                    or entry.get("version") != version or not package_root.is_dir()):
                raise RuntimeError("Marketplace install did not materialize its package in ExtensionStore")
        return result


def main() -> int:
    command = sys.argv[1:]
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        print_report_text("usage: hermetic_cli.py -- <command> [args...]", stream=sys.stderr)
        return 2
    try:
        result = run_hermetic_cli(command, cwd=Path.cwd(), workspace_root=Path.cwd())
    except Exception as error:
        print_report_text(f"Hermetic journey command failed: {error.__class__.__name__}: {error}",
                          stream=sys.stderr, flush=True)
        return 1
    if result.stdout:
        print_report_text(result.stdout, end="", flush=True)
    if result.stderr:
        print_report_text(result.stderr, stream=sys.stderr, end="", flush=True)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
