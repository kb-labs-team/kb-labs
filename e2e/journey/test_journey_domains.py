from __future__ import annotations

import unittest

from journey_domains import JourneyDomain, JourneyDomainRegistry
from journey_selection import JourneySelection
from runner import workflow_journey_domain
from service_steps import FlowGraph, Journey, JourneyContractError


def selection_with_lease(steps: list[dict]) -> JourneySelection:
    return JourneySelection(
        requested=(), claims=frozenset(), owning_steps={}, prerequisite_steps=frozenset(),
        prerequisite_flows=frozenset(), capabilities=frozenset(),
        runner_selector="service-local:explore", requested_runners="",
        execution_lease={"mode": "local", "steps": steps,
                         "directStepIds": [step["id"] for step in steps if step["direct"]]},
    )


class JourneyDomainRegistryTests(unittest.TestCase):
    # case: S-262.20
    def test_workflow_domain_matches_the_existing_full_route_identity(self):
        workflow_claims = ([f"S-002.{step}" for step in range(1, 7)]
                           + [f"S-008.{step}" for step in range(1, 5)]
                           + [f"S-027.{step}" for step in range(1, 4)]
                           + [f"S-028.{step}" for step in range(1, 4)]
                           + [f"S-143.{step}" for step in range(1, 5)])

        domain = workflow_journey_domain(workflow_claims)

        self.assertEqual(domain.id, "workflow-execution")
        self.assertEqual(domain.owner_name, "workflow execution journey")
        self.assertEqual(domain.group, "workflow")
        self.assertEqual(domain.capability, "workflow")
        self.assertEqual(domain.cases, tuple([*workflow_claims, "S-007.5"]))
        self.assertEqual(domain.runners, ("service-local:explore", "service-secured:explore"))

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
        lease_step = {"id": "flow:other", "kind": "flow", "name": "other flow", "direct": True}
        graph = FlowGraph(Journey("local", "domain-lease-missing",
                                  selection=selection_with_lease([lease_step])), {})
        events: list[str] = []

        with self.assertRaisesRegex(JourneyContractError, "does not select atomic domain"):
            registry.run(graph, domain.id, lambda: events.append("callback"),
                         setup=lambda: events.append("setup"))

        self.assertEqual(events, [])

    # case: S-262.20
    def test_lease_with_an_unrelated_direct_owner_is_rejected_before_callback(self):
        registry = JourneyDomainRegistry()
        domain = JourneyDomain("workflow-execution", "workflow execution journey", "workflow",
                               "workflow", ("S-002.1",), ("service-local:explore",))
        registry.register(domain)
        direct_flow = {"id": "flow:workflow execution journey", "kind": "flow",
                       "name": domain.owner_name, "direct": True}
        foreign = {"id": "step:foreign", "kind": "step", "name": "foreign", "direct": True}
        graph = FlowGraph(Journey("local", "domain-lease-foreign",
                                  selection=selection_with_lease([direct_flow, foreign])), {})
        calls: list[str] = []

        with self.assertRaisesRegex(JourneyContractError, "only the atomic direct owner"):
            registry.run(graph, domain.id, lambda: calls.append("callback"))

        self.assertEqual(calls, [])

    # case: S-262.20
    def test_cleanup_runs_after_callback_failure_and_domain_stays_atomic(self):
        registry = JourneyDomainRegistry()
        domain = JourneyDomain("workflow-execution", "workflow execution journey", "workflow",
                               "workflow", ("S-002.1",), ("service-local:explore",))
        registry.register(domain)
        direct = {"id": "flow:workflow execution journey", "kind": "flow",
                  "name": domain.owner_name, "direct": True}
        graph = FlowGraph(Journey("local", "domain-lease-valid",
                                  selection=selection_with_lease([direct])), {})
        events: list[str] = []

        status = registry.run(
            graph, domain.id,
            lambda: (events.append("callback"), (_ for _ in ()).throw(RuntimeError("case failed")))[1],
            setup=lambda: events.append("setup"), cleanup=lambda: events.append("cleanup"),
        )

        self.assertEqual(status, "FAIL")
        self.assertEqual(events, ["setup", "callback", "cleanup"])
        self.assertEqual([row.name for row in graph.journey.steps], [domain.owner_name])
        self.assertEqual(graph.journey.steps[0].status, "FAIL")

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
