"""Installed secured journey coverage for connection and session cases."""
from __future__ import annotations

from kb_invocation import kb_command

import json
import os
from pathlib import Path
from datetime import datetime, timezone
import uuid
from urllib.parse import urlparse
import urllib.request

from gateway_sessions import SavedGatewaySession, gateway_session
from invocations import (decode_ux_error_result, decode_ux_success_result, invocation_context,
                         open_http, read_ux_cli_result, read_ux_http_result,
                         store_report_secret, run_command)
from service_steps import Journey, journey_modes
from steps.accounts import _browser_call, _browser_login
from steps.auth import _login, _request


def _expect(value: bool, message: str) -> None:
    if not value:
        raise AssertionError(message)


def _cli(cli: str, env: dict[str, str], *args: str):
    return run_command(kb_command([ *args], executable=cli), env=env, timeout=90)


def _json(result, description: str) -> dict:
    try:
        value = read_ux_cli_result(result)
    except json.JSONDecodeError as error:
        raise AssertionError(f"{description} did not return JSON") from error
    _expect(isinstance(value, dict), f"{description} did not return a JSON object")
    envelope = value
    return envelope


def _response(base: str, path: str, *, method: str = "GET", token: str = "",
              body: dict | None = None, extra_headers: dict[str, str] | None = None,
              return_envelope: bool = False) -> tuple[int, dict]:
    headers = {"Accept": "application/json"}
    headers.update(extra_headers or {})
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode() if body is not None else None
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    status, raw, _ = open_http(urllib.request.urlopen, request, timeout=15, env=os.environ)
    try:
        envelope = read_ux_http_result(raw, status)
    except json.JSONDecodeError as error:
        raise AssertionError(f"{method} {path} did not return JSON") from error
    if return_envelope:
        return status, envelope
    payload = (decode_ux_success_result(envelope) if 200 <= status < 300
               else decode_ux_error_result(envelope))
    _expect(isinstance(payload, dict), f"{method} {path} did not return a JSON object")
    return status, payload


def validate_case_response(case_id: str, status: int, value: dict, *, expected: str = "") -> None:
    """Validate observable response contracts; split by claim for fake-failure tests."""
    contracts = {
        "S-042.1": lambda: status == 201 and bool(value.get("inviteId"))
        and urlparse(str(value.get("activationUrl", ""))).netloc == expected,
        "S-042.2": lambda: status == 200 and value.get("ok") is True,
        "S-042.3": lambda: status == 422 and value.get("code") == "KB_AUTH_INVALID_INVITE"
        and bool(value.get("hint")),
        "S-042.5": lambda: status == 200 and value.get("ok") is True,
        "S-042.6": lambda: status == 400 and value.get("code") == "KB_AUTH_INVALID_PASSWORD_RESET"
        and bool(value.get("hint")),
        "S-005.4": lambda: status == 200 and "projects:read" in value.get("permissions", [])
        and "users:read" not in value.get("permissions", []),
        "S-005.5": lambda: status == 403 and value.get("code") == "KB_AUTH_FORBIDDEN"
        and value.get("message") == "Permission denied: users:read"
        and bool(value.get("hint")),
    }
    if case_id not in contracts:
        raise ValueError(f"no HTTP response contract for {case_id}")
    _expect(contracts[case_id](), f"{case_id} response did not match the case contract")


def validate_hidden_health_response(health_status: int, health_body: dict,
                                    unknown_status: int, unknown_body: dict) -> None:
    """Require denied auth health to be indistinguishable from an unknown Gateway path."""
    for status, body, description in (
        (health_status, health_body, "denied /health/auth"),
        (unknown_status, unknown_body, "unknown Gateway path"),
    ):
        _expect(status == 404, f"{description} returned HTTP {status}, expected 404")
        _expect(set(body) == {"ok", "error"} and body.get("ok") is False,
                f"{description} did not return the canonical UX error envelope")
        error = body["error"]
        _expect(isinstance(error, dict), f"{description} did not return an error object")
        _expect(error.get("code") == "KB_RUNTIME_RESOURCE_NOT_FOUND",
                f"{description} did not return KB_RUNTIME_RESOURCE_NOT_FOUND")
        _expect(not any(key in error for key in ("readiness", "checks", "activeAdmins", "authEnabled")),
                f"{description} exposed readiness details")

    normalized_health = dict(health_body)
    normalized_unknown = dict(unknown_body)
    normalized_health["error"] = dict(health_body["error"])
    normalized_unknown["error"] = dict(unknown_body["error"])
    normalized_health["error"].pop("correlationId", None)
    normalized_unknown["error"].pop("correlationId", None)
    _expect(normalized_health == normalized_unknown,
            "denied /health/auth response differed from unknown Gateway path beyond correlationId")


def validate_local_health_response(status: int, body: dict) -> None:
    """Require an anonymous unproxied loopback request to reach readiness output."""
    _expect(status == 200, f"local /health/auth returned HTTP {status}, expected 200")
    data = body.get("data")
    _expect(body.get("ok") is True and isinstance(data, dict),
            "local /health/auth did not return the canonical UX success envelope")
    _expect({"authEnabled", "tenantId", "activeAdmins", "bootstrap", "issues"}.issubset(data),
            "local /health/auth omitted readiness output")


def _client_cli_provenance_matches(payload: dict, sealed_index: dict | None) -> bool:
    if not isinstance(sealed_index, dict):
        return False
    data = payload.get("data", payload)
    receipt = data.get("receipt", {}) if isinstance(data, dict) else {}
    plan = receipt.get("plan", {}) if isinstance(receipt, dict) else {}
    artifacts = plan.get("artifacts", []) if isinstance(plan, dict) else []
    if not isinstance(artifacts, list):
        return False
    cli_artifact = next((item for item in artifacts if isinstance(item, dict)
                         and item.get("package") == "@kb-labs/cli-bin"), None)
    if not isinstance(cli_artifact, dict):
        return False
    records = sealed_index.get("provenance")
    if not isinstance(records, list):
        return False
    expected = next((item for item in records if isinstance(item, dict)
                     and item.get("package") == "@kb-labs/cli-bin"
                     and item.get("version") == cli_artifact.get("version")), None)
    actual = cli_artifact.get("provenance")
    if not isinstance(expected, dict) or not isinstance(actual, dict):
        return False
    fields = ("sourceRevision", "integrity", "contentScope", "distSha256")
    return (expected.get("contentScope") == "dist"
            and all(isinstance(expected.get(field), str) and expected[field]
                    and actual.get(field) == expected[field] for field in fields))


def validate_cli_case(case_id: str, returncode: int, output: str, payload: dict | None = None,
                      *, email: str = "", gateway: str = "", root: str = "",
                      sealed_index: dict | None = None) -> None:
    """Validate CLI observables independently so fake failures exercise each claim."""
    payload = payload or {}
    data = payload.get("data", payload)
    session = (gateway_session(data, gateway) or {}) if returncode == 0 and case_id in {"S-005.3", "S-031.1"} else {}
    checks = {
        "S-005.1": returncode == 0 and payload.get("ok") is True and root == expected_root(payload)
        and data.get("profile") == "client" and data.get("services") == []
        and isinstance(data.get("shim"), dict)
        and _client_cli_provenance_matches(payload, sealed_index),
        "S-005.2": returncode == 0,
        "S-005.3": returncode == 0 and session.get("authenticated") is True
        and session.get("email") == email and session.get("gatewayUrl") == gateway,
        "S-031.1": returncode == 0 and session.get("authenticated") is True
        and session.get("tokenExpired") is True and session.get("gatewayUrl") == gateway
        and isinstance(session.get("path"), str)
        and Path(session["path"]).parent.name == ".kb"
        and Path(session["path"]).name == "session.json",
        "S-031.2": returncode == 0 and bool(output.strip()),
        "S-031.3": returncode != 0 and "kb auth login" in output.lower()
        and "stack" not in output.lower()
        and not any(line.lstrip().startswith("at ") for line in output.splitlines()),
        "S-031.4": returncode != 0 and "kb auth login --gateway-url" in output,
        "S-042.4": returncode == 0 and payload.get("ok") is True
        and bool(data.get("resetUrl")) and isinstance(data.get("expiresAt"), (int, float)),
    }
    if case_id not in checks:
        raise ValueError(f"no CLI response contract for {case_id}")
    _expect(checks[case_id], f"{case_id} CLI result did not match the case contract")


def _session_status(cli: str, env: dict[str, str]) -> dict:
    result = _cli(cli, env, "auth", "status", "--json")
    return decode_ux_success_result(read_ux_cli_result(result))


def _journey_home(env: dict[str, str]) -> Path:
    """Return the isolated HOME passed to child commands, not the runner's HOME."""
    return Path(env["HOME"])


def expected_root(payload: dict) -> str:
    receipt = payload.get("data", payload).get("receipt", {})
    return str(receipt.get("plan", {}).get("request", {}).get("platformRoot", ""))


@journey_modes("secured")
def register_secured_connection_steps(journey: Journey, env: dict[str, str]) -> None:
    """Register exact S-005, S-031, and S-042 journey claims.

    The flow intentionally provisions the invited account before connecting it,
    then exercises the real CLI session file and gateway refresh-token routes.
    """
    base = env.get("KB_JOURNEY_BASE_URL", "http://127.0.0.1:4000").rstrip("/")
    cli = env.get("KB_JOURNEY_CLI_PATH", str(Path.home() / ".local/bin/kb"))
    admin_email = env.get("KB_JOURNEY_ADMIN_EMAIL", "journey-admin@example.test")
    admin_password = env.get("KB_JOURNEY_ADMIN_PASSWORD", "")
    member_email = "coverage-member@example.test"
    member_password = "MemberPass123!"

    state: dict[str, str] = {}

    def hidden_auth_health():
        local_status, local_body = _response(base, "/health/auth", return_envelope=True)
        validate_local_health_response(local_status, local_body)
        health_status, health_error = _response(
            base, "/health/auth", extra_headers={"X-Forwarded-For": "203.0.113.10"},
            return_envelope=True)
        unknown_path = f"/api/v1/__journey_unknown_{uuid.uuid4().hex}"
        unknown_status, unknown_error = _response(base, unknown_path, return_envelope=True)
        validate_hidden_health_response(health_status, health_error, unknown_status, unknown_error)
        return None

    journey.step("hide auth readiness from proxied anonymous requests", "auth.secured",
                 hidden_auth_health, cases=["S-041.15"])

    def invite():
        with invocation_context(step_id="journey.setup"):
            access, _ = _login(base, admin_email, admin_password)
            jar = _browser_login(base, admin_email, admin_password)
        response = _browser_call(base, jar, "/auth/invites", method="POST",
                                 body={"email": member_email, "role": "member"}, csrf=True,
                                 expected=201)
        validate_case_response("S-042.1", 201, response, expected=urlparse(base).netloc)
        _expect(bool(response.get("inviteId")), "invite response omitted inviteId")
        url = str(response.get("activationUrl", ""))
        _expect(urlparse(url).netloc == urlparse(base).netloc, "activation URL was not on the gateway host")
        token = url.rstrip("/").rsplit("/", 1)[-1]
        _expect(bool(token), "activation URL omitted its token")
        store_report_secret(env, "KB_JOURNEY_INVITE_TOKEN", token,
                            "secured connection activation token")
        state.update(admin_access=access, invite_token=token)
        return None

    def activate():
        with invocation_context(step_id="journey.setup"):
            jar = _browser_login(base, admin_email, admin_password)
        body = _browser_call(base, jar,
                             "/auth/activate", method="POST",
                             body={"token": state["invite_token"], "password": member_password},
                             expected=200)
        validate_case_response("S-042.2", 200, body)
        _expect(body.get("ok") is True, "activation did not return ok=true")
        profile = _browser_call(base, jar, "/auth/me")
        user = profile.get("user", profile)
        _expect(user.get("email") == member_email and bool(user.get("tenantId")),
                "activation session did not identify the member and tenant")
        with invocation_context(step_id="journey.setup"):
            access, _ = _login(base, member_email, member_password)
        state["member_access"] = access
        return None

    def replay_invite():
        status, value = _response(base, "/auth/activate", method="POST",
                                  body={"token": state["invite_token"], "password": member_password})
        validate_case_response("S-042.3", status, value)
        return None

    journey.step("invite member with admin session", "auth.secured", invite, cases=["S-042.1"])
    journey.step("activate invitation and resolve member session", "auth.secured", activate, cases=["S-042.2"],
                 requires=("step:invite member with admin session",))
    journey.step("reject consumed activation token", "auth.secured", replay_invite, cases=["S-042.3"],
                 requires=("step:invite member with admin session",))

    def reset_link():
        started = datetime.now(timezone.utc)
        with invocation_context(step_id="journey.setup"):
            users = _request(base, "/auth/users", token=state["admin_access"]).get("users", [])
        member = next((user for user in users if user.get("email") == member_email), None)
        _expect(isinstance(member, dict) and bool(member.get("userId")), "admin could not find invited user")
        result = _cli(cli, env, "auth", "reset-link", "--user-id", str(member["userId"]), "--json")
        value = _json(result, "kb auth reset-link")
        result_data = value.get("data", {})
        reset_url = str(result_data.get("resetUrl", ""))
        expires = result_data.get("expiresAt")
        if reset_url:
            state["reset_token"] = reset_url.rstrip("/").rsplit("/", 1)[-1]
            store_report_secret(env, "KB_JOURNEY_PASSWORD_RESET_TOKEN", state["reset_token"],
                                "secured connection password reset token")
        validate_cli_case("S-042.4", result.returncode, result.stdout, value)
        _expect(bool(reset_url) and isinstance(expires, (int, float)),
                "reset-link JSON omitted expiresAt required by S-042.4")
        expires_at = (datetime.fromtimestamp(float(expires) / 1000, timezone.utc)
                      if float(expires) > 10_000_000_000
                      else datetime.fromtimestamp(float(expires), timezone.utc))
        remaining = (expires_at - started).total_seconds()
        _expect(24 * 3600 - 60 <= remaining <= 24 * 3600 + 60,
                "reset link did not expire 24 hours after creation")
        token = reset_url.rstrip("/").rsplit("/", 1)[-1]
        _expect(bool(token), "reset URL omitted its token")
        state.update(reset_token=token, reset_expires=str(expires))
        return None

    def perform_reset():
        with invocation_context(step_id="S-042.5"):
            old_access, old_refresh = _login(base, member_email, member_password)
            reset = _request(base, "/auth/password/reset", method="POST",
                             body={"token": state["reset_token"], "newPassword": "NewMemberPass123!"})
            validate_case_response("S-042.5", 200, reset)
            old_status, _ = _response(base, "/auth/me", token=old_access)
            _expect(old_status == 401, "password reset did not revoke the member access session")
            status, _ = _response(base, "/auth/refresh/cli", method="POST",
                                  body={"refreshToken": old_refresh})
            _expect(status == 401, "password reset did not revoke the member refresh session")
            _login(base, member_email, "NewMemberPass123!")
        return None

    def replay_reset():
        status, value = _response(base, "/auth/password/reset", method="POST",
                                  body={"token": state["reset_token"], "newPassword": "NewMemberPass123!"})
        validate_case_response("S-042.6", status, value)
        return None

    journey.step("issue CLI password reset link", "auth.secured", reset_link, cases=["S-042.4"],
                 requires=("step:invite member with admin session",))
    journey.step("consume reset link and verify revoked sessions", "auth.secured", perform_reset,
                 cases=["S-042.5"], requires=("step:issue CLI password reset link",))
    journey.step("reject consumed password reset token", "auth.secured", replay_reset, cases=["S-042.6"],
                 requires=("step:issue CLI password reset link",))

    # Keep the secured CLI profile independent from the reset-link flow.
    def apply_isolated_platform():
        home = _journey_home(env)
        root = home / ".kb/s005-client"
        index = home / ".local/share/kb-create/release-index.json"
        sealed_index = json.loads(index.read_text(encoding="utf-8"))
        result = run_command([env.get("KB_JOURNEY_KB_CREATE_PATH", str(home / ".local/bin/kb-create")),
                              "apply", "--index", str(index), "--platform-root", str(root),
                              "--service-profile", "client", "--json"],
                             env=env, cwd=home, timeout=600)
        value = _json(result, "kb-create apply")
        actual = value.get("data", {}).get("receipt", {}).get("plan", {}).get("request", {}).get("platformRoot")
        validate_cli_case("S-005.1", result.returncode, result.stdout, value,
                          root=str(actual or ""), sealed_index=sealed_index)
        _expect(actual == str(root), "kb-create apply did not report the requested isolated platform root")
        state["client_cli"] = str(root / ".kb/v2/bin/kb")
        return None

    journey.step("apply isolated client platform", "auth.secured", apply_isolated_platform, cases=["S-005.1"])

    def member_login():
        result = run_command([state.get("client_cli", cli), "auth", "login", "--gateway-url", base,
                              "--email", member_email, "--password-stdin"],
                             env=env, input="NewMemberPass123!\n", timeout=90)
        validate_cli_case("S-005.2", result.returncode, result.stdout)
        session = SavedGatewaySession.from_status(_session_status(state.get("client_cli", cli), env), base).record
        state["client_access"] = store_report_secret(
            env, "KB_JOURNEY_CLIENT_ACCESS_TOKEN", session["accessToken"],
            "secured connection client access token")
        store_report_secret(env, "KB_JOURNEY_CLIENT_REFRESH_TOKEN", session["refreshToken"],
                            "secured connection client refresh token")
        return None

    def member_status():
        result = _cli(state.get("client_cli", cli), env, "auth", "status", "--json")
        value = _json(result, "kb auth status")
        validate_cli_case("S-005.3", result.returncode, result.stdout, value,
                          email=member_email, gateway=base)
        return None

    def member_permissions():
        response = _request(base, "/auth/permissions", token=state["client_access"])
        validate_case_response("S-005.4", 200, response)
        return None

    def member_users_denied():
        status, value = _response(base, "/auth/users", token=state["client_access"])
        validate_case_response("S-005.5", status, value)
        return None

    journey.step("member signs in to secured gateway", "auth.secured", member_login, cases=["S-005.2"],
                 requires=("step:apply isolated client platform",))
    journey.step("member auth status identifies gateway", "auth.secured", member_status, cases=["S-005.3"],
                 requires=("step:apply isolated client platform",))
    journey.step("member reads authorized permissions", "auth.secured", member_permissions, cases=["S-005.4"],
                 requires=("step:member signs in to secured gateway",))
    journey.step("member cannot read tenant users", "auth.secured", member_users_denied, cases=["S-005.5"],
                 requires=("step:member signs in to secured gateway",))

    def expired_status():
        with invocation_context(step_id="journey.setup"):
            _cli(cli, env, "auth", "login", "--gateway-url", base, "--email", admin_email,
                 "--password", admin_password)
        session = SavedGatewaySession.from_status(_session_status(cli, env), base)
        session.expire()
        result = _cli(cli, env, "auth", "status", "--json")
        value = _json(result, "kb auth status")
        validate_cli_case("S-031.1", result.returncode, result.stdout, value, gateway=base)
        return None

    def refresh_session():
        result = _cli(cli, env, "auth", "tokens")
        validate_cli_case("S-031.2", result.returncode, result.stdout)
        return None

    def revoked_session():
        session = SavedGatewaySession.from_status(_session_status(cli, env), base)
        with invocation_context(step_id="journey.setup"):
            _request(base, "/auth/logout/cli", method="POST",
                     body={"refreshToken": session.record["refreshToken"]})
        session.expire()
        with invocation_context(step_id="S-031.3"):
            result = _cli(cli, env, "auth", "tokens")
        output = result.stdout + result.stderr
        validate_cli_case("S-031.3", result.returncode, output)
        return None

    def removed_session():
        status = _session_status(cli, env)
        if gateway_session(status, base) is not None:
            SavedGatewaySession.from_status(status, base).remove()
        result = _cli(cli, env, "auth", "tokens")
        output = result.stdout + result.stderr
        validate_cli_case("S-031.4", result.returncode, output)
        return None

    journey.step("report expired saved CLI session", "auth.secured", expired_status, cases=["S-031.1"])
    journey.step("refresh expired CLI session", "auth.secured", refresh_session, cases=["S-031.2"])
    journey.step("report revoked CLI session", "auth.secured", revoked_session, cases=["S-031.3"])
    journey.step("report removed CLI session", "auth.secured", removed_session, cases=["S-031.4"])
