from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import service_runner
from service_runner import (FlowGraph, Journey, prepare_service_api_session,
                            install_project_commit_plugin, restore_secured_cli_login,
                            service_api_token)


class SecuredCliLoginTests(unittest.TestCase):
    def test_restores_cli_login_after_auth_journey_logs_out(self):
        calls = []

        def runner(command, **kwargs):
            calls.append((command, kwargs))
            return SimpleNamespace(returncode=0, stdout="signed in", stderr="")

        env = {
            "HOME": "/isolated-home",
            "KB_JOURNEY_ADMIN_EMAIL": "admin@example.test",
            "KB_JOURNEY_ADMIN_PASSWORD": "JourneyPassw0rd!",
            "KB_JOURNEY_BASE_URL": "http://127.0.0.1:4000",
        }

        restore_secured_cli_login("/isolated-home/.local/bin/kb", env, runner=runner)

        self.assertEqual(calls[0][0], [
            "/isolated-home/.local/bin/kb", "auth", "login",
            "--gateway-url", "http://127.0.0.1:4000",
            "--email", "admin@example.test",
            "--password-stdin",
        ])
        self.assertEqual(calls[0][1]["cwd"], "/isolated-home")
        self.assertEqual(calls[0][1]["env"], env)

    def test_login_failure_names_the_recovery_command(self):
        def runner(_command, **_kwargs):
            return SimpleNamespace(returncode=1, stdout="", stderr="credentials rejected")

        with self.assertRaisesRegex(RuntimeError, "kb auth login.*credentials rejected"):
            restore_secured_cli_login(
                "/isolated-home/.local/bin/kb",
                {"HOME": "/isolated-home", "KB_JOURNEY_ADMIN_EMAIL": "admin@example.test",
                 "KB_JOURNEY_ADMIN_PASSWORD": "bad"},
                runner=runner,
            )


class ProjectPluginSettingsFixtureTests(unittest.TestCase):
    def test_installs_commit_into_project_before_reading_manifest_defaults(self):
        calls = []
        result = SimpleNamespace(returncode=0, stdout="", stderr="")

        def runner(command, **kwargs):
            calls.append((command, kwargs))
            return result

        env = {"HOME": "/isolated-home", "KB_HOME": "/isolated-home/.kb"}
        actual = install_project_commit_plugin("/tmp/project-a", "/isolated-home/.local/bin/kb", env,
                                                runner=runner)

        self.assertIs(actual, result)
        self.assertEqual(calls, [(
            ["/isolated-home/.local/bin/kb", "marketplace", "install", "@kb-labs/commit",
             "--scope", "project", "--json"],
            {"cwd": str(Path("/tmp/project-a").resolve()), "env": env, "capture_output": True,
             "text": True, "timeout": 300},
        )])


class AdapterDefaultsProbeTests(unittest.TestCase):
    def test_cleanup_probe_is_skipped_when_its_flow_did_not_run(self):
        selected = "S-054.3"
        with patch.dict(os.environ, {
            "KB_JOURNEY_SELECTED_STEPS": selected,
            "KB_JOURNEY_CASES": selected,
            "KB_JOURNEY_SELECTED_CAPABILITIES": "workflow",
            "KB_JOURNEY_NEEDED_STATES": "adapter-defaults",
        }, clear=True):
            journey = Journey("local", "adapter-cleanup-tied-to-flow")
            graph = FlowGraph(journey, {"workflow": ("adapter-defaults",)}, groups={
                "workflow": {"capabilities": {"workflow"}, "depends_on": ("adapter-defaults",)},
                "adapters": {"capabilities": {"adapter"}, "depends_on": ()},
            })
            flow = graph.flow("adapter defaults flow", "adapters", "adapter",
                              lambda: None, cases=["S-054.1"], record_empty_success=False)
            tied = graph.probe_state("adapter-defaults", "adapters", "restore adapter fixture",
                                     lambda: "cleanup ran without its flow", after_flow="adapter defaults flow")
            untied = graph.probe_state("adapter-defaults", "adapters", "mutated cleanup probe",
                                       lambda: "BLOCKED: adapter defaults flow did not run")

        self.assertEqual(flow, "SKIPPED")
        self.assertEqual(tied.status, "SKIPPED")
        self.assertEqual(untied.status, "BLOCKED")

    def test_probe_detects_valid_but_different_config_after_successful_restore_row(self):
        with tempfile.TemporaryDirectory(prefix="journey-adapter-probe-") as directory:
            config_path = Path(directory) / "kb.config.json"
            original = b'{"platform":{"adapterOptions":{"storage":{"baseDir":"storage"}}}}\n'
            config_path.write_bytes(b'{"platform":{"adapterOptions":{"storage":{"baseDir":"changed"}}}}\n')
            journey = service_runner.Journey("local", "adapter-probe-wrong-config")
            journey.step("adapter defaults flow", "adapter", lambda: None)
            journey.step("restore adapter journey fixture state", "adapter", lambda: None, role="lifecycle")

            error = service_runner._adapter_defaults_probe_error(
                journey, {"path": config_path, "contents": original}, Path(directory),
            )

        self.assertEqual(error, "platform adapter config differs from its snapshot at keys: platform.adapterOptions.storage.baseDir")
        self.assertNotIn("changed", error)
        probe = journey.step("state probe: adapter-defaults", "journey.state", lambda: error)
        self.assertEqual(probe.status, "FAIL")
        self.assertIn("platform.adapterOptions.storage.baseDir", probe.message)

    def test_probe_names_the_flow_that_prevented_fixture_cleanup(self):
        journey = service_runner.Journey("local", "adapter-probe-blocked")
        journey.step("adapter defaults flow", "adapter",
                     lambda: "BLOCKED: blocked by state project-registered: project add failed")

        error = service_runner._adapter_defaults_probe_error(journey, {}, Path("/unused"))
        probe = journey.step("state probe: adapter-defaults", "journey.state", lambda: error)

        self.assertEqual(probe.status, "BLOCKED")
        self.assertIn("adapter defaults flow ended BLOCKED", error)
        self.assertIn("project-registered", error)


class SecuredServiceTokenTests(unittest.TestCase):
    def test_short_login_token_fails_at_acquisition_before_storage(self):
        journey = Journey("secured", "short-service-token")
        graph = FlowGraph(journey, {}, states={})
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(service_runner, "ADMIN_PASSWORD", "synthetic-admin-password"), \
                patch.object(service_runner, "request", return_value=(200, {"accessToken": "weak"}, None)):
            prepare_service_api_session(graph, "secured")

            self.assertFalse(graph.states["service-api-session"]["passed"])
            self.assertIn("at least 12 characters", graph.states["service-api-session"]["evidence"])
            self.assertNotIn("KB_JOURNEY_SERVICE_TOKEN", os.environ)

    def test_valid_login_token_is_stored_and_redacted_from_report(self):
        secret = "synthetic-service-access-token-for-tests"
        journey = Journey("secured", "stored-service-token")
        graph = FlowGraph(journey, {}, states={})
        with tempfile.TemporaryDirectory(prefix="journey-service-token-") as temp, \
                patch.dict(os.environ, {}, clear=True), \
                patch.object(service_runner, "ADMIN_PASSWORD", "synthetic-admin-password"), \
                patch.object(service_runner, "request", side_effect=[
                    (200, {"accessToken": secret}, None), (200, {}, None),
                ]):
            prepare_service_api_session(graph, "secured")
            self.assertTrue(graph.states["service-api-session"]["passed"])
            self.assertEqual(os.environ["KB_JOURNEY_SERVICE_TOKEN"], secret)
            self.assertEqual(service_api_token(graph), secret)

            import invocations
            report = Path(temp) / "service-token.json"
            invocations.write_report_json(report, {"diagnostic": secret}, env={})
            self.assertNotIn(secret, report.read_text())
            self.assertEqual(json.loads(report.read_text())["diagnostic"], "[REDACTED]")


if __name__ == "__main__":
    unittest.main()
