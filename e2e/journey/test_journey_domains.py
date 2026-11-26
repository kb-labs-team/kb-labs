from __future__ import annotations

import unittest
import json
from unittest.mock import patch

from journey_domains import (JourneyDomain, JourneyDomainRegistry,
                             service_journey_domain_registry)
from journey_selection import JourneySelection, read_journey_selection
from service_steps import FlowGraph, Journey, JourneyContractError
import runner


def selection_with_lease(steps: list[dict]) -> JourneySelection:
    claim_ids = sorted({claim for step in steps if step["direct"]
                        for claim in step.get("claimIds", [])})
    return JourneySelection(
        requested=tuple(claim_ids), claims=frozenset(claim_ids),
        owning_steps={step["name"]: tuple(step.get("claimIds", [])) for step in steps
                      if step["direct"] and step.get("claimIds")}, prerequisite_steps=frozenset(),
        prerequisite_flows=frozenset(), capabilities=frozenset(),
        runner_selector="service-local:explore", requested_runners="",
        execution_lease={"mode": "local", "claimIds": claim_ids, "steps": steps,
                         "directStepIds": [step["id"] for step in steps if step["direct"]]},
    )


def strict_workflow_selection(selector: str = "service-local:explore",
                              claims: tuple[str, ...] | None = None) -> JourneySelection:
    owner_name = "workflow execution journey"
    owner_id = f"{selector}|flow:{owner_name}"
    required_claims = claims
    if required_claims is None:
        mode = "secured" if selector == "service-secured:explore" else "local"
        required_claims = service_journey_domain_registry(mode=mode).get("workflow-execution").required_claims
    lease = {
        "schema": "kb.devkit-journey-shard-lease/v1", "planId": "plan", "runId": "run",
        "sourceSHA": "a" * 40, "shardId": "local-01", "attemptId": "attempt-1",
        "mode": "local", "runner": selector, "claimIds": list(required_claims),
        "directStepIds": [owner_id], "directStepNames": [owner_name],
        "selectedStepNames": ["workflow fixture lint", owner_name],
        "steps": [
            {"id": f"{selector}|flow:workflow fixture lint", "name": "workflow fixture lint",
             "kind": "flow", "claimIds": [], "capabilities": ["workflow"], "states": [],
             "direct": False},
            {"id": owner_id, "name": owner_name, "kind": "flow",
             "claimIds": list(required_claims), "capabilities": ["workflow"], "states": [],
             "direct": True},
        ],
    }
    return read_journey_selection({
        "KB_JOURNEY_EXECUTION_LEASE_JSON": json.dumps(lease),
        "KB_JOURNEY_ONLY": selector,
        "KB_JOURNEY_RUNNER_SELECTOR": selector,
    }, strict=True)


def outer_with_workflow_prerequisite(selection: JourneySelection, run_id: str) -> Journey:
    journey = Journey("local", run_id, selection=selection)
    journey.record_flow("workflow fixture lint", "PASS")
    return journey


def full_service_selection() -> JourneySelection:
    return JourneySelection(
        requested=(), claims=frozenset(), owning_steps={}, prerequisite_steps=frozenset(),
        prerequisite_flows=frozenset(), capabilities=frozenset(),
        runner_selector="service-local:explore", requested_runners="",
    )


class JourneyDomainRegistryTests(unittest.TestCase):
    # case: S-262.20
    def test_workflow_domain_matches_the_existing_full_route_identity(self):
        registry = service_journey_domain_registry()
        domain = registry.get("workflow-execution")
        self.assertIsNotNone(domain)

        self.assertEqual(domain.id, "workflow-execution")
        self.assertEqual(domain.owner_name, "workflow execution journey")
        self.assertEqual(domain.group, "workflow")
        self.assertEqual(domain.capability, "workflow")
        self.assertIn("S-006.3", domain.cases)
        self.assertIn("S-044.9", domain.cases)
        self.assertIn("S-041.17", domain.cases)
        self.assertNotIn("S-041.7", domain.cases)
        self.assertEqual(domain.runners, ("service-local:explore", "service-secured:explore"))
        runtime_domain = service_journey_domain_registry(mode="local").get("workflow-execution")
        self.assertIn("S-002.1", runtime_domain.required_claims)
        self.assertIn("S-041.17", service_journey_domain_registry(mode="secured")
                      .get("workflow-execution").required_claims)

    # case: S-262.20
    def test_full_route_runs_one_callback_with_common_setup_and_cleanup(self):
        registry = JourneyDomainRegistry()
        domain = JourneyDomain("workflow-execution", "workflow execution journey", "workflow",
                               "workflow", ("S-002.1",), ("service-local:explore",))
        registry.register(domain)
        graph = FlowGraph(Journey("local", "domain-full"), {})
        events: list[str] = []

        status = registry.run(graph, domain.id, lambda: events.append("callback"),
                              setup=lambda: events.append("setup"),
                              cleanup=lambda: events.append("cleanup"))

        self.assertEqual(status, "PASS")
        self.assertEqual(events, ["setup", "callback", "cleanup"])
        self.assertEqual(graph.journey.flow_events[-1]["name"], domain.owner_name)

    # case: S-262.20
    def test_lease_requires_exact_direct_flow_owner_before_setup_or_callback(self):
        registry = JourneyDomainRegistry()
        domain = JourneyDomain("workflow-execution", "workflow execution journey", "workflow",
                               "workflow", ("S-002.1",), ("service-local:explore",))
        registry.register(domain)
        lease_step = {"id": "service-local:explore|flow:other", "kind": "flow",
                      "name": "other flow", "claimIds": ["S-002.1"], "direct": True}
        graph = FlowGraph(Journey("local", "domain-lease-missing",
                                  selection=selection_with_lease([lease_step])), {})
        events: list[str] = []

        with self.assertRaisesRegex(JourneyContractError, "does not select atomic domain"):
            registry.run(graph, domain.id, lambda: events.append("callback"),
                         setup=lambda: events.append("setup"))

        self.assertEqual(events, [])

    # case: S-262.20
    def test_lease_with_foreign_claim_on_domain_owner_is_rejected_before_callback(self):
        registry = JourneyDomainRegistry()
        domain = JourneyDomain("workflow-execution", "workflow execution journey", "workflow",
                               "workflow", ("S-002.1",), ("service-local:explore",))
        registry.register(domain)
        direct_flow = {"id": "service-local:explore|flow:workflow execution journey", "kind": "flow",
                       "name": domain.owner_name, "claimIds": ["S-002.1", "S-999.1"], "direct": True}
        graph = FlowGraph(Journey("local", "domain-lease-foreign",
                                  selection=selection_with_lease([direct_flow])), {})
        calls: list[str] = []

        with self.assertRaisesRegex(JourneyContractError, "claims do not match"):
            registry.run(graph, domain.id, lambda: calls.append("callback"))

        self.assertEqual(calls, [])

    # case: S-262.20
    def test_cleanup_runs_after_callback_failure_and_domain_stays_atomic(self):
        registry = JourneyDomainRegistry()
        domain = JourneyDomain("workflow-execution", "workflow execution journey", "workflow",
                               "workflow", ("S-002.1",), ("service-local:explore",))
        registry.register(domain)
        direct = {"id": "service-local:explore|flow:workflow execution journey", "kind": "flow",
                  "name": domain.owner_name, "claimIds": ["S-002.1"], "direct": True}
        graph = FlowGraph(Journey("local", "domain-lease-valid",
                                  selection=selection_with_lease([direct])), {})
        events: list[str] = []

        status = registry.run(
            graph, domain.id,
            lambda: self._raise_after_callback(events),
            setup=lambda: events.append("setup"), cleanup=lambda: events.append("cleanup"),
        )

        self.assertEqual(status, "FAIL")
        self.assertEqual(events, ["setup", "callback", "cleanup"])
        self.assertEqual([row.name for row in graph.journey.steps], [domain.owner_name])
        self.assertEqual(graph.journey.steps[0].status, "FAIL")

    @staticmethod
    def _raise_after_callback(events: list[str]):
        events.append("callback")
        raise RuntimeError("case failed")

    # case: S-262.20
    def test_strict_lease_runs_real_child_assertion_without_step_filtering(self):
        registry = service_journey_domain_registry(mode="local")
        domain = registry.get("workflow-execution")
        selection = strict_workflow_selection()
        outer = outer_with_workflow_prerequisite(selection, "domain-strict-lease")
        graph = FlowGraph(outer, {})
        executed: list[str] = []

        def run_child():
            child = Journey("local", "workflow-child", selection=domain.child_selection(selection))
            for claim in domain.required_claims:
                result = child.step(f"real workflow assertion {claim}", "workflow",
                                    lambda claim=claim: executed.append(claim), cases=[claim])
                self.assertEqual(result.status, "PASS")
            self.assertFalse(child.selection_boundary.active)
            return child

        status = registry.run(graph, domain.id, run_child, expected_claims=domain.required_claims)

        self.assertEqual(status, "PASS")
        self.assertEqual(executed, list(domain.required_claims))
        self.assertEqual(graph.journey.flow_events[-1]["status"], "PASS")

    # case: S-262.20
    def test_unsharded_production_domain_runs_catalogued_children_and_real_host_boundary(self):
        registry = service_journey_domain_registry(mode="local")
        domain = registry.get("workflow-execution")
        outer = outer_with_workflow_prerequisite(full_service_selection(), "domain-full-production")
        graph = FlowGraph(outer, {})
        executed: list[str] = []
        child = Journey("local", "workflow-child-full", selection=domain.child_selection(
            outer.selection_boundary))
        for claim in domain.required_claims:
            child.step(f"workflow assertion {claim}", "workflow",
                       lambda claim=claim: executed.append(claim), cases=[claim])

        with patch.object(runner, "probe_platform_state") as host_cleanup:
            status = registry.run(
                graph, domain.id,
                lambda: runner.run_workflow_with_host_boundary(
                    graph, env={}, launcher="kb-create", action=lambda: child),
                expected_claims=domain.required_claims,
            )

        self.assertEqual(status, "PASS")
        self.assertEqual(executed, list(domain.required_claims))
        host_cleanup.assert_called_once()
        self.assertEqual(host_cleanup.call_args.kwargs["mutator_group"], "workflow")

    # case: S-262.20
    def test_unrelated_legacy_selection_skips_domain_before_prerequisite_validation(self):
        registry = service_journey_domain_registry(mode="local")
        domain = registry.get("workflow-execution")
        selection = JourneySelection(
            requested=("S-041.1",), claims=frozenset({"S-041.1"}), owning_steps={},
            prerequisite_steps=frozenset(), prerequisite_flows=frozenset(), capabilities=frozenset(),
            runner_selector="service-local:explore", requested_runners="",
        )
        graph = FlowGraph(Journey("local", "domain-unrelated-case", selection=selection), {})
        calls: list[str] = []

        status = registry.run(graph, domain.id, lambda: calls.append("callback"),
                              expected_claims=domain.required_claims)

        self.assertEqual(status, "SKIPPED")
        self.assertEqual(calls, [])

    # case: S-262.20
    def test_domain_rejects_pass_child_with_missing_claim_evidence(self):
        registry = service_journey_domain_registry(mode="local")
        domain = registry.get("workflow-execution")
        selection = strict_workflow_selection()
        graph = FlowGraph(outer_with_workflow_prerequisite(selection, "domain-missing-child-evidence"), {})

        status = registry.run(
            graph, domain.id,
            lambda: Journey("local", "workflow-child-empty",
                            selection=domain.child_selection(selection)),
            expected_claims=domain.required_claims,
        )

        self.assertEqual(status, "FAIL")
        self.assertIn("lacks PASS child evidence", graph.journey.steps[-1].message)

    # case: S-262.20
    def test_domain_rejects_foreign_runner_before_callback(self):
        registry = service_journey_domain_registry(mode="local")
        domain = registry.get("workflow-execution")
        selection = strict_workflow_selection("agent:commit")
        graph = FlowGraph(outer_with_workflow_prerequisite(selection, "domain-foreign-runner"), {})
        calls: list[str] = []

        with self.assertRaisesRegex(JourneyContractError, "not authorized"):
            registry.run(graph, domain.id, lambda: calls.append("callback"),
                         expected_claims=domain.required_claims)

        self.assertEqual(calls, [])

    # case: S-262.20
    def test_empty_lease_claims_cannot_self_validate_a_required_domain(self):
        registry = service_journey_domain_registry(mode="local")
        domain = registry.get("workflow-execution")
        selection = strict_workflow_selection(claims=())
        graph = FlowGraph(outer_with_workflow_prerequisite(selection, "domain-empty-claims"), {})
        calls: list[str] = []

        with self.assertRaisesRegex(JourneyContractError, "independent domain inventory"):
            registry.run(graph, domain.id, lambda: calls.append("callback"),
                         expected_claims=domain.required_claims)

        self.assertEqual(calls, [])

    # case: S-262.20
    def test_registry_rejects_duplicate_and_unknown_domains(self):
        registry = JourneyDomainRegistry()
        domain = JourneyDomain("workflow-execution", "workflow execution journey", "workflow",
                               "workflow", ("S-002.1",), ("service-local:explore",))
        registry.register(domain)
        with self.assertRaisesRegex(JourneyContractError, "duplicate journey domain"):
            registry.register(domain)
        with self.assertRaisesRegex(JourneyContractError, "unknown journey domain"):
            registry.run(FlowGraph(Journey("local", "domain-unknown"), {}), "missing", lambda: None)


if __name__ == "__main__":
    unittest.main()
