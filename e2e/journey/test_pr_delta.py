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

    def write_mode(self, root, sha, local_status, secured_status):
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
            for name, value in values.items():
                (directory / name).write_text(json.dumps(value), encoding="utf-8")
