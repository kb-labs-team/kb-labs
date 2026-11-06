import json
import ast
import os
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import urlparse
import urllib.request
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from marketplace_steps import (_output, _platform_snapshot, authenticate_secured_marketplace,
                               configured_marketplace_source_kinds,
                               commit_publish_command,
                               _publish_fixture_command,
                               _assert_catalogued_marketplace_failure,
                               prepare_commit_project_fixture,
                               prepare_registry_commit_project_fixture,
                               publish_commit_update_fixture,
                               run_ordered_source_journey_steps,
                               run_plugin_policy_diagnostic_step,
                               run_marketplace_steps, validate_commit_status_response,
                               validate_shared_failure, validate_unmounted_commit_response,
                               wait_for_marketplace_ready)
from service_steps import FlowGraph, Journey
from marketplace_tamper_proxy import tamper_tarball
from journey_dependencies import Dependency
import service_runner
from test_install_layout import create_test_install_container
from invocations import catalogued_error_hint, catalogued_error_message, invocation_context, open_http, run_command
import jsonl
from commit_fixture import commit_fixture_source_version


def _release_entity(identity: str) -> dict:
    root = Path(__file__).resolve().parents[2]
    index = json.loads((root / "e2e" / "platform" / "fixtures" / "release-index-v3.json").read_text())
    return next((entity for collection in ("plugins", "adapters") for entity in index[collection]
                 if entity["id"] == identity or entity["package"] == identity), None)


class MarketplaceStepTests(unittest.TestCase):
    def test_not_found_source_expectations_come_from_kb_create_status(self):
        self.assertEqual(configured_marketplace_source_kinds({"marketplaceSources": [
            {"kind": "registry", "url": "https://registry.example"}, {"kind": "npm"},
        ]}), ("registry", "npm"))
        with self.assertRaisesRegex(RuntimeError, "did not report"):
            configured_marketplace_source_kinds({})

    def test_plugin_not_found_claim_requires_per_source_results(self):
        missing_results = subprocess.CompletedProcess(
            ["kb", "marketplace", "install", "journey-not-published", "--json"], 1,
            json.dumps({"ok": False, "error": {
                "code": "KB_PLUGIN_NOT_FOUND", "message": "missing", "hint": "retry",
                "cause": "registry: not-found-unowned",
            }}), "")
        with self.assertRaisesRegex(AssertionError, "each configured source"):
            validate_shared_failure(
                missing_results, json_mode=True, code="KB_PLUGIN_NOT_FOUND", message="missing", hint="retry",
                marketplace_source_kinds=("registry", "npm"))
        complete_results = subprocess.CompletedProcess(
            ["kb", "marketplace", "install", "journey-not-published", "--json"], 1,
            json.dumps({"ok": False, "error": {
                "code": "KB_PLUGIN_NOT_FOUND", "message": "missing", "hint": "retry",
                "cause": "registry: not-found-unowned; npm: not-found-unowned",
            }}), "")
        validate_shared_failure(
            complete_results, json_mode=True, code="KB_PLUGIN_NOT_FOUND", message="missing", hint="retry",
            marketplace_source_kinds=("registry", "npm"))

    def test_commit_update_fixture_publishes_next_major_from_registry_candidate(self):
        published: list[dict] = []

        def fake_run(command, *, cwd=None, env=None, timeout=None, input=None, **_kwargs):
            if command[:2] == ["npm", "pack"] and command[2].startswith("@kb-labs/commit@"):
                package = Path(cwd) / "fixture" / "package"
                package.mkdir(parents=True)
                (package / "package.json").write_text(json.dumps(
                    {"name": "@kb-labs/commit", "version": "2.120.1"}))
                destination = command[command.index("--pack-destination") + 1]
                subprocess.run(["tar", "-czf", str(Path(destination) / "kb-labs-commit-2.120.1.tgz"),
                                "-C", str(package.parent), "package"], check=True)
                return subprocess.CompletedProcess(command, 0, "", "")
            if command[:3] == ["npm", "pack", "--ignore-scripts"]:
                manifest = json.loads((Path(cwd) / "package.json").read_text())
                destination = Path(command[command.index("--pack-destination") + 1])
                (destination / f"kb-labs-commit-{manifest['version']}.tgz").write_text(manifest["version"])
                return subprocess.CompletedProcess(command, 0, "", "")
            if command[0] == "tar":
                return subprocess.run(command, capture_output=True, text=True)
            if command[0] == "sh" and command[1].endswith("e2e/publisher/publish.sh"):
                directory = Path(env["PUBLISH_PACKAGES_DIR"])
                published.append({"registry": env["VERDACCIO_URL"],
                                  "files": sorted(path.name for path in directory.iterdir()),
                                  "home": env["HOME"]})
                return subprocess.CompletedProcess(command, 0, "", "")
            raise AssertionError(command)

        version = publish_commit_update_fixture("http://registry.test", "2.120.1",
                                                {"HOME": "/journey-home"}, fake_run)

        self.assertEqual(version, "3.0.0")
        self.assertEqual(len(published), 1)
        self.assertEqual(published[0]["registry"], "http://registry.test")
        self.assertEqual(published[0]["files"], ["kb-labs-commit-3.0.0.tgz"])
        self.assertNotEqual(published[0]["home"], "/journey-home")

    def test_shared_commit_fixture_uses_release_one_npm_source_without_registry_lane(self):
        with tempfile.TemporaryDirectory(prefix="kb-marketplace-default-fixture-") as directory:
            home = Path(directory)
            project = home / "project"
            (project / ".kb").mkdir(parents=True)
            (project / ".kb" / "kb.config.json").write_text("{}\n")
            commands = []
            source_version = commit_fixture_source_version(Path(__file__).resolve().parents[2])

            def runner(command, *, cwd, env, capture_output, text, timeout):
                commands.append(tuple(command))
                args = command[1:]
                if args[:3] == ["marketplace", "plugins", "doctor"]:
                    return subprocess.CompletedProcess(command, 0,
                        json.dumps({"ok": True, "data": {"total": 0, "issues": []}}), "")
                if args[:2] == ["marketplace", "install"]:
                    self.assertEqual(args[2], f"@kb-labs/commit@{source_version}")
                    lock = {"schema": "kb.marketplace/3", "plugins": {
                        "@kb-labs/commit": {"version": source_version, "package": "@kb-labs/commit",
                            "source": "marketplace", "marketplaceSource": "npm",
                            "signatureStatus": "unsigned", "integrity": "sha512-npm", "enabled": True},
                    }}
                    (project / ".kb" / "marketplace.lock").write_text(json.dumps(lock))
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "data": {
                        "scope": "project", "installed": [{"id": "@kb-labs/commit", "version": source_version,
                            "source": "npm", "signatureStatus": "unsigned"}],
                    }}), "")
                self.fail(f"unexpected shared-fixture command: {command}")

            journey = Journey("local", "default-commit-fixture")
            with patch("marketplace_steps.wait_for_marketplace_ready"):
                entry = prepare_commit_project_fixture(journey, project, "http://verdaccio.test",
                                                       {"HOME": str(home)}, runner)
            self.assertIsNotNone(entry)
            self.assertEqual(entry["marketplaceSource"], "npm")
            self.assertEqual(entry["signatureStatus"], "unsigned")
            self.assertFalse(any(command[:2] == ("npm", "view") for command in commands))
            self.assertTrue(any(command[:3] == ("kb", "marketplace", "install") for command in commands))
            self.assertFalse(any(command[:2] == ("node",) or "hub" in command for command in commands))
            self.assertFalse((project / ".kb" / "marketplace.lock").read_text().find('"marketplaceSource": "registry"') >= 0)

    def test_s268_ordered_source_rows_are_wired_to_installed_journey_steps(self):
        with tempfile.TemporaryDirectory(prefix="kb-s268-journey-wiring-") as directory:
            project = Path(directory)
            lock_path = project / ".kb" / "marketplace.lock"
            lock_path.parent.mkdir()
            lock_path.write_text(json.dumps({"schema": "kb.marketplace/3", "plugins": {
                "@kb-labs/commit": {"package": "@kb-labs/commit", "version": "1.0.0",
                    "integrity": "sha256-original", "marketplaceSource": "registry", "signatureStatus": "verified"},
                "journey-npm-only-fixture": {"package": "journey-npm-only-fixture", "version": "1.0.0",
                    "integrity": "sha256-fallback", "marketplaceSource": "npm", "signatureStatus": "unsigned"},
            }}))
            rendered = {"ok": True, "data": {
                "installed": [{"id": "journey-npm-only-fixture", "source": "npm", "signatureStatus": "unsigned"}],
                "marketplaceSources": [{"kind": "registry", "url": "http://registry.test"}],
            }}
            def runner(command, **_kwargs):
                if command[0].endswith("kb-create") and command[1] == "update":
                    return subprocess.CompletedProcess(command, 0, json.dumps(rendered), "")
                if command[0].endswith("kb-create"):
                    return subprocess.CompletedProcess(command, 0, json.dumps(rendered), "")
                if command[1:4] == ["marketplace", "plugins", "doctor"]:
                    code = "KB_MARKETPLACE_PROVENANCE_REQUIRED"
                    return subprocess.CompletedProcess(command, 1, json.dumps({"ok": False, "error": {
                        "code": code,
                        "message": "The Marketplace lock entry does not record its source provenance.",
                        "hint": catalogued_error_hint(code, package="@kb-labs/commit", scope="project"),
                    }}), "")
                return subprocess.CompletedProcess(command, 0, json.dumps(rendered), "")

            platform_root = project / "platform"
            (platform_root / ".kb").mkdir(parents=True)
            (platform_root / ".kb" / "kb.config.jsonc").write_text(
                '{"marketplace":{"sources":[{"signingPublicKey":"${KB_JOURNEY_MARKETPLACE_PUBLIC_KEY}",'
                '"authToken":"${KB_JOURNEY_MARKETPLACE_TOKEN}"}]}}\n')
            env = {"HOME": directory, "KB_JOURNEY_PLATFORM_ROOT": str(project / "platform"),
                   "KB_JOURNEY_REGISTRY": "http://verdaccio.test",
                   "KB_JOURNEY_MARKETPLACE_REGISTRY_URL": "http://registry.test",
                   "KB_JOURNEY_MARKETPLACE_PUBLIC_KEY": "journey-public-key",
                   "KB_JOURNEY_MARKETPLACE_TOKEN": "journey-token-secret-value",
                   "KB_JOURNEY_KB_CREATE_PATH": str(project / "kb-create")}
            with patch("marketplace_steps._set_marketplace_proxy_faults"), \
                    patch("marketplace_steps._assert_catalogued_marketplace_failure"), \
                    patch("marketplace_steps._json", return_value=rendered["data"]), \
                    patch.dict(os.environ, {"KB_JOURNEY_RUNNER_SELECTOR": "service-marketplace-registry:local"}):
                journey = Journey("local", "s268-wiring")
                journey.step("publish and install Commit through Registry", "marketplace-fixtures", lambda: None,
                             runners=("service-marketplace-registry:local", "service-marketplace-registry:secured"))
                run_ordered_source_journey_steps(journey, project, env, runner)
            claims = {case for step in journey.steps for case in step.cases}
            self.assertEqual(claims, {f"S-268.{number}" for number in range(2, 9)})
            self.assertTrue(all(step.status == "PASS" for step in journey.steps),
                            [(step.name, step.status, step.message) for step in journey.steps])

    def test_s268_failure_assertion_reads_catalogue_message_and_hint(self):
        with tempfile.TemporaryDirectory(prefix="kb-s268-error-catalog-") as directory:
            project = Path(directory)
            code = "KB_MARKETPLACE_TRANSPORT_FAILED"
            package = "@kb-labs/commit"
            envelope = {"ok": False, "error": {
                "code": code, "message": catalogued_error_message(code),
                "hint": catalogued_error_hint(code, package=package, scope="project"),
            }}
            def runner(command, **_kwargs):
                return subprocess.CompletedProcess(command, 1, json.dumps(envelope), "")
            _assert_catalogued_marketplace_failure(project, {"HOME": directory}, runner, package, code)
            envelope["error"]["hint"] = "hand-copied hint"
            with self.assertRaisesRegex(RuntimeError, "exact hint"):
                _assert_catalogued_marketplace_failure(project, {"HOME": directory}, runner, package, code)

    def test_tamper_forwarder_changes_only_registry_tarball_bytes(self):
        body = b"sealed package archive"
        self.assertNotEqual(tamper_tarball("/api/v1/packages/acme/plugin/1.0.0/tarball", body), body)
        self.assertEqual(tamper_tarball("/api/v1/packages/acme/plugin", body), body)

    def test_commit_fixture_publisher_uses_the_real_hub_publish_request(self):
        self.assertEqual(commit_publish_command("/workspace"), [
            "hub", "publish", "--path", "/workspace/plugins/commit", "--json",
        ])
        self.assertEqual(_publish_fixture_command("/workspace", "plugins/qa"), [
            "hub", "publish", "--path", "/workspace/plugins/qa", "--json",
        ])

    def test_registry_commit_fixture_publishes_in_workspace_and_installs_in_lane_project(self):
        with tempfile.TemporaryDirectory(prefix="kb-marketplace-registry-fixture-") as directory:
            root = Path(directory)
            project = root / "project"
            (project / ".kb").mkdir(parents=True)
            (project / ".kb" / "kb.config.json").write_text("{}\n")
            workspace = root / "workspace"
            calls = []

            def runner(command, *, cwd, env, capture_output, text, timeout):
                calls.append((tuple(command), cwd, env.copy()))
                if command[0] == "node":
                    return subprocess.CompletedProcess(command, 0, json.dumps({
                        "ok": True, "data": {"version": "2.120.1"},
                    }), "")
                if command[0] == "kb":
                    lock = {"schema": "kb.marketplace/3", "plugins": {
                        "@kb-labs/commit": {"version": "2.120.1", "package": "@kb-labs/commit",
                            "source": "marketplace", "marketplaceSource": "registry",
                            "signatureStatus": "verified", "integrity": "sha512-registry", "enabled": True},
                    }}
                    (project / ".kb" / "marketplace.lock").write_text(json.dumps(lock))
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "data": {
                        "scope": "project", "installed": [{"id": "@kb-labs/commit", "version": "2.120.1",
                            "source": "registry", "signatureStatus": "verified"}],
                    }}), "")
                self.fail(f"unexpected Registry fixture command: {command}")

            env = {"HOME": str(root), "KB_JOURNEY_WORKSPACE_ROOT": str(workspace),
                   "KB_JOURNEY_MARKETPLACE_PUBLISH_URL": "http://registry.test/api/v1",
                   "KB_JOURNEY_MARKETPLACE_AUTHOR_HANDLE": "journey"}
            with patch("marketplace_steps.wait_for_marketplace_ready"), \
                    patch.dict(os.environ, {"KB_JOURNEY_RUNNER_SELECTOR": "service-marketplace-registry:local"}):
                journey = Journey("local", "registry-commit-fixture")
                entry = prepare_registry_commit_project_fixture(journey, project, "http://verdaccio.test",
                                                                 env, runner)

            self.assertEqual(entry["marketplaceSource"], "registry")
            self.assertEqual(entry["signatureStatus"], "verified")
            workspace_cli = str(workspace / "cli" / "bin" / "dist" / "bin.js")
            self.assertEqual([call[0] for call in calls if call[0][0] == "node"], [
                ("node", workspace_cli, "hub", "publish", "--path", str(workspace / "plugins/commit"), "--json"),
                ("node", workspace_cli, "hub", "publish", "--path", str(workspace / "e2e/journey/fixtures/analytics-emitter"), "--json"),
                ("node", workspace_cli, "hub", "publish", "--path", str(workspace / "plugins/qa"), "--json"),
            ])
            self.assertEqual(journey.result().status, "PASS")

    def test_policy_diagnostic_step_restores_config_and_proves_blocked_fixture_and_first_party_cli(self):
        with tempfile.TemporaryDirectory(prefix="kb-policy-journey-unit-") as directory:
            project = Path(directory)
            config = project / ".kb" / "kb.config.json"
            config.parent.mkdir()
            original = b'{"preserved": true}\n'
            config.write_bytes(original)
            calls = []

            def runner(command, **_kwargs):
                calls.append(command)
                if command[0] == "kb" and command[1:3] == ["marketplace", "install"]:
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "data": {}}), "")
                if command[0] == "kb" and command[1:4] == ["marketplace", "plugins", "doctor"]:
                    return subprocess.CompletedProcess(command, 1, json.dumps({"ok": False, "error": {
                        "code": "KB_RUNTIME_COMMAND_FAILED", "message": "Marketplace doctor found issues",
                        "hint": "Run doctor", "diagnostics": [{
                            "code": "PLUGIN_POLICY_TYPE_INVALID", "severity": "error",
                            "path": str(config), "message": "@kb-labs/e2e-analytics-emitter is unavailable: plugins.block must be an array",
                            "hint": f"Repair the policy; kb marketplace plugins doctor --scope project",
                        }],
                    }}), "")
                if command[0] == "kb" and command[1:3] == ["journey", "analytics"]:
                    return subprocess.CompletedProcess(command, 1, json.dumps({"ok": False, "error": {
                        "code": "KB_RUNTIME_COMMAND_NOT_FOUND", "message": "Unknown command journey analytics emit",
                        "hint": "Run kb help",
                    }}), "")
                if command[0] == "kb" and command[1] == "version":
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "data": {"version": "1.0.0"}}), "")
                raise AssertionError(f"unexpected command: {command}")

            journey = Journey("local", "policy-test")
            with patch("marketplace_steps._registry_version", return_value="1.0.0"):
                run_plugin_policy_diagnostic_step(journey, project, "http://registry.test", {"HOME": directory}, runner)

            self.assertEqual(config.read_bytes(), original)
            self.assertEqual(journey.steps[-1].status, "PASS")
            self.assertEqual(journey.steps[-1].cases, ["S-203.25"])
            self.assertTrue(any(command[0] == "kb" and command[1] == "version" for command in calls))

    def test_commit_route_http_claims_accept_documented_success_and_not_found(self):
        response = {"ok": False, "error": {"code": "KB_PLUGIN_NOT_INSTALLED",
            "message": "Plugin is not installed in this project.",
            "hint": "Run `kb marketplace install @kb-labs/commit` in this project.",
            "correlationId": "request-fixture"}}
        validate_commit_status_response(200, {"ok": True, "data": {"scope": "root"}})
        validate_unmounted_commit_response(404, response)

    def test_commit_route_claims_fail_for_fake_unmounted_and_still_mounted_responses(self):
        with self.assertRaisesRegex(RuntimeError, "unexpected response: HTTP 404"):
            validate_commit_status_response(404, {"ok": False, "error": {"code": "KB_RUNTIME_UNEXPECTED"}})
        with self.assertRaisesRegex(RuntimeError, "unexpected gateway failure: HTTP 200"):
            validate_unmounted_commit_response(200, {"ok": True, "data": {"scope": "project"}})
        with self.assertRaisesRegex(RuntimeError, "unexpected gateway failure: HTTP 404"):
            validate_unmounted_commit_response(404, {"ok": False, "error": {
                "code": "KB_RUNTIME_UNEXPECTED", "message": "An unexpected error occurred.",
                "hint": "Re-run with --debug and include the correlationId in a report.",
                "correlationId": "request-fixture"}})

    def test_fake_failures_are_rejected_for_both_shared_error_renderings(self):
        for json_mode in (False, True):
            with self.subTest(json_mode=json_mode), self.assertRaises(AssertionError):
                validate_shared_failure(subprocess.CompletedProcess(
                    ["kb", "marketplace", "install"], 0, "{}", ""), json_mode=json_mode,
                    code="KB_PLUGIN_NOT_FOUND", message="missing",
                    hint='Check the exact package name and package source. If available, run `kb marketplace install @kb-labs/not-published`; `kb marketplace plugins list` shows installed plugins.')

    def test_shared_error_validator_accepts_json_envelope_and_human_recovery_hint(self):
        message = "Adapter package x is not installed on this platform."
        hint = "kb marketplace install x --scope platform"
        validate_shared_failure(subprocess.CompletedProcess(["kb"], 1, json.dumps({
            "ok": False, "error": {"code": "KB_ADAPTER_NOT_INSTALLED", "message": message, "hint": hint},
        }), ""), json_mode=True, code="KB_ADAPTER_NOT_INSTALLED", message=message, hint=hint)
        validate_shared_failure(subprocess.CompletedProcess(["kb"], 1,
            f"{message} [KB_ADAPTER_NOT_INSTALLED]\n  Hint:  {hint}\n", ""),
            json_mode=False, code="KB_ADAPTER_NOT_INSTALLED", message=message, hint=hint)

    def test_command_and_http_steps_do_not_bypass_the_invocation_helper(self):
        root = Path(__file__).parent
        guarded = [source for source in root.rglob("*.py")
                   if source.name != "invocations.py" and not source.name.startswith("test_")]
        violations = []

        class CallGuard(ast.NodeVisitor):
            def __init__(self, source):
                self.source = source

            def visit_Call(self, node):
                function = node.func
                if (isinstance(function, ast.Attribute)
                        and function.attr in {"run", "Popen", "check_output", "call"}
                        and isinstance(function.value, ast.Name)
                        and function.value.id == "subprocess"):
                    violations.append(f"{self.source.name}:{node.lineno} calls subprocess.{function.attr} directly")
                if (isinstance(function, ast.Attribute) and function.attr == "urlopen"
                        and isinstance(function.value, ast.Attribute)
                        and function.value.attr == "request"):
                    violations.append(f"{self.source.name}:{node.lineno} calls urllib.request.urlopen directly")
                self.generic_visit(node)

            def visit_FunctionDef(self, node):
                self._check_defaults(node.args.defaults, node.lineno)
                self._check_defaults([value for value in node.args.kw_defaults if value is not None], node.lineno)
                self.generic_visit(node)

            visit_AsyncFunctionDef = visit_FunctionDef

            def _check_defaults(self, values, line):
                for value in values:
                    if (isinstance(value, ast.Attribute) and value.attr == "run"
                            and isinstance(value.value, ast.Name) and value.value.id == "subprocess"):
                        violations.append(f"{self.source.name}:{line} defaults to subprocess.run")

        for source in guarded:
            tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
            CallGuard(source).visit(tree)
        self.assertEqual(violations, [])

    def test_invocation_helper_records_case_command_outputs_and_redacts_secrets(self):
        with tempfile.TemporaryDirectory(prefix="kb-invocation-evidence-") as directory:
            report_root = Path(directory)
            env = {"HOME": "/isolated", "KB_JOURNEY_HOME_LABEL": "anonymous",
                   "KB_JOURNEY_ADMIN_PASSWORD": "never-write-this"}

            def runner(command, **_kwargs):
                return subprocess.CompletedProcess(command, 7, "failure never-write-this", "stderr detail")

            with invocation_context(step_id="S-041.7", report_root=report_root):
                result = run_command(["kb", "marketplace", "plugins", "list", "--json"],
                                     cwd="/isolated/project", env=env, runner=runner)

            record = jsonl.read_jsonl(report_root / "invocations" / "calls.jsonl")[0].value
            self.assertEqual(result.returncode, 7)
            self.assertEqual(record["step_id"], "S-041.7")
            self.assertEqual(record["home_label"], "anonymous")
            self.assertEqual(record["cwd"], "/isolated/project")
            self.assertEqual(record["exit_code"], 7)
            self.assertEqual(record["stdout"], "failure [REDACTED]")
            self.assertEqual(record["stderr"], "stderr detail")
            self.assertGreaterEqual(record["duration_seconds"], 0)
            self.assertNotIn("never-write-this", json.dumps(record))

    def test_invocation_helper_records_redacted_http_request_and_response(self):
        class Response:
            status = 201
            headers = {}

            def __enter__(self):
                return self

            def __exit__(self, *_exc):
                return None

            def read(self):
                return b'{"ok":true}'

        with tempfile.TemporaryDirectory(prefix="kb-invocation-http-evidence-") as directory:
            report_root = Path(directory)
            secret = "studio-member-password"
            request = urllib.request.Request("https://gateway.test/auth/invites", data=json.dumps({
                "email": "member@example.test", "password": secret,
            }).encode(), method="POST")
            with invocation_context(step_id="S-106.2", report_root=report_root):
                status, body, _ = open_http(lambda *_args, **_kwargs: Response(), request,
                                            timeout=3, env={"KB_STUDIO_MEMBER_PASSWORD": secret})
            record = jsonl.read_jsonl(report_root / "invocations" / "calls.jsonl")[0].value
            self.assertEqual(status, 201)
            self.assertEqual(body, b'{"ok":true}')
            self.assertEqual(record["argv"], ["POST"])
            self.assertEqual(record["url"], "https://gateway.test/auth/invites")
            self.assertEqual(record["request_body"], '{"email": "member@example.test", "password": "[REDACTED]"}')
            self.assertEqual(record["stdout"], '{"ok":true}')
            self.assertNotIn(secret, json.dumps(record))

    def test_marketplace_product_health_check_runs_through_invocation_helper(self):
        with tempfile.TemporaryDirectory(prefix="kb-marketplace-health-") as directory:
            calls = []

            def fake_run(command, **kwargs):
                calls.append(command)
                return subprocess.CompletedProcess(command, 0, '{"ok":true,"data":{}}', "")

            wait_for_marketplace_ready(Path(directory), {"HOME": directory}, fake_run)
            self.assertEqual(calls, [["kb", "marketplace", "plugins", "doctor", "--scope", "project", "--json"]])

    def test_platform_snapshot_detects_receipt_and_package_version_changes(self):
        with tempfile.TemporaryDirectory(prefix="kb-marketplace-platform-snapshot-") as directory:
            root = Path(directory)
            active = create_test_install_container(root)
            receipt = active / ".kb" / "v2" / "receipt.json"
            receipt.parent.mkdir(parents=True)
            receipt.write_text('{"version":"1"}\n')
            package = active / "node_modules" / "@kb-labs" / "workflow-daemon" / "package.json"
            package.parent.mkdir(parents=True)
            package.write_text('{"name":"@kb-labs/workflow-daemon","version":"2.120.1"}\n')

            before = _platform_snapshot(root)
            receipt.write_text('{"version":"2.120.2"}\n')
            self.assertNotEqual(before, _platform_snapshot(root))
            receipt.write_text('{"version":"2.120.1"}\n')

            before = _platform_snapshot(root)
            package.write_text('{"name":"@kb-labs/workflow-daemon","version":"2.120.2"}\n')

            self.assertNotEqual(before, _platform_snapshot(root))

    def test_marketplace_failure_detail_keeps_error_start_and_end(self):
        command = ["kb", "marketplace", "install", "@kb-labs/qa"]
        raw = "ERR_PNPM_RESOLUTION_FAILURE: root cause " + ("detail " * 400) + "final context"
        result = subprocess.CompletedProcess(command, 1, raw, "")

        with self.assertRaisesRegex(RuntimeError, "ERR_PNPM_RESOLUTION_FAILURE: root cause") as raised:
            _output(result, command)

        self.assertIn("final context", str(raised.exception))

    def test_marketplace_failure_detail_uses_stderr_when_stdout_is_empty(self):
        command = ["kb", "marketplace", "install", "@kb-labs/adapters-analytics-file", "--json"]
        result = subprocess.CompletedProcess(command, 1, "", '{"ok":false,"error":{"code":"KB_MARKETPLACE_PLATFORM_ARTIFACT_PINS_MISSING"}}')

        with self.assertRaisesRegex(RuntimeError, "KB_MARKETPLACE_PLATFORM_ARTIFACT_PINS_MISSING"):
            _output(result, command)

    def test_setup_command_failure_preserves_typed_code_message_and_next_step(self):
        command = ["kb", "project", "add", "/work/missing-project", "--json"]
        result = subprocess.CompletedProcess(command, 1, json.dumps({
            "ok": False,
            "error": {
                "code": "KB_PROJECT_PATH_INVALID",
                "message": "Project path does not exist.",
                "hint": "Create it, then run `kb project add /work/missing-project`.",
            },
        }), "")

        with self.assertRaises(RuntimeError) as raised:
            _output(result, command)

        self.assertIn("`kb project add /work/missing-project --json` exited 1", str(raised.exception))
        self.assertIn("KB_PROJECT_PATH_INVALID", str(raised.exception))
        self.assertIn("Project path does not exist.", str(raised.exception))
        self.assertIn("hint: Create it, then run `kb project add /work/missing-project`.", str(raised.exception))

    def test_secured_marketplace_claims_typed_missing_login_then_persists_admin_session(self):
        with tempfile.TemporaryDirectory(prefix="kb-marketplace-auth-journey-") as directory:
            root = Path(directory)
            project = root / "project"
            project.mkdir()
            env = {
                "HOME": str(root),
                "KB_JOURNEY_BASE_URL": "http://gateway.test",
                "KB_JOURNEY_ADMIN_EMAIL": "admin@example.test",
                "KB_JOURNEY_ADMIN_PASSWORD": "fixture-password",
            }
            calls: list[tuple[str, ...]] = []
            session_saved = False
            machine_credentials = True

            def fake_run(command, *, cwd, env, capture_output, text, timeout):
                nonlocal session_saved, machine_credentials
                calls.append(tuple(command))
                args = command[1:]
                if args[:2] == ["auth", "logout"]:
                    machine_credentials = False
                    session_saved = False
                    return subprocess.CompletedProcess(command, 0, '{"ok":true}', "")
                if args[:3] == ["marketplace", "plugins", "list"]:
                    if machine_credentials or session_saved:
                        return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "data": {"entries": []}}), "")
                    return subprocess.CompletedProcess(command, 1, json.dumps({
                        "ok": False,
                        "error": {
                            "code": "KB_AUTH_REQUIRED",
                            "message": catalogued_error_message("KB_AUTH_REQUIRED"),
                            "hint": catalogued_error_hint("KB_AUTH_REQUIRED", gatewayUrl="http://gateway.test"),
                        },
                    }), "")
                if args[:2] == ["auth", "login"]:
                    session_saved = True
                    return subprocess.CompletedProcess(command, 0, '{"ok":true}', "")
                if args[:2] == ["auth", "status"]:
                    return subprocess.CompletedProcess(command, 0, json.dumps({
                        "ok": True, "data": {"session": {"authenticated": session_saved}},
                    }), "")
                return subprocess.CompletedProcess(command, 2, "", f"unexpected command: {command[1:3]}")

            journey = Journey("secured", "marketplace-auth-fixture")
            authenticate_secured_marketplace(journey, project, env, fake_run)

            self.assertEqual(journey.result().status, "PASS", journey.result().first_failure)
            self.assertEqual(journey.result().case_run["claims"], [
                {"claimId": "S-010.6", "kind": "journey", "status": "PASS"},
                {"claimId": "S-041.7", "kind": "journey", "status": "PASS"},
            ])
            self.assertIn(("kb", "marketplace", "plugins", "list", "--scope", "platform", "--json"), calls)
            self.assertLess(calls.index(("kb", "auth", "logout", "--json")),
                            calls.index(("kb", "marketplace", "plugins", "list", "--scope", "platform", "--json")))
            self.assertIn(("kb", "auth", "login", "--gateway-url", "http://gateway.test",
                           "--email", "admin@example.test", "--password-stdin", "--json"), calls)
            self.assertIn(("kb", "auth", "status", "--json"), calls)

    def test_marketplace_and_adapter_flows_claim_only_asserted_case_steps(self):
        with tempfile.TemporaryDirectory(prefix="kb-marketplace-journey-") as directory:
            home = Path(directory)
            project = home / "project-a"
            (project / ".kb").mkdir(parents=True)
            (project / ".kb" / "kb.config.json").write_text("{}\n")
            platform_root = home / "kb-platform"
            active_platform = create_test_install_container(platform_root)
            platform_config = active_platform / ".kb" / "kb.config.jsonc"
            platform_config.parent.mkdir(parents=True)
            platform_config.write_text(json.dumps({"gateway": {"access": {"mode": "local"}}}))
            receipt = active_platform / ".kb" / "v2" / "receipt.json"
            receipt.parent.mkdir(parents=True)
            receipt.write_text('{"version":"2.120.1"}\n')
            package = active_platform / "node_modules" / "@kb-labs" / "workflow-daemon" / "package.json"
            package.parent.mkdir(parents=True)
            package.write_text('{"name":"@kb-labs/workflow-daemon","version":"2.120.1"}\n')
            env = {"HOME": str(home), "KB_JOURNEY_PROJECT_ROOT": str(project),
                   "KB_JOURNEY_PLATFORM_ROOT": str(platform_root),
                   "KB_JOURNEY_PROJECT_ID": "prj_marketplace_fixture",
                   "KB_JOURNEY_BASE_URL": "http://gateway.test",
                   "KB_JOURNEY_SERVICE_TOKEN": "fixture-token",
                   "KB_JOURNEY_MARKETPLACE_PUBLISH_URL": "http://registry.test/api/v1",
                   "KB_JOURNEY_MARKETPLACE_AUTHOR_HANDLE": "journey"}
            calls: list[tuple[str, ...]] = []
            host_running = True
            registry_version = "2.120.1"
            published_versions: dict[str, str] = {}

            def lock(path: Path, *, platform: bool = False) -> dict:
                lock_file = path / ".kb" / "marketplace.lock"
                try:
                    return json.loads(lock_file.read_text())
                except FileNotFoundError:
                    return {"schema": "kb.marketplace/3", "plugins": {}, "adapters": {}} if platform else {
                        "schema": "kb.marketplace/3", "plugins": {}
                    }

            def save_lock(path: Path, value: dict) -> None:
                lock_file = path / ".kb" / "marketplace.lock"
                lock_file.parent.mkdir(parents=True, exist_ok=True)
                lock_file.write_text(json.dumps(value))

            save_lock(active_platform, {"schema": "kb.marketplace/3", "plugins": {
                "@kb-labs/commit": {"version": "2.120.1", "package": "@kb-labs/commit",
                                    "source": "platform", "integrity": "sha512-shipped"},
            }, "adapters": {}})

            def fake_run(command, *, cwd, env, capture_output, text, timeout):
                nonlocal host_running
                calls.append(tuple(command))
                cwd_path = Path(cwd)
                if command[0] == "kb-create":
                    if command[1] in ("start", "stop"):
                        host_running = command[1] == "start"
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True}), "")
                if command[0] == "npm":
                    package_id = command[2]
                    entity = _release_entity(package_id)
                    if entity is None:
                        return subprocess.CompletedProcess(command, 1, "", "package not present in release fixture")
                    version = published_versions.get(entity["package"], entity["version"])
                    return subprocess.CompletedProcess(command, 0, json.dumps(version), "")

                args = command[2:] if command[0] == "node" else command[1:]
                stdout = "{}"
                if args[:2] == ["hub", "publish"]:
                    package_path = Path(args[args.index("--path") + 1])
                    package = json.loads((package_path / "package.json").read_text())
                    published = {"handle": "fixture", "name": package["name"],
                                 "version": registry_version, "trust": "trusted"}
                    published_versions[published["name"]] = published["version"]
                    stdout = json.dumps(published)
                elif args[:2] == ["marketplace", "install"] and args[2] == "@kb-labs/not-published":
                    payload = {"ok": False, "error": {"code": "KB_PLUGIN_NOT_FOUND",
                        "message": "Plugin @kb-labs/not-published was not found in the registry.",
                        "hint": 'Check the exact package name and package source. If available, run `kb marketplace install @kb-labs/not-published`; `kb marketplace plugins list` shows installed plugins.'}}
                    if "--json" in args:
                        return subprocess.CompletedProcess(command, 1, json.dumps(payload), "")
                    error = payload["error"]
                    return subprocess.CompletedProcess(command, 1,
                        f"{error['message']} [{error['code']}]\n  Hint:  {error['hint']}\n", "")
                elif args[:2] == ["adapter", "bind"] and args[3] == "@kb-labs/adapters-not-installed":
                    payload = {"ok": False, "error": {"code": "KB_ADAPTER_NOT_INSTALLED",
                        "message": "Adapter package @kb-labs/adapters-not-installed is not installed on this platform.",
                        "hint": "kb marketplace install @kb-labs/adapters-not-installed --scope platform"}}
                    if "--json" in args:
                        return subprocess.CompletedProcess(command, 1, json.dumps(payload), "")
                    error = payload["error"]
                    return subprocess.CompletedProcess(command, 1,
                        f"{error['message']} [{error['code']}]\n  Hint:  {error['hint']}\n", "")
                elif args[:3] == ["marketplace", "plugins", "doctor"]:
                    policy_config = json.loads((cwd_path / ".kb" / "kb.config.json").read_text())
                    if policy_config.get("plugins", {}).get("block") == 7:
                        return subprocess.CompletedProcess(command, 1, json.dumps({"ok": False, "error": {
                            "code": "KB_RUNTIME_COMMAND_FAILED", "message": "Marketplace doctor found issues", "hint": "Run doctor",
                            "diagnostics": [{"code": "PLUGIN_POLICY_TYPE_INVALID", "severity": "error",
                                "path": str(cwd_path / ".kb" / "kb.config.json"),
                                "message": "@kb-labs/e2e-analytics-emitter is unavailable: plugins.block must be an array",
                                "hint": "Repair config; kb marketplace plugins doctor --scope project"}],
                        }}), "")
                    if env.get("GATEWAY_PORT") == "not-a-port":
                        return subprocess.CompletedProcess(command, 1, json.dumps({
                            "ok": False,
                            "error": {
                                "code": "KB_CONFIG_INVALID",
                                "message": 'Environment variable "GATEWAY_PORT" must be an integer from 1 through 65535.',
                                "hint": 'Run "unset GATEWAY_PORT", then retry the command to use the service default port.',
                            },
                        }), "")
                    if host_running:
                        stdout = json.dumps({"ok": True, "data": {"total": 0, "issues": []}})
                    else:
                        return subprocess.CompletedProcess(command, 1, json.dumps({
                            "ok": False,
                            "error": {
                                "code": "KB_HOST_UNREACHABLE",
                                "message": "The platform host is unreachable.",
                                "hint": 'Run "kb-create start", or "kb-create doctor" if the host should already be running.',
                            },
                        }), "")
                elif args[:3] == ["journey", "analytics", "emit"]:
                    policy = json.loads((cwd_path / ".kb" / "kb.config.json").read_text())
                    installed = any(entry.get("package") == "@kb-labs/e2e-analytics-emitter"
                                    for entry in lock(cwd_path)["plugins"].values())
                    if policy.get("plugins", {}).get("block") == 7 or not installed:
                        return subprocess.CompletedProcess(command, 1, json.dumps({"ok": False, "error": {
                            "code": "KB_RUNTIME_COMMAND_NOT_FOUND", "message": "Unknown command journey analytics emit", "hint": "Run kb help",
                        }}), "")
                    return subprocess.CompletedProcess(command, 0, "", "")
                elif args[:1] == ["version"]:
                    stdout = json.dumps({"version": "1.0.0"})
                elif args[:2] == ["marketplace", "install"]:
                    exact_version = args[2].count("@") > 1
                    if exact_version:
                        package_id, version = args[2].rsplit("@", 1)
                    else:
                        package_id, version = args[2], registry_version
                    entity = _release_entity(package_id)
                    if entity is None:
                        error = {
                            "code": "KB_PLUGIN_NOT_FOUND",
                            "message": catalogued_error_message("KB_PLUGIN_NOT_FOUND").format(plugin=package_id),
                            "hint": catalogued_error_hint("KB_PLUGIN_NOT_FOUND", plugin=package_id),
                            "cause": "registry: not-found-unowned; npm: not-found-unowned",
                        }
                        if "--json" in args:
                            return subprocess.CompletedProcess(command, 1, json.dumps({"ok": False, "error": error}), "")
                        return subprocess.CompletedProcess(command, 1,
                            f"{error['message']} [{error['code']}]\nHint: {error['hint']}\n", "")
                    plugin_id = entity["id"]
                    package_name = entity["package"]
                    if not exact_version:
                        version = published_versions.get(package_name, version)
                    platform = "--scope" in args and args[args.index("--scope") + 1] == "platform"
                    lock_root = active_platform if platform else cwd_path
                    value = lock(lock_root, platform=platform)
                    value.setdefault("adapters", {})
                    collection = value["plugins"]
                    collection[plugin_id] = {
                        "version": version, "integrity": "sha512-fixture", "source": "marketplace",
                        "marketplaceSource": "npm", "signatureStatus": "unsigned",
                        "enabled": True, "package": package_name,
                    }
                    save_lock(lock_root, value)
                    stdout = json.dumps({
                        "installed": [{"id": plugin_id, "version": version, "source": "npm",
                                       "signatureStatus": "unsigned"}],
                        "warnings": [],
                        "scope": "platform" if platform else "project",
                    })
                elif args[:3] == ["marketplace", "plugins", "list"]:
                    platform_scope = "--scope" in args and args[args.index("--scope") + 1] == "platform"
                    value = lock(active_platform if platform_scope else cwd_path, platform=platform_scope)
                    entries = [{"id": package_id, **entry} for package_id, entry in value["plugins"].items()]
                    if "--json" in args:
                        stdout = json.dumps({"entries": entries})
                    else:
                        enabled_count = sum(1 for entry in entries if entry.get("enabled", True))
                        disabled_count = len(entries) - enabled_count
                        rows = [f"{'✅' if entry.get('enabled', True) else '⏸'} {entry['id']} {entry.get('version', '')}"
                                for entry in entries]
                        stdout = (f"{len(entries)} plugins ({enabled_count} enabled, {disabled_count} disabled) — scope=project\n"
                                  + "\n".join(rows))
                elif args[:4] in (["marketplace", "plugins", "disable", "@kb-labs/commit"],
                                  ["marketplace", "plugins", "enable", "@kb-labs/commit"]):
                    value = lock(cwd_path)
                    entry = value["plugins"].get("@kb-labs/commit")
                    if not isinstance(entry, dict):
                        return subprocess.CompletedProcess(command, 1, json.dumps({"ok": False}), "")
                    enabled = args[2] == "enable"
                    entry["enabled"] = enabled
                    save_lock(cwd_path, value)
                    stdout = f"{'Enabled' if enabled else 'Disabled'} @kb-labs/commit (project)\n"
                elif args[:3] == ["marketplace", "plugins", "disable"]:
                    return subprocess.CompletedProcess(command, 1, "", "Plugin @kb-labs/not-installed was not found.\n")
                elif args[:3] == ["marketplace", "update", "@kb-labs/commit"]:
                    value = lock(cwd_path)
                    entry = value["plugins"]["@kb-labs/commit"]
                    entry["version"] = "3.0.0"
                    entry["integrity"] = "sha512-updated-fixture"
                    save_lock(cwd_path, value)
                    stdout = json.dumps({"scope": "project", "warnings": [],
                        "installed": [{"id": "@kb-labs/commit", "version": "3.0.0", "primaryKind": "plugin"}]})
                elif args[:3] == ["marketplace", "update", "@kb-labs/not-published"]:
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "data": {"scope": "project",
                        "warnings": ["Plugin @kb-labs/not-published was not found in the registry."]}}), "")
                elif args[:2] == ["commit", "--help"]:
                    if lock(cwd_path)["plugins"].get("@kb-labs/commit", {}).get("enabled") is False:
                        return subprocess.CompletedProcess(command, 1, "", "Command not found: commit")
                    stdout = "Commands: commit plan show"
                elif args == ["review", "--help"]:
                    installed = _release_entity("@kb-labs/review")["id"] in lock(cwd_path)["plugins"]
                    return subprocess.CompletedProcess(command, 0 if installed else 2, "", "")
                elif args[:3] == ["commit", "plan", "show"]:
                    value = lock(cwd_path)
                    if "@kb-labs/commit" not in value["plugins"]:
                        return subprocess.CompletedProcess(command, 2, json.dumps({"ok": False, "error": {
                            "code": "KB_RUNTIME_UNKNOWN_COMMAND",
                            "message": "Unknown command: commit plan show",
                            "hint": 'Check the command name or run "kb --help" to list available commands.',
                        }}), "")
                    stdout = json.dumps({"hasPlan": False})
                elif args[:2] == ["marketplace", "uninstall"]:
                    platform = "--scope" in args and args[args.index("--scope") + 1] == "platform"
                    lock_root = active_platform if platform else cwd_path
                    value = lock(lock_root, platform=platform)
                    value["plugins"].pop("@kb-labs/commit" if args[2] == "@kb-labs/commit" else args[2], None)
                    save_lock(lock_root, value)
                    stdout = json.dumps({"ok": True})
                elif args[:2] == ["workflow", "health"]:
                    stdout = json.dumps({"ok": True, "data": {"status": "healthy"}})
                elif args[:3] == ["qa", "cases", "list"]:
                    stdout = json.dumps({"schema": "kb.qa-case-list/v1", "cases": [], "diagnostics": []})
                elif args[:2] == ["project", "add"]:
                    root = Path(args[2])
                    (root / ".kb").mkdir(parents=True, exist_ok=True)
                    (root / ".kb" / "kb.config.json").write_text("{}\n")
                    stdout = json.dumps({"ok": True})
                elif args[:2] == ["adapter", "bind"]:
                    if "--dry-run" not in args:
                        config_file = cwd_path / ".kb" / "kb.config.json"
                        config = json.loads(config_file.read_text())
                        config.setdefault("platform", {}).setdefault("adapters", {})["storage"] = args[3]
                        config_file.write_text(json.dumps(config))
                    stdout = json.dumps({"ok": True, "dryRun": "--dry-run" in args})
                elif args[:2] == ["config", "set"]:
                    config_file = cwd_path / ".kb" / "kb.config.json"
                    config = json.loads(config_file.read_text())
                    config.setdefault("platform", {}).setdefault("adapterOptions", {})["storage"] = json.loads(args[3])
                    config_file.write_text(json.dumps(config))
                    stdout = json.dumps({"ok": True, "scope": "project"})
                elif args[:2] == ["workflow", "run"]:
                    stdout = json.dumps({"ok": True, "data": {"runId": "run-fixture"}})
                elif args[:3] == ["workflow", "runs", "watch"]:
                    stdout = "Run SUCCESS\n"
                elif args[:2] == ["adapter", "unbind"]:
                    config_file = cwd_path / ".kb" / "kb.config.json"
                    config = json.loads(config_file.read_text())
                    del config["platform"]["adapters"]["storage"]
                    config_file.write_text(json.dumps(config))
                    stdout = json.dumps({"ok": True})
                elif args[:2] == ["project", "remove"]:
                    stdout = json.dumps({"ok": True})
                else:
                    return subprocess.CompletedProcess(command, 2, "", f"unexpected command: {command}")
                if "--json" in args and stdout.lstrip().startswith("{"):
                    envelope = json.loads(stdout)
                    if envelope.get("ok") is True and "data" not in envelope:
                        envelope = {"ok": True, "data": {key: value for key, value in envelope.items() if key != "ok"}}
                    elif "ok" not in envelope:
                        envelope = {"ok": True, "data": envelope}
                    stdout = json.dumps(envelope)
                return subprocess.CompletedProcess(command, 0, stdout, "")

            http_calls = []
            route_observations = []
            commit_case_hook_calls = []

            class FakeResponse:
                headers = {}

                def __init__(self, status, payload):
                    self.status = status
                    self.payload = payload

                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    return None

                def read(self):
                    return json.dumps(self.payload).encode()

            rest_route_table = {"plugins/commit/status"}

            def fake_http(request, timeout):
                http_calls.append((request.full_url, request.get_header("Authorization"), timeout))
                path = urlparse(request.full_url).path
                project_marker = "/rest/"
                service_path = path.split(project_marker, 1)[1] if project_marker in path else ""
                if "/unknown-service/" in path:
                    return FakeResponse(404, {"ok": False, "error": {
                        "code": "KB_PROJECT_SERVICE_NOT_FOUND",
                        "message": "Project service was not found.",
                        "hint": "Check the project service ID and retry the request.",
                        "correlationId": "request-fixture"}})
                if request.full_url.endswith("/health"):
                    return FakeResponse(200, {"ok": True, "data": {"projectRuntimes": {"runtimes": []}}})
                if service_path in rest_route_table:
                    route_observations.append((
                        "@kb-labs/commit" in lock(active_platform, platform=True)["plugins"],
                        "@kb-labs/commit" in lock(project)["plugins"],
                    ))
                if service_path in rest_route_table and "@kb-labs/commit" in lock(project)["plugins"]:
                    return FakeResponse(200, {"ok": True, "data": {"scope": "root", "hasPlan": False}})
                error_code = "KB_RUNTIME_RESOURCE_NOT_FOUND" if service_path not in rest_route_table else "KB_PLUGIN_NOT_INSTALLED"
                message = "Project service was not found." if error_code == "KB_RUNTIME_RESOURCE_NOT_FOUND" else "Plugin is not installed in this project."
                return FakeResponse(404, {"ok": False, "error": {
                    "code": error_code,
                    "message": message,
                    "hint": "Run `kb marketplace install @kb-labs/commit` in this project.",
                    "correlationId": "request-fixture"}})

            def fake_commit_case_hook():
                self.assertIn("@kb-labs/commit", lock(project)["plugins"])
                commit_case_hook_calls.append(True)

            journey = Journey("local", "marketplace-fixture")
            fixture_entry = prepare_commit_project_fixture(journey, project, "http://registry.test", env, fake_run)
            self.assertIsNotNone(fixture_entry, journey.steps)
            self.assertEqual(fixture_entry, json.loads((project / ".kb" / "marketplace.lock").read_text())[
                "plugins"]["@kb-labs/commit"])
            registry_version = "2.120.9"
            def fail_unrelated_policy_claim(journey, *_args, **_kwargs):
                journey.step("malformed project plugin policy diagnostic", "marketplace",
                             lambda: "replayed j54 S-203.25 failure", cases=["S-203.25"])
            def fail_unrelated_error_claim(*_args, **_kwargs):
                raise AssertionError("independent S-051 envelope assertion failed")
            with patch("marketplace_steps.run_plugin_policy_diagnostic_step", side_effect=fail_unrelated_policy_claim), \
                    patch("marketplace_steps.validate_shared_failure", side_effect=fail_unrelated_error_claim), \
                    patch("marketplace_steps.publish_commit_update_fixture", return_value="3.0.0"):
                run_marketplace_steps(journey, project, "prj_marketplace_fixture", "http://registry.test", env, fake_run, fake_http,
                                      commit_case_hook=fake_commit_case_hook, fixture_entry=fixture_entry)

            expected = {f"S-{case}.{step}" for case, steps in (("010", range(1, 6)), ("011", range(1, 7)), ("012", range(1, 5)), ("047", range(1, 4)), ("192", range(1, 7))) for step in steps}
            expected.update({
                "S-010.7",
                "S-051.2", "S-051.3", "S-051.4",
                "S-203.14", "S-203.15", "S-203.16",
                "S-203.25",
                "S-192.7",
            })
            actual = {claim["claimId"] for claim in journey.result().case_run["claims"]}
            claims_by_id = {claim["claimId"]: claim["status"]
                            for claim in journey.result().case_run["claims"]}
            self.assertEqual(journey.result().status, "FAIL")
            self.assertEqual(claims_by_id["S-051.2"], "FAIL")
            self.assertEqual(claims_by_id["S-203.25"], "FAIL")
            self.assertEqual(claims_by_id["S-192.1"], "PASS")
            self.assertEqual(actual, expected, [(step.name, step.status, step.message) for step in journey.steps])
            self.assertEqual(commit_case_hook_calls, [True])
            self.assertFalse(any("hub" in call for call in calls))
            pinned_commit = f"@kb-labs/commit@{fixture_entry['version']}"
            self.assertIn(("kb", "marketplace", "install", pinned_commit, "--json"), calls)
            self.assertIn(("kb", "marketplace", "install", pinned_commit,
                           "--scope", "platform", "--json"), calls)
            self.assertIn(("npm", "view", "@kb-labs/review", "version", "--json",
                           "--registry=http://registry.test"), calls)
            self.assertIn(("kb", "marketplace", "uninstall", "@kb-labs/commit",
                           "--scope", "platform", "--json"), calls)
            self.assertEqual([call[0] for call in http_calls], [
                "http://gateway.test/api/v1/projects/prj_marketplace_fixture/unknown-service/health",
                "http://gateway.test/health",
                "http://gateway.test/api/v1/projects/prj_marketplace_fixture/rest/plugins/commit/status",
                "http://gateway.test/api/v1/projects/prj_marketplace_fixture/rest/plugins/commit/status",
                "http://gateway.test/api/v1/projects/prj_marketplace_fixture/rest/plugins/commit/status",
                "http://gateway.test/api/v1/projects/prj_marketplace_fixture/rest/plugins/commit/status",
                "http://gateway.test/api/v1/projects/prj_marketplace_fixture/rest/api/v1/plugins/commit/status",
            ])
            self.assertTrue(all(call[1] == "Bearer fixture-token" for call in http_calls))
            self.assertEqual(route_observations[0], (False, False))
            self.assertEqual(route_observations[-3], (False, True))
            self.assertEqual(route_observations[-2], (False, False))
            self.assertNotIn(("npm", "view", "@kb-labs/adapters-fs", "version", "--json", "--registry=http://registry.test"), calls)
            self.assertNotIn(("kb", "marketplace", "install", "@kb-labs/adapters-fs@2.107.0", "--scope", "platform", "--json"), calls)
            self.assertIn(("kb", "review", "--help"), calls)
            self.assertIn(("kb", "marketplace", "plugins", "doctor", "--scope", "project", "--json"), calls)
            self.assertNotIn("port", json.loads(platform_config.read_text())["gateway"])
            self.assertFalse(any(item.name.startswith("kb-marketplace-project-b-") for item in home.iterdir()))

            lock_path = project / ".kb" / "marketplace.lock"
            self.assertIn("@kb-labs/commit", json.loads(lock_path.read_text())["plugins"])
            fixture_file = home / "summary" / "project-fixtures-local.json"
            env["KB_JOURNEY_PROJECT_FIXTURES_FILE"] = str(fixture_file)
            graph = FlowGraph(journey, {"marketplace-fixtures": ("marketplace-available",)})
            probe = graph.probe_state("marketplace-available", "marketplace", "marketplace install", lambda: (
                None if "@kb-labs/commit" in json.loads(lock_path.read_text()).get("plugins", {})
                else "Commit fixture is absent from the project marketplace lock"
            ))
            self.assertEqual(probe.status, "PASS")

            previous_environment = {key: os.environ.get(key) for key in (
                "KB_JOURNEY_PROJECT_B_ID", "KB_JOURNEY_PROJECT_B_ROOT")}
            downstream = []
            try:
                with patch("service_runner.prepare_mcp_projects", return_value=("prj_fixture_b", str(home / "project-b"))):
                    handoff = graph.flow("prepare MCP project fixtures", "marketplace-fixtures", "mcp",
                                         lambda: service_runner._prepare_mcp_projects(
                                             "prj_marketplace_fixture", str(project), "registry", env))
                self.assertEqual(handoff, "PASS")
                self.assertTrue(fixture_file.is_file())
                self.assertEqual(json.loads(fixture_file.read_text())["projectAId"], "prj_marketplace_fixture")
                downstream_flow = graph.flow("fixture-dependent downstream flow", "marketplace-fixtures", "downstream",
                                              lambda: downstream.append("ran"))
                self.assertEqual(downstream_flow, "PASS")
                self.assertEqual(downstream, ["ran"])
            finally:
                for key, value in previous_environment.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value

            lifecycle_assertions = [
                step.name for step in journey.steps
                if step.capability == "marketplace"
                and step.name != "restore Commit project fixture after marketplace lifecycle"
            ]
            self.assertGreater(len(lifecycle_assertions), 20)
            original_commit_entry = dict(fixture_entry)
            all_case_claims = {case_id for step in journey.steps for case_id in step.cases}
            modes = (
                ("batch", set()),
                ("selected", set(all_case_claims)),
            )
            for mode_name, selected_steps in modes:
                for index, failpoint in enumerate(lifecycle_assertions):
                    with self.subTest(mode=mode_name, lifecycle_assertion=failpoint):
                        registry_version = "2.120.1"
                        save_lock(project, {"schema": "kb.marketplace/3", "plugins": {
                            "@kb-labs/commit": dict(original_commit_entry),
                        }})
                        save_lock(active_platform, {"schema": "kb.marketplace/3", "plugins": {}, "adapters": {}})
                        trial = Journey("local", f"marketplace-failure-{mode_name}-{index}")
                        trial.selected_steps = set(selected_steps)
                        trial.selected_claims = set(selected_steps)
                        if selected_steps:
                            trial.selected_capabilities = {"marketplace"}
                    trial_fixture_entry = prepare_commit_project_fixture(
                        trial, project, "http://registry.test", env, fake_run)
                    self.assertEqual(trial_fixture_entry, original_commit_entry)
                    registry_version = "2.120.9"
                    requirements: dict[str, tuple[str, ...]] = {}
                    original_step = trial.step

                    def record_requirements(name, capability, check, cases=(), details=None, *,
                                            requires=(), role="step", runners=()):
                        requirements[name] = tuple(Dependency.parse(item).name for item in requires)
                        return original_step(name, capability, check, cases=cases, details=details,
                                             requires=requires, role=role, runners=runners)

                    trial.step = record_requirements
                    checked_steps = []

                    def inject_selected_failure(name, check, selected=failpoint):
                        checked_steps.append(name)
                        if name == selected:
                            return f"injected assertion failure at {selected}"
                        return check()

                    trial.step_guard = inject_selected_failure
                    with patch("marketplace_steps.run_plugin_policy_diagnostic_step",
                               side_effect=fail_unrelated_policy_claim), \
                            patch("marketplace_steps.validate_shared_failure",
                                  side_effect=fail_unrelated_error_claim), \
                            patch("marketplace_steps.publish_commit_update_fixture", return_value="3.0.0"):
                        run_marketplace_steps(trial, project, "prj_marketplace_fixture", "http://registry.test", env, fake_run, fake_http,
                                              commit_case_hook=fake_commit_case_hook,
                                              fixture_entry=trial_fixture_entry)
                    self.assertEqual(
                        next(step.status for step in trial.steps if step.name == failpoint), "FAIL")
                    final_lock = json.loads(lock_path.read_text())
                    final_entry = final_lock.get("plugins", {}).get("@kb-labs/commit")
                    self.assertEqual(final_lock.get("schema"), "kb.marketplace/3")
                    self.assertEqual(final_entry, original_commit_entry)

                    status_by_name = {step.name: step for step in trial.steps}
                    blocked_dependents = set()
                    changed = True
                    while changed:
                        changed = False
                        for name, prereqs in requirements.items():
                            if name not in blocked_dependents and any(
                                    required == failpoint or required in blocked_dependents
                                    for required in prereqs):
                                blocked_dependents.add(name)
                                changed = True
                    claims_by_id = {
                        claim["claimId"]: claim["status"]
                        for claim in trial.result().case_run["claims"]
                    }
                    for dependent_name in blocked_dependents:
                        dependent = status_by_name[dependent_name]
                        self.assertEqual(dependent.status, "BLOCKED", dependent_name)
                        self.assertTrue(dependent.details.get("prerequisiteFailures"), dependent_name)
                        for claim_id in dependent.cases:
                            self.assertNotIn(claim_id, claims_by_id, f"blocked claim {claim_id} must not be emitted")
                    for independent_name in lifecycle_assertions:
                        if independent_name != failpoint and independent_name not in blocked_dependents:
                            self.assertIn(independent_name, checked_steps, independent_name)

                    failure_graph = FlowGraph(
                        trial,
                        {"marketplace-fixtures": ("marketplace-available",),
                         "marketplace-lifecycle": ("marketplace-available",)},
                        groups={
                            "marketplace-lifecycle": {
                                "capabilities": {"marketplace"},
                                "depends_on": ("marketplace-available",),
                                "cases": tuple(all_case_claims),
                            },
                            "marketplace-fixtures": {
                                "capabilities": set(),
                                "depends_on": ("marketplace-available",),
                                "cases": tuple(all_case_claims),
                            },
                        },
                    )
                    state_probe = failure_graph.probe_state(
                        "marketplace-available", "marketplace-fixture-producer", "Commit project fixture",
                        lambda: None if "@kb-labs/commit" in json.loads(lock_path.read_text()).get("plugins", {})
                        else "Commit fixture is absent from the project marketplace lock",
                    )
                    self.assertEqual(state_probe.status, "PASS")
                    downstream = []
                    with patch("service_runner.prepare_mcp_projects",
                                  return_value=("prj_fixture_b", str(home / "project-b"))):
                        handoff = failure_graph.flow(
                            "prepare MCP project fixtures", "marketplace-fixtures", "mcp",
                            lambda: service_runner._prepare_mcp_projects(
                                "prj_marketplace_fixture", str(project), "registry", env))
                    self.assertEqual(handoff, "PASS")
                    self.assertTrue(fixture_file.is_file())
                    self.assertEqual(json.loads(fixture_file.read_text())["projectAId"],
                                     "prj_marketplace_fixture")
                    self.assertEqual(failure_graph.flow(
                        "fixture-dependent downstream flow", "marketplace-fixtures", "downstream",
                        lambda: downstream.append(failpoint)), "PASS")
                    self.assertEqual(downstream, [failpoint])


if __name__ == "__main__":
    unittest.main()
