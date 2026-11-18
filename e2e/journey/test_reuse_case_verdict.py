#!/usr/bin/env python3
"""Behavioral tests for selected-case evidence verdicts."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from reuse_case_verdict import select_case_from_workspace, verify_case_reports

REPO = Path(__file__).resolve().parents[2]


class ReuseCaseVerdictTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.metadata = {"result": "PASS"}

    def tearDown(self) -> None:
        self.temp.cleanup()

    def report(self, name: str, *, mode: str, selection: list[str], claims: list[dict]) -> None:
        (self.root / name).write_text(json.dumps({"case_run": {
            "mode": mode, "selection": selection, "claims": claims,
        }}), encoding="utf-8")

    def test_whole_case_uses_original_selection_and_expanded_claims(self) -> None:
        selected = {"selection": ["S-001"], "steps": ["S-001.1", "S-001.2"]}
        self.report("one.json", mode="local", selection=["S-001"], claims=[
            {"claimId": "S-001.1", "status": "PASS"},
        ])
        self.report("two.json", mode="local", selection=["S-001"], claims=[
            {"claimId": "S-001.2", "status": "PASS"},
        ])
        verify_case_reports(self.root, "local", selected, self.metadata)

    def test_one_selected_step_passes(self) -> None:
        selected = {"selection": ["S-001.2"], "steps": ["S-001.2"]}
        self.report("step.json", mode="local", selection=["S-001.2"], claims=[
            {"claimId": "S-001.2", "status": "PASS"},
        ])
        verify_case_reports(self.root, "local", selected, self.metadata)

    def test_failed_or_missing_claim_fails(self) -> None:
        selected = {"selection": ["S-001"], "steps": ["S-001.1", "S-001.2"]}
        self.report("partial.json", mode="local", selection=["S-001"], claims=[
            {"claimId": "S-001.1", "status": "PASS"},
            {"claimId": "S-001.2", "status": "FAIL"},
        ])
        with self.assertRaisesRegex(ValueError, "failed=.*S-001.2"):
            verify_case_reports(self.root, "local", selected, self.metadata)

    def test_other_selection_and_mode_do_not_supply_evidence(self) -> None:
        selected = {"selection": ["S-001"], "steps": ["S-001.1"]}
        self.report("other-case.json", mode="local", selection=["S-002"], claims=[
            {"claimId": "S-001.1", "status": "PASS"},
        ])
        self.report("other-mode.json", mode="secured", selection=["S-001"], claims=[
            {"claimId": "S-001.1", "status": "PASS"},
        ])
        with self.assertRaisesRegex(ValueError, "missing=.*S-001.1"):
            verify_case_reports(self.root, "local", selected, self.metadata)

    def test_non_passing_mode_metadata_fails(self) -> None:
        selected = {"selection": ["S-001.1"], "steps": ["S-001.1"]}
        with self.assertRaisesRegex(ValueError, "mode did not pass"):
            verify_case_reports(self.root, "secured", selected, {"result": "FAIL"})

    def test_missing_candidate_config_build_output_fails_before_catalog_selection(self) -> None:
        (self.root / "cli/bin/dist").mkdir(parents=True)
        (self.root / "cli/bin/dist/bin.js").touch()
        with self.assertRaisesRegex(ValueError, "core/config/dist/index.js.*@kb-labs/core-config build"):
            select_case_from_workspace(self.root, "S-001.1", "local")

    def test_verifier_imports_case_selection_from_candidate_checkout(self) -> None:
        workspace = self.root / "candidate"
        (workspace / "core/config/dist").mkdir(parents=True)
        (workspace / "core/config/dist/index.js").touch()
        (workspace / "cli/bin/dist").mkdir(parents=True)
        (workspace / "cli/bin/dist/bin.js").touch()
        journey = workspace / "e2e/journey"
        journey.mkdir(parents=True)
        (journey / "select_from_cases.py").write_text(
            "from pathlib import Path\n"
            "assert Path(__file__).resolve().parents[2].name == 'candidate'\n"
            "def coverage_results(): return []\n"
            "def selection_from_coverage(*args, **kwargs):\n"
            "    return {'selection': ['S-001.1'], 'steps': ['S-001.1']}\n",
            encoding="utf-8",
        )
        reports = self.root / "reports"
        reports.mkdir()
        (reports / "batch-metadata.json").write_text('{"result":"PASS"}\n', encoding="utf-8")
        self.report("unused.json", mode="local", selection=["S-001.1"], claims=[
            {"claimId": "S-001.1", "status": "PASS"},
        ])
        # The actual CLI resolves report paths under reports_root.
        (reports / "pass.json").write_text(json.dumps({"case_run": {
            "mode": "local", "selection": ["S-001.1"],
            "claims": [{"claimId": "S-001.1", "status": "PASS"}],
        }}), encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(REPO / "e2e/journey/reuse_case_verdict.py"),
             "local", "S-001.1", str(reports), str(workspace)],
            cwd=workspace, text=True, capture_output=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
