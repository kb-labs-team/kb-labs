from __future__ import annotations

import json
import io
import ast
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.parse
import urllib.request
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import invocations
import redaction
import jsonl
import journey_resources


class HarnessProbeTest(unittest.TestCase):
    def test_probe_checks_exit_status_and_keeps_the_requested_timeout(self):
        completed = subprocess.CompletedProcess(["node", "--version"], 0, "v24.1.0\n", "")
        with patch.object(invocations.subprocess, "run", return_value=completed) as run:
            self.assertIs(invocations.probe_harness_command(["node", "--version"], timeout=5), completed)
        run.assert_called_once_with(
            ["node", "--version"], capture_output=True, text=True, timeout=5, check=True,
        )

    def test_probe_returns_none_for_unavailable_or_failed_commands(self):
        for error in (FileNotFoundError("node"), subprocess.CalledProcessError(1, ["node", "--version"])):
            with self.subTest(error=type(error).__name__), \
                 patch.object(invocations.subprocess, "run", side_effect=error):
                self.assertIsNone(invocations.probe_harness_command(["node", "--version"], timeout=5))


class PlatformRegistryPlanStageTests(unittest.TestCase):
    def test_staged_plan_script_runs_go_cli_boundary_with_runner_resource_layout(self):
        source_root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="platform-registry-plan-stage-") as temporary:
            install_root = Path(temporary) / "opt" / "kb-journey"
            journey_dir = install_root / "e2e" / "journey"
            journey_dir.mkdir(parents=True)
            for module in ("invocations.py", "journey_values.py", "redaction.py", "jsonl.py",
                           "journey_resources.py", "platform_registry_plan.py"):
                shutil.copyfile(source_root / "e2e" / "journey" / module, journey_dir / module)

            tool_entrypoints = [resource.source for resource in journey_resources.RUNNER_IMAGE_RESOURCES
                                if resource.source.startswith("tools/") and resource.source.endswith("/main.go")]
            resources = (*tool_entrypoints, "core/platform/src/error-envelope/errors.catalog.json")
            for source in resources:
                destination = install_root / source
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source_root / source, destination)

            fake_bin = Path(temporary) / "bin"
            fake_bin.mkdir()
            kb_create = fake_bin / "kb-create"
            kb_create.write_text(
                "#!/bin/sh\nprintf '%s\\n' '{\"ok\":true,\"data\":{\"plan\":{}}}'\n",
                encoding="utf-8",
            )
            kb_create.chmod(0o755)
            output = Path(temporary) / "plan.json"
            env = os.environ.copy()
            env["PATH"] = f"{fake_bin}:{env.get('PATH', '')}"
            env["PYTHONPATH"] = str(journey_dir)
            result = subprocess.run(
                [sys.executable, str(journey_dir / "platform_registry_plan.py"), str(output), "--json"],
                cwd=temporary, env=env, capture_output=True, text=True, check=False,
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), {
                "ok": True, "data": {"plan": {}},
            })
            dockerfile = (source_root / "e2e" / "platform" / "Dockerfile").read_text(encoding="utf-8")
            for source in resources:
                self.assertIn(f"COPY {source} /opt/kb-journey/{source}", dockerfile)


def secret_environment_write_violations(source_text: str, filename: str = "<source>") -> list[str]:
    """Find secret-like keys written directly into environment mappings."""
    tree = ast.parse(source_text, filename=filename)

    def literal_key(node):
        return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None

    def secret_keys(mapping):
        return [key for key in (literal_key(item) for item in mapping.keys)
                if key is not None and redaction.is_secret_key(key)]

    def is_env_mapping(node):
        if isinstance(node, ast.Name):
            return node.id == "env" or node.id.endswith("_env") or node.id == "environ"
        return (isinstance(node, ast.Attribute) and node.attr == "environ"
                and isinstance(node.value, ast.Name) and node.value.id == "os")

    def contains_secret_mapping_write(node):
        if isinstance(node, ast.Dict) and secret_keys(node):
            return True
        if isinstance(node, ast.Call) and any(
                keyword.arg and redaction.is_secret_key(keyword.arg) for keyword in node.keywords):
            return True
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            return ((is_env_mapping(node.left) and contains_secret_mapping_write(node.right))
                    or (is_env_mapping(node.right) and contains_secret_mapping_write(node.left)))
        return False

    violations = []
    parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}

    def inside_storage_helper(node):
        current = node
        while current in parents:
            current = parents[current]
            if (isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef))
                    and current.name == "store_report_secret"):
                return Path(filename).name == "invocations.py"
        return False

    for node in ast.walk(tree):
        if inside_storage_helper(node):
            continue
        if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                key = literal_key(target.slice) if isinstance(target, ast.Subscript) else None
                if (isinstance(target, ast.Subscript) and is_env_mapping(target.value)
                        and isinstance(target.ctx, (ast.Store, ast.Del))
                        and key is not None and redaction.is_secret_key(key)
                        and not (isinstance(node.value, ast.Constant) and node.value.value == "")):
                    violations.append(f"{filename}:{node.lineno}: direct secret-key assignment")
                if (is_env_mapping(target) and contains_secret_mapping_write(node.value)):
                    violations.append(f"{filename}:{node.lineno}: secret literal assigned to environment")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            receiver = node.func.value
            if is_env_mapping(receiver):
                if node.func.attr in {"update", "setdefault", "__setitem__"}:
                    if any(contains_secret_mapping_write(arg) for arg in node.args):
                        violations.append(f"{filename}:{node.lineno}: secret literal passed to environment write")
                    if any(keyword.arg is None and contains_secret_mapping_write(keyword.value)
                           for keyword in node.keywords):
                        violations.append(f"{filename}:{node.lineno}: secret mapping expanded into environment write")
                    if any(keyword.arg and redaction.is_secret_key(keyword.arg)
                           for keyword in node.keywords):
                        violations.append(f"{filename}:{node.lineno}: secret key passed to environment write")
                    if node.func.attr == "setdefault" and node.args:
                        key = literal_key(node.args[0])
                        if key is not None and redaction.is_secret_key(key):
                            violations.append(f"{filename}:{node.lineno}: direct secret-key setdefault")
            for keyword in node.keywords:
                if keyword.arg == "env" and contains_secret_mapping_write(keyword.value):
                    violations.append(f"{filename}:{node.lineno}: secret literal passed as env")
        if isinstance(node, ast.Dict):
            if any(key is None and is_env_mapping(value) for key, value in zip(node.keys, node.values)):
                if secret_keys(node):
                    violations.append(f"{filename}:{node.lineno}: secret key in environment mapping merge")
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            if ((is_env_mapping(node.left) and contains_secret_mapping_write(node.right))
                    or (is_env_mapping(node.right) and contains_secret_mapping_write(node.left))):
                violations.append(f"{filename}:{node.lineno}: secret key in environment mapping union")

    return violations


class PtyInvocationTest(unittest.TestCase):
    # case: S-315.2
    def test_url_userinfo_is_redacted_in_retained_evidence(self):
        rendered = redaction.redact_text(
            "redis://journey:redis-password@cache.internal:6379/0 "
            "https://user%40name:encoded%3Asecret@example.test/path"
        )
        self.assertNotIn("redis-password", rendered)
        self.assertNotIn("encoded%3Asecret", rendered)
        self.assertEqual(rendered.count("[REDACTED]@"), 2)

    def test_url_redaction_scales_for_large_single_line_logs(self):
        value = "x" * (128 * 1024)
        started = time.monotonic()
        self.assertEqual(redaction.redact_text(value), value)
        self.assertLess(time.monotonic() - started, 3.0)

        credential = "very-long-userinfo-" + ("secret" * 4096)
        rendered = redaction.redact_text(f"https://{credential}@registry.internal/path")
        self.assertNotIn(credential, rendered)
        self.assertEqual(rendered, "https://[REDACTED]@registry.internal/path")

    def test_failed_envelope_log_path_is_captured_bounded_and_redacted(self):
        with tempfile.TemporaryDirectory(prefix="journey-error-log-artifact-") as temp:
            root = Path(temp)
            source = root / "host.log"
            secret = "invocation-artifact-secret"
            source.write_text(secret + "\n" + ("x" * (2 * 1024 * 1024)))
            env = {"KB_JOURNEY_API_TOKEN": secret}
            failure = json.dumps({"ok": False, "error": {
                "code": "KB_UPDATE_HOST_NOT_HEALTHY",
                "details": {"logPath": str(source)},
            }})

            with invocations.invocation_context(report_root=root):
                record = invocations.record_invocation(
                    kind="http", argv=["GET"], cwd=root, env=env, exit_code=500,
                    stdout=failure, duration_seconds=0.1,
                )

            self.assertEqual(len(record["invocation_evidence"]), 1)
            artifact = root / record["invocation_evidence"][0]
            content = artifact.read_text()
            self.assertNotIn(secret, content)
            self.assertIn("[REDACTED]", content)
            self.assertLessEqual(artifact.stat().st_size, invocations.MAX_ERROR_LOG_BYTES + 128)
            self.assertTrue(content.endswith("[truncated by journey evidence limit]\n"))

    def test_unexpected_correlation_parser_reads_json_and_catalog_rendered_human_output(self):
        correlation_id = "cli-text-correlation-1"
        catalog_path = Path(__file__).resolve().parents[2] / "core/platform/src/error-envelope/errors.catalog.json"
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        unexpected = next(item for item in catalog["codes"] if item["code"] == "KB_RUNTIME_UNEXPECTED")
        hint = unexpected["hint"].replace("{correlationId}", correlation_id)
        human_output = f"{unexpected['message']} [KB_RUNTIME_UNEXPECTED]\nHint: {hint}"
        machine_output = json.dumps({"ok": False, "error": {
            "code": "KB_RUNTIME_UNEXPECTED", "correlationId": correlation_id,
        }})

        self.assertEqual(invocations.parse_error_correlation_id(machine_output, expected_code="KB_RUNTIME_UNEXPECTED"), (True, correlation_id))
        self.assertEqual(invocations.parse_error_correlation_id("", human_output, expected_code="KB_RUNTIME_UNEXPECTED"), (True, correlation_id))

    def test_correlated_plugin_failure_parser_reads_catalogued_json_and_human_output(self):
        correlation_id = "plugin-text-correlation-1"
        catalog_path = Path(__file__).resolve().parents[2] / "core/platform/src/error-envelope/errors.catalog.json"
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        failure = next(item for item in catalog["codes"] if item["code"] == "KB_PLUGIN_COMMAND_FAILED")
        hint = failure["hint"].replace("{correlationId}", correlation_id)
        human_output = f"{failure['message'].replace('{command}', 'journey-error throw').replace('{plugin}', '@kb-labs/e2e-plugin-error').replace('{failureReason}', 'failed unexpectedly')} [KB_PLUGIN_COMMAND_FAILED]\nHint: {hint}"
        machine_output = json.dumps({"ok": False, "error": {
            "code": "KB_PLUGIN_COMMAND_FAILED", "correlationId": correlation_id,
        }})

        self.assertEqual(invocations.parse_error_correlation_id(machine_output, expected_code="KB_PLUGIN_COMMAND_FAILED"), (True, correlation_id))
        self.assertEqual(invocations.parse_error_correlation_id("", human_output, expected_code="KB_PLUGIN_COMMAND_FAILED"), (True, correlation_id))
        self.assertEqual(invocations.parse_error_correlation_id(machine_output, expected_code="KB_RUNTIME_UNEXPECTED"), (False, None))

    def test_unexpected_error_queries_the_cli_when_invoked_by_name_on_path(self):
        with tempfile.TemporaryDirectory(prefix="journey-kb-by-name-") as temp:
            root = Path(temp)
            target = root / "installed-kb"
            target.write_text(
                "#!/bin/sh\n"
                "[ \"$1 $2 $3\" = 'logs query --correlation-id' ] && [ \"$4\" = 'cli-by-name-1' ] && [ \"$5\" = '--json' ] || exit 7\n"
                "printf '%s\\n' 'not-json'\n"
            )
            target.chmod(0o755)
            (root / "kb").symlink_to(target)
            env = {"PATH": str(root), "KB_JOURNEY_CLI_PATH": str(root / "kb")}
            stdout = json.dumps({"ok": False, "error": {
                "code": "KB_RUNTIME_UNEXPECTED", "correlationId": "cli-by-name-1"}})

            diagnostic = invocations._failure_log_query("command", 1,
                                                        ["kb", "adapter", "list", "--json"],
                                                        stdout, "", root, env)

        self.assertEqual(diagnostic, {
            "code": "KB_RUNTIME_UNEXPECTED",
            "correlationId": "cli-by-name-1",
            "queryError": "not-json",
            "exitCode": 0,
        })

    def test_explicit_installed_cli_invocation_queries_that_platform_without_path_lookup(self):
        with tempfile.TemporaryDirectory(prefix="journey-kb-explicit-path-") as temp:
            root = Path(temp)
            target = root / "installed-kb"
            target.write_text("#!/bin/sh\nexit 0\n")
            target.chmod(0o755)
            cli = root / "kb"
            cli.symlink_to(target)
            correlation_id = "explicit-path-correlation-1"
            query_envelope = {"ok": True, "data": {"data": {"logs": [
                {"correlationId": correlation_id, "message": "target platform failure"},
            ]}}}
            env = {"PATH": "/usr/bin:/bin", "KB_JOURNEY_CLI_PATH": str(cli)}
            failure = json.dumps({"ok": False, "error": {
                "code": "KB_RUNTIME_UNEXPECTED", "correlationId": correlation_id,
            }})

            with patch.object(invocations.subprocess, "run", return_value=subprocess.CompletedProcess(
                    [str(target), "logs"], 0, json.dumps(query_envelope), "")) as run:
                diagnostic = invocations._failure_log_query(
                    "command", 1, [str(cli), "adapter", "list", "--json"],
                    failure, "", root, env)

        command = run.call_args.args[0]
        self.assertEqual(command, [str(Path(target).resolve()), "logs", "query", "--correlation-id", correlation_id, "--json"])
        self.assertEqual(diagnostic, {
            "code": "KB_RUNTIME_UNEXPECTED",
            "correlationId": correlation_id,
            "result": query_envelope,
        })

    def test_kb_create_failure_does_not_query_platform_logs(self):
        with tempfile.TemporaryDirectory(prefix="journey-kb-create-log-query-") as temp:
            root = Path(temp)
            target = root / "installed-kb"
            target.write_text("#!/bin/sh\nexit 0\n")
            target.chmod(0o755)
            installer = root / "kb-create"
            installer.write_text("#!/bin/sh\nexit 0\n")
            installer.chmod(0o755)
            cli = root / "kb"
            cli.symlink_to(target)
            env = {"PATH": str(root), "KB_JOURNEY_CLI_PATH": str(cli)}
            failure = json.dumps({"ok": False, "error": {
                "code": "KB_INSTALL_OPERATION_FAILED", "correlationId": "installer-correlation-1",
            }})
            with patch.object(invocations.subprocess, "run") as run:
                diagnostic = invocations._failure_log_query(
                    "command", 1, [str(installer), "install", "--json"],
                    failure, "", root, env)

        self.assertIsNone(diagnostic)
        run.assert_not_called()

    def test_json_report_writer_does_not_accept_append_mode(self):
        import inspect
        self.assertNotIn("append", inspect.signature(invocations.write_report_json).parameters)

    def test_http_failure_with_correlation_id_records_the_complete_platform_log_query(self):
        with tempfile.TemporaryDirectory(prefix="journey-http-log-query-") as temp:
            root = Path(temp)
            target = root / "installed-kb"
            target.write_text("#!/bin/sh\nexit 0\n")
            target.chmod(0o755)
            cli = root / "kb"
            cli.symlink_to(target)
            correlation_id = "http-failure-correlation-1"
            query_envelope = {"ok": True, "data": {"data": {"source": "persistence", "logs": [
                {"correlationId": correlation_id, "message": "plugin cause"},
            ]}}}
            env = {"PATH": str(root), "KB_JOURNEY_CLI_PATH": str(cli)}
            failure = json.dumps({"ok": False, "error": {
                "code": "KB_PLUGIN_COMMAND_FAILED", "correlationId": correlation_id,
            }})

            with patch.object(invocations.subprocess, "run", return_value=subprocess.CompletedProcess(
                    [str(cli), "logs"], 0, json.dumps(query_envelope), "")) as run:
                with invocations.invocation_context(report_root=root):
                    invocations.record_invocation(
                        kind="http", argv=["GET"], cwd=root, env=env, exit_code=500,
                        stdout=failure, duration_seconds=0.1, url="http://gateway.invalid/test",
                    )

            self.assertEqual(run.call_args.args[0], [str(cli), "logs", "query", "--correlation-id", correlation_id, "--json"])
            record = json.loads((root / "invocations/calls.jsonl").read_text())
            self.assertEqual(record["correlated_log_query"], {
                "code": "KB_PLUGIN_COMMAND_FAILED",
                "correlationId": correlation_id,
                "result": query_envelope,
            })

    def test_non_cli_report_does_not_query_nested_unexpected_error_text(self):
        with tempfile.TemporaryDirectory(prefix="journey-nested-diagnostic-") as temp:
            root = Path(temp)
            target = root / "installed-kb"
            target.write_text("#!/bin/sh\nexit 9\n")
            target.chmod(0o755)
            (root / "kb").symlink_to(target)
            env = {"PATH": str(root), "KB_JOURNEY_CLI_PATH": str(root / "kb")}
            catalog_path = Path(__file__).resolve().parents[2] / "core/platform/src/error-envelope/errors.catalog.json"
            catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
            unexpected = next(item for item in catalog["codes"] if item["code"] == "KB_RUNTIME_UNEXPECTED")
            correlation_id = "nested-correlation\\"
            hint = unexpected["hint"].replace("{correlationId}", correlation_id)
            service_report = json.dumps({"message": f"{unexpected['message']} [KB_RUNTIME_UNEXPECTED]\nHint: {hint}"})

            diagnostic = invocations._failure_log_query(
                "command", 1, ["python3", "service_runner.py"], service_report, "", root, env)

        self.assertIsNone(diagnostic)

    def test_invocation_records_kb_environment_and_resolved_shim_with_shared_redaction(self):
        with tempfile.TemporaryDirectory(prefix="journey-kb-shim-evidence-") as temp:
            root = Path(temp)
            target = root / "installed-kb"
            target.write_text("#!/bin/sh\nexit 0\n")
            target.chmod(0o755)
            shim = root / "kb"
            shim.symlink_to(target)
            secret = "journey-secret-token-value"
            env = {
                "PATH": str(root),
                "KB_PLATFORM_ROOT": str(root / "platform"),
                "KB_JOURNEY_API_TOKEN": secret,
            }
            with invocations.invocation_context(report_root=root):
                invocations.record_invocation(
                    kind="command", argv=[str(shim), "config", "show"], cwd=root,
                    env=env, exit_code=1, duration_seconds=0.1,
                )

            serialized = (root / "invocations/calls.jsonl").read_text()
            record = json.loads(serialized)
            self.assertEqual(record["kb_environment"]["KB_PLATFORM_ROOT"], str(root / "platform"))
            self.assertEqual(record["kb_environment"]["KB_JOURNEY_API_TOKEN"], "[REDACTED]")
            self.assertEqual(record["kb_shim"], {
                "path": str(shim),
                "realpath": os.path.realpath(target),
                "target": str(target),
            })
            self.assertNotIn(secret, serialized)

    # case: S-261.3
    def test_recorded_jsonl_preserves_unicode_line_separators_as_one_valid_row(self):
        with tempfile.TemporaryDirectory(prefix="journey-jsonl-unicode-") as temp:
            root = Path(temp)
            unusual = "NEL\x85 LS\u2028 FS\x1c"
            with invocations.invocation_context(step_id="S-261.3", report_root=root):
                invocations.record_invocation(
                    kind="command", argv=["kb", "--json"], cwd=root, env={}, exit_code=0,
                    stdout=unusual, duration_seconds=0.1,
                )

            rows = jsonl.read_jsonl(root / "invocations" / "calls.jsonl")

        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0].error)
        self.assertEqual(rows[0].line_number, 1)
        self.assertEqual(rows[0].value["stdout"], unusual)

    def test_invocation_captures_structured_error_identity_from_json_response(self):
        with tempfile.TemporaryDirectory(prefix="journey-error-envelope-") as temp:
            root = Path(temp)
            response = {"ok": False, "error": {
                "code": "KB_PLUGIN_CONTRACT_VIOLATION", "area": "plugin", "stage": "run",
                "message": "failure", "hint": "inspect",
            }}
            with invocations.invocation_context(step_id="S-010.4", report_root=root):
                invocations.record_invocation(
                    kind="command", argv=["kb", "--json"], cwd=root, env={}, exit_code=1,
                    stdout=json.dumps(response), duration_seconds=0.1,
                )

            record = jsonl.read_jsonl(root / "invocations/calls.jsonl")[0].value
            self.assertEqual(record["error_envelope"], {
                "code": "KB_PLUGIN_CONTRACT_VIOLATION", "area": "plugin", "stage": "run",
            })

    def test_template_like_data_passes_through_command_and_http_boundaries(self):
        commands = []
        result = invocations.run_command(
            ["kb", "config", "set", "openai.apiKey", "${OPENAI_API_KEY}",
             "--scenario-answers", '{"a":1}'],
            runner=lambda argv, **kwargs: commands.append(argv) or subprocess.CompletedProcess(argv, 0, "", ""),
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(commands[0][-3:], ["${OPENAI_API_KEY}", "--scenario-answers", '{"a":1}'])

        request = urllib.request.Request(
            "http://127.0.0.1:4000/api/v1/config", data=b'{"template":"${OPENAI_API_KEY}","a":1}')
        requests = []
        class Response:
            headers = {}
            def __enter__(self): return self
            def __exit__(self, *_args): return False
            def read(self): return b'{"ok":true,"data":{}}'
            status = 200
        invocations.open_http(lambda req, **kwargs: requests.append(req) or Response(), request, timeout=1)
        self.assertEqual(requests, [request])

    def test_hermetic_share_install_timeout_redacts_token_from_step_and_invocation_evidence(self):
        from hermetic_cli import run_hermetic_cli

        with tempfile.TemporaryDirectory(prefix="journey-share-token-timeout-") as temp:
            root = Path(temp)
            token = "kbrt_0123456789abcdef0123456789abcdef"
            env = {"KB_JOURNEY_MARKETPLACE_SHARE_TOKEN": token}

            def timeout(argv, **_kwargs):
                raise subprocess.TimeoutExpired(argv, 1, output=f"failed {token}")

            command = ["kb", "marketplace", "install", "@owner/private@1.2.3",
                       "--token", token, "--scope", "project", "--json"]
            with invocations.invocation_context(step_id="S-252.2", report_root=root):
                with self.assertRaises(RuntimeError) as failure:
                    run_hermetic_cli(command, cwd=root, env=env, runner=timeout, redact_output=True)

            self.assertNotIn(token, str(failure.exception))
            evidence = (root / "invocations" / "calls.jsonl").read_text(encoding="utf-8")
            self.assertNotIn(token, evidence)
            self.assertIn("[REDACTED]", evidence)

    def test_hermetic_share_install_rejects_token_persisted_in_server_extension_store(self):
        from hermetic_cli import run_hermetic_cli

        with tempfile.TemporaryDirectory(prefix="journey-share-token-store-") as temp:
            root = Path(temp)
            server_kb_home = root / "server-kb-home"
            token = "kbrt_abcdef0123456789abcdef0123456789"

            def persist_token(argv, **kwargs):
                (server_kb_home / "store").mkdir(parents=True)
                (server_kb_home / "store" / "leak.json").write_text(token, encoding="utf-8")
                return subprocess.CompletedProcess(argv, 0, "{\"ok\":true,\"data\":{}}", "")

            with self.assertRaisesRegex(RuntimeError, "persisted in project or extension-store files"):
                run_hermetic_cli(["kb", "marketplace", "install"], cwd=root, env={},
                                 runner=persist_token, forbid_secret_in_files=token,
                                 server_kb_home=server_kb_home)

    def test_share_metadata_query_redacts_token_but_keeps_version_in_invocation_evidence(self):
        with tempfile.TemporaryDirectory(prefix="journey-share-metadata-query-") as temp:
            root = Path(temp)
            token = "kbrt_abcdef0123456789abcdef0123456789"
            env = {"KB_JOURNEY_MARKETPLACE_SHARE_TOKEN": token}
            request = urllib.request.Request(
                "https://gateway.example.test/api/v1/registry/packages/owner/plugin?"
                + urllib.parse.urlencode({"token": token, "version": "1.2.3"}))

            class Response:
                status = 200
                headers = {}
                def __enter__(self): return self
                def __exit__(self, *_args): return False
                def read(self): return b'{"versions":[{"version":"1.2.3"}]}'

            with invocations.invocation_context(step_id="S-252.2", report_root=root):
                status, body, _ = invocations.open_http(
                    lambda _request, **_kwargs: Response(), request, timeout=1, env=env)
            evidence = (root / "invocations" / "calls.jsonl").read_text(encoding="utf-8")
            self.assertEqual(status, 200)
            self.assertIn(b"1.2.3", body)
            self.assertNotIn(token, evidence)
            self.assertIn("version=1.2.3", evidence)
            self.assertIn("[REDACTED]", evidence)

    def test_sensitive_marketplace_cli_error_never_copies_token_code_message_or_hint_to_step(self):
        from marketplace_steps import _sensitive_cli_error_code, _sensitive_cli_success_data

        token = "kbrt_0123456789abcdef0123456789abcdef"
        failure = subprocess.CompletedProcess(
            ["kb", "marketplace", "install"], 1,
            json.dumps({"ok": False, "error": {
                "code": token, "message": token, "hint": token,
            }}), "",
        )
        self.assertEqual(_sensitive_cli_error_code(failure), token)
        with self.assertRaises(RuntimeError) as step_failure:
            _sensitive_cli_success_data(failure)
        self.assertNotIn(token, str(step_failure.exception))
        self.assertIn("details redacted", str(step_failure.exception))

    def test_marketplace_server_kb_home_uses_platform_contract_unless_overridden(self):
        from marketplace_steps import _marketplace_server_kb_home
        from installed_fixture import layout_value

        with tempfile.TemporaryDirectory(prefix="journey-marketplace-server-home-") as temp:
            root = Path(temp)
            platform = root / "installed-platform"
            expected = (platform / layout_value("sharedStateDirectory")
                        / layout_value("kbHomeDirectory")).resolve()
            self.assertEqual(_marketplace_server_kb_home({
                "KB_JOURNEY_PLATFORM_ROOT": str(platform), "KB_HOME": " ",
            }), expected)
            override = root / "service-kb-home"
            self.assertEqual(_marketplace_server_kb_home({
                "KB_JOURNEY_PLATFORM_ROOT": str(platform), "KB_HOME": str(override),
            }), override.resolve())

    def test_hermetic_consumer_registers_project_in_its_own_home_with_installed_kb(self):
        from hermetic_cli import run_hermetic_cli

        with tempfile.TemporaryDirectory(prefix="journey-hermetic-project-registration-") as temp:
            root = Path(temp)
            project = root / "consumer-project"
            project.mkdir()
            server_kb_home = root / "server-kb-home"
            invocations_seen = []

            def configure(home, **_kwargs):
                kb_home = Path(home) / ".kb"
                kb_home.mkdir()
                return {"HOME": str(home), "KB_HOME": str(kb_home),
                        "KB_PLATFORM_ROOT": str(Path(home) / "platform")}

            def run(argv, **kwargs):
                invocations_seen.append((argv, kwargs.get("env", {}).copy()))
                if argv[1:3] == ["project", "add"]:
                    payload = {"ok": True, "data": {"project": {
                        "id": "project-hermetic", "path": str(project.resolve()),
                    }}}
                else:
                    entry = server_kb_home / "store" / "entries" / "@fixture+plugin@1.2.3"
                    (entry / "node_modules" / "@fixture" / "plugin").mkdir(parents=True)
                    (entry / "entry.json").write_text(json.dumps({
                        "name": "@fixture/plugin", "version": "1.2.3",
                    }), encoding="utf-8")
                    payload = {"ok": True, "data": {"installed": []}}
                return subprocess.CompletedProcess(argv, 0, json.dumps(payload), "")

            with patch("hermetic_cli.configure_hermetic_cli_fixture", side_effect=configure):
                result = run_hermetic_cli(["kb", "marketplace", "install", "--json"],
                                          cwd=project, env={}, runner=run, project_root=project,
                                          register_project=True,
                                          require_extension_store_entry=("@fixture/plugin", "1.2.3"),
                                          server_kb_home=server_kb_home)

            self.assertEqual(result.returncode, 0)
            self.assertEqual([call[0][0:3] for call in invocations_seen], [
                ["kb", "project", "add"], ["kb", "marketplace", "install"],
            ])
            registered_home = Path(invocations_seen[0][1]["KB_HOME"])
            self.assertEqual(registered_home, Path(invocations_seen[1][1]["KB_HOME"]))
            self.assertNotEqual(registered_home, project / ".kb")

    def test_missing_project_state_is_rejected_before_url_is_built(self):
        from project_service_path import project_service_path
        from journey_values import MissingJourneyState, journey_value
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(MissingJourneyState, "KB_JOURNEY_PROJECT_ID"):
                journey_value("KB_JOURNEY_PROJECT_ID", required=True)
            with self.assertRaisesRegex(MissingJourneyState, "project-registered"):
                project_service_path("", "rest", "workflow/health")

    def test_pty_timeout_without_output_is_explicit_in_error_and_invocation(self):
        with tempfile.TemporaryDirectory(prefix="journey-pty-empty-timeout-") as temp, \
                invocations.invocation_context(report_root=temp):
            with self.assertRaises(invocations.PtyCommandTimeout) as raised:
                invocations.run_pty_command(
                    [sys.executable, "-c", "import time; time.sleep(5)"], timeout=0.2,
                )

            self.assertEqual(raised.exception.output, "")
            self.assertIn("no output received before the timeout", str(raised.exception))
            call = jsonl.read_jsonl(Path(temp) / "invocations/calls.jsonl")[0].value
            self.assertEqual(call["stdout"], "")
            self.assertIn("no output received before the timeout", call["error"])

    def test_pty_timeout_retains_partial_transcript_without_exported_state(self):
        with tempfile.TemporaryDirectory(prefix="journey-pty-timeout-") as temp, \
                invocations.invocation_context(report_root=temp):
            with self.assertRaises(invocations.PtyCommandTimeout) as raised:
                invocations.run_pty_command(
                    [sys.executable, "-c", "import sys; print('confirmation prompt', flush=True); sys.stdin.read()"],
                    env={"KB_JOURNEY_STATES": '{"candidate":"running"}'}, timeout=0.2,
                )

            self.assertIn("confirmation prompt", raised.exception.output)
            self.assertNotIn("candidate state", str(raised.exception))
            self.assertNotIn('"candidate":"running"', str(raised.exception))
            call = jsonl.read_jsonl(Path(temp) / "invocations/calls.jsonl")[0].value
            self.assertIn("confirmation prompt", call["stdout"])
            self.assertNotIn('"candidate":"running"', call["error"])

    def test_pty_eof_waits_for_child_exit_instead_of_recording_timeout(self):
        class ExitingProcess:
            pid = 12345
            returncode = None

            def poll(self):
                return self.returncode

            def wait(self, timeout=None):
                self.returncode = 1
                return self.returncode

            def kill(self):
                raise AssertionError("an exited PTY child must not be killed as a timeout")

        process = ExitingProcess()
        records = []
        with tempfile.TemporaryDirectory(prefix="journey-pty-evidence-") as temp:
            with (invocations.invocation_context(report_root=temp),
                  patch.object(invocations.subprocess, "Popen", return_value=process),
                  patch.object(invocations.select, "select", side_effect=lambda readers, *_args: (readers, [], [])),
                  patch.object(invocations.os, "read", side_effect=OSError(5, "PTY reached EOF")),
                  patch.object(invocations, "record_invocation",
                               side_effect=lambda **record: records.append(record))):
                result, _ = invocations.run_pty_command(
                    [sys.executable, "-c", "raise SystemExit(1)"], timeout=120, raise_on_timeout=False,
                )

        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["exit_code"], 1)
        self.assertIsNone(records[0]["error"])


class ReportRedactionTest(unittest.TestCase):
    def test_kb_create_failure_row_names_copied_log_and_diagnostic_paths(self):
        with tempfile.TemporaryDirectory(prefix="journey-kb-create-dossier-") as temp:
            root = Path(temp)
            log = root / "apply.log"
            diagnostic = root / "apply-diagnostic.json"
            secret = "diagnostic-bearer-secret-value"
            log.write_text("first diagnostic line\n"
                           + "\n".join(f"apply detail {line}" for line in range(250))
                           + f"\npnpm failed with token {secret}\n")
            diagnostic.write_text(json.dumps({"error": "apply failed", "token": secret}))
            payload = {"ok": False, "error": {"code": "KB_INSTALL_APPLY_FAILED",
                                                "message": "apply failed",
                                                "details": {"logPath": str(log),
                                                            "diagnosticPath": str(diagnostic)}}}
            output = jsonl.encode_jsonl_records((payload, {
                "ok": True, "data": None,
                "meta": {"stream": {"terminal": True, "exitCode": 1}},
            }))
            runner = lambda *_args, **_kwargs: subprocess.CompletedProcess(
                args=["kb-create", "install"], returncode=1,
                stdout=output, stderr="")
            env = {"KB_JOURNEY_API_TOKEN": secret}

            with invocations.invocation_context(step_id="S-001.9", report_root=root):
                invocations.run_command(["kb-create", "install", "--json"], env=env, runner=runner)
                row_reference = invocations.invocation_link("S-001.9")

            call = jsonl.read_jsonl(root / "invocations/calls.jsonl")[0].value
            self.assertEqual(len(call["invocation_evidence"]), 2)
            self.assertIn(call["invocation_evidence"][0], row_reference)
            self.assertIn(call["invocation_evidence"][1], row_reference)
            for relative in call["invocation_evidence"]:
                copied = root / relative
                text = copied.read_text()
                self.assertNotIn(secret, text)
                self.assertTrue(text)
                if copied.name.endswith("apply.log"):
                    self.assertIn("first diagnostic line", text)

    def test_typed_command_failure_attaches_redacted_product_named_log_files(self):
        with tempfile.TemporaryDirectory(prefix="journey-failure-log-evidence-") as temp:
            root = Path(temp)
            log = root / "host.log"
            secret = "secured-bearer-state-sentinel-value"
            state_bundle = json.dumps({"service-api-session": {"passed": True, "value": secret}})
            log.write_text(f"startup failed\nKB_JOURNEY_STATES={state_bundle}\n")
            env = {"KB_JOURNEY_SERVICE_TOKEN": secret, "KB_JOURNEY_STATES": state_bundle}
            payload = {"ok": False, "error": {"code": "KB_HOST_START_FAILED",
                                                "message": "host could not start",
                                                "details": {"log": str(log)}}}
            runner = lambda *_args, **_kwargs: subprocess.CompletedProcess(
                args=["kb-create", "start"], returncode=1,
                stdout=json.dumps(payload), stderr="")

            with invocations.invocation_context(step_id="S-001.1", report_root=root):
                invocations.run_command(["kb-create", "start", "--json"], env=env, runner=runner)

            call = jsonl.read_jsonl(root / "invocations/calls.jsonl")[0].value
            self.assertEqual(len(call["invocation_evidence"]), 1)
            evidence = root / call["invocation_evidence"][0]
            self.assertIn("startup failed", evidence.read_text())
            self.assertNotIn(secret, evidence.read_text())
            self.assertIn('"value": "[REDACTED]"', evidence.read_text())

    def test_short_secret_values_only_redact_structural_secret_fields(self):
        with tempfile.TemporaryDirectory(prefix="journey-short-redaction-") as temp:
            target = Path(temp) / "report.json"
            source = {
                "exit_code": 1,
                "case_id": "S-187.7",
                "path": "/tmp/common/path",
                "message": "one common value remains useful here",
                "command_text": "APP_PASSWORD=1 --token common",
                "environment": {"APP_PASSWORD": "1", "APP_TOKEN": "common"},
                "argv": ["kb", "--token", "common", "--path", "/tmp/common/path"],
            }
            expected = {
                "exit_code": 1,
                "case_id": "S-187.7",
                "path": "/tmp/common/path",
                "message": "one common value remains useful here",
                "command_text": "APP_PASSWORD=[REDACTED] --token [REDACTED]",
                "environment": {"APP_PASSWORD": "[REDACTED]", "APP_TOKEN": "[REDACTED]"},
                "argv": ["kb", "--token", "[REDACTED]", "--path", "/tmp/common/path"],
            }
            invocations.write_report_json(
                target, source, env={"APP_PASSWORD": "1", "APP_TOKEN": "common"})

            rendered = target.read_text()
            self.assertEqual(rendered, json.dumps(expected, indent=2) + "\n")
            self.assertEqual(json.loads(rendered), expected)

    def test_each_report_boundary_redacts_an_unredacted_payload(self):
        env = {}
        secret = invocations.store_report_secret(
            env, "KB_JOURNEY_API_TOKEN", "synthetic-boundary-secret-for-tests",
            "synthetic boundary test secret")
        with tempfile.TemporaryDirectory(prefix="journey-boundary-redaction-") as temp:
            root = Path(temp)
            json_path = root / "direct.json"
            invocations.write_report_json(json_path, {"message": secret}, env=env)
            self.assertNotIn(secret, json_path.read_text())
            self.assertEqual(json.loads(json_path.read_text())["message"], "[REDACTED]")

            text_path = root / "direct.txt"
            invocations.write_report_text(text_path, f"message: {secret}", env=env)
            self.assertNotIn(secret, text_path.read_text())

            printed = io.StringIO()
            invocations.print_report_text(f"message: {secret}", env=env, stream=printed)
            self.assertNotIn(secret, printed.getvalue())

            with invocations.invocation_context(report_root=root):
                invocations.record_invocation(
                    kind="command", argv=["kb", "--token", secret], cwd=root,
                    env=env, exit_code=1, stdout=secret, stderr="", duration_seconds=0.1,
                )
            invocation = (root / "invocations" / "calls.jsonl").read_text()
            self.assertNotIn(secret, invocation)
            self.assertEqual(json.loads(invocation)["exit_code"], 1)

    def test_journey_sources_store_secret_environment_values_through_shared_helper(self):
        root = Path(__file__).parent
        violations = []
        for source in sorted(root.rglob("*.py")):
            if source.name.startswith("test_"):
                continue
            violations.extend(secret_environment_write_violations(source.read_text(), str(source)))

        self.assertEqual(violations, [])

    def test_secret_environment_source_scan_covers_mapping_writes_and_allows_reads(self):
        writes = (
            'env.update({"KB_X_TOKEN": value})',
            'os.environ.update({"KB_X_TOKEN": value})',
            'env.update(KB_X_TOKEN=value)',
            'os.environ.update(KB_X_TOKEN=value)',
            'env.update(**{"KB_X_TOKEN": value})',
            'env = {**env, "KB_X_TOKEN": value}',
            'merged = env | {"KB_X_TOKEN": value}',
        )
        for source in writes:
            with self.subTest(source=source):
                self.assertTrue(secret_environment_write_violations(source), source)

        reads = (
            'value = env["KB_X_TOKEN"]',
            'value = env.get("KB_X_TOKEN")',
            'present = "KB_X_TOKEN" in env',
        )
        for source in reads:
            with self.subTest(source=source):
                self.assertEqual(secret_environment_write_violations(source), [], source)

        self.assertEqual(secret_environment_write_violations('env["KB_X_TOKEN"] = ""'), [])
        self.assertTrue(secret_environment_write_violations('env["KB_X_TOKEN"] = token'))


if __name__ == "__main__":
    unittest.main()
