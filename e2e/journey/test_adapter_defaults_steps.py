import json
import os
import shlex
import hashlib
import io
import subprocess
import sys
import tempfile
import unittest
import unicodedata
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from adapter_defaults_steps import (_assert_missing_embeddings, _assert_missing_vector_store, _assert_vector_store_restart,
                                    _assert_no_network_defaults, _assert_required_upstreams_ready, _json, _restore_platform_adapter_fixture,
                                    _run_from_registered_project, run_adapter_default_steps,
                                    _assert_no_project_adapter_config, _assert_missing_gateway_dispatch_error)
from sdk_runtime_import_check import check_installed_runtime_imports
from invocations import invocation_context
import jsonl
from service_steps import Journey
from test_install_layout import create_test_install_container
from invocations import catalogued_error_hint, catalogued_error_message


class InstalledDefaultAdapterGapTests(unittest.TestCase):
    # case: S-054.6
    def test_missing_vector_store_journey_rejects_stack_trace_output(self):
        with tempfile.TemporaryDirectory(prefix="journey-vector-missing-") as directory:
            project = Path(directory) / "project"
            project.mkdir()
            env = {"HOME": directory, "KB_JOURNEY_SERVICE_TOKEN": "journey-token"}
            platform_root = Path(directory) / "platform"
            error = {"ok": False, "error": {
                "code": "KB_ADAPTER_CREDENTIALS_MISSING",
                "message": "Adapter embeddings is missing OPENAI_API_KEY.",
                "details": {"service": "embeddings"},
            }}

            def runner(command, **kwargs):
                if command[:2] == ["kb-create", "status"]:
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "data": {
                        "host": {"healthUrl": "http://gateway.test/health"},
                    }}), "")
                return subprocess.CompletedProcess(command, 1, json.dumps(error), "Traceback (most recent call last):")

            def fake_open_http(_urlopen, request, *, timeout, env):
                return 200, json.dumps({"ok": True, "data": None}).encode(), {}

            with patch("adapter_defaults_steps.open_http", side_effect=fake_open_http):
                with self.assertRaisesRegex(RuntimeError, "printed a stack trace"):
                    _assert_missing_vector_store(runner, env, project, platform_root)

    # case: S-054.24
    def test_implicit_embeddings_reports_missing_key_and_exact_command(self):
        project = Path(tempfile.mkdtemp(prefix="journey-embeddings-default-"))
        env = {"HOME": str(project), "OPENAI_API_KEY": "", "KB_JOURNEY_SERVICE_TOKEN": "journey-token"}
        calls = []

        def cli(command):
            calls.append(command)
            return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "data": {}}), "")

        def runner(command, **kwargs):
            if command[:2] == ["kb-create", "status"]:
                return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "data": {
                    "host": {"healthUrl": "http://gateway.test/health"},
                }}), "")
            error = {
                "code": "KB_ADAPTER_CREDENTIALS_MISSING",
                "message": "Adapter embeddings is missing OPENAI_API_KEY.",
                "details": {
                    "service": "embeddings",
                    "credential": "OPENAI_API_KEY",
                    "command": "kb config set --scope platform platform.adapterOptions.embeddings.apiKey '${OPENAI_API_KEY}' --allow-missing-env",
                },
                "actions": [{
                    "command": "kb config set --scope platform platform.adapterOptions.embeddings.apiKey '${OPENAI_API_KEY}' --allow-missing-env",
                }],
                "hint": "No request was sent",
            }
            return subprocess.CompletedProcess(command, 1, json.dumps({"ok": False, "error": error}), "")

        def fake_open_http(_urlopen, request, *, timeout, env):
            payload = json.loads(request.data)
            self.assertEqual(request.full_url, "http://gateway.test/platform/v1/vectorStore/upsert")
            self.assertEqual(request.get_header("Authorization"), "Bearer journey-token")
            self.assertEqual(payload["args"][1], "default")
            self.assertEqual(payload["args"][0][0]["id"], "s054-embeddings-credential-probe")
            return 200, json.dumps({"ok": True, "data": None}).encode(), {}

        rows = {"embeddings": {
            "implementation": "@kb-labs/adapters-openai/embeddings",
            "credentialsStatus": "missing",
            "missingCredentials": ["OPENAI_API_KEY"],
        }}
        with patch("adapter_defaults_steps.open_http", side_effect=fake_open_http):
            _assert_missing_embeddings(runner, env, project, project / "platform",
                                        cli, lambda _project: rows)
        self.assertEqual(calls, [["marketplace", "install", "@kb-labs/mind", "--scope", "platform", "--json"]])

    # case: S-054.25
    def test_vector_default_survives_host_restart_through_platform_api(self):
        with tempfile.TemporaryDirectory(prefix="journey-vector-restart-") as directory:
            project = Path(directory) / "project"
            project.mkdir()
            platform_root = Path(directory) / "platform"
            project_id = "fixture-project"
            kb_home = Path(directory) / ".kb"
            kb_home.mkdir()
            (kb_home / "projects.json").write_text(json.dumps({"projects": [
                {"id": project_id, "path": str(project.resolve())},
            ]}))
            env = {"HOME": directory, "KB_HOME": str(kb_home), "KB_JOURNEY_SERVICE_TOKEN": "journey-token"}
            commands = []
            records = {}

            def runner(command, **kwargs):
                commands.append(command)
                if command[:2] == ["kb-create", "status"]:
                    body = json.dumps({"ok": True, "data": {
                        "host": {"healthUrl": "http://gateway.test/health"},
                    }})
                    return subprocess.CompletedProcess(command, 0, body, "")
                return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "data": {}}), "")

            def fake_open_http(_urlopen, request, *, timeout, env):
                self.assertEqual(request.get_header("Authorization"), "Bearer journey-token")
                payload = json.loads(request.data)
                if request.full_url.endswith("/upsert"):
                    records[payload["args"][1], payload["args"][0][0]["id"]] = payload["args"][0][0]
                    vector_database = kb_home / "state" / project_id / "vector-store" / "vectors.sqlite"
                    vector_database.parent.mkdir(parents=True, exist_ok=True)
                    vector_database.touch()
                    result = None
                else:
                    namespace = payload["args"][3]
                    result = [{
                        "id": record["id"], "score": 1, "metadata": record["metadata"],
                    } for (record_namespace, _), record in records.items() if record_namespace == namespace]
                return 200, json.dumps({"ok": True, "data": result}).encode(), {}

            vector_rows = {"vectorStore": {
                "implementation": "@kb-labs/adapters-sqlite/vector-store",
            }}
            with patch("adapter_defaults_steps.open_http", side_effect=fake_open_http):
                _assert_vector_store_restart(runner, env, project, platform_root, lambda _args: None,
                                             lambda _project: vector_rows)
            self.assertIn(["kb-create", "restart", "--platform-root", str(platform_root)], commands)

    # case: S-054.18
    def test_installed_defaults_require_no_project_written_adapter_config(self):
        with tempfile.TemporaryDirectory(prefix="journey-project-default-config-") as directory:
            project = Path(directory)
            (project / ".kb").mkdir()

            _assert_no_project_adapter_config(project)

            (project / ".kb" / "kb.config.jsonc").write_text("{}\n")
            with self.assertRaisesRegex(RuntimeError, "user-written adapter config"):
                _assert_no_project_adapter_config(project)

    # case: S-054.19
    def test_missing_gateway_dispatch_error_is_catalogued_and_correlated(self):
        error = {
            "code": "KB_HOST_SERVICE_ADDRESS_MISSING",
            "message": catalogued_error_message("KB_HOST_SERVICE_ADDRESS_MISSING"),
            "hint": catalogued_error_hint("KB_HOST_SERVICE_ADDRESS_MISSING"),
            "details": {"service": "gateway"},
            "correlationId": "corr-missing-gateway",
        }
        result = subprocess.CompletedProcess(
            ["kb", "workflow", "run", "--workflow-id=e2e-hello", "--json"],
            1, json.dumps({"ok": False, "error": error}), "",
        )

        _assert_missing_gateway_dispatch_error(result)

    def test_missing_gateway_dispatch_error_rejects_other_service_or_no_correlation(self):
        error = {
            "code": "KB_HOST_SERVICE_ADDRESS_MISSING",
            "message": catalogued_error_message("KB_HOST_SERVICE_ADDRESS_MISSING"),
            "hint": catalogued_error_hint("KB_HOST_SERVICE_ADDRESS_MISSING"),
            "details": {"service": "state-broker"},
        }
        result = subprocess.CompletedProcess(
            ["kb", "workflow", "run", "--workflow-id=e2e-hello", "--json"],
            1, json.dumps({"ok": False, "error": error}), "",
        )

        with self.assertRaisesRegex(RuntimeError, "gateway.*correlation"):
            _assert_missing_gateway_dispatch_error(result)


class AdapterDefaultJourneyTests(unittest.TestCase):
    # case: S-054.4
    def test_network_requirement_check_excludes_slots_that_require_configuration(self):
        rows = {
            "storage": {"networkRequired": False, "mode": "real"},
            "llm": {"networkRequired": True, "mode": "real", "credentialsStatus": "missing"},
            "embeddings": {"networkRequired": True, "mode": "real", "credentialsStatus": "missing"},
            "serviceTransport": {"networkRequired": True, "mode": "unconfigured", "requiresConfiguration": True},
        }
        _assert_no_network_defaults(rows, lambda: None)

        rows["storage"] = {"networkRequired": True, "mode": "real"}
        with self.assertRaisesRegex(RuntimeError, "built-in default reports a network dependency"):
            _assert_no_network_defaults(rows, lambda: None)

    # case: S-054.16
    def test_installed_runtime_import_check_names_missing_module_and_importer(self):
        with tempfile.TemporaryDirectory(prefix="kb-installed-runtime-imports-") as directory:
            root = Path(directory)
            sdk = root / "node_modules" / "@kb-labs" / "sdk"
            (sdk / "dist").mkdir(parents=True)
            (sdk / "package.json").write_text(json.dumps({
                "name": "@kb-labs/sdk",
                "type": "module",
                "exports": {".": {"import": "./dist/index.js"}},
                "dependencies": {"@kb-labs/sdk-runtime-dependency": "1.0.0"},
                "peerDependencies": {"@kb-labs/shared-testing": "^2.0.0"},
                "peerDependenciesMeta": {"@kb-labs/shared-testing": {"optional": True}},
            }))
            (sdk / "dist" / "index.js").write_text('import "@kb-labs/sdk-runtime-dependency";\n')
            plugin = root / "node_modules" / "@kb-labs" / "e2e-plugin"
            (plugin / "dist" / "commands").mkdir(parents=True)
            (plugin / "dist" / "setup").mkdir(parents=True)
            (plugin / "package.json").write_text(json.dumps({
                "name": "@kb-labs/e2e-plugin",
                "type": "module",
                "exports": {
                    ".": {"import": "./dist/index.js"},
                    "./dist/runtime/*": {"node": "./dist/runtime/*"},
                    "./dist/widgets/*": {"browser": "./dist/widgets/*"},
                },
            }))
            (plugin / "dist" / "manifest.json").write_text(json.dumps({
                "schema": "kb.plugin/3",
                "id": "@kb-labs/e2e-plugin",
                "setup": {"handler": "./setup/handler.js"},
                "cli": {"commands": [{"path": "workflow test", "handler": "./commands/handler.js"}]},
            }))
            (plugin / "dist" / "index.js").write_text('import "@kb-labs/shared-command-kit";\n')
            (plugin / "dist" / "commands" / "handler.js").write_text('import "@kb-labs/shared-command-kit";\n')
            (plugin / "dist" / "setup" / "handler.js").write_text('import "@kb-labs/shared-command-kit";\n')
            runtime_wildcard = plugin / "dist" / "runtime"
            runtime_wildcard.mkdir()
            (runtime_wildcard / "wildcard-runtime.js").write_text('import "@kb-labs/runtime-wildcard-dependency";\n')
            (plugin / "dist" / "widgets").mkdir()
            (plugin / "dist" / "widgets" / "remoteEntry.js").write_text('throw new Error("browser-only remote entry");\n')
            platform_runtime = root / "node_modules" / "@kb-labs" / "core-runtime"
            resolver_parent = platform_runtime / "node_modules" / "@kb-labs"
            resolver_parent.mkdir(parents=True)
            (platform_runtime / "package.json").write_text(json.dumps({
                "name": "@kb-labs/core-runtime",
                "dependencies": {"@kb-labs/core-platform": "2.0.0"},
            }))
            workspace_platform = Path(__file__).resolve().parents[2] / "core" / "platform"
            (resolver_parent / "core-platform").symlink_to(workspace_platform, target_is_directory=True)
            receipt = root / ".kb" / "v2" / "receipt.json"
            receipt.parent.mkdir(parents=True)
            receipt.write_text(json.dumps({"plan": {"artifacts": [
                {"kind": "plugin", "package": "@kb-labs/e2e-plugin"},
            ]}}))

            result = check_installed_runtime_imports(root)

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("@kb-labs/shared-command-kit", result.stdout + result.stderr)
            self.assertIn("@kb-labs/sdk", result.stdout + result.stderr)
            self.assertIn("@kb-labs/e2e-plugin", result.stdout + result.stderr)
            self.assertIn("dist/commands/handler.js", result.stdout + result.stderr)
            self.assertIn("dist/setup/handler.js", result.stdout + result.stderr)
            self.assertIn("@kb-labs/runtime-wildcard-dependency", result.stdout + result.stderr)
            self.assertIn("dist/runtime/wildcard-runtime.js", result.stdout + result.stderr)
            self.assertNotIn("browser-only remote entry", result.stdout + result.stderr)

            plugin_manifest = plugin / "dist" / "manifest.json"
            plugin_manifest.unlink()
            result = check_installed_runtime_imports(root)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("bundled plugin @kb-labs/e2e-plugin is missing dist/manifest.json", result.stderr)
            plugin_manifest.write_text(json.dumps({"schema": "kb.plugin/3"}))

            for name, package_root in (
                ("@kb-labs/shared-command-kit", root / "node_modules" / "@kb-labs" / "shared-command-kit"),
                ("@kb-labs/runtime-wildcard-dependency", root / "node_modules" / "@kb-labs" / "runtime-wildcard-dependency"),
                ("@kb-labs/sdk-runtime-dependency", root / "node_modules" / "@kb-labs" / "sdk-runtime-dependency"),
            ):
                (package_root / "dist").mkdir(parents=True)
                (package_root / "package.json").write_text(json.dumps({
                    "name": name,
                    "type": "module",
                    "exports": {".": {"import": "./dist/index.js"}},
                }))
                (package_root / "dist" / "index.js").write_text("export {};\n")

            result = check_installed_runtime_imports(root)
            self.assertEqual(result.returncode, 0, result.stderr)

            runtime_wildcard_file = runtime_wildcard / "wildcard-runtime.js"
            removed_runtime_wildcard = runtime_wildcard / "wildcard-runtime.mutated"
            runtime_wildcard_file.rename(removed_runtime_wildcard)
            result = check_installed_runtime_imports(root)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("runtime export pattern ./dist/runtime/* matches no JavaScript files", result.stderr)
            removed_runtime_wildcard.rename(runtime_wildcard_file)

            sdk_dependency_at_root = root / "node_modules" / "@kb-labs" / "sdk-runtime-dependency"
            sdk_dependency_at_scope = sdk / "node_modules" / "@kb-labs" / "sdk-runtime-dependency"
            sdk_dependency_at_scope.parent.mkdir(parents=True)
            sdk_dependency_at_root.rename(sdk_dependency_at_scope)
            result = check_installed_runtime_imports(root)
            self.assertEqual(result.returncode, 0, result.stderr)

            shared_peer = root / "node_modules" / "@kb-labs" / "shared-command-kit"
            removed_peer = root / "node_modules" / "@kb-labs" / "shared-command-kit.mutated"
            shared_peer.rename(removed_peer)
            result = check_installed_runtime_imports(root)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("@kb-labs/shared-command-kit", result.stdout + result.stderr)
            self.assertIn("dist/index.js", result.stdout + result.stderr)
            removed_peer.rename(shared_peer)

            result = check_installed_runtime_imports(root)
            self.assertEqual(result.returncode, 0, result.stderr)

            optional_helper = root / "node_modules" / "@kb-labs" / "shared-testing"
            optional_helper.mkdir(parents=True)
            (optional_helper / "package.json").write_text(json.dumps({"name": "@kb-labs/shared-testing"}))
            result = check_installed_runtime_imports(root)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("optional SDK peers: @kb-labs/shared-testing", result.stderr)

    def test_kb_create_install_json_uses_registered_stream_reader(self):
        result_payload = {"operation": "install", "receipt": {"id": "receipt-1"}}
        stdout = jsonl.encode_jsonl_records((
            {"ok": True, "data": {"phase": "Apply"}},
            {"ok": True, "data": result_payload,
             "meta": {"stream": {"result": True}}},
            {"ok": True, "data": None,
             "meta": {"stream": {"terminal": True, "exitCode": 0}}},
        ))
        command = ["kb-create", "install", "--json"]
        result = subprocess.CompletedProcess(command, 0, stdout, "")

        self.assertEqual(_json(result, command), {"ok": True, **result_payload})

    def test_registered_project_command_fails_when_it_changes_the_repository(self):
        with tempfile.TemporaryDirectory(prefix="kb-project-repository-guard-") as directory:
            project = Path(directory) / "project"
            project.mkdir()

            def runner(command, **kwargs):
                (project / ".kb").mkdir()
                return subprocess.CompletedProcess(command, 0, "{}", "")

            with self.assertRaisesRegex(RuntimeError, "adapter list --json changed the registered project repository"):
                _run_from_registered_project(runner, ["kb", "adapter", "list", "--json"], project, {"HOME": directory})

    def test_failed_adapter_flow_restores_the_original_platform_config(self):
        with tempfile.TemporaryDirectory(prefix="kb-adapter-restore-") as directory:
            root = Path(directory)
            config_path = root / ".kb" / "kb.config.json"
            config_path.parent.mkdir()
            original = b'{"platform":{}}\n'
            config_path.write_bytes(b'{"platform":{"adapters":{"storage":"@kb-labs/adapters-fs"}}}\n')
            commands = []

            def runner(command, **kwargs):
                commands.append(command)
                return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "data": {}}), "")

            error = _restore_platform_adapter_fixture(
                config_path, original, root / "project", root, {"HOME": directory}, runner,
            )

            self.assertIsNone(error)
            self.assertEqual(config_path.read_bytes(), original)
            self.assertEqual(commands, [["kb-create", "restart", "--platform-root", str(root), "--json"]])

    def test_restore_reports_successful_restart_that_leaves_different_valid_config(self):
        with tempfile.TemporaryDirectory(prefix="kb-adapter-restore-wrong-config-") as directory:
            root = Path(directory)
            config_path = root / ".kb" / "kb.config.json"
            config_path.parent.mkdir()
            original = b'{"platform":{"adapters":{"storage":"@kb-labs/adapters-fs"}}}\n'
            config_path.write_bytes(b'{"platform":{"adapters":{}}}\n')

            def runner(command, **_kwargs):
                config_path.write_text(json.dumps({"platform": {"adapters": {"storage": "wrong"}}}))
                return subprocess.CompletedProcess(command, 0, '{"ok":true,"data":{}}', "")

            error = _restore_platform_adapter_fixture(
                config_path, original, root / "project", root, {"HOME": directory}, runner,
            )

            self.assertEqual(error, "platform adapter config differs from its snapshot at keys: platform.adapters.storage")
            self.assertNotIn("wrong", error)
            journey = Journey("local", "adapter-restore-wrong-config")
            cleanup = journey.step("restore adapter journey fixture state", "adapter",
                                   lambda: error, role="lifecycle")
            self.assertEqual(cleanup.status, "FAIL")
            self.assertIn("platform.adapters.storage", cleanup.message)

    def test_workflow_readiness_claim_fails_when_required_upstream_is_down(self):
        with self.assertRaisesRegex(RuntimeError, "required upstreams not ready: marketplace"):
            _assert_required_upstreams_ready({
                "ready": True,
                "components": {
                    "upstream:marketplace": {"ready": False, "status": "down"},
                    "projectRuntimes": {"ready": True, "status": "1/4 active"},
                },
            })

    def test_default_pack_and_platform_adapter_scope_are_observable(self):
        with tempfile.TemporaryDirectory(prefix="kb-adapter-defaults-") as directory:
            home = Path(directory)
            project_a = home / "project-a"
            (project_a / ".kb").mkdir(parents=True)
            (project_a / "README.md").write_text("adapter defaults fixture\n")
            project_id = "prj_" + hashlib.sha256(unicodedata.normalize("NFC", str(project_a.resolve())).encode()).hexdigest()[:16]
            registry_home = (home / ".kb").resolve()
            registry_home.mkdir()
            (registry_home / "projects.json").write_text(json.dumps({"schemaVersion": 1, "projects": [
                {"id": project_id, "path": str(project_a.resolve()), "name": "project-a", "status": "active",
                 "addedAt": "2026-10-01T00:00:00.000Z", "lastUsedAt": None}
            ]}))
            storage_default = registry_home / "state" / project_id / "storage"
            env = {"HOME": str(home), "KB_JOURNEY_PROJECT_ROOT": str(project_a),
                   "KB_GATEWAY_URL": "http://127.0.0.1:4000",
                   "KB_JOURNEY_SERVICE_TOKEN": "journey-token"}
            calls: list[tuple[str, ...]] = []
            run_counter = 0
            host_running = True
            install_root = (home / "kb-platform").resolve()
            platform_root = create_test_install_container(install_root)
            sdk_root = platform_root / "node_modules" / "@kb-labs" / "sdk"
            (sdk_root / "dist").mkdir(parents=True)
            (sdk_root / "package.json").write_text(json.dumps({
                "name": "@kb-labs/sdk",
                "type": "module",
                "exports": {".": {"import": "./dist/index.js"}},
                "peerDependencies": {"@kb-labs/shared-testing": "^2.0.0"},
                "peerDependenciesMeta": {"@kb-labs/shared-testing": {"optional": True}},
            }))
            (sdk_root / "dist" / "index.js").write_text("export {};\n")
            shared_data = install_root / "state" / "data"
            shared_data.mkdir(parents=True)
            (platform_root / ".kb").mkdir(parents=True, exist_ok=True)
            (platform_root / ".kb" / "data").symlink_to(os.path.relpath(shared_data, platform_root / ".kb"), target_is_directory=True)
            receipt = platform_root / ".kb" / "v2" / "receipt.json"
            receipt.parent.mkdir(parents=True)
            receipt.write_text(json.dumps({"id": "sealed", "plan": {"artifacts": [
                {"id": "workflow", "kind": "service", "package": "@kb-labs/workflow-daemon",
                 "version": "2.120.1", "sha256": "workflow-digest", "tarball": "registry/workflow.tgz"},
                {"id": "openai", "kind": "adapter", "package": "@kb-labs/adapters-openai", "config": [
                    {"id": "openai.apiKey", "optional": True, "severity": "warning",
                     "action": "set OPENAI_API_KEY to enable LLM features"}]},
            ]}}) + "\n")
            sealed_package = platform_root / "node_modules" / "@kb-labs" / "workflow-daemon" / "package.json"
            sealed_package.parent.mkdir(parents=True)
            sealed_package.write_text('{"name":"@kb-labs/workflow-daemon","version":"2.120.1"}\n')
            openai_package = platform_root / "node_modules" / "@kb-labs" / "adapters-openai" / "package.json"
            openai_package.parent.mkdir(parents=True)
            openai_package.write_text('{"name":"@kb-labs/adapters-openai","version":"2.120.1"}\n')
            (platform_root / "package.json").write_text(json.dumps({
                "name": "kb-platform",
                "dependencies": {},
            }))
            (platform_root / "pnpm-workspace.yaml").write_text(
                'overrides:\n  "@kb-labs/workflow-daemon": "file:.kb/v2/cache/packages/workflow-digest.tgz"\n')
            platform_config = platform_root / ".kb" / "kb.config.jsonc"
            platform_config.parent.mkdir(parents=True, exist_ok=True)
            platform_config.write_text(json.dumps({"platform": {
                "adapters": {
                    "analytics": "@kb-labs/adapters-analytics-sqlite",
                    "eventBus": "@kb-labs/adapters-eventbus-cache",
                },
                "adapterOptions": {"analytics": {"dbPath": "analytics/analytics.sqlite"}},
            }}))
            gateway_manifest = platform_root / "node_modules" / "@kb-labs" / "gateway-app" / "kb-create.manifest.json"
            gateway_manifest.parent.mkdir(parents=True)
            gateway_manifest.write_text(json.dumps({"schema": "kb.create.artifact-manifest/v2", "id": "gateway-app",
                "package": "@kb-labs/gateway-app", "version": "1.0.0"}))

            def config(root: Path) -> dict:
                jsonc_file = root / ".kb" / "kb.config.jsonc"
                config_file = jsonc_file if jsonc_file.exists() else root / ".kb" / "kb.config.json"
                return json.loads(config_file.read_text()) if config_file.exists() else {}

            def write_config(root: Path, value: dict) -> None:
                jsonc_file = root / ".kb" / "kb.config.jsonc"
                config_file = jsonc_file if jsonc_file.exists() else root / ".kb" / "kb.config.json"
                config_file.parent.mkdir(parents=True, exist_ok=True)
                config_file.write_text(json.dumps(value))

            project_plugins: dict[Path, set[str]] = {project_a.resolve(): set()}

            def fake_run(command, *, cwd, env, capture_output, text, timeout):
                nonlocal run_counter, host_running
                calls.append(tuple(command))
                root = Path(cwd)
                args = command[1:]
                if command[0] == "kb-create" and args[:2] == ["status", "--platform-root"]:
                    return subprocess.CompletedProcess(command, 0,
                        json.dumps({"ok": True, "host": {"healthUrl": "http://health.test/health"}}), "")
                if command[0] == "git" and args == ["ls-files", "-z"]:
                    return subprocess.CompletedProcess(command, 0, b"README.md\0", b"")
                if command[0] == "kb-create" and args[:3] == ["doctor", "--platform-root", str(install_root)]:
                    if "--fix" in args:
                        gateway_manifest.parent.mkdir(parents=True, exist_ok=True)
                        gateway_manifest.write_text(json.dumps({"schema": "kb.create.artifact-manifest/v2", "id": "gateway-app",
                            "package": "@kb-labs/gateway-app", "version": "1.0.0"}))
                        return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "data": {
                            "operation": "doctor-fix", "findings": []}}), "")
                    if not gateway_manifest.exists():
                        result = {"ok": True, "data": {"operation": "doctor", "status": "unhealthy",
                            "findings": [{"code": "KB_INSTALL_MANIFEST_PROJECTION_INVALID",
                            "component": "@kb-labs/gateway-app", "path": "node_modules/@kb-labs/gateway-app/kb-create.manifest.json",
                            "hint": "Run `kb-create doctor --fix`."}], "platform": {"ok": True, "checks": []}}}
                        return subprocess.CompletedProcess(command, 0, json.dumps(result), "")
                    if not host_running:
                        result = {"ok": True, "data": {"operation": "doctor", "status": "unhealthy",
                            "findings": [], "platform": {"checks": [
                            {"id": "adapters", "detail": "Adapter status cannot be checked while the host is stopped.",
                             "hint": f'Run `{shlex.join(["kb-create", "start", "--platform-root", str(install_root)])}`.'}
                        ]}}}
                        if args[-1] == "--json":
                            result["data"]["findings"] = [
                                {"code": "KB_ADAPTER_CREDENTIALS_MISSING", "component": "openai",
                                 "path": "/platform/adapterOptions/llm/apiKey", "hint": "set OPENAI_API_KEY"},
                                {"code": "KB_ADAPTER_CREDENTIALS_MISSING", "component": "openai-embeddings",
                                 "path": "/platform/adapterOptions/embeddings/apiKey", "hint": "set OPENAI_API_KEY"},
                            ]
                            return subprocess.CompletedProcess(command, 0, json.dumps(result), "")
                        return subprocess.CompletedProcess(command, 0,
                            f'Finding KB_ADAPTER_CREDENTIALS_MISSING: package=openai path=/platform/adapterOptions/llm/apiKey\nAdapters: Adapter status cannot be checked while the host is stopped.\nNext: Run `{shlex.join(["kb-create", "start", "--platform-root", str(install_root)])}`.\n', "")
                    analytics_provider = config(platform_root).get("platform", {}).get("adapters", {}).get(
                        "analytics", "@kb-labs/adapters-analytics-sqlite")
                    statuses = [
                        {"slot": "storage", "mode": "real", "implementation": "@kb-labs/adapters-fs"},
                        {"slot": "cache", "mode": "real", "implementation": "@kb-labs/adapters-state-broker"},
                        *[{"slot": slot, "mode": "real", "implementation": slot}
                          for slot in ("logger", "documentDatabase")],
                        {"slot": "kvStore", "mode": "real", "implementation": "@kb-labs/adapters-sqlite/kv"},
                        {"slot": "analytics", "mode": "real", "implementation": analytics_provider},
                        {"slot": "eventBus", "mode": "real", "implementation": "@kb-labs/adapters-eventbus-cache"},
                        {"slot": "logs", "mode": "real", "implementation": "HybridLogReader"},
                        *[{"slot": slot, "mode": "inmemory", "implementation": slot}
                          for slot in ("config", "invoke", "artifacts", "notifier")],
                        {"slot": "vectorStore", "mode": "real", "implementation": "@kb-labs/adapters-sqlite/vector-store"},
                        {"slot": "embeddings", "mode": "real", "implementation": "@kb-labs/adapters-openai/embeddings"},
                        {"slot": "llm", "mode": "real", "implementation": "@kb-labs/adapters-openai"},
                    ]
                    if args[-1] == "--json":
                        findings = [
                            {"code": "KB_ADAPTER_CREDENTIALS_MISSING", "severity": "warning", "component": "openai", "path": "/platform/adapterOptions/llm/apiKey", "action": "set OPENAI_API_KEY to enable LLM features", "hint": "set OPENAI_API_KEY"},
                            {"code": "KB_ADAPTER_CREDENTIALS_MISSING", "severity": "warning", "component": "openai-embeddings", "path": "/platform/adapterOptions/embeddings/apiKey", "action": "set OPENAI_API_KEY to enable embeddings", "hint": "set OPENAI_API_KEY"},
                        ]
                        result = {"ok": True, "data": {"findings": findings, "platform": {"ok": True, "checks": statuses}}}
                        return subprocess.CompletedProcess(command, 0, json.dumps(result), "")
                    return subprocess.CompletedProcess(command, 0,
                        "Warnings:\nKB_ADAPTER_CREDENTIALS_MISSING: set OPENAI_API_KEY to enable LLM features\nKB_ADAPTER_CREDENTIALS_MISSING: set OPENAI_API_KEY to enable embeddings\nAdapter storage: mode=real implementation=@kb-labs/adapters-fs\n", "")
                if command[0] == "kb-create" and args[:2] in (["stop", "--platform-root"], ["start", "--platform-root"]):
                    host_running = args[0] == "start"
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True}), "")
                if command[0] == "kb-create" and args[:2] == ["restart", "--platform-root"]:
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True}), "")
                if args[:3] == ["adapter", "list", "--json"]:
                    value = config(root)
                    project_platform = value.get("platform", {})
                    registry_path = Path(env["HOME"]) / ".kb" / "projects.json"
                    registry_data = json.loads(registry_path.read_text())
                    registered_paths = {Path(item["path"]).resolve() for item in registry_data.get("projects", [])}
                    if root.resolve() in registered_paths and ("adapters" in project_platform or "adapterOptions" in project_platform or
                            "adapters" in value or "adapterOptions" in value):
                        error = {"code": "KB_ADAPTER_PROJECT_SCOPE", "message": "Project adapter configuration is unsupported.",
                                 "hint": "Move `platform.adapters` and `platform.adapterOptions` to the platform config."}
                        return subprocess.CompletedProcess(command, 1, json.dumps({"ok": False, "error": error}), "")
                    platform_value = config(platform_root)
                    platform_settings = platform_value.get("platform", {})
                    options = platform_settings.get("adapterOptions", {}).get("storage", {})
                    document_path = platform_settings.get("adapterOptions", {}).get("documentDatabase", {}).get("filename")
                    if isinstance(document_path, str) and (document_path.startswith(".kb/") or document_path.startswith("../")):
                        corrected = "database/kb.sqlite" if document_path.startswith(".kb/") else Path(document_path).name
                        error = {"code": "KB_CONFIG_INVALID", "message": "Platform adapter path is outside the platform data root.",
                                 "hint": f"Run `kb config set --scope platform platform.adapterOptions.documentDatabase '{{\"filename\":\"{corrected}\"}}'`."}
                        return subprocess.CompletedProcess(command, 1, json.dumps({"ok": False, "error": error}), "")
                    for slot, key in (("documentDatabase", "filename"), ("analytics", "dbPath")):
                        raw_path = platform_settings.get("adapterOptions", {}).get(slot, {}).get(key)
                        if isinstance(raw_path, str) and not Path(raw_path).is_absolute():
                            output = Path(os.path.realpath(platform_root / ".kb" / "data")) / raw_path
                            output.parent.mkdir(parents=True, exist_ok=True)
                            output.touch()
                    analytics_provider = platform_settings.get("adapters", {}).get(
                        "analytics", "@kb-labs/adapters-analytics-sqlite")
                    storage_base = Path(options.get("baseDir", storage_default))
                    if not storage_base.is_absolute():
                        storage_base = Path(os.path.realpath(platform_root / ".kb" / "data")) / storage_base
                    rows = [
                        {"slot": "storage", "implementation": "@kb-labs/adapters-fs", "mode": "real",
                        "baseDir": str(storage_base), "networkRequired": False},
                        {"slot": "cache", "implementation": "@kb-labs/adapters-state-broker", "mode": "real", "networkRequired": False},
                        {"slot": "logger", "implementation": "@kb-labs/adapters-pino", "mode": "real", "networkRequired": False},
                        {"slot": "analytics", "implementation": analytics_provider, "mode": "real", "networkRequired": False},
                        {"slot": "documentDatabase", "implementation": "@kb-labs/adapters-sqlite", "mode": "real", "networkRequired": False},
                        {"slot": "kvStore", "implementation": "@kb-labs/adapters-sqlite/kv", "mode": "real", "networkRequired": False},
                        {"slot": "eventBus", "implementation": "@kb-labs/adapters-eventbus-cache", "mode": "real", "networkRequired": False},
                        {"slot": "invoke", "implementation": "InMemoryInvoke", "mode": "inmemory", "networkRequired": False},
                        {"slot": "artifacts", "implementation": "InMemoryArtifacts", "mode": "inmemory", "networkRequired": False},
                        {"slot": "config", "implementation": "InMemoryConfig", "mode": "inmemory", "networkRequired": False},
                        {"slot": "logs", "implementation": "HybridLogReader", "mode": "real", "networkRequired": False},
                        {"slot": "notifier", "implementation": "InMemoryNotifier", "mode": "inmemory", "networkRequired": False},
                        {"slot": "llm", "implementation": "@kb-labs/adapters-openai", "mode": "real", "networkRequired": True,
                         "credentialsStatus": "missing", "missingCredentials": ["OPENAI_API_KEY"]},
                        {"slot": "embeddings", "implementation": "@kb-labs/adapters-openai/embeddings", "mode": "real", "networkRequired": True,
                         "credentialsStatus": "missing", "missingCredentials": ["OPENAI_API_KEY"]},
                        {"slot": "vectorStore", "implementation": "@kb-labs/adapters-sqlite/vector-store", "mode": "real", "networkRequired": False},
                        {"slot": "snapshotManager", "implementation": None, "mode": "unconfigured", "networkRequired": False,
                         "requiresConfiguration": True},
                    ]
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "adapters": rows}), "")
                if args[:2] == ["project", "add"]:
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True}), "")
                if args[:2] == ["config", "set"]:
                    if args[2:4] == ["commit.llm.enabled", "true"]:
                        return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True}), "")
                    if args[2:4] == ["--scope", "project"]:
                        error = {"code": "KB_ADAPTER_PROJECT_SCOPE", "message": "Project adapter configuration is unsupported.",
                                 "hint": "Move `platform.adapters` and `platform.adapterOptions` to the platform config."}
                        return subprocess.CompletedProcess(command, 1, json.dumps({"ok": False, "error": error}), "")
                    if args[2:4] == ["--scope", "platform"]:
                        key, raw = args[4], args[5]
                    else:
                        key, raw = args[2], args[3]
                    parts = key.split(".")
                    if parts[:2] != ["platform", "adapterOptions"] or len(parts) != 3:
                        return subprocess.CompletedProcess(command, 2, "", f"unexpected config key: {key}")
                    value = config(platform_root)
                    value.setdefault("platform", {}).setdefault("adapterOptions", {})[parts[2]] = json.loads(raw)
                    write_config(platform_root, value)
                    return subprocess.CompletedProcess(command, 0, json.dumps({
                        "ok": True, "file": str(platform_config), "scope": "platform",
                    }), "")
                if args[:2] == ["config", "get"] and args[2:4] == ["--scope", "platform"]:
                    value = config(platform_root).get("platform", {}).get("adapterOptions", {}).get("storage")
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "data": {
                        "value": value, "file": str(platform_config),
                    }}), "")
                if args[:2] == ["adapter", "bind"]:
                    value = config(platform_root)
                    value.setdefault("platform", {}).setdefault("adapters", {})[args[2]] = args[3]
                    write_config(platform_root, value)
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True}), "")
                if args[:2] == ["adapter", "unbind"]:
                    value = config(platform_root)
                    value.setdefault("platform", {}).setdefault("adapters", {}).pop("storage", None)
                    value.setdefault("platform", {}).setdefault("adapterOptions", {}).pop("storage", None)
                    write_config(platform_root, value)
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True}), "")
                if args[:2] == ["workflow", "run"] and "KB_GATEWAY_URL" not in env:
                    error = {
                        "code": "KB_HOST_SERVICE_ADDRESS_MISSING",
                        "message": catalogued_error_message("KB_HOST_SERVICE_ADDRESS_MISSING"),
                        "hint": catalogued_error_hint("KB_HOST_SERVICE_ADDRESS_MISSING"),
                        "details": {"service": "gateway"},
                        "correlationId": "corr-adapter-workflow-gateway",
                    }
                    return subprocess.CompletedProcess(command, 1,
                        json.dumps({"ok": False, "error": error}), "")
                if args[:2] == ["workflow", "run"]:
                    run_counter += 1
                    run_id = f"run-{run_counter}"
                    value = config(platform_root)
                    options = value.get("platform", {}).get("adapterOptions", {}).get("storage", {})
                    base_dir = Path(options.get("baseDir", storage_default))
                    if not base_dir.is_absolute():
                        base_dir = root / base_dir
                    record = base_dir / "workflows" / f"{run_id}.json"
                    record.parent.mkdir(parents=True, exist_ok=True)
                    record.write_text(json.dumps({"runId": run_id, "status": "success"}))
                    diagnostic = ('[discover] error COMMAND_HANDLER_MISSING: Command handler "./commands/emit.js#default" '
                                  'declared by plugin "@kb-labs/e2e-analytics-emitter" was not found.\n')
                    return subprocess.CompletedProcess(command, 0,
                        json.dumps({"ok": True, "data": {"runId": run_id}}), diagnostic)
                if args[:3] == ["workflow", "runs", "watch"]:
                    return subprocess.CompletedProcess(command, 0, "Run SUCCESS.\n", "")
                if args[:3] == ["workflow", "runs", "view"]:
                    run_id = args[3]
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "data": {"id": run_id, "status": "success"}}), "")
                if args[:3] == ["commit", "plan", "create"]:
                    error = {"code": "KB_ADAPTER_CREDENTIALS_MISSING", "message": "Adapter llm is missing OPENAI_API_KEY.",
                             "hint": "Set OPENAI_API_KEY or run `kb config set --scope platform platform.adapterOptions.llm.apiKey '${OPENAI_API_KEY}' --allow-missing-env`. No request was sent.",
                             "retryable": False, "correlationId": "adapter-missing-credentials",
                             "details": {"adapter": "llm", "credential": "OPENAI_API_KEY"}}
                    return subprocess.CompletedProcess(command, 1, json.dumps({"ok": False, "error": error}), "")
                if args[:3] == ["commit", "plan", "delete"]:
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True}), "")
                if args[:2] == ["mind", "search"]:
                    command_text = "kb config set --scope platform platform.adapterOptions.embeddings.apiKey '" + "$" + "{OPENAI_API_KEY}' --allow-missing-env"
                    error = {"code": "KB_ADAPTER_CREDENTIALS_MISSING", "message": "Adapter embeddings is missing OPENAI_API_KEY.",
                             "hint": "No request was sent.", "details": {
                                 "service": "embeddings", "credential": "OPENAI_API_KEY", "command": command_text,
                             }, "actions": [{"command": command_text}]}
                    return subprocess.CompletedProcess(command, 1, json.dumps({"ok": False, "error": error}), "")
                if args[:2] == ["marketplace", "install"] and args[2] == "@kb-labs/mind":
                    if args[3:] != ["--scope", "platform", "--json"]:
                        (root / ".kb").mkdir(exist_ok=True)
                        (root / ".kb" / "project-plugin-lock.json").write_text("project install")
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True}), "")
                if args[:3] == ["marketplace", "install", "@kb-labs/commit"]:
                    project_plugins.setdefault(root.resolve(), set()).add("@kb-labs/commit")
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True}), "")
                if args[:3] == ["marketplace", "plugins", "list"]:
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "plugins": sorted(project_plugins.get(root.resolve(), set()))}), "")
                if args[:3] == ["marketplace", "install", "@kb-labs/adapters-analytics-file"]:
                    workspace = (platform_root / "pnpm-workspace.yaml").read_text()
                    if '"@kb-labs/workflow-daemon": "file:.kb/v2/cache/packages/workflow-digest.tgz"' not in workspace:
                        error = {
                            "code": "KB_MARKETPLACE_PLATFORM_ARTIFACT_PINS_MISSING",
                            "message": "The installed platform is missing kb-create's sealed artifact overrides. No package was installed.",
                            "hint": f'Run "kb-create update --platform-root {install_root}" and retry "kb marketplace install @kb-labs/adapters-analytics-file@2.120.1 --scope platform".',
                        }
                        return subprocess.CompletedProcess(command, 1, json.dumps({"ok": False, "error": error}), "")
                    lock_path = platform_root / ".kb" / "marketplace.lock"
                    lock_path.parent.mkdir(parents=True, exist_ok=True)
                    lock = {"schema": "kb.marketplace/3", "plugins": {}, "adapters": {
                        "@kb-labs/adapters-analytics-file": {
                            "version": "2.120.1", "integrity": "sha512-fixture", "resolvedPath": "node_modules/@kb-labs/adapters-analytics-file",
                            "enabled": True, "source": "platform",
                        },
                    }}
                    lock_path.write_text(json.dumps(lock))
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True}), "")
                if args[:2] == ["project", "remove"]:
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True}), "")
                return subprocess.CompletedProcess(command, 2, "", f"unexpected command: {command}")

            raw_fake_run = fake_run

            def fake_run(command, *, cwd, env, capture_output, text, timeout):
                result = raw_fake_run(command, cwd=cwd, env=env, capture_output=capture_output,
                                      text=text, timeout=timeout)
                if result.returncode == 0 and "--json" in command and result.stdout:
                    try:
                        envelope = json.loads(result.stdout)
                    except json.JSONDecodeError:
                        return result
                    if isinstance(envelope, dict) and envelope.get("ok") is True and "data" not in envelope:
                        envelope = {"ok": True, "data": {key: value for key, value in envelope.items() if key != "ok"}}
                        return subprocess.CompletedProcess(command, result.returncode, json.dumps(envelope), result.stderr)
                return result

            journey = Journey("local", "adapter-defaults-fixture")
            vector_records = {}
            runtime_adapters = [
                {"slot": "storage", "mode": "real", "implementation": "@kb-labs/adapters-fs"},
                {"slot": "cache", "mode": "real", "implementation": "@kb-labs/adapters-state-broker"},
                *[{"slot": slot, "mode": "real", "implementation": slot}
                  for slot in ("logger", "documentDatabase")],
                {"slot": "kvStore", "mode": "real", "implementation": "@kb-labs/adapters-sqlite/kv"},
                {"slot": "analytics", "mode": "real", "implementation": None},
                {"slot": "eventBus", "mode": "real", "implementation": "@kb-labs/adapters-eventbus-cache"},
                {"slot": "logs", "mode": "real", "implementation": "HybridLogReader"},
                *[{"slot": slot, "mode": "inmemory", "implementation": slot}
                  for slot in ("config", "invoke", "artifacts", "notifier")],
                {"slot": "vectorStore", "mode": "real", "implementation": "@kb-labs/adapters-sqlite/vector-store"},
                {"slot": "embeddings", "mode": "real", "implementation": "@kb-labs/adapters-openai/embeddings",
                 "credentialsStatus": "missing", "missingCredentials": ["OPENAI_API_KEY"]},
                {"slot": "llm", "mode": "real", "implementation": "@kb-labs/adapters-openai"},
            ]

            def health_adapters() -> list[dict]:
                # The host reports the provider currently bound in the platform config.
                bound = config(platform_root).get("platform", {}).get("adapters", {})
                provider = bound.get("analytics", "@kb-labs/adapters-analytics-sqlite")
                return [{**row, "implementation": provider} if row["slot"] == "analytics" else row
                        for row in runtime_adapters]

            def fake_urlopen(request, *args, **kwargs):
                url = request.full_url if hasattr(request, "full_url") else str(request)
                if "/platform/v1/vectorStore/" in url:
                    request_body = json.loads(request.data)
                    method = url.rsplit("/", 1)[-1]
                    if method == "upsert":
                        vectors, namespace = request_body["args"]
                        for record in vectors:
                            vector_records[namespace, record["id"]] = record
                        vector_database = registry_home / "state" / project_id / "vector-store" / "vectors.sqlite"
                        vector_database.parent.mkdir(parents=True, exist_ok=True)
                        vector_database.touch()
                        return io.BytesIO(json.dumps({"ok": True, "data": None}).encode())
                    query, _limit, _filter, namespace = request_body["args"]
                    results = [
                        {"id": record["id"], "score": 1, "metadata": record["metadata"]}
                        for (stored_namespace, _), record in vector_records.items()
                        if stored_namespace == namespace and record["vector"] == query
                    ]
                    return io.BytesIO(json.dumps({"ok": True, "data": results}).encode())
                if url.endswith("/ready"):
                    return io.BytesIO(json.dumps({"ok": True, "data": {
                        "ready": True,
                        "components": {
                            "upstream:marketplace": {"ready": True, "status": "up"},
                        },
                    }}).encode())
                if url.endswith("/health"):
                    return io.BytesIO(json.dumps({"ok": True, "data": {
                        "status": "healthy",
                        "upstreams": {"marketplace": {"status": "up"}},
                        "projectRuntimes": {"limit": 4, "active": 1, "runtimes": [
                            {"projectId": project_id, "state": "ready"}]}}}).encode())
                return io.BytesIO(json.dumps({"ok": True, "data": health_adapters()}).encode())

            report_root = home / "journey-report"
            with invocation_context(report_root=report_root):
                with patch("adapter_defaults_steps.urllib.request.urlopen", side_effect=fake_urlopen):
                    run_adapter_default_steps(journey, project_a, env, fake_run)

            expected = ({f"S-054.{number}" for number in range(1, 9)}
                        | {f"S-054.{number}" for number in range(10, 17)}
                        | {"S-054.18", "S-054.19", "S-054.24", "S-054.25"}
                        | {"S-054.21", "S-054.22", "S-051.5"}
                        | {f"S-048.{number}" for number in range(1, 8)})
            claims = {claim["claimId"] for claim in journey.result().case_run["claims"]}
            self.assertEqual(journey.result().status, "PASS", journey.result().first_failure)
            cleanup = next(step for step in journey.steps if step.name == "restore adapter journey fixture state")
            self.assertEqual(cleanup.status, "PASS")
            self.assertEqual(claims, expected)
            invocation_records = jsonl.read_jsonl(report_root / "invocations" / "calls.jsonl")
            self.assertEqual([row.line_number for row in invocation_records if row.error is not None], [])
            workflow_rows = [row.value for row in invocation_records
                             if row.value.get("argv", [])[1:3] == ["workflow", "run"]]
            successful_workflow_rows = [row for row in workflow_rows
                                        if json.loads(row["stdout"]).get("ok") is True]
            failed_workflow_rows = [row for row in workflow_rows
                                    if json.loads(row["stdout"]).get("ok") is False]
            self.assertTrue(successful_workflow_rows)
            self.assertTrue(any(
                json.loads(row["stdout"]).get("error", {}).get("code") == "KB_HOST_SERVICE_ADDRESS_MISSING"
                for row in failed_workflow_rows))
            for row in successful_workflow_rows:
                self.assertTrue(json.loads(row["stdout"])["ok"])
                self.assertNotIn("[discover]", row["stdout"])
                self.assertIn("[discover]", row["stderr"])
            self.assertIn(("kb", "adapter", "list", "--json"), calls)
            self.assertIn(("kb", "adapter", "unbind", "storage", "--json"), calls)
            self.assertIn(("kb", "config", "get", "--scope", "platform", "platform.adapterOptions.storage", "--json"), calls)
            self.assertNotIn(("kb", "config", "set", "commit.llm.enabled", "true", "--json"), calls)
            self.assertIn(("kb", "commit", "plan", "create", "--json"), calls)
            self.assertIn(("kb", "mind", "search", "--text", "adapter defaults", "--json"), calls)
            self.assertIn(("kb", "marketplace", "install", "@kb-labs/mind", "--scope", "platform", "--json"), calls)
            self.assertIn(("kb", "marketplace", "install", "@kb-labs/adapters-analytics-file", "--scope", "platform", "--json"), calls)
            self.assertIn(("kb-create", "doctor", "--platform-root", str(install_root), "--json"), calls)
            self.assertIn(("kb-create", "doctor", "--platform-root", str(install_root)), calls)
            self.assertIn(("kb-create", "doctor", "--platform-root", str(install_root), "--fix", "--json"), calls)
            self.assertIn(("kb-create", "status", "--platform-root", str(install_root), "--json"), calls)
            self.assertFalse(any(call[0] == "kb-dev" and "doctor" in call for call in calls))
            self.assertNotIn(("kb", "marketplace", "install", "@kb-labs/adapters-fs", "--scope", "platform"), calls)
            self.assertFalse(any(item.name.startswith("kb-adapter-project-b-") for item in home.iterdir()))


if __name__ == "__main__":
    unittest.main()
