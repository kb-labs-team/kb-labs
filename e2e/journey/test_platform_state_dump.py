from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from platform_state_dump import (MAX_DUMP_BYTES, MAX_FILE_BYTES, PlatformStateDumpOnce,
                                 _write_auth_state_probe, archive_service_logs, dump_platform_state,
                                 )
from installed_fixture import layout_value
from journey_resources import installer_record_path
from test_install_layout import create_test_install_container, move_test_platform_into_container


class PlatformStateDumpTests(unittest.TestCase):
    def test_invalid_install_root_is_recorded_without_crashing_failure_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            platform = base / "kb-platform"
            platform.mkdir()
            (platform / "current").write_text("not a layout link\n")
            reports = base / "reports"

            destination = dump_platform_state(
                platform, reports, mode="local", front="agent", scenario="explore",
                variant="default", first_failure=(
                    'kb-create install --json: exit 1; '
                    '{"error":{"code":"KB_INSTALL_LAYOUT_UNSUPPORTED"}}'),
            )

            diagnosis = json.loads((destination / "install-root-diagnosis.json").read_text())
            self.assertEqual(diagnosis["firstFailure"],
                             'kb-create install --json: exit 1; '
                             '{"error":{"code":"KB_INSTALL_LAYOUT_UNSUPPORTED"}}')
            self.assertIn("current is not a symlink", diagnosis["layoutError"])

    def test_auth_state_probe_reports_aggregate_status_and_database_identity_without_tokens(self):
        with tempfile.TemporaryDirectory(prefix="journey-auth-probe-") as temporary:
            root = Path(temporary)
            active = create_test_install_container(root)
            database = active / ".kb/data/database/kb.sqlite"
            database.parent.mkdir(parents=True)
            config = active / ".kb/kb.config.jsonc"
            config.write_text(json.dumps({"platform": {"adapterOptions": {
                "documentDatabase": {"filename": str(database)},
            }}}))
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE doc_session_families (id TEXT, data TEXT)")
                connection.execute("CREATE TABLE doc_refresh_tokens (id TEXT, data TEXT)")
                connection.execute("INSERT INTO doc_session_families VALUES (?, ?)",
                                   ("family-1", json.dumps({"userId": "user-1", "familyId": "family-1"})))
                connection.execute("INSERT INTO doc_refresh_tokens VALUES (?, ?)",
                                   ("refresh-1", json.dumps({"familyId": "family-1", "expiresAt": 9999999999999,
                                                              "jti": "sensitive-refresh-id"})))
            output = root / "auth-state-probe.json"
            self.assertGreater(_write_auth_state_probe(root, output), 0)
            probe = json.loads(output.read_text())
            self.assertEqual(probe["sessionStorePath"], str(database))
            self.assertEqual(probe["users"]["user-1"],
                             {"sessionFamilyCount": 1, "active": 1, "inactive": 0})
            self.assertIn("inode", probe["databaseFile"])
            self.assertNotIn("sensitive-refresh-id", output.read_text())

    def test_service_log_archive_finds_each_runtime_log_in_both_modes(self):
        for mode in ("local", "secured"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix="journey-service-logs-") as temporary:
                root = Path(temporary)
                platform_root = root / "platform"
                create_test_install_container(platform_root)
                kb_home = root / "home" / ".kb"
                database = kb_home / "state" / "prj_test" / "database" / "kb.sqlite"
                database.parent.mkdir(parents=True)
                with sqlite3.connect(database) as connection:
                    connection.execute("CREATE TABLE doc_logs (id TEXT, data TEXT, created_at INT, updated_at INT)")
                    services = {
                        "host": {"serviceId": "kb-host", "component": "host-server"},
                        "gateway": {"serviceId": "kb-host", "component": "gateway-bootstrap"},
                        "project-runtime": {"serviceId": "kb-host", "component": "project-runtime"},
                        "workflow-daemon": {"serviceId": "workflow-daemon", "appId": "workflow-daemon"},
                    }
                    for index, (service, service_fields) in enumerate(services.items()):
                        data = {"logId": f"log-{service}", "timestamp": "2026-10-02T00:00:00Z",
                                "level": "error", "message": f"failure from {service}",
                                "source": "platform", "fields": {**service_fields, "token": "secret-value"}}
                        connection.execute("INSERT INTO doc_logs VALUES (?, ?, ?, ?)",
                                           (f"log-{index}", json.dumps(data), index, index))
                destination = archive_service_logs(
                    kb_home, root / "reports", platform_root=platform_root, mode=mode, run_id="run-1",
                )
                for service in ("host", "gateway", "project-runtime", "workflow-daemon"):
                    archived = list(destination.rglob(f"{service}.jsonl"))
                    self.assertEqual(len(archived), 1)
                    self.assertIn(f"failure from {service}", archived[0].read_text())
                    self.assertNotIn("secret-value", archived[0].read_text())

    def test_service_log_archive_reads_platform_document_database(self):
        with tempfile.TemporaryDirectory(prefix="journey-platform-service-logs-") as temporary:
            root = Path(temporary)
            kb_home = root / "home" / ".kb"
            platform_root = root / "platform"
            active = create_test_install_container(platform_root)
            data_root = platform_root / "state" / "data"
            data_root.mkdir(parents=True)
            (active / ".kb").mkdir(parents=True)
            (active / ".kb" / "data").symlink_to(os.path.relpath(data_root, active / ".kb"), target_is_directory=True)
            database = data_root / "database" / "kb.sqlite"
            database.parent.mkdir(parents=True)
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE doc_logs (id TEXT, data TEXT, created_at INT, updated_at INT)")
                record = {
                    "source": "platform",
                    "message": "unexpected plugin failure",
                    "error": {"stack": "Error: fixture failure\\n    at command.js:12"},
                    "fields": {"serviceId": "kb-host", "component": "cli-runtime",
                               "correlationId": "corr-platform-log"},
                }
                connection.execute("INSERT INTO doc_logs VALUES (?, ?, ?, ?)",
                                   ("platform-log-1", json.dumps(record), 1, 1))

            destination = archive_service_logs(
                kb_home, root / "reports", platform_root=platform_root, mode="secured", run_id="run-2",
            )
            archived = list(destination.rglob("*.jsonl"))
            self.assertEqual(len(archived), 1)
            contents = archived[0].read_text()
            self.assertIn("corr-platform-log", contents)
            self.assertIn("fixture failure", contents)

    def test_dump_once_then_continue_to_uninstall(self):
        dump_guard = PlatformStateDumpOnce()
        events = []
        with patch("platform_state_dump.dump_platform_state") as write_dump:
            write_dump.side_effect = lambda *args, **kwargs: events.append("dump")
            dump_guard.dump("platform", "reports", mode="local", front="agent",
                            scenario="commit", variant="default", first_failure="failed step")
            events.append("continue to uninstall")
            dump_guard.dump("platform", "reports", mode="local", front="agent",
                            scenario="commit", variant="default", first_failure="failed step")

        self.assertEqual(events, ["dump", "continue to uninstall"])
        write_dump.assert_called_once()

    def test_dump_is_bounded_redacted_and_records_command_failures(self):
        with tempfile.TemporaryDirectory(prefix="journey-dump-test-") as temporary:
            root = Path(temporary)
            home = root / "home"
            host_state = root / "relocated-host-state"
            host_state.mkdir()
            (host_state / "host.log").write_text(
                "\n".join(f"host-line-{number}" for number in range(500))
                + "\napiKey: launcher-secret\n"
            )
            (host_state / layout_value("hostLogFiles.structured")).write_text(
                '{"level":50,"time":1,"msg":"structured-cause apiKey: launcher-secret"}\n')
            (host_state / (layout_value("hostLogFiles.structured") + ".1")).write_text(
                '{"level":50,"time":0,"msg":"rotated-cause"}\n')
            (host_state / "launcher.log").write_text("GATEWAY_INTERNAL_SECRET=probe-secret\n")
            platform = root / "platform"
            reports = root / "reports"
            binaries = root / "bin"
            binaries.mkdir()
            (platform / ".kb/logs").mkdir(parents=True)
            (platform / ".kb/diagnostics").mkdir(parents=True)
            (platform / "node_modules/@kb-labs/sample").mkdir(parents=True)
            (platform / ".kb/marketplace.lock").write_text('{"commit":"abc","token":"lock-secret"}')
            (platform / ".kb/kb.config.jsonc").write_text('{\n  "apiKey": "config-secret",\n  // retained comment\n}\n')
            (platform / ".kb/v2").mkdir(parents=True, exist_ok=True)
            (platform / ".kb/v2/receipt.json").write_text(json.dumps({
                "password": "receipt-secret",
                "plan": {"artifacts": [
                    {"id": "sample", "package": "@kb-labs/sample", "version": "1.2.3"},
                    {"id": "missing", "package": "@kb-labs/missing", "version": "4.5.6"},
                ]},
            }))
            (platform / "node_modules/@kb-labs/sample/package.json").write_text(
                '{"name":"@kb-labs/sample","version":"1.2.3"}'
            )
            (platform / "node_modules/@kb-labs/sample/kb-create.manifest.json").write_text('{}\n')
            (platform / ".kb/logs/oversized.log").write_text("skip-this-" + "x" * (MAX_DUMP_BYTES // 2))
            (platform / ".kb/logs/recent.log").write_text(
                "\n".join(f"line-{number}" for number in range(500)) + "\nJourneyPassw0rd!\n"
            )
            (platform / ".kb/diagnostics/recent.json").write_text(
                json.dumps({"message": "JourneyPassw0rd!", "secret": "diag-secret"})
            )

            kb = binaries / "kb"
            kb.write_text(
                "#!/bin/sh\n"
                "if [ \"$1\" = marketplace ] && [ \"$2\" = plugins ]; then echo 'marketplace plugins command failed'; exit 7; fi\n"
                "echo 'diag command failed'; exit 8\n"
            )
            kb.chmod(0o755)
            launcher = binaries / "kb-create"
            launcher.write_text(
                "#!/bin/sh\n"
                "if [ \"$1\" = doctor ]; then\n"
                f"  echo '{{\"ok\":true,\"data\":{{\"retention\":{{\"hostState\":\"{host_state}\"}}}}}}'\n"
                "  exit 0\n"
                "fi\n"
                "echo '{\"token\":\"launcher-secret\"}'\nexit 9\n"
            )
            launcher.chmod(0o755)
            move_test_platform_into_container(platform)
            opaque_state = platform / "state" / "nested" / "runtime-state.bin"
            opaque_state.parent.mkdir(parents=True)
            opaque_state.write_bytes(b"\x00opaque-state\xff")
            snapshots = installer_record_path(platform, "snapshots")
            snapshots.mkdir(parents=True)
            (snapshots / "snapshot-good.json").write_text(
                '{"id":"snapshot-good","token":"snapshot-secret"}'
            )
            (snapshots / "snapshot-too-large.json").write_text("x" * (MAX_FILE_BYTES + 1))
            env = {**os.environ, "HOME": str(home), "PATH": f"{binaries}:{os.environ.get('PATH', '')}",
                   "KB_JOURNEY_GIT_REVISION": "abc123def"}

            destination = dump_platform_state(
                platform, reports, mode="secured", front="agent", scenario="commit", variant="default",
                first_failure="kb command failed: Unknown command: workflow run",
                env=env, cwd=root, admin_password="JourneyPassw0rd!",
            )

            self.assertTrue((destination / ".kb/marketplace.lock").is_file())
            self.assertTrue((destination / ".kb/v2/receipt.json").is_file())
            fingerprints_path = destination / "shared-state-fingerprints.json"
            self.assertTrue(fingerprints_path.is_file())
            fingerprints = json.loads(fingerprints_path.read_text())
            self.assertEqual(set(fingerprints), {"nested/runtime-state.bin"})
            self.assertRegex(fingerprints["nested/runtime-state.bin"], r"^[0-9a-f]{64}$")
            snapshot = destination / "installer/snapshots/snapshot-good.json"
            self.assertTrue(snapshot.is_file())
            self.assertNotIn("snapshot-secret", snapshot.read_text())
            self.assertFalse((destination / "installer/snapshots/snapshot-too-large.json").exists())
            manifests = json.loads((destination / "receipt-artifact-manifests.json").read_text())
            self.assertEqual(manifests, [
                {"id": "sample", "package": "@kb-labs/sample", "version": "1.2.3", "manifestExists": True},
                {"id": "missing", "package": "@kb-labs/missing", "version": "4.5.6", "manifestExists": False},
            ])
            self.assertIn("sample@1.2.3", (destination / "kb-labs-packages.txt").read_text())
            tail = (destination / ".kb/logs/recent.log").read_text()
            self.assertIn("line-499", tail)
            self.assertNotIn("line-99\n", tail)
            self.assertTrue((destination / ".kb/logs/oversized.log").is_file())
            self.assertLessEqual((destination / ".kb/logs/oversized.log").stat().st_size, 1024 * 1024)
            self.assertNotIn("JourneyPassw0rd!", "".join(
                path.read_text(errors="replace") for path in destination.rglob("*") if path.is_file()
            ))
            self.assertNotIn("config-secret", (destination / ".kb/kb.config.jsonc").read_text())
            self.assertNotIn("receipt-secret", (destination / ".kb/v2/receipt.json").read_text())
            self.assertNotIn("diag-secret", (destination / ".kb/diagnostics/recent.json").read_text())
            self.assertIn("exit_code: 7", (destination / "kb-marketplace-plugins-platform.txt").read_text())
            self.assertIn("exit_code: 7", (destination / "kb-marketplace-plugins-project.txt").read_text())
            self.assertIn("exit_code: 8", (destination / "kb-command-diagnostic.txt").read_text())
            self.assertIn("exit_code: 9", (destination / "kb-create-status.txt").read_text())
            launcher_tail = (destination / "installer-host-state/host.log").read_text()
            self.assertIn("host-line-499", launcher_tail)
            self.assertNotIn("host-line-99\n", launcher_tail)
            self.assertNotIn("launcher-secret", launcher_tail)
            structured_name = layout_value("hostLogFiles.structured")
            structured_dump = (destination / "installer-host-state" / structured_name).read_text()
            self.assertIn("structured-cause", structured_dump)
            self.assertNotIn("launcher-secret", structured_dump)
            self.assertIn("rotated-cause", (destination / "installer-host-state" / (structured_name + ".1")).read_text())
            self.assertIn("GATEWAY_INTERNAL_SECRET", (destination / "installer-host-state/launcher.log").read_text())
            self.assertNotIn("launcher-secret", launcher_tail)
            self.assertNotIn("probe-secret", (destination / "installer-host-state/launcher.log").read_text())
            self.assertIn("First failure:", (destination / "index.md").read_text())
            self.assertIn("Journey git revision: abc123def", (destination / "index.md").read_text())
            size = sum(path.stat().st_size for path in destination.rglob("*") if path.is_file())
            self.assertLessEqual(size, MAX_DUMP_BYTES)

    def test_dump_reports_missing_product_directed_host_logs(self):
        with tempfile.TemporaryDirectory(prefix="journey-main-home-dump-") as temporary:
            root = Path(temporary)
            platform = root / "platform"
            create_test_install_container(platform)
            host_state = root / "moved-host-state"
            host_state.mkdir()
            binaries = root / "bin"
            binaries.mkdir()
            launcher = binaries / "kb-create"
            launcher.write_text(
                "#!/bin/sh\n"
                "if [ \"$1\" = doctor ]; then\n"
                f"  echo '{{\"ok\":true,\"data\":{{\"retention\":{{\"hostState\":\"{host_state}\"}}}}}}'\n"
                "  exit 0\n"
                "fi\nexit 0\n"
            )
            launcher.chmod(0o755)
            destination = dump_platform_state(
                platform, root / "reports", mode="local", front="agent", scenario="explore",
                variant="default", first_failure="runner failed",
                env={**os.environ, "HOME": str(root), "PATH": str(binaries)},
            )
            index = (destination / "index.md").read_text()
            self.assertIn("Doctor reported hostState", index)
            self.assertIn("contains no log files", index)

    def test_dump_includes_project_workflow_records_and_daemon_logs(self):
        with tempfile.TemporaryDirectory(prefix="journey-workflow-dump-test-") as temporary:
            home = Path(temporary)
            platform = home / "kb-platform"
            create_test_install_container(platform)
            project = home / "fresh-project"
            project.mkdir()
            reports = home / "reports"
            project_state = home / ".kb/state/prj_test"
            workflow_dir = project_state / "storage/workflows"
            log_dir = project_state / "logs"
            workflow_dir.mkdir(parents=True)
            log_dir.mkdir(parents=True)
            (home / ".kb").mkdir(parents=True, exist_ok=True)
            (home / ".kb/projects.json").write_text(json.dumps({"projects": [{"id": "prj_test", "path": str(project)}]}))
            (workflow_dir / "run-success.json").write_text(
                '{"id":"run-success","status":"success","input":{"message":"hello"},"token":"hidden"}'
            )
            (log_dir / "workflow-daemon.log").write_text("run-success completed successfully\n")

            destination = dump_platform_state(
                platform, reports, mode="local", front="agent", scenario="explore", variant="default",
                first_failure="workflow did not reach a terminal status",
                env={**os.environ, "HOME": str(home), "KB_HOME": str(home / ".kb"), "PATH": ""}, cwd=home,
            )

            evidence = destination / "workflow-evidence/fresh-project/project-state/storage/workflows/run-success.json"
            daemon_log = destination / "workflow-evidence/fresh-project/project-state/logs/workflow-daemon.log"
            self.assertTrue(evidence.is_file())
            self.assertIn('"status": "success"', evidence.read_text())
            self.assertIn('"token": "[REDACTED]"', evidence.read_text())
            self.assertTrue(daemon_log.is_file())
            self.assertIn("run-success completed successfully", daemon_log.read_text())
            size = sum(path.stat().st_size for path in destination.rglob("*") if path.is_file())
            self.assertLessEqual(size, MAX_DUMP_BYTES)


if __name__ == "__main__":
    unittest.main()
