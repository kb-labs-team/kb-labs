import ast
import hashlib
import io
import shutil
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

from mcp_tool_names import DEFAULT_ENABLED_SERVICES, commit_tool, service_tool_names
from nightly_report import aggregate, fingerprint, load_results, render_summary, sync_issues
from entrypoint import run_runner
import runner as journey_runner
from runner import (login_and_configure_secured_admin,
                    uninstall_human_summary_has_shim_result,
                    uninstall_shim_result_matches)
from service_runner import (SERVICE_GROUPS, STATE_PRODUCERS, checks, service_selection_groups,
                            configure_installed_cli_path, declared_capabilities,
                            discover_workflow, expect_json, mcp_diagnostics, mcp_initialize,
                            expect_html, install_project_agents_plugin,
                            request as request_result,
                            project_plugin_settings_isolation, repository_git_status,
                            _prepare_mcp_projects,
                            journey_result_exit_code, main as service_main, mcp_probe,
                            prepare_service_api_session, service_api_token,
                            run_grouped_service_steps, run_service_steps)
from service_steps import FlowGraph, Journey, record_runner_exception, record_runner_failure, replay_steps
from journey_selection import JourneySelection
from invocations import catalogued_error_hint, run_pty_command, store_report_secret
from steps.auth import run_secured_auth_steps


def tearDownModule():
    journey_runner.cleanup()


class FakeGitHub:
    def __init__(self):
        self.issues = [{"number": 10, "title": "Nightly status", "state": "open", "labels": []}]
        self.created = 20


    def list_open(self):
        return self.issues

    def create(self, title, body, labels):
        issue = {"number": self.created, "title": title, "body": body, "labels": labels, "state": "open"}
        self.created += 1
        self.issues.append(issue)
        return issue

    def update(self, number, **fields):
        issue = next(item for item in self.issues if item["number"] == number)
        issue.update(fields)
        return issue


class UninstallShimResultTest(unittest.TestCase):
    def test_agent_uninstall_requires_shim_disposition_and_canonical_owner_when_left(self):
        with tempfile.TemporaryDirectory(prefix="journey-uninstall-shim-") as temp:
            root = Path(temp) / "noncanonical" / ".." / "platform"
            root.mkdir(parents=True)
            canonical = str(root.resolve())
            alias = Path(temp) / "platform-alias"
            alias.symlink_to(root, target_is_directory=True)
            self.assertTrue(uninstall_shim_result_matches({"shimAction": "removed"}, root))
            self.assertTrue(uninstall_shim_result_matches(
                {"shimAction": "left", "shimOwner": canonical}, root))
            self.assertTrue(uninstall_shim_result_matches({"shimAction": "left-foreign"}, root))
            self.assertFalse(uninstall_shim_result_matches({"operation": "uninstall"}, root))
            self.assertFalse(uninstall_shim_result_matches(
                {"shimAction": "left", "shimOwner": str(alias)}, root))

    def test_human_uninstall_requires_shim_disposition_and_canonical_owner_when_left(self):
        with tempfile.TemporaryDirectory(prefix="journey-uninstall-shim-") as temp:
            root = Path(temp) / "platform"
            root.mkdir(parents=True)
            self.assertTrue(uninstall_human_summary_has_shim_result(
                "Platform uninstalled. The kb command was removed.", root))
            self.assertTrue(uninstall_human_summary_has_shim_result(
                f"Platform uninstalled. The kb command remains with its owner at {root.resolve()}.", root))
            self.assertTrue(uninstall_human_summary_has_shim_result(
                "Platform uninstalled. The existing kb command was left untouched because its owner could not be verified.", root))
            self.assertFalse(uninstall_human_summary_has_shim_result("Platform uninstalled.", root))


class ServiceJourneyTests(unittest.TestCase):
    def test_project_mcp_tool_name_artifact_matches_producer(self):
        root = Path(__file__).parents[2]
        result = subprocess.run(
            ["node", str(root / "services/mcp/app/scripts/generate-project-mcp-journey-names.mjs"), "--check"],
            cwd=root, capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_service_catalog_expectations_follow_the_enabled_service_set(self):
        self.assertTrue(service_tool_names(DEFAULT_ENABLED_SERVICES))
        disabled = DEFAULT_ENABLED_SERVICES - {"workflow"}
        self.assertFalse(any(name.startswith("workflow__") for name in service_tool_names(disabled)))

    def test_s045_case_tool_name_matches_generated_catalog(self):
        root = Path(__file__).parents[2]
        catalog = json.loads((root / "e2e/journey/generated/project_mcp_tool_names.json").read_text())
        service_prefixes = tuple(catalog["servicePrefixes"])
        generated_names = {
            tool_name
            for commands in catalog["services"].values()
            for tool_name in commands.values()
        }
        case = root / "docs/qa/scenarios/S-045-project-mcp-tools.md"
        row = next(line for line in case.read_text().splitlines() if line.startswith("| S-045.2 |"))
        case_names = [
            token
            for token in row.split("|")[3].split("`")
            if token.startswith(service_prefixes)
        ]
        self.assertTrue(case_names)
        self.assertTrue(all(name in generated_names for name in case_names))

    def test_required_probe_refreshes_mutated_state_outside_claim_selection(self):
        selection = JourneySelection(
            requested=("S-001.1",), claims=frozenset({"S-001.1"}), owning_steps={},
            prerequisite_steps=frozenset(), prerequisite_flows=frozenset(), capabilities=frozenset(),
            runner_selector="service-local:explore", requested_runners="service-local:explore",
        )
        journey = Journey("secured", "required-state-refresh", selection=selection)
        graph = FlowGraph(journey, {"host": ()}, states={
            "host-running": {"passed": False, "evidence": "update invalidated the previous host probe",
                             "group": "update", "step": "platform update"},
        })

        result = graph.probe_state("host-running", "host", "post-update health", lambda: None, required=True)

        self.assertEqual(result.status, "PASS")
        self.assertTrue(graph.states["host-running"]["passed"])
        self.assertEqual(graph.states["host-running"]["step"], "flow:state probe: host-running")

    def test_invalidated_state_is_reestablished_by_its_declared_probe(self):
        journey = Journey("secured", "mutated-shared-state-restored")
        graph = FlowGraph(
            journey,
            {"host": ("host-running",), "auth": ("host-running",)},
            states={"host-running": {"passed": True, "evidence": "host ready"}},
            state_producers={"host-running": "host"},
            groups={"host": {"produces": ("host-running",)}, "auth": {}},
        )
        graph.invalidate_state(
            "host-running", group="auth", step="recovery", evidence="recovery restarted the shared host",
        )

        restored = graph.probe_state(
            "host-running", "host", "health probe after recovery", lambda: None,
        )
        consumer = graph.flow("auth consumer", "auth", "auth", lambda: None)

        self.assertEqual(restored.status, "PASS")
        self.assertEqual(consumer, "PASS")
        self.assertEqual([step.status for step in journey.steps], ["PASS", "PASS"])

    def test_flow_schedules_declared_state_producer_before_gate(self):
        journey = Journey("secured", "producer-before-consumer")
        graph = FlowGraph(
            journey,
            {"consumer": ("project-registered",), "project": ()},
            state_producers={"project-registered": "project"},
            groups={"consumer": {"depends_on": ("project-registered",)},
                    "project": {"produces": ("project-registered",)}},
        )
        events = []
        graph.register_state_producer(
            "project-registered",
            lambda: graph.probe_state(
                "project-registered", "project", "verify project registration",
                lambda: events.append("producer probe") and None,
                value=lambda: {"id": "project-1"},
            ),
        )
        result = graph.flow(
            "consumer prerequisite gate", "consumer", "journey.consumer",
            lambda: events.append("consumer gate") and None,
            record_empty_success=False,
        )

        self.assertEqual(result, "PASS")
        self.assertEqual(events, ["producer probe", "consumer gate"])
        self.assertTrue(graph.states["project-registered"]["passed"])

    def test_failed_scheduled_state_producer_blocks_gate_with_evidence(self):
        journey = Journey("secured", "failed-producer-before-consumer")
        graph = FlowGraph(
            journey,
            {"consumer": ("project-registered",), "project": ()},
            state_producers={"project-registered": "project"},
            groups={"consumer": {"depends_on": ("project-registered",)},
                    "project": {"produces": ("project-registered",)}},
        )
        consumer_calls = []
        graph.register_state_producer(
            "project-registered",
            lambda: graph.probe_state(
                "project-registered", "project", "verify project registration",
                lambda: "kb project show exited 7: secondary shim missing",
            ),
        )
        result = graph.flow(
            "consumer prerequisite gate", "consumer", "journey.consumer",
            lambda: consumer_calls.append("ran"),
            record_empty_success=False,
        )

        self.assertEqual(result, "BLOCKED")
        self.assertEqual(consumer_calls, [])
        blocked = next(step for step in journey.steps if step.name == "consumer prerequisite gate")
        self.assertIn("state project-registered", blocked.message)
        self.assertIn("secondary shim missing", blocked.message)
        self.assertEqual(blocked.details["requires"], ["state:project-registered"])

    def test_mutated_state_blocks_consumers_until_its_producer_reestablishes_it(self):
        journey = Journey("secured", "declared-state-mutation")
        graph = FlowGraph(journey, {"project": (), "projects": ("project-registered",)}, states={
            "project-registered": {"passed": True, "evidence": "project is registered",
                                   "value": {"id": "project-1", "root": "/work/project"}},
        })

        graph.invalidate_state("project-registered", group="auth",
                               step="bootstrap administrator recovery",
                               evidence="recovery removed the shared project registration")
        blocked = graph.dispatch_step("project API", "projects", "projects", lambda: None,
                                      cases=["PC-002.3"])
        self.assertEqual(blocked.status, "BLOCKED")
        self.assertIn("state project-registered", blocked.message)
        self.assertIn("recovery removed the shared project registration", blocked.message)
        self.assertEqual(blocked.details["requires"], ["state:project-registered"])

        graph.probe_state("project-registered", "project", "project registration restored",
                          lambda: None,
                          value=lambda: {"id": "project-1", "root": "/work/project"})
        passed = graph.dispatch_step("project API after restore", "projects", "projects", lambda: None,
                                     cases=["PC-002.3"])
        self.assertEqual(passed.status, "PASS")

        failed_journey = Journey("secured", "declared-state-mutation-recovery-failed")
        failed_graph = FlowGraph(failed_journey, {"project": (), "projects": ("project-registered",)},
                                 states={"project-registered": {
                                     "passed": True, "evidence": "project is registered",
                                     "value": {"id": "project-1", "root": "/work/project"},
                                 }})
        failed_graph.invalidate_state("project-registered", group="auth",
                                      step="bootstrap administrator recovery",
                                      evidence="recovery removed the shared journey project")
        failed_graph.probe_state("project-registered", "project", "project registration restored",
                                 lambda: "fresh session was revoked before project re-registration")
        blocked_recovery = failed_graph.dispatch_step("project API after failed restore", "projects", "projects",
                                                      lambda: None, cases=["PC-002.3"])
        self.assertEqual(blocked_recovery.status, "BLOCKED")
        self.assertIn("fresh session was revoked before project re-registration", blocked_recovery.message)

    def _selected_service_checks(self, mode, responses, *, login_fails=False):
        selected = "PC-002.3,PC-002.8"
        requests = []

        def fake_request(path, *, token="", **_kwargs):
            requests.append((path, token))
            if path == "/auth/login/cli":
                if login_fails:
                    return 401, {"message": "credentials rejected"}, {}
                return 200, {"accessToken": "synthetic-service-token"}, {}
            if path == "/auth/me":
                return 200, {}, {}
            return responses(path, token)

        with patch.dict(os.environ, {"KB_JOURNEY_SELECTED_STEPS": selected,
                                     "KB_JOURNEY_CASES": selected,
                                     "KB_JOURNEY_SELECTED_CAPABILITIES": "gateway,projects",
                                     "KB_JOURNEY_ADMIN_PASSWORD": "synthetic-password"}), \
                patch("service_runner.ADMIN_PASSWORD", "synthetic-password"), \
                patch("service_runner.project_service_path",
                      side_effect=lambda project_id, service, *parts:
                      f"/api/v1/projects/{project_id}/{service}/{'/'.join(parts)}"), \
                patch("service_runner.request", side_effect=fake_request):
            journey = Journey(mode, "service-api-session-selection")
            graph = FlowGraph(
                journey,
                {name: spec["depends_on"] for name, spec in SERVICE_GROUPS.items()},
                states={
                    "host-running": {"passed": True, "evidence": "host ready"},
                    "project-registered": {"passed": True, "evidence": "project registered",
                                           "value": {"id": "project-123", "root": "/work/project"}},
                },
                groups=SERVICE_GROUPS,
            )
            prepare_service_api_session(graph, mode)
            run_service_steps(journey, checks(mode, graph), mode, graph=graph)
        return journey, graph, requests

    # Regression for PC-002.3 and PC-002.8: the selected checks must acquire runner-owned API state.
    def test_selected_secured_checks_run_after_service_api_session_and_send_token(self):
        def responses(path, _token):
            if path == "/ready":
                return 200, {"status": "ready"}, {}
            if path.endswith("/workflow/health"):
                return 200, {"status": "healthy"}, {}
            if path == "/api/v1/projects/project-123":
                return 200, {"path": "/work/project"}, {}
            if path == "/health":
                return 200, {"projectRuntimes": {"runtimes": [{"projectId": "project-123", "state": "ready"}]}}, {}
            if path.endswith("/rest/health"):
                return 200, {"status": "healthy"}, {}
            self.fail(f"unexpected request {path}")

        journey, graph, requests = self._selected_service_checks("secured", responses)
        selected = [step for step in journey.steps if step.cases and set(step.cases) & {"PC-002.3", "PC-002.8"}]
        self.assertEqual([step.status for step in selected], ["PASS", "PASS"])
        self.assertTrue(graph.states["service-api-session"]["passed"])
        self.assertIn(("/auth/login/cli", ""), requests)
        self.assertIn(("/auth/me", "synthetic-service-token"), requests)
        self.assertTrue(any(token == "synthetic-service-token" for path, token in requests
                            if path != "/auth/me"))

    def test_selected_secured_checks_block_when_service_api_session_fails(self):
        journey, _graph, requests = self._selected_service_checks(
            "secured", lambda path, _token: self.fail(f"check sent unexpected request {path}"),
            login_fails=True,
        )
        selected = [step for step in journey.steps if step.cases and set(step.cases) & {"PC-002.3", "PC-002.8"}]
        self.assertEqual([step.status for step in selected], ["BLOCKED", "BLOCKED"])
        self.assertTrue(all("service-api-session" in step.message and "HTTP 401" in step.message
                            for step in selected))
        self.assertEqual([path for path, _token in requests], ["/auth/login/cli"])
        self.assertEqual(journey.result().status, "FAIL")

    def test_selected_local_checks_need_no_service_api_login(self):
        def responses(path, token):
            if path == "/ready":
                return 200, {"status": "ready"}, {}
            if path.endswith("/workflow/health"):
                return 200, {"status": "healthy"}, {}
            if path == "/api/v1/projects/project-123":
                return 200, {"path": "/work/project"}, {}
            if path == "/health":
                return 200, {"projectRuntimes": {"runtimes": [{"projectId": "project-123", "state": "ready"}]}}, {}
            if path.endswith("/rest/health"):
                return 200, {"status": "healthy"}, {}
            self.fail(f"unexpected request {path}")

        journey, graph, requests = self._selected_service_checks("local", responses)
        self.assertTrue(graph.states["service-api-session"]["passed"])
        self.assertFalse(any(path == "/auth/login/cli" for path, _token in requests))
        self.assertTrue(any(path.endswith("/workflow/health") and not token for path, token in requests))
        selected = [step for step in journey.steps if step.cases and set(step.cases) & {"PC-002.3", "PC-002.8"}]
        self.assertEqual([step.status for step in selected], ["PASS", "PASS"])

    def test_service_api_token_accessor_fails_before_unauthenticated_request_if_group_gate_is_removed(self):
        journey = Journey("secured", "service-api-session-missing-dependency")
        graph = FlowGraph(journey, {"projects": ()}, states={
            "service-api-session": {"passed": True, "evidence": "session established"},
        })
        selected = "PC-002.8"
        with patch.dict(os.environ, {"KB_JOURNEY_SELECTED_STEPS": selected,
                                    "KB_JOURNEY_CASES": selected}, clear=True):
            step = graph.dispatch_step("project registry check", "projects", "projects",
                              lambda: service_api_token(graph), cases=["PC-002.8"])
        self.assertEqual(step.status, "BLOCKED")
        self.assertIn("service-api-session", step.message)

        flow_journey = Journey("secured", "service-api-flow-missing-dependency")
        flow_graph = FlowGraph(flow_journey, {"analytics": ()}, states={
            "service-api-session": {"passed": True, "evidence": "session established"},
        })
        with patch.dict(os.environ, {"KB_JOURNEY_SELECTED_STEPS": selected,
                                    "KB_JOURNEY_CASES": selected}, clear=True):
            outcome = flow_graph.flow("analytics API flow", "analytics", "analytics",
                                      lambda: service_api_token(flow_graph), cases=["PC-002.8"])
        self.assertEqual(outcome, "BLOCKED")
        self.assertIn("service-api-session", flow_journey.steps[-1].message)

    def test_ordinary_unclaimed_credential_step_is_skipped_and_selected_check_blocks(self):
        selected = "PC-002.3,PC-002.8"
        with patch.dict(os.environ, {"KB_JOURNEY_SELECTED_STEPS": selected,
                                     "KB_JOURNEY_CASES": selected}, clear=True):
            journey = Journey("secured", "ordinary-unclaimed-session-mutation")
            graph = FlowGraph(journey, {"projects": ("service-api-session",)}, states={})
            ordinary = journey.step("service API login", "auth.secured", lambda: None)
            consumer = graph.dispatch_step("project registry check", "projects", "projects",
                                  lambda: service_api_token(graph), cases=["PC-002.8"])
        self.assertEqual(ordinary.status, "SKIPPED")
        self.assertEqual(consumer.status, "BLOCKED")
        self.assertIn("service-api-session", consumer.message)

    def test_service_check_order_changes_only_for_api_credential_lifecycle_row(self):
        names = [step[0] for step in checks("secured")]
        self.assertNotIn("secured admin CLI login", names)
        self.assertEqual(names[0], "platform readiness (gateway + project workflow)")
        self.assertNotIn("service-api-session", STATE_PRODUCERS)

    def test_selected_smoke_runs_only_selected_checks_and_required_states_in_both_modes(self):
        for mode in ("local", "secured"):
            with self.subTest(mode=mode):
                token = "synthetic-service-token" if mode == "secured" else ""
                seen = []

                def fake_open_http(_opener, request, **_kwargs):
                    seen.append(dict(request.header_items()))
                    return 200, b'{"ok":true,"data":{"ready":true}}', {"content-type": "application/json"}

                selected = "PC-002.3,PC-002.8"
                with patch.dict(os.environ, {
                    "KB_JOURNEY_SELECTED_STEPS": selected,
                    "KB_JOURNEY_CASES": selected,
                    "KB_JOURNEY_SELECTED_CAPABILITIES": "gateway,projects",
                }, clear=True), patch("service_runner.open_http", side_effect=fake_open_http):
                    journey = Journey(mode, f"selected-smoke-{mode}")
                    groups = SERVICE_GROUPS
                    graph = FlowGraph(
                        journey,
                        {name: spec["depends_on"] for name, spec in groups.items()},
                        states={
                            "host-running": {"passed": True, "evidence": "host ready"},
                            "project-registered": {"passed": True, "evidence": "project registered",
                                                   "value": {"id": "project-123", "root": "/work/project"}},
                            "service-api-session": {"passed": True, "evidence": "service API session ready",
                                                     "value": token or None},
                        },
                        state_producers=STATE_PRODUCERS,
                        groups=groups,
                    )
                    graph.probe_state("service-api-session", "auth", "service API login", lambda: None,
                                      value=lambda: token or None)
                    setup_calls = []
                    graph.flow("produce Commit project fixture", "marketplace-fixture-producer",
                               "marketplace-fixtures", lambda: setup_calls.append("Commit"),
                               record_empty_success=False)
                    graph.probe_state("marketplace-available", "marketplace-fixture-producer",
                                      "Commit project fixture", lambda: None)
                    graph.flow("prepare MCP project fixtures", "marketplace-fixtures", "mcp",
                               lambda: setup_calls.append("MCP"), record_empty_success=False)
                    graph.probe_state("fixtures-installed", "marketplace-fixtures",
                                      "project fixture handoff", lambda: None)
                    graph.flow("marketplace lifecycle assertions", "marketplace-lifecycle", "marketplace",
                               lambda: setup_calls.append("marketplace"), record_empty_success=False)
                    graph.flow("adapter defaults flow", "adapters", "adapter",
                               lambda: setup_calls.append("adapters"), cases=["S-054.1"],
                               record_empty_success=False)
                    adapter_probe = graph.probe_state(
                        "adapter-defaults", "adapters", "restore adapter fixture",
                        lambda: "cleanup should not run", after_flow="adapter defaults flow")
                    for name, claim in (("selected readiness", "PC-002.3"),
                                        ("selected project runtime", "PC-002.8")):
                        graph.dispatch_step(name, "projects", "projects",
                                   lambda: (None if request_result("/ready", token=service_api_token(graph))[0] == 200
                                            else "selected request failed"), cases=[claim])

                self.assertEqual(setup_calls, [])
                self.assertEqual(adapter_probe.status, "SKIPPED")
                self.assertNotIn("BLOCKED", [step.status for step in journey.steps])
                self.assertEqual(journey.result().status, "PASS")
                selected_steps = [step for step in journey.steps if step.cases and step.status == "PASS"]
                self.assertEqual({step.name for step in selected_steps},
                                 {"selected readiness", "selected project runtime"})
                self.assertEqual(len(seen), 2)
                self.assertTrue(all(headers.get("Authorization") == f"Bearer {token}" if token
                                    else "Authorization" not in headers for headers in seen))

    def test_marketplace_claim_selects_its_flow_and_state_producer(self):
        calls = []
        selected = "S-010.1"
        with patch.dict(os.environ, {
            "KB_JOURNEY_SELECTED_STEPS": selected,
            "KB_JOURNEY_CASES": selected,
            "KB_JOURNEY_SELECTED_CAPABILITIES": "marketplace",
        }, clear=True):
            journey = Journey("local", "selected-marketplace-flow")
            groups = service_selection_groups()
            graph = FlowGraph(
                journey,
                {name: spec["depends_on"] for name, spec in groups.items()},
                states={
                    "host-running": {"passed": True, "evidence": "host ready"},
                    "project-registered": {"passed": True, "evidence": "project registered"},
                    "service-api-session": {"passed": True, "evidence": "API session ready"},
                },
                state_producers=STATE_PRODUCERS,
                groups=groups,
            )
            producer = graph.flow("produce Commit project fixture", "marketplace-fixture-producer",
                                  "marketplace-fixtures", lambda: calls.append("producer"),
                                  record_empty_success=False)
            probe = graph.probe_state("marketplace-available", "marketplace-fixture-producer",
                                      "Commit project fixture", lambda: None)
            lifecycle = graph.flow(
                "marketplace lifecycle assertions", "marketplace-lifecycle", "marketplace",
                lambda: journey.step("install exact marketplace plugin", "marketplace", lambda: None,
                                     cases=["S-010.1"]),
                cases=["S-010.1"],
                record_empty_success=False,
            )

        self.assertEqual(producer, "PASS")
        self.assertEqual(probe.status, "PASS")
        self.assertEqual(lifecycle, "PASS")
        self.assertEqual(calls, ["producer"])
        self.assertEqual(journey.result().case_run["claims"], [
            {"claimId": "S-010.1", "kind": "journey", "status": "PASS"},
        ])

    def test_flow_exception_and_blocked_only_run_have_named_first_failure(self):
        selected = "S-010.1"
        with patch.dict(os.environ, {
            "KB_JOURNEY_SELECTED_STEPS": selected,
            "KB_JOURNEY_CASES": selected,
        }, clear=True):
            journey = Journey("local", "named-flow-error")
            graph = FlowGraph(journey, {"marketplace-lifecycle": ()}, groups={
                "marketplace-lifecycle": {"cases": ("S-010.1",)},
            })
            graph.flow("marketplace lifecycle assertions", "marketplace-lifecycle", "marketplace",
                       lambda: (_ for _ in ()).throw(RuntimeError("fixture setup failed")), cases=("S-010.1",))
        result = journey.result()
        self.assertEqual(result.first_failure["name"], "marketplace lifecycle assertions")
        self.assertEqual(result.first_failure["message"], "fixture setup failed")

        blocked = Journey("local", "named-blocked-only")
        blocked.blocked("required project state", "projects", "project registration was not verified",
                        cases=["PC-002.8"])
        blocked_result = blocked.result()
        self.assertEqual(blocked_result.status, "BLOCKED")
        self.assertIsNone(blocked_result.first_failure)

    def test_project_b_claims_stay_registered_when_fixture_state_is_missing(self):
        selected = "S-199.3,S-199.4,S-199.5"
        groups = service_selection_groups()
        with patch.dict(os.environ, {
            "KB_JOURNEY_SELECTED_STEPS": selected,
            "KB_JOURNEY_CASES": selected,
            "KB_JOURNEY_SELECTED_CAPABILITIES": "mcp",
            "KB_JOURNEY_SELECTED_OWNING_STEPS": "{}",
        }, clear=True):
            journey = Journey("secured", "missing-project-b-claims")
            graph = FlowGraph(
                journey,
                {name: spec["depends_on"] for name, spec in groups.items()},
                states={
                    "project-registered": {"passed": True, "evidence": "project registered",
                                           "value": {"id": "prj_a", "root": "/tmp/project-a"}},
                    "service-api-session": {"passed": True, "evidence": "service API session ready",
                                            "value": "token"},
                },
                state_producers=STATE_PRODUCERS,
                groups=groups,
            )
            declarations = checks("secured", graph)
        by_claim = {claim: name for name, _capability, _check, cases, _requires, _runners in declarations
                    for claim in cases}
        self.assertEqual(by_claim["S-199.3"], "project plugin catalog isolation")
        self.assertEqual(by_claim["S-199.4"], "project MCP read-only tool isolation")
        self.assertEqual(by_claim["S-199.5"], "secured project MCP catalog selection")

    def test_auth_group_failure_does_not_invalidate_service_api_session(self):
        selected = "PC-002.8"
        sent_headers = []

        def fake_open_http(_opener, request, **_kwargs):
            sent_headers.append(dict(request.header_items()))
            return 200, b'{"ok":true,"data":{"projects":[]}}', {"content-type": "application/json"}

        journey = Journey("secured", "auth-failure-preserves-service-api-session")
        graph = FlowGraph(
            journey,
            {"auth": ("host-running",), "projects": ("host-running", "service-api-session")},
            states={
                "host-running": {"passed": True, "evidence": "host ready"},
            },
            state_producers=STATE_PRODUCERS,
        )
        with patch.dict(os.environ, {"KB_JOURNEY_SELECTED_STEPS": selected,
                                     "KB_JOURNEY_CASES": selected}), \
                patch("service_runner.open_http", side_effect=fake_open_http):
            graph.probe_state("service-api-session", "auth", "service API login", lambda: None,
                              value=lambda: "synthetic-service-token")
            outcome = graph.flow("auth group flow", "auth", "auth.secured",
                                 lambda: "unrelated auth assertion failed")
            check = graph.dispatch_step(
                "project registry check", "projects", "projects",
                lambda: (None if request_result("/api/v1/projects", token=service_api_token(graph))[0] == 200
                         else "project registry request failed"),
                cases=["PC-002.8"],
            )

        self.assertEqual(outcome, "FAIL")
        self.assertTrue(graph.states["service-api-session"]["passed"])
        self.assertEqual(check.status, "PASS")
        self.assertEqual(sent_headers[0].get("Authorization"), "Bearer synthetic-service-token")

    # case: S-204.1, S-204.2
    def test_repository_status_detects_files_created_by_settings_commands(self):
        with tempfile.TemporaryDirectory(prefix="journey-project-settings-tree-") as temp:
            project = Path(temp) / "project"
            project.mkdir()
            initialized = subprocess.run(["git", "init", "--quiet", str(project)], capture_output=True, text=True)
            self.assertEqual(initialized.returncode, 0, initialized.stderr)
            baseline = repository_git_status(project)
            self.assertEqual(baseline, "")
            (project / ".kb").mkdir()
            (project / ".kb" / "config.json").write_text("{}\n", encoding="utf-8")
            current = repository_git_status(project)
            self.assertIsNotNone(current)
            self.assertNotEqual(current, baseline)

    # case: S-204.1, S-204.2, S-204.8, S-204.9, S-204.10, S-204.11
    def test_project_settings_step_reports_repository_write_and_continues(self):
        with tempfile.TemporaryDirectory(prefix="journey-project-settings-cli-") as temp:
            root = Path(temp)
            cli = root / "kb-fixture"
            cli.write_text("""#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

args = sys.argv[1:]
state_path = Path(os.environ["KB_JOURNEY_FIXTURE_STATE"])
state = json.loads(state_path.read_text()) if state_path.exists() else {}
cwd = Path.cwd()
def succeed(data):
    print(json.dumps({"ok": True, "data": data}))
    raise SystemExit(0)
if args[:2] == ["project", "add"]:
    succeed({"project": {"id": cwd.name}})
if args[:2] == ["project", "remove"]:
    succeed({})
if args[:2] == ["marketplace", "install"]:
    succeed({"package": "@kb-labs/commit", "scope": "project"})
if args[:2] == ["config", "set"]:
    if ".kb" not in state:
        (cwd / ".kb").mkdir()
        state[".kb"] = True
    scope = "platform" if "--scope" in args else cwd.name
    key = args[args.index("--scope") + 2] if "--scope" in args else args[2]
    value_index = args.index(key) + 1
    state[f"{scope}:{key}"] = json.loads(args[value_index]) if key.endswith("scopes") else int(args[value_index])
    state_path.write_text(json.dumps(state))
    succeed({})
if args[:2] == ["config", "get"]:
    key = args[2]
    if key.endswith("maxTokens"):
        if cwd.name == "project-a" and f"project-a:{key}" in state:
            value, layer = state[f"project-a:{key}"], "project"
        elif f"platform:{key}" in state:
            value, layer = state[f"platform:{key}"], "platform"
        else:
            value, layer = 2000, "manifest"
    else:
        if cwd.name == "project-a" and f"project-a:{key}" in state:
            value, layer = state[f"project-a:{key}"], "project"
        else:
            value, layer = state.get(f"platform:{key}", []), "platform"
    succeed({"value": value, "layer": layer})
print(json.dumps({"ok": False, "error": {"code": "KB_PROJECT_UNKNOWN", "message": "unknown project", "hint": "run kb project add"}}))
raise SystemExit(1)
""", encoding="utf-8")
            cli.chmod(0o755)
            state = root / "fixture-state.json"
            journey = Journey("local", "project-settings-tree-regression")
            settings_cases = ["S-204.1", "S-204.2", "S-204.8", "S-204.9", "S-204.10", "S-204.11"]

            with patch.dict(os.environ, {"KB_JOURNEY_CLI_PATH": str(cli),
                                         "KB_JOURNEY_FIXTURE_STATE": str(state)}):
                settings = journey.step(
                    "project plugin settings isolation and clean repositories", "projects",
                    lambda: project_plugin_settings_isolation("synthetic-service-token"), cases=settings_cases,
                )
                following = journey.step("workflow discovery", "workflow", lambda: None)
                self.assertEqual(settings.status, "FAIL")
                self.assertEqual(settings.cases, settings_cases)
                self.assertEqual(settings.message, "project settings commands changed project-a's repository tree")
                self.assertTrue(state.is_file(), "the CLI fixture must have run the settings commands")
                self.assertEqual(following.status, "PASS")
                self.assertEqual(following.name, "workflow discovery")

    def test_runner_exception_keeps_completed_steps_and_adds_crash_row_to_report(self):
        with tempfile.TemporaryDirectory(prefix="journey-runner-crash-") as temp:
            root = Path(temp)
            journey = Journey("local", "runner-crash")
            for number in range(3):
                journey.step(f"completed step {number + 1}", "journey.test", lambda: None,
                             cases=[f"S-900.{number + 1}"])
            try:
                raise RuntimeError("runner body failed after recorded steps")
            except RuntimeError as error:
                record_runner_exception(journey, error, root / "journey-diagnostics.log")
            report = root / "journey.json"
            result = journey.write_json(report)
            saved = json.loads(report.read_text())
            diagnostic = (root / "journey-diagnostics.log").read_text()

        self.assertEqual(len(saved["steps"]), 4)
        self.assertEqual([step["status"] for step in saved["steps"]], ["PASS", "PASS", "PASS", "FAIL"])
        self.assertEqual(saved["steps"][-1]["name"], "outer journey orchestration")
        self.assertEqual(len(saved["case_run"]["claims"]), 3)
        self.assertIn("Traceback", diagnostic)
        self.assertEqual(result.status, "FAIL")

    def test_fixture_journey_rows_are_replayed_into_the_reporting_journey(self):
        fixture = Journey("local", "fixture-rows")
        fixture.step("fixture passes", "journey.test", lambda: None, cases=["S-900.1"])
        fixture.step("fixture fails", "journey.test", lambda: "fixture left a host running", cases=["S-900.2"])
        report = Journey("local", "reporting")
        report.step("earlier row", "journey.test", lambda: None, cases=["S-900.3"])

        replay_steps(fixture, report)

        self.assertEqual([(step.name, step.status, step.cases) for step in report.steps],
                         [("earlier row", "PASS", ["S-900.3"]),
                          ("fixture passes", "PASS", ["S-900.1"]),
                          ("fixture fails", "FAIL", ["S-900.2"])])
        self.assertEqual(report.steps[-1].message, "fixture left a host running")

    def test_journey_registry_is_shared_with_npm_resolution(self):
        compose = (Path(__file__).parent / "docker-compose.yml").read_text()
        registry = re.search(r"^\s+KB_JOURNEY_REGISTRY:\s*(.+)$", compose, re.MULTILINE)
        npm_registry = re.search(r"^\s+NPM_CONFIG_REGISTRY:\s*(.+)$", compose, re.MULTILINE)

        self.assertIsNotNone(registry)
        self.assertIsNotNone(npm_registry)
        anchor = re.fullmatch(r"&(?P<name>[A-Za-z0-9_-]+)\s+(?P<value>\S+)", registry.group(1))
        alias = re.fullmatch(r"\*(?P<name>[A-Za-z0-9_-]+)", npm_registry.group(1))
        self.assertIsNotNone(anchor)
        self.assertIsNotNone(alias)
        self.assertEqual(alias.group("name"), anchor.group("name"))

    def test_failed_setup_producer_reports_typed_reason_and_blocks_dependents(self):
        journey = Journey("secured", "setup-producer-failure")
        calls = []
        graph = FlowGraph(
            journey,
            {"install": (), "project": ("project-registered",), "adapter": ("project-registered",)},
            state_producers={"project-registered": "install"},
        )

        def failed_setup():
            raise RuntimeError("`kb project add /work/app` exited 1: KB_PROJECT_UNKNOWN; project root is missing; hint: create the project directory")

        graph.flow("journey.setup project registration", "install", "platform.install", failed_setup)
        graph.flow("project commands", "project", "projects", lambda: calls.append("project"))
        graph.flow("adapter commands", "adapter", "adapter", lambda: calls.append("adapter"))

        self.assertEqual(calls, [])
        self.assertEqual([step.status for step in journey.steps], ["FAIL", "BLOCKED", "BLOCKED"])
        self.assertIn("KB_PROJECT_UNKNOWN", journey.steps[0].message)
        self.assertIn("hint: create the project directory", journey.steps[0].message)
        self.assertIn("KB_PROJECT_UNKNOWN", journey.steps[1].message)
        self.assertEqual(graph.states["project-registered"]["step"], journey.steps[0].step_id)

    def test_service_runner_main_consumes_full_list_and_selection_closure(self):
        declared = [
            ("selected analytics check", "analytics", lambda: None, ["S-201.3"]),
            ("unselected mcp check", "mcp", lambda: None, ["S-140.1"]),
        ]
        for mode in ("local", "secured"):
            for selected in (False, True):
                with self.subTest(mode=mode, selected=selected), tempfile.TemporaryDirectory() as directory:
                    output = Path(directory) / f"service-{mode}.json"
                    inherited = json.dumps({
                        "host-running": {"passed": True, "evidence": "stubbed"},
                        "project-registered": {"passed": True, "evidence": "stubbed",
                                               "value": {"id": "prj_fixture", "root": str(Path(directory))}},
                    })
                    env = {
                        "HOME": directory,
                        "PATH": os.environ.get("PATH", ""),
                        "KB_JOURNEY_PLATFORM_ROOT": str(Path(directory) / "platform"),
                        "KB_JOURNEY_STATES": inherited,
                    }
                    if selected:
                        env.update({"KB_JOURNEY_CASES": "S-201.3",
                                    "KB_JOURNEY_SELECTED_STEPS": "S-201.3",
                                    "KB_JOURNEY_SELECTED_CAPABILITIES": "analytics"})
                    executed: list[str] = []
                    fixture_project_ids: list[str] = []
                    fixture_state_at_check_declaration: list[bool] = []
                    workspace_commands: list[list[str]] = []

                    def declare_checks(step_mode, graph):
                        fixture_state_at_check_declaration.append(
                            graph.states.get("fixtures-installed", {}).get("passed") is True
                        )
                        return iter(declared)

                    def execute_declared_steps(journey, steps, step_mode, *, graph):
                        for state, producer in STATE_PRODUCERS.items():
                            if state not in graph.states:
                                graph.probe_state(state, producer, f"producer {state}", lambda: None)
                        for name, capability, check, cases in steps:
                            group = next(group for group, spec in SERVICE_GROUPS.items()
                                         if capability in spec["capabilities"])
                            result = graph.dispatch_step(name, group, capability, check, cases=cases)
                            if result.status == "PASS":
                                executed.append(name)

                    def prepare_project_fixtures(_project_id, _project_root, _registry, child_env, *_args):
                        fixture_project_ids.append(_project_id)
                        fixture_file = Path(directory) / "fixtures.json"
                        fixture_file.write_text(json.dumps({
                            "projectAId": "prj_fixture", "projectARoot": str(Path(directory)),
                            "projectBId": "prj_fixture_b", "projectBRoot": str(Path(directory) / "project-b"),
                        }))
                        child_env["KB_JOURNEY_PROJECT_FIXTURES_FILE"] = str(fixture_file)

                    def produce_commit_fixture(_journey, project_root, _registry, _env):
                        lock_path = Path(project_root) / ".kb" / "marketplace.lock"
                        lock_path.parent.mkdir(parents=True, exist_ok=True)
                        lock_path.write_text(json.dumps({"plugins": {"@kb-labs/commit": {
                            "package": "@kb-labs/commit", "version": "2.120.1",
                        }}}))
                        return {"name": "@kb-labs/commit", "package": "@kb-labs/commit",
                                "version": "2.120.1"}

                    def capture_workspace_command(argv, **_kwargs):
                        workspace_commands.append(argv)
                        return subprocess.CompletedProcess(argv, 0, "", "")

                    # One ExitStack: a single with-statement over this many patches exceeds Python's static block nesting limit.
                    with ExitStack() as stack:
                        workspace_cli_steps = stack.enter_context(patch("service_runner.run_workspace_cli_steps"))
                        for manager in (
                            patch("service_runner.checks", side_effect=declare_checks),
                            patch("service_runner.run_service_steps", side_effect=execute_declared_steps),
                            patch("service_runner.prepare_service_api_session",
                                  side_effect=lambda graph, _mode: graph.probe_state(
                                      "service-api-session", "auth", "service API login", lambda: None,
                                      value=lambda: None)),
                            patch("service_runner.prepare_commit_project_fixture",
                                  side_effect=produce_commit_fixture),
                            patch("service_runner._prepare_mcp_projects",
                                  side_effect=prepare_project_fixtures),
                            patch("service_runner.run_marketplace_steps"),
                            patch("service_runner.install_project_agents_plugin"),
                            patch("service_runner.configure_installed_cli_path"),
                            patch("service_runner.restore_secured_cli_login", return_value=None),
                            patch("service_runner.run_analytics_steps"),
                            patch("service_runner.run_gateway_steps"),
                            patch("service_runner.run_project_identity_steps"),
                            patch("workspace_steps.run_command", side_effect=capture_workspace_command),
                            patch("service_runner.archive_service_logs"),
                            patch.dict(os.environ, env, clear=True),
                            patch("sys.argv", ["service_runner.py", "--mode", mode, "--output", str(output)]),
                            redirect_stdout(io.StringIO()),
                        ):
                            stack.enter_context(manager)
                        service_main()
                        if selected:
                            workspace_cli_steps.assert_not_called()
                        else:
                            workspace_cli_steps.assert_called_once()

                    result = json.loads(output.read_text())
                    expected = (
                        {"selected analytics check"} if selected else
                        {"selected analytics check", "unselected mcp check"}
                    )
                    self.assertEqual(set(executed), expected)
                    self.assertEqual(len(executed), len(expected))
                    self.assertEqual(fixture_project_ids, ["prj_fixture"])
                    self.assertEqual(fixture_state_at_check_declaration, [True])
                    self.assertEqual(workspace_cli_steps.call_count, int(not selected))
                    self.assertFalse(any(argv[-3:] == ["release", "plan", "--json"]
                                         for argv in workspace_commands), workspace_commands)
                    status_by_name = {step["name"]: (step["status"], step["message"]) for step in result["steps"]}
                    if selected:
                        self.assertEqual(status_by_name["unselected mcp check"][0], "SKIPPED")
                        self.assertEqual(status_by_name["selected analytics check"][0], "PASS")
                        self.assertEqual(status_by_name["state probe: fixtures-installed"][0], "PASS")
                        self.assertEqual(status_by_name["state probe: marketplace-available"][0], "PASS")
                        allowed_passes = {
                            "selected analytics check",
                            "state probe: fixtures-installed",
                            "state probe: marketplace-available",
                            "state probe: service-api-session",
                            "archive runtime service logs",
                        }
                        self.assertTrue(all(
                            status[0] == ("PASS" if name in allowed_passes else "SKIPPED")
                            for name, status in status_by_name.items()
                        ), status_by_name)

    def test_project_fixture_flows_do_not_depend_on_claim_selection_for_registration(self):
        source = Path(__file__).with_name("service_runner.py").read_text(encoding="utf-8")
        self.assertNotIn("if project_b_root or graph.selection_active", source)
        self.assertNotIn("if project_root or journey.selected_claims", source)
        self.assertNotIn("if project_id or journey.selected_claims", source)

    def test_checks_returns_a_reusable_list_for_both_modes(self):
        for mode in ("local", "secured"):
            with self.subTest(mode=mode):
                declared = checks(mode)
                self.assertIsInstance(declared, list)
                first_pass = list(declared)
                second_pass = list(declared)
                self.assertEqual([step[0] for step in first_pass], [step[0] for step in second_pass])

    def test_agents_project_fixture_installs_through_marketplace(self):
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "project"
            project.mkdir()
            calls = []

            def fake_run(command, **kwargs):
                calls.append((command, kwargs))
                return subprocess.CompletedProcess(command, 0, '{"ok":true,"data":{}}', "")

            with patch("service_runner._registry_version", return_value="2.120.1"), \
                    patch("service_runner.run_with_runner", side_effect=lambda runner, command, **kwargs: fake_run(command, **kwargs)):
                install_project_agents_plugin(str(project), "http://registry.test", {"HOME": temp})

            self.assertEqual(calls[0][0], [
                "kb", "marketplace", "install", "@kb-labs/agents@2.120.1", "--json",
            ])
            self.assertEqual(calls[0][1]["cwd"], str(project.resolve()))

    def test_studio_shell_is_html_while_studio_api_uses_json_envelope(self):
        with patch("service_runner.request_raw", return_value=(200, b"<!doctype html><html></html>",
                                                               {"content-type": "text/html; charset=utf-8"})):
            self.assertIsNone(expect_html("/", "Studio shell"))
        with patch("service_runner.request_raw", return_value=(200, b"{\"ok\":true}",
                                                               {"content-type": "application/json"})):
            self.assertIn("HTML", expect_html("/", "Studio shell"))

    def test_studio_project_api_requires_the_shared_json_envelope(self):
        from service_runner import JourneyResponseError

        headers = {"content-type": "application/json"}
        with patch("service_runner.open_http", return_value=(200, b'{"ok":true,"data":{"projects":[]}}', headers)):
            status, body, _ = request_result("/api/v1/projects")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"projects": []})

        with patch("service_runner.open_http", return_value=(200, b'{"projects":[]}', headers)):
            with self.assertRaisesRegex(JourneyResponseError, "UX JSON envelope"):
                request_result("/api/v1/projects")

    def test_first_failure_and_json_result(self):
        journey = Journey("local", "fixture")
        journey.step("health", "gateway", lambda: None)
        journey.step("workflow", "workflow", lambda: "workflow route returned 404")
        result = journey.result()
        self.assertEqual(result.status, "FAIL")
        self.assertEqual(result.first_failure["name"], "workflow")
        self.assertEqual(len(result.steps), 2)
        self.assertEqual(result.steps[0]["cases"], [])
        self.assertEqual(result.case_run["claims"], [])
        with tempfile.TemporaryDirectory() as directory:
            saved = journey.write_json(Path(directory) / "journey.json")
            self.assertEqual(saved.schema, "kb.service-journey/v1")

    def test_selected_step_runs_declared_prerequisite_chain_and_labels_it(self):
        def selection_environment(*, cases):
            return {
                "KB_JOURNEY_SELECTED_STEPS": cases[0],
                "KB_JOURNEY_PREREQUISITE_STEPS": '["candidate provenance", "launcher version", "start host"]',
            }

        env = selection_environment(cases=["S-023.9"])
        with patch.dict(os.environ, env, clear=False):
            journey = Journey("local", "selected-update-chain")
            journey.step("candidate provenance", "journey.orchestration", lambda: None)
            journey.step("launcher version", "platform.install", lambda: None, cases=["PC-001.1"])
            journey.step("start host", "platform.host", lambda: None, cases=["PC-002.1"])
            journey.step("update stopped host", "platform.update", lambda: None,
                         cases=["S-023.9"], requires=("step:candidate provenance", "step:launcher version",
                                                       "step:start host"))

        self.assertEqual([step.status for step in journey.steps], ["PASS"] * 4)
        self.assertEqual(journey.steps[0].details["selectionRole"], "prerequisite")
        self.assertEqual(journey.steps[1].details["selectionRole"], "prerequisite")
        self.assertEqual(journey.steps[2].details["selectionRole"], "prerequisite")
        self.assertEqual(journey.result().case_run["claims"][-1]["claimId"], journey.steps[-1].cases[0])

    def test_journey_result_does_not_fail_for_unexecuted_selected_claim(self):
        def selection_environment(*, cases):
            return {"KB_JOURNEY_SELECTED_STEPS": cases[0]}

        with patch.dict(os.environ, selection_environment(cases=["S-042.1"]), clear=False):
            journey = Journey("local", "missing-selected-claim")
            journey.step("unrelated check", "auth", lambda: None, cases=["S-042.2"])

        result = journey.result()
        self.assertEqual(result.status, "PASS")
        self.assertIsNone(result.first_failure)

    def test_selection_is_not_a_journey_local_failure_during_split_run(self):
        with patch.dict(os.environ, {"KB_JOURNEY_SELECTED_STEPS": "PC-001.2,PC-002.3"}, clear=False):
            installer_journey = Journey("local", "installer-local-service-explore")
            installer_journey.step("candidate provenance", "journey.setup", lambda: None, role="lifecycle")
            intermediate = installer_journey.result()
            installer_journey.step("install", "platform.install", lambda: None, cases=["PC-001.2"])

            service_journey = Journey("local", "service-local")
            service_journey.step("readiness", "gateway", lambda: None, cases=["PC-002.3"])
            final = service_journey.result()

        self.assertEqual(intermediate.status, "PASS")
        self.assertEqual(intermediate.case_run["claims"], [])
        self.assertEqual(installer_journey.result().case_run["claims"], [
            {"claimId": "PC-001.2", "kind": "journey", "status": "PASS"},
        ])
        self.assertEqual(final.status, "PASS")
        self.assertEqual(final.case_run["claims"], [
            {"claimId": "PC-002.3", "kind": "journey", "status": "PASS"},
        ])

    def test_lifecycle_step_runs_outside_the_selected_claim_set(self):
        with patch.dict(os.environ, {"KB_JOURNEY_SELECTED_STEPS": "S-042.1"}, clear=False):
            journey = Journey("local", "lifecycle-step")
            result = journey.step("state probe: host", "journey.state", lambda: None, role="lifecycle")
        self.assertEqual(result.status, "PASS")
        self.assertEqual(result.details["selectionRole"], "lifecycle")

    def test_selected_closure_state_consumer_without_edge_fails_and_exits_nonzero(self):
        shared_state = {}

        def produce_state():
            shared_state["project"] = "registered"

        def consume_state():
            return shared_state["project"]

        with patch.dict(os.environ, {
            "KB_JOURNEY_SELECTED_STEPS": "S-042.1",
            "KB_JOURNEY_PREREQUISITE_STEPS": "[]",
        }, clear=False):
            journey = Journey("local", "selected-closure-state-missing-edge")
            producer = journey.step("closure state producer", "test", produce_state)
            consumer = journey.step("closure state consumer", "test", consume_state,
                                    cases=("S-042.1",))
            result = journey.result()

        self.assertEqual(producer.status, "SKIPPED")
        self.assertEqual(consumer.status, "FAIL")
        self.assertEqual(result.status, "FAIL")
        self.assertEqual(result.case_run["claims"], [
            {"claimId": "S-042.1", "kind": "journey", "status": "FAIL"},
        ])
        self.assertEqual(journey_result_exit_code(result), 1)

    def test_failed_prerequisite_blocks_the_selected_step_with_reason(self):
        def selection_environment(*, cases):
            return {
                "KB_JOURNEY_SELECTED_STEPS": cases[0],
                "KB_JOURNEY_PREREQUISITE_STEPS": '["project registration"]',
            }

        with patch.dict(os.environ, selection_environment(cases=["S-042.1"]), clear=False):
            journey = Journey("local", "failed-selected-prerequisite")
            journey.step("project registration", "platform.project", lambda: "registration failed")
            target = journey.step("update", "platform.update", lambda: None, cases=["S-042.1"],
                                  requires=("step:project registration",))

        self.assertEqual(target.status, "BLOCKED")
        self.assertIn("project registration ended FAIL", target.message)
        self.assertEqual(target.details["prerequisiteFailures"],
                         ["step:project registration ended FAIL: registration failed"])
        self.assertEqual(target.details["requires"], ["step:flow:project registration"])
        serialized = journey.result().steps
        self.assertEqual(serialized[0]["stepId"], "flow:project registration")
        self.assertEqual(serialized[1]["stepId"], "case:S-042.1")
        self.assertEqual(journey.result().case_run["claims"], [])
        self.assertEqual(journey.result().status, "FAIL")

    def test_unknown_required_producer_fails_selected_step_with_journey_status_fail(self):
        def selection_environment(*, cases):
            return {
                "KB_JOURNEY_SELECTED_STEPS": cases[0],
            }

        with patch.dict(os.environ, selection_environment(cases=["S-042.1"]), clear=False):
            journey = Journey("local", "missing-selected-prerequisite")
            target = journey.step("update", "platform.update", lambda: None, cases=["S-042.1"],
                                  requires=("step:unrun-prerequisite",))

        self.assertEqual(target.status, "FAIL")
        self.assertIn("harness defect: unknown journey prerequisite 'unrun-prerequisite'", target.message)
        self.assertEqual(target.details["requires"], ["step:unresolved:unrun-prerequisite"])
        self.assertEqual(journey.result().case_run["claims"], [
            {"claimId": "S-042.1", "kind": "journey", "status": "FAIL"},
        ])
        self.assertEqual(journey.result().status, "FAIL")

    def test_reflected_recorder_unknown_producer_fails_selected_step(self):
        with patch.dict(os.environ, {"KB_JOURNEY_SELECTED_STEPS": "S-042.1"}, clear=False):
            journey = Journey("local", "reflected-recorder-prerequisite")
            recorder = getattr(journey, "step")
            target = recorder("update", "platform.update", lambda: None,
                              cases=["S-042.1"], requires=("step:unrun-prerequisite",))

        self.assertEqual(target.status, "FAIL")
        self.assertIn("harness defect: unknown journey prerequisite 'unrun-prerequisite'", target.message)
        self.assertEqual(journey.result().case_run["claims"], [
            {"claimId": "S-042.1", "kind": "journey", "status": "FAIL"},
        ])
        self.assertEqual(journey.result().status, "FAIL")

    def test_failed_host_start_blocks_nested_update_in_full_run(self):
        with patch.dict(os.environ, {
            "KB_JOURNEY_SELECTED_STEPS": "",
            "KB_JOURNEY_PREREQUISITE_STEPS": "[]",
            "KB_JOURNEY_PREREQUISITE_FLOWS": "[]",
        }, clear=False):
            parent = Journey("local", "full-update-parent")
            graph = FlowGraph(parent, {})
            self.assertEqual(graph.flow(
                "start platform host", "host", "platform.host",
                lambda: parent.step("start host", "platform.host", lambda: "host did not start"),
            ), "FAIL")
            child = Journey("local", "nested-update", parent=parent)
            blocked = child.step(
                "update platform", "platform.update", lambda: None,
                requires=("flow:start platform host", "step:start host"),
            )

        self.assertEqual(blocked.status, "BLOCKED")
        self.assertIn("flow:start platform host ended FAIL", blocked.message)
        self.assertIn("step:start host ended FAIL", blocked.message)

    def test_nested_journey_resolves_parent_step_and_flow_outcomes_live(self):
        parent = Journey("local", "nested-parent")
        graph = FlowGraph(parent, {})
        graph.flow("project registration", "project", "projects",
                   lambda: parent.step("project registered", "projects", lambda: None))
        child = Journey("local", "nested-child", parent=parent)
        result = child.step("dependent", "project", lambda: None,
                            requires=("flow:project registration", "step:project registered"))
        self.assertEqual(result.status, "PASS")

    # case: S-262.7
    def test_journey_result_case_run_loads_through_qa_cases_coverage_consumer(self):
        root = Path(__file__).resolve().parents[2]
        node = shutil.which("node")
        self.assertIsNotNone(node)
        for package in ("cli/bin", "plugins/qa"):
            package_root = root / package
            build = subprocess.run(
                [str(root / "node_modules/.bin/tsup"), "--config", "tsup.config.ts"],
                cwd=package_root, text=True, capture_output=True, check=False, timeout=900,
            )
            self.assertEqual(build.returncode, 0, f"case coverage CLI build failed: {build.stderr or build.stdout}")
        shutil.copy2(root / "core/plugin-runtime/dist/sandbox/bootstrap.js", root / "cli/bin/dist/bootstrap.js")
        cli_bin = root / "cli/bin/dist/bin.js"
        self.assertTrue(cli_bin.is_file(), f"CLI binary not found at {cli_bin}")

        with tempfile.TemporaryDirectory(prefix="qa-coverage-consumer-test-") as directory:
            run_file = Path(directory) / "test-run.json"
            journey = Journey("local", "coverage-consumer-test-run")
            # Step with PASS claim: PC-001.1 is claimed by e2e/journey/runner.py
            journey.step("provenance check", "platform.install", lambda: None, cases=["PC-001.1"])
            # Step that FAILS: PC-001.2 is claimed by e2e/journey/runner.py
            journey.step("install check", "platform.install", lambda: "installation failed", cases=["PC-001.2"])
            # Step that is BLOCKED: PC-001.3 is claimed by e2e/journey/runner.py, requiring PC-001.2
            journey.step("dependent check", "platform.install", lambda: None, cases=["PC-001.3"],
                         requires=("step:install check",))

            journey_result = journey.result()
            self.assertEqual(journey_result.status, "FAIL")
            self.assertEqual(journey_result.case_run["schema"], "kb.qa-case-run/v2")
            steps_by_name = {step.name: step for step in journey.steps}
            self.assertEqual(steps_by_name["provenance check"].status, "PASS")
            self.assertEqual(steps_by_name["install check"].status, "FAIL")
            self.assertEqual(steps_by_name["dependent check"].status, "BLOCKED")

            # Crucial producer invariant: claims array contains ONLY PASS and FAIL, NO BLOCKED
            claims_map = {claim["claimId"]: claim["status"] for claim in journey_result.case_run["claims"]}
            self.assertEqual(claims_map, {"PC-001.1": "PASS", "PC-001.2": "FAIL"})
            self.assertNotIn("PC-001.3", claims_map)

            # Write out result
            journey.write_json(run_file)

            # Load through the real consumer CLI
            command = [node, str(cli_bin), "qa", "coverage", "show", "--mode", "local",
                       "--run", str(run_file), "--json"]
            env = dict(os.environ)
            env["HOME"] = directory
            env.pop("KB_PLATFORM_ROOT", None)
            env.pop("KB_HOME", None)
            env.pop("KB_NET_OFFSET", None)
            from hermetic_cli import run_hermetic_cli
            proc = run_hermetic_cli(command, cwd=root, env=env, timeout=120,
                                    workspace_root=root)
            self.assertEqual(proc.returncode, 0, f"qa coverage show failed: {proc.stderr or proc.stdout}")
            payload = json.loads(proc.stdout)
            self.assertTrue(payload.get("ok"), payload)
            coverage_data = payload.get("data", {})
            self.assertEqual(coverage_data.get("schema"), "kb.qa-case-coverage/v1")
            pc001 = next((c for c in coverage_data.get("cases", []) if c.get("id") == "PC-001"), None)
            self.assertIsNotNone(pc001)
            steps_cov = {s.get("stepId"): s for s in pc001.get("steps", [])}
            self.assertEqual(steps_cov["PC-001.1"].get("status"), "PASS")
            self.assertEqual(steps_cov["PC-001.2"].get("status"), "FAIL")
            self.assertEqual(steps_cov["PC-001.3"].get("status"), "NOT RUN")
            self.assertIn("Journey/e2e claim exists but has no passing run result", steps_cov["PC-001.3"].get("reason", ""))

            # Also verify consumer strictly rejects if a run file contains status: BLOCKED in claims
            corrupted_run_file = Path(directory) / "corrupted-run.json"
            corrupted_data = json.loads(run_file.read_text())
            corrupted_data["case_run"]["claims"].append({"claimId": "PC-001.3", "kind": "journey", "status": "BLOCKED"})
            corrupted_run_file.write_text(json.dumps(corrupted_data))

            corrupted_proc = run_hermetic_cli([node, str(cli_bin), "qa", "coverage", "show", "--mode", "local",
                                              "--run", str(corrupted_run_file), "--json"], cwd=root, env=env, timeout=120,
                                              workspace_root=root)
            self.assertIn("claims[2].status must be PASS or FAIL", corrupted_proc.stdout + corrupted_proc.stderr)

    def test_service_step_exception_is_saved_and_later_steps_continue(self):
        journey = Journey("local", "raised-step")

        def broken_check():
            raise RuntimeError("marketplace CLI is unavailable")

        run_service_steps(journey, [
            ("marketplace registry", "marketplace", broken_check, [], (), ()),
            ("gateway readiness", "gateway", lambda: None, [], (), ()),
        ], states={
            "host-running": {"passed": True, "evidence": "healthy", "group": "install", "step": "start", "claim": "PC-002.1"},
            "project-registered": {"passed": True, "evidence": "registered", "group": "project", "step": "add", "claim": "no case claim"},
            "service-api-session": {"passed": True, "evidence": "session ready", "group": "auth", "step": "login", "claim": "no case claim"},
        })
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "service-local.json"
            result = journey.write_json(path)
            saved = json.loads(path.read_text())

        self.assertEqual(result.status, "FAIL")
        self.assertEqual(saved["steps"][0]["status"], "FAIL")
        self.assertEqual(saved["steps"][0]["message"], "marketplace CLI is unavailable")
        self.assertEqual(saved["steps"][1]["status"], "PASS")

    def test_service_step_preserves_blocked_result_without_case_claim(self):
        journey = Journey("local", "blocked-step")
        run_service_steps(journey, [
            ("gateway readiness", "gateway", lambda: "BLOCKED: gateway fixture is missing", [], (), ()),
        ])
        self.assertEqual(journey.steps[0].status, "BLOCKED")
        self.assertEqual(journey.result().case_run["claims"], [])

    def test_failed_registered_setup_blocks_selected_service_claim(self):
        with patch.dict(os.environ, {
                "KB_JOURNEY_SELECTED_STEPS": "PC-002.3",
                "KB_JOURNEY_PREREQUISITE_STEPS": '["registered project setup"]',
        }, clear=False):
            journey = Journey("local", "service-setup-prerequisite")
            journey.step("registered project setup", "journey.setup",
                         lambda: "project registration handoff is missing", role="lifecycle")
            run_service_steps(journey, [
                ("platform readiness", "gateway", lambda: self.fail("claim must be blocked"),
                 ["PC-002.3"], ("step:registered project setup",), ()),
            ])

        self.assertEqual([step.status for step in journey.steps], ["FAIL", "BLOCKED"])
        self.assertEqual(journey.steps[0].details["selectionRole"], "prerequisite")
        self.assertIn("project registration handoff is missing", journey.steps[1].message)

    def test_product_failure_with_healthy_state_probes_does_not_block_later_groups(self):
        journey = Journey("local", "product-failure-healthy-state")
        calls = []
        graph = FlowGraph(journey, {"update": (), "auth": ("host-running", "platform-version-known")},
                          states={
                              "host-running": {"passed": True, "evidence": "healthy",
                                               "group": "update", "step": "rollback", "claim": "S-024.1"},
                              "platform-version-known": {"passed": True, "evidence": "version N restored",
                                                          "group": "update", "step": "rollback", "claim": "S-024.1"},
                          })
        graph.flow("update product assertion", "update", "platform.update",
                   lambda: journey.step("saved session assertion", "platform.update",
                                         lambda: "saved session was rejected", cases=["S-023.5"]),
                   cases=["S-023.5"])
        graph.flow("auth-dependent group", "auth", "auth", lambda: calls.append("auth"),
                   cases=["S-041.1"])

        self.assertEqual(calls, ["auth"])
        self.assertEqual([step.status for step in journey.steps], ["FAIL", "PASS"])
        self.assertEqual(journey.steps[0].cases, ["S-023.5"])

    def test_failed_host_probe_blocks_dependents_with_probe_evidence_and_claim(self):
        journey = Journey("local", "host-state-block")
        calls = []
        graph = FlowGraph(
            journey, {"update": ("host-running",), "auth": ("host-running",)},
            states={"host-running": {"passed": True, "evidence": "healthy before update",
                                     "group": "install", "step": "start/status", "claim": "PC-002.2"}},
        )
        graph.flow("update journey", "update", "platform.update",
                   lambda: journey.step("update product assertion", "platform.update",
                                        lambda: "saved session rejected", cases=["S-023.5"]),
                   cases=["S-023.5"])
        graph.probe_state("host-running", "update", "rollback/status",
                          lambda: "kb-create status reports running=False; gateway /ready returned HTTP 503")
        graph.flow("auth group", "auth", "auth", lambda: calls.append("auth"), cases=["S-041.1"])

        self.assertEqual(calls, [])
        self.assertEqual([step.status for step in journey.steps], ["FAIL", "FAIL", "BLOCKED"])
        self.assertIn("blocked by state host-running:", journey.steps[2].message)
        self.assertIn("running=False", journey.steps[2].message)
        self.assertIn("update/rollback/status (no case claim)", journey.steps[2].message)

    def test_saved_session_assertion_does_not_block_after_fresh_login_probe(self):
        journey = Journey("secured", "saved-session-failure-fresh-login")
        calls = []
        graph = FlowGraph(journey, {"auth": (), "plugin-author": ("session",)})
        graph.flow("saved session product assertion", "auth", "auth",
                   lambda: journey.step("saved session rejected", "auth", lambda: "saved token rejected",
                                        cases=["S-023.5"]), cases=["S-023.5"])
        graph.probe_state("session", "auth", "fresh admin login", lambda: None)
        graph.flow("plugin author group", "plugin-author", "plugin-author",
                   lambda: calls.append("plugin-author"), cases=["S-014.1"])

        self.assertEqual(calls, ["plugin-author"])
        self.assertEqual([step.status for step in journey.steps], ["FAIL", "PASS", "PASS"])

    def test_platform_prerequisite_failure_blocks_each_dependent_group_with_claim(self):
        journey = Journey("local", "platform-stop")
        calls = []
        groups = {
            "platform": {"capabilities": {"gateway"}, "depends_on": ()},
            "auth": {"capabilities": {"auth.local"}, "depends_on": ("host-running",)},
            "projects": {"capabilities": {"projects"}, "depends_on": ("host-running",)},
        }
        graph = FlowGraph(journey, {name: spec["depends_on"] for name, spec in groups.items()})
        graph.probe_state("host-running", "install", "gateway readiness", lambda: "host is down")
        run_grouped_service_steps(journey, [
            ("local identity", "auth.local", lambda: calls.append("auth"), [], (), ()),
            ("project registration", "projects", lambda: calls.append("projects"), [], (), ()),
        ], groups=groups, graph=graph)

        self.assertEqual(calls, [])
        self.assertEqual([step.status for step in journey.steps], ["FAIL", "BLOCKED", "BLOCKED"])
        self.assertIn("blocked by state host-running", journey.steps[1].message)
        self.assertIn("no case claim", journey.steps[1].message)
        self.assertIn("gateway readiness", journey.steps[2].message)

    def test_selected_group_step_runs_declared_setup_and_blocks_owner_on_setup_failure(self):
        from journey_selection import JourneySelection
        selection = JourneySelection(
            requested=("S-100.1",),
            claims=frozenset({"S-100.1"}),
            owning_steps={"selected update owner": ("S-100.1",)},
            prerequisite_steps=frozenset({"prepare update fixture"}),
            prerequisite_flows=frozenset(),
            capabilities=frozenset({"platform.update"}),
            runner_selector="service-secured:explore",
            requested_runners="",
        )
        journey = Journey("secured", "selection-owned-update", selection=selection)
        calls = []
        groups = {
            "update": {
                "capabilities": {"platform.update"},
                "cases": {"S-100.1"},
                "steps": {"prepare update fixture", "selected update owner"},
                "depends_on": (),
            },
        }
        graph = FlowGraph(journey, {"update": ()}, groups=groups)
        run_grouped_service_steps(journey, [
            ("prepare update fixture", "platform.update",
             lambda: calls.append("setup") or "fixture setup failed", [], (), ()),
            ("selected update owner", "platform.update",
             lambda: calls.append("owner"), ["S-100.1"],
             ("step:prepare update fixture",), ()),
            ("unselected update claim", "platform.update",
             lambda: calls.append("unselected"), ["S-023.2"], (), ()),
        ], groups=groups, graph=graph)

        self.assertEqual(calls, ["setup"])
        self.assertEqual([step.status for step in journey.steps], ["FAIL", "BLOCKED", "SKIPPED"])
        self.assertIn("step:prepare update fixture ended FAIL", journey.steps[1].message)

    def test_unselected_step_with_invalid_prerequisite_does_not_fail_selected_run(self):
        from journey_selection import JourneySelection

        selection = JourneySelection(
            requested=("S-100.1",), claims=frozenset({"S-100.1"}),
            owning_steps={"selected owner": ("S-100.1",)}, capabilities=frozenset(),
            prerequisite_steps=frozenset(), prerequisite_flows=frozenset(),
            runner_selector="service-secured:explore", requested_runners="",
        )
        journey = Journey("secured", "unselected-invalid-dependency", selection=selection)
        result = journey.step("unselected", "fixture", lambda: self.fail("unselected check ran"),
                              cases=["S-050.5"], requires=("step:missing",))
        self.assertEqual(result.status, "SKIPPED")
        self.assertEqual(result.message, "not selected")

    def test_fixture_probe_blocks_only_groups_that_need_the_fixture(self):
        journey = Journey("local", "fixture-state")
        calls = []
        graph = FlowGraph(journey, {"workflow": (), "mcp": ("fixtures-installed",), "studio": ()})
        graph.flow("marketplace install assertion", "marketplace", "marketplace",
                   lambda: journey.step("marketplace product assertion", "marketplace",
                                        lambda: "route returned 500", cases=["S-010.1"]), cases=["S-010.1"])
        graph.probe_state("fixtures-installed", "marketplace-fixtures", "fixture handoff",
                          lambda: "project B fixture ID is missing")
        graph.flow("workflow health", "workflow", "workflow", lambda: calls.append("workflow"))
        graph.flow("project-scoped MCP initialize", "mcp", "mcp", lambda: calls.append("mcp"),
                   cases=["S-140.2"])
        graph.flow("Studio shell", "studio", "studio", lambda: calls.append("studio"))

        self.assertEqual(calls, ["workflow", "studio"])
        self.assertEqual([step.status for step in journey.steps], ["FAIL", "FAIL", "PASS", "BLOCKED", "PASS"])
        self.assertIn("blocked by state fixtures-installed:", journey.steps[3].message)

    def test_flow_graph_isolates_failures_blocks_dependents_and_always_runs_cleanup(self):
        journey = Journey("local", "outer-flow-graph")
        calls = []
        with tempfile.TemporaryDirectory() as directory:
            graph = FlowGraph(
                journey,
                {"install": (), "host": ("platform-installed",), "adapter": (),
                 "analytics": ("host-running",), "adapter-dependent": ("adapter-defaults",),
                 "uninstall": ("install",)},
                states={"platform-installed": {"passed": True, "evidence": "receipt present", "group": "install", "step": "apply", "claim": "PC-001.1"},
                        "host-running": {"passed": True, "evidence": "healthy", "group": "install", "step": "start", "claim": "PC-002.1"}},
                diagnostics_path=Path(directory) / "journey-diagnostics.log",
            )

            graph.flow("install platform", "install", "platform.install",
                       lambda: calls.append("install"), cases=["PC-001.1"])
            graph.flow("adapter defaults", "adapter", "adapter",
                       lambda: (_ for _ in ()).throw(RuntimeError("adapter fixture broke")),
                       cases=["S-054.1"])
            graph.probe_state("adapter-defaults", "adapter", "adapter default verification",
                              lambda: "configured adapter default is unavailable")
            graph.flow("analytics extras", "analytics", "analytics",
                       lambda: calls.append("analytics"), cases=["S-191.1"])
            graph.flow("workflow depending on adapter", "adapter-dependent", "workflow",
                       lambda: calls.append("dependent"), cases=["S-054.3"])
            graph.flow("uninstall platform", "uninstall", "platform.uninstall",
                       lambda: calls.append("uninstall"), cases=["S-050.6"], role="lifecycle")

            diagnostic = (Path(directory) / "journey-diagnostics.log").read_text()

        self.assertEqual(calls, ["install", "analytics", "uninstall"])
        self.assertEqual([step.status for step in journey.steps], ["PASS", "FAIL", "FAIL", "PASS", "BLOCKED", "PASS"])
        self.assertIn("RuntimeError: adapter fixture broke", diagnostic)
        self.assertIn("blocked by state adapter-defaults:", journey.steps[4].message)
        self.assertIn("adapter/adapter default verification (no case claim)", journey.steps[4].message)

    def test_flow_exception_is_orchestration_evidence_without_case_claims(self):
        journey = Journey("local", "flow-exception-no-claim")
        graph = FlowGraph(journey, {"project": ()})

        graph.flow("project orchestration", "project", "projects",
                   lambda: (_ for _ in ()).throw(RuntimeError("project setup failed")),
                   cases=["PC-002.8"])

        self.assertEqual(journey.steps[0].status, "FAIL")
        self.assertEqual(journey.steps[0].cases, [])
        self.assertEqual(journey.result().case_run["claims"], [])

    def test_state_probe_rejects_case_claims(self):
        graph = FlowGraph(Journey("local", "probe-no-claim"), {})

        with self.assertRaises(TypeError):
            graph.probe_state("project-registered", "project", "project add", lambda: None,
                              cases=["PC-002.8"])

    def test_installed_cli_bin_is_added_to_service_path(self):
        with tempfile.TemporaryDirectory() as directory, patch("pathlib.Path.home", return_value=Path(directory)), \
                patch.dict("os.environ", {"PATH": "/usr/bin"}):
            configure_installed_cli_path()
            self.assertEqual(os.environ["PATH"].split(os.pathsep)[0], str(Path(directory) / ".local" / "bin"))

    def test_runner_writes_result_json_when_orchestration_raises(self):
        for mode in ("local", "secured"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / f"service-{mode}.json"
                diagnostics = output.with_name("journey-diagnostics.log")
                stdout = io.StringIO()
                with patch("service_runner.archive_service_logs") as archive, \
                        patch("service_runner.checks", side_effect=RuntimeError("simulated orchestration error")), \
                        patch.dict(os.environ, {"KB_JOURNEY_PLATFORM_ROOT": str(Path(directory) / "platform")}), \
                        patch("sys.argv", ["service_runner.py", "--mode", mode, "--output", str(output)]), \
                        redirect_stdout(stdout):
                    status = service_main()
                result = json.loads(output.read_text())

                self.assertEqual(status, 1)
                self.assertIn("states", result)
                runner_step = next(step for step in result["steps"] if step["name"] == "service runner")
                self.assertEqual(runner_step["status"], "FAIL")
                self.assertEqual(runner_step["message"], "simulated orchestration error")
                self.assertIn("RuntimeError: simulated orchestration error", diagnostics.read_text())
                self.assertEqual(result["steps"][-1]["name"], "archive runtime service logs")
                self.assertEqual(result["steps"][-1]["status"], "PASS")
                archive.assert_called_once()
                self.assertEqual(archive.call_args.kwargs["mode"], mode)
                self.assertEqual(archive.call_args.kwargs["platform_root"], str(Path(directory) / "platform"))
                self.assertNotIn("Traceback", stdout.getvalue())

    def test_pty_timeout_redacts_secret_from_invocation_step_report_and_stdout(self):
        with tempfile.TemporaryDirectory(prefix="journey-redaction-") as directory:
            root = Path(directory)
            output = root / "service-local.json"
            env = {
                "HOME": str(root / "home"),
                "KB_HOME": str(root / "home" / ".kb"),
                "KB_JOURNEY_PLATFORM_ROOT": str(root / "platform"),
                "KB_JOURNEY_INVOCATIONS": str(root),
            }
            password = store_report_secret(
                env, "KB_JOURNEY_ADMIN_PASSWORD", "synthetic-journey-password-never-print",
                "synthetic PTY regression secret")
            env["KB_JOURNEY_STATES"] = json.dumps({"candidateState": password})
            stdout = io.StringIO()

            def add_timeout_step(journey, *_args, **_kwargs):
                journey.step(
                    "synthetic PTY timeout", "journey.auth",
                    lambda: run_pty_command(
                        [sys.executable, "-c",
                         "import os,time; print(os.environ['KB_JOURNEY_ADMIN_PASSWORD'], flush=True); time.sleep(5)"],
                        env=os.environ.copy(), timeout=0.3,
                    ),
                )

            with patch.dict(os.environ, env, clear=False), \
                    patch("service_runner.checks", return_value=[]), \
                    patch("service_runner.configure_installed_cli_path"), \
                    patch("service_runner.run_service_steps", side_effect=add_timeout_step), \
                    patch("service_runner.FlowGraph.flow", return_value=None), \
                    patch("service_runner.archive_service_logs"), \
                    patch("sys.argv", ["service_runner.py", "--mode", "local", "--output", str(output)]), \
                    redirect_stdout(stdout):
                status = service_main()

            report_text = output.read_text()
            report = json.loads(report_text)
            invocation_text = (root / "invocations" / "calls.jsonl").read_text()
            step_message = next(step["message"] for step in report["steps"]
                                if step["name"] == "synthetic PTY timeout")
            for rendered in (invocation_text, step_message, report_text, stdout.getvalue()):
                if password in rendered:
                    self.fail("synthetic secret leaked through a journey output boundary")
            self.assertEqual(status, 1)
            self.assertIn("[REDACTED]", step_message)
            self.assertIn("[REDACTED]", invocation_text)

    def test_pre_service_failure_is_saved_with_step_and_message(self):
        with tempfile.TemporaryDirectory() as directory:
            result = record_runner_failure(Path(directory) / "service-local.json", "local",
                                           "install.sh: download returned HTTP 404")
        self.assertEqual(result.status, "FAIL")
        self.assertEqual(result.steps[0]["capability"], "journey.install")
        self.assertEqual(result.steps[0]["name"], "install.sh")
        self.assertEqual(result.steps[0]["message"], "download returned HTTP 404")

    def test_runner_startup_exception_writes_failure_result_without_traceback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            broken_runner = root / "broken_runner.py"
            broken_runner.write_text('raise RuntimeError("simulated import failure")\n')
            summary = root / "journey-summary.md"
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                status = run_runner(broken_runner, summary, "local")
            result = load_results(root)[0]
        self.assertEqual(status, 1)
        self.assertEqual(result["steps"][0]["capability"], "journey.runner")
        self.assertEqual(result["steps"][0]["status"], "FAIL")
        self.assertEqual(result["steps"][0]["name"], "runner startup")
        self.assertIn("simulated import failure", result["steps"][0]["message"])
        self.assertNotIn("Traceback", stderr.getvalue())

    def test_runner_crash_is_labeled_separately_from_startup_and_logs_traceback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            crashing_runner = root / "crashing_runner.py"
            crashing_runner.write_text('def main():\n    raise RuntimeError("simulated run crash")\n')
            stdout = io.StringIO()
            with patch.dict(os.environ, {"HOME": str(root)}), redirect_stdout(stdout):
                status = run_runner(crashing_runner, root / "journey-summary.md", "local")
            result = load_results(root)[0]
            self.assertEqual(status, 1)
            self.assertEqual(result["steps"][0]["name"], "runner crash")
            self.assertIn("simulated run crash", result["steps"][0]["message"])
            diagnostics = (root / "journey-diagnostics.log").read_text()
            self.assertIn("Traceback (most recent call last)", diagnostics)
            self.assertIn("RuntimeError: simulated run crash", diagnostics)
            self.assertIn("Journey runner crashed: RuntimeError: simulated run crash", stdout.getvalue())

    def test_secured_release_admin_signs_in_without_unneeded_platform_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "home"
            home.mkdir()
            project = home / "fresh-project"
            project.mkdir()
            commands = []

            def fake_run(args, *, env, cwd, timeout):
                commands.append((args, cwd))
                return subprocess.CompletedProcess(args, 0, "{}", ""), 0.0

            with patch("runner.PROJECT", project):
                result = login_and_configure_secured_admin(
                    env={"HOME": str(home), "KB_JOURNEY_PROJECT_ROOT": str(project),
                         "KB_JOURNEY_PLATFORM_ROOT": str(root / "platform"),
                         "KB_JOURNEY_ADMIN_EMAIL": "admin@example.test",
                         "KB_JOURNEY_ADMIN_PASSWORD": "password"},
                    launcher="kb-create", run_command=fake_run)

        self.assertIsNone(result)
        self.assertEqual(len(commands), 1)
        self.assertEqual(commands[0][0][3:6], ["kb", "auth", "login"])
        self.assertEqual(commands[0][1], project)

    def test_secured_admin_signs_in_before_authenticated_provider_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "home"
            home.mkdir()
            project = home / "fresh-project"
            project.mkdir()
            commands = []

            def fake_run(args, *, env, cwd, timeout):
                commands.append((args, cwd))
                return subprocess.CompletedProcess(args, 0, "{}", ""), 0.0

            result = login_and_configure_secured_admin(
                env={"HOME": str(home), "KB_JOURNEY_PROJECT_ROOT": str(project),
                     "KB_JOURNEY_PLATFORM_ROOT": str(root / "platform"),
                     "KB_JOURNEY_ADMIN_EMAIL": "admin@example.test",
                     "KB_JOURNEY_ADMIN_PASSWORD": "password"},
                launcher="kb-create", configure_oidc=True, run_command=fake_run)

        self.assertIsNone(result)
        self.assertEqual(len(commands), 3)
        self.assertEqual(commands[0][0][3:6], ["kb", "auth", "login"])
        self.assertIn("gateway.auth.providers", commands[1][0])
        self.assertEqual(commands[1][1], home)
        self.assertEqual(commands[2][0], ["kb-create", "restart", "--platform-root", str(root / "platform")])

    def test_secured_platform_config_is_not_attempted_when_admin_login_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "project"
            project.mkdir()
            commands = []

            def fake_run(args, *, env, cwd, timeout):
                commands.append(args)
                return subprocess.CompletedProcess(args, 1, "login denied", ""), 0.0

            result = login_and_configure_secured_admin(
                env={"HOME": str(root), "KB_JOURNEY_PROJECT_ROOT": str(project),
                     "KB_JOURNEY_PLATFORM_ROOT": str(root / "platform"),
                     "KB_JOURNEY_ADMIN_EMAIL": "admin@example.test",
                     "KB_JOURNEY_ADMIN_PASSWORD": "password"},
                launcher="kb-create", run_command=fake_run)

        self.assertEqual(result[0], "kb auth login")
        self.assertEqual(len(commands), 1)
        self.assertEqual(commands[0][3:6], ["kb", "auth", "login"])

    def test_mcp_probe_uses_shared_mcp_reader(self):
        tools = [{"name": name, "inputSchema": {"type": "object"}}
                 for name in (commit_tool("commit commit"), *service_tool_names(DEFAULT_ENABLED_SERVICES), "kb-labs__mcp_diagnostics")]
        with patch("service_runner.request_mcp", return_value=(200, {"jsonrpc": "2.0", "result": {"tools": tools}}, {})) as request:
            failure = mcp_probe("prj_test", "token", DEFAULT_ENABLED_SERVICES)
        self.assertIsNone(failure)
        self.assertEqual(request.call_args.kwargs["accept"], "application/json, text/event-stream")
        self.assertEqual(request.call_args.kwargs["step"], "project-scoped MCP tools/list")

    def test_mcp_probe_accepts_catalog_for_project_without_workflow(self):
        enabled = DEFAULT_ENABLED_SERVICES - {"workflow"}
        tools = [{"name": name, "inputSchema": {"type": "object"}}
                 for name in (commit_tool("commit commit"), *service_tool_names(enabled), "kb-labs__mcp_diagnostics")]
        with patch("service_runner.request_mcp", return_value=(200, {"result": {"tools": tools}}, {})):
            self.assertIsNone(mcp_probe("prj_without_workflow", "token", enabled))

    def test_mcp_probe_rejects_service_tool_outside_enabled_catalog(self):
        enabled = DEFAULT_ENABLED_SERVICES - {"workflow"}
        tools = [{"name": name, "inputSchema": {"type": "object"}}
                 for name in (commit_tool("commit commit"), *service_tool_names(enabled),
                              "workflow__workflow_run", "kb-labs__mcp_diagnostics")]
        with patch("service_runner.request_mcp", return_value=(200, {"result": {"tools": tools}}, {})):
            failure = mcp_probe("prj_with_extra_workflow", "token", enabled)
        self.assertIn("service catalog mismatch", failure)
        self.assertIn("workflow__workflow_run", failure)

    def test_mcp_probe_uses_sanitized_platform_member_manifest_id(self):
        tools = [{"name": name, "inputSchema": {"type": "object"}}
                 for name in (*service_tool_names(DEFAULT_ENABLED_SERVICES), "kb-labs__mcp_diagnostics")]
        with patch("service_runner.request_mcp", return_value=(200, {"result": {"tools": tools}}, {})):
            failure = mcp_probe("prj_test", "token", DEFAULT_ENABLED_SERVICES)
        self.assertIn("expected=", failure)
        self.assertIn(commit_tool("commit commit"), failure)
        self.assertIn("served=", failure)

    def test_prepare_mcp_projects_writes_id_and_canonical_root_to_fixture_handoff(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "home"
            home.mkdir()
            project_a = root / "project-a"
            project_a.mkdir()
            subprocess.run(["git", "init", "-q", str(project_a)], check=True)
            (project_a / "note.txt").write_text("journey note\n")
            subprocess.run(["git", "-C", str(project_a), "add", "note.txt"], check=True)
            fixture_file = home / "project-fixtures.json"
            env = {"HOME": str(home), "KB_JOURNEY_PROJECT_FIXTURES_FILE": str(fixture_file)}
            calls = []
            registered_project_exists = []
            registered_project_roots = []

            def fake_runner(command, **kwargs):
                calls.append(command)
                if command[:3] == ["kb", "project", "add"]:
                    registry_project_root = str(Path(kwargs["cwd"]).resolve())
                    registered_project_roots.append(registry_project_root)
                    registered_project_exists.append(
                        Path(registry_project_root).is_dir() and (Path(registry_project_root) / ".git").is_dir())
                    return subprocess.CompletedProcess(
                        command, 0,
                        json.dumps({"ok": True, "data": {"project": {"id": "prj_b", "path": registry_project_root}}}), "")
                return subprocess.CompletedProcess(command, 0, "{}", "")

            with patch("service_runner._registry_version", return_value="2.120.1"):
                with patch.dict(os.environ, {}, clear=False):
                    project_b_id, project_b_root = _prepare_mcp_projects(
                        "prj_project_a", str(project_a), "http://registry.test", env, fake_runner)
                    self.assertNotIn("KB_JOURNEY_PROJECT_B_ID", os.environ)
                    self.assertNotIn("KB_JOURNEY_PROJECT_B_ROOT", os.environ)
            project_id = "prj_" + hashlib.sha256(
                str(project_a.resolve()).encode("utf-8")).hexdigest()[:16]
            plan_path = home / ".kb" / "state" / project_id / "commit" / "plans" / "root" / "current" / "plan.json"
            plan = json.loads(plan_path.read_text())
            handoff = json.loads(fixture_file.read_text())

        self.assertEqual(project_b_id, "prj_b")
        self.assertEqual(registered_project_roots, [project_b_root])
        self.assertNotIn("KB_JOURNEY_PROJECT_B_ID", env)
        self.assertNotIn("KB_JOURNEY_PROJECT_B_ROOT", env)
        self.assertEqual(handoff, {
            "projectAId": "prj_project_a",
            "projectARoot": str(project_a.resolve()),
            "projectBId": project_b_id,
            "projectBRoot": project_b_root,
            "commitPlanPreparationResult": {
                "path": str(plan_path), "planId": "journey-commit", "totalCommits": 1,
            },
        })
        self.assertEqual(calls[0], ["kb", "marketplace", "install", "@kb-labs/commit", "--json"])
        registration_calls = [call for call in calls if call[:3] == ["kb", "project", "add"]]
        self.assertEqual(len(registration_calls), 1)
        self.assertEqual(calls[2], ["kb", "marketplace", "install", "@kb-labs/review@2.120.1", "--json"])
        self.assertEqual(registration_calls[0][0:3], ["kb", "project", "add"])
        self.assertEqual(registered_project_exists, [True])
        self.assertEqual(plan["gitStatus"]["staged"], ["note.txt"])
        self.assertEqual(plan["commits"][0]["files"], ["note.txt"])

    def test_mcp_initialize_checks_protocol_response(self):
        response = {"result": {"protocolVersion": "2025-03-26"}}
        with patch("service_runner.request", return_value=(200, response, {})) as ux_request, \
                patch("service_runner.request_mcp", return_value=(200, response, {})) as request:
            self.assertIsNone(mcp_initialize("prj_test", "token"))
        request.assert_called_once()
        ux_request.assert_not_called()
        self.assertEqual(request.call_args.kwargs["payload"]["method"], "initialize")
        self.assertEqual(request.call_args.kwargs["step"], "project-scoped MCP initialize")
        with patch("service_runner.request_mcp", return_value=(200, {"result": {}}, {})):
            self.assertIn("no result", mcp_initialize("prj_test", "token"))

    def test_mcp_diagnostics_checks_clean_project_result(self):
        result = {"result": {"isError": False, "content": [{"text": "Project loaded cleanly"}]}}
        with patch("service_runner.request_mcp", return_value=(200, result, {})) as request:
            self.assertIsNone(mcp_diagnostics("prj_test", "token"))
        self.assertEqual(request.call_args.kwargs["payload"]["params"]["name"], "kb-labs__mcp_diagnostics")
        self.assertEqual(request.call_args.kwargs["step"], "project-scoped MCP diagnostics")
        with patch("service_runner.request_mcp", return_value=(200, {"result": {"isError": True, "content": []}}, {})):
            self.assertIn("did not report", mcp_diagnostics("prj_test", "token"))

    def test_health_claim_requires_json_object(self):
        with patch("service_runner.request", return_value=(200, {"ok": True, "data": {"ready": True}}, {})):
            self.assertIsNone(expect_json("/ready", "gateway readiness"))
        with patch("service_runner.request", side_effect=ValueError("response is not a valid UX success envelope")):
            self.assertIn("invalid UX result envelope", expect_json("/ready", "gateway readiness"))

    # case: S-041.4
    def test_secured_auth_journey_preserves_session_until_logout_after_restart(self):
        calls = []
        state = {"admin_revoked": False}

        def fake_request(_base, path, *, method="GET", token=None, body=None, expected=200):
            calls.append((method, path, token, body, expected))
            if path == "/auth/register":
                self.assertEqual(expected, 401)
                return {
                    "code": "KB_AUTH_REQUIRED",
                    "message": "Authentication is required.",
                    "hint": catalogued_error_hint("KB_AUTH_REQUIRED", gatewayUrl="http://gateway.test"),
                }
            if path == "/auth/permissions":
                return {"permissions": ["users:read"]}
            if path == "/auth/users" and expected == 200:
                return {"users": [{"email": "member@example.test", "userId": "member-1"}]}
            if path == "/auth/invites":
                return {"activationUrl": "http://localhost/activate/invite-token"}
            if path.endswith("password-reset-link"):
                return {"resetUrl": "http://localhost/reset-password/reset-token-for-journey"}
            if path == "/auth/me" and token == "admin-access":
                self.assertEqual(expected, 401 if state["admin_revoked"] else 200)
                return {} if state["admin_revoked"] else {"email": "admin@example.test"}
            if path == "/auth/me" and token == "fresh-admin-token":
                self.assertEqual(expected, 200)
                return {"email": "admin@example.test"}
            if path == "/auth/logout/cli" and body == {"refreshToken": "admin-refresh"}:
                state["admin_revoked"] = True
                return {"ok": True}
            if path == "/auth/refresh/cli" and body == {"refreshToken": "admin-refresh"}:
                return {"error": "invalid_session"}
            return {}

        logins = iter([
            ("admin-access", "admin-refresh"),
            ("member-access", "member-refresh"),
            ("member-replacement-access", "member-replacement-refresh"),
            ("fresh-admin-token", "fresh-admin-refresh"),
        ])

        def fake_login(_base, email, password):
            calls.append(("LOGIN", email, password, None, None))
            return next(logins)

        def restart_host():
            calls.append(("RESTART", "", None, None, None))
            return "http://gateway.test/restarted"

        with patch("steps.auth._request", side_effect=fake_request), \
             patch("steps.auth._login", side_effect=fake_login):
            run_secured_auth_steps("http://gateway.test", "admin@example.test", "synthetic-admin-password",
                                   "member@example.test", restart_host)

        restart = calls.index(("RESTART", "", None, None, None))
        restart_check = calls.index(("GET", "/auth/me", "admin-access", None, 200), restart)
        logout = calls.index(("POST", "/auth/logout/cli", None, {"refreshToken": "admin-refresh"}, 200))
        revoked_check = calls.index(("GET", "/auth/me", "admin-access", None, 401))
        fresh_login = calls.index(("LOGIN", "admin@example.test", "synthetic-admin-password", None, None), restart)
        fresh_check = calls.index(("GET", "/auth/me", "fresh-admin-token", None, 200))
        self.assertLess(restart_check, logout)
        self.assertLess(logout, revoked_check)
        self.assertLess(revoked_check, fresh_login)
        self.assertLess(fresh_login, fresh_check)

    def test_dockerfile_copies_modules_imported_by_journey_scripts_together(self):
        root = Path(__file__).resolve().parents[2]
        journey_dir = Path(__file__).resolve().parent
        copied_into_package = set()
        wrapper_copied = False
        for line in (journey_dir / "Dockerfile.runner").read_text().splitlines():
            if not line.lstrip().startswith("COPY "):
                continue
            tokens = shlex.split(line)
            if any(token.startswith("--from=") for token in tokens[1:-1]):
                continue
            destination = tokens[-1]
            for source in tokens[1:-1]:
                for path in root.glob(source):
                    target = Path(destination)
                    if path.is_dir() and str(target) == "/opt/kb-journey/e2e/journey":
                        copied_into_package.update(child.name for child in path.glob("*.py"))
                    if destination.endswith("/"):
                        target /= path.name
                    if str(target) == "/usr/local/bin/kb-journey-runner" and path.name == "entrypoint.py":
                        wrapper_copied = True
                    if str(target.parent) == "/opt/kb-journey/e2e/journey":
                        copied_into_package.add(path.name)

        local_modules = {path.stem for path in journey_dir.glob("*.py")}
        imported_modules = set()
        for filename in ("runner.py", "service_runner.py", "studio_steps.py"):
            tree = ast.parse((journey_dir / filename).read_text(), filename=filename)
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    imported_modules.update(alias.name.split(".", 1)[0] for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    imported_modules.add(node.module.split(".", 1)[0])
        required_modules = {f"{name}.py" for name in imported_modules & local_modules}
        required_modules.update({"runner.py", "service_runner.py", "studio_steps.py"})
        self.assertTrue(wrapper_copied, "Dockerfile.runner must install entrypoint.py as kb-journey-runner")
        self.assertTrue(required_modules <= copied_into_package,
                        f"Dockerfile.runner misses journey modules: {sorted(required_modules - copied_into_package)}")
        self.assertIn("COPY e2e/journey /opt/kb-journey/e2e/journey",
                      (journey_dir / "Dockerfile.runner").read_text(),
                      "Dockerfile.runner must mirror the journey package under the repository resource root")

    def test_aggregate_compares_previous_status_and_uses_stable_fingerprint(self):
        bad = {"capability": "workflow", "mode": "local", "name": "run", "status": "FAIL",
               "message": "HTTP 404 at host A", "duration_seconds": 1}
        report = aggregate([{"steps": [bad]}])
        self.assertEqual(report["status"], "FAIL")
        self.assertEqual(fingerprint(bad), fingerprint({**bad, "message": "HTTP 500 at host B"}))
        good = {**bad, "status": "PASS", "message": "passed"}
        next_report = aggregate([{"steps": [good]}], [{"steps": [bad]}])
        self.assertEqual(next_report["delta"]["fixed"], ["workflow:local"])

    def test_yesterday_today_fixtures_report_fixed_and_new_failures(self):
        fixtures = Path(__file__).parent / "fixtures" / "nightly"
        report = aggregate(load_results(fixtures / "today"), load_results(fixtures / "yesterday"))
        self.assertEqual(report["delta"]["fixed"], ["workflow:local"])
        self.assertEqual(report["delta"]["new"], ["mcp:local"])
        self.assertEqual(report["status"], "FAIL")

    def test_empty_results_cannot_pass(self):
        report = aggregate([])
        self.assertEqual(report["status"], "FAIL")
        self.assertEqual(report["capabilities"][0]["first_failure"]["name"], "result files")

    def test_release_case_coverage_is_included_in_nightly_status(self):
        capability_result = {"steps": [{"capability": "gateway", "mode": "local", "name": "ready",
                                        "status": "PASS", "duration_seconds": 0, "message": "passed"}]}
        coverage = {"schema": "kb.qa-case-coverage/v1", "mode": "local", "releasePassed": False,
                    "cases": [{"id": "S-045", "release": True, "status": "active", "statusResult": "NOT COVERED"}]}
        report = aggregate([capability_result], case_coverage=[coverage])
        self.assertEqual(report["status"], "FAIL")
        self.assertEqual(report["case_coverage"], [coverage])
        self.assertIn("Case coverage (local): **FAIL**", render_summary(report))

    def test_result_with_no_capability_steps_cannot_pass(self):
        report = aggregate([{"steps": []}])
        self.assertEqual(report["status"], "FAIL")
        self.assertEqual(report["capabilities"][0]["first_failure"]["name"], "capability results")

    def test_profile_missing_declared_capabilities_is_blocked(self):
        result = {"steps": [{"capability": "gateway", "mode": "local", "name": "ready",
                            "status": "PASS", "duration_seconds": 0, "message": "passed"}]}
        report = aggregate([result], profiles={"local": {"gateway", "workflow"}})
        workflow = next(item for item in report["capabilities"] if item["capability"] == "workflow")
        self.assertEqual(workflow["status"], "BLOCKED")
        self.assertIn("profile local declares workflow", workflow["first_failure"]["message"])
        self.assertEqual(report["status"], "BLOCKED")

    def test_profile_passes_only_when_each_declared_capability_passes(self):
        steps = [{"capability": capability, "mode": "local", "name": capability,
                  "status": "PASS", "duration_seconds": 0, "message": "passed"}
                 for capability in ("gateway", "workflow")]
        report = aggregate([{"steps": steps}], profiles={"local": {"gateway", "workflow"}})
        self.assertEqual(report["status"], "PASS")
        self.assertEqual({item["capability"] for item in report["capabilities"]}, {"gateway", "workflow"})

    def test_nonzero_journey_exit_fails_even_when_result_steps_pass(self):
        result = {"steps": [{"capability": "gateway", "mode": "secured", "name": "ready",
                            "status": "PASS", "duration_seconds": 0, "message": "passed"}]}
        report = aggregate([result], journey_exits={"secured": 7})
        failure = next(item for item in report["capabilities"] if item["capability"] == "journey.runner")
        self.assertEqual(report["status"], "FAIL")
        self.assertEqual(failure["first_failure"]["name"], "journey process exit")
        self.assertIn("status 7", failure["first_failure"]["message"])

    def test_unparseable_result_file_is_reported_as_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "service-local.json").write_text("{broken")
            report = aggregate(load_results(directory))
        failure = next(item for item in report["capabilities"] if item["capability"] == "journey.runner")
        self.assertEqual(report["status"], "FAIL")
        self.assertEqual(failure["first_failure"]["name"], "result file parse")
        self.assertIn("service-local.json", failure["first_failure"]["message"])

    def test_result_loader_skips_case_coverage_documents(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "service-local.json").write_text('{"steps":[]}')
            Path(directory, "case-coverage-local.json").write_text('{"schema":"kb.qa-case-coverage/v1"}')
            Path(directory, "report.json").write_text('{"schema":"kb.nightly-report/v1"}')
            results = load_results(directory)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0], {"steps": []})

    def test_invalid_step_status_cannot_be_treated_as_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "service-local.json").write_text(
                '{"steps":[{"capability":"workflow","mode":"local","name":"run",'
                '"status":"SKIP","message":"missing"}]}'
            )
            report = aggregate(load_results(directory))
        failure = next(item for item in report["capabilities"] if item["capability"] == "journey.runner")
        self.assertEqual(report["status"], "FAIL")
        self.assertIn("status must be", failure["first_failure"]["message"])

    def test_declared_profile_capabilities_match_service_checks(self):
        for mode, auth_capability in (("local", "auth.local"), ("secured", "auth.invite-reset")):
            self.assertEqual(declared_capabilities(mode),
                             {capability for _, capability, _, _, _, _ in checks(mode)}
                             | {auth_capability, "plugin-author"})

    def test_issue_sync_is_idempotent_updates_existing_and_closes_fixed(self):
        client = FakeGitHub()
        failure = {"capability": "mcp", "mode": "secured", "name": "tools/list",
                   "status": "FAIL", "message": "HTTP 404", "duration_seconds": 2}
        report = aggregate([{"steps": [failure]}])
        first = sync_issues(client, report, 10)
        self.assertEqual(len(first["created"]), 1)
        self.assertEqual(len(client.issues), 2)
        second = sync_issues(client, report, 10)
        self.assertEqual(second["updated"], first["created"])
        self.assertEqual(len(client.issues), 2)
        green = aggregate([{"steps": [{**failure, "status": "PASS", "message": "passed"}]}])
        closed = sync_issues(client, green, 10)
        self.assertEqual(len(closed["closed"]), 1)
        self.assertEqual(client.issues[1]["state"], "closed")

    # case: S-261.3
    def test_issue_sync_creates_one_pinned_status_issue_when_missing(self):
        client = FakeGitHub()
        client.issues.clear()
        passed = {"capability": "gateway", "mode": "local", "name": "ready",
                  "status": "PASS", "message": "passed", "duration_seconds": 0}
        report = aggregate([{"steps": [passed]}])
        changes = sync_issues(client, report, 0)
        self.assertEqual(len(client.issues), 1)
        self.assertIn("nightly-status", client.issues[0]["labels"])
        self.assertEqual(changes, {"created": [], "updated": [], "closed": []})
        sync_issues(client, report, 0)
        self.assertEqual(len(client.issues), 1, "the nightly issue is found and updated on the next run")

    def test_required_mode_steps_and_workflow_fixture_are_explicit(self):
        local = {capability for _, capability, _, _, _, _ in checks("local")}
        secured = {capability for _, capability, _, _, _, _ in checks("secured")}
        self.assertNotIn("auth.invites", local | secured)
        self.assertNotIn("scaffold", local | secured)
        with patch("service_runner.request", return_value=(200, {"data": {"workflows": []}}, {})):
            failure = discover_workflow("prj_fixture", "")
        self.assertIn("e2e-hello fixture", failure)


if __name__ == "__main__":
    unittest.main()
