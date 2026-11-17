#!/usr/bin/env python3
"""Create and verify the journey report bind-mount directory without chmod/chown."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import stat
import sys


class ReportDirectoryError(RuntimeError):
    """The report bind-mount directory is not owned or writable by this runner."""


def _describe(path: Path) -> str:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return f"path={path} absent"
    kind = "directory" if stat.S_ISDIR(metadata.st_mode) else (
        "symlink" if stat.S_ISLNK(metadata.st_mode) else "other"
    )
    return (f"path={path} kind={kind} owner={metadata.st_uid}:{metadata.st_gid} "
            f"mode={stat.S_IMODE(metadata.st_mode):04o}")


def _record(path: Path, evidence: Path, phase: str) -> None:
    evidence.parent.mkdir(parents=True, exist_ok=True)
    with evidence.open("a", encoding="utf-8") as stream:
        stream.write(f"phase={phase} runner={os.getuid()}:{os.getgid()}\n")
        stream.write(_describe(path.parent) + "\n")
        stream.write(_describe(path) + "\n")


def _validate(path: Path) -> None:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise ReportDirectoryError(f"reports path cannot be inspected: {error.strerror}") from error
    if not stat.S_ISDIR(metadata.st_mode):
        raise ReportDirectoryError("reports path must be a real directory, not a symlink or file")
    if (metadata.st_uid, metadata.st_gid) != (os.getuid(), os.getgid()):
        raise ReportDirectoryError(
            f"reports owner mismatch: expected {os.getuid()}:{os.getgid()}, "
            f"got {metadata.st_uid}:{metadata.st_gid}"
        )
    mode = stat.S_IMODE(metadata.st_mode)
    if mode & 0o700 != 0o700 or mode & 0o022:
        raise ReportDirectoryError(f"reports directory has unsafe mode {mode:04o}")
    if not os.access(path, os.W_OK | os.X_OK):
        raise ReportDirectoryError("reports directory is not writable/searchable by this runner")


def ensure_report_directory(path: str | Path, evidence: str | Path) -> None:
    reports = Path(path)
    evidence_path = Path(evidence)
    _record(reports, evidence_path, "before-create")
    try:
        if not os.path.lexists(reports):
            reports.mkdir(mode=0o755)
        _validate(reports)
    except OSError as error:
        raise ReportDirectoryError(f"reports directory could not be prepared: {error.strerror}") from error
    finally:
        _record(reports, evidence_path, "after-create")


def check_report_directory(path: str | Path, evidence: str | Path, phase: str) -> None:
    reports = Path(path)
    evidence_path = Path(evidence)
    _record(reports, evidence_path, phase)
    _validate(reports)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "check"))
    parser.add_argument("path")
    parser.add_argument("evidence")
    parser.add_argument("--phase", default="check")
    args = parser.parse_args()
    try:
        if args.action == "prepare":
            ensure_report_directory(args.path, args.evidence)
        else:
            check_report_directory(args.path, args.evidence, args.phase)
    except (OSError, ReportDirectoryError) as error:
        print(f"journey report directory guard failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
