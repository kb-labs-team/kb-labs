import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess

sys.path.insert(0, str(Path(__file__).parent))

import workflow_steps
from installed_fixture import configure_hermetic_cli_fixture
from service_steps import Journey
from invocations import catalogued_error_hint, catalogued_error_message
import jsonl


class WorkflowJourneyTests(unittest.TestCase):
    def test_registry_representative_selection_fails_for_unrepresented_protection_class(self):
        registry_listing = {
            "data": {"commands": [
                {"path": ["config", "show"], "protectionClass": "session:system", "requiresSession": True, "available": True},
                {"path": ["workflow", "defs", "list"], "protectionClass": "session:plugin", "requiresSession": True, "available": True},
                {"path": ["auth", "status"], "protectionClass": "public:system", "requiresSession": False, "available": True},
                {"path": ["new", "feature"], "protectionClass": "session:new-class", "requiresSession": True, "available": False},
            ]}
        }

        with self.assertRaisesRegex(AssertionError, "session:new-class"):
            workflow_steps.select_session_protection_representatives(registry_listing)

    def test_registry_representative_selection_uses_one_command_from_each_session_class(self):
        registry_listing = {
            "data": {"commands": [
                {"path": ["config", "show"], "protectionClass": "session:system", "requiresSession": True, "available": True},
                {"path": ["workflow", "defs", "list"], "protectionClass": "session:plugin", "requiresSession": True, "available": True},
                {"path": ["auth", "status"], "protectionClass": "public:system", "requiresSession": False, "available": True},
            ]}
        }

        self.assertEqual(workflow_steps.select_session_protection_representatives(registry_listing), {
            "session:system": ["config", "show"],
            "session:plugin": ["workflow", "defs", "list"],
        })

    # case: S-203.1
    def test_bash_profile_cli_capture_keeps_stderr_separate_from_stdout(self):
        with tempfile.TemporaryDirectory(prefix="journey-cli-streams-") as temp:
            env = {
                **os.environ,
                "HOME": temp,
                "KB_JOURNEY_INVOCATIONS": temp,
                "KB_JOURNEY_CLI_PATH": "/bin/sh",
            }
            result = workflow_steps.run_cli(
                ["-c", "printf envelope; printf diagnostic >&2"],
                env=env,
                cwd=Path(temp),
            )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "envelope")
        self.assertEqual(result.stderr, "diagnostic")

    def test_solo_workflow_list_claim_fails_when_workflow_id_field_is_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            (project / ".kb" / "workflows").mkdir(parents=True)

            def fake_run(args, *, env, cwd, timeout=120, input_text=None):
                if args == ["workflow", "create"]:
                    (cwd / ".kb" / "workflows" / "hello.yml").write_text(
                        "on:\n  manual: true\ncommand: echo hello-workflow\n", encoding="utf-8")
                    return CompletedProcess(args, 0,
                                            "Created .kb/workflows/hello.yml\n"
                                            "Next: kb workflow lint && kb workflow run --workflow-id=hello\n")
                if args == ["workflow", "lint"]:
                    return CompletedProcess(args, 0, ".kb/workflows/hello.yml is valid\n")
                if args[:2] == ["workflow", "run"]:
                    return CompletedProcess(args, 0, json.dumps({"ok": True, "data": {
                        "runId": "solo-run", "status": "queued"}}))
                if args[:3] == ["workflow", "runs", "view"] and "--json=all" in args:
                    return CompletedProcess(args, 0, json.dumps({"ok": True, "data": {
                        "id": "solo-run", "name": "hello", "status": "success",
                        "jobs": [{"steps": [{"id": "hello", "status": "success",
                                               "output": "hello-workflow", "outputs": {}}]}]}}))
                if args[:3] == ["workflow", "runs", "view"]:
                    return CompletedProcess(args, 1, json.dumps({"ok": False, "error": {
                        "code": "KB_RUNTIME_WORKFLOW_RUN_NOT_FOUND",
                        "message": "Workflow run journey-run-does-not-exist was not found.",
                        "hint": 'Run "kb workflow runs list" to inspect available runs.',
                    }}))
                if args[:3] == ["workflow", "runs", "list"]:
                    # Valid runs-list shape from the command's WorkflowRunSummary contract, but it omits
                    # S-002.5's required workflowId field instead of silently substituting another key.
                    return CompletedProcess(args, 0, json.dumps({"ok": True, "data": [{
                        "id": "solo-run", "name": "hello", "status": "success"}]}))
                return CompletedProcess(args, 1, "unexpected fake CLI command")

            old_run_cli = workflow_steps.run_cli
            workflow_steps.run_cli = fake_run
            try:
                journey = Journey("local", "workflow-list-contract")
                workflow_steps._solo_workflow_case(
                    journey, env={"HOME": directory}, project=project,
                    clock=lambda: 0.0, sleep=lambda _seconds: None)
            finally:
                workflow_steps.run_cli = old_run_cli

            claims = {claim["claimId"]: claim["status"] for claim in journey.result().case_run["claims"]}
            self.assertEqual(claims["S-002.5"], "FAIL")
            failed_step = next(step for step in journey.steps if step.name == "find solo project workflow in history")
            self.assertIn("requires `data[].workflowId`", failed_step.message)

    def test_new_workflow_claims_fail_against_fake_cli_errors(self):
        cases = {
            workflow_steps._solo_workflow_case: {f"S-002.{step}" for step in range(1, 7)},
            workflow_steps._cancellation_case: {f"S-008.{step}" for step in range(1, 5)},
            workflow_steps._live_progress_case: {f"S-027.{step}" for step in range(1, 4)},
            workflow_steps._real_work_case: {f"S-028.{step}" for step in range(1, 4)},
            workflow_steps._rerun_case: {f"S-143.{step}" for step in range(1, 5)},
        }

        def fake_failure(args, *, env, cwd, timeout=120):
            return CompletedProcess(args, 1, "fake gateway failure")

        def fake_watch(command, *, cwd, env, timeout, on_output):
            return CompletedProcess(command, 1, "fake gateway failure"), 0.0

        old_run_cli = workflow_steps.run_cli
        old_pty = workflow_steps.run_pty_command
        workflow_steps.run_cli = fake_failure
        workflow_steps.run_pty_command = fake_watch
        try:
            for helper, expected_claims in cases.items():
                with self.subTest(helper=helper.__name__), tempfile.TemporaryDirectory() as directory:
                    project = Path(directory)
                    (project / ".kb" / "workflows").mkdir(parents=True)
                    journey = Journey("local", f"red-{helper.__name__}")
                    kwargs = {"env": {"HOME": directory}, "project": project}
                    if helper is workflow_steps._solo_workflow_case:
                        kwargs.update(clock=lambda: 0.0, sleep=lambda _seconds: None)
                    elif helper is workflow_steps._cancellation_case:
                        kwargs.update(clock=lambda: 0.0, sleep=lambda _seconds: None)
                    elif helper in {workflow_steps._real_work_case, workflow_steps._rerun_case}:
                        kwargs.update(clock=lambda: 0.0, sleep=lambda _seconds: None)
                    helper(journey, **kwargs)
                    statuses = {claim: step.status for step in journey.steps for claim in step.cases}
                    self.assertEqual(set(statuses), expected_claims)
                    if helper is workflow_steps._cancellation_case:
                        expected_statuses = {"S-008.1": "FAIL", "S-008.2": "BLOCKED",
                                             "S-008.3": "BLOCKED", "S-008.4": "BLOCKED"}
                    elif helper is workflow_steps._live_progress_case:
                        expected_statuses = {"S-027.1": "FAIL", "S-027.2": "BLOCKED", "S-027.3": "BLOCKED"}
                    elif helper is workflow_steps._rerun_case:
                        expected_statuses = {"S-143.1": "BLOCKED", "S-143.2": "BLOCKED",
                                             "S-143.3": "BLOCKED", "S-143.4": "FAIL"}
                    else:
                        expected_statuses = {claim: "FAIL" for claim in expected_claims}
                    self.assertEqual(statuses, expected_statuses)
        finally:
            workflow_steps.run_cli = old_run_cli
            workflow_steps.run_pty_command = old_pty

    def test_secured_plugin_commands_are_gated_and_admin_login_recovers(self):
        authenticated = [False]
        calls = []
        repository = Path(__file__).resolve().parents[2]
        cli_path = repository / "cli" / "bin" / "dist" / "bin.js"
        with tempfile.TemporaryDirectory(prefix="journey-registry-cli-") as fixture:
            home = Path(fixture) / "home"
            home.mkdir()
            launcher = Path(fixture) / "kb-built"
            launcher.write_text(f'#!/bin/sh\nexec node "{cli_path}" "$@"\n', encoding="utf-8")
            launcher.chmod(0o755)
            registry_env = {key: value for key, value in os.environ.items() if not key.startswith("KB_")}
            registry_env.update({"HOME": str(home), "KB_JOURNEY_CLI_PATH": str(launcher)})
            registry_env = configure_hermetic_cli_fixture(
                home, env=registry_env, workspace_root=repository)
            registry_result = workflow_steps.run_cli(["registry", "commands", "--json"],
                                                       env=registry_env, cwd=Path(registry_env["KB_PROJECT_ROOT"]))
            if registry_result.returncode != 0:
                self.fail(f"built CLI registry listing failed: {(registry_result.stderr or registry_result.stdout).strip()}")
            real_listing = json.loads(registry_result.stdout)
        commands = real_listing["data"]["commands"]
        session_paths = [tuple(command["path"]) for command in commands if command["requiresSession"]]
        self.assertIn(("registry", "commands"), session_paths)
        self.assertIn(("project", "add"), session_paths)
        representatives = workflow_steps.select_session_protection_representatives(real_listing)

        def refused(args):
            correlation_id = f"journey-correlation-{len(calls)}"
            envelope = {"ok": False, "error": {
                "code": "KB_AUTH_REQUIRED", "message": catalogued_error_message("KB_AUTH_REQUIRED"),
                "hint": catalogued_error_hint("KB_AUTH_REQUIRED", gatewayUrl="http://127.0.0.1:4000"),
                "correlationId": correlation_id,
            }}
            diagnostic = json.dumps({"event": "cli.bootstrap.context.resolved", "correlationId": correlation_id})
            return CompletedProcess(args, 1, json.dumps(envelope), f"[WARN] CLI resolved invocation context {diagnostic}")

        def fake_run(args, *, env, cwd, timeout=120, input_text=None):
            args = list(args)
            calls.append(args)
            if args[:2] == ["auth", "login"] and "--help" not in args:
                self.assertIn("admin@example.test", args)
                self.assertNotIn("admin-password", args)
                self.assertEqual(input_text, "admin-password\n")
                authenticated[0] = True
                return CompletedProcess(args, 0, "Logged in")
            if args[:2] == ["auth", "logout"]:
                authenticated[0] = False
                return CompletedProcess(args, 0, json.dumps({"ok": True, "data": {}}))
            path = tuple(argument for argument in args if argument != "--json")
            is_session_command = any(path[:len(command_path)] == command_path for command_path in session_paths)
            if is_session_command and not authenticated[0]:
                if "--json" not in args:
                    return CompletedProcess(args, 1,
                                            f"KB_AUTH_REQUIRED: {catalogued_error_message('KB_AUTH_REQUIRED')}\nHint: {catalogued_error_hint('KB_AUTH_REQUIRED', gatewayUrl='http://127.0.0.1:4000')}\n")
                return refused(args)
            if args[:2] == ["project", "add"]:
                target = Path(args[2]).resolve()
                return CompletedProcess(args, 0, json.dumps({"ok": True, "data": {"project": {"path": str(target)}}}))
            if args == ["project", "list", "--json"]:
                return CompletedProcess(args, 0, json.dumps({"ok": True, "data": {"projects": [{"path": "/tmp/project"}]}}))
            if args == ["registry", "commands", "--json"]:
                return CompletedProcess(args, 0, json.dumps(real_listing))
            if args == ["auth", "status", "--json"]:
                return CompletedProcess(args, 0, json.dumps({"ok": True, "data": {"authenticated": False, "session": {"authenticated": False}}}))
            if args in (["auth", "login", "--help"], ["version"], ["health", "--json"]):
                return CompletedProcess(args, 0, json.dumps({"ok": True}))
            if is_session_command:
                return CompletedProcess(args, 0, json.dumps({"ok": True, "data": {"id": "fixture"}}))
            self.fail(f"unexpected CLI command: {args!r}")

        old_run_cli = workflow_steps.run_cli
        workflow_steps.run_cli = fake_run
        try:
            with tempfile.TemporaryDirectory() as home:
                journey = Journey("secured", "workflow-auth")
                report_root = Path(home) / "journey-report"
                workflow_steps.run_secured_cli_auth_step(
                    journey,
                    env={"HOME": home,
                         "KB_JOURNEY_CLI_PATH": "/installed/bin/kb",
                         "KB_JOURNEY_PLATFORM_ROOT": "/installed/platform",
                         "KB_JOURNEY_INVOCATIONS": str(report_root),
                         "KB_JOURNEY_BASE_URL": "http://127.0.0.1:4000",
                         "KB_JOURNEY_ADMIN_EMAIL": "admin@example.test",
                         "KB_JOURNEY_ADMIN_PASSWORD": "admin-password"},
                    project=Path("/tmp/project"),
                )
                registry_record = jsonl.read_jsonl(report_root / "project-registries.jsonl")[0].value
                self.assertEqual(registry_record["mode"], "secured")
                self.assertEqual(registry_record["projects"], [{"path": "/tmp/project"}])
        finally:
            workflow_steps.run_cli = old_run_cli

        result = journey.result()
        self.assertEqual(result.status, "PASS", result.first_failure)
        setup_login = calls.index(next(call for call in calls if call[:2] == ["auth", "login"] and "--help" not in call))
        project_add = calls.index(["project", "add", "/tmp/project", "--json"])
        listing_call = calls.index(["registry", "commands", "--json"])
        logout = calls.index(["auth", "logout", "--json"])
        self.assertLess(setup_login, project_add)
        self.assertLess(project_add, listing_call)
        self.assertLess(listing_call, logout)
        first_anonymous_probe = logout + 1
        self.assertEqual(calls[first_anonymous_probe], ["project", "add", str(Path(calls[first_anonymous_probe][2])), "--json"])
        expected_probe_paths = [[*paths, "--json"] for paths in representatives.values()]
        self.assertEqual(calls[first_anonymous_probe + 1:first_anonymous_probe + 1 + len(expected_probe_paths) * 2],
                         expected_probe_paths * 2)
        self.assertEqual(result.case_run["claims"], [
            {"claimId": "S-007.4", "kind": "journey", "status": "PASS"},
            {"claimId": "S-041.12", "kind": "journey", "status": "PASS"},
            {"claimId": "S-041.17", "kind": "journey", "status": "PASS"},
            {"claimId": "S-041.7", "kind": "journey", "status": "PASS"},
            {"claimId": "S-041.8", "kind": "journey", "status": "PASS"},
        ])

    def test_workflow_and_cron_cases_assert_outcomes_and_claim_steps(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            (project / ".kb").mkdir()
            clock = [0.0]
            run_list_calls = {"journey-hello": 0, "journey-fails": 0, "journey-cron-target": 0}
            cron_fired = [False]
            restart_calls = []
            marketplace_install_calls = []
            cancelled = [False]
            progress_finished = [False]
            successful_workflow_commands = []

            def fake_sleep(seconds):
                clock[0] += seconds

            def fake_run(args, *, env, cwd, timeout=120):
                args = list(args)
                output = {}
                if args[:2] == ["marketplace", "install"]:
                    marketplace_install_calls.append(args)
                    output = {"ok": True, "data": {"installed": [{"id": "@kb-labs/steward"}]}}
                elif args == ["workflow", "create"]:
                    target = cwd / ".kb" / "workflows" / "hello.yml"
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text("name: hello\non:\n  manual: true\ncommand: echo hello-workflow\n")
                    return CompletedProcess(args, 0, "Created .kb/workflows/hello.yml\nNext: kb workflow lint && kb workflow run --workflow-id=hello\n")
                elif args == ["workflow", "lint"]:
                    target = "real-work.yml" if (cwd / ".kb" / "workflows" / "real-work.yml").exists() else "hello.yml"
                    return CompletedProcess(args, 0, f".kb/workflows/{target} is valid\n")
                elif args[:2] == ["workflow", "run"]:
                    workflow_arg = next((arg.split("=", 1)[1] for arg in args if arg.startswith("--workflow-id=")), "")
                    if workflow_arg == "journey-hello":
                        successful_workflow_commands.append(workflow_arg)
                    run_id = {"hello": "ok-run", "journey-hello": "ok-run", "journey-fails": "failed-run",
                              "journey-cancel": "cancel-run", "journey-progress": "progress-run",
                              "real-work": "real-run", "journey-rerun": "source-run"}.get(workflow_arg, "failed-run")
                    output = {"ok": True, "data": {"runId": run_id, "status": "queued"}}
                elif args[:3] == ["workflow", "runs", "cancel"]:
                    if cancelled[0]:
                        return CompletedProcess(args, 1, "", stderr="Run is already finished")
                    cancelled[0] = True
                    return CompletedProcess(args, 0, f"Cancellation requested for {args[3]}")
                elif args[:3] == ["workflow", "runs", "view"]:
                    run_id = args[3]
                    if run_id == "journey-run-does-not-exist":
                        return CompletedProcess(args, 1, json.dumps({"ok": False, "error": {
                            "code": "KB_RUNTIME_WORKFLOW_RUN_NOT_FOUND",
                            "message": f"Workflow run {run_id} was not found.",
                            "hint": 'Run "kb workflow runs list" to inspect available runs.',
                        }}))
                    status = ("cancelled" if run_id == "cancel-run" and cancelled[0] else
                              "failed" if run_id in {"failed-run", "source-run", "rerun-one", "rerun-failed"} else "success")
                    if run_id == "cancel-run" and not cancelled[0]:
                        status = "running"
                    if run_id == "progress-run" and not progress_finished[0]:
                        status = "running"
                    if run_id == "rerun-one":
                        status = "failed"
                    output = {"ok": True, "data": {
                        "id": run_id,
                        "name": {"ok-run": "hello", "real-run": "real-work",
                                 "source-run": "journey-rerun", "rerun-one": "journey-rerun",
                                 "rerun-failed": "journey-rerun"}.get(run_id, "journey-fails"),
                        "status": status,
                        "trigger": {"type": "schedule", "metadata": {"cronId": "journey-cron"}}
                        if run_id == "cron-run" else {"type": "manual"},
                        "metadata": {"cronId": "journey-cron"} if run_id == "cron-run" else {},
                        "inputs": {"message": "rerun-input"} if run_id in {"source-run", "rerun-one", "rerun-failed"} else
                                  {"message": "hello"} if run_id == "ok-run" else {},
                        "workflowId": "journey-rerun" if run_id in {"source-run", "rerun-one", "rerun-failed"} else
                                      "real-work" if run_id == "real-run" else "hello",
                        "jobs": [{"steps": [{"id": "failed-run:smoke:0", "name": "Deliberate failure",
                                              "spec": {"id": "deliberate-failure"}, "status": "failed",
                                              "error": {"message": "journey-failure-diagnostic"}}]}]
                        if run_id == "failed-run" else ([{"steps": [
                            {"spec": {"id": "succeeds"}, "status": "success"},
                            {"spec": {"id": "fails"}, "status": "failed"}]}]
                            if run_id in {"source-run", "rerun-one", "rerun-failed"} else
                            ([{"steps": [{"output": "hello-workflow", "spec": {"id": "hello"}, "status": "success"}]}]
                             if run_id == "ok-run" else
                             ([{"steps": [
                                 {"spec": {"id": "write-marker"}, "status": "success"},
                                 {"spec": {"id": "check-health"}, "status": "success"}]}]
                              if run_id == "real-run" else []))),
                    }}
                elif args[:3] == ["workflow", "runs", "logs"]:
                    run_id = args[3]
                    message = "hello hello-workflow" if run_id == "ok-run" else "journey-failure-diagnostic"
                    if run_id == "real-run":
                        marker = cwd / ".kb" / "workflow-marker"
                        marker.write_text("done")
                        message = "healthy write-marker check-health"
                    if run_id == "cron-run":
                        message = "journey-cron-fired"
                    return CompletedProcess(args, 0, f"{message}\n")
                elif args[:3] == ["workflow", "runs", "rerun"]:
                    if args[3] == "run-does-not-exist":
                        return CompletedProcess(args, 1, json.dumps({"ok": False, "error": {
                            "code": "KB_RUNTIME_WORKFLOW_RUN_NOT_FOUND", "message": "Run run-does-not-exist not found",
                            "hint": "Run kb workflow runs list to see available runs"}}))
                    run_id = "rerun-failed" if "--failed-only" in args else "rerun-one"
                    output = {"ok": True, "data": {"runId": run_id, "status": "queued"}}
                elif args[:3] == ["workflow", "runs", "list"]:
                    workflow_arg = next((arg.split("=", 1)[1] for arg in args if arg.startswith("--workflow=")), None)
                    if workflow_arg is None:
                        runs = [
                            {"id": "ok-run", "name": "journey-hello", "status": "success", "createdAt": "now"},
                            {"id": "failed-run", "name": "journey-fails", "status": "failed", "createdAt": "now"},
                        ]
                    elif workflow_arg == "journey-hello":
                        run_list_calls[workflow_arg] += 1
                        runs = [{"id": "ok-run", "name": "journey-hello", "status": "success", "createdAt": "now"}]
                    elif workflow_arg == "hello":
                        runs = [{"id": "ok-run", "name": "hello", "status": "success", "workflowId": "hello"}]
                    elif workflow_arg == "journey-fails":
                        run_list_calls[workflow_arg] += 1
                        runs = [{"id": "failed-run", "name": "journey-fails", "status": "failed", "createdAt": "now"}]
                    else:
                        run_list_calls[workflow_arg] += 1
                        schedule_file = cwd / ".kb" / "crons" / "journey-cron.yml"
                        enabled = schedule_file.exists() and "enabled: true" in schedule_file.read_text()
                        if enabled:
                            cron_fired[0] = True
                        if cron_fired[0]:
                            runs = [{"id": "cron-run", "name": "journey-cron-target", "status": "success",
                                     "trigger": {"type": "schedule", "metadata": {"cronId": "journey-cron"}}}]
                        else:
                            runs = []
                    output = {"ok": True, "data": runs}
                elif args[:3] == ["workflow", "crons", "list"]:
                    schedule_file = cwd / ".kb" / "crons" / "journey-cron.yml"
                    enabled = schedule_file.exists() and "enabled: true" in schedule_file.read_text()
                    exists = schedule_file.exists()
                    content = schedule_file.read_text() if exists else ""
                    errors = []
                    if "not a cron" in content:
                        errors = [{"file": ".kb/crons/journey-cron.yml", "reason": "invalid cron expression"}]
                    elif "missing-workflow" in content:
                        errors = [{"file": ".kb/crons/journey-cron.yml", "reason": "unknown workflow missing-workflow"}]
                    output = {"ok": True, "data": {"crons": [{
                        "id": "journey-cron", "source": "user", "enabled": enabled,
                        "schedule": "* * * * *", "target": {"workflow": "journey-cron-target"},
                        "input": {"message": "journey-cron-fired"},
                        "nextFireAt": "next",
                    }, {"id": "plugin:test:read-only", "source": "plugin", "enabled": True,
                        "schedule": "0 0 * * *", "target": {"handler": "test:cleanup"}}
                    ] if exists and not errors else [{"id": "plugin:test:read-only", "source": "plugin",
                        "enabled": True, "schedule": "0 0 * * *", "target": {"handler": "test:cleanup"}}], "errors": errors}}
                elif args[:3] == ["workflow", "crons", "disable"]:
                    schedule_file = cwd / ".kb" / "crons" / "journey-cron.yml"
                    schedule_file.write_text(schedule_file.read_text().replace("enabled: true", "enabled: false"))
                    output = {"ok": True, "data": {"enabled": False}}
                elif args[:3] == ["workflow", "crons", "enable"]:
                    if args[3].startswith("plugin:"):
                        return CompletedProcess(args, 1, "", stderr="CronMutationRefused: plugin crons are read-only")
                    schedule_file = cwd / ".kb" / "crons" / "journey-cron.yml"
                    schedule_file.write_text(schedule_file.read_text().replace("enabled: false", "enabled: true"))
                    output = {"ok": True, "data": {"enabled": True}}
                elif args[:3] == ["workflow", "defs", "list"]:
                    output = {"ok": True, "data": [
                        {"id": "journey-hello", "name": "journey-hello", "source": "standalone"},
                        {"id": "journey-fails", "name": "journey-fails", "source": "standalone"},
                        {"id": "journey-cron-target", "name": "journey-cron-target", "source": "standalone"},
                        {"id": "hello", "name": "hello", "source": "standalone"}]}
                else:
                    self.fail(f"unexpected CLI command: {args!r}")
                return CompletedProcess(args, 0, json.dumps(output))

            old_run_cli = workflow_steps.run_cli
            old_run_pty_command = workflow_steps.run_pty_command
            workflow_steps.run_cli = fake_run
            def fake_run_pty(command, *, cwd, env, timeout, on_output):
                run_id = command[-1]
                transcript = (f"Watching run {run_id}\nstep.started step:first-id\nstep.succeeded step:first-id\n"
                              "step.started step:second-i\nstep.succeeded step:second-i\n"
                              "run.finished\nRun SUCCESS.\n")
                on_output(transcript)
                progress_finished[0] = True
                return CompletedProcess(command, 0, transcript), 0.0
            workflow_steps.run_pty_command = fake_run_pty
            try:
                journey = Journey("local", "workflow-fixture")
                journey_env = {"HOME": directory}
                workflow_steps.run_workflow_journey(
                    journey,
                    env=journey_env,
                    project=project,
                    restart_host=lambda: restart_calls.append("kb-create restart --platform-root <platform>"),
                    clock=lambda: clock[0],
                    sleep=fake_sleep,
                )
            finally:
                workflow_steps.run_cli = old_run_cli
                workflow_steps.run_pty_command = old_run_pty_command

        self.assertEqual(journey_env.get("KB_STUDIO_DIAGNOSTIC_RUN_ID"), "failed-run")
        self.assertEqual(successful_workflow_commands, ["journey-hello"])

        result = journey.result()
        self.assertEqual(result.status, "PASS", result.first_failure)
        self.assertEqual(marketplace_install_calls, [["marketplace", "install", "@kb-labs/steward", "--json"]])
        self.assertEqual(restart_calls, [
            "kb-create restart --platform-root <platform>",
            "kb-create restart --platform-root <platform>",
        ])
        claims = {claim["claimId"] for claim in result.case_run["claims"]}
        self.assertEqual(claims, {
            "S-002.1", "S-002.2", "S-002.3", "S-002.4", "S-002.5", "S-002.6",
            "S-008.1", "S-008.2", "S-008.3", "S-008.4",
            "S-027.1", "S-027.2", "S-027.3", "S-028.1", "S-028.2", "S-028.3",
            "S-143.1", "S-143.2", "S-143.3", "S-143.4",
            "S-006.3", "S-007.1", "S-007.2", "S-007.3", "S-009.1", "S-009.2", "S-009.3", "S-009.4", "PC-002.5",
            "S-029.1", "S-029.2", "S-029.3", "S-044.1", "S-044.2", "S-044.3", "S-044.4",
            "S-044.5", "S-044.6", "S-044.7", "S-044.8",
            "S-056.1", "S-056.2", "S-056.3",
        })

        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "service-local.json"
            report.write_text(json.dumps({
                "steps": [],
                "case_run": {"schema": "kb.qa-case-run/v2", "runId": "base", "mode": "local",
                             "claims": [{"claimId": "S-001.1", "kind": "journey", "status": "PASS"}]},
            }))
            merged = workflow_steps.merge_workflow_result(report, result.__dict__)
            merged_ids = {claim["claimId"] for claim in merged["case_run"]["claims"]}
            self.assertEqual(merged_ids, claims | {"S-001.1"})


if __name__ == "__main__":
    unittest.main()
