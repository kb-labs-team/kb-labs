#!/usr/bin/env python3
"""Assemble the shared journey artifact and render durations from its metadata."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import shlex
import sys
from typing import Any

from scoreboard_contract import release_gate_modes
from scoreboard import write_scoreboards


STAGES = ("reset", "build", "unit", "candidate", "local", "secured", "total")


class CandidateArchiveError(ValueError):
    """The candidate archive does not match producer metadata."""


def candidate_archive_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as archive:
        for chunk in iter(lambda: archive.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_metadata(directory: Path, mode: str) -> dict[str, Any]:
    path = directory / mode / "batch-metadata.json"
    value = json.loads(path.read_text(encoding="utf-8"))
    allowed_results = ({"PASS", "FAIL", "PARTIAL", "INTERRUPTED"} if mode == "shared"
                       else {"PASS", "FAIL", "NO_SELECTED_CLAIMS"})
    if (not isinstance(value, dict)
            or not isinstance(value.get("stageDurationsSeconds"), dict)
            or value.get("result") not in allowed_results):
        raise ValueError(f"batch metadata is invalid: {path}")
    return value


def _read_scoreboard(directory: Path) -> dict[str, Any]:
    path = directory / "case-scoreboard.json"
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"scoreboard is invalid: {path}")
    selection = value.get("selection")
    if not isinstance(selection, list) or any(not isinstance(item, str) for item in selection):
        raise ValueError(f"scoreboard selection is invalid: {path}")
    return value


def requested_selection(value: str) -> list[str]:
    selection = [item.strip() for item in value.split(",") if item.strip()]
    if len(selection) != len(set(selection)):
        raise ValueError("requested case selection contains duplicate IDs")
    return sorted(selection)


def requested_area(value: str) -> str | None:
    if not value.startswith("@area:"):
        return None
    area = value.removeprefix("@area:")
    if not area or any(char not in "abcdefghijklmnopqrstuvwxyz0123456789-" for char in area):
        raise ValueError("product area selection is invalid")
    return area


def record_scoreboard_selection(path: Path, selected_cases: str, catalog: Path) -> None:
    value = _read_scoreboard(path.parent)
    release_gate_modes(value)
    selection = sorted(set(value["selection"]).union(requested_selection(selected_cases)))
    write_scoreboards(path.parent, catalog, selection)


def selected_owners_have_evidence(directory: Path, mode: str) -> bool:
    """Require selected prerequisites and direct owner claims in raw reports."""
    plan_path = directory / "selection-plan.json"
    try:
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    owners = plan.get("selectedClaimOwners") if isinstance(plan, dict) else None
    prerequisites = plan.get("prerequisiteSteps") if isinstance(plan, dict) else None
    selected_claims = plan.get("steps") if isinstance(plan, dict) else None
    if (not isinstance(owners, dict) or not isinstance(prerequisites, list)
            or not isinstance(selected_claims, list)
            or any(not isinstance(claim, str) for claim in selected_claims)
            or any(not isinstance(name, str) or not name or not isinstance(claims, list) or not claims
                   or any(not isinstance(claim, str) or not claim for claim in claims)
                   for name, claims in owners.items())
            or any(not isinstance(name, str) or not name for name in prerequisites)):
        return False
    owner_obligations = [(name, claim) for name, claims in owners.items()
                         if isinstance(name, str) and isinstance(claims, list)
                         for claim in claims if isinstance(claim, str)]
    required_prerequisites = {name for name in prerequisites if isinstance(name, str)}
    if not owner_obligations or any(claim not in selected_claims for _name, claim in owner_obligations):
        return False
    evidence: set[tuple[str, str]] = set()
    step_statuses: dict[str, set[str]] = {}
    claim_statuses: dict[str, set[str]] = {}
    for report_path in directory.glob("*.json"):
        if report_path.name.startswith("case-scoreboard") or report_path.name == plan_path.name:
            continue
        try:
            report = json.loads(report_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(report, dict):
            continue
        case_run = report.get("case_run")
        if isinstance(case_run, dict) and case_run.get("mode") == mode:
            for claim in case_run.get("claims", []):
                if isinstance(claim, dict) and isinstance(claim.get("claimId"), str):
                    claim_statuses.setdefault(claim["claimId"], set()).add(str(claim.get("status", "")))
        for step in report.get("steps", []):
            if not isinstance(step, dict) or not isinstance(step.get("name"), str):
                continue
            step_mode = step.get("mode")
            if step_mode is None and isinstance(case_run, dict):
                step_mode = case_run.get("mode")
            if step_mode != mode:
                continue
            name = step["name"]
            status = str(step.get("status", ""))
            step_statuses.setdefault(name, set()).add(status)
            if status == "PASS":
                for claim in step.get("cases", []):
                    if isinstance(claim, str):
                        evidence.add((name, claim))
    passing_claims = {claim for claim, statuses in claim_statuses.items() if statuses == {"PASS"}}
    return (set(selected_claims).issubset(passing_claims)
            and all(step_statuses.get(name) == {"PASS"} for name in required_prerequisites)
            and all(step_statuses.get(name) == {"PASS"}
                    and claim in passing_claims and (name, claim) in evidence
                    for name, claim in owner_obligations))


def mode_is_gating(directory: Path, mode: str, selected_cases: str = "") -> bool:
    gate_modes = release_gate_modes(_read_scoreboard(directory))
    return bool(requested_selection(selected_cases)) or mode in gate_modes


def _write_metadata(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def write_run(path: Path, commit: str, baseline: str, build_base: str) -> None:
    path.write_text(json.dumps({"commit": commit, "baseline": baseline, "buildBase": build_base}) + "\n",
                    encoding="utf-8")


def verify_run_commit(path: Path, current_commit: str) -> None:
    value = json.loads(path.read_text(encoding="utf-8"))
    producer_commit = value.get("commit") if isinstance(value, dict) else None
    if not isinstance(producer_commit, str) or not producer_commit:
        raise ValueError(f"journey producer artifact has no commit identity: {path}")
    if producer_commit != current_commit:
        raise ValueError(
            f"candidate artifact is bound to {producer_commit}, checked out {current_commit}; "
            "next: rerun e2e/journey/batch.sh prepare for this commit"
        )


def write_stage_metadata(path: Path, mode: str, result: str, commit: str, baseline: str,
                         build_base: str, stage_values: list[str], archive: Path) -> None:
    if mode not in {"shared", "local", "secured"} or result not in {"PASS", "FAIL", "INTERRUPTED"}:
        raise ValueError("batch metadata has an unsupported mode or result")
    if len(stage_values) != len(STAGES):
        raise ValueError("batch metadata requires one duration for every stage")
    value: dict[str, Any] = {
        "commit": commit,
        "baseline": baseline,
        "buildBase": build_base,
        "result": result,
        "stageDurationsSeconds": dict(zip(STAGES, (int(seconds) for seconds in stage_values))),
    }
    if archive.is_file():
        value["candidateArchiveSha256"] = candidate_archive_sha256(archive)
    if mode != "shared":
        value["mode"] = mode
    _write_metadata(path, value)


def verify_candidate_archive(metadata_path: Path, archive: Path) -> None:
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    expected = metadata.get("candidateArchiveSha256") if isinstance(metadata, dict) else None
    if not isinstance(expected, str) or not expected:
        raise CandidateArchiveError("producer metadata has no candidate archive digest")
    actual = candidate_archive_sha256(archive)
    if actual != expected:
        raise CandidateArchiveError("candidate archive digest does not match producer metadata")


def write_mode_metadata(source: Path, destination: Path, mode: str, result: str, elapsed: int,
                        selected_cases: str = "", failure_reason: str = "",
                        selected_area: str = "", uncovered_area_steps: str = "") -> None:
    if mode not in {"local", "secured"} or result not in {"PASS", "FAIL", "NO_SELECTED_CLAIMS"}:
        raise ValueError("mode metadata has an unsupported mode or result")
    value = json.loads(source.read_text(encoding="utf-8"))
    durations = dict(value["stageDurationsSeconds"])
    durations[mode] = elapsed
    durations["total"] = sum(durations[stage] for stage in STAGES if stage != "total")
    value["stageDurationsSeconds"] = durations
    value["mode"] = mode
    value["result"] = result
    value["requestedSelection"] = requested_selection(selected_cases)
    value["requestedArea"] = selected_area or None
    value["requestedAreaUncoveredSteps"] = requested_selection(uncovered_area_steps)
    value["requestedAreaCoverage"] = (
        "NOT_COVERED" if selected_area and (
            value["requestedAreaUncoveredSteps"] or not value["requestedSelection"])
        else "CLAIMABLE_STEPS_SELECTED" if selected_area else None
    )
    if failure_reason:
        value["failureReason"] = failure_reason
    _write_metadata(destination, value)


def assemble(output: Path, producer: Path, local: Path, secured: Path,
             authoritative_selection: str = "") -> int:
    shared_dir = producer / "shared"
    local_dir = local / "local"
    secured_dir = secured / "secured"
    area = requested_area(authoritative_selection)
    selected = [] if area else requested_selection(authoritative_selection)
    output.mkdir(parents=True, exist_ok=True)
    for mode, source in (("shared", shared_dir), ("local", local_dir), ("secured", secured_dir)):
        if not source.is_dir() or source.resolve() != (output / mode).resolve():
            shutil.rmtree(output / mode, ignore_errors=True)
        (output / mode).mkdir(parents=True, exist_ok=True)

    for source, destination, ignore in (
        (shared_dir, output / "shared", shutil.ignore_patterns("build-candidate.tar")),
        (local_dir, output / "local", None),
        (secured_dir, output / "secured", None),
    ):
        if source.is_dir() and source.resolve() != destination.resolve():
            shutil.copytree(source, destination, dirs_exist_ok=True, ignore=ignore)

    missing_shared = [str(path) for path in (
        output / "shared" / "batch-metadata.json", output / "shared" / "run.json")
        if not path.is_file()]
    if missing_shared:
        message = "\n".join([
            "# Journey batch", "", "- Result: FAIL", "- Missing shared producer artifacts:",
            *[f"  - `{path}`" for path in missing_shared], "",
        ])
        (output / "shared" / "summary.md").write_text(message, encoding="utf-8")
        return 1

    producer_metadata = _read_metadata(output, "shared")
    missing_mode_metadata = [mode for mode in ("local", "secured")
                             if not (output / mode / "batch-metadata.json").is_file()]
    if missing_mode_metadata and not selected:
        paths = [output / mode / "batch-metadata.json" for mode in missing_mode_metadata]
        message = "\n".join(["# Journey batch", "", "- Result: FAIL",
                               "- Missing batch metadata:", *[f"  - `{path}`" for path in paths], ""])
        (output / "shared" / "summary.md").write_text(message, encoding="utf-8")
        return 1
    for mode in missing_mode_metadata:
        durations = dict(producer_metadata["stageDurationsSeconds"])
        durations[mode] = 0
        durations["total"] = sum(durations.get(stage, 0) for stage in STAGES if stage != "total")
        synthetic = {key: producer_metadata[key] for key in ("commit", "baseline", "buildBase")
                     if key in producer_metadata}
        synthetic.update({"mode": mode, "result": "FAIL", "stageDurationsSeconds": durations,
                          "requestedSelection": selected,
                          "failureReason": "mode artifact is missing batch-metadata.json"})
        _write_metadata(output / mode / "batch-metadata.json", synthetic)
    local_metadata = _read_metadata(output, "local")
    secured_metadata = _read_metadata(output, "secured")
    run = json.loads((output / "shared" / "run.json").read_text(encoding="utf-8"))
    run_commit = run.get("commit") if isinstance(run, dict) else None
    commits = {
        "shared/run.json": run_commit,
        "shared/batch-metadata.json": producer_metadata.get("commit"),
        "local/batch-metadata.json": local_metadata.get("commit"),
        "secured/batch-metadata.json": secured_metadata.get("commit"),
    }
    if any(not isinstance(commit, str) or not commit for commit in commits.values()):
        missing_identity = [name for name, commit in commits.items() if not isinstance(commit, str) or not commit]
        raise ValueError(f"batch artifact commit identity is missing: {', '.join(missing_identity)}")
    if len(set(commits.values())) != 1:
        identities = ", ".join(f"{name}={commit}" for name, commit in commits.items())
        for mode in ("shared", "local", "secured"):
            metadata_path = output / mode / "batch-metadata.json"
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            metadata["result"] = "FAIL"
            _write_metadata(metadata_path, metadata)
        raise ValueError(f"batch artifacts contain mixed commit identities: {identities}")
    mode_metadata = {"local": local_metadata, "secured": secured_metadata}
    mode_without_selection = {
        mode: mode_metadata[mode].get("result") == "NO_SELECTED_CLAIMS"
        for mode in ("local", "secured")
    }
    scoreboards = {}
    for mode in ("local", "secured"):
        scoreboard_path = output / mode / "case-scoreboard.json"
        if mode_without_selection[mode]:
            if scoreboard_path.exists():
                raise ValueError(f"mode {mode} has no selected claims but produced a scoreboard")
            scoreboards[mode] = None
        elif not scoreboard_path.is_file() and selected:
            scoreboards[mode] = None
        else:
            scoreboards[mode] = _read_scoreboard(output / mode)
    declared_gates = [release_gate_modes(board) for board in scoreboards.values() if board is not None]
    if declared_gates and any(gates != declared_gates[0] for gates in declared_gates[1:]):
        raise ValueError("local and secured scoreboards publish different releaseGate modes")
    local_durations = local_metadata["stageDurationsSeconds"]
    secured_durations = secured_metadata["stageDurationsSeconds"]
    shared_durations = producer_metadata["stageDurationsSeconds"]
    durations = {
        "reset": shared_durations["reset"],
        "build": shared_durations["build"],
        "unit": shared_durations["unit"],
        "candidate": shared_durations["candidate"],
        "local": local_durations["local"],
        "secured": secured_durations["secured"],
        "total": shared_durations["total"] + max(
            local_durations["local"], secured_durations["secured"]
        ),
    }
    mode_results = {
        mode: metadata.get("result")
        for mode, metadata in mode_metadata.items()
    }
    requested_selections = {
        mode: metadata.get("requestedSelection", [])
        for mode, metadata in mode_metadata.items()
    }
    if any(not isinstance(selection, list) or any(not isinstance(item, str) for item in selection)
           for selection in requested_selections.values()):
        raise ValueError("batch mode metadata has an invalid requestedSelection")
    if any(len(selection) != len(set(selection)) for selection in requested_selections.values()):
        raise ValueError("batch mode metadata requestedSelection contains duplicate IDs")
    requested_areas = {mode: metadata.get("requestedArea") for mode, metadata in mode_metadata.items()}
    uncovered_area_steps = {
        mode: requested_selection(",".join(metadata.get("requestedAreaUncoveredSteps", [])))
        for mode, metadata in mode_metadata.items()
    }
    area_coverages = {mode: metadata.get("requestedAreaCoverage")
                      for mode, metadata in mode_metadata.items()}
    if area:
        if any(requested_areas[mode] != area for mode in ("local", "secured")):
            raise ValueError("mode requestedArea does not match the producer product-area selection")
        for mode in ("local", "secured"):
            if set(uncovered_area_steps[mode]).intersection(requested_selections[mode]):
                raise ValueError(f"product-area steps cannot be both selected and reported uncovered in {mode}")
            expected_coverage = ("NOT_COVERED" if uncovered_area_steps[mode] or not requested_selections[mode]
                                 else "CLAIMABLE_STEPS_SELECTED")
            if area_coverages[mode] != expected_coverage:
                raise ValueError(f"mode {mode} product-area coverage does not match its selected and uncovered steps")
        selected = sorted(set(requested_selections["local"]) | set(requested_selections["secured"]))
    elif any(requested_areas.values()):
        raise ValueError("mode reports a product area but the producer selection does not")
    elif any(uncovered_area_steps.values()):
        raise ValueError("mode reports uncovered product-area steps but the producer selection does not")

    def reject_mode_selection(mode: str, reason: str) -> None:
        metadata = mode_metadata[mode]
        metadata["result"] = "FAIL"
        metadata["failureReason"] = reason
        _write_metadata(output / mode / "batch-metadata.json", metadata)
        raise ValueError(reason)

    for mode in ("local", "secured"):
        metadata_selection = requested_selections[mode]
        scoreboard_selection = scoreboards[mode]["selection"] if scoreboards[mode] is not None else []
        if selected:
            expected_mode_selection = metadata_selection if area else selected
            if not area and metadata_selection != selected:
                reject_mode_selection(mode,
                    f"mode {mode} requestedSelection does not match the producer selection: "
                    f"{metadata_selection!r} != {selected!r}"
                )
            if scoreboards[mode] is not None and scoreboard_selection != expected_mode_selection:
                reject_mode_selection(mode,
                    f"mode {mode} scoreboard selection does not match the producer selection: "
                    f"{scoreboard_selection!r} != {expected_mode_selection!r}"
                )
        elif metadata_selection or scoreboard_selection:
            reject_mode_selection(mode,
                f"mode {mode} reports a selected run, but the producer selection is empty"
            )

    for mode in ("local", "secured"):
        if scoreboards[mode] is None and not mode_without_selection[mode]:
            metadata = mode_metadata[mode]
            metadata["result"] = "FAIL"
            previous_reason = metadata.get("failureReason", "")
            suffix = "case-scoreboard.json is missing"
            metadata["failureReason"] = f"{previous_reason}; {suffix}" if previous_reason else suffix
            _write_metadata(output / mode / "batch-metadata.json", metadata)
            mode_results[mode] = "FAIL"
    partial = (bool(selected)
               or any(bool(board["selection"]) for board in scoreboards.values() if board is not None)
               or any(mode_without_selection.values())
               or any(bool(selection) for selection in requested_selections.values())
               or bool(area))
    if partial:
        selected_by_mode = {
            mode: sorted(set(scoreboards[mode]["selection"] if scoreboards[mode] else [])
                         | set(requested_selections[mode])
                         | set(selected if mode in missing_mode_metadata or scoreboards[mode] is None else []))
            for mode in ("local", "secured")
            if ((scoreboards[mode] is not None and scoreboards[mode]["selection"])
                or requested_selections[mode] or selected)
        }
        selections = "; ".join(
            f"{mode}=[{', '.join(selection)}]" for mode, selection in selected_by_mode.items()
        )
        lines = ["# Journey batch", "", f"- Commit: `{run['commit']}`",
                 f"- Baseline: `{run['baseline']}`", f"- Build base: `{run['buildBase']}`", "",
                 "## Stage durations"]
        lines.extend(f"- {stage}: {durations[stage]} seconds" for stage in STAGES)
        unit_log = output / "shared" / "unit.log"
        if unit_log.is_file() and unit_log.read_text(encoding="utf-8").startswith("SKIPPED:"):
            lines.append("- Shared generic journey unit suite: skipped for this partial selection; full journey batch remains the gating verification.")
        lines.extend(["", "- Modes: local and secured", "- Reports and logs: one directory per mode", ""])
        if area:
            lines.extend([f"- Product area: `{area}`", ""])
            for mode in ("local", "secured"):
                selected_steps = ", ".join(f"`{step_id}`" for step_id in requested_selections[mode]) or "none"
                uncovered_steps = ", ".join(f"`{step_id}`" for step_id in uncovered_area_steps[mode]) or "none"
                lines.append(f"- {mode} area steps: selected {selected_steps}; NOT COVERED {uncovered_steps}.")
            if any(area_coverages[mode] != "CLAIMABLE_STEPS_SELECTED" for mode in ("local", "secured")):
                lines.append("- Product area coverage: NOT COVERED in at least one mode; listed claimable steps were run as partial evidence.")
            else:
                lines.append("- Product area coverage: all active steps have journey claims in both modes; this remains iteration-only evidence.")
            lines.append("")
        for mode in mode_metadata:
            if mode_without_selection[mode]:
                lines.append(f"- {mode}: no selected claims in this mode")
            else:
                reason = mode_metadata[mode].get("failureReason")
                suffix = f"; {reason}" if isinstance(reason, str) and reason else ""
                lines.append(f"- {mode}: {mode_results[mode]} (partial evidence; no gate verdict{suffix})")
        lines.extend(["", f"- Partial selection: {selections}",
                      "- Partial evidence is iteration-only and cannot produce a gate verdict.",
                      "", "- Result: PARTIAL", ""])
        (output / "shared" / "summary.md").write_text("\n".join(lines), encoding="utf-8")
        for mode, metadata in (("shared", producer_metadata), ("local", local_metadata),
                               ("secured", secured_metadata)):
            metadata["stageDurationsSeconds"] = durations
            metadata["result"] = "PARTIAL" if mode == "shared" else metadata.get("result")
            if mode != "shared":
                metadata["mode"] = mode
            _write_metadata(output / mode / "batch-metadata.json", metadata)
        return 1

    verify_candidate_archive(shared_dir / "batch-metadata.json", shared_dir / "build-candidate.tar")
    release_gates = {
        mode: release_gate_modes(board)
        for mode, board in scoreboards.items()
    }
    if release_gates["local"] != release_gates["secured"]:
        raise ValueError("local and secured scoreboards publish different releaseGate modes")
    gate_modes = release_gates["local"]
    shared_passed = producer_metadata.get("result") == "PASS"
    gating_mode_failed = any(
        mode in gate_modes and result != "PASS"
        for mode, result in mode_results.items()
    )
    overall_result = "PASS" if shared_passed and not gating_mode_failed else "FAIL"
    lines = ["# Journey batch", "", f"- Commit: `{run['commit']}`",
             f"- Baseline: `{run['baseline']}`", f"- Build base: `{run['buildBase']}`", "",
             "## Stage durations"]
    lines.extend(f"- {stage}: {durations[stage]} seconds" for stage in STAGES)
    lines.extend(["", "- Modes: local and secured", "- Reports and logs: one directory per mode", ""])
    lines.extend(
        f"- {mode}: {mode_results[mode]} ({'gating' if mode in gate_modes else 'non-gating for Release 1'})"
        for mode in mode_metadata
    )
    lines.extend(["", f"- Result: {overall_result}", ""])
    (output / "shared" / "summary.md").write_text("\n".join(lines), encoding="utf-8")
    for mode, metadata in (("shared", producer_metadata), ("local", local_metadata),
                           ("secured", secured_metadata)):
        metadata["stageDurationsSeconds"] = durations
        metadata["result"] = overall_result if mode == "shared" else metadata.get("result")
        if mode != "shared":
            metadata["mode"] = mode
        _write_metadata(output / mode / "batch-metadata.json", metadata)
    return 0 if overall_result == "PASS" else 1


def main(argv: list[str]) -> int:
    if len(argv) == 4 and argv[1] == "verify-run":
        try:
            verify_run_commit(Path(argv[2]), argv[3])
            return 0
        except (OSError, ValueError, json.JSONDecodeError) as error:
            print(f"journey batch candidate identity check failed: {error}", file=sys.stderr)
            return 1
    if len(argv) == 4 and argv[1] == "verify-candidate":
        try:
            verify_candidate_archive(Path(argv[2]), Path(argv[3]))
            return 0
        except (OSError, ValueError, json.JSONDecodeError) as error:
            producer = Path(argv[2]).parent.parent
            next_command = shlex.join(["e2e/journey/batch.sh", "prepare", str(producer)])
            print(f"journey batch candidate archive verification failed: {error}; next: {next_command}",
                  file=sys.stderr)
            return 1
    if len(argv) == 6 and argv[1] == "run":
        try:
            write_run(Path(argv[2]), argv[3], argv[4], argv[5])
            return 0
        except OSError as error:
            print(f"journey run metadata could not be written: {error}; next: rerun e2e/journey/batch.sh prepare",
                  file=sys.stderr)
            return 1
    if len(argv) == 16 and argv[1] == "metadata":
        try:
            write_stage_metadata(Path(argv[2]), argv[3], argv[4], argv[5], argv[6], argv[7], argv[8:15], Path(argv[15]))
            return 0
        except (OSError, ValueError) as error:
            print(f"journey batch metadata could not be written: {error}; next: rerun e2e/journey/batch.sh prepare",
                  file=sys.stderr)
            return 1
    if len(argv) in {7, 8, 9, 10, 11} and argv[1] == "mode-metadata":
        try:
            write_mode_metadata(Path(argv[2]), Path(argv[3]), argv[4], argv[5], int(argv[6]),
                                argv[7] if len(argv) >= 8 else "",
                                argv[8] if len(argv) >= 9 else "",
                                argv[9] if len(argv) >= 10 else "",
                                argv[10] if len(argv) == 11 else "")
            return 0
        except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
            print(f"journey mode metadata could not be written: {error}; next: rerun e2e/journey/batch.sh mode {argv[4]}",
                  file=sys.stderr)
            return 1
    if len(argv) == 7 and argv[1] == "mode-gating":
        mode_dir = Path(argv[2])
        mode = argv[3]
        producer = Path(argv[4])
        output = Path(argv[5])
        selected_cases = argv[6]
        try:
            return 0 if mode_is_gating(mode_dir, mode, selected_cases) else 1
        except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
            command = ["e2e/journey/batch.sh", "mode", mode, str(producer), str(output)]
            if selected_cases:
                command.extend(("--cases", selected_cases))
            next_command = shlex.join(command)
            print(f"journey mode gate could not be read: {error}; next: {next_command}",
                  file=sys.stderr)
            return 2
    if len(argv) == 5 and argv[1] == "record-selection":
        try:
            record_scoreboard_selection(Path(argv[2]), argv[3], Path(argv[4]))
            return 0
        except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
            print(f"journey scoreboard selection could not be recorded: {error}; next: rerun the selected journey",
                  file=sys.stderr)
            return 1
    if len(argv) == 4 and argv[1] == "verify-selection-evidence":
        return 0 if selected_owners_have_evidence(Path(argv[2]), argv[3]) else 1
    if len(argv) not in {5, 6}:
        print("usage: batch_summary.py <output> <producer-artifact> <local-artifact> <secured-artifact>",
              file=sys.stderr)
        return 2
    try:
        return assemble(*(Path(value) for value in argv[1:5]), argv[5] if len(argv) == 6 else "")
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        if isinstance(error, CandidateArchiveError):
            next_command = shlex.join(["e2e/journey/batch.sh", "prepare", argv[2]])
        else:
            next_command = shlex.join([sys.executable, str(Path(argv[0]).resolve()), *argv[1:]])
        print(f"journey batch summary failed: {error}; next: {next_command}",
              file=sys.stderr)
        output = Path(argv[1])
        shared = output / "shared"
        shared.mkdir(parents=True, exist_ok=True)
        (shared / "summary.md").write_text(
            "# Journey batch\n\n- Result: FAIL\n"
            f"- Finalization error: `{error}`\n\n",
            encoding="utf-8",
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
