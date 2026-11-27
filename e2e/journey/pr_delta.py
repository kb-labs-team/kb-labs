#!/usr/bin/env python3
"""Compare the Journey claims selected from the pull request's changed paths."""
from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from fnmatch import fnmatchcase
from pathlib import Path
from typing import NamedTuple

from batch_summary import requested_selection, verify_run_commit
from invocations import print_report_text, run_harness_command
from scoreboard import MODES, _service_message_for_comparison

# These smoke claims cover the corresponding installed product surfaces.
# The Journey selector adds their executable owners and prerequisites.
CLAIM_MAP = Path(__file__).resolve().parents[2] / "scripts/ci/journey-pr-claims.json"
PRODUCT_PREFIXES = ("adapters/", "cli/", "core/", "plugins/", "sdk/", "services/", "shared/",
                    "studio/", "tools/", "e2e/", ".kb/")
DOCKER_E2E_BOOTSTRAP = {
    "e2e/docker-compose.platform.yml",
    "e2e/docker-compose.oauth-ci.yml",
    "e2e/platform/entrypoint.sh",
}
REPORT_PREFIXES = ("service-", "installer-case-", "platform-")
DEVKIT_TASKS = re.compile(r"^tasks:\n(?:^[ #][^\n]*\n|^\n)*", re.MULTILINE)
DEVKIT_COVERAGE_TASK = re.compile(r"^  test:coverage(?::go)?:\n(?:^ {4}[^\n]*\n|^\n)*", re.MULTILINE)


class Evidence(NamedTuple):
    report: str
    step: str
    status: str
    reason: str


def plan_claims(paths: list[str]) -> list[str]:
    policy = read_json(CLAIM_MAP)
    claims = set()
    for path in paths:
        if path.endswith((".md", ".mdx")) or path in {"e2e/journey/scoreboard.py", "e2e/journey/pr_delta.py"}:
            continue
        # The old Playwright package is excluded from active suites by DevKit.
        if path.startswith(("tools/kb-devkit/", "e2e/tests/")) or path == "e2e/_global/ci.zone.json":
            continue
        if path in DOCKER_E2E_BOOTSTRAP or fnmatchcase(path, "e2e/journey/test_*.py"):
            continue
        scoped = {claim for scope in policy["scopes"] for claim in scope["claims"]
                  if any(fnmatchcase(path, pattern) for pattern in scope["paths"])}
        if not scoped and (path.startswith(PRODUCT_PREFIXES)
                           or path in {"package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "devkit.yaml"}):
            scoped.update(policy["crossCutting"])
        claims.update(scoped)
    return sorted(claims)


def without_devkit_coverage_tasks(config: str) -> str:
    # Strip only top-level task declarations. Build rules and coverage thresholds stay in scope.
    return DEVKIT_TASKS.sub(lambda section: DEVKIT_COVERAGE_TASK.sub("", section.group()), config)


def read_json(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected an object")
    return data


def selected_outcomes(directory: Path, sha: str, mode: str,
                      claims: list[str]) -> dict[tuple[str, str], set[Evidence]]:
    verify_run_commit(directory / "run.json", sha)
    metadata = read_json(directory / "batch-metadata.json")
    plan = read_json(directory / "selection-plan.json")
    if (metadata.get("mode") != mode or metadata.get("commit") != sha or metadata.get("failureReason")
            or metadata.get("requestedSelection") != claims or plan.get("selection") != claims):
        raise ValueError(f"{mode}: invalid or incomplete metadata for commit {sha}")
    selected = set(plan["steps"])
    if metadata["result"] == "NO_SELECTED_CLAIMS" and not selected and not plan["runners"]:
        return {}
    if metadata["result"] not in {"PASS", "FAIL"} or not selected or not selected <= set(claims) or not plan["runners"]:
        raise ValueError(f"{mode}: invalid selected Journey plan for commit {sha}")
    owners = plan["selectedClaimOwners"]
    obligations = {(name, claim) for name, ids in owners.items() for claim in ids}
    if {claim for _, claim in obligations} != selected:
        raise ValueError(f"{mode}: the selection plan omits a claim owner for commit {sha}")
    obligations.update((name, "") for name in plan["prerequisiteSteps"])
    measured = defaultdict(set)
    unnamed_claim_results = defaultdict(list)
    for path in sorted(directory.glob("*.json")):
        if not path.name.startswith(REPORT_PREFIXES):
            continue
        report = read_json(path)
        case_run = report.get("case_run", {})
        if case_run.get("mode") != mode:
            continue
        for row in report.get("steps", []):
            status, name = row.get("status"), row.get("name")
            if not name or status not in {"PASS", "FAIL", "BLOCKED"} or row.get("mode", mode) != mode:
                continue
            reason = "" if status == "PASS" else _service_message_for_comparison(row["message"])
            for claim in (*row.get("cases", []), ""):
                key = name, claim
                evidence = Evidence(path.name, name, status, reason)
                if key in obligations:
                    measured[key].add(evidence)
                elif claim in selected and row.get("capability") != "journey.selection":
                    unnamed_claim_results[claim].append(evidence)
    for key in obligations - measured.keys():
        _, claim = key
        results = unnamed_claim_results.get(claim, [])
        if (results and all(row.status == "BLOCKED" and row.reason for row in results)
                and sum(claim in ids for ids in owners.values()) == 1):
            measured[key].update(results)
    missing = obligations - measured.keys()
    if missing:
        label = ", ".join(f"{claim or 'prerequisite'} / {name}" for name, claim in sorted(missing))
        raise ValueError(f"{mode}: missing evidence for commit {sha}: {label}")
    if metadata["result"] == "FAIL" and all(row.status == "PASS" for results in measured.values()
                                            for row in results):
        raise ValueError(f"{mode}: runner failed outside the available results for commit {sha}")
    return dict(measured)


def check_pr(base: Path, candidate: Path, base_sha: str, candidate_sha: str, claims: list[str]) -> tuple[str, bool]:
    lines = ["## Journey baseline delta", "", f"- Base: `{base_sha}`", f"- Tested merge: `{candidate_sha}`",
             f"- Selected claims: {', '.join(claims)}", ""]
    improved, regressed, measured_claims = [], [], set()
    for mode in MODES:
        try:
            before = selected_outcomes(base / mode, base_sha, mode, claims)
            after = selected_outcomes(candidate / mode, candidate_sha, mode, claims)
        except (OSError, ValueError, KeyError, TypeError) as error:
            regressed.append(f"{mode}: {error}")
            continue
        measured_claims.update(claim for _, claim in before.keys() & after.keys() if claim)
        for key in sorted(before.keys() | after.keys()):
            name, claim = key
            label = f"{mode} / {claim or 'prerequisite'} / {name}"
            old, new = before.get(key, set()), after.get(key, set())
            if old == new:
                continue
            old_statuses = {row.status for row in old}
            new_statuses = {row.status for row in new}
            if not claim and not old and new_statuses == {"PASS"}:
                continue
            # Multiple indirect blockers can demonstrate unchanged debt, not owner recovery.
            multiple_blockers = sum(row.step != name for row in old) > 1
            if (not multiple_blockers and {row.report for row in old} == {row.report for row in new}
                    and new_statuses == {"PASS"} and old_statuses & {"FAIL", "BLOCKED"}):
                improved.append(label)
            else:
                old_text = ", ".join(sorted(old_statuses)) or "MISSING"
                new_text = ", ".join(sorted(new_statuses)) or "MISSING"
                regressed.append(f"{label}: {old_text} → {new_text}")
    unknown = set(claims) - measured_claims
    if unknown:
        regressed.append(f"Unverified claims: {', '.join(sorted(unknown))}")
    for title, items in (("Recovered", improved), ("Regressed or unverified", regressed)):
        lines.extend([f"### {title}", *[f"- {item}" for item in (items or ["None"])], ""])
    if not improved:
        lines.append("No demonstrated improvement.")
    return "\n".join(lines), bool(improved) and not regressed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    plan = commands.add_parser("plan")
    plan.add_argument("base")
    plan.add_argument("candidate")
    check = commands.add_parser("check")
    check.add_argument("base", type=Path)
    check.add_argument("candidate", type=Path)
    check.add_argument("base_sha")
    check.add_argument("candidate_sha")
    check.add_argument("claims")
    args = parser.parse_args()
    if args.command == "plan":
        result = run_harness_command(
            ["git", "diff", "--no-renames", "--name-only", "-z", args.base, args.candidate, "--"]
        )
        if result.returncode != 0:
            raise ValueError(f"Could not select changed paths: {result.stderr.strip()}")
        paths = result.stdout.split("\0")
        if "devkit.yaml" in paths:
            base_config = run_harness_command(["git", "show", f"{args.base}:devkit.yaml"])
            candidate_config = run_harness_command(["git", "show", f"{args.candidate}:devkit.yaml"])
            if (base_config.returncode == candidate_config.returncode == 0
                    and base_config.stdout != candidate_config.stdout
                    and without_devkit_coverage_tasks(base_config.stdout)
                    == without_devkit_coverage_tasks(candidate_config.stdout)):
                paths.remove("devkit.yaml")
        print(",".join(plan_claims(paths)))
        return 0
    summary, passed = check_pr(args.base, args.candidate, args.base_sha, args.candidate_sha,
                               requested_selection(args.claims))
    print_report_text(summary, flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
