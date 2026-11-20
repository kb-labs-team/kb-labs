#!/usr/bin/env python3
"""Fingerprint and validate exact-source prepared journey candidates."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import shutil
import subprocess
import sys
import tarfile
from typing import Any


SCHEMA_VERSION = 1
INPUT_PATHS = (
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "devkit.yaml",
    "tools/kb-devkit/go.mod",
    "tools/kb-devkit/go.sum",
    "tools/kb-create/go.mod",
    "tools/kb-create/go.sum",
    "tools/kb-create/config/platform-release.jsonc",
    "tools/kb-create/scripts/prepare-release-index.mjs",
    "e2e/journey/batch.sh",
    "e2e/journey/batch_summary.py",
    "e2e/journey/candidate_cache.py",
    "e2e/journey/preflight.sh",
    "e2e/journey/run.sh",
    "e2e/journey/prepare-candidate.sh",
    "e2e/journey/prepare-candidate-packages.sh",
    "e2e/journey/stage-runner-inputs.sh",
    "e2e/journey/candidate-services.sh",
    "e2e/scripts/pack-all.sh",
    "e2e/scripts/build-pack-extras.mjs",
    "e2e/platform/prepare-release-index.mjs",
    "e2e/platform/release-index-package-stage.mjs",
    "e2e/platform/stage-release-binaries.mjs",
    "e2e/platform/registry-manifest.json",
    "e2e/platform/validate-package-outputs.mjs",
    "scripts/ci/journey-batch-selection.mjs",
    "scripts/prepare-candidate-binaries.sh",
    ".github/workflows/journey-batch.yml",
    ".github/actions/install-goreleaser/action.yml",
)
CANDIDATE_INDEX = ".journey/release/journey-candidate/release-index.json"
CANDIDATE_CHECKSUMS = ".journey/release/journey-candidate/checksums.txt"


def _run(root: Path, *args: str) -> str:
    return subprocess.check_output(args, cwd=root, text=True, stderr=subprocess.PIPE).strip()


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _sha256_stream(file: Any) -> str:
    digest = hashlib.sha256()
    for chunk in iter(lambda: file.read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()


def _source_sha(root: Path) -> str:
    value = _run(root, "git", "rev-parse", "HEAD")
    if len(value) != 40 or any(char not in "0123456789abcdef" for char in value):
        raise ValueError("candidate cache source SHA is not a full Git commit SHA")
    return value


def _source_short_sha(root: Path) -> str:
    value = _run(root, "git", "rev-parse", "--short", "HEAD")
    if not value or any(char not in "0123456789abcdef" for char in value):
        raise ValueError("candidate cache source provenance has an invalid short SHA")
    return value


def _input_digests(root: Path) -> dict[str, dict[str, Any]]:
    values: dict[str, dict[str, Any]] = {}
    for relative in INPUT_PATHS:
        path = root / relative
        if not path.is_file() or path.is_symlink():
            raise ValueError(f"candidate cache input is missing or unsafe: {relative}")
        tracked = subprocess.run(
            ["git", "ls-files", "--error-unmatch", "--", relative],
            cwd=root, text=True, capture_output=True, check=False,
        )
        if tracked.returncode != 0:
            raise ValueError(f"candidate cache input is not tracked by Git: {relative}")
        values[relative] = {
            "sha256": _sha256_file(path),
            "mode": path.stat().st_mode & 0o111,
        }
    return values


def _canonical_digest(value: dict[str, Any]) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return _sha256_bytes(encoded)


def candidate_identity(root: Path, runtime: dict[str, str]) -> dict[str, Any]:
    if not runtime or any(not isinstance(key, str) or not isinstance(value, str) or not value
                          for key, value in runtime.items()):
        raise ValueError("candidate cache runtime identity is incomplete")
    source_sha = _source_sha(root)
    inputs = _input_digests(root)
    identity = {
        "sourceSha": source_sha,
        "inputs": inputs,
        "runtime": dict(sorted(runtime.items())),
    }
    return {
        **identity,
        "inputFingerprint": _canonical_digest(identity),
    }


def current_runtime() -> dict[str, str]:
    def version(*command: str) -> str:
        value = subprocess.check_output(command, text=True, stderr=subprocess.STDOUT).strip()
        if not value:
            raise ValueError(f"candidate cache tool returned no version: {command[0]}")
        return value

    return {
        "runnerOs": os.environ.get("RUNNER_OS", ""),
        "runnerArch": os.environ.get("RUNNER_ARCH", ""),
        "imageOs": os.environ.get("ImageOS") or "unknown",
        "imageVersion": os.environ.get("ImageVersion") or "unknown",
        "node": version("node", "--version"),
        "go": version("go", "version"),
        "pnpm": version("corepack", "pnpm", "--version"),
    }


def cache_key(identity: dict[str, Any]) -> str:
    runtime = identity["runtime"]
    return (f"journey-prepared-candidate-v{SCHEMA_VERSION}-"
            f"{runtime['runnerOs']}-{runtime['runnerArch']}-{identity['sourceSha']}-"
            f"{identity['inputFingerprint']}")


def _normalize_member_name(name: str) -> str:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"candidate archive contains an unsafe path: {name}")
    normalized = posixpath.normpath(name)
    return normalized.removeprefix("./").rstrip("/")


def _archive_members(archive: tarfile.TarFile) -> dict[str, tarfile.TarInfo]:
    members: dict[str, tarfile.TarInfo] = {}
    for member in archive.getmembers():
        name = _normalize_member_name(member.name)
        if not name:
            continue
        if name in members:
            raise ValueError(f"candidate archive repeats path {name}")
        if member.issym() or member.islnk():
            link = PurePosixPath(member.linkname)
            if link.is_absolute():
                raise ValueError(f"candidate archive contains an absolute link: {name}")
            base = PurePosixPath(name).parent if member.issym() else PurePosixPath()
            target = posixpath.normpath(str(base / link))
            if target == ".." or target.startswith("../"):
                raise ValueError(f"candidate archive contains an escaping link: {name}")
        members[name] = member
    return members


def _candidate_contents(path: Path, root: Path, expected_source_sha: str) -> dict[str, str]:
    with tarfile.open(path, "r:") as archive:
        members = _archive_members(archive)
        index_member = members.get(CANDIDATE_INDEX)
        checksum_member = members.get(CANDIDATE_CHECKSUMS)
        if index_member is None or not index_member.isfile() or checksum_member is None or not checksum_member.isfile():
            raise ValueError("candidate archive is missing the sealed release index or its checksums")
        index_file = archive.extractfile(index_member)
        checksums_file = archive.extractfile(checksum_member)
        if index_file is None or checksums_file is None:
            raise ValueError("candidate archive release evidence could not be read")
        index_bytes = index_file.read()
        checksums_bytes = checksums_file.read()
        try:
            index = json.loads(index_bytes)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("candidate archive release index is invalid JSON") from error
        provenance = index.get("provenance") if isinstance(index, dict) else None
        short_sha = _source_short_sha(root)
        if _source_sha(root) != expected_source_sha:
            raise ValueError("candidate release provenance is not being checked against the current source SHA")
        if (not isinstance(provenance, list) or not provenance
                or any(not isinstance(item, dict) or item.get("sourceRevision") != short_sha
                       for item in provenance)):
            raise ValueError("candidate release provenance does not match the current source SHA")
        for item in provenance:
            if (not isinstance(item.get("distSha256"), str) or len(item["distSha256"]) != 64
                    or any(char not in "0123456789abcdef" for char in item["distSha256"])):
                raise ValueError("candidate release provenance contains an invalid dist checksum")

        checksums: dict[str, str] = {}
        for line in checksums_bytes.decode("utf-8").splitlines():
            parts = line.split(maxsplit=1)
            if len(parts) != 2 or len(parts[0]) != 64:
                raise ValueError("candidate release checksums file has an invalid entry")
            digest, relative_name = parts
            relative_name = relative_name.lstrip("* ")
            if any(char not in "0123456789abcdef" for char in digest) or relative_name in checksums:
                raise ValueError("candidate release checksums file has an invalid or duplicate entry")
            checksums[relative_name] = digest
        index_relative = "release-index.json"
        if checksums.get(index_relative) != _sha256_bytes(index_bytes):
            raise ValueError("candidate release-index checksum does not match checksums.txt")
        for relative_name, expected_digest in checksums.items():
            member_name = f".journey/release/journey-candidate/{relative_name}"
            member = members.get(member_name)
            if member is None or not member.isfile():
                raise ValueError(f"candidate release checksum names a missing file: {relative_name}")
            data = archive.extractfile(member)
            if data is None or _sha256_stream(data) != expected_digest:
                raise ValueError(f"candidate release file checksum does not match: {relative_name}")
        return {
            "candidateReleaseIndexSha256": _sha256_bytes(index_bytes),
            "candidateChecksumsSha256": _sha256_bytes(checksums_bytes),
            "releaseSourceRevision": short_sha,
        }


def create_candidate_cache(root: Path, archive: Path, cache_dir: Path,
                           runtime: dict[str, str], key: str = "") -> dict[str, Any]:
    identity = candidate_identity(root, runtime)
    status = subprocess.run(["git", "diff", "--quiet", "HEAD", "--"], cwd=root, check=False)
    if status.returncode != 0:
        raise ValueError("candidate cache cannot be sealed from a worktree with tracked changes")
    if not archive.is_file() or archive.is_symlink():
        raise ValueError("candidate archive is missing or unsafe")
    contents = _candidate_contents(archive, root, identity["sourceSha"])
    cache_dir.mkdir(parents=True, exist_ok=True)
    cached_archive = cache_dir / "build-candidate.tar"
    shutil.copyfile(archive, cached_archive)
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        **identity,
        "cacheKey": key or cache_key(identity),
        "candidateArchiveSha256": _sha256_file(cached_archive),
        "candidateArchiveSizeBytes": cached_archive.stat().st_size,
        **contents,
    }
    (cache_dir / "manifest.json").write_text(
        json.dumps(manifest, sort_keys=True, indent=2) + "\n", encoding="utf-8",
    )
    return manifest


def verify_candidate_cache(root: Path, cache_dir: Path, runtime: dict[str, str],
                           key: str = "") -> tuple[bool, str]:
    try:
        current = candidate_identity(root, runtime)
        manifest_path = cache_dir / "manifest.json"
        archive = cache_dir / "build-candidate.tar"
        if manifest_path.is_symlink() or archive.is_symlink() or not manifest_path.is_file() or not archive.is_file():
            return False, "candidate cache is missing its manifest or archive"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict) or manifest.get("schemaVersion") != SCHEMA_VERSION:
            return False, "candidate cache schema is unsupported"
        if manifest.get("sourceSha") != current["sourceSha"]:
            return False, "candidate cache source SHA does not match this checkout"
        if manifest.get("inputs") != current["inputs"]:
            return False, "candidate cache lock or tool inputs differ from this checkout"
        if manifest.get("runtime") != current["runtime"] or manifest.get("inputFingerprint") != current["inputFingerprint"]:
            return False, "candidate cache runtime or input fingerprint does not match"
        expected_key = key or cache_key(current)
        if manifest.get("cacheKey") != expected_key:
            return False, "candidate cache key does not match the current source and runner"
        worktree = subprocess.run(
            ["git", "diff", "--quiet", "HEAD", "--"], cwd=root, check=False,
        )
        if worktree.returncode != 0:
            return False, "candidate cache cannot be reused with tracked worktree changes"
        actual_size = archive.stat().st_size
        actual_digest = _sha256_file(archive)
        if (manifest.get("candidateArchiveSizeBytes") != actual_size
                or manifest.get("candidateArchiveSha256") != actual_digest):
            return False, "candidate archive checksum does not match its cache manifest"
        contents = _candidate_contents(archive, root, current["sourceSha"])
        for name, value in contents.items():
            if manifest.get(name) != value:
                return False, f"candidate archive {name} does not match its cache manifest"
        return True, "candidate cache source, inputs, checksums, and sealed provenance verified"
    except (OSError, ValueError, tarfile.TarError, json.JSONDecodeError) as error:
        return False, str(error)


def _runtime_from_environment() -> dict[str, str]:
    return current_runtime()


def main(argv: list[str]) -> int:
    if len(argv) >= 3 and argv[1] == "key":
        root = Path(argv[2]).resolve()
        identity = candidate_identity(root, _runtime_from_environment())
        value = f"key={cache_key(identity)}\nsource_sha={identity['sourceSha']}\ninput_fingerprint={identity['inputFingerprint']}\n"
        output = os.environ.get("GITHUB_OUTPUT")
        if output:
            with Path(output).open("a", encoding="utf-8") as file:
                file.write(value)
        else:
            sys.stdout.write(value)
        return 0
    if len(argv) in {5, 6} and argv[1] == "seal":
        root, archive, cache_dir = (Path(item).resolve() for item in argv[2:5])
        manifest = create_candidate_cache(root, archive, cache_dir, _runtime_from_environment(), argv[5] if len(argv) == 6 else "")
        print(json.dumps({key: manifest[key] for key in (
            "sourceSha", "inputFingerprint", "cacheKey", "candidateArchiveSha256",
        )}, sort_keys=True))
        return 0
    if len(argv) in {4, 5} and argv[1] == "verify":
        root, cache_dir = Path(argv[2]).resolve(), Path(argv[3]).resolve()
        valid, reason = verify_candidate_cache(root, cache_dir, _runtime_from_environment(), argv[4] if len(argv) == 5 else "")
        print(reason)
        return 0 if valid else 1
    print("usage: candidate_cache.py key <repo> | seal <repo> <archive> <cache-dir> [cache-key] | verify <repo> <cache-dir> [cache-key]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
