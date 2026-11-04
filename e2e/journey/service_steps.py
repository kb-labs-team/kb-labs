#!/usr/bin/env python3
"""Small named-step framework shared by installed service journeys."""
from __future__ import annotations
import json
import time
import traceback
import os
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, overload
from invocations import invocation_context, invocation_link, write_report_json, write_report_text
from journey_dependencies import Dependency
from journey_values import MissingJourneyState
from journey_values import journey_value
from journey_selection import (JourneySelection, active_journey_selection,
                               read_journey_selection)


class JourneyContractError(RuntimeError):
    """A runner violated its registered step-to-step state contract."""


class StructuredJourneyError(RuntimeError):
    """A journey failure retaining the code and message from its structured owner."""

    def __init__(self, error: Mapping[str, Any]):
        code = error.get("code")
        message = error.get("message")
        if not isinstance(code, str) or not isinstance(message, str):
            raise ValueError("structured journey error requires string code and message")
        super().__init__(f"{code}: {message}")
        self.error = {"code": code, "message": message}


_active_memory_step: ContextVar[tuple[str, frozenset[str], frozenset[str]] | None] = ContextVar(
    "active_journey_memory_step", default=None)


class JourneyMemory:
    """The declared in-memory value store used by journey steps that opt into it."""

    def __init__(self, declarations: Mapping[str, tuple[Iterable[str], Iterable[str]]]):
        self._declarations = {name: tuple(required) for name, (required, _) in declarations.items()}
        self._producers = {key: name for name, (_, keys) in declarations.items() for key in keys}
        self._values: dict[str, Any] = {}

    def register(self, name: str, requires: Iterable[str], provides: Iterable[str]) -> None:
        required_names = tuple(Dependency.parse(item).name for item in requires
                               if Dependency.parse(item).kind == "step")
        self._declarations[name] = required_names
        for key in provides:
            producer = self._producers.get(key)
            if producer is not None and producer != name:
                raise JourneyContractError(
                    f"harness defect: journey state key {key!r} has multiple producers "
                    f"{producer!r} and {name!r}")
            self._producers[key] = name

    def _closure(self, required: Iterable[str]) -> set[str]:
        closure: set[str] = set()
        pending = list(required)
        while pending:
            name = pending.pop()
            if name in closure:
                continue
            if name not in self._declarations:
                raise JourneyContractError(f"harness defect: unknown journey prerequisite {name!r}")
            closure.add(name)
            pending.extend(self._declarations[name])
        return closure

    def validate_requirements(self, requires: Iterable[str]) -> None:
        required_names = tuple(Dependency.parse(item).name for item in requires
                               if Dependency.parse(item).kind == "step")
        self._closure(required_names)

    @contextmanager
    def activate(self, name: str, requires: Iterable[str], provides: Iterable[str]):
        required_names = tuple(Dependency.parse(item).name for item in requires
                               if Dependency.parse(item).kind == "step")
        token = _active_memory_step.set(
            (name, frozenset(self._closure(required_names)), frozenset(provides)))
        try:
            yield
        finally:
            _active_memory_step.reset(token)

    def get(self, key: str) -> Any:
        active = _active_memory_step.get()
        producer = self._producers.get(key)
        if active is None:
            raise JourneyContractError(f"harness defect: journey state {key!r} read outside a registered step")
        reader, closure, _ = active
        if producer is None or producer not in closure:
            raise JourneyContractError(
                f"harness defect: undeclared dependency: reader {reader!r} reads key {key!r} "
                f"from producer {producer or '<unregistered>'!r}")
        return self._values[key]

    def set(self, key: str, value: Any) -> None:
        active = _active_memory_step.get()
        if active is None:
            raise JourneyContractError(f"harness defect: journey state {key!r} written outside a registered step")
        writer, _, provides = active
        if key not in provides:
            raise JourneyContractError(
                f"harness defect: undeclared write: writer {writer!r} writes key {key!r}")
        self._values[key] = value


@dataclass
class StepResult:
    name: str
    capability: str
    mode: str
    status: str
    duration_seconds: float
    message: str
    cases: list[str]
    details: dict[str, Any] | None = None
    step_id: str = ""


@dataclass
class JourneyResult:
    schema: str
    run_id: str
    started_at: str
    duration_seconds: float
    status: str
    first_failure: dict | None
    steps: list[dict]
    case_run: dict


class Journey:
    _instances: list["Journey"] = []

    @classmethod
    def reset_run_registry(cls) -> None:
        cls._instances.clear()

    @classmethod
    def run_instances(cls) -> tuple["Journey", ...]:
        return tuple(cls._instances)

    def __init__(self, mode: str, run_id: str = "local", *, parent: "Journey | None" = None,
                 selection: JourneySelection | None = None):
        if mode not in {"local", "secured"}:
            raise ValueError(f"unsupported access mode: {mode}")
        self.mode = mode
        self.run_id = run_id
        self.parent = parent
        inherited_selection = parent.selection_boundary if parent is not None else active_journey_selection()
        self.selection_boundary = selection or inherited_selection or read_journey_selection(os.environ)
        self.state_graph: FlowGraph | None = None
        self.started_at = datetime.now(timezone.utc).isoformat()
        self.started = time.monotonic()
        self.steps: list[StepResult] = []
        self.selected_steps = set(self.selection_boundary.claims)
        self.selected_claims = set(self.selected_steps)
        self.selected_owning_steps = self.selection_boundary.owning_steps
        self.selected_capabilities = set(self.selection_boundary.capabilities)
        self.prerequisite_steps = set(self.selection_boundary.prerequisite_steps)
        self.prerequisite_flows = set(self.selection_boundary.prerequisite_flows)
        self.flows: dict[str, tuple[str, str]] = {}
        self.flow_step_ids: dict[str, str] = {}
        self.selection = list(self.selection_boundary.requested)
        self.runner_selector = self.selection_boundary.runner_selector
        self.step_guard: Callable[[str, Callable[[], str | None]], str | None] | None = None
        self.memory = parent.memory if parent is not None else JourneyMemory({})
        self._instances.append(self)

    def step(self, name: str, capability: str, check: Callable[[], str | None], cases: Iterable[str] = (),
             details: Callable[[], dict[str, Any]] | None = None, *,
             requires: Iterable[str] = (), provides: Iterable[str] = (), role: str = "step",
             runners: Iterable[str] = (), plan_after_phase: str | None = None,
             plan_phase: str | None = None) -> StepResult:
        return self._record_step(name, capability, check, cases, details, requires=requires,
                                 provides=provides, role=role, runners=runners,
                                 plan_after_phase=plan_after_phase, plan_phase=plan_phase)

    def _record_step(self, name: str, capability: str, check: Callable[[], str | None],
                     cases: Iterable[str] = (), details: Callable[[], dict[str, Any]] | None = None, *,
                     requires: Iterable[str] = (), provides: Iterable[str] = (), role: str = "step",
                     runners: Iterable[str] = (), plan_after_phase: str | None = None,
                     plan_phase: str | None = None) -> StepResult:
        if role not in {"step", "lifecycle"}:
            raise ValueError(f"unsupported journey step role: {role}")
        if plan_after_phase is not None and plan_after_phase != "all-steps":
            raise ValueError("plan_after_phase must be 'all-steps'")
        if plan_phase is not None and (plan_phase != "teardown" or role != "lifecycle"):
            raise ValueError("plan_phase='teardown' is only valid on a lifecycle journey step")
        case_ids = list(cases)
        required_items = tuple(requires)
        step_id = "case:" + ",".join(sorted(set(case_ids))) if case_ids else f"flow:{name}"
        normalized_requirements = self._identified_requirements(required_items)
        dependency_details = {"requires": normalized_requirements} if normalized_requirements else None
        selected = bool(self.selected_steps.intersection(case_ids))
        eligible_runners = set(runners)
        if selected and eligible_runners and self.runner_selector not in eligible_runners:
            message = (f"registered for runner(s) {', '.join(sorted(eligible_runners))}; "
                       f"this execution used {self.runner_selector or 'no runner selector'}")
            result = StepResult(name, capability, self.mode, "FAIL", 0.0, message, case_ids,
                                {**(dependency_details or {}), "selectionRole": "selected"}, step_id)
            self.steps.append(result)
            return result
        if not selected and eligible_runners and self.runner_selector not in eligible_runners:
            result = StepResult(name, capability, self.mode, "SKIPPED", 0.0,
                                f"registered for runner(s) {', '.join(sorted(eligible_runners))}; "
                                f"this execution used {self.runner_selector or 'no runner selector'}",
                                case_ids, dependency_details, step_id)
            self.steps.append(result)
            return result
        prerequisite = name in self.prerequisite_steps
        lifecycle = role == "lifecycle"
        if self.selected_claims and not selected and not prerequisite and not lifecycle:
            result = StepResult(name, capability, self.mode, "SKIPPED", 0.0, "not selected", case_ids,
                                dependency_details, step_id)
            self.steps.append(result)
            return result
        provided_items = tuple(provides)
        self.memory.register(name, required_items, provided_items)
        try:
            self.memory.validate_requirements(required_items)
        except JourneyContractError as error:
            details = dict(dependency_details or {})
            if selected:
                details["selectionRole"] = "selected"
            result = StepResult(name, capability, self.mode, "FAIL", 0.0, str(error), case_ids, details or None, step_id)
            self.steps.append(result)
            return result
        required = {Dependency.parse(item) for item in required_items}
        required_states = {dependency.name for dependency in required if dependency.kind == "state"}
        if required:
            failures = []
            for dependency in sorted(item for item in required if item.kind != "state"):
                prior = self.find_outcome(dependency)
                if prior is None:
                    failures.append(f"{dependency} did not run before {name}")
                elif prior[0] != "PASS":
                    failures.append(f"{dependency} ended {prior[0]}: {prior[1]}")
            graph = self.state_graph
            ancestor = self.parent
            while graph is None and ancestor is not None:
                graph = ancestor.state_graph
                ancestor = ancestor.parent
            for state in sorted(required_states):
                outcome = graph.states.get(state) if graph is not None else None
                if outcome is None:
                    failures.append(f"state:{state} has not been registered before {name}")
                elif outcome.get("passed") is not True:
                    failures.append(f"state:{state} ended FAIL: {outcome.get('evidence', 'state failed')}")
            if failures:
                message = "step prerequisites failed: " + "; ".join(failures)
                step_details = {**(dependency_details or {}), "prerequisiteFailures": failures}
                if selected:
                    step_details["selectionRole"] = "selected"
                elif prerequisite:
                    step_details["selectionRole"] = "prerequisite"
                elif lifecycle:
                    step_details["selectionRole"] = "lifecycle"
                result = StepResult(name, capability, self.mode, "BLOCKED", 0.0, message, case_ids,
                                    step_details, step_id)
                self.steps.append(result)
                return result
        started = time.monotonic()
        missing_state_key: str | None = None
        structured_error: dict[str, str] | None = None
        invocation_capture = None
        try:
            with invocation_context(step_id=",".join(case_ids) or name) as invocation_capture:
                with self.memory.activate(name, (str(item) for item in required), provided_items):
                    message = self.step_guard(name, check) if self.step_guard else check()
            if isinstance(message, str) and message.startswith("BLOCKED:"):
                status = "BLOCKED"
                message = message.removeprefix("BLOCKED:").strip()
            else:
                status = "PASS" if message is None else "FAIL"
        except MissingJourneyState as error:
            status = "BLOCKED"
            message = str(error)
            missing_state_key = error.key
        except JourneyContractError as error:
            status = "FAIL"
            message = str(error)
        except StructuredJourneyError as error:
            status = "FAIL"
            message = str(error)
            structured_error = error.error
        except Exception as error:  # Include a concise error, not a raw traceback.
            status = "FAIL"
            message = str(error) or error.__class__.__name__
        step_details = details() if details is not None else None
        if dependency_details:
            step_details = {**(step_details or {}), **dependency_details}
        if missing_state_key:
            step_details = dict(step_details or {})
            step_details["missingStateKey"] = missing_state_key
        if structured_error:
            step_details = dict(step_details or {})
            step_details["error"] = structured_error
        if invocation_capture and invocation_capture.unexpected_error_diagnostics:
            step_details = dict(step_details or {})
            step_details["unexpectedErrorDiagnostics"] = invocation_capture.unexpected_error_diagnostics
        if prerequisite or lifecycle:
            step_details = dict(step_details or {})
            step_details["selectionRole"] = "prerequisite" if prerequisite else "lifecycle"
        if status == "FAIL":
            reference = invocation_link(",".join(case_ids) or name)
            if reference:
                step_details = dict(step_details or {})
                step_details["invocation_evidence"] = reference
        result = StepResult(name, capability, self.mode, status,
                            round(time.monotonic() - started, 3), message or "passed", case_ids,
                            step_details, step_id)
        self.steps.append(result)
        return result

    def skipped(self, name: str, capability: str, message: str = "not selected") -> StepResult:
        result = StepResult(name, capability, self.mode, "SKIPPED", 0.0,
                            message, [], step_id=f"flow:{name}")
        self.steps.append(result)
        return result

    def record_flow(self, name: str, status: str, message: str = "") -> None:
        self.flows[name] = status, message

    def find_outcome(self, dependency: Dependency) -> tuple[str, str] | None:
        journey: Journey | None = self
        while journey is not None:
            if dependency.kind == "step":
                step = next((item for item in reversed(journey.steps) if item.name == dependency.name), None)
                if step is not None:
                    return step.status, step.message
            else:
                result = journey.flows.get(dependency.name)
                if result is not None:
                    return result
            journey = journey.parent
        return None

    def _identified_requirements(self, requirements: Iterable[str]) -> list[str]:
        identified = []
        for item in requirements:
            dependency = Dependency.parse(item)
            if dependency.kind == "state":
                identified.append(str(dependency))
                continue
            if dependency.kind == "flow":
                producer = self._flow_step_id(dependency.name)
                if producer is not None:
                    identified.append(f"step:{producer}")
                    continue
            matches = [step for step in self.steps if step.name == dependency.name]
            if len(matches) == 1:
                identified.append(f"step:{matches[0].step_id}")
            elif len(matches) > 1:
                raise JourneyContractError(f"ambiguous journey dependency {item!r}; declare its step id")
            elif dependency.kind == "flow":
                identified.append(f"step:flow:{dependency.name}")
            else:
                identified.append(f"step:unresolved:{dependency.name}")
        return identified

    def _flow_step_id(self, name: str) -> str | None:
        journey: Journey | None = self
        while journey is not None:
            step_id = journey.flow_step_ids.get(name)
            if step_id is not None:
                return step_id
            journey = journey.parent
        return None

    def blocked(self, name: str, capability: str, reason: str, cases: Iterable[str] = (), *,
                requires: Iterable[str] = ()) -> StepResult:
        case_ids = list(cases)
        if self.selected_claims and (not case_ids or not self.selected_claims.intersection(case_ids)):
            return self.skipped(name, capability)
        required_items = tuple(requires)
        details = {"requires": self._identified_requirements(required_items)} if required_items else None
        step_id = "case:" + ",".join(sorted(set(case_ids))) if case_ids else f"flow:{name}"
        result = StepResult(name, capability, self.mode, "BLOCKED", 0.0,
                            reason, case_ids, details, step_id)
        self.steps.append(result)
        return result

    def missing_selected_claims(self, journey_results: list[dict[str, Any]]) -> list[str]:
        """Return resolved claims that no journey result recorded as executed."""
        executed = {
            case_id
            for journey_result in journey_results
            for step in journey_result.get("steps", [])
            if step.get("status") in {"PASS", "FAIL", "BLOCKED"}
            for case_id in step.get("cases", [])
        }
        return sorted(self.selected_steps - executed)

    def result(self) -> JourneyResult:
        first_step = next((step for step in self.steps if step.status == "FAIL"), None)
        first = _step_dict(first_step) if first_step is not None else None
        failed = any(step.status == "FAIL" for step in self.steps)
        blocked = any(step.status == "BLOCKED" for step in self.steps)
        status = "FAIL" if failed else "BLOCKED" if blocked else "PASS"
        claims = {}
        for step in self.steps:
            if step.status not in {"PASS", "FAIL"}:
                continue
            for case_id in step.cases:
                previous = claims.get(case_id)
                if step.status == "FAIL" or previous != "FAIL":
                    claims[case_id] = step.status
        case_run = {
            "schema": "kb.qa-case-run/v2",
            "runId": self.run_id,
            "mode": self.mode,
            "claims": [{"claimId": case_id, "kind": "journey", "status": result} for case_id, result in sorted(claims.items())],
        }
        if self.selection:
            case_run.update({"selection": self.selection})
        return JourneyResult("kb.service-journey/v1", self.run_id, self.started_at,
                             round(time.monotonic() - self.started, 3), status, first,
                             [_step_dict(step) for step in self.steps], case_run)

    def write_json(self, path: str | Path) -> JourneyResult:
        result = self.result()
        write_report_json(path, asdict(result), env=os.environ)
        return result


def replay_steps(source: Journey, target: Journey) -> None:
    """Record every step collected by a fixture journey in the journey that owns the report."""
    for step in source.steps:
        target.step(step.name, step.capability,
                    lambda step=step: None if step.status == "PASS" else step.message,
                    cases=step.cases)


def record_runner_exception(journey: Journey, error: Exception,
                            diagnostics_path: str | Path | None = None, *,
                            env: Mapping[str, str] | None = None) -> StepResult:
    """Turn an unexpected runner exception into a durable journey failure row."""
    diagnostic = traceback.format_exc()
    if diagnostics_path:
        write_report_text(diagnostics_path,
                          "\n== unexpected exception in outer journey orchestration ==\n" + diagnostic,
                          env=env, append=True)

    def failed() -> str:
        raise RuntimeError(str(error) or error.__class__.__name__)

    return journey.step("outer journey orchestration", "journey.runner", failed)


class FlowGraph:
    """Gate journey groups on probed state, independent of product assertions."""

    def __init__(self, journey: Journey, dependencies: dict[str, tuple[str, ...]],
                 diagnostics_path: str | Path | None = None,
                 states: dict[str, dict[str, object]] | None = None,
                 state_producers: dict[str, str] | None = None,
                 groups: Mapping[str, Mapping[str, object]] | None = None):
        self.journey = journey
        journey.state_graph = self
        self.dependencies = dependencies
        self.diagnostics_path = Path(diagnostics_path) if diagnostics_path else None
        self.states = dict(states or {})
        self.groups = dict(groups or {})
        self.state_producers = dict(state_producers or {
            state: group for group, spec in self.groups.items()
            for state in spec.get("produces", ())
        })
        self._state_producer_actions: dict[str, Callable[[], object]] = {}
        self._state_producers_running: set[str] = set()
        self.resources: list[Any] = []
        self.selected_groups = {
            group for group, spec in self.groups.items()
            if (self.journey.selected_capabilities.intersection(spec.get("capabilities", ()))
                or self.journey.selected_claims.intersection(spec.get("cases", ()))
                or self.journey.prerequisite_steps.intersection(spec.get("steps", ())))
        }
        self.needed_states = set(filter(None, journey_value("KB_JOURNEY_NEEDED_STATES", "").split(",")))
        for group in self.selected_groups:
            self.needed_states.update(self.dependencies.get(
                group, self.groups.get(group, {}).get("depends_on", ())))
        pending_states = list(self.needed_states)
        while pending_states:
            producer = self.state_producers.get(pending_states.pop())
            if producer is None:
                continue
            for state in self.dependencies.get(
                    producer, self.groups.get(producer, {}).get("depends_on", ())):
                if state not in self.needed_states:
                    self.needed_states.add(state)
                    pending_states.append(state)

    @property
    def selection_active(self) -> bool:
        return bool(self.journey.selected_claims)

    def group_selected(self, group: str) -> bool:
        """Return whether selection or its declared prerequisites include a graph group."""
        return not self.selection_active or group in self.selected_groups

    def selects_steps(self, *names: str) -> bool:
        """Whether the resolver selected one of these owning or prerequisite steps."""
        return not self.selection_active or bool(set(names).intersection(
            set(self.journey.selected_owning_steps) | self.journey.prerequisite_steps))

    def skip_unselected(self, name: str, capability: str) -> None:
        """Record an orchestration journey omitted by claim selection."""
        print(f"SKIPPED {name}: not selected", flush=True)
        self.journey.skipped(name, capability)
        self.journey.record_flow(name, "SKIPPED", "not selected")

    def _group_produces_needed_state(self, group: str) -> bool:
        return bool(set(self.groups.get(group, {}).get("produces", ())) & self.needed_states)

    def register_state_producer(self, state: str, action: Callable[[], object]) -> None:
        """Register the action that establishes a declared state when a consumer needs it."""
        if state not in self.state_producers:
            raise JourneyContractError(f"harness defect: state {state!r} has no declared producer")
        if state in self._state_producer_actions:
            raise JourneyContractError(f"harness defect: state {state!r} has multiple producer actions")
        self._state_producer_actions[state] = action

    def _ensure_dependency_producers(self, group: str) -> None:
        """Run registered producers for absent dependencies before a group's state gate."""
        dependencies = self.dependencies.get(group, self.groups.get(group, {}).get("depends_on", ()))
        for state in dependencies:
            if state in self.states or state in self._state_producers_running:
                continue
            action = self._state_producer_actions.get(state)
            producer_group = self.state_producers.get(state)
            if action is None or producer_group is None:
                continue
            self._ensure_dependency_producers(producer_group)
            producer_dependencies = self.dependencies.get(
                producer_group, self.groups.get(producer_group, {}).get("depends_on", ()))
            if any(dependency not in self.states for dependency in producer_dependencies):
                continue
            if any(self.states[dependency].get("passed") is not True
                   for dependency in producer_dependencies):
                continue
            self._state_producers_running.add(state)
            try:
                action()
            finally:
                self._state_producers_running.remove(state)

    def _flow_owns_selected_claim(self, group: str, cases: Iterable[str]) -> bool:
        if self.journey.selected_claims.intersection(cases):
            return True
        selected_names = set(self.journey.selected_owning_steps) | self.journey.prerequisite_steps
        declared_steps = set(self.groups.get(group, {}).get("steps", ()))
        return bool(selected_names.intersection(declared_steps))

    def state_value(self, state: str) -> Any:
        result = self.states.get(state)
        if not result:
            raise MissingJourneyState(state, "state probe has not run")
        if result.get("passed") is not True:
            raise MissingJourneyState(state, str(result.get("evidence") or "state probe failed"))
        if "value" not in result:
            raise MissingJourneyState(state, "state probe passed without recording its value")
        return result["value"]

    def state_value_if_passed(self, state: str) -> Any | None:
        """Read an optional state at a runner boundary without raising on a failed probe."""
        result = self.states.get(state)
        if result is None or result.get("passed") is not True or "value" not in result:
            return None
        return result["value"]

    def state_failure(self, state: str) -> str:
        """Describe why a state value is unavailable at a runner boundary."""
        result = self.states.get(state)
        if result is None:
            return "state probe has not run"
        if result.get("passed") is not True:
            return str(result.get("evidence") or "state probe failed")
        if "value" not in result:
            return "state probe passed without recording its value"
        return "state probe passed with an unusable value"

    def invalidate_state(self, state: str, *, group: str, step: str, evidence: str) -> None:
        """Mark shared state unavailable after a declared mutating journey step."""
        self.states[state] = {
            "passed": False,
            "evidence": evidence,
            "group": group,
            "step": f"state probe: {state}",
            "mutation": step,
            "claim": "no case claim",
        }

    def _blocker(self, group: str, *, producing_state: str | None = None) -> tuple[str, dict[str, object]] | None:
        for state in self.dependencies.get(group, ()):
            if state == producing_state:
                continue
            result = self.states.get(state)
            if result is None:
                return state, {"passed": False, "evidence": "state probe has not run",
                               "group": "journey", "step": f"state probe: {state}",
                               "mutation": "state probe has not run", "claim": "no case claim"}
            if result.get("passed") is not True:
                return state, result
        return None

    def probe_state(self, state: str, group: str, step: str, check: Callable[[], str | None],
                    *, after_flow: str | None = None,
                    value: Callable[[], Any] | None = None,
                    required: bool = False) -> StepResult:
        """Run and record an explicit state precondition probe."""
        if self.selection_active and not required:
            tied_flow = self.journey.flows.get(after_flow) if after_flow else None
            if after_flow and (tied_flow is None or tied_flow[0] == "SKIPPED"):
                return self.journey.skipped(f"state probe: {state}", "journey.state")
            if state not in self.needed_states and not after_flow:
                return self.journey.skipped(f"state probe: {state}", "journey.state")

        blocker = self._blocker(group, producing_state=state)
        if blocker:
            blocked_state, evidence = blocker
            message = (f"blocked by state {blocked_state}: {evidence.get('evidence', 'state probe failed')} "
                       f"(last mutated by {evidence.get('group', 'journey')}/"
                       f"{evidence.get('mutation', evidence.get('step', 'unknown'))} "
                       f"({evidence.get('claim', 'no case claim')}))")
            result = self.journey.blocked(f"state probe: {state}", "journey.state", message,
                                          requires=(f"state:{blocked_state}",))
            self.states[state] = {
                "passed": False,
                "evidence": message,
                "group": group,
                "step": result.step_id,
                "mutation": step,
                "claim": "no case claim",
            }
            return result

        def checked() -> str | None:
            try:
                return check()
            except Exception:
                self._write_traceback(group, f"state probe: {state}")
                raise

        probe_name = f"state probe: {state}"
        result = self.journey.step(probe_name, "journey.state", checked, role="lifecycle")
        state_result = {
            "passed": result.status == "PASS",
            "evidence": "probe passed" if result.status == "PASS" else result.message,
            "group": group,
            "step": result.step_id,
            "mutation": step,
            "claim": "no case claim",
        }
        if result.status == "PASS" and value is not None:
            state_result["value"] = value()
        self.states[state] = state_result
        return result

    def _write_traceback(self, group: str, name: str) -> None:
        if self.diagnostics_path:
            write_report_text(self.diagnostics_path,
                              f"\n== unexpected exception in {group}/{name} ==\n{traceback.format_exc()}",
                              append=True)

    def dispatch_step(self, name: str, group: str, capability: str, check: Callable[[], str | None],
                      cases: Iterable[str] = (), *, requires: Iterable[str] = (),
                      runners: Iterable[str] = ()) -> StepResult:
        case_ids = list(cases)
        def checked() -> str | None:
            blocker = self._blocker(group)
            if blocker:
                state, evidence = blocker
                return (f"BLOCKED: blocked by state {state}: {evidence['evidence']} (last owned by "
                        f"{evidence.get('mutation', evidence['step'])} ({evidence.get('claim', 'no case claim')}))")
            try:
                return check()
            except Exception:
                self._write_traceback(group, name)
                raise

        state_dependencies = self.dependencies.get(group, self.groups.get(group, {}).get("depends_on", ()))
        result = self.journey._record_step(name, capability, checked, cases=case_ids,
                                           requires=requires, runners=runners)
        declared_dependencies = [*self.journey._identified_requirements(requires),
                                 *(f"state:{state}" for state in state_dependencies)]
        if declared_dependencies:
            result.details = {**(result.details or {}), "requires": declared_dependencies}
        return result

    @overload
    def flow(self, name: str, group: str, capability: str, action: Callable[[], object],
             cases: Iterable[str] = (), *, role: str = "step",
             record_empty_success: bool = True, runners: Iterable[str] = (),
             skip_note: str | None = None, case_action: None = None,
             plan_after_phase: str | None = None, plan_phase: str | None = None) -> str: ...

    @overload
    def flow(self, name: str, group: str, capability: str, action: None,
             cases: Iterable[str] = (), *, role: str = "step",
             record_empty_success: bool = True, runners: Iterable[str] = (),
             skip_note: str | None = None,
             case_action: Callable[[tuple[str, ...]], object],
             plan_after_phase: str | None = None, plan_phase: str | None = None) -> str: ...

    def flow(self, name: str, group: str, capability: str, action: Callable[[], object] | None,
             cases: Iterable[str] = (), *, role: str = "step",
             record_empty_success: bool = True, runners: Iterable[str] = (),
             skip_note: str | None = None,
             case_action: Callable[[tuple[str, ...]], object] | None = None,
             plan_after_phase: str | None = None, plan_phase: str | None = None) -> str:
        """Run an outer flow; return PASS, FAIL, or BLOCKED for dependency wiring."""
        case_ids = list(cases)

        def record_flow_step(check, *, cases=(), role=role):
            if plan_after_phase == "all-steps":
                return self.journey.step(name, capability, check, cases=cases, role=role,
                                         runners=runners, plan_after_phase="all-steps")
            if plan_phase == "teardown":
                return self.journey.step(name, capability, check, cases=cases, role=role,
                                         runners=runners, plan_phase="teardown")
            return self.journey.step(name, capability, check, cases=cases, role=role, runners=runners)

        if (action is None) == (case_action is None):
            raise JourneyContractError("provide exactly one outer flow action")
        prerequisite = name in self.journey.prerequisite_flows
        lifecycle = role == "lifecycle"
        selected_owner = (group in self.selected_groups
                          or self._flow_owns_selected_claim(group, case_ids))
        producer = self._group_produces_needed_state(group)
        selected_by_flow_rule = selected_owner or prerequisite or producer
        if (self.selection_active and not selected_by_flow_rule):
            suffix = f"; {skip_note}" if skip_note else ""
            print(f"SKIPPED {name}: not selected{suffix}", flush=True)
            self.journey.skipped(name, capability)
            self.journey.record_flow(name, "SKIPPED", "not selected")
            return "SKIPPED"
        self._ensure_dependency_producers(group)
        blocker = None if lifecycle else self._blocker(group)
        if blocker:
            state, evidence = blocker
            self.journey.blocked(name, capability,
                                 f"blocked by state {state}: {evidence['evidence']} (last mutated by "
                                 f"{evidence['group']}/{evidence.get('mutation', evidence['step'])} "
                                 f"({evidence.get('claim', 'no case claim')}))",
                                 cases=case_ids, requires=(f"state:{state}",))
            self.journey.record_flow(name, "BLOCKED", f"blocked by state {state}")
            return "BLOCKED"

        start = len(self.journey.steps)
        try:
            if case_action is not None:
                outcome = case_action(tuple(case_ids))
            elif action is not None:
                outcome = action()
            else:
                raise JourneyContractError("outer flow action was not selected")
        except MissingJourneyState as error:
            record_flow_step(lambda: f"BLOCKED: {error}", cases=case_ids,
                             role="lifecycle" if selected_by_flow_rule else role)
            outcome = None
        except Exception as error:
            self._write_traceback(group, name)
            record_flow_step(lambda: str(error) or error.__class__.__name__,
                             role="lifecycle" if selected_by_flow_rule else role)
            outcome = None
        emitted = self.journey.steps[start:]
        if isinstance(outcome, str):
            record_flow_step(lambda: outcome, cases=case_ids, role=role)
        elif not emitted and record_empty_success:
            record_flow_step(lambda: None, cases=case_ids, role=role)

        group_steps = self.journey.steps[start:]
        failed = next((step for step in group_steps if step.status == "FAIL"), None)
        blocked = next((step for step in group_steps if step.status == "BLOCKED"), None)
        if failed:
            for state, producer in self.state_producers.items():
                if producer == group:
                    self.states[state] = {
                        "passed": False,
                        "evidence": failed.message,
                        "group": group,
                        "step": failed.step_id,
                        "mutation": name,
                        "claim": ", ".join(failed.cases) or "no case claim",
                    }
            self.journey.record_flow(name, "FAIL", failed.message)
            self.journey.flow_step_ids[name] = failed.step_id
            return "FAIL"
        if blocked:
            self.journey.record_flow(name, "BLOCKED", blocked.message)
            self.journey.flow_step_ids[name] = blocked.step_id
            return "BLOCKED"
        self.journey.record_flow(name, "PASS")
        return "PASS"


def _step_dict(step: StepResult) -> dict[str, Any]:
    result = asdict(step)
    result["stepId"] = result.pop("step_id")
    if step.details is None:
        result.pop("details")
    return result


def record_runner_failure(path: str | Path, mode: str, failure: str) -> JourneyResult:
    """Preserve a pre-service runner failure in the capability result file."""
    name, separator, message = failure.partition(": ")
    journey = Journey(mode, f"runner-{mode}")
    journey.step(name if separator else "journey runner", "journey.install",
                 lambda: message if separator else failure or "journey failed before capability checks",
                 role="lifecycle")
    return journey.write_json(path)


def record_candidate_provenance(journey: Journey, checkout_commit: str,
                                candidate: dict[str, str]) -> StepResult:
    """Add candidate source identity to the journey and fail before case claims."""
    candidate_commit = candidate.get("commit", "")
    candidate_version = candidate.get("version", "")
    details = {
        "checkoutCommit": checkout_commit,
        "candidateCommit": candidate_commit,
        "candidateVersion": candidate_version,
    }
    if candidate.get("identityError"):
        details["identityError"] = candidate["identityError"]
    if not checkout_commit or not candidate_commit:
        details["code"] = "KB_JOURNEY_CANDIDATE_IDENTITY_MISSING"
        failure = ("candidate source identity is missing: "
                   f"checkout commit={checkout_commit or '<missing>'}, candidate commit={candidate_commit or '<missing>'}")
        if candidate.get("identityError"):
            failure += f"; {candidate['identityError']}"
    elif not (checkout_commit.casefold().startswith(candidate_commit.casefold())
              or candidate_commit.casefold().startswith(checkout_commit.casefold())):
        details["code"] = "KB_JOURNEY_CANDIDATE_MISMATCH"
        failure = (f"candidate source commit {candidate_commit} ({candidate_version or 'unknown version'}) "
                   f"does not match checkout commit {checkout_commit}")
    else:
        failure = None

    return journey.step("candidate provenance", "journey.orchestration",
                        lambda: failure, details=lambda: details, role="lifecycle")
