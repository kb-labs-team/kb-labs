"""Declarative, atomic callbacks dispatched by the service journey runner."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from journey_selection import JourneySelection
from journey_dependencies import Dependency
from service_steps import FlowGraph, Journey, JourneyContractError


@dataclass(frozen=True)
class JourneyDomain:
    """One real runner callback, kept atomic when selected by a shard lease."""

    id: str
    owner_name: str
    group: str
    capability: str
    cases: tuple[str, ...]
    runners: tuple[str, ...]
    required_claims: tuple[str, ...] = ()
    requires: tuple[str, ...] = ()
    runner_modes: tuple[tuple[str, str], ...] = ()
    implementation_sources: tuple[str, ...] = ()
    child_result_required: bool = False
    position_after: str = ""

    def child_selection(self, parent: JourneySelection) -> JourneySelection:
        """Let an atomic lease run its internal assertions without owner filtering."""
        if parent.execution_lease is None:
            return parent
        return JourneySelection(
            requested=(), claims=frozenset(), owning_steps={}, prerequisite_steps=frozenset(),
            prerequisite_flows=frozenset(), capabilities=frozenset(),
            runner_selector=parent.runner_selector, requested_runners=parent.requested_runners,
        )


class JourneyDomainRegistry:
    """Registry whose entries are invoked by both full and lease-backed runs."""

    def __init__(self) -> None:
        self._domains: dict[str, JourneyDomain] = {}

    def register(self, domain: JourneyDomain) -> None:
        if not domain.id or not domain.owner_name or not domain.cases:
            raise JourneyContractError("journey domain requires an id, owner, and case claims")
        if domain.id in self._domains:
            raise JourneyContractError(f"duplicate journey domain id {domain.id!r}")
        self._domains[domain.id] = domain

    def domains_for_runner(self, selector: str) -> tuple[JourneyDomain, ...]:
        return tuple(domain for domain in self._domains.values() if selector in domain.runners)

    def get(self, domain_id: str) -> JourneyDomain | None:
        return self._domains.get(domain_id)

    def run(self, graph: FlowGraph, domain_id: str, action: Callable[[], object], *,
            setup: Callable[[], None] | None = None,
            cleanup: Callable[[], None] | None = None,
            expected_claims: tuple[str, ...] | None = None) -> str:
        domain = self._domains.get(domain_id)
        if domain is None:
            raise JourneyContractError(f"unknown journey domain {domain_id!r}")
        if expected_claims is None and domain.required_claims:
            expected_claims = domain.required_claims
        if domain.child_result_required and expected_claims is None:
            raise JourneyContractError(
                f"journey domain {domain.id!r} requires an independent expected-claim inventory")

        lease = graph.journey.selection_boundary.execution_lease
        if lease is not None:
            selector = graph.journey.runner_selector
            if selector not in domain.runners:
                raise JourneyContractError(
                    f"runner {selector!r} is not authorized for journey domain {domain.id!r}")
            expected_mode = dict(domain.runner_modes).get(selector)
            if expected_mode is not None and graph.journey.mode != expected_mode:
                raise JourneyContractError(
                    f"runner {selector!r} is registered for mode {expected_mode!r}, "
                    f"not {graph.journey.mode!r}, in domain {domain.id!r}")
            domain_claims = set(lease.get("claimIds", ())).intersection(domain.cases)
            owner = graph.journey.planned_execution_steps.get(("flow", domain.owner_name))
            if not owner or owner.get("direct") is not True:
                if not domain_claims:
                    graph.journey.skipped(domain.owner_name, domain.capability)
                    graph.journey.record_flow(domain.owner_name, "SKIPPED", "domain not assigned to this lease")
                    return "SKIPPED"
                raise JourneyContractError(
                    f"execution lease does not select atomic domain {domain.id!r} "
                    f"through direct flow owner {domain.owner_name!r}")
            expected_owner_id = f"{selector}|flow:{domain.owner_name}"
            if owner.get("id") != expected_owner_id or owner.get("id") not in set(lease.get("directStepIds", [])):
                raise JourneyContractError(
                    f"execution lease has a mismatched direct owner for domain {domain.id!r}")
            independent_claims = (set(expected_claims) if expected_claims is not None else domain_claims)
            if domain_claims != independent_claims or set(owner.get("claimIds", ())) != independent_claims:
                raise JourneyContractError(
                    f"execution lease claims do not match independent domain inventory for {domain.id!r}")

        def invoke() -> object:
            try:
                for dependency_ref in domain.requires:
                    dependency = Dependency.parse(dependency_ref)
                    prior = graph.journey.find_outcome(dependency)
                    if prior is None or prior[0] != "PASS":
                        raise JourneyContractError(
                            f"journey domain {domain.id!r} prerequisite {dependency_ref!r} "
                            f"did not pass before callback "
                            f"(observed {prior[0] if prior else 'missing'})")
                if setup is not None:
                    setup()
                outcome = action()
            finally:
                if cleanup is not None:
                    cleanup()
            if domain.child_result_required:
                if not isinstance(outcome, Journey):
                    raise JourneyContractError(
                        f"journey domain {domain.id!r} did not return its child Journey result")
                child = outcome.result()
                if outcome.mode != graph.journey.mode or child.status != "PASS":
                    raise JourneyContractError(
                        f"journey domain {domain.id!r} child result is {child.status} "
                        f"in mode {outcome.mode}")
                if lease is not None:
                    expected_claim_set = set(expected_claims or ())
                elif graph.selection_active:
                    expected_claim_set = graph.journey.selected_claims.intersection(domain.cases)
                else:
                    expected_claim_set = set(expected_claims or ())
                claim_status: dict[str, str] = {}
                for row in child.steps:
                    for claim in row.get("cases", []):
                        if claim in expected_claim_set:
                            previous = claim_status.get(claim)
                            if row.get("status") != "PASS" or previous == "FAIL":
                                claim_status[claim] = row.get("status", "FAIL")
                            else:
                                claim_status.setdefault(claim, "PASS")
                missing = sorted(claim for claim in expected_claim_set if claim_status.get(claim) != "PASS")
                if missing:
                    raise JourneyContractError(
                        f"journey domain {domain.id!r} lacks PASS child evidence for claims: "
                        + ", ".join(missing))
            return outcome

        return graph.flow(domain.owner_name, domain.group, domain.capability, invoke,
                          cases=domain.cases, record_empty_success=False,
                          runners=domain.runners)


def service_journey_domain_registry(*, mode: str | None = None) -> JourneyDomainRegistry:
    """Authoritative declarative service-domain inventory used at runtime and by planning."""
    if mode is not None and mode not in {"local", "secured"}:
        raise ValueError(f"unsupported service journey mode {mode!r}")
    workflow_claims = tuple(
        [f"S-002.{step}" for step in range(1, 7)]
        + ["S-006.3"]
        + [f"S-007.{step}" for step in range(1, 6)]
        + [f"S-008.{step}" for step in range(1, 5)]
        + [f"S-009.{step}" for step in range(1, 5)]
        + [f"S-027.{step}" for step in range(1, 4)]
        + [f"S-028.{step}" for step in range(1, 4)]
        + [f"S-029.{step}" for step in range(1, 4)]
        + [f"S-044.{step}" for step in range(1, 10)]
        + ["S-056.1", "S-056.2", "S-056.3"]
        + ["S-041.17"]
        + ["PC-002.5"]
        + [f"S-143.{step}" for step in range(1, 5)]
    )
    registry = JourneyDomainRegistry()
    required_claims: tuple[str, ...] = ()
    if mode is not None:
        from journey_resources import case_catalog_root
        from scoreboard import load_cases
        required_claims = tuple(sorted({
            claim
            for case in load_cases(case_catalog_root())
            if case.get("status") == "active" and case.get("release")
            and (not case.get("modes") or mode in case.get("modes", []))
            for claim in case.get("claims", [])
            if claim in workflow_claims
        }))
    registry.register(JourneyDomain(
        id="workflow-execution",
        owner_name="workflow execution journey",
        group="workflow",
        capability="workflow",
        cases=workflow_claims,
        runners=("service-local:explore", "service-secured:explore"),
        required_claims=required_claims,
        runner_modes=(
            ("service-local:explore", "local"),
            ("service-secured:explore", "secured"),
        ),
        implementation_sources=("e2e/journey/workflow_steps.py",),
        child_result_required=True,
        position_after="workflow fixture lint",
        requires=("flow:workflow fixture lint",),
    ))
    return registry
