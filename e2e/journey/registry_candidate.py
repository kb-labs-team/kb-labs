"""Create isolated Registry candidate roots and verify their release graph.

This helper never resets a registry or overwrites an existing candidate. Its
preflight accepts loopback Verdaccio only and emits a publish directory that
contains just graph artifacts missing from that registry.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import tarfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.request import urlopen

from invocations import run_harness_command
from batch_summary import verify_candidate_archive, verify_run_commit


_SOURCE_EXCLUDES = {".git", ".journey", ".kb", "node_modules", "dist", ".next", "target"}


def source_identity(workspace: Path) -> dict:
    workspace = workspace.resolve()
    head_result = run_harness_command(["git", "rev-parse", "HEAD"], cwd=workspace)
    paths_result = run_harness_command(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                                       cwd=workspace)
    if head_result.returncode != 0 or paths_result.returncode != 0:
        raise RuntimeError("could not read the current git source identity")
    head = head_result.stdout.strip()
    paths = paths_result.stdout.encode().split(b"\0")
    digest = hashlib.sha256()
    included = 0
    for raw in sorted(path for path in paths if path):
        relative = Path(os.fsdecode(raw))
        if any(part in _SOURCE_EXCLUDES for part in relative.parts):
            continue
        file_path = workspace / relative
        if not file_path.is_file() and not file_path.is_symlink():
            continue
        digest.update(raw)
        digest.update(b"\0")
        if file_path.is_symlink():
            digest.update(b"symlink\0" + os.fsencode(os.readlink(file_path)))
        else:
            digest.update(b"file\0")
            with file_path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
        digest.update(b"\0")
        included += 1
    status_result = run_harness_command(["git", "status", "--porcelain", "--untracked-files=all"], cwd=workspace)
    if status_result.returncode != 0:
        raise RuntimeError("could not read the current git working-tree status")
    status = status_result.stdout
    return {
        "gitHead": head,
        "sourceTreeSha256": digest.hexdigest(),
        "dirty": bool(status.strip()),
        "sourceFileCount": included,
        "sourceRoot": str(workspace),
    }


def allocate_candidate_root(workspace: Path, parent: Path) -> Path:
    identity = source_identity(workspace)
    parent = parent.resolve()
    parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    candidate_id = f"{stamp}-{identity['sourceTreeSha256'][:12]}"
    root = parent / candidate_id
    root.mkdir()  # Exclusive: never reuse or clean an earlier run.
    for directory in ("packages", "release", "reports"):
        (root / directory).mkdir()
    identity.update({"schema": "kb.journey.registry-candidate/v1", "candidateId": candidate_id,
                     "createdAt": datetime.now(timezone.utc).isoformat(), "candidateRoot": str(root)})
    (root / "source-identity.json").write_text(json.dumps(identity, indent=2) + "\n", encoding="utf-8")
    return root


def stage_verified_batch_candidate(workspace: Path, parent: Path, run: Path,
                                   metadata: Path, archive_path: Path) -> Path:
    """Stage only Registry inputs from a verified producer into a new candidate root."""
    identity = source_identity(workspace)
    if identity["dirty"]:
        raise ValueError("batch candidate staging requires a clean checkout at the producer commit")
    verify_run_commit(run, identity["gitHead"])
    producer_metadata = json.loads(metadata.read_text(encoding="utf-8"))
    if producer_metadata.get("commit") != identity["gitHead"]:
        raise ValueError("candidate metadata is bound to a foreign commit")
    members = verify_candidate_archive(metadata, archive_path)
    selected: list[tuple[tarfile.TarInfo, Path]] = []
    for member in members:
        if not member.isfile():
            continue
        parts = list(Path(member.name).parts)
        if parts[:2] == [".journey", "release"]:
            selected.append((member, Path("release", *parts[2:])))
        elif parts[:2] == ["e2e", "packages"]:
            selected.append((member, Path("packages", *parts[2:])))
    selected_paths = {target for _, target in selected}
    if Path("release/journey-candidate/release-index.json") not in selected_paths:
        raise FileNotFoundError("verified candidate archive has no Registry release index")
    if not any(target.parent == Path("packages") and target.suffix == ".tgz"
               for target in selected_paths):
        raise FileNotFoundError("verified candidate archive has no Registry package tarballs")
    root = allocate_candidate_root(workspace, parent)
    with tarfile.open(archive_path, "r:") as source:
        for member, target in selected:
            destination = root / target
            destination.parent.mkdir(parents=True, exist_ok=True)
            stream = source.extractfile(member)
            if stream is None:
                raise ValueError(f"verified candidate archive member is unreadable: {member.name}")
            with stream, destination.open("xb") as output:
                shutil.copyfileobj(stream, output)
    return root


def _artifact_entries(index: dict) -> list[dict]:
    entries: dict[tuple[str, str], dict] = {}
    for group in ("platforms", "sdks", "plugins", "adapters"):
        for item in index.get(group, []):
            candidates = [item, *item.get("members", [])] if group == "platforms" else [item]
            for entry in candidates:
                package, version = entry.get("package"), entry.get("version")
                if not isinstance(package, str) or not isinstance(version, str):
                    raise ValueError(f"{group} contains an artifact without package/version")
                key = (package, version)
                previous = entries.get(key)
                if previous:
                    for field in ("sha256", "tarball"):
                        if previous.get(field) and entry.get(field) and previous[field] != entry[field]:
                            raise ValueError(f"release index has conflicting {field} for {package}@{version}")
                    entries[key] = {**previous, **entry}
                else:
                    entries[key] = entry
    if not entries:
        raise ValueError("release index contains no package artifact graph")
    return [entries[key] for key in sorted(entries)]


def _version_key(value: str) -> tuple:
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?", value)
    if not match:
        raise ValueError(f"unsupported package version in candidate graph: {value}")
    major, minor, patch, prerelease = match.groups()
    if prerelease is None:
        pre_key = (1,)
    else:
        parts = []
        for part in prerelease.split("."):
            parts.append((0, int(part)) if part.isdigit() else (1, part))
        pre_key = (0, *parts)
    return int(major), int(minor), int(patch), pre_key


def _satisfies(version: str, requirement: str) -> bool:
    if version == requirement:
        return True
    operator = requirement[:2] if requirement[:2] in {">=", "<="} else requirement[:1]
    base = requirement[len(operator):] if operator else requirement
    base = base.lstrip("=v")
    if base in {"", "*", "x", "X", "latest"}:
        return True
    try:
        version_key, base_key = _version_key(version), _version_key(base)
    except ValueError:
        return False
    if operator == "^":
        major, minor, patch = base_key[:3]
        ceiling = (major + 1, 0, 0) if major else ((0, minor + 1, 0) if minor else (0, 0, patch + 1))
        return version_key[:3] >= (major, minor, patch) and version_key[:3] < ceiling
    if operator == "~":
        major, minor, patch = base_key[:3]
        return version_key[:3] >= (major, minor, patch) and version_key[:2] == (major, minor)
    if operator in {">", ">=", "<", "<="}:
        return {">": version_key > base_key, ">=": version_key >= base_key,
                "<": version_key < base_key, "<=": version_key <= base_key}[operator]
    return version_key == base_key


def _package_catalog(packages_dir: Path) -> dict[tuple[str, str], tuple[Path, dict]]:
    catalog = {}
    for tarball in sorted(packages_dir.glob("*.tgz")):
        with tarfile.open(tarball, "r:gz") as archive:
            manifest_stream = archive.extractfile("package/package.json")
            if manifest_stream is None:
                continue
            manifest = json.load(manifest_stream)
        key = (manifest.get("name"), manifest.get("version"))
        if not all(isinstance(part, str) for part in key):
            raise ValueError(f"package tarball has incomplete identity: {tarball.name}")
        if key in catalog:
            raise ValueError(f"package set contains duplicate immutable identity: {key[0]}@{key[1]}")
        catalog[key] = (tarball, manifest)
    return catalog


def _package_content_digest(tarball: Path) -> str:
    digest = hashlib.sha256()
    with tarfile.open(tarball, "r:gz") as archive:
        for member in sorted((item for item in archive.getmembers() if item.isfile()), key=lambda item: item.name):
            stream = archive.extractfile(member)
            if stream is None:
                raise ValueError(f"package archive has an unreadable member: {member.name}")
            digest.update(member.name.encode("utf-8"))
            digest.update(b"\0")
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
            digest.update(b"\0")
    return digest.hexdigest()


def _resolve_catalog_package(catalog: dict, package: str, requirement: str) -> tuple[str, str] | None:
    if requirement.startswith("workspace:"):
        raise ValueError(f"workspace dependency escaped into the candidate graph: {package} {requirement}")
    matches = [key for key in catalog if key[0] == package and _satisfies(key[1], requirement)]
    return max(matches, key=lambda item: _version_key(item[1])) if matches else None


def _read_registry_metadata(registry_url: str, package: str) -> dict | None:
    base = urlsplit(registry_url)
    if base.scheme != "http" or base.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("Registry candidate preflight only permits a loopback HTTP Verdaccio URL")
    endpoint = urlunsplit((base.scheme, base.netloc, quote(package, safe="@").replace("%2F", "%2f"), "", ""))
    try:
        with urlopen(endpoint, timeout=10) as response:
            payload = response.read()
    except HTTPError as error:
        if error.code == 404:
            return None
        raise ValueError(f"Verdaccio metadata request failed with HTTP {error.code} for {package}") from error
    except URLError as error:
        raise ValueError(f"Verdaccio metadata request failed for {package}: {error.reason}") from error
    try:
        result = json.loads(payload)
    except json.JSONDecodeError as error:
        raise ValueError(f"Verdaccio returned invalid package metadata for {package}") from error
    return result if isinstance(result, dict) else None


def preflight_release_graph(release_index: Path, packages_dir: Path, registry_url: str,
                            publish_dir: Path, root_packages: tuple[str, ...] = (),
                            candidate_root: Path | None = None,
                            workspace_root: Path | None = None) -> dict:
    index = json.loads(release_index.read_text(encoding="utf-8"))
    packages_dir = packages_dir.resolve()
    if candidate_root is not None:
        identity_path = candidate_root.resolve() / "source-identity.json"
        if not identity_path.is_file() or workspace_root is None:
            raise ValueError("candidate root and workspace source identity are required together")
        recorded = json.loads(identity_path.read_text(encoding="utf-8"))
        current = source_identity(workspace_root)
        if recorded.get("sourceTreeSha256") != current.get("sourceTreeSha256") or recorded.get("gitHead") != current.get("gitHead"):
            raise ValueError("candidate artifacts do not match the current working-tree source identity")
    if publish_dir.exists():
        raise FileExistsError(f"refusing to reuse existing publish plan directory: {publish_dir}")
    index_entries = _artifact_entries(index)
    catalog = _package_catalog(packages_dir)
    graph: dict[tuple[str, str], dict] = {}
    pending: list[tuple[str, str]] = []
    for entry in index_entries:
        key = (entry["package"], entry["version"])
        graph[key] = entry
        pending.append(key)
    for root_spec in root_packages:
        package, separator, version = root_spec.rpartition("@")
        if not separator or not package or not version:
            raise ValueError(f"invalid extra candidate root package: {root_spec}")
        key = (package, version)
        if key not in catalog:
            raise FileNotFoundError(f"extra candidate root package is not packed: {root_spec}")
        graph.setdefault(key, {"package": package, "version": version})
        pending.append(key)
    while pending:
        package, version = pending.pop()
        item = catalog.get((package, version))
        if item is None:
            raise FileNotFoundError(f"candidate graph dependency is not packed: {package}@{version}")
        manifest = item[1]
        for section in ("dependencies", "optionalDependencies", "peerDependencies"):
            dependencies = manifest.get(section, {})
            optional_peers = manifest.get("peerDependenciesMeta", {})
            for dependency, requirement in dependencies.items():
                if not dependency.startswith("@kb-labs/"):
                    continue
                resolved = _resolve_catalog_package(catalog, dependency, requirement)
                if resolved is None:
                    if section == "peerDependencies" and optional_peers.get(dependency, {}).get("optional"):
                        continue
                    raise FileNotFoundError(
                        f"candidate graph cannot resolve {dependency}@{requirement} required by {package}@{version}"
                    )
                if resolved not in graph:
                    graph[resolved] = {"package": resolved[0], "version": resolved[1]}
                    pending.append(resolved)
    verified: list[dict] = []
    missing: list[dict] = []
    registry_cache: dict[str, dict | None] = {}
    for (package, version), entry in sorted(graph.items()):
        catalog_item = catalog[(package, version)]
        local_tarball = catalog_item[0]
        registry_filename = Path(urlsplit(entry.get("tarball", "")).path).name if entry.get("tarball") else ""
        if entry.get("tarball") and (not registry_filename or Path(registry_filename).name != registry_filename):
            raise ValueError(f"release index has an invalid tarball path for {package}@{version}")
        filename = local_tarball.name
        tarball = local_tarball
        if not tarball.is_file():
            raise FileNotFoundError(f"release artifact is missing locally: {package}@{version}")
        content = tarball.read_bytes()
        sha256 = hashlib.sha256(content).hexdigest()
        if entry.get("sha256") and sha256 != entry.get("sha256"):
            raise ValueError(f"release artifact digest mismatch for {package}@{version}")
        with tarfile.open(tarball, "r:gz") as archive:
            manifest_stream = archive.extractfile("package/package.json")
            if manifest_stream is None:
                raise ValueError(f"release artifact has no package/package.json: {filename}")
            manifest = json.load(manifest_stream)
        if (manifest.get("name"), manifest.get("version")) != (package, version):
            raise ValueError(f"release artifact identity mismatch for {package}@{version}")
        local_integrity = "sha512-" + base64.b64encode(hashlib.sha512(content).digest()).decode("ascii")
        if package not in registry_cache:
            registry_cache[package] = _read_registry_metadata(registry_url, package)
        metadata = registry_cache[package]
        remote = (metadata or {}).get("versions", {}).get(version)
        if remote:
            dist = remote.get("dist", {})
            if dist.get("integrity") != local_integrity:
                raise ValueError(f"immutable Registry version has different bytes: {package}@{version}")
            verified.append({"package": package, "version": version, "tarball": filename,
                             "source": "verified-existing"})
        else:
            missing.append({"package": package, "version": version, "tarball": filename,
                            "source": "publish-new"})
    publish_dir.mkdir(parents=True)
    for item in missing:
        shutil.copyfile(packages_dir / item["tarball"], publish_dir / item["tarball"])
    return {"schema": "kb.journey.registry-publish-plan/v1", "releaseIndex": str(release_index.resolve()),
            "registryUrl": registry_url, "graphArtifacts": len(graph), "reused": len(verified),
            "toPublish": len(missing), "verified": verified, "publish": missing}


def main() -> int:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    allocate = commands.add_parser("allocate")
    allocate.add_argument("--workspace", type=Path, required=True)
    allocate.add_argument("--parent", type=Path, required=True)
    stage = commands.add_parser("stage-batch")
    stage.add_argument("--workspace", type=Path, required=True)
    stage.add_argument("--parent", type=Path, required=True)
    stage.add_argument("--run", type=Path, required=True)
    stage.add_argument("--metadata", type=Path, required=True)
    stage.add_argument("--archive", type=Path, required=True)
    preflight = commands.add_parser("preflight")
    preflight.add_argument("--release-index", type=Path, required=True)
    preflight.add_argument("--packages-dir", type=Path, required=True)
    preflight.add_argument("--registry-url", required=True)
    preflight.add_argument("--publish-dir", type=Path, required=True)
    preflight.add_argument("--plan-output", type=Path, required=True)
    preflight.add_argument("--root-package", action="append", default=[])
    preflight.add_argument("--candidate-root", type=Path)
    preflight.add_argument("--workspace-root", type=Path)
    args = parser.parse_args()
    if args.command == "allocate":
        root = allocate_candidate_root(args.workspace, args.parent)
        print(root)
        return 0
    if args.command == "stage-batch":
        root = stage_verified_batch_candidate(args.workspace, args.parent, args.run,
                                              args.metadata, args.archive)
        print(root)
        return 0
    plan = preflight_release_graph(args.release_index, args.packages_dir, args.registry_url,
                                   args.publish_dir, tuple(args.root_package),
                                   args.candidate_root, args.workspace_root)
    args.plan_output.parent.mkdir(parents=True, exist_ok=True)
    with args.plan_output.open("x", encoding="utf-8") as stream:
        json.dump(plan, stream, indent=2)
        stream.write("\n")
    print(json.dumps({key: plan[key] for key in ("graphArtifacts", "reused", "toPublish")}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
