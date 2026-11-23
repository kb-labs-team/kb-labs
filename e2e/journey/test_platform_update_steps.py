from __future__ import annotations

import json
import hashlib
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from journey_resources import _platform_layout, shared_runtime_file_fingerprints
from platform_update_steps import (_assert_outside_install_unchanged, _outside_install_changes,
                                   _outside_install_snapshot, run_platform_update_steps)
from journey_selection import read_journey_selection
from service_steps import FlowGraph, Journey


class PlatformUpdateStepsTest(unittest.TestCase):
    def expected_platform_user_config(self) -> bytes:
        return (json.dumps({"stable": True, "platform": {"adapterOptions": {
            "storage": {"baseDir": "case-storage"},
        }}}) + "\n").encode()

    def test_outside_install_snapshot_reports_added_changed_and_removed_paths(self):
        before = {"/home/user/.local/share/kb-create/index.json": "sha256:old",
                  "/home/user/.local/bin/kb": "symlink:../old/kb",
                  "/home/user/unchanged": "same"}
        after = {"/home/user/.local/share/kb-create/index.json": "sha256:new",
                 "/home/user/added": "sha256:new",
                 "/home/user/unchanged": "same"}

        self.assertEqual(_outside_install_changes(before, after), [
            {"path": "/home/user/.local/bin/kb", "before": "symlink:../old/kb", "after": None},
            {"path": "/home/user/.local/share/kb-create/index.json", "before": "sha256:old", "after": "sha256:new"},
            {"path": "/home/user/added", "before": None, "after": "sha256:new"},
        ])

    def test_outside_install_diagnostic_includes_shim_identity_before_and_after(self):
        home = Path(self.temp.name) / "home"
        root = home / "kb-platform"
        root.mkdir(parents=True)
        shim = home / ".local" / "bin" / "kb"
        shim.parent.mkdir(parents=True)
        shim.symlink_to("../../kb-platform/current/.kb/v2/bin/kb")
        before = _outside_install_snapshot(root)
        shim.unlink()

        with self.assertRaisesRegex(RuntimeError, r"\.local/bin/kb \(before=symlink:.*current.*; after=<absent>\)"):
            _assert_outside_install_unchanged(root, before, "update")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="journey-update-test-")
        self.root = Path(self.temp.name) / "install"
        self.version_root = self.root / "versions" / "3.0.0"
        (self.version_root / ".kb/v2").mkdir(parents=True)
        (self.version_root / ".kb/kb.config.jsonc").write_text('{"stable":true}\n')
        (self.root / "versions").mkdir(parents=True, exist_ok=True)
        (self.root / "state").mkdir(parents=True, exist_ok=True)
        self.state_file = self.root / "state" / "opaque-runtime-state.bin"
        self.state_file.write_bytes(b"fixture state")
        self.shared_file_projection_paths = [
            self.root / projection["statePath"]
            for projection in _platform_layout()["sharedRuntimePaths"]
            if projection.get("kind") == "file"
        ]
        for index, path in enumerate(self.shared_file_projection_paths):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(f"shared-file-{index}".encode())
        self.secret_values = {"gateway.jwtSecret": "install-secret"}
        (self.version_root / ".kb/marketplace.lock").write_text('{"plugins":[]}\n')
        self.root.joinpath("current").symlink_to(Path("versions") / "3.0.0")
        self.config = self.root / "current/.kb/kb.config.jsonc"
        self.receipt = self.root / "current/.kb/v2/receipt.json"
        self.update_index = self.root / "update-index.json"
        self.update_index.write_text(json.dumps({"platforms": [{"version": "3.0.1", "releaseNotes": "Patch notes."}]}))
        self._write_receipt("3.0.0")
        self.commands: list[list[str]] = []
        self.user_checks = 0
        self.project_user_checks: list[int] = []
        self.running_version = "3.0.0"
        self.pending_restart = None
        parent = Journey("local", "update-step-test-parent")
        parent.step("candidate provenance", "journey.orchestration", lambda: None)
        parent.step("launcher version", "platform.install", lambda: None)
        graph = FlowGraph(parent, {})
        graph.flow("start platform host", "host", "platform.host",
                   lambda: parent.step("start host", "platform.host", lambda: None))
        graph.probe_state("project-registered", "project", "kb project show/list", lambda: None,
                          value=lambda: {"id": "prj_update_test", "root": str(self.root)})
        self.parent_journey = parent

    def test_shared_file_projection_fingerprints_are_opaque_and_change_with_bytes(self):
        before = shared_runtime_file_fingerprints(self.root)
        self.assertEqual(len(before), len(self.shared_file_projection_paths))
        self.shared_file_projection_paths[0].write_bytes(b"changed file bytes")
        after = shared_runtime_file_fingerprints(self.root)
        self.assertNotEqual(before, after)

    def tearDown(self):
        self.temp.cleanup()

    def test_secured_update_registers_nonpass_scan_when_bootstrap_password_is_missing(self):
        from unittest.mock import patch

        with patch.dict(os.environ, {
                "KB_JOURNEY_SELECTED_STEPS": "S-100.1,S-023.1,S-023.2,S-023.3,S-023.4,S-023.5,S-023.6,S-023.8,S-024.2,S-024.3,S-024.4",
                "KB_JOURNEY_PREREQUISITE_STEPS": json.dumps([
                    "candidate provenance", "launcher version", "start host",
                ]),
                "KB_JOURNEY_PREREQUISITE_FLOWS": json.dumps(["start platform host"]),
                "KB_JOURNEY_NEEDED_STATES": "project-registered",
                "KB_JOURNEY_RUNNER_SELECTOR": "service-secured:explore",
        }, clear=False):
            parent = Journey("local", "update-step-test-parent", selection=read_journey_selection(os.environ))
            parent.step("candidate provenance", "journey.orchestration", lambda: None)
            parent.step("launcher version", "platform.install", lambda: None)
            graph = FlowGraph(parent, {})
            graph.flow("start platform host", "host", "platform.host",
                       lambda: parent.step("start host", "platform.host", lambda: None))
            graph.probe_state("project-registered", "project", "kb project show/list", lambda: None,
                              value=lambda: {"id": "prj_update_test", "root": str(self.root)})
            journey = run_platform_update_steps(
                mode="secured", launcher="kb-create", kb_binary="kb",
                platform_root=self.root, update_index=self.update_index,
                request_file=self.root / "request.json", base_version="3.0.0",
                updated_version="3.0.1", bootstrap_password=None, run_command=self.fake_kb,
                parent_journey=parent,
            )

        scan = next((step for step in journey.steps
                     if step.name == "verify disclosed bootstrap credential absent after update and rollback"), None)
        self.assertIsNotNone(scan, "selected S-100.1 scan must be registered without a password")
        self.assertEqual(scan.status, "BLOCKED", scan.message)
        self.assertIn("bootstrap password was unavailable", scan.message)
        self.assertNotIn("journey-bootstrap-secret-sentinel", scan.message)

    def _write_receipt(self, version: str):
        self.receipt.write_text(json.dumps({
            "installationId": "installation-stable-1",
            "plan": self._plan(version),
            "verification": {"configSha256": hashlib.sha256(self.config.read_bytes()).hexdigest(),
                             "hostHealthUrl": "http://127.0.0.1:4100/health"},
        }))

    def _plan(self, version: str) -> dict:
        return {
            "serviceGraph": {"platformVersion": version, "services": [
                {"id": "gateway", "port": 4100}, {"id": "marketplace", "port": 5170},
            ]},
            "configPatches": [{"path": "/platform/adapterOptions", "json": json.dumps({
                "serviceTransport": {"services": {
                    "gateway": {"url": "http://127.0.0.1:4100"},
                    "marketplace": {"url": "http://127.0.0.1:5170"},
                }},
            })}],
            "planHash": "resolved-plan-hash",
        }

    def fake_kb(self, args: list[str]) -> subprocess.CompletedProcess:
        self.commands.append(args)
        stdout = ""
        code = 0
        if args[1] == "config":
            value = json.loads(self.config.read_text())
            value.setdefault("platform", {}).setdefault("adapterOptions", {})["storage"] = {
                "baseDir": "case-storage",
            }
            self.config.write_text(json.dumps(value) + "\n")
            stdout = json.dumps({"ok": True, "file": str(self.config), "value": value})
        elif args[1] == "plan":
            stdout = json.dumps({"ok": True, "plan": self._plan("3.0.1"), "updateSummary": {
                "components": [{"id": "platform", "package": "@kb/platform", "fromVersion": "3.0.0", "toVersion": "3.0.1"}],
                "addedPackages": ["@kb/new"], "removedPackages": ["@kb/old"], "downloadBytes": 1234,
                "releaseNotes": [{"version": "3.0.1", "notes": "Patch notes."}],
            }})
        elif args[1] == "update":
            if "--secret-env" in args:
                mapping = args[args.index("--secret-env") + 1]
                secret, _, env_name = mapping.partition("=")
                if os.environ.get(env_name, "") != self.secret_values.get(secret):
                    stdout = json.dumps({"ok": False, "error": {"code": "KB_UPDATE_SECRET_REFUSED",
                                                                      "message": "update secret refused",
                                                                      "hint": (f'Set the environment variable to the intended secret, then run `kb-create stop --platform-root "{self.root}" && '
                                                                              f'kb-create apply --platform-root "{self.root}" --index "{args[args.index("--index") + 1]}" '
                                                                              f'--input "{args[args.index("--input") + 1]}" --secret-env "{secret}={env_name}"`.')}})
                    return subprocess.CompletedProcess(args, 1, stdout, "")
            update_count = sum(command[1] == "update" for command in self.commands)
            if json.loads(self.receipt.read_text())["plan"]["serviceGraph"]["platformVersion"] == "3.0.1":
                if "--json" not in args:
                    stdout = "Platform is already up to date.\n"
                    return subprocess.CompletedProcess(args, 0, stdout, "")
                stdout = json.dumps({"ok": True, "alreadyUpToDate": True,
                                     "receipt": {"plan": self._plan("3.0.1")},
                                     "hostRestarted": False})
            else:
                self._write_receipt("3.0.1")
                self.pending_restart = {"services": [{"id": "gateway", "runningVersion": "3.0.0"}],
                                        "installedVersion": "3.0.1",
                                        "command": "kb-create restart --platform-root ROOT"}
                if "--json" not in args:
                    stdout = "Platform update completed.\n"
                    return subprocess.CompletedProcess(args, 0, stdout, "")
                stdout = json.dumps({"ok": True, "receipt": {"plan": self._plan("3.0.1")},
                                     "snapshot": {"id": f"snapshot-{update_count}"},
                                     "pendingRestart": self.pending_restart,
                                     "hostRestarted": False, "logPath": "/logs/update.log",
                                     "updateSummary": {
                                         "components": [{"id": "platform", "package": "@kb/platform",
                                                         "fromVersion": "3.0.0", "toVersion": "3.0.1"}],
                                         "releaseNotes": [{"version": "3.0.1", "notes": "Patch notes."}],
                                     }})
        elif args[1] == "stop":
            self.running_version = "stopped"
            stdout = json.dumps({"ok": True, "running": False})
        elif args[1] == "start":
            self.running_version = "3.0.1"
            stdout = json.dumps({"ok": True, "running": True})
        elif args[1] == "apply":
            if self.running_version != "stopped":
                code = 1
                stdout = json.dumps({"ok": False, "error": {"code": "KB_HOST_ALREADY_RUNNING",
                                                                  "message": "The KB Labs host is already running."}})
                return subprocess.CompletedProcess(args, code, stdout, "")
            secret_mapping = args[args.index("--secret-env") + 1]
            secret, _, env_name = secret_mapping.partition("=")
            self.secret_values[secret] = os.environ[env_name]
            self._write_receipt("3.0.1")
            self.running_version = "3.0.1"
            self.pending_restart = None
            stdout = json.dumps({"ok": True, "operation": "apply"})
        elif args[1] == "rollback":
            if "missing-journey-snapshot" in args:
                stdout = json.dumps({"ok": False, "error": {"code": "KB_UPDATE_NO_SNAPSHOT", "message": "Snapshot is unknown.", "hint": "restore a named snapshot", "correlationId": "c-missing"}})
                code = 1
            else:
                self._write_receipt("3.0.0")
                self.running_version = "3.0.0"
                if "--json" not in args:
                    return subprocess.CompletedProcess(args, 0, "Platform rollback completed.\n", "")
                stdout = json.dumps({"ok": True, "snapshot": {"id": "snapshot-1"},
                                     "hostRestarted": True, "logPath": "/logs/rollback.log"})
        elif args[1] == "status":
            installed = json.loads(self.receipt.read_text())["plan"]["serviceGraph"]["platformVersion"]
            if "--json" not in args:
                pending = self.pending_restart
                if pending is None:
                    stdout = "Installed: true\nRunning: true\n"
                else:
                    service = pending["services"][0]
                    stdout = (f"Installed: true\nRunning: true\nPending restart: {service['id']} "
                              f"(running {service['runningVersion']}); installed {pending['installedVersion']}. "
                              f"Run {pending['command']}\n")
                return subprocess.CompletedProcess(args, 0, stdout, "")
            stdout = json.dumps({"ok": True, "running": True, "reachable": True,
                                 "runningVersion": self.running_version, "installedVersion": installed,
                                 "pendingRestart": self.pending_restart if self.running_version != installed else None})
        elif args[1] == "restart":
            self.running_version = json.loads(self.receipt.read_text())["plan"]["serviceGraph"]["platformVersion"]
            self.pending_restart = None
            stdout = json.dumps({"ok": True, "operation": "restart", "host": {"pid": 1234},
                                 "runningVersion": self.running_version})
        elif args[1] == "doctor":
            pending = self.pending_restart if self.running_version != json.loads(self.receipt.read_text())["plan"]["serviceGraph"]["platformVersion"] else None
            if "--json" not in args:
                if pending is None:
                    stdout = "Platform diagnosis completed.\nStatus: healthy\n"
                else:
                    service = pending["services"][0]
                    stdout = (f"Platform diagnosis completed.\nStatus: healthy\nPending restart: {service['id']} "
                              f"(running {service['runningVersion']}); installed {pending['installedVersion']}. "
                              f"Run {pending['command']}\n")
                return subprocess.CompletedProcess(args, 0, stdout, "")
            stdout = json.dumps({"ok": True, "platform": {"ok": True}, "pendingRestart": pending})
        elif args[1] == "adapter":
            stdout = json.dumps({"ok": True, "adapters": []})
        elif args[1] == "project":
            self.project_user_checks.append(self.user_checks)
            stdout = json.dumps({"ok": True, "projects": [], "total": 0})
        else:
            code = 2
            stdout = "unexpected fake command"
        if stdout:
            decoded = json.loads(stdout) if stdout.startswith("{") else None
            if isinstance(decoded, dict) and decoded.get("ok") is True and "data" not in decoded:
                decoded = {"ok": True, "data": {key: value for key, value in decoded.items() if key != "ok"}}
                stdout = json.dumps(decoded)
        return subprocess.CompletedProcess(args, code, stdout, "")

    def test_s023_3_requires_update_summary(self):
        def omit_summary(args: list[str]) -> subprocess.CompletedProcess:
            result = self.fake_kb(args)
            if args[1] == "update" and "--json" in args:
                payload = json.loads(result.stdout)
                result_payload = payload.get("data", payload)
                result_payload.pop("updateSummary", None)
                return subprocess.CompletedProcess(args, result.returncode, json.dumps(payload), result.stderr)
            return result

        result = run_platform_update_steps(
            mode="local", launcher="kb-create", kb_binary="kb", platform_root=self.root,
            parent_journey=self.parent_journey,
            update_index=self.update_index, request_file=self.root / "request.json",
            base_version="3.0.0", updated_version="3.0.1", run_command=omit_summary,
        )
        step = next(step for step in result.result().steps if "S-023.3" in step["cases"])
        self.assertEqual(step["status"], "FAIL")
        self.assertIn("omitted its component and release-note summary", step["message"])

    def test_s023_4_fails_when_a_shared_file_projection_changes_during_update(self):
        def mutate_shared_file(args: list[str]) -> subprocess.CompletedProcess:
            result = self.fake_kb(args)
            updates = sum(command[1] == "update" and "--json" in command for command in self.commands)
            if args[1] == "update" and "--json" in args and updates == 1:
                self.shared_file_projection_paths[0].write_bytes(b"changed during update")
            return result

        journey = run_platform_update_steps(
            mode="local", launcher="kb-create", kb_binary="kb", platform_root=self.root,
            parent_journey=self.parent_journey, update_index=self.update_index,
            request_file=self.root / "request.json", base_version="3.0.0",
            updated_version="3.0.1", run_command=mutate_shared_file,
        )
        step = next(step for step in journey.result().steps
                    if step["name"] == "stage update and leave the running host on its current version")
        self.assertEqual(step["status"], "FAIL")
        self.assertIn("shared-state file fingerprints changed at successful update before restart", step["message"])

    def test_s023_6_requires_receipt_bytes_unchanged(self):
        def rewrite_repeat_receipt(args: list[str]) -> subprocess.CompletedProcess:
            result = self.fake_kb(args)
            if args[1] == "update" and "--json" in args:
                update_calls = sum(command[1] == "update" and "--json" in command for command in self.commands)
                if update_calls == 2:
                    self.receipt.write_text(json.dumps(json.loads(self.receipt.read_text()), indent=2))
            return result

        result = run_platform_update_steps(
            mode="local", launcher="kb-create", kb_binary="kb", platform_root=self.root,
            parent_journey=self.parent_journey,
            update_index=self.update_index, request_file=self.root / "request.json",
            base_version="3.0.0", updated_version="3.0.1", run_command=rewrite_repeat_receipt,
        )
        step = next(step for step in result.result().steps if "S-023.6" in step["cases"])
        self.assertEqual(step["status"], "FAIL")
        self.assertIn("changed the installed receipt bytes", step["message"])

    def test_update_rollback_preserves_the_saved_user_session(self):
        original_state = self.state_file.read_bytes()
        def verify_user():
            self.user_checks += 1
            return subprocess.CompletedProcess(["kb", "auth", "login"], 0, "logged in", "")

        result = run_platform_update_steps(
            mode="secured", launcher="kb-create", kb_binary="kb", platform_root=self.root,
            parent_journey=self.parent_journey,
            update_index=self.update_index,
            request_file=self.root / "request.json", base_version="3.0.0", updated_version="3.0.1",
            run_command=self.fake_kb, verify_user=verify_user,
        )
        report = result.result()
        self.assertEqual(report.status, "PASS")
        steps = {step["name"]: step for step in report.steps}
        self.assertEqual(steps["existing admin can log in after update"]["status"], "PASS")
        self.assertEqual(steps["existing admin can log in after rollback"]["status"], "PASS")
        self.assertEqual(
            steps["save installed receipt, config, and host status"]["details"]["configSha256"]["beforeUpdate"],
            hashlib.sha256(self.expected_platform_user_config()).hexdigest(),
        )
        self.assertEqual(self.config.read_bytes(), self.expected_platform_user_config())
        self.assertEqual(self.commands[0][1:5], ["config", "set", "--scope", "platform"])
        self.assertEqual(self.state_file.read_bytes(), original_state)
        self.assertEqual(
            set(steps["verify restored receipt, config, host, and project command"]["details"]["configSha256"]),
            {"beforeUpdate", "afterUpdateBeforeRestart", "afterUpdateRestart", "afterRollbackHostRestart", "afterMissingSnapshotRecovery"},
        )
        checkpoints = steps["verify restored receipt, config, host, and project command"]["details"]["configSha256"]
        self.assertEqual(checkpoints["beforeUpdate"], checkpoints["afterUpdateBeforeRestart"])
        self.assertEqual(checkpoints["beforeUpdate"], checkpoints["afterUpdateRestart"])
        self.assertEqual(checkpoints["beforeUpdate"], checkpoints["afterRollbackHostRestart"])
        self.assertEqual(checkpoints["afterRollbackHostRestart"], checkpoints["afterMissingSnapshotRecovery"])
        claims = {claim["claimId"] for claim in report.case_run["claims"]}
        self.assertEqual(claims, {f"S-023.{step}" for step in range(1, 9)} | {"S-023.10", "S-023.18"} |
                         {"S-214.10"} |
                         {f"S-024.{step}" for step in (1, 2, 3, 4, 5)} | {"S-041.4", "S-203.10", "S-203.11",
                         "PC-001.13", "PC-001.14", "PC-001.15"})
        self.assertEqual([command[1] for command in self.commands], [
            "config", "status", "project", "plan", "update", "status", "update", "status", "status", "status", "status", "doctor", "status", "doctor", "adapter", "project", "plan", "update", "restart", "status",
            "rollback", "rollback", "rollback", "status", "project", "adapter", "doctor", "restart", "adapter", "stop", "apply", "start", "update", "update",
            "stop", "apply", "status", "doctor", "update",
        ])
        for command in (command for command in self.commands if command[1] in ("update", "rollback", "restart")):
            self.assertIn("--platform-root", command)
        for operation in ("plan", "update"):
            command = next(args for args in self.commands if args[1] == operation)
            self.assertTrue({"--json", "--index", "--input"}.issubset(command))
        rollback = next(args for args in self.commands if args[1] == "rollback" and "missing-journey-snapshot" not in args)
        self.assertIn("--yes", rollback)
        self.assertIn("snapshot-1", rollback)
        human_updates = [command for command in self.commands if command[1] == "update" and "--json" not in command]
        self.assertEqual(len(human_updates), 1)
        self.assertIn("--json", next(command for command in self.commands if command[1] == "rollback" and "--json" in command))
        self.assertEqual(self.user_checks, 3)
        self.assertEqual(self.project_user_checks, [1, 1, 2])
        self.assertNotIn("S-041.4", steps["verify installed version and pending restart while old host serves"]["cases"])
        self.assertIn("S-041.4", steps["verify restored receipt, config, host, and project command"]["cases"])

    def test_failed_initial_login_does_not_claim_saved_session_survives_update(self):
        login_attempts = 0

        def failed_login():
            nonlocal login_attempts
            login_attempts += 1
            code = 1 if login_attempts == 1 else 0
            return subprocess.CompletedProcess(["kb", "auth", "login"], code,
                                               "authentication failed" if code else "logged in", "")

        result = run_platform_update_steps(
            mode="secured", launcher="kb-create", kb_binary="kb", platform_root=self.root,
            parent_journey=self.parent_journey,
            update_index=self.update_index, request_file=self.root / "request.json",
            base_version="3.0.0", updated_version="3.0.1", run_command=self.fake_kb, verify_user=failed_login,
        )
        steps = {step["name"]: step for step in result.result().steps}
        self.assertEqual(steps["save installed receipt, config, and host status"]["status"], "FAIL")
        self.assertEqual(steps["verify restored receipt, config, host, and project command"]["status"], "BLOCKED")
        self.assertIn("step:save installed receipt, config, and host status ended FAIL",
                      steps["verify restored receipt, config, host, and project command"]["message"])
        self.assertEqual(
            steps["save installed receipt, config, and host status"]["details"]["configSha256"]["beforeUpdate"],
            hashlib.sha256(self.expected_platform_user_config()).hexdigest(),
        )

    def test_missing_baseline_blocks_s024_3_with_reason(self):
        status_calls = 0

        def missing_initial_status(args: list[str]) -> subprocess.CompletedProcess:
            nonlocal status_calls
            if args[1] == "status":
                status_calls += 1
                if status_calls == 1:
                    return subprocess.CompletedProcess(args, 1, json.dumps({"ok": False, "error": {
                        "code": "KB_HOST_UNHEALTHY", "message": "The host is stopped.", "hint": "Start the host."}}), "")
            return self.fake_kb(args)

        result = run_platform_update_steps(
            mode="local", launcher="kb-create", kb_binary="kb", platform_root=self.root,
            parent_journey=self.parent_journey,
            update_index=self.update_index, request_file=self.root / "request.json",
            base_version="3.0.0", updated_version="3.0.1", run_command=missing_initial_status,
        )
        steps = {step["name"]: step for step in result.result().steps}
        verification = steps["verify restored receipt, config, host, and project command"]
        self.assertEqual(verification["status"], "BLOCKED")
        self.assertIn("step:save installed receipt, config, and host status ended FAIL", verification["message"])
        self.assertIn("KB_HOST_UNHEALTHY", verification["message"])

    def test_s024_3_names_first_unexpected_checkpoint_change_and_both_hashes(self):
        def mutate_after_rollback(args: list[str]) -> subprocess.CompletedProcess:
            result = self.fake_kb(args)
            if args[1] == "rollback" and "missing-journey-snapshot" not in args and result.returncode == 0:
                self.config.write_text('{"stable":true,"rewritten":true}\n')
            return result

        result = run_platform_update_steps(
            mode="local", launcher="kb-create", kb_binary="kb", platform_root=self.root,
            parent_journey=self.parent_journey,
            update_index=self.update_index, request_file=self.root / "request.json",
            base_version="3.0.0", updated_version="3.0.1", run_command=mutate_after_rollback,
        )
        verification = next(step for step in result.result().steps if "S-024.3" in step["cases"])
        self.assertEqual(verification["status"], "FAIL")
        self.assertIn("after successful rollback plus host restart", verification["message"])
        self.assertIn("beforeUpdate=", verification["message"])
        self.assertIn("afterRollbackHostRestart=", verification["message"])

    def test_s024_3_names_change_during_missing_snapshot_recovery(self):
        def mutate_during_recovery(args: list[str]) -> subprocess.CompletedProcess:
            result = self.fake_kb(args)
            if args[1] == "rollback" and "missing-journey-snapshot" in args:
                self.config.write_text('{"stable":true,"recoveryRewrite":true}\n')
            return result

        result = run_platform_update_steps(
            mode="local", launcher="kb-create", kb_binary="kb", platform_root=self.root,
            parent_journey=self.parent_journey,
            update_index=self.update_index, request_file=self.root / "request.json",
            base_version="3.0.0", updated_version="3.0.1", run_command=mutate_during_recovery,
        )
        verification = next(step for step in result.result().steps if "S-024.3" in step["cases"])
        self.assertEqual(verification["status"], "FAIL")
        self.assertIn("after missing-snapshot recovery", verification["message"])
        self.assertIn("afterRollbackHostRestart=", verification["message"])
        self.assertIn("afterMissingSnapshotRecovery=", verification["message"])

    def test_failed_update_reports_the_first_failed_case_step(self):
        def broken(args: list[str]) -> subprocess.CompletedProcess:
            if args[1] == "plan":
                return subprocess.CompletedProcess(args, 2, json.dumps({"ok": False, "error": {
                    "code": "KB_TEST_PLAN_REJECTED", "message": "Invalid update request.",
                    "hint": "Correct the request and retry."}}), "")
            return self.fake_kb(args)

        result = run_platform_update_steps(
            mode="secured", launcher="kb-create", kb_binary="kb", platform_root=self.root,
            parent_journey=self.parent_journey,
            update_index=self.update_index,
            request_file=self.root / "request.json", base_version="3.0.0", updated_version="3.0.1",
            run_command=broken,
        )
        report = result.result()
        self.assertEqual(report.status, "FAIL")
        self.assertEqual(report.first_failure["name"], "plan the newer sealed release")
        self.assertEqual(report.first_failure["cases"], ["S-023.2", "S-214.10"])
        self.assertIn("KB_TEST_PLAN_REJECTED", report.first_failure["message"])

    def test_repeat_plan_drift_names_changed_plan_fields_before_mutation(self):
        def drifting(args: list[str]) -> subprocess.CompletedProcess:
            result = self.fake_kb(args)
            if args[1] == "plan" and sum(command[1] == "update" for command in self.commands) > 0:
                payload = json.loads(result.stdout)
                payload["data"]["plan"]["planHash"] = "drifted-plan-hash"
                payload["data"]["plan"]["scenarioStateDigest"] = "changed-state"
                result = subprocess.CompletedProcess(args, 0, json.dumps(payload), "")
            return result

        result = run_platform_update_steps(
            mode="secured", launcher="kb-create", kb_binary="kb", platform_root=self.root,
            parent_journey=self.parent_journey,
            update_index=self.update_index, request_file=self.root / "request.json",
            base_version="3.0.0", updated_version="3.0.1", run_command=drifting,
        )
        failure = result.result().first_failure
        self.assertEqual(failure["cases"], ["S-023.6"])
        self.assertIn("plan.planHash", failure["message"])
        self.assertIn("plan.scenarioStateDigest", failure["message"])
        self.assertEqual(sum(command[1] == "update" for command in self.commands), 5)


if __name__ == "__main__":
    unittest.main()
