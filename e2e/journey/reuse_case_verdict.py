#!/usr/bin/env python3
"""Verify that reports prove every selected claim for one installed journey mode."""
from __future__ import annotations

import json
import sys
from pathlib import Path


def verify_case_reports(reports_root: Path, mode: str, selected: dict, metadata: dict) -> None:
    """Raise ValueError unless the selected mode passed every selected claim."""
    if metadata.get("result") != "PASS":
        raise ValueError("selected journey mode did not pass")
    selection = set(selected.get("selection", []))
    expected = set(selected.get("steps", []))
    if not selection or not expected:
        raise ValueError("selected case has no active claims in the case catalogue")

    observed: dict[str, list[object]] = {}
    for report in reports_root.rglob("*.json"):
        if report.name.startswith("case-scoreboard"):
            continue
        try:
            data = json.loads(report.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        case_run = data.get("case_run", {}) if isinstance(data, dict) else {}
        if case_run.get("mode") != mode or set(case_run.get("selection", [])) != selection:
            continue
        for claim in case_run.get("claims", []):
            if isinstance(claim, dict) and isinstance(claim.get("claimId"), str):
                observed.setdefault(claim["claimId"], []).append(claim.get("status"))

    missing = sorted(claim for claim in expected if not observed.get(claim))
    failed = sorted(claim for claim in expected if any(status != "PASS" for status in observed.get(claim, [])))
    if missing or failed:
        raise ValueError(f"selected claims did not all pass in {mode} mode; missing={missing}, failed={failed}")


def select_case_from_workspace(workspace_root: Path, requested: str, mode: str) -> dict:
    """Load case declarations and the built CLI from the candidate workspace."""
    workspace_root = workspace_root.resolve()
    required = (
        (workspace_root / "core/config/dist/index.js", "corepack pnpm --filter @kb-labs/core-config build"),
        (workspace_root / "cli/bin/dist/bin.js", "kb-devkit run build --affected"),
    )
    for path, build_command in required:
        if not path.is_file():
            raise ValueError(
                f"reused candidate build prerequisite is missing: {path}; "
                f"build it with `{build_command}` before running the selected case"
            )

    journey_root = workspace_root / "e2e/journey"
    if not journey_root.is_dir():
        raise ValueError(f"reused candidate journey sources are missing: {journey_root}")

    # The verifier may itself come from the workflow checkout (harness SHA).
    # Resolve its helper imports from the candidate checkout after the artifact
    # has been extracted and any reviewed harness overlay has been applied.
    verifier_root = Path(__file__).resolve().parent
    sys.path[:] = [str(journey_root), *(
        entry for entry in sys.path
        if not entry or Path(entry).resolve() != verifier_root
    )]
    from select_from_cases import coverage_results, selection_from_coverage

    return selection_from_coverage(coverage_results(), requested, mode=mode, requested_runners="")


def main() -> int:
    if len(sys.argv) != 5:
        print("usage: reuse_case_verdict.py <mode> <case-or-step-id> <reports-root> <candidate-workspace>", file=sys.stderr)
        return 2
    mode, requested, reports_root, workspace_root = sys.argv[1:]
    if mode not in {"local", "secured"}:
        print(f"unsupported journey mode: {mode}", file=sys.stderr)
        return 2
    try:
        root = Path(reports_root)
        metadata = json.loads((root / "batch-metadata.json").read_text(encoding="utf-8"))
        selected = select_case_from_workspace(Path(workspace_root), requested, mode)
        verify_case_reports(root, mode, selected, metadata)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
