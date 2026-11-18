#!/usr/bin/env python3
"""Behavioral tests for selected-case evidence verdicts."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from reuse_case_verdict import verify_case_reports


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


if __name__ == "__main__":
    unittest.main()
