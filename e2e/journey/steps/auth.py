"""HTTP auth journey steps for the fresh-install journey runner.

Interface: call ``run_secured_auth_steps(base_url, admin_email, admin_password,
member_email, restart_host)`` after installing and starting a secured platform.
``restart_host`` stops and starts the host, then returns its reachable base URL.
Call ``run_local_auth_steps(base_url)`` after a local install.
"""
from __future__ import annotations

from kb_invocation import kb_command

import json
import os
import tempfile
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from gateway_sessions import gateway_session
from invocations import (
    CompletedProcess,
    decode_ux_error_result,
    decode_ux_success_result,
    open_http,
    read_ux_cli_result,
    read_ux_http_result,
    catalogued_error_hint,
    run_command,
    run_pty_command,
    store_report_secret,
)


def _request(base_url: str, path: str, *, method: str = "GET", token: str | None = None,
             body: dict | None = None, expected: int = 200) -> dict:
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode() if body is not None else None
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(base_url.rstrip("/") + path, data=data, headers=headers, method=method)
    status, raw, _ = open_http(urllib.request.urlopen, request, timeout=15, env=os.environ)
    if status != expected:
        raise AssertionError(f"{method} {path}: expected HTTP {expected}, got {status}: {raw[:300]!r}")
    envelope = read_ux_http_result(raw, status)
    return (decode_ux_success_result(envelope) if 200 <= status < 300
            else decode_ux_error_result(envelope))


def _login(base_url: str, email: str, password: str) -> tuple[str, str]:
    store_report_secret(os.environ, "KB_JOURNEY_LOGIN_PASSWORD", password,
                        "journey login password")
    result = _request(base_url, "/auth/login/cli", method="POST", body={"email": email, "password": password})
    return (store_report_secret(os.environ, "KB_JOURNEY_ACCESS_TOKEN", result["accessToken"],
                                "login access token"),
            store_report_secret(os.environ, "KB_JOURNEY_REFRESH_TOKEN", result["refreshToken"],
                                "login refresh token"))


def assert_machine_registration_requires_auth(base_url: str) -> None:
    """Require human signup attempts to retain the canonical anonymous-auth denial."""
    payload = _request(
        base_url,
        "/auth/register",
        method="POST",
        body={"name": "new-member", "email": "new-member@example.test", "password": "HumanPass123!"},
        expected=401,
    )
    expected_hint = catalogued_error_hint("KB_AUTH_REQUIRED", gatewayUrl=base_url.rstrip("/"))
    if (payload.get("code") != "KB_AUTH_REQUIRED"
            or payload.get("message") != "Authentication is required."
            or payload.get("hint") != expected_hint):
        raise AssertionError(f"anonymous /auth/register returned an unexpected auth envelope: {payload!r}")


def run_local_auth_steps(base_url: str) -> None:
    """Prove that loopback/local mode needs no login and identifies local-admin."""
    profile = _request(base_url, "/auth/me")
    user = profile.get("user", profile)
    if user.get("userId") != "local-admin" and user.get("handle") != "local-admin":
        raise AssertionError(f"local /auth/me did not identify local-admin: {profile!r}")


def run_cli_auth_status(cli_path: str, env: dict[str, str], *, authenticated: bool,
                        email: str | None = None, base_url: str | None = None,
                        password: str | None = None) -> None:
    """Prove the CLI status surface in local and secured mode."""
    def invoke(args: list[str], **kwargs) -> CompletedProcess[str]:
        return run_command([cli_path, *args], env=env, **kwargs)


    if authenticated:
        if not base_url or not email or not password:
            raise ValueError("secured CLI auth status requires gateway URL, email, and password")
        missing_password = invoke(["auth", "login", "--gateway-url", base_url, "--email", email])
        expected_hint = (f"cat password.txt | kb auth login --gateway-url '{base_url}' "
                         f"--email '{email}' --password-stdin")
        human_error = missing_password.stderr
        expected_output = (
            "KB_RUNTIME_INPUT_INVALID",
            "The provided input is invalid.",
            "The password prompt requires an interactive terminal.",
            expected_hint,
        )
        if missing_password.returncode != 2 or any(part not in human_error for part in expected_output):
            raise AssertionError(
                f"non-TTY kb auth login returned an unexpected human error on stderr: {human_error[-600:]}"
            )
        login = invoke(["auth", "login", "--gateway-url", base_url, "--email", email,
                        "--password-stdin"], input=password + "\n")
        if login.returncode != 0:
            raise AssertionError(f"kb auth login failed: {(login.stdout + login.stderr)[-400:]}")
        if password in login.stdout or password in login.stderr:
            raise AssertionError("kb auth login echoed the password supplied through stdin")
        command = kb_command([ "auth", "login", "--gateway-url", base_url, "--email", email], executable=cli_path)
        password_sent = False

        def enter_password(transcript: str) -> str | None:
            nonlocal password_sent
            if not password_sent and "Password: " in transcript:
                password_sent = True
                return password + "\n"
            return None

        tty_login, _ = run_pty_command(command, env=env, timeout=30, on_output=enter_password)
        tty_transcript = _combined(tty_login)
        if tty_login.returncode != 0 or not password_sent or "Authenticated" not in tty_transcript:
            raise AssertionError(f"TTY kb auth login did not complete: {tty_transcript[-400:]}")
        if password in tty_transcript:
            raise AssertionError("TTY kb auth login echoed the password")
    status = invoke(["auth", "status", "--json"])
    try:
        status_payload = decode_ux_success_result(read_ux_cli_result(status))
    except (json.JSONDecodeError, ValueError) as error:
        raise AssertionError(f"kb auth status --json did not return JSON: {status.stdout[-400:]}") from error
    if authenticated:
        session = gateway_session(status_payload, base_url) or {}
    else:
        sessions = status_payload.get("sessions")
        if (not isinstance(sessions, list) or len(sessions) != 1
                or sessions[0].get("authenticated") is not False):
            raise AssertionError("kb auth status reported an unexpected saved human session")
        return
    if status.returncode != 0 or session.get("authenticated") is not authenticated:
        raise AssertionError(f"kb auth status returned unexpected JSON: {status_payload!r}")
    if email and session.get("email") != email:
        raise AssertionError(f"kb auth status returned the wrong email: {session!r}")
    if authenticated:
        session_path = session.get("path")
        if not isinstance(session_path, str) or not Path(session_path).is_file():
            raise AssertionError(f"kb auth status did not report its saved session file: {session!r}")
        tokens = invoke(["auth", "tokens", "--json"])
        try:
            tokens_payload = decode_ux_success_result(read_ux_cli_result(tokens))
        except (json.JSONDecodeError, ValueError) as error:
            raise AssertionError(f"kb auth tokens --json did not return JSON: {tokens.stdout[-400:]}") from error
        if tokens.returncode != 0:
            raise AssertionError(f"kb auth tokens returned unexpected JSON: {tokens_payload!r}")


def run_cli_auth_forbidden(cli_path: str, env: dict[str, str], *, user_id: str = "member-1") -> None:
    """A logged-in member must get the gateway's typed permission denial."""
    args = kb_command([ "auth", "reset-link", "--user-id", user_id, "--json"], executable=cli_path)
    result = run_command(args, env=env)
    try:
        payload = decode_ux_error_result(read_ux_cli_result(result))
    except (json.JSONDecodeError, ValueError) as error:
        raise AssertionError("member auth reset-link did not return JSON") from error
    error = payload
    if (result.returncode == 0 or not isinstance(error, dict)
            or error.get("code") != "KB_AUTH_FORBIDDEN"
            or error.get("details", {}).get("permission") != "users:write"):
        raise AssertionError(f"member auth reset-link returned an unexpected result: {payload!r}")


def _combined(result: CompletedProcess[str]) -> str:
    """Output of a command whose stderr may already be merged into stdout (stderr is None)."""
    return (result.stdout or "") + (result.stderr or "")


def assert_platform_auth_required(result: CompletedProcess[str], command: list[str],
                                  gateway: str = "<url>", *, require_context: bool = False) -> None:
    """Require the exact anonymous CLI auth envelope promised by S-041.7."""
    try:
        payload = decode_ux_error_result(read_ux_cli_result(result))
    except (json.JSONDecodeError, ValueError) as error:
        raise AssertionError(f"unauthenticated {' '.join(command)} did not return JSON") from error
    failure = payload
    if (result.returncode == 0 or not isinstance(failure, dict)
            or failure.get("code") != "KB_AUTH_REQUIRED"
            or failure.get("message") != "Authentication is required."
            or failure.get("hint") != catalogued_error_hint("KB_AUTH_REQUIRED", gatewayUrl=gateway)):
        raise AssertionError(f"unauthenticated {' '.join(command)} returned an unexpected result: {payload!r}")
    if require_context:
        correlation_id = failure.get("correlationId")
        records = []
        for line in (result.stderr or "").splitlines():
            marker = "CLI resolved invocation context "
            if marker in line:
                encoded = line.split(marker, 1)[1]
                try:
                    record = json.loads(encoded)
                except json.JSONDecodeError as error:
                    raise AssertionError("CLI context diagnostic was not structured JSON") from error
                records.append(record)
        if (not isinstance(correlation_id, str) or not correlation_id
                or len(records) != 1 or records[0].get("correlationId") != correlation_id):
            raise AssertionError(f"unauthenticated {' '.join(command)} did not join to one resolved CLI context record")


def assert_cli_session_absent(result: CompletedProcess[str]) -> None:
    """Confirm the CLI product reports no authenticated human session."""
    try:
        payload = decode_ux_success_result(read_ux_cli_result(result))
    except (json.JSONDecodeError, ValueError) as error:
        raise AssertionError("kb auth status --json did not return JSON") from error
    session = payload.get("session") if isinstance(payload, dict) else None
    if result.returncode != 0 or not isinstance(payload, dict):
        raise AssertionError(f"kb auth status --json did not report an unauthenticated session: {payload!r}")
    if not isinstance(session, dict) or session.get("authenticated") is not False:
        raise AssertionError("kb auth status --json reported that the CLI session is authenticated")


def run_cli_corrupt_session_file(cli_path: str, env: dict[str, str]) -> None:
    """A malformed saved session must produce the catalogued repair envelope."""
    with tempfile.TemporaryDirectory(prefix="kb-journey-auth-home-") as home:
        isolated_env = dict(env)
        isolated_env["HOME"] = home
        isolated_env["KB_JOURNEY_HOME_LABEL"] = "corrupt-auth-session"
        status = run_command(kb_command([ "auth", "status", "--json"], executable=cli_path), env=isolated_env)
        try:
            status_data = decode_ux_success_result(read_ux_cli_result(status))
        except (json.JSONDecodeError, ValueError) as error:
            raise AssertionError("kb auth status did not expose the session path") from error
        session_path = Path(status_data["session"]["path"])
        session_path.parent.mkdir(parents=True)
        session_path.write_text("{ invalid json", encoding="utf-8")
        command = kb_command([ "config", "show", "--json"], executable=cli_path)
        result = run_command(command, env=isolated_env)
        try:
            envelope = read_ux_cli_result(result)
        except (json.JSONDecodeError, ValueError) as error:
            raise AssertionError("corrupt saved session did not return one ADR-0049 JSON envelope") from error
        failure = decode_ux_error_result(envelope)
        expected_hint = 'Run "kb auth login" to replace the saved authentication data, then retry the command.'
        if (result.returncode != 1 or failure.get("code") != "KB_CONFIG_INVALID"
                or failure.get("details", {}).get("path") != ".kb/session.json"
                or failure.get("details", {}).get("reason") != "invalid"
                or ".kb/session.json" not in failure.get("message", "")
                or failure.get("hint") != expected_hint):
            raise AssertionError(f"corrupt saved session returned an unexpected result: {envelope!r}")


def run_bootstrap_recovery_steps(launcher: str, platform_root: str, email: str,
                                 old_password: str, new_password: str, env: dict[str, str],
                                 invoke: Callable[..., tuple[CompletedProcess[str], float]],
                                 *, on_valid_password: Callable[[str], None]) -> None:
    """Exercise stopped-host recovery, recovered login, and the running-host guard."""
    login = _request("http://127.0.0.1:4000", "/auth/login/cli", method="POST",
                     body={"email": email, "password": old_password})
    if not login.get("accessToken"):
        raise AssertionError("bootstrap admin login did not return an access token")
    store_report_secret(os.environ, "KB_JOURNEY_ACCESS_TOKEN", login["accessToken"],
                        "bootstrap admin access token")
    initial_profile = _request("http://127.0.0.1:4000", "/auth/me", token=login["accessToken"])
    tenant = initial_profile.get("tenantId")
    if not tenant:
        raise AssertionError("bootstrap administrator profile did not include tenantId")
    stopped, _ = invoke([launcher, "stop", "--platform-root", platform_root], env=env)
    if stopped.returncode != 0:
        raise AssertionError(f"kb-create stop failed: {_combined(stopped)[-400:]}")
    recover_args = [launcher, "doctor", "--platform-root", platform_root, "--recover", "--email", email,
                    "--tenant", tenant, "--password-stdin", "--yes"]
    recovered: CompletedProcess[str] | None = None
    recovery_error: Exception | None = None
    try:
        recovered, _ = invoke(recover_args, env=env, input_text=new_password + "\n")
    except Exception as error:
        recovery_error = error
    finally:
        started, _ = invoke([launcher, "start", "--platform-root", platform_root], env=env)
    if started.returncode != 0:
        raise AssertionError(f"kb-create start failed after recovery: {_combined(started)[-400:]}")

    valid_password = ""
    for password in (new_password, old_password):
        try:
            access, _ = _login("http://127.0.0.1:4000", email, password)
            profile = _request("http://127.0.0.1:4000", "/auth/me", token=access)
        except Exception:
            continue
        if profile.get("email") == email and profile.get("tenantId") == tenant:
            valid_password = password
            break
    if not valid_password:
        raise AssertionError("neither the recovered nor the original bootstrap password authenticates")
    on_valid_password(valid_password)

    if recovery_error:
        raise AssertionError("kb-create doctor --recover could not be run") from recovery_error
    if recovered is None or recovered.returncode != 0:
        output = "" if recovered is None else _combined(recovered)
        for secret in (old_password, new_password):
            output = output.replace(secret, "[redacted]")
        raise AssertionError(f"kb-create doctor --recover failed: {output[-400:]}")
    if valid_password != new_password:
        raise AssertionError("kb-create doctor --recover exited successfully but the new password did not authenticate")
    if new_password in _combined(recovered):
        raise AssertionError("kb-create doctor --recover echoed the supplied password")
    running_recovery, _ = invoke(recover_args, env=env, input_text=new_password + "\n")
    output = _combined(running_recovery).lower()
    if running_recovery.returncode == 0 or "kb_install_recovery_host_running" not in output or "stopped" not in output or "kb-create stop" not in output or "kb-create start" not in output:
        raise AssertionError("running-host recovery did not explain that the host must be stopped and restarted")


def run_secured_auth_steps(base_url: str, admin_email: str, admin_password: str,
                           member_email: str, restart_host: Callable[[], str]) -> None:
    """Prove install, role, invite, reset, persistence, and logout behavior."""
    store_report_secret(os.environ, "KB_JOURNEY_ADMIN_PASSWORD", admin_password,
                        "secured journey admin password")
    assert_machine_registration_requires_auth(base_url)
    _request(base_url, "/auth/me", expected=401)
    admin_access, admin_refresh = _login(base_url, admin_email, admin_password)
    me = _request(base_url, "/auth/me", token=admin_access)
    if me.get("email") != admin_email:
        raise AssertionError(f"admin /auth/me returned the wrong identity: {me!r}")
    permissions = _request(base_url, "/auth/permissions", token=admin_access)
    if not permissions.get("permissions"):
        raise AssertionError("admin permissions response was empty")

    invite = _request(base_url, "/auth/invites", method="POST", token=admin_access,
                      body={"email": member_email, "role": "member"}, expected=201)
    activation_url = invite.get("activationUrl", "")
    if "/activate/" not in activation_url:
        raise AssertionError(f"invite activation link does not match the SPA route: {activation_url!r}")
    activation_token = activation_url.rsplit("/activate/", 1)[1]
    store_report_secret(os.environ, "KB_JOURNEY_INVITE_TOKEN", activation_token,
                        "invite activation token")
    _request(base_url, "/auth/activate", method="POST",
             body={"token": activation_token, "password": "JourneyMember123!"})
    member_access, _ = _login(base_url, member_email, "JourneyMember123!")
    _request(base_url, "/auth/users", token=member_access, expected=403)

    users = _request(base_url, "/auth/users", token=admin_access).get("users", [])
    member = next((user for user in users if user.get("email") == member_email), None)
    if not member:
        raise AssertionError(f"invited user is missing from admin user list: {users!r}")
    reset = _request(base_url, f"/auth/users/{member['userId']}/password-reset-link",
                     method="POST", token=admin_access, expected=201)
    reset_token = reset.get("resetUrl", "").rsplit("/reset-password/", 1)[-1]
    if not reset_token:
        raise AssertionError("admin reset response did not include a reset link")
    store_report_secret(os.environ, "KB_JOURNEY_PASSWORD_RESET_TOKEN", reset_token,
                        "password reset token")
    _request(base_url, "/auth/password/reset", method="POST",
             body={"token": reset_token, "newPassword": "JourneyReplacement123!"})
    _request(base_url, "/auth/me", token=member_access, expected=401)
    _request(base_url, "/auth/login/cli", method="POST",
             body={"email": member_email, "password": "JourneyMember123!"}, expected=401)
    _login(base_url, member_email, "JourneyReplacement123!")

    restarted_url = restart_host()
    restarted_admin = _request(restarted_url, "/auth/me", token=admin_access)
    if restarted_admin.get("email") != admin_email:
        raise AssertionError(f"admin session did not survive host restart: {restarted_admin!r}")
    _request(restarted_url, "/auth/login/cli", method="POST",
             body={"email": member_email, "password": "JourneyReplacement123!"})
    logout = _request(restarted_url, "/auth/logout/cli", method="POST", body={"refreshToken": admin_refresh})
    if logout.get("ok") is not True:
        raise AssertionError(f"CLI logout did not confirm session revocation: {logout!r}")
    _request(restarted_url, "/auth/me", token=admin_access, expected=401)
    _request(restarted_url, "/auth/refresh/cli", method="POST",
             body={"refreshToken": admin_refresh}, expected=401)
    fresh_admin_access, _ = _login(restarted_url, admin_email, admin_password)
    fresh_admin = _request(restarted_url, "/auth/me", token=fresh_admin_access)
    if fresh_admin.get("email") != admin_email:
        raise AssertionError(f"fresh admin login after logout returned the wrong identity: {fresh_admin!r}")
