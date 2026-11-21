"""Run host-side journey CLI commands without reading the caller's KB state."""
from __future__ import annotations

import os
import json
import sys
import tempfile
from pathlib import Path
from typing import Callable, Mapping
from urllib.parse import urlsplit

from installed_fixture import configure_hermetic_cli_fixture

from invocations import (
    CompletedProcess,
    print_report_text,
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
    gateway_login: tuple[str, str, str] | None = None,
) -> CompletedProcess[str]:
    """Run a host-side CLI with fresh HOME and explicit local access mode."""
    if workspace_root is not None:
        workspace_root = Path(workspace_root).resolve()
        cli_entry = workspace_root / "cli/bin/dist/bin.js"
        if not cli_entry.is_file():
            raise FileNotFoundError(
                f"built workspace CLI is missing at {cli_entry}; "
                "build it with `kb-devkit run build --affected` and retry"
            )
    child_env = dict(os.environ if env is None else env)
    with tempfile.TemporaryDirectory(prefix="kb-journey-home-") as home:
        fixture_env = configure_hermetic_cli_fixture(
            Path(home), env=child_env, workspace_root=workspace_root)
        fixture_cwd = fixture_env["KB_PROJECT_ROOT"] if workspace_root is not None else cwd
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
        return run_command(command, cwd=fixture_cwd, env=fixture_env, runner=runner, timeout=timeout)


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
