"""Fake-transport unit coverage for S-045 and S-140 MCP journey claims."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

from mcp_tool_names import DEFAULT_ENABLED_SERVICES, commit_tool, service_tool_names
from mcp_project_steps import (apply_commit_plan, commit_tool_schema, invalid_arguments, local_auth,
                               mcp_ux_result_contract, project_isolation, project_plugin_catalog_isolation,
                               project_readonly_tool_isolation,
                               run_agent_session_steps,
                               opaque_host_credential_mcp_rejection, secured_auth, secured_project_catalog_isolation, unknown_tool)
from service_steps import FlowGraph, Journey
from invocations import catalogued_error_hint
import service_runner
from service_runner import checks


def tool_error(code: str, message: str, hint: str):
    envelope = {
        "code": code,
        "area": "project",
        "stage": "run",
        "severity": "error",
        "retryable": False,
        "message": message,
        "hint": hint,
        "correlationId": "corr-test",
    }
    machine_result = {"ok": False, "error": envelope}
    return {"result": {
        "isError": True,
        "structuredContent": machine_result,
        "content": [{"type": "text", "text": f"{code}: {message} — {hint} (correlationId: corr-test)"}],
    }}


class ProjectMcpJourneyTests(unittest.TestCase):
    def setUp(self):
        def read_installed_contract(*parts: str) -> bytes:
            root = Path(__file__).resolve().parents[2]
            paths = {
                ("ux-result", "machine-result.schema.json"):
                    root / "core/platform/contracts/ux-result/machine-result.schema.json",
                ("error-envelope.schema.json",):
                    root / "core/platform/src/error-envelope/error-envelope.schema.json",
            }
            return paths[parts].read_bytes()

        self.installed_contract_patch = patch(
            "mcp_project_steps.read_installed_platform_resource",
            side_effect=read_installed_contract,
        )
        self.installed_contract_patch.start()

    def tearDown(self):
        self.installed_contract_patch.stop()

    # case: S-045.10
    def test_opaque_host_credential_is_refused_by_catalogue_and_deregistered(self):
        from invocations import catalogued_error_hint
        host = {"hostId": "host-fixture-1", "machineToken": "opaque-host-token"}
        profile = (200, {"tenantId": "tenant-fixture"}, {})
        register = (201, json.dumps(host).encode(), {})
        deregister = (204, b"", {})
        error = {"ok": False, "error": {
            "code": "KB_AUTH_MCP_CREDENTIAL_REQUIRED",
            "hint": catalogued_error_hint("KB_AUTH_MCP_CREDENTIAL_REQUIRED", gatewayUrl="https://gateway.test"),
            "details": {"gatewayUrl": "https://gateway.test"}, "correlationId": "corr-fixture",
        }}
        with patch("service_runner.request", side_effect=[profile, register, deregister]) as gateway_request, \
             patch("service_runner.request_mcp", return_value=(401, error, {})) as mcp_request:
            result = opaque_host_credential_mcp_rejection("prj_a", "user-access-token")

        self.assertIsNone(result)
        self.assertEqual(gateway_request.call_args_list[0].args[0], "/auth/me")
        self.assertEqual(gateway_request.call_args_list[1].args[0], "/hosts/register")
        self.assertEqual(gateway_request.call_args_list[1].kwargs["payload"]["namespaceId"], "tenant-fixture")
        self.assertEqual(gateway_request.call_args_list[2].kwargs["method"], "DELETE")
        self.assertEqual(mcp_request.call_args.kwargs["token"], "opaque-host-token")

    # case: S-141.1, S-141.2, S-141.3, S-141.4, S-141.5, S-141.6
    def test_agent_session_steps_reject_fake_failures_then_claim_full_lifecycle(self):
        journey = Journey("local", "agent-session")
        failures = iter([
            (500, {"error": "creation failed"}, {}),
            (500, {"error": "list failed"}, {}),
            (500, {"error": "detail failed"}, {}),
            (200, {"message": "session-does-not-exist"}, {}),
            (201, {"data": {"session": {"id": "bad", "agentId": "agent-does-not-exist"}}}, {}),
            (404, {"error": {"code": "KB_RUNTIME_UNEXPECTED"}}, {}),
        ])
        with patch("service_runner.request", side_effect=lambda *_args, **_kwargs: next(failures)) as request_mock:
            run_agent_session_steps(journey, "prj_a", "token")
        red = journey.result()
        self.assertEqual(red.status, "FAIL")
        self.assertEqual({claim["claimId"] for claim in red.case_run["claims"]}, {
            "S-141.1", "S-141.4", "S-141.5", "S-141.6",
        })
        self.assertEqual(
            request_mock.call_args_list[0].args[0],
            "/api/v1/projects/prj_a/rest/plugins/agents/sessions",
        )
        self.assertEqual(red.steps[1]["status"], "BLOCKED")
        self.assertEqual(red.steps[1]["details"]["requires"], ["step:case:S-141.1"])
        self.assertEqual(red.steps[2]["status"], "BLOCKED")
        self.assertEqual(red.steps[2]["details"]["requires"], ["step:case:S-141.1"])

        session = {"id": "session-1", "agentId": "orchestrator",
                   "task": "Summarize the project", "status": "pending"}
        responses = iter([
            (201, {"data": {"session": session}}, {}),
            (200, {"data": {"sessions": [session], "total": 1}}, {}),
            (200, {"data": {"session": session}}, {}),
            (200, {"data": {"turns": []}}, {}),
            (200, {"data": {"sessionId": "session-1", "plan": None}}, {}),
            (404, {"error": {
                "code": "KB_RUNTIME_RESOURCE_NOT_FOUND",
                "details": {"sessionId": "session-does-not-exist"},
            }}, {}),
            (404, {"error": {"code": "KB_AGENT_NOT_FOUND", "details": {"agentId": "agent-does-not-exist"}}}, {}),
            (404, {"error": {
                "code": "KB_RUNTIME_RESOURCE_NOT_FOUND",
                "message": "REST route GET /api/v1/plugins/agents/unknown-route was not found for plugin @kb-labs/agents.",
                "hint": "Run `kb marketplace plugins doctor --scope project` to inspect project plugin routes, then use a declared route.",
            }}, {}),
        ])
        green = Journey("local", "agent-session")
        with patch("service_runner.request", side_effect=lambda *_args, **_kwargs: next(responses)):
            run_agent_session_steps(green, "prj_a", "token")
        result = green.result()
        self.assertEqual(result.status, "PASS", result.first_failure)
        self.assertEqual({claim["claimId"] for claim in result.case_run["claims"]}, {
            "S-141.1", "S-141.2", "S-141.3", "S-141.4", "S-141.5", "S-141.6",
        })

    # case: S-199.3
    def test_project_catalog_isolation_rejects_fake_failure_then_proves_project_scoped_tool(self):
        journey = Journey("local", "project-catalog-isolation")
        with patch("service_runner.request_mcp", side_effect=[
            (500, {}, {}), (200, {"result": {"tools": [{"name": commit_tool("commit plan apply")}]}}, {}),
        ]):
            journey.step("project catalog isolation", "mcp",
                         lambda: project_plugin_catalog_isolation("prj_a", "prj_b", "token"),
                         cases=["S-199.3"])
        self.assertEqual(journey.result().case_run["claims"], [
            {"claimId": "S-199.3", "kind": "journey", "status": "FAIL"},
        ])

        journey = Journey("local", "project-catalog-isolation")
        responses = [
            (200, {"result": {"tools": [{"name": commit_tool("commit plan apply")}]}}, {}),
            (200, {"result": {"tools": [{"name": next(iter(service_tool_names(DEFAULT_ENABLED_SERVICES)))}]}}, {}),
        ]
        with patch("service_runner.request_mcp", side_effect=responses):
            journey.step("project catalog isolation", "mcp",
                         lambda: project_plugin_catalog_isolation("prj_a", "prj_b", "token"),
                         cases=["S-199.3"])
        self.assertEqual(journey.result().status, "PASS", journey.result().first_failure)

    # case: S-199.5
    def test_secured_project_catalog_claim_rejects_fake_failure_then_checks_auth_and_scope(self):
        failure = Journey("secured", "project-catalog-auth")
        with patch("service_runner.request_mcp", side_effect=[
            (500, {}, {}),
        ]):
            failure.step("secured project MCP catalog selection", "mcp",
                         lambda: secured_project_catalog_isolation("prj_a", "prj_b", "token"),
                         cases=["S-199.5"])
        self.assertEqual(failure.result().case_run["claims"], [
            {"claimId": "S-199.5", "kind": "journey", "status": "FAIL"},
        ])

        auth_error = {"ok": False, "error": {
            "code": "KB_AUTH_REQUIRED", "message": "Authentication is required.",
            "hint": catalogued_error_hint("KB_AUTH_REQUIRED", gatewayUrl="<url>"),
            "correlationId": "corr-auth",
        }}
        responses = [
            (401, auth_error, {}),
            (200, {"result": {"tools": [{"name": commit_tool("commit plan apply")}]}}, {}),
            (401, auth_error, {}),
            (200, {"result": {"tools": [{"name": "kb-labs-review__review_run"}]}}, {}),
        ]
        green = Journey("secured", "project-catalog-auth")
        with patch("service_runner.request_mcp", side_effect=responses) as request:
            green.step("secured project MCP catalog selection", "mcp",
                       lambda: secured_project_catalog_isolation("prj_a", "prj_b", "token"),
                       cases=["S-199.5"])
        self.assertEqual(green.result().status, "PASS", green.result().first_failure)
        self.assertEqual([call.kwargs.get("token", "") for call in request.call_args_list], ["", "token", "", "token"])

    # case: S-199.4
    def test_readonly_agents_tool_isolation_rejects_fake_failure_then_checks_a_and_b(self):
        failed = Journey("local", "readonly-tool-isolation")
        with patch("service_runner.request_mcp", side_effect=[(500, {}, {})]):
            failed.step("project MCP read-only tool isolation", "mcp",
                        lambda: project_readonly_tool_isolation("prj_a", "prj_b", "token"),
                        cases=["S-199.4"])
        self.assertEqual(failed.result().status, "FAIL")

        success = {"result": {"isError": False, "structuredContent": {"hasPlan": True}, "content": []}}
        unknown = tool_error("KB_RUNTIME_MCP_UNKNOWN_TOOL", "Unknown tool.", "Use tools/list.")
        green = Journey("local", "readonly-tool-isolation")
        with patch("service_runner.request_mcp", side_effect=[(200, success, {}), (200, unknown, {})]) as request:
            green.step("project MCP read-only tool isolation", "mcp",
                       lambda: project_readonly_tool_isolation("prj_a", "prj_b", "token"),
                       cases=["S-199.4"])
        self.assertEqual(green.result().status, "PASS", green.result().first_failure)
        self.assertEqual(request.call_args_list[0].kwargs["payload"]["params"]["name"], commit_tool("commit plan show"))

    def test_live_registry_ux_step_is_registered_as_s203_claim(self):
        step = "MCP UX result contract from live registry"
        local = {name: cases for name, _, _, cases, _, _ in checks("local")}
        secured = {name: cases for name, _, _, cases, _, _ in checks("secured")}
        self.assertEqual(local[step], ["S-203.2"])
        self.assertEqual(secured[step], ["S-203.2", "S-045.6", "S-140.7"])

    def test_platform_readiness_claims_both_gateway_and_project_workflow_checks(self):
        journey = Journey("local", "readiness-registered-project-state")
        graph = FlowGraph(journey, {name: spec["depends_on"] for name, spec in service_runner.SERVICE_GROUPS.items()},
                          groups=service_runner.SERVICE_GROUPS, states={
                              "host-running": {"passed": True, "evidence": "test host is running"},
                          })
        graph.probe_state("project-registered", "project", "test registration probe", lambda: None,
                          value=lambda: {"id": "prj_registered", "root": "/tmp/project"})
        service_runner.prepare_service_api_session(graph, "local")
        name, capability, check, cases, requires, runners = next(
            row for row in checks("local", graph) if row[0] == "platform readiness (gateway + project workflow)")
        self.assertEqual((name, capability, cases), (
            "platform readiness (gateway + project workflow)", "gateway", ["PC-002.3"]))
        self.assertEqual(requires, ())
        self.assertEqual(runners, ())
        with patch("service_runner.expect_json", return_value=None) as expect_json, \
                patch("service_runner.expect_project_service_health", return_value=None) as expect_health:
            self.assertIsNone(check())

        expect_json.assert_called_once_with("/ready", "gateway readiness")
        expect_health.assert_called_once_with(
            "/api/v1/projects/prj_registered/workflow/health",
            "workflow",
            token=None,
        )

    def test_secured_platform_readiness_reads_the_probed_service_api_session(self):
        calls = []

        def request(path, **kwargs):
            calls.append((path, kwargs.get("token", "")))
            if path == "/auth/login/cli":
                return 200, {"accessToken": "session-token"}, {}
            if path == "/auth/me":
                return 200, {"userId": "admin"}, {}
            return 200, {"ready": True}, {}

        journey = service_runner.Journey("secured", "readiness-service-session")
        graph = service_runner.FlowGraph(journey, {}, states={})
        graph.probe_state("project-registered", "project", "test registration probe", lambda: None,
                          value=lambda: {"id": "prj_registered", "root": "/tmp/project"})
        with patch("service_runner.ADMIN_PASSWORD", "synthetic-admin-password"), \
                patch("service_runner.ADMIN_EMAIL", "admin@example.test"), \
                patch("service_runner.project_service_path", return_value="/api/v1/projects/prj_registered/workflow/health"), \
                patch("service_runner.request", side_effect=request), \
                patch("service_runner.expect_json", return_value=None) as expect_json, \
                patch("service_runner.expect_project_service_health", return_value=None) as expect_health:
            service_runner.prepare_service_api_session(graph, "secured")
            rows = list(checks("secured", graph))
            readiness_name, _, readiness_check, _, _, _ = next(
                row for row in rows if row[0] == "platform readiness (gateway + project workflow)")
            self.assertEqual(readiness_name, "platform readiness (gateway + project workflow)")
            self.assertIsNone(readiness_check())

        self.assertEqual(calls[0][0], "/auth/login/cli")
        self.assertEqual(calls[1], ("/auth/me", "session-token"))
        self.assertEqual(expect_json.call_count, 1)
        self.assertEqual(expect_health.call_args_list[0].args,
                         ("/api/v1/projects/prj_registered/workflow/health", "workflow"))
        self.assertEqual(expect_health.call_args_list[0].kwargs["token"], "session-token")

    def test_missing_project_id_blocks_readiness_before_building_a_request(self):
        journey = Journey("local", "missing-project-id")
        graph = FlowGraph(journey, {name: spec["depends_on"] for name, spec in service_runner.SERVICE_GROUPS.items()},
                          groups=service_runner.SERVICE_GROUPS, states={
                              "host-running": {"passed": True, "evidence": "test host is running"},
                          })
        graph.probe_state("host-running", "host", "test host probe", lambda: None)
        service_runner.prepare_service_api_session(graph, "local")
        with patch("service_runner.expect_json", return_value=None), \
                patch("service_runner.expect_project_service_health") as expect_health:
            name, capability, check, cases, _requires, _runners = next(
                row for row in checks("local", graph) if row[0] == "platform readiness (gateway + project workflow)")
            graph.dispatch_step(name, "platform", capability, check, cases)

        blocked = next(step for step in journey.steps if step.status == "BLOCKED")
        self.assertIn("project-registered", blocked.message)
        prerequisite = Journey("local", "missing-project-prerequisite")
        prerequisite.step("prior", "fixture", lambda: "BLOCKED: failed prerequisite")
        blocked = prerequisite.step("dependent", "fixture", lambda: None, requires={"step:prior"})
        self.assertEqual(blocked.status, "BLOCKED")
        self.assertIn("prerequisiteFailures", blocked.details)
        self.assertNotIn("missingStateKey", blocked.details)
        expect_health.assert_not_called()

    def test_project_b_checks_are_declared_with_the_registered_fixture_state(self):
        with tempfile.TemporaryDirectory() as directory:
            project_b_root = str(Path(directory).resolve())
            journey = Journey("local", "mcp-project-b-fixture-order")
            graph = FlowGraph(journey, {name: spec["depends_on"] for name, spec in service_runner.SERVICE_GROUPS.items()},
                              groups=service_runner.SERVICE_GROUPS, states={
                                  "host-running": {"passed": True, "evidence": "host ready"},
                              })
            graph.probe_state("project-registered", "project", "project fixture",
                              lambda: None, value=lambda: {"id": "prj_a", "root": directory})
            graph.probe_state("marketplace-available", "marketplace-fixture-producer", "marketplace fixture",
                              lambda: None, value=lambda: {"available": True})
            service_runner.prepare_service_api_session(graph, "local")
            graph.probe_state("fixtures-installed", "marketplace-fixtures", "project B fixture",
                              lambda: None, value=lambda: {
                                  "projectBId": "prj_b", "projectBRoot": project_b_root,
                              })
            declarations = {name: check for name, _, check, _, _, _ in checks("local", graph)}
            check = declarations["project MCP cross-project isolation"]
            with patch("service_runner.project_isolation", return_value=None) as isolation:
                self.assertIsNone(check())
            isolation.assert_called_once_with("prj_a", "prj_b", project_b_root, None)

    def test_registered_runtime_identity_checks_canonical_registry_path(self):
        project_root = "/tmp/journey-project"
        canonical_root = str(Path(project_root).resolve())
        responses = [
            (200, {"id": "prj_a", "path": canonical_root}, {}),
            (200, {"projectRuntimes": {"runtimes": [{"projectId": "prj_a", "state": "ready"}]}}, {}),
            (200, {"status": "healthy"}, {}),
        ]
        journey = Journey("local", "runtime-identity-registered-project-state")
        graph = FlowGraph(journey, {name: spec["depends_on"] for name, spec in service_runner.SERVICE_GROUPS.items()},
                          groups=service_runner.SERVICE_GROUPS, states={
                              "host-running": {"passed": True, "evidence": "test host is running"},
                          })
        graph.probe_state("project-registered", "project", "test registration probe", lambda: None,
                          value=lambda: {"id": "prj_a", "root": project_root})
        service_runner.prepare_service_api_session(graph, "local")
        checks_by_name = {name: check for name, _, check, _, _, _ in checks("local", graph)}
        with patch("service_runner.request_ux_success", side_effect=responses) as request:
            self.assertIsNone(checks_by_name["registered project runtime identity"]())

        self.assertEqual(
            [call.args[0] for call in request.call_args_list],
            ["/api/v1/projects/prj_a", "/health", "/api/v1/projects/prj_a/rest/health"],
        )

    def test_project_health_claim_rejects_unhealthy_payload_and_accepts_service_health_status(self):
        from service_runner import expect_project_service_health

        with patch("service_runner.request_ux_success", return_value=(200, {"status": "ok"}, {})):
            self.assertIsNone(expect_project_service_health("/health", "workflow"))
        with patch("service_runner.request_ux_success", return_value=(200, {"status": "unhealthy"}, {})):
            self.assertIn("reported unhealthy", expect_project_service_health("/health", "workflow"))
        with patch("service_runner.request_ux_success", return_value=(502, {
                "code": "KB_PROJECT_RUNTIME_START_FAILED"}, {})):
            self.assertIn("HTTP 502", expect_project_service_health("/health", "workflow"))

    def test_ux_contract_claim_discovers_and_checks_every_live_registry_tool(self):
        tools = [
            {"name": "plugin__required", "inputSchema": {"type": "object", "required": ["name"]}},
            {"name": "plugin__no_inputs", "inputSchema": {"type": "object", "properties": {}}},
            {"name": "kb-labs__mcp_diagnostics", "inputSchema": {"type": "object", "properties": {}}},
        ]
        failure = tool_error("KB_RUNTIME_MCP_INVALID_ARGUMENTS", "Invalid arguments", "Pass valid arguments.")
        calls = []

        def fake_request(path, **kwargs):
            payload = kwargs.get("payload", {})
            calls.append((payload.get("method"), payload.get("params", {}).get("name"), payload.get("params", {}).get("arguments"), kwargs.get("token")))
            if payload.get("method") == "tools/list":
                return 200, {"result": {"tools": tools}}, {}
            return 200, failure, {}

        with patch("service_runner.request_mcp", side_effect=fake_request):
            self.assertIsNone(mcp_ux_result_contract("prj_a", "token"))
        self.assertEqual([call[1] for call in calls[1:]], [tool["name"] for tool in tools])
        self.assertEqual(calls[1][2], {})
        self.assertEqual(calls[2][2], {"__ux_invalid_probe__": True})
        self.assertTrue(all(call[3] == "token" for call in calls))

    def test_ux_contract_claim_checks_secured_diagnostics_and_missing_token_envelopes(self):
        tools = [{"name": "plugin__read", "inputSchema": {"type": "object", "required": ["id"]}}]
        failure = tool_error("KB_RUNTIME_MCP_INVALID_ARGUMENTS", "Invalid arguments", "Pass valid arguments.")
        unauthorized = {"ok": False, "error": {
            "code": "KB_AUTH_REQUIRED", "area": "auth", "stage": "login", "severity": "error",
            "retryable": False, "message": "Authentication is required.",
            "hint": catalogued_error_hint("KB_AUTH_REQUIRED", gatewayUrl="<url>"), "correlationId": "corr-auth",
        }}
        calls = []

        def fake_request(path, **kwargs):
            payload = kwargs.get("payload", {})
            call = (payload.get("method"), payload.get("params", {}).get("name"), kwargs.get("token"))
            calls.append(call)
            if payload.get("method") == "tools/list":
                if kwargs.get("token"):
                    return 200, {"result": {"tools": tools}}, {}
                return 401, unauthorized, {}
            if kwargs.get("token"):
                return 200, failure, {}
            return 401, unauthorized, {}

        with patch("service_runner.request_mcp", side_effect=fake_request):
            self.assertIsNone(mcp_ux_result_contract("prj_a", "token", secured=True))
        self.assertEqual(calls[2], ("tools/call", "kb-labs__mcp_diagnostics", ""))
        self.assertEqual(calls[3], ("tools/list", None, ""))

    def test_ux_contract_claim_rejects_stack_text_and_missing_correlation_id(self):
        tools = [{"name": "plugin__read", "inputSchema": {"type": "object", "required": ["id"]}}]
        failure = tool_error("KB_RUNTIME_MCP_INVALID_ARGUMENTS", "Invalid arguments", "Pass valid arguments.")
        failure["result"]["content"][0]["text"] += "\nTraceback (most recent call last):"
        with patch("service_runner.request_mcp", side_effect=[
            (200, {"result": {"tools": tools}}, {}),
            (200, failure, {}),
        ]):
            self.assertIn("stack trace", mcp_ux_result_contract("prj_a", "token"))

    def test_ux_contract_claim_rejects_error_without_correlation_id(self):
        tools = [{"name": "plugin__read", "inputSchema": {"type": "object", "required": ["id"]}}]
        failure = tool_error("KB_RUNTIME_MCP_INVALID_ARGUMENTS", "Invalid arguments", "Pass valid arguments.")
        del failure["result"]["structuredContent"]["error"]["correlationId"]
        with patch("service_runner.request_mcp", side_effect=[
            (200, {"result": {"tools": tools}}, {}),
            (200, failure, {}),
        ]):
            self.assertIn("correlationId", mcp_ux_result_contract("prj_a", "token"))

    def test_unknown_tool_requires_typed_result_and_discovery_hint(self):
        response = tool_error("KB_RUNTIME_MCP_UNKNOWN_TOOL", "Unknown MCP tool", "Call tools/list to discover tools.")
        with patch("service_runner.request_mcp", return_value=(200, response, {})):
            self.assertIsNone(unknown_tool("prj_a", "token"))

    def test_unknown_tool_rejects_plain_text_error(self):
        response = {"result": {"isError": True, "content": [{"text": "Unknown tool: absent"}]}}
        with patch("service_runner.request_mcp", return_value=(200, response, {})):
            self.assertIn("structuredContent", unknown_tool("prj_a", "token"))

    def test_invalid_arguments_sends_bad_type_and_checks_field_in_envelope(self):
        response = tool_error("KB_RUNTIME_MCP_INVALID_ARGUMENTS", "Argument force must be boolean", "Pass a boolean value.")
        with patch("service_runner.request_mcp", return_value=(200, response, {})) as request:
            self.assertIsNone(invalid_arguments("prj_a", "token"))
        self.assertEqual(request.call_args.kwargs["payload"]["params"]["arguments"], {"force": "yes"})

    def test_invalid_arguments_rejects_missing_argument_name(self):
        response = tool_error("KB_RUNTIME_MCP_INVALID_ARGUMENTS", "Argument has the wrong type", "Pass a valid value.")
        with patch("service_runner.request_mcp", return_value=(200, response, {})):
            self.assertIn("did not identify argument", invalid_arguments("prj_a", "token"))

    def test_secured_auth_claim_checks_missing_and_invalid_tokens(self):
        calls = []

        def fake_request(path, **kwargs):
            calls.append(kwargs.get("token"))
            return (401, {"ok": False, "error": {
                "code": "KB_AUTH_REQUIRED", "message": "Authentication is required.",
                "area": "auth", "stage": "login", "severity": "error", "retryable": False,
                "hint": catalogued_error_hint("KB_AUTH_REQUIRED", gatewayUrl="http://127.0.0.1:4000"),
                "correlationId": "corr-auth", "details": {"gatewayUrl": "http://127.0.0.1:4000"},
            }}, {})

        with patch("service_runner.request_mcp", side_effect=fake_request):
            self.assertIsNone(secured_auth("prj_a"))
        self.assertEqual(calls, ["", "not-a-real-token"])

    def test_secured_auth_compares_the_catalog_hint_for_the_returned_gateway(self):
        gateway_url = "http://127.0.0.1:4000"
        response = (401, {"ok": False, "error": {
            "code": "KB_AUTH_REQUIRED", "message": "Authentication is required.",
            "area": "auth", "stage": "run", "severity": "error", "retryable": False,
            "hint": catalogued_error_hint("KB_AUTH_REQUIRED", gatewayUrl=gateway_url),
            "correlationId": "corr-auth", "details": {"gatewayUrl": gateway_url},
        }}, {})
        with patch("service_runner.request_mcp", return_value=response):
            self.assertIsNone(secured_auth("prj_a"))

    def test_secured_auth_rejects_http_401_without_the_catalog_envelope(self):
        with patch("service_runner.request_mcp", return_value=(401, {"ok": False, "error": "unauthorized"}, {})):
            self.assertIn("no KB_AUTH_REQUIRED envelope", secured_auth("prj_a"))

    def test_secured_auth_fails_if_either_request_authenticates(self):
        responses = iter([
            (401, {"ok": False, "error": {
                "code": "KB_AUTH_REQUIRED", "message": "Authentication is required.",
                "area": "auth", "stage": "login", "severity": "error", "retryable": False,
                "hint": catalogued_error_hint("KB_AUTH_REQUIRED", gatewayUrl="http://127.0.0.1:4000"),
                "correlationId": "corr-auth", "details": {"gatewayUrl": "http://127.0.0.1:4000"},
            }}, {}),
            (200, {"result": {"tools": []}}, {}),
        ])
        with patch("service_runner.request_mcp", side_effect=lambda *_args, **_kwargs: next(responses)):
            self.assertIn("invalid token returned HTTP 200", secured_auth("prj_a"))

    def test_local_auth_lists_tools_without_a_token(self):
        tools = [
            {"name": name}
            for name in (
                commit_tool("commit commit"),
                *service_tool_names(DEFAULT_ENABLED_SERVICES),
                "kb-labs__mcp_diagnostics",
            )
        ]
        with patch("service_runner.request_mcp", return_value=(200, {"result": {"tools": tools}}, {})) as request:
            self.assertIsNone(local_auth("prj_a", DEFAULT_ENABLED_SERVICES))
        self.assertEqual(request.call_args.kwargs["token"], "")

    def test_local_auth_rejects_a_catalog_from_another_project(self):
        tools = [{"name": "kb-labs__mcp_diagnostics"}]
        with patch("service_runner.request_mcp", return_value=(200, {"result": {"tools": tools}}, {})):
            self.assertIn("served=", local_auth("prj_a", DEFAULT_ENABLED_SERVICES))

    def test_commit_tool_schema_checks_the_manifest_argument_type(self):
        tools = [{"name": commit_tool("commit plan apply"), "inputSchema": {
            "type": "object", "properties": {"force": {"type": "boolean"}, "json": {"type": "boolean"}},
        }}]
        with patch("service_runner.request_mcp", return_value=(200, {"result": {"tools": tools}}, {})):
            self.assertIsNone(commit_tool_schema("prj_a", "token"))

    def test_commit_tool_schema_reports_a_missing_or_wrong_schema(self):
        tools = [{"name": commit_tool("commit plan apply"), "inputSchema": {"type": "object", "properties": {}}}]
        with patch("service_runner.request_mcp", return_value=(200, {"result": {"tools": tools}}, {})):
            self.assertIn("force and json", commit_tool_schema("prj_a", "token"))

    def test_mutating_step_calls_commit_apply_without_push_and_checks_sha(self):
        response = {"result": {
            "isError": False,
            "content": [{"text": "Created commit a1b2c3d4"}],
            "structuredContent": {"ok": True, "data": "Created commit a1b2c3d4", "meta": {
                "ui": [{"kind": "message", "level": "success", "message": "Applied", "options": {
                    "sections": [{"header": "Commits", "items": ["a1b2c3d4"]}],
                }}],
            }},
        }}
        history = subprocess.CompletedProcess(args=[], returncode=0, stdout="a1b2c3d4\n", stderr="")
        with patch("service_runner.request_mcp", return_value=(200, response, {})) as request, \
             patch("mcp_project_steps.run_command", return_value=history) as git_log:
            self.assertIsNone(apply_commit_plan("prj_a", "token", "/tmp/project-a"))
        payload = request.call_args.kwargs["payload"]
        self.assertEqual(payload["params"]["name"], commit_tool("commit plan apply"))
        self.assertEqual(payload["params"]["arguments"], {})
        self.assertEqual(git_log.call_args_list[0].args[0], ["kb", "commit", "plan", "show", "--json"])
        self.assertEqual(git_log.call_args.args[0][-1], "--all")

    def test_project_isolation_checks_catalog_then_typed_unknown_call(self):
        response = tool_error("KB_RUNTIME_MCP_UNKNOWN_TOOL", "Unknown MCP tool", "Call tools/list to discover tools.")
        with tempfile.TemporaryDirectory() as directory, patch("service_runner.request_mcp", side_effect=[
            (200, {"result": {"tools": [{"name": next(iter(service_tool_names(DEFAULT_ENABLED_SERVICES)))}]}}, {}),
            (200, response, {}),
        ]) as request:
            self.assertIsNone(project_isolation("prj_a", "prj_b", str(Path(directory).resolve()), "token"))
        self.assertEqual(request.call_count, 2)

    def test_project_isolation_requires_the_registered_canonical_root(self):
        with tempfile.TemporaryDirectory() as directory:
            alias = str(Path(directory) / "missing")
            failure = project_isolation("prj_a", "prj_b", alias, "token")
        self.assertEqual(failure, "project B registry root must be an existing canonical directory")

    def test_mcp_call_preserves_parsed_error_response(self):
        from mcp_project_steps import mcp_call
        payload = tool_error("KB_RUNTIME_MCP_UNKNOWN_TOOL", "Unknown MCP tool", "Call tools/list.")
        with patch("service_runner.request_mcp", return_value=(200, payload, {})):
            status, body = mcp_call("prj_a", 4, "missing", {})
        self.assertEqual(status, 200)
        self.assertEqual(body, payload)

    def test_mcp_http_reader_replays_gateway_project_route_fixture(self):
        from service_runner import request_mcp

        fixture_path = Path(__file__).parent / "fixtures" / "project-mcp-responses.json"
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        self.assertEqual({row["step"] for row in fixture}, {
            "initialize", "tools/list", "tool call", "error",
        })
        for row in fixture:
            with self.subTest(step=row["step"]):
                headers = {name: value for name, value in row["headers"].items()}
                with patch("service_runner.open_http", return_value=(
                        row["status"], row["body"].encode("utf-8"), headers)):
                    status, outcome, actual_headers = request_mcp(
                        "/api/v1/projects/project-fixture/mcp", payload={}, step=row["step"])
                self.assertEqual(status, row["status"])
                self.assertEqual(actual_headers, headers)
                self.assertIsInstance(outcome, dict)
                self.assertEqual(outcome.get("jsonrpc"), "2.0")
                if row["step"] == "initialize":
                    self.assertEqual(outcome["result"]["protocolVersion"], "2025-03-26")
                elif row["step"] == "tools/list":
                    self.assertIsInstance(outcome["result"]["tools"], list)
                elif row["step"] == "tool call":
                    self.assertIn("result", outcome)
                else:
                    self.assertIn("error", outcome)

    def test_http_reader_enforces_call_kind_media_type_contract(self):
        from service_runner import JourneyResponseError, request, request_mcp

        responses = [
            ("mcp + html json", request_mcp, "mcp", "text/html", b'{"jsonrpc":"2.0"}'),
            ("mcp + html", request_mcp, "mcp", "text/html", b"<html>no</html>"),
            ("ux + event stream", request, "ux", "text/event-stream", b"data: {}\n\n"),
        ]
        for label, reader, kind, media_type, body in responses:
            with self.subTest(response=label):
                with patch("service_runner.open_http", return_value=(200, body, {
                        "Content-Type": media_type})):
                    with self.assertRaises(JourneyResponseError) as raised:
                        if kind == "mcp":
                            reader("/mcp", payload={}, step=label)
                        else:
                            reader("/rest", step=label)
                error = raised.exception
                self.assertEqual(error.call_kind, kind)
                self.assertEqual(error.media_type, media_type)
                self.assertEqual(error.journey_step, label)
                self.assertIn(kind, str(error))
                self.assertIn(media_type, str(error))
                self.assertIn(label, str(error))



if __name__ == "__main__":
    unittest.main()
