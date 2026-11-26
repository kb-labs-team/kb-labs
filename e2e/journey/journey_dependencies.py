"""Typed references shared by journey selection and runtime dependency checks."""
from __future__ import annotations

from dataclasses import dataclass
from collections.abc import Iterable, Mapping


# FlowGraph state producers are the shared runtime contract used by the installer
# runner and the source resolver. A step dependency must never stand in for one
# of these values when its producing flow varies by runner.
FLOW_GRAPH_STATE_PRODUCERS = {
    "host-running": "host",
    "project-registered": "project",
    "session": "auth",
}


def required_state_closure(selected_groups: Iterable[str],
                           group_dependencies: Mapping[str, Iterable[str]],
                           state_producers: Mapping[str, str],
                           initial_states: Iterable[str] = ()) -> set[str]:
    """Resolve state prerequisites and the prerequisites of their producer groups."""
    required: set[str] = set()
    pending: list[str] = list(initial_states)
    for group in selected_groups:
        pending.extend(group_dependencies.get(group, ()))
    while pending:
        state = pending.pop()
        if state in required:
            continue
        required.add(state)
        producer = state_producers.get(state)
        if producer is not None:
            pending.extend(group_dependencies.get(producer, ()))
    return required


def owner_state_prerequisites(owner_name: str, claim_ids: Iterable[str], capabilities: Iterable[str],
                              groups: Mapping[str, Mapping[str, Iterable[str]]],
                              initial_states: Iterable[str] = ()) -> set[str]:
    """Resolve FlowGraph state prerequisites selected by one runnable owner."""
    step_groups: dict[str, set[str]] = {}
    for group, spec in groups.items():
        for name in spec.get("steps", ()):
            step_groups.setdefault(name, set()).add(group)
    claims = set(claim_ids)
    capability_set = set(capabilities)
    selected_groups = set()
    for group, spec in groups.items():
        if (capability_set.intersection(spec.get("capabilities", ()))
                or claims.intersection(spec.get("cases", ()))
                or step_groups.get(owner_name) == {group}):
            selected_groups.add(group)
    dependencies = {group: spec.get("depends_on", ()) for group, spec in groups.items()}
    producers = {state: group for group, spec in groups.items()
                 for state in spec.get("produces", ())}
    return required_state_closure(selected_groups, dependencies, producers, initial_states)


@dataclass(frozen=True, order=True)
class Dependency:
    kind: str
    name: str

    @classmethod
    def parse(cls, value: str) -> "Dependency":
        kind, separator, name = value.partition(":")
        if not separator or kind not in {"step", "flow", "state"} or not name.strip():
            raise ValueError(
                f"invalid journey dependency {value!r}; use 'step:<name>', 'flow:<name>', or 'state:<name>'")
        return cls(kind, name.strip())

    def __str__(self) -> str:
        return f"{self.kind}:{self.name}"
