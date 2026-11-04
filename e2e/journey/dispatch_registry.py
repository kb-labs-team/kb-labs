#!/usr/bin/env python3
"""Single source for journey claim routing and runner entry points."""
from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass
from invocations import print_report_text


@dataclass(frozen=True)
class Runner:
    selector: str
    front_door: str
    scenario: str
    variant: str
    mode: str
    service_profile: str = ""
    journey_sources: tuple[str, ...] = ("e2e/journey/runner.py",)
    claim_family: str = ""
    lane: str = ""
    batch_default: bool = False


MARKETPLACE_REGISTRY_LANE = "marketplace-registry"


RUNNERS = {
    "agent:explore": Runner("agent:explore", "agent", "explore", "default", "local"),
    "agent:commit": Runner("agent:commit", "agent", "commit", "default", "local", claim_family="journey"),
    "agent-secured:commit": Runner("agent-secured:commit", "agent", "commit", "secured",
                                    "secured", claim_family="journey"),
    "agent-input:commit": Runner("agent-input:commit", "agent", "commit", "input", "local"),
    "agent-relative:commit": Runner("agent-relative:commit", "agent", "commit", "relative-path", "local"),
    "human:default": Runner("human:default", "human", "explore", "human-default", "local"),
    "human:nondefault": Runner("human:nondefault", "human", "commit", "human-nondefault", "local"),
    "negative:wrong-node": Runner("negative:wrong-node", "agent", "explore", "wrong-node", "local"),
    "negative:occupied-port": Runner("negative:occupied-port", "agent", "explore", "occupied-port", "local"),
    "service-local:explore": Runner(
        "service-local:explore", "agent", "explore", "default", "local", "nightly",
        ("e2e/journey/runner.py", "e2e/journey/service_runner.py"), claim_family="service", batch_default=True),
    "service-secured:explore": Runner(
        "service-secured:explore", "human", "explore", "secured", "secured", "nightly",
        ("e2e/journey/runner.py", "e2e/journey/service_runner.py"), claim_family="service", batch_default=True),
    "service-marketplace-registry:local": Runner(
        "service-marketplace-registry:local", "agent", "explore", "default", "local", "nightly",
        ("e2e/journey/runner.py", "e2e/journey/service_runner.py"), lane=MARKETPLACE_REGISTRY_LANE),
    "service-marketplace-registry:secured": Runner(
        "service-marketplace-registry:secured", "human", "explore", "secured", "secured", "nightly",
        ("e2e/journey/runner.py", "e2e/journey/service_runner.py"), lane=MARKETPLACE_REGISTRY_LANE),
}
RUNNER_GROUPS = {
    "service-modes": ("agent:commit", "service-secured:explore"),
}

def runners_for_source(source: str, mode: str) -> set[str]:
    if source in {
        "e2e/journey/service_runner.py",
        "e2e/journey/steps/auth.py",
        "e2e/journey/steps/accounts.py",
        "e2e/journey/studio_steps.py",
    } or source.startswith("e2e/studio/"):
        claim_family = "service"
    elif source.startswith("e2e/journey/"):
        claim_family = "journey"
    else:
        return set()
    return {selector for selector, runner in RUNNERS.items()
            if runner.claim_family == claim_family and runner.mode == mode}


def selector_supports_claim_sources(selector: str, selected_runners: list[str]) -> bool:
    required = set(RUNNER_GROUPS.get(selector, (selector,)))
    return bool(required) and required.issubset(set(selected_runners))


def lanes_for_runners(selectors: list[str] | tuple[str, ...] | set[str]) -> list[str]:
    """Resolve composition lanes from the selected runner declarations."""
    unknown = set(selectors) - RUNNERS.keys() - RUNNER_GROUPS.keys()
    if unknown:
        raise ValueError(f"unknown journey runner selector(s): {', '.join(sorted(unknown))}")
    expanded = {runner for selector in selectors for runner in RUNNER_GROUPS.get(selector, (selector,))}
    return sorted({RUNNERS[runner].lane for runner in expanded if RUNNERS[runner].lane})


def lane_for_runner(selector: str) -> str:
    runner = RUNNERS.get(selector)
    if runner is None:
        raise ValueError(f"unknown journey runner selector: {selector}")
    return runner.lane


def runner_payload(runner: Runner) -> dict[str, object]:
    payload = asdict(runner)
    del payload["batch_default"]
    return payload


def main() -> int:
    if len(sys.argv) == 3 and sys.argv[1] == "--runner":
        runner = RUNNERS.get(sys.argv[2])
        if runner is None:
            raise ValueError(f"unknown journey runner selector: {sys.argv[2]}")
        print_report_text(json.dumps(runner_payload(runner)), flush=True)
        return 0
    if len(sys.argv) == 3 and sys.argv[1] == "--dispatch":
        selector = sys.argv[2]
        selectors = RUNNER_GROUPS.get(selector, (selector,))
        runners = []
        for item in selectors:
            runner = RUNNERS.get(item)
            if runner is None:
                raise ValueError(f"unknown journey runner selector: {item}")
            runners.append(runner_payload(runner))
        print_report_text(json.dumps(runners), flush=True)
        return 0
    if len(sys.argv) == 3 and sys.argv[1] == "--batch-mode":
        mode = sys.argv[2]
        if mode not in {"local", "secured"}:
            raise ValueError(f"unsupported journey batch mode: {mode}")
        selectors = sorted(selector for selector, runner in RUNNERS.items()
                           if runner.mode == mode and runner.batch_default)
        print_report_text(json.dumps(selectors), flush=True)
        return 0
    if len(sys.argv) == 3 and sys.argv[1] == "--supports":
        selection = json.load(sys.stdin)
        return 0 if selector_supports_claim_sources(sys.argv[2], selection.get("runners", [])) else 2
    if len(sys.argv) == 3 and sys.argv[1] == "--lanes":
        print_report_text(json.dumps(lanes_for_runners(sys.argv[2].split(","))), flush=True)
        return 0
    raise ValueError("usage: dispatch_registry.py --runner <selector> | --dispatch <selector> | --supports <selector> | --lanes <selectors>")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ValueError as error:
        print_report_text(str(error), stream=sys.stderr, flush=True)
        raise SystemExit(2)
    except Exception as error:
        print_report_text(f"Journey dispatch failed: {error.__class__.__name__}: {error}",
                          stream=sys.stderr, flush=True)
        raise SystemExit(1)
