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


def mode_is_gating(directory: Path, mode: str) -> bool:
    return mode in release_gate_modes(_read_scoreboard(directory))


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


def write_mode_metadata(source: Path, destination: Path, mode: str, result: str, elapsed: int) -> None:
    if mode not in {"local", "secured"} or result not in {"PASS", "FAIL", "NO_SELECTED_CLAIMS"}:
        raise ValueError("mode metadata has an unsupported mode or result")
    value = json.loads(source.read_text(encoding="utf-8"))
    durations = dict(value["stageDurationsSeconds"])
    durations[mode] = elapsed
    durations["total"] = sum(durations[stage] for stage in STAGES if stage != "total")
    value["stageDurationsSeconds"] = durations
    value["mode"] = mode
    value["result"] = result
    _write_metadata(destination, value)


def assemble(output: Path, producer: Path, local: Path, secured: Path) -> int:
    shared_dir = producer / "shared"
    local_dir = local / "local"
    secured_dir = secured / "secured"
    output.mkdir(parents=True, exist_ok=True)
    for mode in ("shared", "local", "secured"):
        (output / mode).mkdir(parents=True, exist_ok=True)

    for source, destination, ignore in (
        (shared_dir, output / "shared", shutil.ignore_patterns("build-candidate.tar")),
        (local_dir, output / "local", None),
        (secured_dir, output / "secured", None),
    ):
        if source.is_dir() and source.resolve() != destination.resolve():
            shutil.copytree(source, destination, dirs_exist_ok=True, ignore=ignore)

    missing = [str(path) for path in (
        output / "shared" / "batch-metadata.json",
        output / "shared" / "run.json",
        output / "local" / "batch-metadata.json",
        output / "secured" / "batch-metadata.json",
    ) if not path.is_file()]
    if missing:
        message = "\n".join(["# Journey batch", "", "- Result: FAIL",
                               "- Missing batch metadata:", *[f"  - `{path}`" for path in missing], ""])
        (output / "shared" / "summary.md").write_text(message, encoding="utf-8")
        return 1

    producer_metadata = _read_metadata(output, "shared")
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
        else:
            scoreboards[mode] = _read_scoreboard(output / mode)
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
    partial = (any(bool(board["selection"]) for board in scoreboards.values() if board is not None)
               or any(mode_without_selection.values()))
    if partial:
        selections = "; ".join(
            f"{mode}=[{', '.join(scoreboards[mode]['selection'])}]"
            for mode in ("local", "secured")
            if scoreboards[mode] is not None
        )
        lines = ["# Journey batch", "", f"- Commit: `{run['commit']}`",
                 f"- Baseline: `{run['baseline']}`", f"- Build base: `{run['buildBase']}`", "",
                 "## Stage durations"]
        lines.extend(f"- {stage}: {durations[stage]} seconds" for stage in STAGES)
        lines.extend(["", "- Modes: local and secured", "- Reports and logs: one directory per mode", ""])
        lines.extend(f"- {mode}: no selected claims in this mode" if mode_without_selection[mode]
                     else f"- {mode}: {mode_results[mode]} (partial evidence; no gate verdict)"
                     for mode in mode_metadata)
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
    if len(argv) == 7 and argv[1] == "mode-metadata":
        try:
            write_mode_metadata(Path(argv[2]), Path(argv[3]), argv[4], argv[5], int(argv[6]))
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
            return 0 if mode_is_gating(mode_dir, mode) else 1
        except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
            command = ["e2e/journey/batch.sh", "mode", mode, str(producer), str(output)]
            if selected_cases:
                command.extend(("--cases", selected_cases))
            next_command = shlex.join(command)
            print(f"journey mode gate could not be read: {error}; next: {next_command}",
                  file=sys.stderr)
            return 2
    if len(argv) != 5:
        print("usage: batch_summary.py <output> <producer-artifact> <local-artifact> <secured-artifact>",
              file=sys.stderr)
        return 2
    try:
        return assemble(*(Path(value) for value in argv[1:]))
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
