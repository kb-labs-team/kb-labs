#!/usr/bin/env python3
"""Create a narrowly allowlisted harness overlay on a verified source checkout."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from invocations import run_harness_command


EXPECTED_DIFF = {
    ".github/workflows/journey-batch.yml": ("M", "100644", "100644"),
    "docs/qa/scenarios/S-262-journey-batch-on-github.md": ("M", "100644", "100644"),
    "e2e/journey/invocations.py": ("M", "100644", "100644"),
    "e2e/journey/reuse_candidate_overlay.py": ("A", "000000", "100644"),
    "e2e/journey/reuse_case_verdict.py": ("A", "000000", "100644"),
    "e2e/journey/runner.py": ("M", "100644", "100644"),
    "e2e/journey/select_from_cases.py": ("M", "100644", "100644"),
    "e2e/journey/test_reuse_case_verdict.py": ("A", "000000", "100644"),
    "e2e/journey/test_batch_entry.py": ("M", "100644", "100644"),
    "e2e/journey/test_reuse_candidate_overlay.py": ("A", "000000", "100644"),
    "e2e/journey/test_runner.py": ("M", "100644", "100644"),
    "scripts/ci/journey-batch-selection.test.mjs": ("M", "100644", "100644"),
}
OVERLAY_PATHS = (
    "docs/qa/scenarios/S-262-journey-batch-on-github.md",
    "e2e/journey/invocations.py",
    "e2e/journey/runner.py",
    "e2e/journey/select_from_cases.py",
    "e2e/journey/test_runner.py",
)


def parse_and_validate_raw_diff(raw_diff: bytes) -> list[str]:
    """Require the exact reviewed source-to-harness path and mode changes."""
    fields = raw_diff.split(b"\0")
    if fields[-1:] == [b""]:
        fields.pop()
    if len(fields) % 2:
        raise ValueError("source-to-harness raw diff is malformed")
    seen: dict[str, tuple[str, str, str]] = {}
    for header, raw_path in zip(fields[::2], fields[1::2]):
        parts = header.decode("ascii", errors="strict").split()
        if len(parts) != 5 or not parts[0].startswith(":"):
            raise ValueError("source-to-harness raw diff contains an unsupported entry")
        old_mode = parts[0][1:]
        new_mode = parts[1]
        status = parts[4]
        path = raw_path.decode("utf-8", errors="strict")
        if path in seen:
            raise ValueError(f"source-to-harness diff repeats path: {path}")
        seen[path] = (status, old_mode, new_mode)
    if seen != EXPECTED_DIFF:
        unexpected = sorted(set(seen) - set(EXPECTED_DIFF))
        missing = sorted(set(EXPECTED_DIFF) - set(seen))
        mismatched = sorted(path for path in set(seen) & set(EXPECTED_DIFF)
                            if seen[path] != EXPECTED_DIFF[path])
        raise ValueError(
            f"source-to-harness diff does not match the reviewed allowlist; "
            f"unexpected={unexpected}, missing={missing}, mismatched={mismatched}"
        )
    return list(OVERLAY_PATHS)


def _git(root: Path, *args: str, binary: bool = False) -> str | bytes:
    result = run_harness_command(["git", "-C", str(root), *args], timeout=120, binary_output=binary)
    if result.returncode != 0:
        raise ValueError(f"git command failed: {args[0] if args else 'git'}")
    if binary:
        if not isinstance(result.stdout, bytes):
            raise ValueError("git command did not preserve binary output")
        return result.stdout
    if not isinstance(result.stdout, str):
        raise ValueError("git command returned binary output unexpectedly")
    return result.stdout.strip()


def prepare_candidate_source(harness_root: Path, source_sha: str, harness_sha: str,
                             source_root: Path, manifest_path: Path) -> dict:
    """Validate the source-to-harness boundary and create an unmodified source worktree."""
    actual_harness = _git(harness_root, "rev-parse", "HEAD")
    if actual_harness != harness_sha:
        raise ValueError("checked out harness SHA does not match the requested harness SHA")
    if _git(harness_root, "status", "--porcelain"):
        raise ValueError("harness checkout has tracked modifications")
    ancestor = run_harness_command(["git", "-C", str(harness_root), "merge-base", "--is-ancestor",
                                    source_sha, harness_sha], timeout=120)
    if ancestor.returncode != 0:
        raise ValueError("candidate source SHA is not an ancestor of the harness SHA")
    raw_diff = _git(harness_root, "diff", "--no-renames", "--raw", "-z",
                    source_sha, harness_sha, binary=True)
    overlay_paths = parse_and_validate_raw_diff(raw_diff)
    if source_root.exists():
        raise ValueError("candidate source worktree destination already exists")
    _git(harness_root, "worktree", "add", "--detach", str(source_root), source_sha)
    if _git(source_root, "rev-parse", "HEAD") != source_sha:
        raise ValueError("candidate source worktree did not check out the requested source SHA")
    if _git(source_root, "status", "--porcelain", "--untracked-files=no"):
        raise ValueError("candidate source worktree is not clean before harness overlay")

    changed_files = []
    for relative_path, (status, old_mode, new_mode) in EXPECTED_DIFF.items():
        blob_id = _git(harness_root, "rev-parse", f"{harness_sha}:{relative_path}")
        changed_files.append({"path": relative_path, "status": status,
                              "oldMode": old_mode, "newMode": new_mode, "harnessBlob": blob_id})
    manifest = {"candidateSourceSha": source_sha, "harnessSha": harness_sha,
                "changedFiles": changed_files, "overlayPaths": []}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def apply_harness_overlay(harness_root: Path, source_root: Path, manifest_path: Path) -> dict:
    """Overlay the five runtime/case files after source artifact verification."""
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    source_sha = manifest.get("candidateSourceSha")
    harness_sha = manifest.get("harnessSha")
    if not isinstance(source_sha, str) or not isinstance(harness_sha, str):
        raise ValueError("overlay manifest is missing source and harness identities")
    if _git(harness_root, "rev-parse", "HEAD") != harness_sha:
        raise ValueError("checked out harness SHA changed before overlay")
    if _git(source_root, "rev-parse", "HEAD") != source_sha:
        raise ValueError("candidate source HEAD changed before overlay")
    if _git(harness_root, "status", "--porcelain"):
        raise ValueError("harness checkout has tracked or untracked modifications")
    if _git(source_root, "status", "--porcelain", "--untracked-files=no"):
        raise ValueError("candidate source worktree is not clean before harness overlay")
    raw_diff = _git(harness_root, "diff", "--no-renames", "--raw", "-z",
                    source_sha, harness_sha, binary=True)
    if parse_and_validate_raw_diff(raw_diff) != list(OVERLAY_PATHS):
        raise ValueError("source-to-harness overlay paths differ from the prepared manifest")
    expected_changed_files = []
    for relative_path, (status, old_mode, new_mode) in EXPECTED_DIFF.items():
        blob_id = _git(harness_root, "rev-parse", f"{harness_sha}:{relative_path}")
        expected_changed_files.append({"path": relative_path, "status": status,
                                       "oldMode": old_mode, "newMode": new_mode, "harnessBlob": blob_id})
    if manifest.get("changedFiles") != expected_changed_files:
        raise ValueError("prepared source-to-harness manifest changed before overlay")
    blob_ids = {}
    for relative_path in OVERLAY_PATHS:
        contents = _git(harness_root, "show", f"{harness_sha}:{relative_path}", binary=True)
        destination = source_root / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(contents)
        blob_ids[relative_path] = _git(harness_root, "rev-parse", f"{harness_sha}:{relative_path}")
        restored_blob = _git(source_root, "hash-object", "--no-filters", "--", relative_path)
        if restored_blob != blob_ids[relative_path]:
            raise ValueError(f"overlaid harness file does not match its commit blob: {relative_path}")
    manifest["overlayPaths"] = [{"path": path, "blob": blob_ids[path]} for path in OVERLAY_PATHS]
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def prepare_overlay(harness_root: Path, source_sha: str, harness_sha: str,
                    source_root: Path, manifest_path: Path) -> dict:
    """Test convenience that prepares, then applies, the reviewed overlay."""
    prepare_candidate_source(harness_root, source_sha, harness_sha, source_root, manifest_path)
    return apply_harness_overlay(harness_root, source_root, manifest_path)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: reuse_candidate_overlay.py prepare|overlay ...", file=sys.stderr)
        return 2
    operation = sys.argv[1]
    try:
        if operation == "prepare" and len(sys.argv) == 7:
            _, harness_root, source_sha, harness_sha, source_root, manifest_path = sys.argv[1:]
            prepare_candidate_source(Path(harness_root), source_sha, harness_sha,
                                     Path(source_root), Path(manifest_path))
        elif operation == "overlay" and len(sys.argv) == 5:
            _, harness_root, source_root, manifest_path = sys.argv[1:]
            apply_harness_overlay(Path(harness_root), Path(source_root), Path(manifest_path))
        else:
            raise ValueError("invalid overlay operation arguments")
    except (OSError, UnicodeError, ValueError) as error:
        print(f"candidate harness overlay refused: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
