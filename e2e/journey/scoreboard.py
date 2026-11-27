#!/usr/bin/env python3
"""Score product-case claim coverage from installed-platform journey reports."""
from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Iterable
from invocations import print_report_text, write_report_json, write_report_text
import jsonl
from journey_dependencies import Dependency
from scoreboard_contract import RELEASE_GATING_MODES

CASE_STEP = re.compile(r"^\|\s*((?:S|PC)-\d+\.\d+)\s*\|", re.MULTILINE)
CLAIM_TAG = re.compile(r"@(S|PC)-(\d+\.\d+)")
MODES = ("local", "secured")
FAILURE_MAX_LENGTH = 180


def _yaml_scalar(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def load_cases(catalog: Path) -> list[dict]:
    cases = []
    for path in sorted(catalog.glob("*.md")):
        source = path.read_text(encoding="utf-8")
        if not source.startswith("---\n"):
            continue
        _, frontmatter, body = source.split("---", 2)
        fields = dict(re.findall(r"^(id|title|status|release|modes):\s*(.*?)\s*$", frontmatter, re.MULTILINE))
        if "id" not in fields:
            continue
        modes_match = re.match(r"^\[([^]]*)\]$", fields.get("modes", "").strip())
        modes = [_yaml_scalar(value) for value in modes_match.group(1).split(",") if _yaml_scalar(value)] if modes_match else []
        steps = sorted(set(CASE_STEP.findall(body)), key=claim_sort_key)
        cases.append({"id": fields["id"], "title": fields.get("title", ""),
                      "status": _yaml_scalar(fields.get("status", "")),
                      "release": _yaml_scalar(fields.get("release", "")) == "true",
                      "modes": modes, "claims": steps})
    return cases


def release_claims_for_case(case_id: str, catalog: Path) -> list[str]:
    """Return claims only when the catalog marks the case active and release-ready."""
    case = next((item for item in load_cases(catalog) if item["id"] == case_id), None)
    if case is None or case["status"] != "active" or not case["release"]:
        return []
    return case["claims"]


def claim_sort_key(claim: str) -> tuple[str, int]:
    case, step = claim.rsplit(".", 1)
    return case, int(step)


def _record(evidence: dict[str, list[dict]], claim_id: str, status: str, source: str, reason: str = "") -> None:
    if status not in {"PASS", "FAIL", "BLOCKED"}:
        return
    evidence[claim_id].append({"status": status, "source": source, **({"reason": reason} if reason else {})})


def _journey_evidence(data: dict, path: Path, evidence: dict[str, list[dict]]) -> None:
    for claim in data.get("case_run", {}).get("claims", []):
        if isinstance(claim, dict) and isinstance(claim.get("claimId"), str):
            _record(evidence, claim["claimId"], claim.get("status", ""), path.name)
    for step in data.get("steps", []):
        if not isinstance(step, dict):
            continue
        status = step.get("status")
        if status not in {"PASS", "FAIL", "BLOCKED"}:
            continue
        for claim_id in step.get("cases", []):
            if isinstance(claim_id, str):
                _record(evidence, claim_id, status, path.name, str(step.get("message", "")))


def _playwright_status(spec: dict) -> tuple[str, str]:
    tests = spec.get("tests", [])
    results = [result for test in tests for result in test.get("results", []) if isinstance(result, dict)]
    if any(result.get("status") in {"failed", "timedOut", "interrupted"} for result in results):
        return "FAIL", "Playwright test failed"
    if results and all(result.get("status") == "passed" for result in results):
        return "PASS", ""
    if results and all(result.get("status") == "skipped" for result in results):
        annotations = [annotation.get("description", "") for test in tests
                       for annotation in test.get("annotations", []) if isinstance(annotation, dict)]
        return "BLOCKED", "; ".join(item for item in annotations if item) or "Playwright test was skipped"
    if spec.get("ok") is True:
        return "PASS", ""
    return "FAIL", "Playwright spec did not pass"


def _walk_playwright(suites: Iterable[dict], path: Path, evidence: dict[str, list[dict]]) -> None:
    for suite in suites:
        for spec in suite.get("specs", []):
            if not isinstance(spec, dict):
                continue
            title = str(spec.get("title", ""))
            tags = set(spec.get("tags", []))
            tags.update(f"{match.group(1)}-{match.group(2)}" for match in CLAIM_TAG.finditer(title))
            status, reason = _playwright_status(spec)
            for claim_id in tags:
                if isinstance(claim_id, str) and re.fullmatch(r"(?:S|PC)-\d+\.\d+", claim_id):
                    _record(evidence, claim_id, status, path.name, reason)
        _walk_playwright(suite.get("suites", []), path, evidence)


def load_evidence(directory: Path, modes: Iterable[str]) -> dict[str, dict[str, list[dict]]]:
    evidence = {mode: defaultdict(list) for mode in modes}
    if not directory.is_dir():
        return evidence
    for path in sorted(directory.glob("*.json")):
        if path.name.startswith("case-scoreboard"):
            continue
        if not (path.name.startswith(("service-", "service-auth-", "installer-case-", "platform-"))
                or path.name.startswith("studio-playwright-")):
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        if not isinstance(data, dict):
            continue
        if data.get("case_run", {}).get("selection"):
            continue
        if path.name.startswith("studio-playwright-"):
            mode = "secured" if "secured" in path.stem else "local"
            if mode in evidence:
                _walk_playwright(data.get("suites", []), path, evidence[mode])
            continue
        mode = data.get("case_run", {}).get("mode")
        if mode not in evidence:
            mode = next((candidate for candidate in MODES if candidate in path.stem), None)
        if mode in evidence:
            _journey_evidence(data, path, evidence[mode])
    return evidence


def _status(claims: list[str], observed: dict[str, list[dict]], applicable_modes: list[str]) -> tuple[str, list[str]]:
    if not claims:
        return "Unclaimed", []
    all_results = [result for claim_id in claims for mode in applicable_modes
                   for result in observed.get(mode, {}).get(claim_id, [])]
    if not all_results:
        return "Unclaimed", []
    passed_claims = {claim_id for claim_id in claims
                     if any(result["status"] == "PASS" for mode in applicable_modes
                            for result in observed.get(mode, {}).get(claim_id, []))}
    complete = all(any(result["status"] == "PASS" for result in observed.get(mode, {}).get(claim_id, []))
                   and all(result["status"] == "PASS" for result in observed.get(mode, {}).get(claim_id, []))
                   for mode in applicable_modes for claim_id in claims)
    if complete:
        return "Fully green", sorted(passed_claims, key=claim_sort_key)
    if passed_claims:
        return "Partial", sorted(passed_claims, key=claim_sort_key)
    if any(result["status"] == "FAIL" for result in all_results):
        return "Red", []
    if any(result["status"] == "BLOCKED" for result in all_results):
        return "Blocked", []
    return "Unclaimed", []


def _blocking_report(directory: Path, cases: list[dict], mode: str, evidence: dict) -> dict:
    """Rank failed journey steps by the claims reachable through their declared dependencies."""
    steps_by_file: dict[str, list[dict]] = {}
    states_by_file: dict[str, dict] = {}
    invocation_errors: dict[str, set[tuple[str, str, str | None]]] = defaultdict(set)
    unreadable_invocation_rows = []
    calls_path = directory / "invocations" / "calls.jsonl"
    if calls_path.is_file():
        for row in jsonl.read_jsonl(calls_path, errors="replace"):
            if row.error is not None:
                unreadable_invocation_rows.append(row.line_number)
                continue
            call = row.value
            if not isinstance(call, dict):
                continue
            step_ids = call.get("step_id")
            envelope = call.get("error_envelope")
            if not isinstance(step_ids, str) or not isinstance(envelope, dict):
                continue
            code = envelope.get("code")
            area = envelope.get("area")
            stage = envelope.get("stage")
            if not isinstance(code, str) or not isinstance(area, str):
                continue
            identity = (code, area, stage if isinstance(stage, str) else None)
            for step_id in step_ids.split(","):
                invocation_errors[step_id].add(identity)
    if directory.is_dir():
        for path in sorted(directory.glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError):
                continue
            if (not isinstance(data, dict)
                    or data.get("schema") == "kb.journey-case-scoreboard/v2"
                    or data.get("case_run", {}).get("selection")):
                continue
            file_mode = data.get("case_run", {}).get("mode")
            steps = data.get("steps", [])
            if not isinstance(steps, list):
                continue
            mode_steps = [step for step in steps if isinstance(step, dict)
                          and (step.get("mode") == mode or file_mode == mode)]
            if not mode_steps:
                continue
            steps_by_file[path.name] = mode_steps
            states_by_file[path.name] = data.get("states", {}) if isinstance(data.get("states"), dict) else {}

    roots = []
    unresolved_owners = []
    unresolved_dependencies = []

    def report_unresolved_owner(source: str, state: str, step: str | None) -> None:
        unresolved_owners.append({"source": source, "state": state, "step": step})

    allowed_claims = {claim for case in cases if case["status"] == "active" and mode in case["modes"]
                      for claim in case["claims"]}
    steps_by_id: dict[str, list[tuple[str, dict]]] = defaultdict(list)
    graph: dict[str, set[str]] = defaultdict(set)
    for filename, steps in steps_by_file.items():
        for step in steps:
            step_id = step.get("stepId")
            if isinstance(step_id, str):
                steps_by_id[step_id].append((filename, step))
                graph.setdefault(step_id, set())
    state_owners: dict[str, set[str]] = defaultdict(set)
    for filename, states in states_by_file.items():
        for state, value in states.items():
            if isinstance(value, dict) and isinstance(value.get("step"), str):
                owner_id = value["step"]
                if owner_id in steps_by_id:
                    state_owners[state].add(owner_id)
                else:
                    report_unresolved_owner(filename, state, owner_id)
    for filename, steps in steps_by_file.items():
        for step in steps:
            step_id = step.get("stepId")
            if not isinstance(step_id, str):
                continue
            details = step.get("details") if isinstance(step.get("details"), dict) else {}
            requirements = details.get("requires", [])
            dependencies = [Dependency.parse(item) for item in requirements if isinstance(item, str)] \
                if isinstance(requirements, list) else []
            for dependency in dependencies:
                if dependency.kind in {"step", "flow"} and dependency.name in steps_by_id:
                    graph[step_id].add(dependency.name)
                elif dependency.kind in {"step", "flow"}:
                    unresolved_dependencies.append({"source": filename, "stepId": step_id,
                                                    "requiredStepId": dependency.name})
                elif dependency.kind == "state":
                    owners = state_owners.get(dependency.name, set())
                    if owners:
                        graph[step_id].update(owners)
                    elif not any(dependency.name in states for states in states_by_file.values()):
                        report_unresolved_owner(filename, dependency.name, None)
    reverse: dict[str, set[str]] = defaultdict(set)
    for consumer, prerequisites in graph.items():
        for prerequisite in prerequisites:
            reverse[prerequisite].add(consumer)
    state_root_ids = {
        value.get("step")
        for states in states_by_file.values()
        for value in states.values()
        if isinstance(value, dict) and value.get("passed") is False and isinstance(value.get("step"), str)
    }
    for filename, steps in steps_by_file.items():
        for root_step in steps:
            root_id = root_step.get("stepId")
            if not isinstance(root_id, str):
                continue
            if root_step.get("status") != "FAIL":
                continue
            reached: set[str] = set()
            # Reverse edges: find all blocked steps transitively depending on this failure.
            pending = list(reverse.get(root_id, set()))
            while pending:
                current = pending.pop()
                if current in reached:
                    continue
                reached.add(current)
                pending.extend(reverse.get(current, set()))
            affected_claims = set(claim for claim in root_step.get("cases", [])
                                  if isinstance(claim, str) and claim in allowed_claims)
            blocked_cases = set()
            for reached_name in reached:
                for _, dependent in steps_by_id[reached_name]:
                    if dependent.get("status") == "BLOCKED":
                        for claim in dependent.get("cases", []):
                            if isinstance(claim, str) and claim in allowed_claims:
                                affected_claims.add(claim)
            blocked_cases.update(claim.rsplit(".", 1)[0] for claim in affected_claims)
            state_root = root_id in state_root_ids
            details = root_step.get("details") if isinstance(root_step.get("details"), dict) else {}
            error = details.get("error") if isinstance(details.get("error"), dict) else {}
            error_code = error.get("code") if isinstance(error.get("code"), str) else None
            error_message = error.get("message") if isinstance(error.get("message"), str) else None
            recorded_message = root_step.get("message")
            failure = (f"{error_code}: {error_message}"
                       if error_code and error_message else
                       recorded_message if isinstance(recorded_message, str) and recorded_message else
                       "failure message unavailable")
            failure = " ".join(failure.split())
            failure = failure[:FAILURE_MAX_LENGTH]
            if root_id.startswith("case:"):
                invocation_step_ids = root_id.removeprefix("case:").split(",")
            else:
                invocation_step_ids = [root_id]
            error_envelopes = {identity for step_id in invocation_step_ids
                               for identity in invocation_errors.get(step_id, set())}
            roots.append({"mode": mode, "source": filename, "stepId": root_id,
                          "step": root_step.get("name", root_id),
                          "failure": failure,
                          "errorEnvelopes": error_envelopes,
                          "layer": 0 if state_root else 1, "stateRoot": state_root,
                          "unblockedClaims": len(affected_claims),
                          "claims": sorted(affected_claims, key=claim_sort_key),
                          "blockedStepIds": sorted(name for name in reached if any(
                              step.get("status") == "BLOCKED" for _, step in steps_by_id[name])),
                          "blockedStepCount": sum(any(step.get("status") == "BLOCKED"
                                                      for _, step in steps_by_id[name]) for name in reached),
                          "blockedCaseIds": sorted(blocked_cases)})

    deduplicated = {}
    for root in roots:
        key = root["stepId"]
        existing = deduplicated.get(key)
        if existing is None:
            root["_failureMessages"] = {root["failure"]}
            deduplicated[key] = root
            continue
        existing["_failureMessages"].add(root["failure"])
        existing["claims"] = sorted(set(existing["claims"]) | set(root["claims"]), key=claim_sort_key)
        existing["errorEnvelopes"].update(root["errorEnvelopes"])
        existing["unblockedClaims"] = len(existing["claims"])
        existing["blockedCaseIds"] = sorted(set(existing["blockedCaseIds"]) | set(root["blockedCaseIds"]))
        existing["blockedStepIds"] = sorted(set(existing["blockedStepIds"]) | set(root["blockedStepIds"]))
        existing["blockedStepCount"] = len(existing["blockedStepIds"])
        existing["stateRoot"] = existing["stateRoot"] or root["stateRoot"]
        existing["layer"] = 0 if existing["stateRoot"] else 1
        existing["source"] = ", ".join(sorted(set(existing["source"].split(", ")) | {root["source"]}))
    roots = list(deduplicated.values())
    for root in roots:
        root["failure"] = " | ".join(sorted(root.pop("_failureMessages")))[:FAILURE_MAX_LENGTH]
    grouped_roots: dict[tuple[str, str, str | None] | None, dict] = {}
    for root in roots:
        identities = root["errorEnvelopes"] or {None}
        for identity in identities:
            group = grouped_roots.setdefault(identity, {"error": None if identity is None else {
                "code": identity[0], "area": identity[1], **({"stage": identity[2]} if identity[2] else {})},
                "rootStepIds": [], "claims": set()})
            group["rootStepIds"].append(root["stepId"])
            group["claims"].update(root["claims"])
    root_groups = [{**group, "rootStepIds": sorted(set(group["rootStepIds"])),
                    "claims": sorted(group["claims"], key=claim_sort_key),
                    "unblockedClaims": len(group["claims"])}
                   for group in grouped_roots.values()]
    root_groups.sort(key=lambda group: (-group["unblockedClaims"],
                                        group["error"]["code"] if group["error"] else "",
                                        group["error"]["area"] if group["error"] else "",
                                        group["error"].get("stage", "") if group["error"] else ""))
    for root in roots:
        root.pop("errorEnvelopes", None)
    roots.sort(key=lambda item: (item["blockedStepCount"] == 0,
                                 (item["blockedCaseIds"] or [""])[0] if item["blockedStepCount"] == 0 else "",
                                 item["layer"], -item["unblockedClaims"], item["step"], item["source"]))
    applicable = [case for case in cases if case["status"] == "active" and mode in case["modes"]]
    unclaimed = [case["id"] for case in applicable if not any(
        evidence.get(mode, {}).get(claim) for claim in case["claims"])]
    claims = {claim for case in applicable for claim in case["claims"]}
    observed = {claim: evidence.get(mode, {}).get(claim, []) for claim in claims}
    passing = sum(any(result.get("status") == "PASS" for result in results)
                  for results in observed.values())
    reachable = sum(bool(results) and not all(result.get("status") == "BLOCKED" for result in results)
                    for results in observed.values())
    fully_green = sum(_status(case["claims"], evidence, [mode])[0] == "Fully green"
                      for case in applicable)
    return {"mode": mode, "blockingRoots": roots, "rootGroups": root_groups,
            "unreadableInvocationRows": unreadable_invocation_rows, "unclaimedCases": unclaimed,
            "unresolvedStateOwners": unresolved_owners,
            "unresolvedDependencies": unresolved_dependencies,
            "headline": {"activeCasesFullyGreen": {"count": fully_green, "total": len(applicable)},
                         "claimsPassing": {"count": passing, "total": len(claims)},
                         "claimsReachable": {"count": reachable, "total": len(claims)}}}

def build_scoreboard(directory: Path, catalog: Path, modes: Iterable[str],
                    requested_selection: Iterable[str] = ()) -> dict:
    modes = list(modes)
    cases = load_cases(catalog)
    evidence = load_evidence(directory, modes)
    observed_modes = [mode for mode in MODES if any(
        path.name.startswith((f"service-{mode}", f"service-auth-{mode}", f"installer-case-{mode}",
                             f"platform-{mode}", f"studio-playwright-{mode}"))
        for path in directory.glob("*.json"))] if directory.is_dir() else []
    partial_selections = list(requested_selection)
    if directory.is_dir():
        for path in sorted(directory.glob("*.json")):
            if path.name.startswith("case-scoreboard"):
                continue
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError):
                continue
            case_run = data.get("case_run", {}) if isinstance(data, dict) else {}
            partial_selections.extend(case_run.get("selection", []))
    if partial_selections:
        evidence = {mode: defaultdict(list) for mode in modes}
    rows = []
    planned_count = 0
    historical_count = 0
    for case in cases:
        relevant = [mode for mode in modes if mode in case["modes"]]
        if not relevant:
            continue
        if case["status"] == "planned":
            planned_count += 1
            continue
        if case["status"] == "historical":
            historical_count += 1
            continue
        if case["status"] != "active":
            continue
        status, passing = _status(case["claims"], evidence, relevant)
        rows.append({**case, "caseStatus": case["status"], "status": status, "passingClaims": passing,
                     "claimedCount": sum(bool(evidence.get(mode, {}).get(claim_id)) for mode in relevant for claim_id in case["claims"]),
                     "claimCount": len(case["claims"])})
    gated_modes = [mode for mode in modes if mode in RELEASE_GATING_MODES]
    release_cases = [case for case in cases
                     if case["status"] == "active" and case["release"]
                     and any(mode in case["modes"] for mode in gated_modes)]
    mode_reports = {mode: _blocking_report(directory, cases, mode, evidence) for mode in modes}
    result = {
        "schema": "kb.journey-case-scoreboard/v2",
        "modes": modes,
        "releaseGate": {"modes": list(RELEASE_GATING_MODES), "gating": bool(gated_modes)},
        "selection": sorted(set(partial_selections)),
        "observedModes": observed_modes,
        "releaseCases": {"fullyGreen": sum(
            _status(case["claims"], evidence, gated_modes)[0] == "Fully green"
            for case in release_cases), "total": len(release_cases)},
        "activeCases": {"fullyGreen": sum(row["status"] == "Fully green" for row in rows),
                        "total": len(rows)},
        "plannedCount": planned_count,
        "historicalCount": historical_count,
        "cases": rows,
        "modeReports": mode_reports,
    }
    if len(modes) == 1:
        result.update(mode_reports[modes[0]])
    return result


def _render_mode_report(mode: str, report: dict) -> list[str]:
    headline = report["headline"]
    gate_label = "" if mode in RELEASE_GATING_MODES else " (non-gating for Release 1)"
    lines = [f"## {mode}: platform coverage{gate_label}", "",
             f"All active cases fully green: **{headline['activeCasesFullyGreen']['count']} / {headline['activeCasesFullyGreen']['total']}**.",
             f"Claims passing: **{headline['claimsPassing']['count']} / {headline['claimsPassing']['total']}**.",
             f"Claims reachable (not BLOCKED): **{headline['claimsReachable']['count']} / {headline['claimsReachable']['total']}**.",
             "", "### Root groups", ""]
    if report.get("rootGroups"):
        lines.extend(["| Error | Unblocked claims | Root step IDs |", "|---|---:|---|"])
        for group in report["rootGroups"]:
            error = group["error"]
            label = ("no envelope" if error is None else
                     f"{error['code']} ({error['area']}" +
                     (f"/{error['stage']}" if error.get("stage") else "") + ")")
            lines.append(f"| {label} | {group['unblockedClaims']} | " +
                         (", ".join(f"`{step_id}`" for step_id in group["rootStepIds"]) or "none") + " |")
    else:
        lines.append("No failed roots.")
    if report.get("unreadableInvocationRows"):
        lines.extend(["", "### Unreadable invocation records", "",
                      ", ".join(f"`invocations/calls.jsonl:{line}`"
                                for line in report["unreadableInvocationRows"])])
    lines.extend(["", "### Blocking roots", ""])
    if report["blockingRoots"]:
        lines.extend(["| Layer | Step ID | Step | Impacted claims | Blocked steps | Blocked cases | Failure |",
                      "|---:|---|---|---:|---|---|---|"])
        for root in report["blockingRoots"]:
            lines.append(f"| {root['layer']} | `{root['stepId']}` | {root['step']} | {root['unblockedClaims']} | "
                         f"{', '.join(f'`{step_id}`' for step_id in root['blockedStepIds']) or 'none'} | "
                         f"{', '.join(root['blockedCaseIds']) or 'none'} | {root['failure']} |")
    else:
        lines.append("No failed roots.")
    lines.extend(["", "### Unclaimed", "", ", ".join(report["unclaimedCases"]) or "None."])
    if report.get("unresolvedStateOwners"):
        lines.extend(["", "### Unresolved state owners", ""])
        lines.extend(
            (f"- {owner['source']} state `{owner['state']}` has no owner record."
             if owner["step"] is None else
             f"- {owner['source']} state `{owner['state']}` names missing step `{owner['step']}`.")
            for owner in report["unresolvedStateOwners"])
    if report.get("unresolvedDependencies"):
        lines.extend(["", "### Unresolved step dependencies", ""])
        lines.extend(f"- {dependency['source']} step `{dependency['stepId']}` requires missing step ID `"
                     f"{dependency['requiredStepId']}`."
                     for dependency in report["unresolvedDependencies"])
    return lines


def render_markdown(scoreboard: dict) -> str:
    modes = ", ".join(scoreboard["modes"]) or "none"
    counts = defaultdict(int)
    for case in scoreboard["cases"]:
        counts[case["status"]] += 1
    release = scoreboard["releaseCases"]
    active = scoreboard["activeCases"]
    gate_modes = ", ".join(scoreboard["releaseGate"]["modes"])
    gate_status = (f"Release 1 gate modes: {gate_modes}." if scoreboard["releaseGate"]["gating"]
                   else f"Release 1 gate modes: {gate_modes}; this scoreboard is non-gating.")
    lines = [f"# Product case scoreboard ({modes})", "", gate_status,
             (f"**Partial run**; selection: {', '.join(scoreboard['selection'])}." if scoreboard["selection"] else "Full run.")]
    for mode, report in scoreboard.get("modeReports", {}).items():
        lines.extend(["", *_render_mode_report(mode, report)])
    lines.extend(["", f"Release cases: **{release['fullyGreen']} / {release['total']}** fully green.",
                  f"All active cases: **{active['fullyGreen']} / {active['total']}** fully green.",
                  f"Planned cases: **{scoreboard['plannedCount']}**.",
                  f"Historical cases excluded: **{scoreboard['historicalCount']}**.",
                  "", "Active case statuses:", "", "| Status | Cases |", "|---|---:|"])
    for label in ("Fully green", "Partial", "Red", "Unclaimed", "Blocked"):
        if counts[label]:
            lines.append(f"| {label} | {counts[label]} |")
    green_cases = [case["id"] for case in scoreboard["cases"] if case["status"] == "Fully green"]
    lines.extend(["", "Fully green cases: " + (", ".join(green_cases) or "none") + "."])
    return "\n".join(lines) + "\n"


def render_journey_summary(scoreboard: dict) -> str:
    lines = ["## Platform blocking pyramid", ""]
    for mode, report in scoreboard.get("modeReports", {}).items():
        lines.extend(_render_mode_report(mode, report))
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _write_journey_summary(directory: Path, scoreboard: dict) -> None:
    path = directory / "journey-summary.md"
    start_marker = "<!-- kb-journey-scoreboard:start -->"
    end_marker = "<!-- kb-journey-scoreboard:end -->"
    previous = path.read_text(encoding="utf-8") if path.exists() else ""
    start = previous.find(start_marker)
    end = previous.find(end_marker)
    if (start == -1) != (end == -1) or (start != -1 and end < start):
        raise ValueError(f"journey summary has an incomplete scoreboard section: {path}")
    section = f"{start_marker}\n{render_journey_summary(scoreboard)}{end_marker}\n"
    if start == -1:
        updated = previous.rstrip() + ("\n\n" if previous.strip() else "") + section
    else:
        updated = previous[:start].rstrip() + "\n\n" + section + previous[end + len(end_marker):].lstrip("\n")
    write_report_text(path, updated)


def write_scoreboards(directory: Path, catalog: Path, requested_selection: Iterable[str] = ()) -> None:
    selection = list(requested_selection)
    outputs = {f"case-scoreboard-{mode}": build_scoreboard(directory, catalog, [mode], selection)
               for mode in MODES}
    outputs["case-scoreboard"] = build_scoreboard(directory, catalog, MODES, selection)
    _write_journey_summary(directory, outputs["case-scoreboard"])
    for stem, scoreboard in outputs.items():
        write_report_json(directory / f"{stem}.json", scoreboard)
        write_report_text(directory / f"{stem}.md", render_markdown(scoreboard))


def _fully_green(data: dict, mode: str) -> set[str]:
    return {case["id"] for case in data.get("cases", []) if case.get("status") == "Fully green"
            and case.get("release") is True and case.get("caseStatus") == "active"
            and mode in case.get("modes", [])}


def _all_active_green(data: dict, mode: str) -> set[str]:
    return {case["id"] for case in data.get("cases", []) if case.get("status") == "Fully green"
            and case.get("caseStatus") == "active" and mode in case.get("modes", [])}


def _claim_counts(data: dict, mode: str) -> tuple[int, int]:
    applicable = [case for case in data.get("cases", []) if mode in case.get("modes", [])]
    total = sum(len(case.get("claims", [])) for case in applicable)
    passing = sum(len(set(case.get("passingClaims", [])) & set(case.get("claims", [])))
                  for case in applicable)
    return passing, total


def render_delta(previous_dir: Path, current_dir: Path) -> str:
    lines = [f"Case scoreboard delta: {previous_dir.name} → {current_dir.name}"]
    for mode in MODES:
        previous_path = previous_dir / f"case-scoreboard-{mode}.json"
        current_path = current_dir / f"case-scoreboard-{mode}.json"
        if not previous_path.exists() or not current_path.exists():
            lines.extend(["", f"{mode}: missing scoreboard input ({previous_dir if not previous_path.exists() else current_dir})"])
            continue
        previous = json.loads(previous_path.read_text(encoding="utf-8"))
        current = json.loads(current_path.read_text(encoding="utf-8"))
        if previous.get("selection") or current.get("selection"):
            selection = sorted(set(previous.get("selection", [])) | set(current.get("selection", [])))
            lines.extend(["", f"{mode}: delta omitted because a scoreboard is partial (selection: {', '.join(selection)})."])
            continue
        if mode not in previous.get("observedModes", []) or mode not in current.get("observedModes", []):
            continue
        before_release = _fully_green(previous, mode)
        after_release = _fully_green(current, mode)
        before_active = _all_active_green(previous, mode)
        after_active = _all_active_green(current, mode)
        before_claims = _claim_counts(previous, mode)
        after_claims = _claim_counts(current, mode)
        lines.extend(["", f"{mode} release cases: fully green {previous['releaseCases']['fullyGreen']}/{previous['releaseCases']['total']} → "
                      f"{current['releaseCases']['fullyGreen']}/{current['releaseCases']['total']}",
                      f"  Claims passing: {before_claims[0]}/{before_claims[1]} → {after_claims[0]}/{after_claims[1]}",
                      "  Became fully green: " + (", ".join(sorted(after_release - before_release)) or "none"),
                      "  Regressed: " + (", ".join(sorted(before_release - after_release)) or "none"),
                      f"  All active: fully green {previous['activeCases']['fullyGreen']}/{previous['activeCases']['total']} → "
                      f"{current['activeCases']['fullyGreen']}/{current['activeCases']['total']}",
                      "  Became fully green: " + (", ".join(sorted(after_active - before_active)) or "none"),
                      "  Regressed: " + (", ".join(sorted(before_active - after_active)) or "none"),
                      f"  Planned cases: {previous['plannedCount']} → {current['plannedCount']}; "
                      f"historical excluded: {previous['historicalCount']} → {current['historicalCount']}"])
    return "\n".join(lines)


_VOLATILE_JOURNEY_HOME = re.compile(r"/tmp/kb-journey-home-[a-z0-9_]{8}/")
_VOLATILE_CLI_CORRELATION_ID = re.compile(r"Correlation ID: cli-\d+-[a-z0-9]+")


def _service_message_for_comparison(message: str) -> str:
    """Normalize only confirmed per-run home and CLI correlation values for comparison."""
    normalized = _VOLATILE_JOURNEY_HOME.sub("/tmp/kb-journey-home-<run>/", message)
    return _VOLATILE_CLI_CORRELATION_ID.sub("Correlation ID: cli-<timestamp>-<id>", normalized)



def _service_snapshot(directory: Path, mode: str) -> dict[tuple[str, str, str], tuple[str, str]]:
    path = directory / f"service-{mode}.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    if (data["schema"] != "kb.service-journey/v1" or data["case_run"]["mode"] != mode
            or data["case_run"].get("selection", []) != [] or not data["steps"]):
        raise ValueError(f"{path} has invalid or partial {mode} service evidence")
    rows = {}
    statuses = set()
    for row in data["steps"]:
        identity = row["stepId"], row["capability"], row["name"]
        status, message = row["status"], row["message"]
        if (identity in rows or not all(isinstance(part, str) and part for part in identity)
                or status not in {"PASS", "FAIL", "BLOCKED", "SKIPPED"}
                or not isinstance(message, str) or status != "PASS" and not message):
            raise ValueError(f"{path} has an invalid or duplicate service step: {identity}")
        rows[identity] = status, _service_message_for_comparison(message)
        statuses.add(status)
    expected = "FAIL" if "FAIL" in statuses else "BLOCKED" if "BLOCKED" in statuses else "PASS"
    if data["status"] != expected or statuses == {"SKIPPED"}:
        raise ValueError(f"{path} has no consistent service verdict")
    return rows


def _service_delta(previous_dir: Path, current_dir: Path, mode: str) -> tuple[list[str], bool, bool]:
    before, after = _service_snapshot(previous_dir, mode), _service_snapshot(current_dir, mode)
    restored, known, regressions, unverified = [], [], [], []
    for identity in sorted(before.keys() | after.keys()):
        label = " / ".join(identity)
        if identity not in before or identity not in after:
            state = "added" if identity not in before else "disappeared"
            unverified.append(f"{label} ({state})")
            continue
        old_status, old_reason = before[identity]
        status, reason = after[identity]
        if status == "PASS" and old_status in {"FAIL", "BLOCKED"}:
            restored.append(label)
        elif status == old_status == "PASS":
            continue
        elif status == old_status and reason == old_reason and status in {"FAIL", "BLOCKED"}:
            known.append(f"{label} ({status})")
        elif (status == old_status == "SKIPPED" and reason == old_reason
              and reason.startswith("registered for runner(s) ")
              and reason.endswith(f"; this execution used service-{mode}:explore")):
            continue
        else:
            regressions.append(f"{label} ({old_status} → {status}): {reason}")
    lines = [f"Service comparison / {mode}"]
    for title, items in (("Passed on candidate", restored), ("Known failures", known),
                         ("New failures or changed outcomes", regressions), ("Unverified steps", unverified)):
        lines.append(f"{title}: " + ("\n  ".join(items) or "none"))
    return lines, bool(restored), bool(regressions or unverified)


def _read_full_case_results(directory: Path, mode: str) -> dict[str, dict]:
    path = directory / f"case-scoreboard-{mode}.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    if (not isinstance(data, dict) or data.get("schema") != "kb.journey-case-scoreboard/v2"
            or data.get("modes") != [mode] or mode not in data.get("observedModes", [])
            or not isinstance(data.get("cases"), list) or not data["cases"]):
        raise ValueError(f"{path} has no valid {mode} case evidence")
    if data.get("selection") != []:
        raise ValueError(f"{path} has a partial or undeclared case selection")
    cases = {case["id"]: case for case in data["cases"]
             if case.get("caseStatus") == "active" and mode in case.get("modes", [])}
    if len(cases) != len(data["cases"]):
        raise ValueError(f"{path} has duplicated or invalid case entries")
    for case in cases.values():
        claims = set(case["claims"])
        if not set(case["passingClaims"]) <= claims:
            raise ValueError(f"{path} reports a passing claim outside {case['id']}")
    return cases


def _claim_outcomes(directory: Path, mode: str) -> dict[tuple[str, str], set[str]]:
    outcomes = defaultdict(set)
    for claim, rows in load_evidence(directory, [mode])[mode].items():
        for row in rows:
            outcomes[claim, row["source"]].add(row["status"])
    return outcomes


def _check_mode(previous_dir: Path, current_dir: Path, mode: str) -> tuple[list[str], bool, bool]:
    service_summary, restored_service, service_regressed = _service_delta(previous_dir, current_dir, mode)
    before = _read_full_case_results(previous_dir, mode)
    after = _read_full_case_results(current_dir, mode)
    missing_cases = before.keys() - after.keys()
    lost_claims, lost_scope, regained_cases, regressed_cases = set(), set(), set(), set()
    for case_id in before.keys() & after.keys():
        old, new = before[case_id], after[case_id]
        old_claims, new_claims = set(old["claims"]), set(new["claims"])
        lost_scope.update(old_claims - new_claims)
        if old.get("release") is True and new.get("release") is not True:
            lost_scope.add(case_id)
        lost_claims.update(set(old["passingClaims"]) - set(new["passingClaims"]))
        if old["status"] == "Fully green" and new["status"] != "Fully green":
            regressed_cases.add(case_id)
        if old["status"] in {"Red", "Blocked", "Partial"} and new["status"] == "Fully green" and old_claims == new_claims:
            regained_cases.add(case_id)
    previous_outcomes, current_outcomes = (_claim_outcomes(directory, mode)
                                          for directory in (previous_dir, current_dir))
    restored_evidence, regressed_evidence = [], []
    for key in sorted(previous_outcomes.keys() | current_outcomes.keys()):
        old, new = previous_outcomes.get(key, set()), current_outcomes.get(key, set())
        if not new or ("PASS" in old and "PASS" not in new) or (new - old) & {"FAIL", "BLOCKED"}:
            regressed_evidence.append(" / ".join(key))
        elif new == {"PASS"} and old & {"FAIL", "BLOCKED"}:
            restored_evidence.append(" / ".join(key))
    summary = [f"Case comparison / {mode}"]
    if mode in RELEASE_GATING_MODES:
        counts = []
        for cases in (before, after):
            release = [case for case in cases.values() if case["release"]]
            counts.append(f"{sum(case['status'] == 'Fully green' for case in release)}/{len(release)}")
        summary.append(f"Release cases passing in full: {' → '.join(counts)}")
    for title, items in (("Cases now passing in full", regained_cases), ("Cases no longer passing in full", regressed_cases),
                         ("Restored claim evidence", restored_evidence), ("Regressed claim evidence", regressed_evidence),
                         ("Lost passing claims", lost_claims), ("Removed cases", missing_cases),
                         ("Removed claims or release scope", lost_scope)):
        summary.append(f"{title}: {', '.join(sorted(items)) or 'none'}")
    return (summary + service_summary, restored_service or bool(restored_evidence or regained_cases),
            service_regressed or bool(regressed_evidence or lost_claims or missing_cases or lost_scope or regressed_cases))


def check_delta(previous_dir: Path, current_dir: Path, mode: str) -> tuple[str, int]:
    comparisons = ([_check_mode(previous_dir / profile, current_dir / profile, profile) for profile in MODES]
                   if mode == "all" else [_check_mode(previous_dir, current_dir, mode)])
    lines = [line for summary, _, _ in comparisons for line in summary]
    if any(regressed for _, _, regressed in comparisons):
        return "\n".join(lines + ["\nRejected: regression or unverified evidence"]), 1
    if not any(improved for _, improved, _ in comparisons):
        return "\n".join(lines + ["\nRejected: No demonstrated improvement"]), 1
    return "\n".join(lines + ["\nAccepted: Demonstrated improvement without regressions"]), 0


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) == 4 and args[0] == "--check" and args[1] in (*MODES, "all"):
        report, verdict = check_delta(Path(args[2]), Path(args[3]), args[1])
        print_report_text(report, flush=True)
        return verdict
    if len(args) == 2:
        print_report_text(render_delta(Path(args[0]), Path(args[1])), flush=True)
        return 0
    if len(args) == 3 and args[0] == "--write":
        write_scoreboards(Path(args[1]), Path(args[2]))
        return 0
    print_report_text("usage: scoreboard.py <runA-dir> <runB-dir> | "
                      "--check local|secured|all <baseline-dir> <candidate-dir> | --write <reports-dir> <catalog-dir>",
                      stream=sys.stderr, flush=True)
    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print_report_text(f"Journey scoreboard failed: {error.__class__.__name__}: {error}",
                          stream=sys.stderr, flush=True)
        raise SystemExit(1)
