"""Helpers for setting up Studio browser coverage in an installed journey."""
from __future__ import annotations

from collections import deque
import json
import os
import re
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from invocations import (
    TimeoutExpired,
    decode_ux_error_result,
    decode_ux_success_result,
    invocation_link,
    open_http,
    print_report_text,
    read_ux_http_result,
    record_invocation,
    run_harness_command,
    run_streaming_command,
    store_report_secret,
    write_report_json,
    write_report_text,
)

PLAYWRIGHT_IMAGE_REBUILD_COMMAND = "e2e/journey/run.sh --no-build"


def create_studio_environment(service_env: dict[str, str], *, mode: str, project_id: str,
                              project_name: str, project_root: str, kb_bin: str) -> dict[str, str]:
    studio_env = service_env.copy()
    studio_env.update({
        "GATEWAY_URL": "http://127.0.0.1:4000",
        "KB_STUDIO_PROJECT_ID": project_id,
        "KB_STUDIO_PROJECT_NAME": project_name,
        "KB_ACCESS_MODE": mode,
        "KB_STUDIO_FRESH_HOST_JOURNEY": "1",
        "KB_STUDIO_FIRST_TIER_JOURNEY": "1",
        "KB_STUDIO_PROJECT_ROOT": project_root,
        "KB_STUDIO_KB_BIN": kb_bin,
    })
    if mode == "secured":
        if admin_email := service_env.get("KB_JOURNEY_ADMIN_EMAIL"):
            studio_env["KB_STUDIO_ADMIN_EMAIL"] = admin_email
        if admin_password := service_env.get("KB_JOURNEY_ADMIN_PASSWORD"):
            store_report_secret(studio_env, "KB_STUDIO_ADMIN_PASSWORD", admin_password,
                                "Studio browser admin password")
    return studio_env


def _playwright_browser_preflight(env: dict[str, str]) -> str | None:
    browsers_path = env.get("PLAYWRIGHT_BROWSERS_PATH")
    if not browsers_path:
        return ("PLAYWRIGHT_BROWSERS_PATH is not set; rebuild the runner image with "
                f"`{PLAYWRIGHT_IMAGE_REBUILD_COMMAND}`.")
    try:
        discovered = run_harness_command(
            ["node", "-e", "process.stdout.write(require('@playwright/test').chromium.executablePath())"])
    except OSError:
        discovered = None
    executable = Path(discovered.stdout) if discovered and discovered.returncode == 0 else None
    if (executable is None or not executable.is_file()
            or not executable.is_relative_to(Path(browsers_path))):
        location = str(executable) if executable else "Playwright did not report its Chromium executable"
        return (f"Playwright Chromium headless shell is missing at {location}; "
                f"rebuild the runner image with `{PLAYWRIGHT_IMAGE_REBUILD_COMMAND}`.")
    return None


def create_studio_member(base_url: str, admin_email: str, admin_password: str) -> tuple[str, str]:
    store_report_secret(os.environ, "KB_JOURNEY_ADMIN_PASSWORD", admin_password,
                        "Studio fixture admin password")
    def post(path: str, payload: dict, token: str = "") -> dict:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(
            f"{base_url}{path}", data=json.dumps(payload).encode(), headers=headers, method="POST")
        status, raw, _ = open_http(urllib.request.urlopen, request, timeout=20, env=os.environ)
        if status not in {200, 201}:
            raise RuntimeError(f"POST {path} returned HTTP {status}")
        envelope = read_ux_http_result(raw, status)
        return (decode_ux_success_result(envelope) if 200 <= status < 300
                else decode_ux_error_result(envelope))

    login = post("/auth/login/cli", {"email": admin_email, "password": admin_password})
    token = str(login.get("accessToken") or login.get("token") or "")
    if not token:
        raise RuntimeError("secured admin login returned no access token")
    store_report_secret(os.environ, "KB_JOURNEY_STUDIO_ACCESS_TOKEN", token,
                        "Studio fixture admin access token")
    invite = post("/auth/invites", {"email": "journey-member@example.test", "role": "member"}, token)
    activation_path = urllib.parse.urlparse(str(invite.get("activationUrl") or "")).path
    if "/activate/" not in activation_path:
        raise RuntimeError("member invite returned no Studio activation link")
    activation_token = activation_path.rsplit("/activate/", 1)[1]
    store_report_secret(os.environ, "KB_JOURNEY_STUDIO_INVITE_TOKEN", activation_token,
                        "Studio fixture activation token")
    member_password = "JourneyMember123!"
    post("/auth/activate", {"token": activation_token, "password": member_password})
    return "journey-member@example.test", member_password


def create_studio_access_tokens(base_url: str, admin_email: str, admin_password: str,
                                member_email: str, member_password: str,
                                *, env: dict[str, str]) -> tuple[str, str]:
    """Mint real admin and member API tokens for the settings authorization claim."""
    store_report_secret(env, "KB_JOURNEY_ADMIN_PASSWORD", admin_password,
                        "Studio settings admin password")
    store_report_secret(env, "KB_STUDIO_MEMBER_PASSWORD", member_password,
                        "Studio settings member password")
    def login(email: str, password: str) -> str:
        request = urllib.request.Request(
            f"{base_url}/auth/login/cli",
            data=json.dumps({"email": email, "password": password}).encode(),
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        status, raw, _ = open_http(urllib.request.urlopen, request, timeout=20, env=env)
        if status not in {200, 201}:
            raise RuntimeError(f"POST /auth/login/cli returned HTTP {status} while preparing Studio settings auth")
        envelope = read_ux_http_result(raw, status)
        payload = (decode_ux_success_result(envelope) if 200 <= status < 300
                   else decode_ux_error_result(envelope))
        token = payload.get("accessToken") or payload.get("token") if isinstance(payload, dict) else ""
        if not isinstance(token, str) or not token:
            raise RuntimeError("POST /auth/login/cli returned no access token while preparing Studio settings auth")
        return store_report_secret(env, "KB_JOURNEY_STUDIO_ACCESS_TOKEN", token,
                                  "Studio settings access token")

    return login(admin_email, admin_password), login(member_email, member_password)


def record_studio_browser_step(report: Path, mode: str, passed: bool, duration: float, message: str) -> None:
    status = "PASS" if passed else "FAIL"
    _record_step(report, mode, status, duration, message)


def studio_playwright_output_directory(report: Path) -> Path:
    """Return the run-specific writable artifact directory next to its report."""
    return report.with_name(f"{report.stem}-playwright-results")


def run_studio_browser_step(command: list[str], env: dict[str, str], report: Path,
                            mode: str, shell_passed: bool, timeout: int = 180, *,
                            cases: list[str] | None = None) -> tuple[bool, float, str]:
    if not shell_passed:
        message = "Playwright was not run because the Studio shell check failed"
        _record_step(report, mode, "BLOCKED", 0.0, message)
        return False, 0.0, message
    preflight_error = _playwright_browser_preflight(env)
    if not preflight_error and mode == "secured":
        required_credentials = (
            "KB_STUDIO_ADMIN_EMAIL", "KB_STUDIO_ADMIN_PASSWORD",
            "KB_STUDIO_MEMBER_EMAIL", "KB_STUDIO_MEMBER_PASSWORD",
        )
        missing_credentials = [key for key in required_credentials if not env.get(key)]
        if missing_credentials:
            preflight_error = (
                "secured admin-users Playwright setup did not provide "
                + ", ".join(missing_credentials)
                + "; complete the isolated admin and member setup before rerunning the secured journey"
            )
    if preflight_error:
        _record_step(report, mode, "FAIL", 0.0, preflight_error)
        return False, 0.0, preflight_error

    output_dir = Path(env.get(
        "KB_STUDIO_PLAYWRIGHT_OUTPUT_DIR",
        str(studio_playwright_output_directory(report)),
    ))
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(prefix=".write-check-", dir=output_dir):
            pass
    except OSError as error:
        message = (f"Playwright output directory {output_dir} is not writable to the journey runner: "
                   f"{error.strerror or error.__class__.__name__}; make the run report directory writable "
                   "and rerun the journey.")
        _record_step(report, mode, "FAIL", 0.0, message)
        return False, 0.0, message

    command = [*command, f"--output={output_dir}"]
    env = {**env, "KB_STUDIO_PLAYWRIGHT_OUTPUT_DIR": str(output_dir)}

    started = time.monotonic()
    output_lines: deque[str] = deque(maxlen=40)
    return_code: int | None = None
    invocation_error: str | None = None
    log_path = report.with_name(f"studio-playwright-{mode}.log")
    try:
        write_report_text(log_path, "", env=env)

        def copy_output(rendered: str) -> None:
            safe_line = write_report_text(log_path, rendered + "\n", env=env, append=True)
            output_lines.append(safe_line.rstrip("\r\n"))
            print_report_text(f"[studio-playwright] {safe_line.rstrip()}", env=env, flush=True)

        try:
            result, _duration = run_streaming_command(
                command, env=env, timeout=timeout, on_output_line=copy_output,
                start_new_session=True)
            return_code = result.returncode
        except TimeoutExpired as error:
            return_code = -1
            raise error
        elapsed = time.monotonic() - started
        passed = return_code == 0
        message = "Studio browser journey passed"
        if not passed:
            message = f"Playwright exited {return_code}" + _output_excerpt(output_lines)
    except TimeoutExpired:
        elapsed = time.monotonic() - started
        message = f"Playwright timed out after {timeout}s"
        message += _output_excerpt(output_lines)
        invocation_error = f"timed out after {timeout}s"
        passed = False
    except OSError as error:
        elapsed = time.monotonic() - started
        message = f"Playwright could not start: {error}"
        invocation_error = f"{error.__class__.__name__}: {error}"
        passed = False

    record_invocation(kind="command", argv=command, cwd=Path.cwd(), env=env,
                      exit_code=return_code, stdout="\n".join(output_lines),
                      duration_seconds=elapsed, error=invocation_error)
    evidence = invocation_link(",".join(cases or []))
    if not passed and evidence:
        message += f"; invocation evidence: {evidence}"

    _record_step(report, mode, "PASS" if passed else "FAIL", elapsed, message)
    _record_playwright_case_claims(report, env.get("KB_STUDIO_PLAYWRIGHT_JSON", ""))
    return passed, elapsed, message


def _output_excerpt(lines: deque[str]) -> str:
    if not lines:
        return ""
    return "\nLast Playwright output (up to 40 lines):\n" + "\n".join(lines)


def _signal_process_group(process_id: int, signum: int) -> None:
    try:
        os.killpg(process_id, signum)
    except ProcessLookupError:
        pass


def _record_step(report: Path, mode: str, status: str, duration: float, message: str) -> None:
    try:
        result = json.loads(report.read_text())
    except (OSError, json.JSONDecodeError):
        return
    _append_step(result, mode, status, duration, message)
    write_report_json(report, result)


def _record_playwright_case_claims(report: Path, json_report: str) -> None:
    if not json_report:
        return
    try:
        payload = json.loads(Path(json_report).read_text(encoding="utf-8"))
        result = json.loads(report.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    claims: dict[str, str] = {}

    def visit(suite: dict) -> None:
        for spec in suite.get("specs", []):
            title = str(spec.get("title", ""))
            ids = re.findall(r"@(S-\d{3}\.\d+)", title)
            tests = spec.get("tests", [])
            statuses = [res.get("status") for test in tests for res in test.get("results", [])]
            status = "PASS" if statuses and all(item == "passed" for item in statuses) else "FAIL"
            for case_id in ids:
                claims[case_id] = status
        for child in suite.get("suites", []):
            visit(child)

    for suite in payload.get("suites", []):
        visit(suite)
    if not claims:
        return
    case_run = result.setdefault("case_run", {})
    existing = {item.get("claimId"): item for item in case_run.get("claims", []) if isinstance(item, dict)}
    existing.update({case_id: {"claimId": case_id, "kind": "journey", "status": status}
                     for case_id, status in claims.items()})
    case_run["claims"] = [existing[key] for key in sorted(existing)]
    write_report_json(report, result)


def _append_step(result: dict, mode: str, status: str, duration: float, message: str) -> None:
    step = {
        "name": "Studio fresh-host browser journey",
        "capability": "studio",
        "mode": mode,
        "status": status,
        "duration_seconds": round(duration, 3),
        "message": message,
    }
    result.setdefault("steps", []).append(step)
    if status == "FAIL":
        result["status"] = "FAIL"
        result["first_failure"] = result.get("first_failure") or step
    elif status == "BLOCKED" and result.get("status") == "PASS":
        result["status"] = "BLOCKED"
