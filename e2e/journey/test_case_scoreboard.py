import json
import tempfile
import unittest
from pathlib import Path

from scoreboard import RELEASE_GATING_MODES, build_scoreboard, load_cases, release_claims_for_case, render_delta, render_markdown, write_scoreboards
from service_steps import FlowGraph, Journey
from invocations import invocation_context, record_invocation
import jsonl


JOURNEY_ROOT = Path(__file__).resolve().parent


class CaseScoreboardTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.catalog = self.root / "catalog"
        self.reports = self.root / "reports"
        self.catalog.mkdir()
        self.reports.mkdir()
        (self.catalog / "S-001-demo.md").write_text(
            "---\nid: S-001\ntitle: Demo\nstatus: active\nrelease: true\nmodes: [local, secured]\n---\n"
            "| S-001.1 | First | observable result |\n| S-001.2 | Second | observable result |\n",
            encoding="utf-8")
        (self.catalog / "S-002-secured.md").write_text(
            "---\nid: S-002\ntitle: Secured only\nstatus: active\nrelease: false\nmodes: [secured]\n---\n"
            "| S-002.1 | First | observable result |\n", encoding="utf-8")
        (self.catalog / "S-003-planned.md").write_text(
            "---\nid: S-003\ntitle: Planned\nstatus: planned\nrelease: true\nmodes: [local, secured]\n---\n"
            "| S-003.1 | First | observable result |\n", encoding="utf-8")
        (self.catalog / "S-004-historical.md").write_text(
            "---\nid: S-004\ntitle: Historical\nstatus: historical\nrelease: false\nmodes: [local, secured]\n---\n",
            encoding="utf-8")

    def tearDown(self):
        self.temporary.cleanup()

    def write_json(self, name, data):
        (self.reports / name).write_text(json.dumps(data), encoding="utf-8")

    def test_release_gate_is_owned_by_local_mode_and_secured_stays_non_gating(self):
        self.assertEqual(RELEASE_GATING_MODES, ("local",))
        self.write_json("installer-case-local-agent-explore-default.json", {
            "case_run": {"mode": "local", "claims": [
                {"claimId": "S-001.1", "status": "PASS"},
                {"claimId": "S-001.2", "status": "PASS"}]}, "steps": []})
        self.write_json("service-secured.json", {
            "case_run": {"mode": "secured", "claims": []},
            "steps": [{"cases": ["S-001.1", "S-001.2"], "status": "FAIL", "message": "secured lane failure"}]})

        combined = build_scoreboard(self.reports, self.catalog, ["local", "secured"])
        secured = build_scoreboard(self.reports, self.catalog, ["secured"])

        self.assertEqual(combined["releaseGate"], {"modes": ["local"], "gating": True})
        self.assertEqual(combined["releaseCases"], {"fullyGreen": 1, "total": 1})
        self.assertEqual(secured["releaseGate"], {"modes": ["local"], "gating": False})
        self.assertEqual(secured["releaseCases"], {"fullyGreen": 0, "total": 0})
        self.assertIn("non-gating for Release 1", render_markdown(secured))

    def test_scores_case_defined_denominator_and_mode_specific_results(self):
        self.write_json("installer-case-local-agent-explore-default.json", {
            "case_run": {"mode": "local", "claims": [
                {"claimId": "S-001.1", "status": "PASS"},
                {"claimId": "S-001.2", "status": "PASS"}]}, "steps": []})
        self.write_json("service-secured.json", {
            "case_run": {"mode": "secured", "claims": [
                {"claimId": "S-001.1", "status": "PASS"}]},
            "steps": [{"cases": ["S-001.2"], "status": "BLOCKED", "message": "KB_JOURNEY_PROJECT_B_ID is missing"},
                      {"cases": ["S-002.1"], "status": "FAIL", "message": "failed"}]})

        local = build_scoreboard(self.reports, self.catalog, ["local"])
        secured = build_scoreboard(self.reports, self.catalog, ["secured"])
        combined = build_scoreboard(self.reports, self.catalog, ["local", "secured"])
        local_cases = {case["id"]: case for case in local["cases"]}
        secured_cases = {case["id"]: case for case in secured["cases"]}
        combined_cases = {case["id"]: case for case in combined["cases"]}

        self.assertEqual(local_cases["S-001"]["status"], "Fully green")
        self.assertNotIn("S-002", local_cases)
        self.assertEqual(secured_cases["S-001"]["status"], "Partial")
        self.assertEqual(secured_cases["S-002"]["status"], "Red")
        self.assertEqual(combined_cases["S-001"]["status"], "Partial")
        self.assertEqual(combined_cases["S-001"]["claimCount"], 2)
        self.assertEqual(local["releaseCases"], {"fullyGreen": 1, "total": 1})
        self.assertEqual(local["activeCases"], {"fullyGreen": 1, "total": 1})
        self.assertEqual(secured["activeCases"], {"fullyGreen": 0, "total": 2})
        self.assertEqual(combined["activeCases"], {"fullyGreen": 0, "total": 2})
        self.assertEqual(local["plannedCount"], 1)
        self.assertEqual(local["historicalCount"], 1)
        self.assertNotIn("S-004", {case["id"] for case in local["cases"]})

    def test_blocking_roots_rank_transitive_claims_and_report_unclaimed_cases(self):
        (self.catalog / "S-005-unclaimed.md").write_text(
            "---\nid: S-005\ntitle: Unclaimed\nstatus: active\nrelease: false\nmodes: [local]\n---\n"
            "| S-005.1 | First | observable result |\n", encoding="utf-8")
        self.write_json("service-local.json", {
            "case_run": {"mode": "local", "claims": []},
            "steps": [
                {"stepId": "case:S-001.1", "name": "A", "status": "FAIL", "message": "install failed", "cases": ["S-001.1"]},
                {"stepId": "case:S-001.2-b", "name": "B", "status": "BLOCKED", "message": "blocked", "cases": ["S-001.2"],
                 "details": {"requires": ["step:case:S-001.1"]}},
                {"stepId": "case:S-001.2-c", "name": "C", "status": "BLOCKED", "message": "blocked", "cases": ["S-001.2"],
                 "details": {"requires": ["step:case:S-001.1"]}},
                {"stepId": "case:S-001.1-leaf", "name": "leaf", "status": "FAIL", "message": "leaf failure", "cases": ["S-001.1"]},
            ],
            "states": {"platform-installed": {"passed": False, "group": "install", "step": "case:S-001.1"}},
        })
        scoreboard = build_scoreboard(self.reports, self.catalog, ["local"])
        roots = scoreboard["blockingRoots"]
        self.assertEqual(roots[0]["stepId"], "case:S-001.1")
        self.assertEqual(roots[0]["unblockedClaims"], 2)
        self.assertEqual(roots[0]["blockedCaseIds"], ["S-001"])
        self.assertEqual(roots[0]["blockedStepCount"], 2)
        self.assertEqual(roots[0]["blockedStepIds"], ["case:S-001.2-b", "case:S-001.2-c"])
        self.assertEqual(roots[1]["stepId"], "case:S-001.1-leaf")
        self.assertEqual(roots[1]["unblockedClaims"], 1)
        self.assertEqual(scoreboard["unclaimedCases"], ["S-005"])
        self.assertEqual(scoreboard["headline"]["claimsPassing"], {"count": 0, "total": 3})
        self.assertEqual(scoreboard["headline"]["claimsReachable"], {"count": 1, "total": 3})
        self.assertIn("Blocking roots", render_markdown(scoreboard))
        self.assertIn("Unclaimed", render_markdown(scoreboard))

    # case: S-261.3
    def test_j86_fixture_projects_recorded_failure_and_installer_prerequisite(self):
        fixture = JOURNEY_ROOT / "testdata" / "x104-j86" / "local.json"
        data = json.loads(fixture.read_text(encoding="utf-8"))
        recorded_session_failure = next(step["message"] for step in data["steps"]
                                        if step["stepId"] == "case:S-141.1")
        journey = Journey("local", "x104-j86-replay")
        journey.step("create project agent session", "agents", lambda: recorded_session_failure,
                     cases=["S-141.1"])
        for name, claim in (("list project agent sessions", "S-141.2"),
                            ("inspect project agent session", "S-141.3")):
            journey.step(name, "agents", lambda: self.fail("blocked check was invoked"), cases=[claim],
                         requires=("step:create project agent session",))
        data["steps"] = [step for step in data["steps"]
                         if step["stepId"] not in {"case:S-141.1", "case:S-141.2", "case:S-141.3"}]
        data["steps"].extend(journey.result().steps)
        self.write_json("installer-cases-local.json", data)

        real_catalog = Path(__file__).resolve().parents[2] / "docs" / "qa" / "scenarios"
        report = build_scoreboard(self.reports, real_catalog, ["local"])
        root_step = next(step for step in data["steps"]
                         if step["stepId"] == "case:PC-001.10,S-181.3")
        root = next(item for item in report["blockingRoots"]
                    if item["stepId"] == root_step["stepId"])
        self.assertEqual(root["failure"], root_step["message"])
        self.assertIn("case:S-181.6", root["blockedStepIds"])
        blocked = next(step for step in data["steps"] if step["stepId"] == "case:S-181.6")
        self.assertEqual(blocked["status"], "BLOCKED")
        self.assertEqual(blocked["details"]["requires"], [f"step:{root_step['stepId']}"])
        session_root = next(item for item in report["blockingRoots"]
                            if item["stepId"] == "case:S-141.1")
        self.assertEqual(session_root["failure"], recorded_session_failure)
        self.assertEqual(session_root["blockedStepIds"], ["case:S-141.2", "case:S-141.3"])
        markdown = render_markdown(report)
        self.assertIn("`case:S-141.2`", markdown)
        self.assertIn(recorded_session_failure, markdown)

    # case: S-261.3
    def test_j86_roots_group_by_captured_structured_error_and_keep_no_envelope_visible(self):
        journey = Journey("local", "x104-j86-root-groups")
        journey.step("plugin command with a structured failure", "plugin.run",
                     lambda: "plugin invocation failed", cases=["S-001.1"])
        journey.step("second plugin command with the same structured failure", "plugin.run",
                     lambda: "plugin invocation failed", cases=["S-001.2"])
        journey.step("assertion after success", "http", lambda: "expected a result", cases=["S-001.3"])
        steps = journey.result().steps
        self.write_json("installer-cases-local.json", {
            "case_run": {"mode": "local", "claims": []},
            "steps": steps,
        })
        envelope = {"code": "KB_PLUGIN_CONTRACT_VIOLATION", "area": "plugin", "stage": "run"}
        structured_failure_ids = {"case:S-001.1", "case:S-001.2"}
        for step in steps:
            if step["stepId"] not in structured_failure_ids:
                continue
            response = {"ok": False, "error": {**envelope, "message": "failure", "hint": "inspect"}}
            with invocation_context(step_id=step["stepId"].removeprefix("case:"), report_root=self.reports):
                record_invocation(kind="command", argv=["kb", "--json"], cwd=self.root,
                                  env={}, exit_code=1, stdout=json.dumps(response),
                                  duration_seconds=0.1)
        alternate = {"ok": False, "error": {
            "code": "KB_RUNTIME_UNEXPECTED", "area": "runtime", "stage": "run",
            "message": "failure", "hint": "inspect",
        }}
        with invocation_context(step_id="S-001.1", report_root=self.reports):
            record_invocation(kind="command", argv=["kb", "--json"], cwd=self.root,
                              env={}, exit_code=1, stdout=json.dumps(alternate),
                              duration_seconds=0.1)
        with invocation_context(step_id="S-001.3", report_root=self.reports):
            record_invocation(kind="http", argv=["GET"], cwd=self.root,
                              env={}, exit_code=200, url="http://example.test/success",
                              stdout=json.dumps({"ok": True, "data": {"value": "available"}}),
                              duration_seconds=0.1)
        self.write_json("installer-cases-local.json", {
            "case_run": {"mode": "local", "claims": []},
            "steps": steps,
        })

        report = build_scoreboard(self.reports, self.catalog, ["local"])
        groups = report["rootGroups"]
        self.assertEqual(groups[0]["error"], envelope)
        self.assertEqual(groups[0]["rootStepIds"], ["case:S-001.1", "case:S-001.2"])
        self.assertEqual(groups[0]["unblockedClaims"], 2)
        self.assertEqual(groups[1]["error"], {
            "code": "KB_RUNTIME_UNEXPECTED", "area": "runtime", "stage": "run",
        })
        self.assertEqual(groups[1]["unblockedClaims"], 1)
        no_envelope_group = next(group for group in groups if group["error"] is None)
        self.assertEqual(no_envelope_group["rootStepIds"], ["case:S-001.3"])
        markdown = render_markdown(report)
        self.assertIn("Root groups", markdown)
        self.assertIn("no envelope", markdown)
        self.assertIn("`case:S-001.3`", markdown)

    # case: S-261.3
    def test_unreadable_invocation_record_is_reported_by_line(self):
        calls = self.reports / "invocations" / "calls.jsonl"
        calls.parent.mkdir()
        calls.write_text("not-json\n", encoding="utf-8")

        report = build_scoreboard(self.reports, self.catalog, ["local"])

        self.assertEqual(report["unreadableInvocationRows"], [1])
        self.assertIn("invocations/calls.jsonl:1", render_markdown(report))

    def test_state_precondition_links_failed_state_owner_to_blocked_claim(self):
        self.write_json("service-local.json", {
            "case_run": {"mode": "local", "claims": []},
            "steps": [
                {"stepId": "case:S-001.1", "name": "host bootstrap", "status": "FAIL", "message": "host down", "cases": ["S-001.1"]},
                {"stepId": "case:S-001.2", "name": "project probe", "status": "BLOCKED", "message": "host state failed",
                 "cases": ["S-001.2"], "details": {"requires": ["state:host-running"]}},
            ],
            "states": {"host-running": {"passed": False, "group": "host", "step": "case:S-001.1"}},
        })
        roots = build_scoreboard(self.reports, self.catalog, ["local"])["blockingRoots"]
        self.assertEqual(roots[0]["stepId"], "case:S-001.1")
        self.assertEqual(roots[0]["blockedStepCount"], 1)
        self.assertEqual(roots[0]["layer"], 0)

    def test_state_owner_id_resolves_across_result_files_in_the_run(self):
        self.write_json("service-local-parent.json", {
            "case_run": {"mode": "local", "claims": []},
            "steps": [{"stepId": "case:S-001.1", "name": "host startup", "status": "FAIL",
                       "message": "host down", "cases": ["S-001.1"]}],
            "states": {"host-running": {"passed": False, "group": "host", "step": "case:S-001.1"}},
        })
        self.write_json("service-auth-local-child.json", {
            "case_run": {"mode": "local", "claims": []},
            "steps": [{"stepId": "case:S-001.2", "name": "project status", "status": "BLOCKED",
                       "message": "host unavailable", "cases": ["S-001.2"],
                       "details": {"requires": ["state:host-running"]}}],
        })
        roots = build_scoreboard(self.reports, self.catalog, ["local"])["blockingRoots"]
        root = next(item for item in roots if item["stepId"] == "case:S-001.1")
        self.assertEqual(root["blockedStepIds"], ["case:S-001.2"])
        self.assertEqual(root["layer"], 0)

    def test_missing_state_owner_is_reported_for_blocked_consumer(self):
        self.write_json("service-local.json", {
            "case_run": {"mode": "local", "claims": []},
            "steps": [{"stepId": "case:S-001.2", "name": "project probe", "status": "BLOCKED",
                       "message": "host state missing", "cases": ["S-001.2"],
                       "details": {"requires": ["state:absent-state"]}}],
        })

        report = build_scoreboard(self.reports, self.catalog, ["local"])
        self.assertEqual(report["unresolvedStateOwners"], [
            {"source": "service-local.json", "state": "absent-state", "step": None}])
        self.assertIn("state `absent-state` has no owner record", render_markdown(report))

    def test_state_owner_is_exact_step_and_unresolved_owner_is_diagnostic(self):
        self.write_json("service-local.json", {
            "case_run": {"mode": "local", "claims": []},
            "steps": [
                {"stepId": "case:S-001.1", "name": "owner", "status": "FAIL", "message": "host down", "cases": ["S-001.1"]},
                {"stepId": "case:S-001.2", "name": "same claim but unrelated", "status": "BLOCKED", "message": "blocked",
                 "cases": ["S-001.2"], "details": {"requires": ["state:host-running"]}},
                {"stepId": "case:S-001.1-decoy", "name": "same claim owner decoy", "status": "PASS", "message": "passed",
                 "cases": ["S-001.1"]},
            ],
            "states": {"host-running": {"passed": False, "group": "host", "step": "unregistered owner",
                                          "claim": "S-001.1"}},
        })
        report = build_scoreboard(self.reports, self.catalog, ["local"])
        root = next(item for item in report["blockingRoots"] if item["stepId"] == "case:S-001.1")
        self.assertEqual(root["blockedStepCount"], 0)
        self.assertEqual(root["unblockedClaims"], 1)
        self.assertEqual(report["unresolvedStateOwners"], [
            {"source": "service-local.json", "state": "host-running", "step": "unregistered owner"}])
        self.assertIn("Unresolved state owners", render_markdown(report))

    def test_failure_summary_uses_structured_marketplace_error_and_bounds_length(self):
        fixture = JOURNEY_ROOT / "testdata" / "marketplace-install-j81.jsonl"
        records = jsonl.read_jsonl(fixture)
        self.assertEqual([row.line_number for row in records if row.error is not None], [])
        artifact_rows = [row.value for row in records]
        invocation = next(row for row in artifact_rows
                          if row["step_id"] == "prepare update preservation baseline")
        marketplace_payload = json.loads(invocation["stdout"])["error"]
        self.assertEqual(marketplace_payload["code"], "KB_MARKETPLACE_PLATFORM_ARTIFACT_PINS_MISSING")
        self.write_json("platform-update-local.json", {
            "case_run": {"mode": "local", "claims": []},
            "steps": [{
                "stepId": "flow:prepare update preservation baseline", "name": "Marketplace root", "status": "FAIL", "cases": [],
                "message": "j81 recorded invocation",
                "details": {"error": marketplace_payload}
            }],
        })
        roots = build_scoreboard(self.reports, self.catalog, ["local"])["blockingRoots"]
        failure = roots[0]["failure"]
        self.assertTrue(failure.startswith(marketplace_payload["code"] + ": " + marketplace_payload["message"]))
        self.assertLessEqual(len(failure), 180)
        self.assertNotIn("hint", failure)

    def test_duplicate_display_names_are_indexed_by_stable_step_id(self):
        self.write_json("service-local.json", {
            "case_run": {"mode": "local", "claims": []},
            "steps": [
                {"stepId": "case:S-001.1", "name": "shared label", "status": "FAIL", "cases": ["S-001.1"]},
                {"stepId": "case:S-001.2", "name": "shared label", "status": "BLOCKED", "cases": ["S-001.2"],
                 "details": {"requires": ["step:case:S-001.1"]}},
            ],
        })
        roots = build_scoreboard(self.reports, self.catalog, ["local"])["blockingRoots"]
        self.assertEqual(len(roots), 1)
        self.assertEqual(roots[0]["stepId"], "case:S-001.1")
        self.assertEqual(roots[0]["blockedStepIds"], ["case:S-001.2"])

    def test_same_root_aggregates_union_of_blocked_ids_across_files(self):
        blocked_sets = ({"case:block-1", "case:block-2"}, {"case:block-2", "case:block-3"},
                        {"case:block-4"})
        for index, blocked in enumerate(blocked_sets):
            root_id = "flow:shared-root"
            steps = [{"stepId": root_id, "name": "same root", "status": "FAIL", "cases": ["S-001.1"],
                      "details": {"error": {"code": "E", "message": "failure"}}}]
            for blocked_id in blocked:
                steps.append({"stepId": blocked_id, "name": "blocked", "status": "BLOCKED", "cases": ["S-001.2"],
                              "details": {"requires": [f"step:{root_id}"]}})
            self.write_json(f"service-local-{index}.json", {"case_run": {"mode": "local", "claims": []}, "steps": steps})
        roots = build_scoreboard(self.reports, self.catalog, ["local"])["blockingRoots"]
        root = next(item for item in roots if item["stepId"] == "flow:shared-root")
        self.assertEqual(root["blockedStepIds"], sorted(set.union(*blocked_sets)))
        self.assertEqual(root["blockedStepCount"], 4)

    def test_parent_flow_failure_reaches_child_claim_across_serialized_result_files(self):
        Journey.reset_run_registry()
        parent = Journey("local", "parent-child-run")
        parent_flow = FlowGraph(parent, {})
        self.assertEqual(parent_flow.flow(
            "start platform host", "host", "platform.host", lambda: "host failed",
            cases=("PC-002.1",)), "FAIL")

        child = Journey("local", "parent-child-run", parent=parent)
        blocked = child.step(
            "confirm host status", "platform.host", lambda: None, cases=("PC-002.2",),
            requires=("flow:start platform host",))
        parent.write_json(self.reports / "service-local-parent.json")
        child.write_json(self.reports / "service-auth-local-child.json")

        self.assertEqual(parent.steps[0].step_id, "case:PC-002.1")
        self.assertEqual(blocked.status, "BLOCKED")
        self.assertEqual(blocked.details["requires"], ["step:case:PC-002.1"])
        real_catalog = Path(__file__).resolve().parents[2] / "docs" / "qa" / "scenarios"
        report = build_scoreboard(self.reports, real_catalog, ["local"])
        root = next(item for item in report["blockingRoots"] if item["stepId"] == "case:PC-002.1")
        self.assertEqual(root["blockedStepIds"], ["case:PC-002.2"])
        self.assertEqual(root["blockedCaseIds"], ["PC-002"])

    def test_unresolved_step_id_dependency_is_reported_without_name_matching(self):
        self.write_json("service-local.json", {
            "case_run": {"mode": "local", "claims": []},
            "steps": [{"stepId": "case:S-001.1", "name": "consumer", "status": "BLOCKED",
                       "cases": ["S-001.1"], "details": {"requires": ["step:case:missing"]}}],
        })
        report = build_scoreboard(self.reports, self.catalog, ["local"])
        self.assertEqual(report["unresolvedDependencies"], [{
            "source": "service-local.json", "stepId": "case:S-001.1", "requiredStepId": "case:missing"}])
        self.assertIn("Unresolved step dependencies", render_markdown(report))

    def test_reads_status_and_release_fields_from_real_scenarios(self):
        real_catalog = Path(__file__).resolve().parents[2] / "docs" / "qa" / "scenarios"
        cases = {case["id"]: case for case in load_cases(real_catalog)}
        self.assertEqual(cases["PC-001"]["status"], "active")
        self.assertIs(cases["PC-001"]["release"], True)
        self.assertEqual(cases["PC-005"]["status"], "historical")
        self.assertIs(cases["PC-005"]["release"], False)
        self.assertEqual(cases["S-034"]["status"], "planned")
        self.assertIs(cases["S-034"]["release"], False)

    def test_release_claims_follow_the_case_release_flag(self):
        catalog = Path(__file__).resolve().parents[2] / "docs" / "qa" / "scenarios"
        self.assertEqual(release_claims_for_case("S-109", catalog), [])
        self.assertEqual(release_claims_for_case("S-100", catalog), [])

    def test_playwright_tags_and_skip_are_claimed(self):
        self.write_json("studio-playwright-secured.json", {"suites": [{"specs": [{
            "title": "admin flow @S-001.1 @S-001.2", "ok": False,
            "tests": [{"annotations": [{"description": "missing admin fixture"}], "results": [
                {"status": "skipped"}]}]}]}]})
        scoreboard = build_scoreboard(self.reports, self.catalog, ["secured"])
        case = next(item for item in scoreboard["cases"] if item["id"] == "S-001")
        self.assertEqual(case["status"], "Blocked")

    def test_writer_emits_per_mode_and_combined_json_and_markdown(self):
        self.write_json("service-local.json", {"case_run": {"mode": "local", "claims": []}, "steps": []})
        self.write_json("service-auth-secured.json", {"case_run": {"mode": "secured", "claims": []}, "steps": []})
        (self.reports / "journey-summary.md").write_text("Existing journey rows\n", encoding="utf-8")
        write_scoreboards(self.reports, self.catalog)
        write_scoreboards(self.reports, self.catalog)
        for stem in ("case-scoreboard-local", "case-scoreboard-secured", "case-scoreboard"):
            self.assertTrue((self.reports / f"{stem}.json").is_file())
            self.assertTrue((self.reports / f"{stem}.md").is_file())
        combined = json.loads((self.reports / "case-scoreboard.json").read_text(encoding="utf-8"))
        self.assertEqual(combined["modes"], ["local", "secured"])
        markdown = (self.reports / "case-scoreboard.md").read_text(encoding="utf-8")
        self.assertLess(markdown.index("All active cases fully green:"), markdown.index("Release cases:"))
        self.assertLess(markdown.index("Release cases:"), markdown.index("All active cases:"))
        self.assertLess(markdown.index("All active cases:"), markdown.index("Planned cases:"))
        self.assertLess(markdown.index("Planned cases:"), markdown.index("Historical cases excluded:"))
        journey_summary = (self.reports / "journey-summary.md").read_text(encoding="utf-8")
        self.assertIn("Existing journey rows", journey_summary)
        self.assertIn("## Platform blocking pyramid", journey_summary)
        self.assertEqual(journey_summary.count("kb-journey-scoreboard:start"), 1)

    def test_writer_always_emits_both_mode_views_for_a_single_mode_run(self):
        self.write_json("service-local.json", {"case_run": {"mode": "local", "claims": []}, "steps": []})
        write_scoreboards(self.reports, self.catalog)
        secured = json.loads((self.reports / "case-scoreboard-secured.json").read_text(encoding="utf-8"))
        combined = json.loads((self.reports / "case-scoreboard.json").read_text(encoding="utf-8"))
        self.assertEqual(secured["observedModes"], ["local"])
        self.assertEqual(combined["modes"], ["local", "secured"])
        self.assertEqual(combined["observedModes"], ["local"])

    def test_partial_run_is_marked_and_never_contributes_case_evidence(self):
        self.write_json("service-secured.json", {
            "case_run": {"mode": "secured", "claims": [
                {"claimId": "S-001.1", "status": "PASS"},
                {"claimId": "S-001.2", "status": "PASS"}]},
            "steps": [],
        })
        self.write_json("service-local.json", {
            "case_run": {"mode": "local", "selection": ["S-001.1"],
                         "claims": [{"claimId": "S-001.1", "status": "PASS"},
                                    {"claimId": "S-001.2", "status": "PASS"}]},
            "steps": [],
        })
        scoreboard = build_scoreboard(self.reports, self.catalog, ["local"])
        case = next(item for item in scoreboard["cases"] if item["id"] == "S-001")
        self.assertEqual(scoreboard["selection"], ["S-001.1"])
        self.assertEqual(case["status"], "Unclaimed")
        self.assertIn("Partial run", render_markdown(scoreboard))

    def test_split_partial_journey_records_keep_selection_without_claiming_missing_rows(self):
        selection = ["S-001.1", "S-001.2"]
        self.write_json("installer-case-local-agent-explore-default.json", {
            "case_run": {"mode": "local", "selection": selection,
                         "claims": [{"claimId": "S-001.1", "status": "PASS"}]},
            "steps": [],
        })
        self.write_json("service-local.json", {
            "case_run": {"mode": "local", "selection": selection,
                         "claims": [{"claimId": "S-001.2", "status": "PASS"}]},
            "steps": [],
        })

        scoreboard = build_scoreboard(self.reports, self.catalog, ["local"])
        case = next(item for item in scoreboard["cases"] if item["id"] == "S-001")
        self.assertEqual(scoreboard["selection"], selection)
        self.assertEqual(case["status"], "Unclaimed")
        self.assertEqual(case["claimedCount"], 0)

    def test_delta_reports_new_and_regressed_fully_green_cases(self):
        before, after = self.root / "before", self.root / "after"
        before.mkdir()
        after.mkdir()
        for directory, green in ((before, "S-001"), (after, "S-002")):
            data = {"observedModes": ["local"], "releaseCases": {"fullyGreen": int(green == "S-001"), "total": 1},
                    "activeCases": {"fullyGreen": 1, "total": 2}, "plannedCount": 1, "historicalCount": 1,
                    "cases": [{"id": claim_id, "status": "Fully green" if claim_id == green else "Red",
                               "caseStatus": "active", "release": claim_id == "S-001", "modes": ["local"],
                               "claims": [f"{claim_id}.1", f"{claim_id}.2"],
                               "passingClaims": [f"{claim_id}.1", f"{claim_id}.2"] if claim_id == green else []}
                              for claim_id in ("S-001", "S-002")]}
            (directory / "case-scoreboard-local.json").write_text(json.dumps(data), encoding="utf-8")
        delta = render_delta(before, after)
        self.assertIn("local release cases: fully green 1/1 → 0/1", delta)
        self.assertIn("Claims passing: 2/4 → 2/4", delta)
        self.assertIn("Regressed: S-001", delta)
        self.assertIn("All active: fully green 1/2 → 1/2", delta)
        self.assertLess(delta.index("local release cases:"), delta.index("All active:"))

    def test_delta_omits_partial_runs_instead_of_reporting_regressions(self):
        before, after = self.root / "before-partial", self.root / "after-full"
        before.mkdir()
        after.mkdir()
        for directory, selection in ((before, ["S-001"]), (after, [])):
            data = {"observedModes": ["local"], "selection": selection,
                    "releaseCases": {"fullyGreen": 0, "total": 1},
                    "activeCases": {"fullyGreen": 0, "total": 2}, "plannedCount": 1,
                    "historicalCount": 1, "cases": []}
            (directory / "case-scoreboard-local.json").write_text(json.dumps(data), encoding="utf-8")
        delta = render_delta(before, after)
        self.assertIn("delta omitted because a scoreboard is partial", delta)
        self.assertNotIn("Regressed:", delta)


if __name__ == "__main__":
    unittest.main()
