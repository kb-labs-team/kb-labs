import json
import tempfile
import unittest
from pathlib import Path

from pr_delta import check_pr, plan_claims, without_devkit_coverage_tasks


class PullRequestDeltaTests(unittest.TestCase):
    # case: S-262.21
    def test_selects_bounded_product_scope_from_paths(self):
        self.assertEqual(plan_claims(["docs/plans/changes.md", "e2e/journey/test_pr_delta.py"]), [])
        self.assertEqual(plan_claims(["e2e/journey/marketplace_steps.py", "docs/guide.md"]),
                         ["S-010.1", "S-010.8", "S-012.1"])
        self.assertIn("S-160.5", plan_claims(["e2e/journey/plugin_author_steps.py"]))
        self.assertEqual(plan_claims(["services/workflow/daemon/src/api/workflows-api.ts"]),
                         ["S-002.1", "S-006.3", "S-007.1", "S-056.1"])
        self.assertEqual(plan_claims(["tools/kb-devkit/internal/engine/executor.go"]), [])
        self.assertIn("PC-001.2", plan_claims(["tools/kb-devkit/internal/engine/executor.go", "tools/kb-create/main.go"]))
        self.assertEqual(plan_claims(["e2e/docker-compose.platform.yml", "e2e/docker-compose.oauth-ci.yml",
                                     "e2e/platform/entrypoint.sh"]), [])
        self.assertIn("PC-001.2", plan_claims(["e2e/docker-compose.yml", "e2e/journey/docker-compose.yml"]))
        self.assertIn("PC-001.2", plan_claims(["e2e/platform/prepare-release-index.mjs"]))
        self.assertIn("PC-001.2", plan_claims(["core/runtime/src/main.ts"]))
        self.assertTrue(plan_claims(["services/new-service/src/main.ts"]))

    # case: S-262.21
    def test_only_devkit_coverage_tasks_are_outside_installed_scope(self):
        base = (
            "tasks:\n"
            "  build:\n"
            "    - command: build-platform\n\n"
            "  test:coverage:\n"
            "    - command: vitest --coverage\n\n"
            "    - command: go test -coverprofile=coverage.out\n\n"
            "  test:\n"
            "    - command: make test\n\n"
            "coverage:\n"
            "  thresholds: {}\n"
        )
        split = base.replace("    - command: go test", "  test:coverage:go:\n    - command: go test", 1)
        product_config = without_devkit_coverage_tasks(base)
        self.assertEqual(product_config, without_devkit_coverage_tasks(split))
        self.assertNotEqual(product_config, without_devkit_coverage_tasks(split.replace("build-platform", "true")))
        self.assertNotEqual(product_config, without_devkit_coverage_tasks(split.replace("make test", "true")))
        self.assertNotEqual(product_config, without_devkit_coverage_tasks(split.replace("thresholds: {}", "thresholds: null")))
        self.assertEqual(plan_claims(["devkit.yaml"]), ["PC-001.2", "S-002.1", "S-010.1"])

    # case: S-262.23
    def test_shared_compose_selects_installed_claims_but_platform_overlay_is_fixture(self):
        self.assertEqual(plan_claims(["e2e/docker-compose.yml"]), ["PC-001.2", "S-002.1", "S-010.1"])
        self.assertEqual(plan_claims(["e2e/docker-compose.platform.yml"]), [])

    # case: S-262.24
    def test_manual_legacy_specs_do_not_select_installed_claims(self):
        legacy = "e2e/tests/specs/platform/plugins.spec.ts"
        active = "e2e/shared/src/auth.ts"
        self.assertEqual(plan_claims([legacy]), [])
        self.assertEqual(plan_claims(["e2e/_global/ci.zone.json"]), [])
        self.assertTrue(plan_claims([active]))
        self.assertEqual(plan_claims([legacy, active]), plan_claims([active]))

    # case: S-262.21
    def test_requires_real_improvement_and_rejects_regressions_and_missing_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base, candidate = root / "base", root / "candidate"
            self.write_mode(base, "a" * 40, "PASS", "FAIL")
            for local, secured, expected in (("PASS", "PASS", True), ("FAIL", "PASS", False),
                                              ("PASS", "FAIL", False), (None, "PASS", False)):
                with self.subTest(local=local, secured=secured):
                    self.write_mode(candidate, "b" * 40, local, secured)
                    summary, passed = check_pr(base, candidate, "a" * 40, "b" * 40, ["S-010.1"])
                    self.assertEqual(passed, expected, summary)
                    if local == "FAIL":
                        self.assertIn("PASS → FAIL", summary)
            summary, passed = check_pr(base, candidate, "a" * 40, "c" * 40, ["S-010.1"])
            self.assertFalse(passed)
            self.assertIn("commit", summary)

    # case: S-262.21
    def test_explicit_block_for_a_single_owner_can_recover(self):
        with tempfile.TemporaryDirectory() as directory:
            base, candidate = Path(directory) / "base", Path(directory) / "candidate"
            self.write_mode(candidate, "b" * 40, "PASS", "PASS")
            for status, mode, owner_count, row_count, expected in (
                ("BLOCKED", "secured", 1, 1, True), ("PASS", "secured", 1, 1, False),
                ("BLOCKED", "local", 1, 1, False), ("BLOCKED", "secured", 2, 1, False),
                ("BLOCKED", "secured", 1, 0, False), ("BLOCKED", "secured", 1, 2, False),
            ):
                with self.subTest(status=status, mode=mode, owners=owner_count, rows=row_count):
                    self.write_mode(base, "a" * 40, "PASS", "BLOCKED")
                    plan_path = base / "secured" / "selection-plan.json"
                    plan = json.loads(plan_path.read_text())
                    if owner_count == 2:
                        plan["selectedClaimOwners"]["second owner"] = ["S-010.1"]
                    plan_path.write_text(json.dumps(plan))
                    report_path = base / "secured" / "service-secured.json"
                    report = json.loads(report_path.read_text())
                    report["steps"] = [{"name": f"fixture block {i}", "mode": mode, "status": status,
                                        "cases": ["S-010.1"], "message": "required fixture was not ready"}
                                       for i in range(row_count)]
                    report_path.write_text(json.dumps(report))
                    (base / "secured" / "installer-case-secured.json").write_text(json.dumps({
                        "case_run": {"mode": "secured"},
                        "steps": [{"name": "selected step never ran: install (claim S-010.1)",
                                   "capability": "journey.selection", "status": "FAIL", "cases": ["S-010.1"],
                                   "message": "selected step never ran: install (claim S-010.1)"}],
                    }))
                    summary, passed = check_pr(base, candidate, "a" * 40, "b" * 40, ["S-010.1"])
                    self.assertEqual(passed, expected, summary)
                    fragment = "secured / S-010.1 / install" if expected or row_count == 2 else "missing evidence"
                    self.assertIn(fragment, summary)

    # case: S-262.21
    def test_multiple_explicit_blocks_must_stay_identical(self):
        def replace_owner_with_blockers(root, blockers):
            path = root / "local" / "service-local.json"
            report = json.loads(path.read_text())
            report["steps"] = [
                {"name": name, "status": status, "message": reason, "cases": ["S-010.1"]}
                for name, status, reason in blockers
            ]
            path.write_text(json.dumps(report))

        expected_blocks = [
            ("fixture lint", "BLOCKED", "fixture is not installed"),
            ("workflow run", "BLOCKED", "could not read /tmp/kb-journey-home-1_fwdorq/.kb/projects.json"),
        ]
        with tempfile.TemporaryDirectory() as directory:
            base, candidate = Path(directory) / "base", Path(directory) / "candidate"
            self.write_mode(base, "a" * 40, "BLOCKED", "FAIL")
            replace_owner_with_blockers(base, expected_blocks)
            for blocks, expected in (
                (expected_blocks, True),
                ([*expected_blocks[:1], ("workflow run", "BLOCKED",
                                         "could not read /tmp/kb-journey-home-0nt645hm/.kb/projects.json")], True),
                (expected_blocks[1:], False),
                ([*expected_blocks[:1], ("another step", "BLOCKED", "fixture is not installed")], False),
                ([*expected_blocks[:1], ("workflow run", "BLOCKED", "registry is not ready")], False),
                ([*expected_blocks[:1], ("workflow run", "PASS", "passed")], False),
                ([], False),
            ):
                with self.subTest(blocks=blocks):
                    self.write_mode(candidate, "b" * 40, "BLOCKED", "PASS")
                    replace_owner_with_blockers(candidate, blocks)
                    summary, passed = check_pr(base, candidate, "a" * 40, "b" * 40, ["S-010.1"])
                    self.assertEqual(passed, expected, summary)

    # case: S-262.21
    def test_workflow_child_recovery_requires_matching_legacy_runner_and_unchanged_siblings(self):
        owner = "initialize solo project workflow"
        local_report = "installer-case-local-agent-explore-default.json"
        secured_report = "installer-case-secured-human-explore-secured.json"

        def write_workflow_run(root, sha, *, candidate, claim="S-002.1", changed_lint=False,
                               misplaced=False, ambiguous=False):
            for mode, installer in (("local", local_report), ("secured", secured_report)):
                runner = f"service-{mode}:explore"
                directory = root / mode
                directory.mkdir(parents=True, exist_ok=True)
                report_scope = {"mode": mode}
                blockers = [{"name": "workflow fixture lint", "status": "BLOCKED", "cases": [claim],
                             "message": "different cause" if changed_lint else "fixture not installed"}]
                if not candidate:
                    blockers.append({"name": "workflow execution journey", "status": "BLOCKED",
                                     "cases": [claim], "message": "adapter fixture could not read project registry"})
                plan = {"selection": [claim], "steps": [claim], "selectedClaimOwners": {owner: [claim]},
                        "prerequisiteSteps": [], "runners": [runner], "owners": {runner: [claim]}}
                if candidate:
                    plan["selectedOwningStepsByRunner"] = {runner: {owner: [claim]}}
                    if ambiguous:
                        other = f"service-marketplace-registry:{mode}"
                        plan["runners"].append(other)
                        plan["selectedOwningStepsByRunner"][other] = {owner: [claim]}
                reports = {
                    "run.json": {"commit": sha},
                    "batch-metadata.json": {"commit": sha, "mode": mode, "requestedSelection": [claim],
                                            "result": "PASS" if candidate else "FAIL"},
                    "selection-plan.json": plan,
                    installer: {"case_run": report_scope, "steps": blockers},
                }
                if candidate:
                    filename = f"service-auth-{mode}.json" if misplaced else f"service-{mode}.json"
                    reports[filename] = {"case_run": report_scope, "steps": [
                        {"name": owner, "status": "PASS", "cases": [claim], "message": "passed"},
                    ]}
                for name, value in reports.items():
                    (directory / name).write_text(json.dumps(value), encoding="utf-8")

        for claim, changes, expected in (
            ("S-002.1", {}, True),
            ("S-002.1", {"changed_lint": True}, False),
            ("S-002.1", {"misplaced": True}, False),
            ("S-002.1", {"ambiguous": True}, False),
            ("S-010.1", {}, False),
        ):
            with self.subTest(claim=claim, changes=changes), tempfile.TemporaryDirectory() as directory:
                base, candidate = Path(directory) / "base", Path(directory) / "candidate"
                write_workflow_run(base, "a" * 40, candidate=False, claim=claim)
                write_workflow_run(candidate, "b" * 40, candidate=True, claim=claim, **changes)
                summary, passed = check_pr(base, candidate, "a" * 40, "b" * 40, [claim])
                self.assertEqual(passed, expected, summary)

    # case: S-262.21
    def test_passing_added_prerequisite_does_not_count_as_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base, candidate = root / "base", root / "candidate"
            for base_status, prerequisite_status, expected in (
                ("FAIL", "PASS", True), ("PASS", "PASS", False),
                ("FAIL", "FAIL", False), ("FAIL", None, False),
            ):
                with self.subTest(base_status=base_status, prerequisite_status=prerequisite_status):
                    self.write_mode(base, "a" * 40, "PASS", base_status)
                    self.write_mode(candidate, "b" * 40, "PASS", "PASS",
                                    added_prerequisite=("prepare fixture", prerequisite_status))
                    summary, passed = check_pr(base, candidate, "a" * 40, "b" * 40, ["S-010.1"])
                    self.assertEqual(passed, expected, summary)
                    if prerequisite_status == "FAIL":
                        self.assertIn("MISSING → FAIL", summary)
                    if prerequisite_status is None:
                        self.assertIn("missing evidence", summary)
                    if base_status == "PASS":
                        self.assertIn("No demonstrated improvement.", summary)

    def write_mode(self, root, sha, local_status, secured_status, *, added_prerequisite=None):
        for mode, status in (("local", local_status), ("secured", secured_status)):
            directory = root / mode
            directory.mkdir(parents=True, exist_ok=True)
            values = {
                "run.json": {"commit": sha},
                "batch-metadata.json": {"commit": sha, "mode": mode, "requestedSelection": ["S-010.1"],
                                        "result": "PASS" if status == "PASS" else "FAIL"},
                "selection-plan.json": {"selection": ["S-010.1"], "steps": ["S-010.1"],
                                        "selectedClaimOwners": {"install": ["S-010.1"]}, "prerequisiteSteps": [],
                                        "runners": [f"service-{mode}:explore"]},
                f"service-{mode}.json": {
                    "case_run": {"mode": mode, "claims": [] if status is None else
                                 [{"claimId": "S-010.1", "status": status}]},
                    "steps": [] if status is None else [{"name": "install", "status": status,
                                                         "message": "example failure" if status == "FAIL" else "passed",
                                                         "cases": ["S-010.1"]}],
                },
            }
            if mode == "secured" and added_prerequisite:
                name, prerequisite_status = added_prerequisite
                values["selection-plan.json"]["prerequisiteSteps"].append(name)
                if prerequisite_status is not None:
                    values[f"service-{mode}.json"]["steps"].append({
                        "name": name, "status": prerequisite_status, "message": "prerequisite result",
                    })
            for name, value in values.items():
                (directory / name).write_text(json.dumps(value), encoding="utf-8")
