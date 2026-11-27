import tempfile
import unittest
from pathlib import Path
from nightly_report import aggregate, fingerprint, load_results, render_summary, sync_issues
from service_runner import declared_capabilities, checks


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


class NightlyReportTests(unittest.TestCase):
    def test_nightly_report_job_runs_only_the_dedicated_report_test_module(self):
        workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/nightly-user-journey.yml").read_text()
        step = workflow.split("- name: Run report and issue-sync unit tests", 1)[1].split("\n      - ", 1)[0]
        self.assertIn("test_nightly_report.py", step)
        self.assertNotIn("test_*.py", step)

    # case: S-261.3
    def test_nightly_report_consumes_validated_full_coverage_from_reusable_producer(self):
        root = Path(__file__).resolve().parents[2]
        nightly = (root / ".github/workflows/nightly-user-journey.yml").read_text()
        reusable = (root / ".github/workflows/reusable-installer-journey.yml").read_text()
        report = nightly.split("  report:", 1)[1]
        producer = reusable.split("  coverage:", 1)[1].split("  evidence_diagnostic:", 1)[0]
        self.assertIn("name: installer-case-coverage", report)
        self.assertNotIn("kb-devkit run build", report)
        self.assertNotIn("qa coverage show", report)
        self.assertIn("!cancelled() && needs.prepare.result == 'success'", producer)
        self.assertIn("qa coverage show --level all", producer)
        self.assertIn("kb.qa-case-coverage/v1", producer)
        self.assertIn(".mode == $mode and (.releasePassed | type) == \"boolean\"", producer)
        self.assertIn("if: always()\n        with:\n          name: installer-case-coverage", producer)
        self.assertIn("jq -e '.releasePassed == true'", producer)

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

