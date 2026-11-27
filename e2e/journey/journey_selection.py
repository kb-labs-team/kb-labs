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
    completion_owners: dict[str, tuple[str, ...]] | None = None

    @property
    def active(self) -> bool:
        return bool(self.claims)


SELECTION_KEYS = (
    "KB_JOURNEY_CASES",
    "KB_JOURNEY_SELECTED_STEPS",
    "KB_JOURNEY_SELECTED_OWNING_STEPS",
    "KB_JOURNEY_SELECTED_COMPLETION_OWNERS",
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


def _owner_map(environment: Mapping[str, str], key: str) -> dict[str, tuple[str, ...]] | None:
    if key not in environment:
        return None
    try:
        payload = json.loads(environment[key])
    except json.JSONDecodeError as error:
        raise JourneySelectionError(
            f"{key} must be a JSON object mapping step names to claim IDs: {error.msg}") from error
    if not isinstance(payload, dict):
        raise JourneySelectionError(f"{key} must be a JSON object mapping step names to claim IDs")
    owners = {}
    for name, claims in payload.items():
        if not isinstance(name, str) or not name or not isinstance(claims, list) or not claims \
                or any(not isinstance(claim, str) or not claim for claim in claims):
            raise JourneySelectionError(
                f"{key} values must be non-empty arrays of claim IDs keyed by non-empty step names")
        if len(claims) != len(set(claims)):
            raise JourneySelectionError(f"{key}[{name!r}] contains duplicate claim IDs")
        owners[name] = tuple(claims)
    return owners


def read_journey_selection(environment: Mapping[str, str], *, strict: bool = False,
                           default_runner_selector: str = "agent:commit") -> JourneySelection:
    """Read and validate all selection metadata exactly once at runner entry."""
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
    owners = _owner_map(environment, owners_key)
    if active and strict:
        if owners is None:
            raise JourneySelectionError(f"{owners_key} is missing while claim selection is active")
        if not owners:
            raise JourneySelectionError(
                f"{owners_key} is empty while {claims!r} is selected; the resolver must provide owning steps")
        unknown_claims = sorted({claim for values in owners.values() for claim in values} - set(claims))
        if unknown_claims:
            raise JourneySelectionError(
                f"{owners_key} names claims not present in KB_JOURNEY_SELECTED_STEPS: {', '.join(unknown_claims)}")
    owners = owners or {}

    completion_key = "KB_JOURNEY_SELECTED_COMPLETION_OWNERS"
    completion_owners = _owner_map(environment, completion_key)
    if active and strict and completion_owners is not None:
        for name, step_claims in completion_owners.items():
            if name in owners and set(step_claims) <= set(owners[name]):
                continue
            raise JourneySelectionError(
                f"{completion_key}[{name!r}] must contain only selected claims for that step")

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
                            frozenset(flows), frozenset(capabilities), selector, requested_runners,
                            completion_owners)
