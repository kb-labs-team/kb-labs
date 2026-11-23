from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import unittest
from pathlib import Path
from unittest.mock import patch

from test_environment import isolated_environment, stage_cli_root

sys.path.insert(0, str(Path(__file__).parent))
import steps.auth as auth_steps
from steps.accounts import run_cli_logout_steps
from steps.auth import (assert_platform_auth_required, run_bootstrap_recovery_steps, run_cli_auth_forbidden,
                        run_cli_auth_status, assert_cli_session_absent, run_cli_corrupt_session_file,
                        assert_machine_registration_requires_auth)
from invocations import catalogued_error_hint, run_pty_command

REAL_PROCESS_TIMEOUT_SECONDS = 60


class CliAuthJourneyTests(unittest.TestCase):
    def test_auth_required_hint_comes_from_the_catalogue_template(self):
        hint = catalogued_error_hint("KB_AUTH_REQUIRED", gatewayUrl="http://gateway.test")
        self.assertIn("http://gateway.test", hint)
        self.assertNotIn("{gatewayUrl}", hint)

    # case: S-104.6
    def test_human_signup_attempt_keeps_401_and_returns_canonical_auth_envelope(self):
        result = subprocess.CompletedProcess(
            ["POST", "/auth/register"], 0,
            json.dumps({"ok": False, "error": {
                "code": "KB_AUTH_REQUIRED",
                "message": "Authentication is required.",
                "hint": catalogued_error_hint("KB_AUTH_REQUIRED", gatewayUrl="http://gateway.test"),
            }}), "",
        )
        with patch("steps.auth.open_http", return_value=(401, result.stdout.encode(), {})) as request:
            assert_machine_registration_requires_auth("http://gateway.test")

        sent_request = request.call_args.args[1]
        self.assertEqual(sent_request.full_url, "http://gateway.test/auth/register")
        self.assertEqual(sent_request.get_method(), "POST")
        self.assertEqual(json.loads(sent_request.data), {
            "name": "new-member", "email": "new-member@example.test", "password": "HumanPass123!",
        })

    # case: S-041.6, S-100.1
    def test_real_tty_password_prompt_never_echoes_password(self):
        class GatewayHandler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.dumps({"ok": True, "data": {
                    "accessToken": "access", "refreshToken": "refresh", "expiresIn": 900,
                }}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                body = json.dumps({"ok": True, "data": {"email": "member@example.test", "tenantId": "test"}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, _format, *_args):
                return

        gateway = HTTPServer(("127.0.0.1", 0), GatewayHandler)
        thread = threading.Thread(target=gateway.serve_forever, daemon=True)
        thread.start()
        root = Path(__file__).resolve().parents[2]
        password = "TtyPassword123!"
        session_created = False
        with tempfile.TemporaryDirectory(prefix="auth-pty-home-") as home:
            fixture_bin = Path(home) / "bin"
            fixture_bin.mkdir()
            env = isolated_environment(Path(home), fixture_bin, required_tools=("node",))
            node_binary = Path(env["PATH"].split(os.pathsep)[1]) / "node"
            node_version = subprocess.run([str(node_binary), "-p", "process.version"], env=env,
                                           capture_output=True, text=True, check=True).stdout.strip()
            cli_root = stage_cli_root(root, Path(home) / "platform")
            sent = False

            def answer_password(transcript: str) -> str | None:
                nonlocal sent
                if sent or "Password: " not in transcript:
                    return None
                sent = True
                return password + "\n"

            try:
                completed, _ = run_pty_command(
                    [str(node_binary), str(cli_root / "cli/bin/dist/bin.js"), "auth", "login", "--gateway-url",
                     f"http://127.0.0.1:{gateway.server_port}", "--email", "member@example.test"],
                    cwd=cli_root, env=env, timeout=REAL_PROCESS_TIMEOUT_SECONDS, on_output=answer_password,
                )
            finally:
                gateway.shutdown()
                gateway.server_close()
                thread.join(timeout=2)
            session_created = (Path(home) / ".kb" / "session.json").is_file()
        output = completed.stdout
        self.assertTrue(sent, f"TTY login under {node_binary} ({node_version}) did not show its password prompt: {output!r}")
        self.assertEqual(completed.returncode, 0, output)
        self.assertNotIn(password, output)
        self.assertTrue(session_created)

    # case: S-041.7, S-041.17
    def test_cli_gate_requires_the_complete_case_error_envelope(self):
        result = subprocess.CompletedProcess(
            ["kb", "config", "show", "--json"], 1,
            json.dumps({"ok": False, "error": {
                "code": "KB_AUTH_REQUIRED",
                "message": "Authentication is required.",
                "hint": catalogued_error_hint("KB_AUTH_REQUIRED", gatewayUrl="<url>"),
            }}), "",
        )
        assert_platform_auth_required(result, ["config", "show", "--json"])

        for error in (
            {"code": "KB_AUTH_REQUIRED", "message": "Different message.", "hint": catalogued_error_hint("KB_AUTH_REQUIRED", gatewayUrl="<url>")},
            {"code": "KB_AUTH_REQUIRED", "message": "Authentication is required.", "hint": "Different hint."},
            {"code": "OTHER_ERROR", "message": "Authentication is required.", "hint": catalogued_error_hint("KB_AUTH_REQUIRED", gatewayUrl="<url>")},
        ):
            malformed = subprocess.CompletedProcess(
                ["kb", "config", "show", "--json"], 1,
                json.dumps({"ok": False, "error": error}), "",
            )
            with self.subTest(error=error), self.assertRaises(AssertionError):
                assert_platform_auth_required(malformed, ["config", "show", "--json"])

    # case: S-041.18
    def test_corrupt_saved_session_uses_a_disposable_home_and_requires_repair_envelope(self):
        homes = []

        def invoke(args, *, env, **_kwargs):
            home = Path(env["HOME"])
            homes.append(home)
            if args[1:3] == ["auth", "status"]:
                return subprocess.CompletedProcess(args, 0, json.dumps({"ok": True, "data": {
                    "session": {"authenticated": False, "path": str(home / ".kb" / "session.json")},
                }}), "")
            self.assertEqual(args, ["/isolated/bin/kb", "config", "show", "--json"])
            self.assertEqual((home / ".kb" / "session.json").read_text(encoding="utf-8"), "{ invalid json")
            self.assertNotIn("KB_PLATFORM_ROOT", env)
            self.assertNotIn("KB_HOME", env)
            self.assertNotIn("KB_NET_OFFSET", env)
            payload = {"ok": False, "error": {
                "code": "KB_CONFIG_INVALID",
                "message": "Saved authentication file .kb/session.json is invalid.",
                "hint": 'Run "kb auth login" to replace the saved authentication data, then retry the command.',
                "details": {"path": ".kb/session.json", "reason": "invalid"},
            }}
            return subprocess.CompletedProcess(args, 1, json.dumps(payload), "")

        with patch("steps.auth.run_command", side_effect=invoke):
            run_cli_corrupt_session_file("/isolated/bin/kb", {})

        self.assertEqual(len(homes), 2)
        self.assertFalse(homes[0].exists())

    # case: S-041.7, S-041.8
    def test_anonymous_auth_status_is_verified_through_the_cli_product(self):
        result = subprocess.CompletedProcess(
            ["kb", "auth", "status", "--json"], 0,
            json.dumps({"ok": True, "data": {"authenticated": False, "session": {"authenticated": False}}}), "",
        )
        assert_cli_session_absent(result)

        authenticated = subprocess.CompletedProcess(
            ["kb", "auth", "status", "--json"], 0,
            json.dumps({"ok": True, "data": {"authenticated": True, "session": {"authenticated": True}}}), "",
        )
        with self.assertRaisesRegex(AssertionError, "session is authenticated"):
            assert_cli_session_absent(authenticated)

    # case: S-041.5, S-041.6, S-100.1
    def test_local_status_and_secured_login_status_tokens_commands(self):
        calls: list[list[str]] = []

        def invoke(args, *, env, **kwargs):
            calls.append(args)
            if args[1:3] == ["auth", "status"]:
                payload = {"ok": True, "data": {"sessions": [{"authenticated": bool(state["email"]),
                                                               "path": str(Path(env["HOME"]) / ".kb" / "session.json"),
                                                               **({"email": state["email"], "gatewayUrl": "http://gateway.test"} if state["email"] else {})}]}}
            elif args[1:3] == ["auth", "login"]:
                if "--password-stdin" not in args:
                    message = "The provided input is invalid. [KB_RUNTIME_INPUT_INVALID]"
                    cause = "The password prompt requires an interactive terminal."
                    hint = "cat password.txt | kb auth login --gateway-url 'http://gateway.test' --email 'member@example.test' --password-stdin"
                    return subprocess.CompletedProcess(args, 2, "", f"{message}\nCause: {cause}\nHint: {hint}\n")
                self.assertEqual(kwargs.get("input"), "MemberPass123!\n")
                state["email"] = "member@example.test"
                session_path = Path(env["HOME"]) / ".kb" / "session.json"
                session_path.parent.mkdir(parents=True, exist_ok=True)
                session_path.write_text("{}", encoding="utf-8")
                return subprocess.CompletedProcess(args, 0, "Authenticated\n", "")
            elif args[1:3] == ["auth", "tokens"]:
                payload = {"ok": True, "data": {"tokens": []}}
            else:
                raise AssertionError(args)
            return subprocess.CompletedProcess(args, 0, json.dumps(payload), "")

        state = {"email": None}
        with tempfile.TemporaryDirectory(prefix="auth-status-home-") as home:
            env = {"HOME": home}
            with patch("invocations.subprocess.run", side_effect=invoke):
                old_run_pty = auth_steps.run_pty_command

                def run_pty(command, *, env, timeout, on_output):
                    transcript = "Password: \nAuthenticated\n"
                    on_output(transcript)
                    return subprocess.CompletedProcess(command, 0, transcript, ""), 0.0

                auth_steps.run_pty_command = run_pty
                try:
                    run_cli_auth_status("/isolated/bin/kb", env, authenticated=False)
                    state["email"] = None
                    run_cli_auth_status("/isolated/bin/kb", env, authenticated=True,
                                        email="member@example.test", password="MemberPass123!",
                                        base_url="http://gateway.test")
                finally:
                    auth_steps.run_pty_command = old_run_pty

        self.assertEqual(calls[0], ["/isolated/bin/kb", "auth", "status", "--json"])
        self.assertIn(["/isolated/bin/kb", "auth", "login", "--gateway-url", "http://gateway.test",
                       "--email", "member@example.test"], calls)
        self.assertIn(["/isolated/bin/kb", "auth", "login", "--gateway-url", "http://gateway.test",
                       "--email", "member@example.test", "--password-stdin"], calls)
        self.assertIn(["/isolated/bin/kb", "auth", "tokens", "--json"], calls)

    # case: S-041.9
    def test_member_reset_link_requires_admin_permission(self):
        args = ["/isolated/bin/kb", "auth", "reset-link", "--user-id", "member-1", "--json"]
        response = {"ok": False, "error": {
            "code": "KB_AUTH_FORBIDDEN", "details": {"permission": "users:write"},
            "message": "Permission denied.",
        }}
        with patch("invocations.subprocess.run", return_value=subprocess.CompletedProcess(
                args, 1, json.dumps(response), "")) as invoke:
            run_cli_auth_forbidden("/isolated/bin/kb", {"HOME": "/isolated"})
        self.assertEqual(invoke.call_args.args[0], args)

    # case: S-100.2, S-100.3, S-100.4
    def test_bootstrap_recovery_uses_stopped_host_command_and_checks_running_guard(self):
        commands = []
        doctor_calls = 0
        recovered_passwords = []

        def invoke(args, *, env, input_text=None):
            nonlocal doctor_calls
            commands.append((args, input_text))
            if args[1] == "doctor":
                self.assertNotIn("KB_PROJECT_ID", env)
                self.assertNotIn("KB_PROJECT_ROOT", env)
                self.assertEqual(args[args.index("--platform-root") + 1], "/isolated/platform")
            if args[1] == "doctor":
                doctor_calls += 1
            if args[1] == "doctor" and doctor_calls == 2:
                return subprocess.CompletedProcess(args, 1,
                    'KB_INSTALL_RECOVERY_HOST_RUNNING: Recovery needs the host to be stopped. Next: Run "kb-create stop", recover, then "kb-create start".', ""), 0.0
            return subprocess.CompletedProcess(args, 0, "done", ""), 0.0

        with patch("steps.auth._login", return_value=("new-access-token-for-journey", "new-refresh-token-for-journey")), \
             patch("steps.auth._request", side_effect=[{"accessToken": "old-access-token-for-journey"}, {"tenantId": "tenant-1"},
                 {"email": "admin@example.test", "tenantId": "tenant-1"}]):
            run_bootstrap_recovery_steps("/bin/kb-create", "/isolated/platform", "admin@example.test",
                                         "OldPass123!", "NewPass123!", {"HOME": "/isolated"}, invoke,
                                         on_valid_password=recovered_passwords.append)

        recover = [args for args, _ in commands if "--recover" in args]
        self.assertEqual(len(recover), 2)
        self.assertIn("--platform-root", recover[0])
        self.assertIn("--password-stdin", recover[0])
        self.assertIn("--yes", recover[0])
        self.assertIn((recover[0], "NewPass123!\n"), commands)
        self.assertEqual(recovered_passwords, ["NewPass123!"])

    # case: S-100.2, S-100.3
    def test_failed_bootstrap_recovery_restarts_host_without_adopting_password(self):
        commands = []
        recovered_passwords = []

        def invoke(args, *, env, input_text=None):
            commands.append(args)
            if args[1] == "doctor":
                return subprocess.CompletedProcess(args, 1, "recovery failed", ""), 0.0
            return subprocess.CompletedProcess(args, 0, "done", ""), 0.0

        with patch("steps.auth._login", side_effect=[AssertionError("invalid credentials"),
                                                      ("old-access-token-for-journey", "old-refresh-token-for-journey")]), \
             patch("steps.auth._request", side_effect=[{"accessToken": "old-access-token-for-journey"}, {"tenantId": "tenant-1"},
                                                        {"email": "admin@example.test", "tenantId": "tenant-1"}]), \
             self.assertRaisesRegex(AssertionError, "recovery failed"):
            run_bootstrap_recovery_steps("/bin/kb-create", "/isolated/platform", "admin@example.test",
                                         "OldPass123!", "NewPass123!", {"HOME": "/isolated"}, invoke,
                                         on_valid_password=recovered_passwords.append)

        self.assertIn(["/bin/kb-create", "start", "--platform-root", "/isolated/platform"], commands)
        self.assertEqual(recovered_passwords, ["OldPass123!"])

    # case: S-100.2, S-100.3
    def test_echoed_recovery_password_fails_step_but_keeps_verified_credentials(self):
        commands = []
        recovered_passwords = []

        def invoke(args, *, env, input_text=None):
            commands.append(args)
            output = "NewPass123!" if args[1] == "doctor" else "done"
            return subprocess.CompletedProcess(args, 0, output, ""), 0.0

        with patch("steps.auth._login", return_value=("new-access-token-for-journey", "new-refresh-token-for-journey")), \
             patch("steps.auth._request", side_effect=[{"accessToken": "old-access-token-for-journey"}, {"tenantId": "tenant-1"},
                                                        {"email": "admin@example.test", "tenantId": "tenant-1"}]), \
             self.assertRaisesRegex(AssertionError, "echoed the supplied password"):
            run_bootstrap_recovery_steps("/bin/kb-create", "/isolated/platform", "admin@example.test",
                                         "OldPass123!", "NewPass123!", {"HOME": "/isolated"}, invoke,
                                         on_valid_password=recovered_passwords.append)

        self.assertEqual(recovered_passwords, ["NewPass123!"])
        self.assertIn(["/bin/kb-create", "start", "--platform-root", "/isolated/platform"], commands)

    # case: S-102.3
    def test_cli_logout_removes_session_and_status_reports_unauthenticated(self):
        commands = []

        def invoke(args, **kwargs):
            commands.append(args)
            if args[1:3] == ["auth", "login"]:
                self.assertEqual(kwargs.get("input"), "AdminPass123!\n")
                payload = {"ok": True, "data": {"email": "admin@example.test", "gatewayUrl": "http://gateway.test"}}
                return subprocess.CompletedProcess(args, 0, json.dumps(payload), "")
            payload = {"ok": True, "data": {"message": "Logged out. Credentials removed."}} if args[2] == "logout" else {
                "ok": True, "data": {"session": {"authenticated": False}}}
            return subprocess.CompletedProcess(args, 0, json.dumps(payload), "")

        with patch("steps.accounts.run_command", side_effect=invoke):
            run_cli_logout_steps("/isolated/bin/kb", {"HOME": "/isolated", "KB_JOURNEY_ADMIN_EMAIL": "admin@example.test",
                                                        "KB_JOURNEY_ADMIN_PASSWORD": "AdminPass123!",
                                                        "KB_JOURNEY_BASE_URL": "http://gateway.test"})
        self.assertEqual(commands, [["/isolated/bin/kb", "auth", "login", "--gateway-url", "http://gateway.test",
                                     "--email", "admin@example.test", "--password-stdin", "--json"],
                                    ["/isolated/bin/kb", "auth", "logout", "--json"],
                                    ["/isolated/bin/kb", "auth", "status", "--json"]])


if __name__ == "__main__":
    unittest.main()
