"""Validated selection metadata crossing from the journey shell into a runner."""
from __future__ import annotations

import json
import re
from contextvars import ContextVar
from dataclasses import dataclass
from contextlib import contextmanager
from typing import Mapping


class JourneySelectionError(ValueError):
    """Malformed selection metadata at the runner boundary."""


@dataclass(frozen=True)
class JourneySelection:
    requested: tuple[str, ...]
    claims: frozenset[str]
    owning_steps: dict[str, tuple[str, ...]]
    prerequisite_steps: frozenset[str]
    prerequisite_flows: frozenset[str]
    capabilities: frozenset[str]
    runner_selector: str
    requested_runners: str
    selected_step_names: tuple[str, ...] = ()
    direct_step_names: tuple[str, ...] = ()
    execution_lease: dict | None = None

    @property
    def active(self) -> bool:
        return bool(self.claims or self.selected_step_names)


SELECTION_KEYS = (
    "KB_JOURNEY_CASES",
    "KB_JOURNEY_SELECTED_STEPS",
    "KB_JOURNEY_SELECTED_OWNING_STEPS",
    "KB_JOURNEY_PREREQUISITE_STEPS",
    "KB_JOURNEY_PREREQUISITE_FLOWS",
    "KB_JOURNEY_SELECTED_CAPABILITIES",
    "KB_JOURNEY_ONLY",
    "KB_JOURNEY_RUNNER_SELECTOR",
)

_ACTIVE_SELECTION: ContextVar[JourneySelection | None] = ContextVar("journey_selection", default=None)


@contextmanager
def use_journey_selection(selection: JourneySelection):
    token = _ACTIVE_SELECTION.set(selection)
    try:
        yield selection
    finally:
        _ACTIVE_SELECTION.reset(token)


def active_journey_selection() -> JourneySelection | None:
    return _ACTIVE_SELECTION.get()


def read_requested_cases(environment: Mapping[str, str]) -> tuple[str, ...]:
    """Read the pre-resolution request through the same environment boundary."""
    return _csv_set(environment, "KB_JOURNEY_CASES", required=False)


def _csv_set(environment: Mapping[str, str], key: str, *, required: bool) -> tuple[str, ...]:
    if key not in environment:
        if required:
            raise JourneySelectionError(f"{key} is missing while claim selection is active")
        return ()
    raw = environment[key]
    if not raw:
        if required:
            raise JourneySelectionError(f"{key} is empty while claim selection is active")
        return ()
    values = tuple(item.strip() for item in raw.split(","))
    if any(not item for item in values):
        raise JourneySelectionError(f"{key} must be a comma-separated list of non-empty values")
    if required and not values:
        raise JourneySelectionError(f"{key} is empty while claim selection is active")
    if len(values) != len(set(values)):
        raise JourneySelectionError(f"{key} contains duplicate values")
    return values


def _json_array(environment: Mapping[str, str], key: str, *, required: bool) -> tuple[str, ...]:
    if key not in environment:
        if required:
            raise JourneySelectionError(f"{key} is missing while claim selection is active")
        return ()
    try:
        value = json.loads(environment[key])
    except json.JSONDecodeError as error:
        raise JourneySelectionError(f"{key} must be a JSON array of non-empty strings: {error.msg}") from error
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise JourneySelectionError(f"{key} must be a JSON array of non-empty strings")
    if len(value) != len(set(value)):
        raise JourneySelectionError(f"{key} contains duplicate values")
    return tuple(value)


def read_journey_selection(environment: Mapping[str, str], *, strict: bool = False,
                           default_runner_selector: str = "agent:commit") -> JourneySelection:
    """Read and validate all selection metadata exactly once at runner entry."""
    lease_raw = environment.get("KB_JOURNEY_EXECUTION_LEASE_JSON")
    if lease_raw:
        return _read_execution_lease(lease_raw, environment, default_runner_selector)
    requested = read_requested_cases(environment)
    claims = _csv_set(environment, "KB_JOURNEY_SELECTED_STEPS", required=bool(requested) and strict)
    active = bool(requested or claims)
    if active and strict and not requested:
        raise JourneySelectionError("KB_JOURNEY_CASES is missing while claim selection is active")
    if active and strict and not claims:
        raise JourneySelectionError("KB_JOURNEY_SELECTED_STEPS is missing while claim selection is active")
    capability_key = "KB_JOURNEY_SELECTED_CAPABILITIES"
    if active and strict and capability_key not in environment:
        raise JourneySelectionError(f"{capability_key} is missing while claim selection is active")
    capabilities = _csv_set(environment, capability_key, required=False)
    prerequisites = _json_array(environment, "KB_JOURNEY_PREREQUISITE_STEPS", required=active and strict)
    flows = _json_array(environment, "KB_JOURNEY_PREREQUISITE_FLOWS", required=active and strict)

    owners_key = "KB_JOURNEY_SELECTED_OWNING_STEPS"
    if owners_key not in environment:
        if active and strict:
            raise JourneySelectionError(f"{owners_key} is missing while claim selection is active")
        owners: dict[str, tuple[str, ...]] = {}
    else:
        try:
            owner_payload = json.loads(environment[owners_key])
        except json.JSONDecodeError as error:
            raise JourneySelectionError(f"{owners_key} must be a JSON object mapping step names to claim IDs: {error.msg}") from error
        if not isinstance(owner_payload, dict):
            raise JourneySelectionError(f"{owners_key} must be a JSON object mapping step names to claim IDs")
        owners = {}
        for name, owner_claims in owner_payload.items():
            if not isinstance(name, str) or not name or not isinstance(owner_claims, list) or not owner_claims \
                    or any(not isinstance(claim, str) or not claim for claim in owner_claims):
                raise JourneySelectionError(
                    f"{owners_key} values must be non-empty arrays of claim IDs keyed by non-empty step names")
            if len(owner_claims) != len(set(owner_claims)):
                raise JourneySelectionError(f"{owners_key}[{name!r}] contains duplicate claim IDs")
            owners[name] = tuple(owner_claims)
        if active and strict and not owners:
            raise JourneySelectionError(
                f"{owners_key} is empty while {claims!r} is selected; the resolver must provide owning steps")
        unknown_claims = sorted({claim for values in owners.values() for claim in values} - set(claims))
        if active and strict and unknown_claims:
            raise JourneySelectionError(
                f"{owners_key} names claims not present in KB_JOURNEY_SELECTED_STEPS: {', '.join(unknown_claims)}")

    selector_key = "KB_JOURNEY_RUNNER_SELECTOR"
    host_selector_key = "KB_JOURNEY_ONLY"
    if selector_key not in environment and active and strict:
        raise JourneySelectionError(f"{selector_key} is missing while claim selection is active")
    selector = environment.get(selector_key, default_runner_selector)
    requested_runners = environment.get(host_selector_key, "")
    if active and strict and not selector:
        raise JourneySelectionError(f"{selector_key} is missing or empty while claim selection is active")
    if selector and not re.fullmatch(r"[a-z0-9-]+:[a-z0-9-]+", selector):
        raise JourneySelectionError(f"{selector_key} must be a registered runner selector")
    requested_selector_values = _csv_set(environment, host_selector_key, required=False)
    if requested_selector_values and any(
            not re.fullmatch(r"[a-z0-9-]+:[a-z0-9-]+", item) for item in requested_selector_values):
        raise JourneySelectionError(f"{host_selector_key} must be a comma-separated list of runner selectors")

    return JourneySelection(requested, frozenset(claims), owners, frozenset(prerequisites),
                            frozenset(flows), frozenset(capabilities), selector, requested_runners)


def _read_execution_lease(raw: str, environment: Mapping[str, str], default_runner_selector: str) -> JourneySelection:
    try:
        lease = json.loads(raw)
    except json.JSONDecodeError as error:
        raise JourneySelectionError(f"KB_JOURNEY_EXECUTION_LEASE_JSON must be a JSON object: {error.msg}") from error
    required = ("schema", "planId", "sourceSHA", "shardId", "attemptId", "mode", "runner",
                "claimIds", "directStepIds", "directStepNames", "selectedStepNames", "steps")
    if not isinstance(lease, dict) or any(key not in lease for key in required):
        raise JourneySelectionError("execution lease is missing required identity or selection fields")
    if lease["schema"] != "kb.devkit-journey-shard-lease/v1" or not all(
            isinstance(lease[key], str) and lease[key] for key in ("planId", "sourceSHA", "shardId", "attemptId")):
        raise JourneySelectionError("execution lease identity is invalid")
    if lease["mode"] not in {"local", "secured"} or not isinstance(lease["runner"], str) or not lease["runner"]:
        raise JourneySelectionError("execution lease mode or runner is invalid")
    if not re.fullmatch(r"[a-z0-9-]+:[a-z0-9-]+", lease["runner"]):
        raise JourneySelectionError("execution lease runner must be a registered selector")
    for key in ("claimIds", "directStepIds", "directStepNames", "selectedStepNames"):
        values = lease[key]
        if not isinstance(values, list) or any(not isinstance(item, str) or not item for item in values) or len(values) != len(set(values)):
            raise JourneySelectionError(f"execution lease {key} must be a unique array of non-empty strings")
    if not isinstance(lease["steps"], list) or not lease["steps"]:
        raise JourneySelectionError("execution lease steps must be a non-empty array")
    expected_names = set()
    expected_ids = set()
    direct_names = set(lease["directStepNames"])
    claims = set(lease["claimIds"])
    owners: dict[str, tuple[str, ...]] = {}
    prerequisites, flows = set(), set()
    for step in lease["steps"]:
        if not isinstance(step, dict) or not all(isinstance(step.get(key), str) and step[key] for key in ("id", "name", "kind")):
            raise JourneySelectionError("execution lease contains an invalid step identity")
        if step["id"] in expected_ids or step["name"] in expected_names:
            raise JourneySelectionError("execution lease contains duplicate step identities")
        if step["kind"] not in {"step", "flow"} or not isinstance(step.get("direct"), bool):
            raise JourneySelectionError("execution lease contains an invalid step kind or role")
        step_claims = step.get("claimIds", [])
        if not isinstance(step_claims, list) or any(not isinstance(item, str) or not item for item in step_claims):
            raise JourneySelectionError("execution lease step claimIds must be non-empty strings")
        expected_names.add(step["name"])
        expected_ids.add(step["id"])
        if step["direct"]:
            if step["name"] not in direct_names:
                raise JourneySelectionError("execution lease direct step names do not match its step rows")
            if step_claims:
                owners[step["name"]] = tuple(step_claims)
        elif step["kind"] == "step":
            prerequisites.add(step["name"])
        else:
            flows.add(step["name"])
    if expected_names != set(lease["selectedStepNames"]):
        raise JourneySelectionError("execution lease selected step names do not match its step rows")
    if set(lease["directStepNames"]) - expected_names:
        raise JourneySelectionError("execution lease direct step is absent from its step rows")
    if set(claim for values in owners.values() for claim in values) != claims:
        raise JourneySelectionError("execution lease direct step claims do not match claimIds")
    if set(step["id"] for step in lease["steps"] if step["direct"]) != set(lease["directStepIds"]):
        raise JourneySelectionError("execution lease direct step IDs do not match its step rows")
    selector = environment.get("KB_JOURNEY_RUNNER_SELECTOR", lease["runner"])
    if selector != lease["runner"] or environment.get("KB_JOURNEY_ONLY", lease["runner"]) != lease["runner"]:
        raise JourneySelectionError("runner selector does not match the execution lease")
    return JourneySelection(tuple(lease["claimIds"]), frozenset(claims), owners, frozenset(prerequisites),
                            frozenset(flows), frozenset(), lease["runner"], lease["runner"],
                            tuple(lease["selectedStepNames"]), tuple(lease["directStepNames"]), lease)
