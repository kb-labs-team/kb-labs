import json
import tempfile
import unittest
from pathlib import Path

from pr_delta import check_pr, plan_claims


class PullRequestDeltaTests(unittest.TestCase):
    # case: S-262.21
    def test_selects_bounded_product_scope_from_paths(self):
        self.assertEqual(plan_claims(["docs/plans/changes.md", "e2e/journey/test_pr_delta.py"]), [])
        self.assertEqual(plan_claims(["e2e/journey/marketplace_steps.py", "docs/guide.md"]),
                         ["S-010.1", "S-010.8", "S-012.1"])
        self.assertIn("S-160.5", plan_claims(["e2e/journey/plugin_author_steps.py"]))
        self.assertEqual(plan_claims(["tools/kb-devkit/internal/engine/executor.go"]), [])
        self.assertIn("PC-001.2", plan_claims(["tools/kb-devkit/internal/engine/executor.go", "tools/kb-create/main.go"]))
        self.assertIn("PC-001.2", plan_claims(["core/runtime/src/main.ts"]))
        self.assertTrue(plan_claims(["services/new-service/src/main.ts"]))

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
                    summary, passed = check_pr(base, candidate, "a" * 40, "b" * 40, ["S-010.1"])
                    self.assertEqual(passed, expected, summary)
                    self.assertIn("secured / S-010.1 / install" if expected else "missing evidence", summary)

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
