"""Declarative, atomic callbacks dispatched by the service journey runner."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from service_steps import FlowGraph, JourneyContractError


@dataclass(frozen=True)
class JourneyDomain:
    """One real runner callback, kept atomic when selected by a shard lease."""

    id: str
    owner_name: str
    group: str
    capability: str
    cases: tuple[str, ...]
    runners: tuple[str, ...]


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

    def run(self, graph: FlowGraph, domain_id: str, action: Callable[[], object], *,
            setup: Callable[[], None] | None = None,
            cleanup: Callable[[], None] | None = None) -> str:
        domain = self._domains.get(domain_id)
        if domain is None:
            raise JourneyContractError(f"unknown journey domain {domain_id!r}")

        lease = graph.journey.selection_boundary.execution_lease
        if lease is not None:
            owner = graph.journey.planned_execution_steps.get(("flow", domain.owner_name))
            if not owner or owner.get("direct") is not True:
                raise JourneyContractError(
                    f"execution lease does not select atomic domain {domain.id!r} "
                    f"through direct flow owner {domain.owner_name!r}")
            direct_ids = set(lease.get("directStepIds", []))
            if direct_ids != {owner.get("id")}:
                raise JourneyContractError(
                    f"execution lease must contain only the atomic direct owner for domain {domain.id!r}; "
                    f"got {sorted(direct_ids)!r}")

        def invoke() -> object:
            try:
                if setup is not None:
                    setup()
                return action()
            finally:
                if cleanup is not None:
                    cleanup()

        return graph.flow(domain.owner_name, domain.group, domain.capability, invoke,
                          cases=domain.cases, record_empty_success=False,
                          runners=domain.runners)
