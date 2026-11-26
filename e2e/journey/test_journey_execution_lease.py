from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from journey_selection import JourneySelectionError, read_journey_selection
from service_steps import FlowGraph, Journey


def lease() -> dict:
    return {
        "schema": "kb.devkit-journey-shard-lease/v1", "planId": "journey-plan", "runId": "run-1",
        "sourceSHA": "a" * 40, "shardId": "local-01", "attemptId": "attempt-1",
        "mode": "local", "runner": "service-local:explore", "claimIds": ["S-001.1"],
        "directStepIds": ["service-local:explore|flow:setup", "service-local:explore|step:setup"],
        "directStepNames": ["setup", "setup"], "selectedStepNames": ["setup", "setup", "prerequisite"],
        "steps": [
            {"id": "service-local:explore|step:setup", "name": "setup", "kind": "step",
             "claimIds": ["S-001.1"], "direct": True},
            {"id": "service-local:explore|flow:setup", "name": "setup", "kind": "flow",
             "claimIds": [], "direct": True},
            {"id": "service-local:explore|step:prerequisite", "name": "prerequisite", "kind": "step",
             "claimIds": [], "states": ["host-running"], "direct": False},
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
        self.assertEqual(selection.direct_step_names, ("setup", "setup"))
        self.assertEqual(selection.prerequisite_steps, {"prerequisite"})
        self.assertEqual(selection.runner_selector, "service-local:explore")
        journey = Journey("local", "lease-run", selection=selection)
        journey.step("setup", "install", lambda: None, cases=["S-001.1"])
        outside = journey.step("same claim, unplanned owner", "install", lambda: None, cases=["S-001.1"])
        self.assertEqual(outside.status, "SKIPPED")
        journey.record_flow("setup", "PASS")
        journey.step("prerequisite", "install", lambda: None)
        probe = journey.step("state probe: host-running", "journey.state", lambda: None, role="lifecycle")
        self.assertEqual(probe.status, "PASS")
        receipt = journey.result().execution
        self.assertEqual(receipt["attemptId"], "attempt-1")
        self.assertEqual(receipt["runId"], "run-1")
        self.assertEqual(receipt["directStepIds"], ["service-local:explore|flow:setup",
                                                     "service-local:explore|step:setup"])
        self.assertEqual(receipt["requiredStates"], ["host-running"])
        rows = journey.result().steps
        self.assertEqual([(row["plannedStepId"], row["plannedDirect"]) for row in rows if "plannedStepId" in row], [
            ("service-local:explore|step:setup", True),
            ("service-local:explore|step:prerequisite", False),
        ])
        state_probe = next(row for row in rows if row["name"] == "state probe: host-running")
        self.assertEqual(state_probe["details"]["selectionRole"], "lifecycle")
        self.assertEqual(journey.result().flows[0]["plannedStepId"], "service-local:explore|flow:setup")

    def test_flow_graph_fallback_row_cannot_claim_same_named_step(self):
        selection = read_journey_selection({
            "KB_JOURNEY_EXECUTION_LEASE_JSON": json.dumps(lease()),
            "KB_JOURNEY_ONLY": "service-local:explore",
            "KB_JOURNEY_RUNNER_SELECTOR": "service-local:explore",
        }, strict=True)
        journey = Journey("local", "lease-run", selection=selection)
        graph = FlowGraph(journey, {})
        called = []
        self.assertEqual(graph.flow("setup", "setup", "install", lambda: called.append(True)), "PASS")
        self.assertEqual(called, [True])
        report = journey.result()
        self.assertFalse(any(row.get("plannedStepId") == "service-local:explore|step:setup"
                             for row in report.steps))
        self.assertEqual(report.flows[0]["plannedStepId"], "service-local:explore|flow:setup")

    def test_selected_child_owner_activates_its_enclosing_group_flow(self):
        payload = lease()
        payload["steps"][0]["capabilities"] = ["gateway"]
        selection = read_journey_selection({
            "KB_JOURNEY_EXECUTION_LEASE_JSON": json.dumps(payload),
            "KB_JOURNEY_ONLY": "service-local:explore",
            "KB_JOURNEY_RUNNER_SELECTOR": "service-local:explore",
        }, strict=True)
        journey = Journey("local", "lease-run", selection=selection)
        graph = FlowGraph(journey, {}, groups={"gateway": {
            "capabilities": {"gateway"}, "depends_on": (), "steps": ()}})
        child_called = []

        def selected_child():
            journey.step("setup", "install", lambda: child_called.append(True), cases=["S-001.1"])

        self.assertEqual(graph.flow("container", "gateway", "gateway", selected_child), "PASS")
        self.assertEqual(child_called, [True])
        self.assertTrue(any(row.get("plannedStepId") == "service-local:explore|step:setup"
                            for row in journey.result().steps))

    def test_unowned_enclosing_flow_failures_cannot_be_filtered_by_lease(self):
        for failure in ("raised", "returned"):
            with self.subTest(failure=failure):
                payload = lease()
                payload["steps"][0]["capabilities"] = ["gateway"]
                selection = read_journey_selection({
                    "KB_JOURNEY_EXECUTION_LEASE_JSON": json.dumps(payload),
                    "KB_JOURNEY_ONLY": "service-local:explore",
                    "KB_JOURNEY_RUNNER_SELECTOR": "service-local:explore",
                }, strict=True)
                journey = Journey("local", "lease-run", selection=selection)
                graph = FlowGraph(journey, {}, groups={"gateway": {
                    "capabilities": {"gateway"}, "depends_on": (), "steps": ()}})

                def failing_child():
                    journey.step("setup", "install", lambda: None, cases=["S-001.1"])
                    if failure == "raised":
                        raise RuntimeError("setup finalization failed")
                    return "setup finalization failed"

                self.assertEqual(graph.flow("container", "gateway", "gateway", failing_child), "FAIL")
                report = journey.result()
                self.assertEqual(report.status, "FAIL")
                self.assertEqual(report.first_failure["message"], "setup finalization failed")

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
