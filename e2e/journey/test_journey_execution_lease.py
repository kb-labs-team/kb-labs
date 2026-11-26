from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from journey_selection import JourneySelectionError, read_journey_selection
from service_steps import Journey


def lease() -> dict:
    return {
        "schema": "kb.devkit-journey-shard-lease/v1", "planId": "journey-plan",
        "sourceSHA": "a" * 40, "shardId": "local-01", "attemptId": "attempt-1",
        "mode": "local", "runner": "service-local:explore", "claimIds": ["S-001.1"],
        "directStepIds": ["service-local:explore|step:setup"],
        "directStepNames": ["setup"], "selectedStepNames": ["setup", "prerequisite"],
        "steps": [
            {"id": "service-local:explore|step:setup", "name": "setup", "kind": "step",
             "claimIds": ["S-001.1"], "direct": True},
            {"id": "service-local:explore|step:prerequisite", "name": "prerequisite", "kind": "step",
             "claimIds": [], "direct": False},
        ],
    }


class JourneyExecutionLeaseTests(unittest.TestCase):
    def test_lease_drives_exact_runner_selection_and_report_receipt(self):
        selection = read_journey_selection({
            "KB_JOURNEY_EXECUTION_LEASE_JSON": json.dumps(lease()),
            "KB_JOURNEY_ONLY": "service-local:explore",
            "KB_JOURNEY_RUNNER_SELECTOR": "service-local:explore",
        }, strict=True)
        self.assertEqual(selection.claims, {"S-001.1"})
        self.assertEqual(selection.direct_step_names, ("setup",))
        self.assertEqual(selection.prerequisite_steps, {"prerequisite"})
        self.assertEqual(selection.runner_selector, "service-local:explore")
        journey = Journey("local", "lease-run", selection=selection)
        journey.step("setup", "install", lambda: None, cases=["S-001.1"])
        journey.step("prerequisite", "install", lambda: None)
        receipt = journey.result().execution
        self.assertEqual(receipt["attemptId"], "attempt-1")
        self.assertEqual(receipt["directStepIds"], ["service-local:explore|step:setup"])
        rows = journey.result().steps
        self.assertEqual([(row["plannedStepId"], row["plannedDirect"]) for row in rows], [
            ("service-local:explore|step:setup", True),
            ("service-local:explore|step:prerequisite", False),
        ])

    def test_lease_rejects_foreign_runner_mode_and_incomplete_selected_inventory(self):
        with self.assertRaisesRegex(JourneySelectionError, "selector does not match"):
            read_journey_selection({"KB_JOURNEY_EXECUTION_LEASE_JSON": json.dumps(lease()),
                                    "KB_JOURNEY_ONLY": "service-secured:explore"}, strict=True)
        invalid = lease()
        invalid["selectedStepNames"] = ["setup"]
        with self.assertRaisesRegex(JourneySelectionError, "step names do not match"):
            read_journey_selection({"KB_JOURNEY_EXECUTION_LEASE_JSON": json.dumps(invalid)}, strict=True)
        selection = read_journey_selection({"KB_JOURNEY_EXECUTION_LEASE_JSON": json.dumps(lease())})
        with self.assertRaisesRegex(RuntimeError, "does not match runner mode"):
            Journey("secured", "wrong-mode", selection=selection)


if __name__ == "__main__":
    unittest.main()
