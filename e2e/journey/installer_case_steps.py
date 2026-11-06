"""Additional install, repair, and request-selection case claims."""
from __future__ import annotations

from kb_invocation import kb_command
from journey_values import journey_value

import json
import hashlib
import base64
import copy
import os
import platform
import re
import shutil
import shlex
import socket
import stat
import sys
import tempfile
import tarfile
import threading
import urllib.request
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable
from urllib.parse import urlsplit

from platform_update_steps import _json_command
from installed_fixture import (
    active_path,
    add_installed_manifest_requirement as _add_installed_manifest_requirement,
    cleanup_fixture_root as cleanup_installer_fixture_root,
    install_fixture_root as _seed_installed_fixture,
    installed_fixture as _installed_fixture,
    inject_existing_fault,
    installed_path,
    layout_relative,
    layout_value,
    stop_fixture_host as stop_installer_fixture_host,
    unused_loopback_gateway_url,
)
from invocations import (
    CompletedProcess,
    decode_ux_error_result,
    decode_ux_success_result,
    read_kb_create_cli_result,
    catalogued_error_hint,
    catalogued_error_message,
    open_http,
    read_ux_cli_result,
    read_ux_cli_stream,
    run_command as evidence_run_command,
)
from journey_resources import (installer_case_fixture_root, installer_scenario_resources,
                               active_platform_root,
                               snapshot_tree, workspace_resource)
from service_port_assertions import (assert_root_offset, service_ports,
                                     service_transport_ports)
from service_steps import Journey

CommandRunner = Callable[..., CompletedProcess]


def parse_install_refusal(result: CompletedProcess[str]) -> dict | None:
    """Return the typed product envelope from a failed JSON install stream."""
    try:
        envelope = read_ux_cli_stream(result)
    except ValueError:
        return None
    return next((decode_ux_error_result(record) for record in envelope[:-1]
                 if record.get("ok") is False), None)


def verify_installed_candidate_provenance(active_root: Path) -> None:
    """Compare executed package bytes reported by the verifier with the receipt."""
    active_root = Path(active_root)
    installed_path = active_root / ".kb/v2/installed-provenance.json"
    if not installed_path.is_file():
        raise RuntimeError("installed candidate omitted verifier-produced package provenance")
    installed = json.loads(installed_path.read_text())
    packages = installed.get("packages", [])
    if not packages or any(not all(package.get(field) for field in
                                   ("name", "version", "integrity", "installedPath", "sourceRevision", "contentDigest"))
                           for package in packages):
        raise RuntimeError("installed candidate provenance omitted a resolved identity field")
    receipt = json.loads((active_root / ".kb/v2/receipt.json").read_text())
    sealed = {
        (artifact.get("package"), artifact.get("version")): artifact.get("provenance", {}).get("distSha256")
        for artifact in receipt.get("plan", {}).get("artifacts", [])
        if artifact.get("package")
    }
    executed = {
        (package.get("name"), package.get("version")): package.get("contentDigest")
        for package in packages
    }
    if set(executed) != set(sealed):
        missing = sorted(set(sealed) - set(executed))
        unexpected = sorted(set(executed) - set(sealed))
        raise RuntimeError(
            "installed package closure differs from the sealed release manifest: "
            f"missing={missing}, unexpected={unexpected}")
    if not executed or any(sealed.get(identity) != digest for identity, digest in executed.items()):
        raise RuntimeError("installed executed package dist digests differ from the sealed provenance manifest")


def _candidate_package_records(index: dict) -> list[dict]:
    records = []
    for platform_bundle in index.get("platforms", []):
        records.append(platform_bundle)
        records.extend(platform_bundle.get("members", []))
    records.extend(index.get("sdks", []))
    records.extend(index.get("plugins", []))
    records.extend(index.get("adapters", []))
    return [record for record in records
            if isinstance(record, dict) and all(isinstance(record.get(field), str) and record[field]
                                                for field in ("package", "version", "tarball", "sha256"))]


def commit_marketplace_install_record(receipt: dict) -> dict | None:
    """Return the resolved Marketplace record for the requested Commit scenario plugin."""
    installs = receipt.get("marketplaceInstalls", [])
    return next((entry for entry in installs
                 if isinstance(entry, dict) and entry.get("id") == "@kb-labs/commit"
                 and entry.get("spec") == "@kb-labs/commit"
                 and entry.get("version") and entry.get("source")), None)


def assert_commit_marketplace_receipt(receipt: dict) -> None:
    """Require the built-in Commit scenario result to come from Marketplace."""
    request = receipt.get("plan", {}).get("request", {})
    if request.get("scenarioId") != "commit":
        raise RuntimeError("Commit scenario receipt does not identify the commit scenario")
    if not commit_marketplace_install_record(receipt):
        raise RuntimeError("Commit scenario receipt omitted requested spec, Marketplace source, or resolved version")
    if any(artifact.get("id") == "@kb-labs/commit" for artifact in receipt.get("plan", {}).get("artifacts", [])):
        raise RuntimeError("Commit Marketplace identity was incorrectly resolved from the release index")


def assert_apply_shim_owner(result: dict, platform_root: Path) -> None:
    """Check the apply result's shim when the invocation owns or links it."""
    shim = result.get("shim")
    if shim is not None and shim != {"linked": True, "owner": str(platform_root.resolve())}:
        raise RuntimeError("apply result reported a shim that is not linked to the canonical platform root")


def _extract_candidate_tarball(tarball: Path, package_root: Path, package: str) -> None:
    with tarfile.open(tarball, "r:gz") as archive:
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != "package":
                raise RuntimeError(f"candidate tarball for {package} has an unsafe member path")
            if member.issym() or member.islnk():
                raise RuntimeError(f"candidate tarball for {package} contains a symlink")
            if member.isdir():
                continue
            if not member.isfile():
                raise RuntimeError(f"candidate tarball for {package} contains a non-file member")
            relative = Path(*path.parts[1:])
            destination = package_root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise RuntimeError(f"candidate tarball for {package} contains an unreadable file")
            with source, destination.open("wb") as output:
                shutil.copyfileobj(source, output)


def _mutate_candidate_dist(source_tarball: Path, destination: Path, package: str) -> None:
    with tempfile.TemporaryDirectory(prefix="pc001-package-unpack-") as temporary:
        extracted = Path(temporary)
        _extract_candidate_tarball(source_tarball, extracted, package)
        dist = extracted / "dist"
        dist_files = sorted(path for path in dist.rglob("*") if path.is_file())
        if not dist_files:
            raise RuntimeError(f"candidate package {package} has no regular file under dist")
        changed = dist_files[0]
        data = changed.read_bytes()
        changed.write_bytes(bytes([data[0] ^ 1]) + data[1:] if data else b"\0")
        with tarfile.open(destination, "w:gz") as archive:
            for path in sorted(extracted.rglob("*")):
                archive.add(path, arcname=Path("package") / path.relative_to(extracted), recursive=False)


def _extract_candidate_package(tarball: Path, manifest_root: Path, package: str) -> None:
    package_root = manifest_root / "node_modules" / Path(*PurePosixPath(package).parts)
    _extract_candidate_tarball(tarball, package_root, package)


def _repack_candidate_with_changed_mtimes(source: Path, destination: Path) -> None:
    with tarfile.open(source, "r:gz") as original, tarfile.open(destination, "w:gz") as repacked:
        for member in original.getmembers():
            changed = copy.copy(member)
            changed.mtime += 120
            if member.isfile():
                contents = original.extractfile(member)
                if contents is None:
                    raise RuntimeError(f"candidate archive member {member.name} could not be read")
                with contents:
                    repacked.addfile(changed, contents)
            else:
                repacked.addfile(changed)


def _serve_candidate_directory(directory: Path):
    handler = lambda *args, **kwargs: SimpleHTTPRequestHandler(*args, directory=str(directory), **kwargs)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, name="pc001-provenance-origin", daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


@contextmanager
def _candidate_origin(directory: Path):
    yield from _serve_candidate_directory(directory)


def _build_candidate_provenance_mutation(*, index_path: Path, directory: Path,
                                         sealer: str, install_receipt: dict,
                                         origin_base: str) -> tuple[Path, str, str, str, Path]:
    index = json.loads(index_path.read_text(encoding="utf-8"))
    provenance = {(item["package"], item["version"]): item
                  for item in index.get("provenance", [])}
    selected = next((item for item in install_receipt.get("plan", {}).get("artifacts", [])
                     if (item.get("package"), item.get("version")) in provenance), None)
    if selected is None:
        raise RuntimeError("candidate has no selected package artifact with sealed provenance")
    identity = (selected["package"], selected["version"])
    records = _candidate_package_records(index)
    changed_record = next((item for item in records
                           if (item["package"], item["version"]) == identity), None)
    if changed_record is None:
        raise RuntimeError(f"sealed candidate omits package record {identity[0]}@{identity[1]}")

    directory.mkdir(parents=True, exist_ok=True)
    original = directory / "original-package.tgz"
    request = urllib.request.Request(changed_record["tarball"])
    status, body, _ = open_http(urllib.request.urlopen, request, timeout=60, env=os.environ)
    if status != 200:
        raise RuntimeError(f"candidate package request returned HTTP {status}")
    original.write_bytes(body)
    mutated = directory / "mutated-package.tgz"
    _mutate_candidate_dist(original, mutated, identity[0])
    expected_dist = provenance[identity]["distSha256"]
    mutated_name = f"{identity[0].replace('/', '-')}-{identity[1]}-mutated.tgz"
    served_tarball = directory / mutated_name
    mutated.replace(served_tarball)
    for item in records:
        if (item["package"], item["version"]) == identity:
            item["tarball"] = f"{origin_base}/{mutated_name}"
            item["sha256"] = hashlib.sha256(served_tarball.read_bytes()).hexdigest()
            item["sizeBytes"] = served_tarball.stat().st_size

    manifest_root = directory / "manifest-root"
    source_tarballs: dict[tuple[str, str], Path] = {}
    for item in records:
        key = item["package"], item["version"]
        if key in source_tarballs:
            continue
        if key == identity:
            source_tarball = original
        else:
            source_tarball = directory / f"package-{len(source_tarballs)}.tgz"
            status, body, _ = open_http(urllib.request.urlopen,
                                       urllib.request.Request(item["tarball"]),
                                       timeout=60, env=os.environ)
            if status != 200:
                raise RuntimeError(f"candidate package request returned HTTP {status}")
            source_tarball.write_bytes(body)
        source_tarballs[key] = source_tarball
        package_tarball = served_tarball if key == identity else source_tarball
        _extract_candidate_package(package_tarball, manifest_root, item["package"])

    original_set = directory / "candidate-packages-original"
    repacked_set = directory / "candidate-packages-repacked"
    changed_set = directory / "candidate-packages-changed"
    for package_set in (original_set, repacked_set, changed_set):
        package_set.mkdir()
    for position, item in enumerate(index.get("provenance", [])):
        key = item["package"], item["version"]
        source_tarball = source_tarballs.get(key)
        if source_tarball is None:
            raise RuntimeError(f"candidate provenance has no package record for {key[0]}@{key[1]}")
        filename = f"candidate-{position}.tgz"
        copy = original_set / filename
        shutil.copyfile(source_tarball, copy)
        changed_copy = changed_set / filename
        shutil.copyfile(served_tarball if key == identity else source_tarball, changed_copy)
        _repack_candidate_with_changed_mtimes(source_tarball, repacked_set / filename)

    producer = workspace_resource("e2e", "platform", "journey-update-packages.mjs")
    def candidate_version(package_set: Path) -> str:
        result = evidence_run_command(["node", str(producer), "--base-version", "1.0.0",
                                       "--packages-dir", str(package_set),
                                       "--digest-tool", sealer], timeout=300)
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
            raise RuntimeError(f"candidate content version calculation failed: {detail}")
        return result.stdout.strip()

    original_version = candidate_version(original_set)
    if original_version != candidate_version(repacked_set):
        raise RuntimeError("candidate version changed when unchanged package bytes were repacked with different mtimes")
    changed_version = candidate_version(changed_set)
    if original_version == changed_version:
        raise RuntimeError("candidate version did not change when one packed dist byte changed")

    mutated_index = directory / "release-index-provenance-mismatch.json"
    candidate_input = directory / "candidate-index.json"
    candidate_input.write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    result = evidence_run_command([sealer, "--input", str(candidate_input), "--manifest-root", str(manifest_root),
                                   "--output", str(mutated_index)], timeout=300)
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise RuntimeError(f"could not seal the candidate-derived provenance mutation index: {detail}")
    return mutated_index, identity[0], identity[1], expected_dist, served_tarball


def assert_provenance_mismatch_refusal(result: CompletedProcess[str], *, install_root: Path,
                                       package: str, expected_dist: str) -> None:
    _, error = _diagnostic(result, "PC-001.19 tampered candidate install")
    if error.get("code") != "KB_INSTALL_PROVENANCE_MISMATCH":
        raise RuntimeError("tampered candidate install did not return the catalogued provenance-mismatch code")
    details = error.get("details", {})
    actual_dist = details.get("actual") if isinstance(details, dict) else None
    package_path = f"node_modules/{package}"
    template_values = {
        "package": package, "field": "digest", "expected": expected_dist,
        "actual": actual_dist, "packagePath": package_path, "digestVersion": "kb-dist-digest/v1",
    }
    if (not isinstance(details, dict) or details.get("field") != "digest"
            or details.get("expected") != expected_dist or details.get("package") != package
            or details.get("packagePath") != package_path
            or details.get("digestVersion") != "kb-dist-digest/v1"
            or not isinstance(actual_dist, str) or len(actual_dist) != 64 or actual_dist == expected_dist
            or error.get("message") != catalogued_error_message("KB_INSTALL_PROVENANCE_MISMATCH").format_map(template_values)
            or error.get("hint") != catalogued_error_hint("KB_INSTALL_PROVENANCE_MISMATCH", **template_values)):
        raise RuntimeError("provenance refusal omitted its catalogued field, values, package path, or digest version")
    current = install_root / layout_value("currentLink")
    versions = install_root / layout_value("versionRoots.path")
    if current.exists() or current.is_symlink():
        raise RuntimeError("provenance mismatch changed current before install activation")
    if versions.exists() and any(versions.iterdir()):
        raise RuntimeError("provenance mismatch created a version root before install activation")


def assert_immutable_publish_conflict(result: CompletedProcess[str], *, package: str,
                                      version: str, changed_tarball: Path) -> None:
    output = f"{result.stdout}\n{result.stderr}"
    expected_message = catalogued_error_message("KB_RELEASE_VERSION_CONFLICT").format(
        package=package, version=version)
    expected_hint = catalogued_error_hint("KB_RELEASE_VERSION_CONFLICT", package=package, version=version)
    if result.returncode == 0 or "KB_RELEASE_VERSION_CONFLICT" not in output:
        raise RuntimeError("publisher accepted a package version that already exists in the immutable registry")
    if expected_message not in output or expected_hint not in output:
        raise RuntimeError("publisher conflict omitted its catalogued message or hint")
    registry_line = next((line for line in output.splitlines() if line.startswith("Registry digest:")), "")
    local_integrity = f"sha512-{base64.b64encode(hashlib.sha512(changed_tarball.read_bytes()).digest()).decode()}"
    registry_digest, separator, local_digest = registry_line.removeprefix("Registry digest: ").partition("; local digest: ")
    local_digest = local_digest.removesuffix(".")
    if (not separator or not registry_digest or not local_digest or registry_digest == local_digest
            or local_integrity != local_digest):
        raise RuntimeError("publisher conflict omitted the registry and changed tarball digests")


def run_candidate_provenance_mismatch_step(*, launcher: str, candidate_index: Path,
                                           installed_root: Path, registry: str,
                                           run_command: CommandRunner) -> None:
    sealer = shutil.which("kb-create-release-index")
    if not sealer:
        raise RuntimeError("journey runner is missing kb-create-release-index; run `KB_JOURNEY_CASES=PC-001.19 e2e/journey/run.sh` to rebuild and rerun the case")
    receipt = json.loads((installed_root / ".kb/v2/receipt.json").read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory(prefix="pc001-provenance-mismatch-") as temporary:
        directory = Path(temporary)
        with _candidate_origin(directory) as origin_base:
            mutated_index, package, version, expected_dist, changed_tarball = _build_candidate_provenance_mutation(
                index_path=candidate_index, directory=directory, sealer=sealer,
                install_receipt=receipt, origin_base=origin_base)
            disposable_root = directory / "install-root"
            disposable_root.mkdir()
            result = run_command([launcher, "install", "--json", "--index", str(mutated_index),
                                  "--platform-root", str(disposable_root), "--registry", registry,
                                  "--service-profile", "default", "--scenario", "commit"])
            assert_provenance_mismatch_refusal(result, install_root=disposable_root,
                                               package=package, expected_dist=expected_dist)
            publisher_dir = directory / "publisher-conflict"
            publisher_dir.mkdir()
            publisher_tarball = publisher_dir / changed_tarball.name
            shutil.copyfile(changed_tarball, publisher_tarball)
            publisher_environment = dict(os.environ)
            publisher_environment.update({
                "PUBLISH_PACKAGES_DIR": str(publisher_dir),
                "PUBLISH_PARALLELISM": "1",
                "VERDACCIO_URL": registry,
                "KB_ERROR_CATALOG_PATH": str(workspace_resource(
                    "core", "platform", "src", "error-envelope", "errors.catalog.json")),
            })
            conflict = evidence_run_command(["sh", str(workspace_resource(
                "e2e", "publisher", "publish.sh"))], env=publisher_environment, timeout=180)
            assert_immutable_publish_conflict(conflict, package=package, version=version,
                                              changed_tarball=publisher_tarball)


def _hint_has_argv(text: str, expected: list[str]) -> bool:
    for command in re.findall(r"`([^`]*)`", text):
        try:
            if shlex.split(command)[:len(expected)] == expected:
                return True
        except ValueError:
            continue
    return False


def shim_owner_matches(data: dict, install_root: Path, expected_owner: Path) -> bool:
    owner = data.get("shim", {}).get("owner")
    if not owner:
        return False
    canonical_owner = Path(owner).resolve()
    expected_owner = Path(expected_owner).resolve()
    owns_shim = canonical_owner == Path(install_root).resolve()
    return canonical_owner == expected_owner and data.get("shim") == {
        "linked": owns_shim, "owner": str(canonical_owner)}


def gateway_registry_path(launcher: str) -> Path:
    home = Path(launcher).absolute().parents[2]
    return Path(os.environ.get("XDG_DATA_HOME") or home / ".local" / "share") / "kb-create" / "gateway-roots.json"


def gateway_registry_rows_for_installation(registry_path: Path, installation_id: str) -> list[dict]:
    registry = json.loads(Path(registry_path).read_text(encoding="utf-8"))
    if registry["schema"] != 2:
        raise RuntimeError(f"Gateway registry has unsupported schema {registry['schema']}")
    return [row for row in registry["roots"] if row["installationId"] == installation_id]


def verify_installation_spellings(*, launcher: str, index: Path, install_root: Path,
                                  channel: str, version: str, gateway_url: str,
                                  installation_id: str, receipt_id: str,
                                  operations: tuple[str, ...], shim_owner_root: Path,
                                  run_command: CommandRunner) -> None:
    """Prove the installed root's aliases resolve one receipt, Gateway row, and shim."""
    install_root = Path(install_root)
    spellings = (install_root, install_root / layout_value('currentLink'), active_platform_root(install_root))
    registry_path = gateway_registry_path(launcher)
    shim_path = Path(launcher).absolute().parent / "kb"
    before_shim = shim_path.readlink() if shim_path.is_symlink() else None
    registry_before = registry_path.read_bytes()
    expected_shim = Path(shim_owner_root).resolve() / layout_relative('currentLink', '.kb/v2/bin/kb')
    if before_shim is None or (shim_path.parent / before_shim).resolve() != expected_shim.resolve():
        raise RuntimeError(f"kb shim does not point to the scenario owner {shim_owner_root}: {before_shim}")
    matching = gateway_registry_rows_for_installation(registry_path, installation_id)
    if (len(matching) != 1 or matching[0].get("installationId") != installation_id
            or matching[0].get("url") != gateway_url):
        raise RuntimeError(f"Gateway registry does not have one row for {install_root}: {matching}")

    for spelling in spellings:
        for operation in operations:
            arguments = [launcher, operation, "--json"]
            if operation in ("plan", "update"):
                arguments.extend(["--index", str(index), "--platform-channel", channel,
                                  "--policy", "compatible"])
            arguments.extend(["--platform-root", str(spelling)])
            result = _data(run_command(arguments), f"{channel} {operation} through {spelling}")

            if operation == "plan":
                plan = result.get("plan", {})
                request = plan.get("request", {})
                if (request.get("gatewayUrl") != gateway_url
                        or plan.get("serviceGraph", {}).get("platformVersion") != version):
                    raise RuntimeError(f"plan through {spelling} changed installation identity or Gateway allocation: {plan}")
            elif operation == "status":
                installation = result.get("installation", {})
                if (installation.get("receiptId") != receipt_id
                        or installation.get("platformChannel") != channel
                        or installation.get("platformVersion") != version):
                    raise RuntimeError(f"status through {spelling} did not resolve the same installation: {result}")
            elif operation == "update":
                if result.get("operation") != "update" or result.get("alreadyUpToDate") is not True:
                    raise RuntimeError(f"update through {spelling} did not preserve the installed selection: {result}")
            else:
                raise ValueError(f"unsupported installation spelling operation: {operation}")

            if operation in ("plan", "update"):
                status_args = [launcher, "status", "--json", "--platform-root", str(spelling)]
                status = _data(run_command(status_args), f"{channel} status after {operation} through {spelling}")
                expected_owner = str(Path(shim_owner_root).resolve())
                expected_linked = expected_owner == str(install_root.resolve())
                if status.get("shim") != {"linked": expected_linked, "owner": expected_owner}:
                    raise RuntimeError(
                        f"status after {operation} through {spelling} did not report the scenario's kb owner: "
                        f"{status.get('shim')!r}")

        if registry_path.read_bytes() != registry_before:
            raise RuntimeError(f"{channel} {spelling} changed or duplicated the Gateway registry row")
        after_shim = shim_path.readlink() if shim_path.is_symlink() else None
        if after_shim != before_shim:
            raise RuntimeError(f"{channel} {spelling} changed the kb shim target: {before_shim} -> {after_shim}")


def verify_primary_installation_spellings(*, launcher: str, index: Path, install_root: Path,
                                          run_command: CommandRunner) -> None:
    receipt = json.loads((active_platform_root(install_root) / ".kb/v2/receipt.json").read_text())
    plan = receipt["plan"]
    health_url = urlsplit(receipt["verification"]["hostHealthUrl"])
    verify_installation_spellings(
        launcher=launcher, index=index, install_root=install_root,
        channel=plan["platformChannel"], version=plan["serviceGraph"]["platformVersion"],
        gateway_url=f"{health_url.scheme}://{health_url.netloc}",
        installation_id=receipt["installationId"], receipt_id=receipt["id"],
        operations=("plan", "update"), shim_owner_root=install_root,
        run_command=run_command)


def verify_stable_installation_spellings(*, launcher: str, index: Path, install_root: Path,
                                         shim_owner_root: Path,
                                         run_command: CommandRunner) -> None:
    receipt = json.loads((active_platform_root(install_root) / ".kb/v2/receipt.json").read_text())
    plan = receipt["plan"]
    verify_installation_spellings(
        launcher=launcher, index=index, install_root=install_root,
        channel="stable", version=plan["serviceGraph"]["platformVersion"],
        gateway_url=plan["request"]["gatewayUrl"],
        installation_id=receipt["installationId"], receipt_id=receipt["id"],
        operations=("status", "plan", "update"), shim_owner_root=shim_owner_root,
        run_command=run_command)


def assert_foreign_shim_diagnosis(data: dict, human_output: str, link: Path,
                                  target: Path, install_root: Path) -> None:
    finding = next((item for item in data.get("findings", [])
                    if item.get("code") == "KB_INSTALL_SHIM_DANGLING"), None)
    if not finding or finding.get("path") != str(link):
        raise RuntimeError(f"doctor omitted the foreign shim finding or link path: {data}")
    hint = finding.get("hint", "")
    repair = f"'kb-create' 'doctor' '--fix' '--platform-root' '{install_root}'"
    required = (str(link), str(target), "cannot be mapped to a validated installation",
                "considers it foreign and will not change it", "'rm' '--'", repair)
    for output in (hint, human_output):
        positions = [output.find(fragment) for fragment in required]
        if any(position < 0 for position in positions) or positions != sorted(positions):
            raise RuntimeError(f"doctor did not explain the foreign shim and ordered cleanup/repair: {output}")


def assert_other_shim_diagnosis(data: dict, human_output: str, link: Path,
                                owner_root: Path, install_root: Path) -> None:
    installation = data.get("installation", {})
    checks = installation.get("checks", [])
    check = next((item for item in checks if item.get("id") == "kb-command-shim"), None)
    if check is None:
        raise RuntimeError(f"doctor omitted the other-installation shim check: {data}")
    remove = "'rm' '--' '" + str(link) + "'"
    repair = f"'kb-create' 'doctor' '--fix' '--platform-root' '{install_root}'"
    expected = (str(link), "validated installation", str(owner_root.resolve()),
                "leaves it with that installation", remove, repair)
    for output in (check.get("hint", ""), human_output):
        positions = [output.find(fragment) for fragment in expected]
        if any(position < 0 for position in positions) or positions != sorted(positions):
            raise RuntimeError(f"doctor did not explain the other shim owner and deliberate switch: {output}")


def assert_gateway_index_diagnosis(data: dict, path: Path, root: Path) -> None:
    error = data.get("error", {})
    hint = error.get("hint", "")
    remove = f"'rm' '--' '{path}'"
    repair = f"'kb-create' 'doctor' '--fix' '--platform-root' '{root}'"
    expected = ("KB_INSTALL_GATEWAY_INDEX_UNAVAILABLE", str(path), "unsupported schema 1", remove, repair)
    text = " ".join((error.get("code", ""), error.get("message", ""), hint))
    positions = [text.find(part) for part in expected]
    if any(position < 0 for position in positions) or positions != sorted(positions):
        raise RuntimeError(f"Gateway index diagnostic lacks path, reason, or ordered recovery commands: {data}")


def read_gateway_index_refusal(result: CompletedProcess, label: str,
                               path: Path, root: Path) -> dict:
    envelope = read_kb_create_cli_result(result.args[1], result)
    error = decode_ux_error_result(envelope)
    exit_code = result.returncode
    if exit_code != 1:
        raise RuntimeError(f"{label}: expected operation-failure exit 1, got {exit_code}")
    assert_gateway_index_diagnosis({"error": error}, path, root)
    return error


def diagnostic_hint_has_next_command(error: dict) -> bool:
    details = error.get("details")
    next_command = details.get("nextCommand") if isinstance(details, dict) else None
    hint = error.get("hint")
    return isinstance(next_command, str) and bool(next_command) and isinstance(hint, str) and next_command in hint


class InstallerHostLifecycle:
    """Single owner for inspecting, changing, and restoring fixture host state."""

    def __init__(self, launcher: str, run_command: CommandRunner):
        self.launcher = launcher
        self.run_command = run_command

    def state(self, root: Path) -> tuple[bool, dict]:
        status = _json_command(self.run_command,
                               [self.launcher, "status", "--platform-root", str(root), "--json"],
                               f"host lifecycle status for {root}")
        host = status.get("host", {})
        return isinstance(host, dict) and host.get(layout_value('sharedStateDirectory')) == "running", status

    def set_running(self, root: Path, running: bool) -> None:
        operation = "start" if running else "stop"
        _json_command(self.run_command,
                      [self.launcher, operation, "--platform-root", str(root), "--json"],
                      f"{operation} host for {root}")

    @contextmanager
    def preserve(self, roots: list[Path]):
        initial = {root: self.state(root)[0] for root in roots}
        action_error: Exception | None = None
        try:
            yield initial
        except Exception as error:
            action_error = error
        finally:
            failures = []
            for root, was_running in reversed(list(initial.items())):
                try:
                    running, _ = self.state(root)
                    if running != was_running:
                        self.set_running(root, was_running)
                except Exception as error:
                    failures.append(f"{root}: {error}")
            if failures:
                message = "could not restore installer host state: " + "; ".join(failures)
                if action_error is not None:
                    raise RuntimeError(f"{action_error}; {message}") from action_error
                raise RuntimeError(message)
        if action_error is not None:
            raise action_error


def _data(result: CompletedProcess, label: str) -> dict:
    _, payload = _payload(result, label)
    if result.returncode == 0 and isinstance(payload, dict):
        return payload
    raise RuntimeError(f"{label}: exit {result.returncode}; {' '.join(result.stdout.split())[-500:]}")


def _assert_repeat_install_applied(result: CompletedProcess, *, launcher: str, root: Path,
                                   run_command: CommandRunner, expected_identity: dict, label: str) -> None:
    data = _data(result, label)
    if data.get("operation") != "apply":
        raise RuntimeError(f"{label}: expected an ordinary apply result")
    receipt = data.get("receipt", {})
    fields = ("projectSelectedPath", "projectId", "projectCanonicalPath")
    if any(receipt.get(field) != expected_identity.get(field) for field in fields):
        raise RuntimeError(f"{label}: repeat install changed the recorded project identity")
    if "first administrator credentials" in result.stdout.lower() or "password:" in result.stdout.lower():
        raise RuntimeError(f"{label}: repeat install disclosed or prompted for credentials")
    status = _json_command(run_command, [launcher, "status", "--platform-root", str(root), "--json"],
                           f"host status after {label}")
    host = status.get("host", {})
    if (not isinstance(host, dict) or host.get(layout_value('sharedStateDirectory')) != "running"
            or status.get("running") is not True or status.get("reachable") is not True):
        raise RuntimeError(f"{label}: host is not running and reachable after apply")


def _payload(result: CompletedProcess, label: str) -> tuple[dict, dict]:
    command = result.args[1]
    if result.returncode != 0:
        try:
            envelope = read_kb_create_cli_result(command, result)
            error = decode_ux_error_result(envelope)
        except ValueError as failure:
            raise RuntimeError(f"{label}: expected a structured CLI failure: {failure}") from failure
        return {"ok": False, "error": error}, error

    try:
        envelope = read_kb_create_cli_result(command, result)
        data = decode_ux_success_result(envelope)
    except ValueError as error:
        raise RuntimeError(f"{label}: expected the registered kb-create JSON result form: {error}") from error
    return envelope, data if isinstance(data, dict) else {}


def _fixture_contains_secret_material(root: Path) -> bool:
    markers = ("fixture-secret-value", "fixture.required=value")
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        with path.open("r", encoding="utf-8", errors="replace") as source:
            if any(marker in line for line in source for marker in markers):
                return True
    return False


def _diagnostic(result: CompletedProcess, label: str) -> tuple[dict, dict]:
    envelope, error = _payload(result, label)
    if result.returncode == 0 or not isinstance(error, dict):
        raise RuntimeError(f"{label}: expected a structured error")
    return envelope, error


def add_installed_host_stop_case_step(journey: Journey, platform_root: Path,
                                     env: dict[str, str], *,
                                     runner: CommandRunner = evidence_run_command) -> None:
    """Claim the installed host stop lifecycle after the PC-002 start journey."""
    root = Path(platform_root).resolve()

    def stop_and_confirm() -> None:
        stop_command = ["kb-create", "stop", "--platform-root", str(root), "--json"]
        stopped = runner(stop_command, cwd=str(root), env=env, capture_output=True,
                         text=True, check=False, timeout=120)
        stop_data = _data(stopped, "kb-create stop")
        if stop_data.get("operation") != "stop":
            raise RuntimeError("kb-create stop JSON did not report operation stop")

        status_command = ["kb-create", "status", "--platform-root", str(root), "--json"]
        status = _data(runner(status_command, cwd=str(root), env=env, capture_output=True,
                              text=True, check=False, timeout=120), "status after kb-create stop")
        host = status.get("host")
        if (status.get("running") is not False or not isinstance(host, dict)
                or host.get(layout_value("sharedStateDirectory")) != "stopped"):
            raise RuntimeError("kb-create status did not report host.state stopped and running false after stop")

    journey.step("stop the installed host after start and service checks", "platform.host",
                 stop_and_confirm, cases=["PC-002.4"],
                 plan_after_phase="all-steps")


def _commands_in_hint(hint: str) -> list[list[str]]:
    """Read the shell commands the diagnostic offers as executable argv."""
    commands = [shlex.split(command) for command in re.findall(r"`([^`]+)`", hint)]
    retry = hint.partition("then retry:")[2].strip()
    if retry:
        commands.append(shlex.split(retry))
    return commands


def run_port_conflict_step(*, mode: str, launcher: str, stable_index: Path,
                           platform_root: Path, run_command: CommandRunner) -> Journey:
    """Prove apply reports a foreign owner for the Gateway port it resolved."""
    journey = Journey(mode, f"port-conflict-{mode}")
    conflict_root = platform_root.parent / "pc001-port-conflict-root"
    conflict_gateway_url = unused_loopback_gateway_url()

    def port_conflict_ux() -> None:
        plan = _json_command(run_command, [launcher, "plan", "--json", "--index", str(stable_index),
                                           "--platform-root", str(conflict_root),
                                           "--gateway-url", conflict_gateway_url,
                                           "--service-profile", "default", "--scenario", "commit"],
                             "PC-001 port-conflict plan").get("plan", {})
        health_url = plan.get("host", {}).get("healthUrl")
        port = urlsplit(health_url).port if isinstance(health_url, str) else None
        if port is None:
            raise RuntimeError("PC-001 port-conflict plan omitted its Gateway port")
        with socket.socket() as owner:
            owner.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            owner.bind(("127.0.0.1", port))
            owner.listen(1)
            result = run_command([launcher, "apply", "--json", "--index", str(stable_index),
                                  "--platform-root", str(conflict_root),
                                  "--gateway-url", conflict_gateway_url,
                                  "--service-profile", "default", "--scenario", "commit"])
        envelope, error = _diagnostic(result, "PC-001 port conflict")
        details = error.get("details", error.get("meta", {}))
        if (result.returncode == 0 or envelope.get("ok") is not False
                or error.get("code") != "KB_INSTALL_PORT_IN_USE"
                or not isinstance(details, dict)
                or details.get("port") != str(port) or not details.get("pid") or not details.get("command")
                or str(details["pid"]) not in error.get("hint", "")
                or str(details["command"]) not in error.get("hint", "")):
            raise RuntimeError(f"port conflict omitted its catalogued code, owner, or apply hint: {error}")
        retry = next((argv for argv in _commands_in_hint(error.get("hint", ""))
                      if argv[:2] == ["kb-create", "apply"] and "--gateway-url" in argv), None)
        if (retry is None or "--platform-root" not in retry
                or retry[retry.index("--platform-root") + 1] != str(conflict_root)
                or retry[retry.index("--gateway-url") + 1] == conflict_gateway_url):
            raise RuntimeError(f"port conflict did not offer a shell-safe apply retry for this root and another Gateway URL: {error}")

    journey.step("report the owning process when apply cannot claim a required port", "platform.install",
                 port_conflict_ux, cases=["PC-001.9"])
    return journey


def verify_package_manager_failure_diagnostic(*, launcher: str, stable_index: Path,
                                              platform_root: Path, registry: str,
                                              run_command: CommandRunner) -> None:
    """Prove an installed apply exposes the failing package manager's exit and stderr."""
    failure_root = platform_root.parent / "pc001-pnpm-failure-root"
    request_path = platform_root.parent / "pc001-pnpm-failure-request.json"
    fake_bin = platform_root.parent / "pc001-pnpm-failure-bin"
    stderr = "x149-pnpm-fixture: registry unavailable"

    def assert_failure_diagnostic() -> None:
        plan = _json_command(
            run_command,
            [launcher, "plan", "--json", "--index", str(stable_index), "--platform-root", str(failure_root),
             "--service-profile", "default", "--scenario", "commit", "--registry", registry],
            "PC-001 package-manager failure plan",
        ).get("plan", {})
        request = plan.get("request")
        if not isinstance(request, dict) or request.get("platformRoot") != str(failure_root):
            raise RuntimeError("package-manager failure plan omitted its isolated install request")
        request_path.write_text(json.dumps(request) + "\n", encoding="utf-8")
        fake_bin.mkdir(mode=0o700, exist_ok=True)
        fake_corepack = fake_bin / "corepack"
        fake_corepack.write_text(f"#!/bin/sh\nprintf '%s\\n' '{stderr}' >&2\nexit 47\n", encoding="utf-8")
        fake_corepack.chmod(0o700)
        failure_env = dict(os.environ)
        failure_env["PATH"] = str(fake_bin) + os.pathsep + failure_env.get("PATH", "")
        result = run_command(
            [launcher, "apply", "--json", "--index", str(stable_index), "--input", str(request_path),
             "--platform-root", str(failure_root), "--registry", registry],
            env=failure_env,
        )
        _, error = _diagnostic(result, "PC-001 package-manager failure")
        details = error.get("details", error.get("meta", {}))
        if (error.get("code") != "KB_INSTALL_APPLY_FAILED" or not isinstance(details, dict)
                or details.get("packageManagerExitCode") != "47"
                or details.get("packageManagerStderrTail") != stderr):
            raise RuntimeError(f"package-manager failure omitted its exit code or stderr tail: {error}")
        log_path = details.get("logPath")
        diagnostic_path = details.get("diagnosticPath")
        if (not isinstance(log_path, str) or not Path(log_path).is_file()
                or stderr not in Path(log_path).read_text(encoding="utf-8")
                or not isinstance(diagnostic_path, str) or not Path(diagnostic_path).is_file()):
            raise RuntimeError("package-manager failure omitted its complete installer log or diagnostic dossier")

    assert_failure_diagnostic()


def run_platform_cli(platform_root: Path, args: list[str], run_command: CommandRunner,
                     *, input_text: str | None = None) -> CompletedProcess:
    """Run the CLI installed for the requested root, independent of PATH shim ownership."""
    executable = active_platform_root(platform_root) / ".kb/v2/bin/kb"
    if not executable.is_file():
        raise RuntimeError(f"platform CLI is missing for {platform_root}: {executable}")
    options = {"input": input_text} if input_text is not None else {}
    return run_command(kb_command(args, executable=executable), **options)


def installer_primary_host_guard(root: Path, launcher: str,
                                 run_command: CommandRunner) -> Callable[[str, Callable[[], str | None]], str | None]:
    """Keep the primary host's run-state stable across each installer-case step."""
    lifecycle = InstallerHostLifecycle(launcher, run_command)

    def listener_context(payload: dict) -> str:
        host = payload.get("host", {})
        pid = host.get("pid", "unknown") if isinstance(host, dict) else "unknown"
        ports = []
        try:
            receipt = json.loads((active_platform_root(root) / ".kb/v2/receipt.json").read_text())
            plan = receipt.get("plan", {})
            host_url = plan.get("host", {}).get("healthUrl")
            if host_url and urlsplit(host_url).port:
                ports.append(str(urlsplit(host_url).port))
            ports.extend(str(port) for port in service_ports(plan).values())
        except (OSError, json.JSONDecodeError, AttributeError, TypeError) as error:
            return f"root {root}, pid {pid}, port(s) unavailable: {error}"
        listeners = listener_state(ports)
        rendered_listeners = ", ".join(f"{port}/{owner_pid} ({command})"
                                        for port, owner_pid, command in listeners) or "none"
        return (f"root {root}, pid {pid}, port(s) {', '.join(sorted(set(ports))) or 'unknown'}, "
                f"listeners {rendered_listeners}")

    def listener_state(ports: list[str]) -> tuple[tuple[str, str, str], ...]:
        owners = []
        for port in sorted(set(ports)):
            result = run_command(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-Fp", "-Fc"])
            if result.returncode == 1:
                continue
            if result.returncode != 0:
                raise RuntimeError(f"could not inspect listener ownership for port {port}: {result.stderr.strip()}")
            pid = None
            command = None
            for line in result.stdout.splitlines():
                if line.startswith("p"):
                    pid = line[1:]
                elif line.startswith("c") and pid:
                    command = line[1:]
                    owners.append((port, pid, command))
                    pid = None
                    command = None
            if pid is not None:
                owners.append((port, pid, command or "unknown"))
            if not result.stdout.strip():
                continue
        return tuple(sorted(owners))

    def signature(payload: dict) -> tuple[bool, str, str, tuple[tuple[str, str, str], ...]]:
        host = payload.get("host", {})
        running = isinstance(host, dict) and host.get(layout_value('sharedStateDirectory')) == "running"
        pid = str(host.get("pid", "unknown")) if isinstance(host, dict) else "unknown"
        try:
            receipt = json.loads((active_platform_root(root) / ".kb/v2/receipt.json").read_text())
            plan = receipt.get("plan", {})
            ports = []
            host_url = plan.get("host", {}).get("healthUrl")
            if host_url and urlsplit(host_url).port:
                ports.append(str(urlsplit(host_url).port))
            ports.extend(str(port) for port in service_ports(plan).values())
            listeners = listener_state(ports)
        except (OSError, json.JSONDecodeError, AttributeError, TypeError) as error:
            return running, pid if running else "stopped", f"listener state unavailable: {error}", ()
        return running, pid if running else "stopped", ",".join(sorted(set(ports))), listeners

    def guard(name: str, check: Callable[[], str | None]) -> str | None:
        before_running, before = lifecycle.state(root)
        before_signature = signature(before)
        action_error: Exception | None = None
        message: str | None = None
        try:
            message = check()
        except Exception as error:
            action_error = error
        _, after = lifecycle.state(root)
        after_signature = signature(after)
        after_running = isinstance(after.get("host"), dict) and after["host"].get(layout_value('sharedStateDirectory')) == "running"
        violation = None
        if after_signature != before_signature:
            violation = (f"installer step {name!r} changed primary host run-state "
                         f"from {listener_context(before)} to {listener_context(after)}")
            try:
                if after_running != before_running:
                    lifecycle.set_running(root, before_running)
            except Exception as restore_error:
                violation += f"; restoration failed: {restore_error}"
        if action_error is not None:
            if violation:
                raise RuntimeError(f"{action_error}; {violation}") from action_error
            raise action_error
        if violation:
            raise RuntimeError(violation)
        return message

    return guard


def run_fixture_group(journey: Journey, label: str, run_fixture: Callable[[], Journey]) -> None:
    """Run a nested fixture journey inside the owning journey's host guard and keep its rows.

    The fixture always runs and always reports its claims: a guard that cannot
    observe the host is one failed row, not a reason to drop the group.
    """
    collected: list[Journey] = []
    failures: list[str] = []
    started = False

    def run() -> None:
        nonlocal started
        started = True
        collected.append(run_fixture())

    for attempt in (lambda: journey.step_guard(label, run), run):
        if started:
            break
        try:
            attempt()
        except Exception as error:
            failures.append(str(error) or error.__class__.__name__)
    for failure in failures:
        journey.step(f"installer fixture group: {label}", "journey.orchestration",
                     lambda failure=failure: failure, role="lifecycle")
    for fixture in collected:
        journey.steps.extend(fixture.steps)


def run_uninstall_decline_step(*, mode: str, args: list[str], receipt_path: Path,
                               run_pty: Callable[..., tuple[CompletedProcess, float]]) -> Journey:
    """Confirm terminal uninstall cancellation preserves the active receipt."""
    journey = Journey(mode, f"uninstall-decline-{mode}")

    def decline() -> None:
        before = receipt_path.read_bytes()
        prompt_seen = False

        def answer_no(transcript: str):
            nonlocal prompt_seen
            if not prompt_seen and "Continue? [y/N]" in transcript:
                prompt_seen = True
                return "n\n"
            return None

        result, _ = run_pty(args, on_output=answer_no)
        if (not prompt_seen or result.returncode != 1
                or "KB_INSTALL_OPERATION_CANCELLED" not in result.stdout
                or receipt_path.read_bytes() != before):
            raise RuntimeError("terminal decline did not preserve the receipt with KB_INSTALL_OPERATION_CANCELLED")

    journey.step("decline the terminal uninstall confirmation", "platform.uninstall", decline,
                 cases=["S-050.3"])
    return journey


def run_missing_project_request_steps(*, mode: str, launcher: str, stable_index: Path,
                                      home: Path, run_command: CommandRunner) -> Journey:
    """Reject a missing project in every request command before platform mutation."""
    journey = Journey(mode, f"missing-project-install-{mode}")

    def reject_missing_project(operations: tuple[str, ...]) -> None:
        def path_state(path: Path) -> tuple[str, bytes | str | None] | None:
            if path.is_symlink():
                return "symlink", str(path.readlink())
            if path.is_file():
                return "file", path.read_bytes()
            if path.is_dir():
                return "directory", None
            if path.exists():
                return "other", str(path.stat().st_mode)
            return None

        shim_path = Path(launcher).resolve().parent / "kb"
        registry_path = home / ".kb" / "projects.json"
        shim_before = path_state(shim_path)
        registry_before = path_state(registry_path)
        with tempfile.TemporaryDirectory(prefix="journey-missing-project-install-") as temp:
            root = Path(temp)
            project = root / "missing-project"
            for operation in operations:
                target = root / operation
                result = run_command([launcher, operation, "--json", "--index", str(stable_index),
                                      "--platform-root", str(target), "--project-root", str(project)])
                _, error = _diagnostic(result, f"{operation} with a missing project directory")
                hint = error.get("hint", "")
                receipt_path = target / ".kb" / "v2" / "receipt.json"
                scenario_path = target / ".kb" / "v2" / "scenarios" / "custom.json"
                shim_changed = path_state(shim_path) != shim_before
                registry_changed = path_state(registry_path) != registry_before
                if (result.returncode == 0 or error.get("code") != "KB_INSTALL_INPUT_REQUIRED"
                        or "must exist" not in error.get("message", "")
                        or "'mkdir' '-p'" not in hint
                        or "existing project directory" not in hint
                        or target.exists() or receipt_path.exists() or shim_changed or registry_changed
                        or scenario_path.exists() or Path(str(scenario_path) + ".tmp").exists()):
                    raise RuntimeError(f"missing project {operation} was not rejected before mutation: "
                                       f"exit={result.returncode}, code={error.get('code')}, "
                                       f"platform root exists={target.exists()}, receipt exists={receipt_path.exists()}, "
                                       f"shim changed={shim_changed}, project registry changed={registry_changed}, "
                                       f"scenario state exists={scenario_path.exists()}")

    journey.step("reject installation when the selected project directory is missing",
                 "platform.install", lambda: reject_missing_project(("install",)), cases=["S-187.7"])
    journey.step("reject plan and apply when the selected project directory is missing",
                 "platform.install", lambda: reject_missing_project(("plan", "apply")), cases=["S-187.8"])
    return journey


def _without_jsonc_comments(source: str) -> str:
    """Remove JSONC comments without changing comment markers inside strings."""
    output: list[str] = []
    quoted = escaped = False
    index = 0
    while index < len(source):
        char = source[index]
        following = source[index + 1] if index + 1 < len(source) else ""
        if quoted:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
            index += 1
        elif char == '"':
            quoted = True
            output.append(char)
            index += 1
        elif char == "/" and following == "/":
            index += 2
            while index < len(source) and source[index] not in "\r\n":
                index += 1
        elif char == "/" and following == "*":
            index += 2
            while index + 1 < len(source) and source[index:index + 2] != "*/":
                index += 1
            index = min(len(source), index + 2)
        elif char == ",":
            lookahead = index + 1
            while lookahead < len(source) and source[lookahead].isspace():
                lookahead += 1
            if lookahead < len(source) and source[lookahead] in "]}":
                index += 1
            else:
                output.append(char)
                index += 1
        else:
            output.append(char)
            index += 1
    return "".join(output)


def run_analytics_invalid_retention_step(*, mode: str, launcher: str, platform_root: Path,
                                         run_command: CommandRunner) -> Journey:
    """Prove invalid SQLite retention config fails a real installed host start."""
    journey = Journey(mode, f"analytics-invalid-retention-{mode}")

    def invalid_retention() -> None:
        config_path = active_platform_root(platform_root) / layout_value('sharedRuntimePaths.kb_kb_config_jsonc.platformPath')
        original_config = config_path.read_bytes()
        lifecycle = InstallerHostLifecycle(launcher, run_command)
        with lifecycle.preserve([platform_root]) as initial:
            action_error: Exception | None = None
            try:
                config = json.loads(_without_jsonc_comments(original_config.decode()))
                platform_config = config.setdefault("platform", {})
                options = platform_config.setdefault("adapterOptions", {})
                options.setdefault("analytics", {})["retentionDays"] = 0
                config_path.write_text(json.dumps(config, indent=2) + "\n")
                if initial[platform_root]:
                    lifecycle.set_running(platform_root, False)
                result = run_command([launcher, "start", "--platform-root", str(platform_root), "--json"])
                envelope, error = _diagnostic(result, "invalid analytics retention")
                detail = json.dumps(error, sort_keys=True)
                expected_hint = (
                    "kb config set --scope platform "
                    "platform.adapterOptions.analytics.retentionDays 90"
                )
                if (result.returncode != 1 or envelope.get("ok") is not False
                        or error.get("code") != "KB_CONFIG_INVALID"
                        or "platform.adapterOptions.analytics.retentionDays" not in detail
                        or "positive integer" not in detail
                        or expected_hint not in str(error.get("hint", ""))
                        or error.get("code") == "KB_RUNTIME_UNEXPECTED"):
                    raise RuntimeError(f"invalid analytics retention did not return its catalogued config error: {error}")
            except Exception as error:
                action_error = error
            try:
                config_path.write_bytes(original_config)
            except Exception as restore_error:
                if action_error is not None:
                    raise RuntimeError(f"{action_error}; could not restore the platform config: {restore_error}") from action_error
                raise
            if action_error is not None:
                raise action_error

    journey.step("reject invalid SQLite retention during installed host startup", "platform.install",
                 invalid_retention, cases=["S-191.7"])
    return journey


def run_offline_plan_step(*, mode: str, launcher: str, stable_index: Path,
                          platform_root: Path, run_command: CommandRunner) -> Journey:
    """Populate a dedicated root's verified artifact cache, then resolve offline from it."""
    journey = Journey(mode, f"offline-plan-{mode}")

    def offline_plan() -> None:
        root = platform_root.parent / "s181-offline-root"
        lifecycle = InstallerHostLifecycle(launcher, run_command)
        with lifecycle.preserve([platform_root]) as initial:
            primary_was_running = initial[platform_root]
            if primary_was_running:
                lifecycle.set_running(platform_root, False)
            _data(run_command([launcher, "apply", "--json", "--index", str(stable_index),
                               "--platform-channel", "stable", "--platform-root", str(root)]),
                  "online cache priming apply")
            plan = _json_command(run_command, [launcher, "plan", "--json", "--index", str(stable_index),
                                               "--platform-channel", "stable", "--offline",
                                               "--platform-root", str(root)], "offline plan").get("plan", {})
            artifacts = plan.get("artifacts", [])
            if (plan.get("request", {}).get("source") != "offline" or not artifacts
                    or any(item.get("resolvedFrom") != "cache" or item.get("resolvedUrl") for item in artifacts)):
                raise RuntimeError("offline plan omitted cache provenance or claimed registry/network resolution")

    journey.step("resolve a fresh request from the local artifact cache", "platform.install", offline_plan,
                 cases=["S-181.4"])
    return journey


def run_secondary_root_gateway_isolation_step(*, mode: str, launcher: str, primary_root: Path,
                                             secondary_root: Path, admin_password: str,
                                             run_command: CommandRunner) -> Journey:
    """Check the secondary root while live, then verify its stopped-host error."""
    journey = Journey(mode, f"secondary-gateway-isolation-{mode}")
    try:
        primary_receipt = active_platform_root(primary_root) / ".kb/v2/receipt.json"
        secondary_receipt = active_platform_root(secondary_root) / ".kb/v2/receipt.json"
    except FileNotFoundError as error:
        journey.step("isolate the secondary Gateway from the primary root", "platform.install",
                     lambda: f"prerequisite installation is missing: {error}", cases=["PC-001.12"])
        return journey

    def gateway_isolation() -> None:
        primary_installation = json.loads(primary_receipt.read_text()).get("installationId")
        secondary_data = json.loads(secondary_receipt.read_text())
        secondary_installation = secondary_data.get("installationId")
        gateway_url = secondary_data.get("plan", {}).get("request", {}).get("gatewayUrl", "")
        primary_gateway = json.loads(primary_receipt.read_text()).get("verification", {}).get("hostHealthUrl", "")
        primary_port, secondary_port = urlsplit(primary_gateway).port, urlsplit(gateway_url).port
        if not primary_port or not secondary_port or secondary_port == primary_port:
            raise RuntimeError(f"secondary root receipt does not declare a distinct Gateway address: {gateway_url}")

        lifecycle = InstallerHostLifecycle(launcher, run_command)
        with lifecycle.preserve([primary_root, secondary_root]) as initial:
            for root in (primary_root, secondary_root):
                if not initial[root]:
                    lifecycle.set_running(root, True)

            admin_email = "journey-admin@example.test"
            login = run_platform_cli(secondary_root, [
                "auth", "login", "--gateway-url", gateway_url, "--email", admin_email, "--password-stdin",
            ], run_command, input_text=admin_password + "\n")
            if login.returncode != 0:
                raise RuntimeError("could not authenticate to the secured secondary Gateway with its fixture admin")

            live = run_platform_cli(secondary_root, ["adapter", "list", "--json"], run_command)
            _, live_data = _payload(live, "secondary root adapter list while running")
            if not isinstance(live_data.get("adapters"), list):
                raise RuntimeError("running secondary root adapter list omitted adapter state")

            lifecycle.set_running(secondary_root, False)
            stopped = run_platform_cli(secondary_root, ["adapter", "list", "--json"], run_command)
            _, error = _diagnostic(stopped, "secondary root adapter list while stopped")
            unreachable_hint = f'Run "kb-create start --platform-root {secondary_root}" and retry the command.'
            unreachable = error.get("code") == "KB_HOST_UNREACHABLE" and error.get("hint") == unreachable_hint
            primary_answers = (error.get("code") == "KB_HOST_IDENTITY_MISMATCH"
                               and error.get("details", {}).get("actualInstallationId") == primary_installation
                               and error.get("details", {}).get("expectedInstallationId") == secondary_installation)
            if stopped.returncode == 0 or not (unreachable or primary_answers):
                raise RuntimeError(f"stopped secondary root did not identify its own unavailable Gateway: {error}")

    journey.step("verify the secondary root's Gateway while running and stopped", "platform.install",
                 gateway_isolation, cases=["PC-001.12"])
    return journey


def run_stable_layout_contract_refusal_step(*, mode: str, platform_root: Path,
                                            run_command: CommandRunner) -> Journey:
    """Verify the installed CLI refuses a stable-root-only layout contract."""
    journey = Journey(mode, f"stable-layout-contract-refusal-{mode}")

    def refuse_stable_contract() -> None:
        active_root = active_platform_root(platform_root)
        contract_suffix = (".kb", "v2", "platform-layout.json")
        active_contract = active_root.joinpath(*contract_suffix)
        stable_contract = platform_root.joinpath(*contract_suffix)
        expected_path = installed_path(platform_root, "currentLink", *contract_suffix)
        if not active_contract.is_file():
            raise RuntimeError(f"active version layout contract is missing before fixture setup: {active_contract}")
        original_active = active_contract.read_bytes()
        original_active_mode = stat.S_IMODE(active_contract.stat().st_mode)
        original_stable = stable_contract.read_bytes() if stable_contract.exists() else None
        original_stable_mode = stat.S_IMODE(stable_contract.stat().st_mode) if original_stable is not None else None
        stable_parent_existed = stable_contract.parent.exists()
        stable_kb_parent_existed = stable_contract.parent.parent.exists()
        root_before = snapshot_tree(platform_root)
        contract_bytes = workspace_resource("tools", "kb-create", "v2", "contracts", "platform-layout.json").read_bytes()
        failure: BaseException | None = None
        try:
            stable_contract.parent.mkdir(parents=True, exist_ok=True)
            stable_contract.write_bytes(contract_bytes)
            active_contract.unlink()
            result = run_platform_cli(platform_root, ["adapter", "list", "--json"], run_command)
            _, error = _diagnostic(result, "stable-root-only platform layout contract")
            if (error.get("code") != "KB_CONFIG_INVALID"
                    or error.get("details", {}).get("contractPath") != str(expected_path)
                    or error.get("details", {}).get("remedyOperation") != "update"
                    or error.get("details", {}).get("remedyPlatformRoot") != str(platform_root)):
                raise RuntimeError(f"CLI did not diagnose the stable-root-only platform layout contract: {error}")
        except BaseException as error:
            failure = error

        restore_error: Exception | None = None
        try:
            active_contract.write_bytes(original_active)
            os.chmod(active_contract, original_active_mode)
            if original_stable is None:
                stable_contract.unlink(missing_ok=True)
            else:
                stable_contract.write_bytes(original_stable)
                if original_stable_mode is not None:
                    os.chmod(stable_contract, original_stable_mode)
            if not stable_parent_existed:
                stable_contract.parent.rmdir()
            if not stable_kb_parent_existed:
                stable_contract.parent.parent.rmdir()
            if snapshot_tree(platform_root) != root_before:
                raise RuntimeError("stable-layout contract fixture did not restore the install root byte-for-byte")
        except Exception as error:
            restore_error = error
        if failure is not None and restore_error is not None:
            raise RuntimeError(f"{failure}; fixture restoration failed: {restore_error}") from failure
        if failure is not None:
            raise failure
        if restore_error is not None:
            raise RuntimeError(f"fixture restoration failed: {restore_error}") from restore_error

    journey.step("refuse a stable-root-only layout contract", "cli", refuse_stable_contract,
                 cases=["S-054.23"])
    return journey


def run_gateway_allocation_step(*, mode: str, launcher: str, stable_index: Path,
                                primary_root: Path, automatic_root: Path,
                                explicit_root: Path, run_command: CommandRunner) -> Journey:
    """Verify the automatically assigned root address and explicit override."""
    journey = Journey(mode, f"gateway-allocation-{mode}")

    def assert_allocation_domain(plan: dict, gateway_port: int, label: str) -> None:
        if gateway_port < 4000 or gateway_port > 9900 or (gateway_port - 4000) % 100:
            raise RuntimeError(f"{label} Gateway allocation left the 4000–9900 product domain: {gateway_port}")
        services = plan.get("serviceGraph", {}).get("services", [])
        service_ports = [service["port"] for service in services
                         if isinstance(service.get("port"), int) and service.get("port", 0)]
        transport_ports = service_transport_ports(plan).values()
        unsafe_ports = [port for port in [*service_ports, *transport_ports] if port >= 32768]
        if unsafe_ports:
            raise RuntimeError(f"{label} produced service ports in the conventional ephemeral range: {unsafe_ports}")

    def verify_gateway_addresses() -> None:
        primary_receipt = json.loads((active_platform_root(primary_root) / ".kb/v2/receipt.json").read_text())
        automatic_receipt = json.loads((active_platform_root(automatic_root) / ".kb/v2/receipt.json").read_text())
        primary_url = primary_receipt.get("verification", {}).get("hostHealthUrl", "")
        automatic_url = automatic_receipt.get("verification", {}).get("hostHealthUrl", "")
        primary_port, automatic_port = urlsplit(primary_url).port, urlsplit(automatic_url).port
        if not primary_port or automatic_port != primary_port + 100:
            raise RuntimeError(f"no-flag apply did not allocate the next Gateway offset: {automatic_url}")
        automatic_plan = automatic_receipt.get("plan", {})
        automatic_services = automatic_plan.get("serviceGraph", {}).get("services", [])
        assert_allocation_domain(automatic_plan, automatic_port, "secondary receipt")
        primary_plan = primary_receipt.get("plan", {})
        primary_ports = service_ports(primary_plan)
        primary_transport_ports = service_transport_ports(primary_plan)
        assert_root_offset(automatic_plan, primary_ports, primary_transport_ports, 100,
                           "secondary receipt")
        InstallerHostLifecycle(launcher, run_command).set_running(automatic_root, False)

        explicit_installed = False
        try:
            project_root = explicit_root.parent / "pc001-explicit-gateway-project"
            project_root.mkdir(parents=True, exist_ok=True)
            result = run_command([launcher, "install", "--json", "--index", str(stable_index),
                                  "--platform-channel", "stable", "--platform-root", str(explicit_root),
                                  "--service-profile", "default", "--scenario", "custom",
                                  "--scenario-answers", json.dumps({"access.mode": "local"}),
                                  "--gateway-url", "http://127.0.0.1:4200",
                                  "--project-root", str(project_root)])
            explicit_installed = (active_platform_root(explicit_root) / ".kb/v2/receipt.json").is_file()
            data = _data(result, "explicit Gateway install")
            if not shim_owner_matches(data, install_root=explicit_root, expected_owner=primary_root):
                raise RuntimeError(f"explicit secondary install reported the wrong shim owner: {data.get('shim')}")
            explicit_receipt = data.get("receipt", {})
            explicit_url = explicit_receipt.get("verification", {}).get("hostHealthUrl", "")
            if explicit_url != "http://127.0.0.1:4200/health":
                raise RuntimeError(f"explicit Gateway override was not recorded in the receipt: {explicit_url}")

            next_plan = _data(run_command([launcher, "plan", "--json", "--index", str(stable_index),
                                           "--platform-channel", "stable", "--platform-root",
                                           str(explicit_root.parent / "root-d")]), "plan after stopped root allocation").get("plan", {})
            next_url = next_plan.get("request", {}).get("gatewayUrl", "")
            if urlsplit(next_url).port != automatic_port + 200:
                raise RuntimeError(f"stopped root did not retain its allocation: new root planned {next_url}")
            assert_allocation_domain(next_plan, urlsplit(next_url).port, "next planned root")
            assert_root_offset(next_plan, primary_ports, primary_transport_ports, 300,
                               "next planned root")

            planned = _data(run_command([launcher, "plan", "--json", "--index", str(stable_index),
                                         "--platform-channel", "stable", "--platform-root",
                                         str(automatic_root)]), "repeat automatic Gateway plan").get("plan", {})
            if (planned.get("request", {}).get("gatewayUrl") != automatic_url.removesuffix("/health")
                    or planned.get("host", {}).get("healthUrl") != automatic_url
                    or planned.get("serviceGraph", {}).get("services") != automatic_services):
                raise RuntimeError(f"replanning changed the stopped root's Gateway or service ports: {planned}")
            assert_allocation_domain(planned, automatic_port, "re-planned secondary root")
        finally:
            if explicit_installed:
                stop_installer_fixture_host(explicit_root, launcher, run_command)

    journey.step("allocate an unused Gateway address by default and honor an explicit override",
                 "platform.install", verify_gateway_addresses, cases=["PC-001.10", "PC-001.16"])

    return journey


def run_json_install_project_step(*, mode: str, launcher: str, stable_index: Path,
                                  platform_root: Path, project_root: Path,
                                  run_command: CommandRunner) -> Journey:
    """Install a custom scenario in JSON mode and verify its project registry entry."""
    journey = Journey(mode, f"json-install-project-{mode}")
    installed = False

    def install_and_show() -> None:
        nonlocal installed
        platform_root.parent.mkdir(parents=True, exist_ok=True)
        platform_root.mkdir(parents=True, exist_ok=True)
        project_root.mkdir(parents=True, exist_ok=True)
        try:
            result = run_command([launcher, "install", "--json", "--index", str(stable_index),
                                  "--platform-root", str(platform_root), "--service-profile", "default",
                                  "--scenario", "custom", "--scenario-answers", '{"access.mode":"local"}',
                                  "--gateway-url", unused_loopback_gateway_url(),
                                  "--project-root", str(project_root)])
            install_data = _data(result, "JSON custom-scenario install with project")
            receipt = install_data.get("receipt", {})
            selected_path = str(project_root.absolute())
            canonical_path = str(project_root.resolve())
            shown = _data(run_platform_cli(platform_root, ["project", "show", str(project_root), "--json"], run_command),
                          "registered project after JSON install").get("project", {})
            if (shown.get("path") != canonical_path or not shown.get("id")
                    or receipt.get("projectSelectedPath") != selected_path
                    or receipt.get("projectCanonicalPath") != canonical_path
                    or receipt.get("projectId") != shown.get("id")):
                raise RuntimeError(f"JSON install did not register the canonical project path: {shown}")
            repeated = _data(run_platform_cli(platform_root,
                                              ["project", "add", str(project_root), "--json"], run_command),
                             "idempotent add of installer-registered project")
            if repeated.get("alreadyExisted") is not True or repeated.get("project", {}).get("id") != shown.get("id"):
                raise RuntimeError("duplicate project add did not return the existing registration")
            if (project_root / ".kb").exists():
                raise RuntimeError("JSON project registration wrote KB Labs files into the project repository")
            installed = True
        except Exception:
            cleanup_installer_fixture_root(platform_root, launcher, run_command)
            raise

    def update_after_project_removed() -> None:
        if not installed:
            raise RuntimeError("project install fixture did not complete")
        request_path = platform_root.parent / "s187-receipt-request.json"
        try:
            receipt = json.loads((active_platform_root(platform_root) / ".kb/v2/receipt.json").read_text())
            request_path.write_text(json.dumps(receipt["plan"]["request"]))
            shutil.rmtree(project_root)
            updated = _data(run_command([launcher, "update", "--json", "--index", str(stable_index),
                                         "--input", str(request_path)]),
                            "update after registered project directory was removed")
            if updated.get("ok") is not True or not updated.get("alreadyUpToDate"):
                raise RuntimeError(f"update did not accept the receipt request after project removal: {updated}")
        finally:
            request_path.unlink(missing_ok=True)
            cleanup_installer_fixture_root(platform_root, launcher, run_command)

    def reject_changed_project_selection() -> None:
        recorded = project_root
        selected = platform_root.parent / "s187-changed-project-alias"
        if not selected.exists():
            selected.symlink_to(recorded, target_is_directory=True)
        receipt_path = active_platform_root(platform_root) / ".kb/v2/receipt.json"
        before = receipt_path.read_bytes()
        before_root = snapshot_tree(platform_root)
        result = run_command([launcher, "install", "--json", "--index", str(stable_index),
                              "--platform-root", str(platform_root), "--project-root", str(selected)])
        _, failure = _diagnostic(result, "install with a changed project selection")
        if (failure.get("code") != "KB_INSTALL_PROJECT_SELECTION_CHANGED"
                or "path spelling differs" not in failure.get("message", "")
                or "different project" in failure.get("message", "").lower()
                or not _hint_has_argv(failure.get("hint", ""), kb_command([ "project", "add"]))
                or not _hint_has_argv(failure.get("hint", ""), kb_command([ "project", "show"]))
                or receipt_path.read_bytes() != before or snapshot_tree(platform_root) != before_root):
            raise RuntimeError("changed project selection was not refused before the active receipt changed")
        apply_result = run_command([launcher, "apply", "--json", "--index", str(stable_index),
                                    "--platform-root", str(platform_root), "--project-root", str(selected)])
        _, apply_failure = _diagnostic(apply_result, "apply with a changed project selection")
        if (apply_failure.get("code") != "KB_INSTALL_PROJECT_SELECTION_CHANGED"
                or not _hint_has_argv(apply_failure.get("hint", ""), kb_command([ "project", "add"]))
                or not _hint_has_argv(apply_failure.get("hint", ""), kb_command([ "project", "show"]))
                or receipt_path.read_bytes() != before or snapshot_tree(platform_root) != before_root):
            raise RuntimeError("apply changed the active receipt instead of refusing the selection")

    def accept_existing_project_selections() -> None:
        root = platform_root.parent / "s187-repeat-install"
        selected_project = platform_root.parent / "s187-repeat-project"
        selected_alias = platform_root.parent / "s187-repeat-project-alias"
        root.mkdir(parents=True, exist_ok=True)
        selected_project.mkdir(parents=True, exist_ok=True)
        selected_alias.symlink_to(selected_project, target_is_directory=True)
        registry_path = Path.home() / ".kb/projects.json"
        try:
            initial = run_command([launcher, "install", "--json", "--index", str(stable_index),
                                   "--platform-root", str(root), "--service-profile", "default",
                                   "--scenario", "custom", "--scenario-answers", '{"access.mode":"local"}',
                                   "--gateway-url", unused_loopback_gateway_url(),
                                   "--project-root", str(selected_alias)])
            initial_data = _data(initial, "initial install for repeated project selection")
            recorded_identity = {field: initial_data.get("receipt", {}).get(field)
                                 for field in ("projectSelectedPath", "projectId", "projectCanonicalPath")}
            before = registry_path.read_bytes()
            repeated = run_command([launcher, "install", "--json", "--index", str(stable_index),
                                    "--platform-root", str(root), "--service-profile", "default",
                                    "--scenario", "custom", "--scenario-answers", '{"access.mode":"local"}',
                                    "--project-root", str(selected_alias)])
            _assert_repeat_install_applied(repeated, launcher=launcher, root=root, run_command=run_command,
                                           expected_identity=recorded_identity,
                                           label="repeat install with the recorded selected spelling")
            canonical_repeat = run_command([launcher, "install", "--json", "--index", str(stable_index),
                                            "--platform-root", str(root), "--service-profile", "default",
                                            "--scenario", "custom", "--scenario-answers", '{"access.mode":"local"}',
                                            "--project-root", str(selected_project.resolve())])
            _assert_repeat_install_applied(canonical_repeat, launcher=launcher, root=root, run_command=run_command,
                                           expected_identity=recorded_identity,
                                           label="repeat install with the recorded canonical spelling")
            omitted = run_command([launcher, "install", "--json", "--index", str(stable_index),
                                   "--platform-root", str(root), "--service-profile", "default",
                                   "--scenario", "custom", "--scenario-answers", '{"access.mode":"local"}'])
            _assert_repeat_install_applied(omitted, launcher=launcher, root=root, run_command=run_command,
                                           expected_identity=recorded_identity,
                                           label="repeat install with no selected project")
            after = registry_path.read_bytes()
            if (initial.returncode != 0 or repeated.returncode != 0 or canonical_repeat.returncode != 0 or omitted.returncode != 0
                    or after != before):
                raise RuntimeError("an existing recorded or omitted selection triggered project registration")
        finally:
            action_error = sys.exc_info()[1]
            try:
                cleanup_installer_fixture_root(root, launcher, run_command)
            except Exception as cleanup_error:
                if action_error is not None:
                    raise RuntimeError(f"{action_error}; fixture cleanup failed: {cleanup_error}") from action_error
                raise

    def install_secured_project_without_session() -> None:
        root = platform_root.parent / "s187-secured"
        project = platform_root.parent / "s187-secured-project"
        project_alias = platform_root.parent / "s187-secured-project-alias"
        admin_password = journey_value("KB_JOURNEY_ADMIN_PASSWORD", "JourneyInstallSecret1!")
        root.mkdir(parents=True, exist_ok=True)
        project.mkdir(parents=True, exist_ok=True)
        project_alias.symlink_to(project, target_is_directory=True)
        selected_path = str(project_alias.absolute())
        canonical_path = str(project.resolve())
        try:
            result = run_command([launcher, "install", "--index", str(stable_index),
                                  "--platform-root", str(root), "--service-profile", "default",
                                  "--scenario", "custom", "--scenario-answers",
                                  '{"access.mode":"secured","admin.email":"x18-admin@example.test","admin.tenant":"default"}',
                                  "--secret-env", "gateway.bootstrap.password=KB_JOURNEY_ADMIN_PASSWORD",
                                  "--project-root", str(project_alias)])
            if result.returncode != 0 or "First administrator credentials (shown once)" not in result.stdout:
                raise RuntimeError("secured install did not complete or disclose the first administrator once")
            if not _hint_has_argv(result.stdout, kb_command([ "project", "show", canonical_path])):
                raise RuntimeError("secured install omitted its project verification command")
            registry_path = Path.home() / ".kb/projects.json"
            registry = json.loads(registry_path.read_text())
            registered = [entry for entry in registry.get("projects", [])
                          if entry.get("path") == str(project.resolve())]
            if len(registered) != 1 or (Path.home() / ".kb/session.json").exists():
                raise RuntimeError("secured install did not register once or left a CLI session")
            if (project / ".kb").exists():
                raise RuntimeError("secured project registration wrote into the project repository")
            active_root = active_platform_root(root)
            receipt = json.loads((active_root / ".kb/v2/receipt.json").read_text())
            if (receipt.get("projectSelectedPath") != selected_path
                    or receipt.get("projectCanonicalPath") != canonical_path
                    or receipt.get("projectId") != registered[0].get("id")
                    or canonical_path not in result.stdout):
                raise RuntimeError("secured install did not report the registry-owned project identity")
            recorded_identity = {field: receipt.get(field)
                                 for field in ("projectSelectedPath", "projectId", "projectCanonicalPath")}
            gateway_url = receipt.get("verification", {}).get("hostHealthUrl", "")
            gateway_origin = urlsplit(gateway_url)
            gateway_url = f"{gateway_origin.scheme}://{gateway_origin.netloc}"
            login = evidence_run_command(kb_command([ "auth", "login",
                                          "--gateway-url", gateway_url, "--email", "x18-admin@example.test",
                                          "--password-stdin"], executable=str(active_root / ".kb/v2/bin/kb")), input=admin_password + "\n")
            if login.returncode != 0 or not (Path.home() / ".kb/session.json").is_file():
                raise RuntimeError("explicit administrator login did not create a CLI session")
            shown = _data(run_platform_cli(root, ["project", "show", str(project), "--json"], run_command),
                          "printed project verification command after explicit login").get("project", {})
            if shown.get("path") != str(project.resolve()) or shown.get("id") != registered[0].get("id"):
                raise RuntimeError("the printed project verification command did not show the registered project")
            (Path.home() / ".kb/session.json").unlink(missing_ok=True)
            registry_before_repeat = registry_path.read_bytes()
            repeat = run_command([launcher, "install", "--json", "--index", str(stable_index),
                                  "--platform-root", str(root), "--service-profile", "default",
                                  "--scenario", "custom", "--scenario-answers",
                                  '{"access.mode":"secured","admin.email":"x18-admin@example.test","admin.tenant":"default"}',
                                  "--project-root", str(project_alias)])
            _assert_repeat_install_applied(repeat, launcher=launcher, root=root, run_command=run_command,
                                           expected_identity=recorded_identity,
                                           label="repeat secured install with its recorded project")
            canonical_repeat = run_command([launcher, "install", "--json", "--index", str(stable_index),
                                            "--platform-root", str(root), "--service-profile", "default",
                                            "--scenario", "custom", "--scenario-answers",
                                            '{"access.mode":"secured","admin.email":"x18-admin@example.test","admin.tenant":"default"}',
                                            "--project-root", str(project.resolve())])
            _assert_repeat_install_applied(canonical_repeat, launcher=launcher, root=root, run_command=run_command,
                                           expected_identity=recorded_identity,
                                           label="repeat secured install with recorded canonical path")
            omitted = run_command([launcher, "install", "--json", "--index", str(stable_index),
                                   "--platform-root", str(root), "--service-profile", "default",
                                   "--scenario", "custom", "--scenario-answers",
                                   '{"access.mode":"secured","admin.email":"x18-admin@example.test","admin.tenant":"default"}'])
            _assert_repeat_install_applied(omitted, launcher=launcher, root=root, run_command=run_command,
                                           expected_identity=recorded_identity,
                                           label="repeat secured install without a project selection")
            if repeat.returncode != 0 or canonical_repeat.returncode != 0 or omitted.returncode != 0 or registry_path.read_bytes() != registry_before_repeat:
                raise RuntimeError("secured existing project selections unexpectedly required login")
            receipt_path = active_platform_root(root) / ".kb/v2/receipt.json"
            before = receipt_path.read_bytes()
            before_root = snapshot_tree(root)
            changed = platform_root.parent / "s187-secured-changed-project-alias"
            changed.symlink_to(project, target_is_directory=True)
            refusal = run_command([launcher, "install", "--json", "--index", str(stable_index),
                                  "--platform-root", str(root), "--project-root", str(changed)])
            _, failure = _diagnostic(refusal, "secured install with changed project selection")
            if (failure.get("code") != "KB_INSTALL_PROJECT_SELECTION_CHANGED"
                    or "path spelling differs" not in failure.get("message", "")
                    or "different project" in failure.get("message", "").lower()
                    or not _hint_has_argv(failure.get("hint", ""), kb_command([ "auth", "login", "--gateway-url"]))
                    or not _hint_has_argv(failure.get("hint", ""), kb_command([ "project", "add"]))
                    or not _hint_has_argv(failure.get("hint", ""), kb_command([ "project", "show"]))
                    or receipt_path.read_bytes() != before or snapshot_tree(root) != before_root):
                raise RuntimeError("secured changed project selection was not refused before apply")
            apply_refusal = run_command([launcher, "apply", "--json", "--index", str(stable_index),
                                         "--platform-root", str(root), "--project-root", str(changed)])
            _, apply_failure = _diagnostic(apply_refusal, "secured apply with changed project selection")
            if (apply_failure.get("code") != "KB_INSTALL_PROJECT_SELECTION_CHANGED"
                    or not _hint_has_argv(apply_failure.get("hint", ""), kb_command([ "auth", "login", "--gateway-url"]))
                    or not _hint_has_argv(apply_failure.get("hint", ""), kb_command([ "project", "add"]))
                    or not _hint_has_argv(apply_failure.get("hint", ""), kb_command([ "project", "show"]))
                    or receipt_path.read_bytes() != before or snapshot_tree(root) != before_root):
                raise RuntimeError("secured apply changed the active receipt instead of refusing the selection")
        finally:
            (Path.home() / ".kb/session.json").unlink(missing_ok=True)
            cleanup_installer_fixture_root(root, launcher, run_command)

    journey.step("install a custom scenario in JSON mode and register its project",
                 "platform.install", install_and_show, cases=["S-187.6"])
    journey.step("make project registration idempotent for the same canonical path",
                 "platform.install", install_and_show, cases=["S-124.14"])
    if mode == "local":
        journey.step("refuse a changed project selection before applying an existing installation",
                     "platform.install", reject_changed_project_selection, cases=["S-187.11"],
                     runners=("agent:commit", "service-local:explore"))
    if mode == "local":
        journey.step("accept the recorded or omitted project selection without registering again",
                     "platform.install", accept_existing_project_selections, cases=["S-187.12"],
                     runners=("agent:commit", "service-local:explore"))
    if mode == "secured":
        journey.step("register the selected project during secured first install without saving a session",
                     "platform.install", install_secured_project_without_session,
                     cases=["S-187.10", "S-187.11", "S-187.12"],
                     runners=("agent-secured:commit", "service-secured:explore"))
    journey.step("update after the registered project directory was removed",
                 "platform.update", update_after_project_removed, cases=["S-187.9"])
    return journey


def run_repeat_plan_readonly_step(*, mode: str, launcher: str, stable_index: Path,
                                  platform_root: Path, run_command: CommandRunner) -> Journey:
    """Compare repeat plans while the host runs, excluding declared runtime state."""
    journey = Journey(mode, f"repeat-plan-readonly-{mode}")
    root = str(platform_root)

    def repeat_plan() -> None:
        lifecycle = InstallerHostLifecycle(launcher, run_command)
        with lifecycle.preserve([platform_root]) as initial:
            if not initial[platform_root]:
                lifecycle.set_running(platform_root, True)
            before = _snapshot_installation_owned_tree(platform_root)
            args = [launcher, "plan", "--json", "--index", str(stable_index),
                    "--platform-root", root, "--service-profile", "default",
                    "--scenario", "commit"]
            first = _json_command(run_command, args, "first clean-install plan").get("plan", {})
            second = _json_command(run_command, args, "repeat clean-install plan").get("plan", {})
            if any(first.get(key) != second.get(key) for key in ("planHash", "artifacts", "serviceGraph")):
                raise RuntimeError("repeat plan changed planHash, artifacts, or serviceGraph")
            after = _snapshot_installation_owned_tree(platform_root)
            changes = _snapshot_changes(before, after)
            if any(changes.values()):
                raise RuntimeError(_format_snapshot_changes(changes))
            status = _json_command(run_command, [launcher, "status", "--platform-root", root, "--json"],
                                   "status after repeat plan")
            host = status.get("host", {})
            if (not isinstance(host, dict) or host.get(layout_value('sharedStateDirectory')) != "running"
                    or status.get("running") is not True or status.get("reachable") is not True):
                raise RuntimeError("host health check failed after PC-001.8: expected running and reachable")

    journey.step("repeat install planning without changing the installed root", "platform.install",
                 repeat_plan, cases=["PC-001.8"])
    return journey


def _runtime_state_paths() -> tuple[str, ...]:
    layout_path = workspace_resource("tools", "kb-create", "v2", "contracts", "platform-layout.json")
    layout = json.loads(layout_path.read_text(encoding="utf-8"))
    return tuple(layout["runtimeStatePaths"]) + (layout["platformDataRoot"]["statePath"],)


def _snapshot_installation_owned_tree(root: Path) -> dict[str, tuple[str, bytes | str | None]]:
    layout_path = workspace_resource("tools", "kb-create", "v2", "contracts", "platform-layout.json")
    layout = json.loads(layout_path.read_text(encoding="utf-8"))
    runtime_paths = tuple(Path(path).parts for path in _runtime_state_paths())
    runtime_paths += tuple(Path(item["statePath"]).parts for item in layout.get("sharedRuntimePaths", []))
    shared_platform_paths = (Path(layout["platformDataRoot"]["platformPath"]).parts,)
    shared_platform_paths += tuple(Path(item["platformPath"]).parts for item in layout.get("sharedRuntimePaths", []))
    version_root = Path(layout["versionRoots"]["path"]).parts
    version_state_paths = tuple(Path(entry["path"]).parts for entry in layout.get("versionStatePaths", []))
    version_state_paths += shared_platform_paths
    snapshot = snapshot_tree(root)
    return {
        path: value for path, value in snapshot.items()
        if not any(Path(path).parts[:len(runtime_path)] == runtime_path for runtime_path in runtime_paths)
        and not any(Path(path).parts[:len(version_state)] == version_state
                    for version_state in version_state_paths)
        and not any(parts[index + len(version_root) + 1:][:len(version_state)] == version_state
                    for version_state in version_state_paths
                    for parts in (Path(path).parts,)
                    for index in range(len(parts) - len(version_root) + 1)
                    if parts[index:index + len(version_root)] == version_root)
    }


def _service_ids_match(planned_graph: dict, declared_graph: dict) -> bool:
    planned = planned_graph.get("services", [])
    declared = declared_graph.get("services", [])
    if not planned or not declared:
        return False
    planned_ids = [service.get("id") for service in planned]
    declared_ids = [service.get("id") for service in declared]
    return all(planned_ids) and all(declared_ids) and len(planned_ids) == len(set(planned_ids)) \
        and len(declared_ids) == len(set(declared_ids)) and set(planned_ids) == set(declared_ids)


def _snapshot_changes(before: dict[str, tuple[str, bytes | str | None]],
                      after: dict[str, tuple[str, bytes | str | None]]) -> dict[str, list[str]]:
    old_paths, new_paths = set(before), set(after)
    added = sorted(new_paths - old_paths)
    removed = sorted(old_paths - new_paths)
    changed = sorted(path for path in old_paths & new_paths if before[path] != after[path])
    return {"changed": changed, "added": added, "removed": removed}


def _format_snapshot_changes(changes: dict[str, list[str]]) -> str:
    total = sum(len(paths) for paths in changes.values())
    remaining = 20
    categories = []
    for category in ("changed", "added", "removed"):
        paths = changes[category]
        visible = paths[:remaining]
        remaining -= len(visible)
        categories.append(f"{category} ({len(paths)}): {', '.join(visible) if visible else 'none'}")
    shown = min(total, 20)
    return ("planning changed the active platform root: " + "; ".join(categories)
            + f"; {total} path(s) total, showing {shown} of {total}")


def run_invalid_request_step(*, mode: str, launcher: str, stable_index: Path,
                             platform_root: Path, run_command: CommandRunner) -> Journey:
    """Prove invalid request validation is actionable and does not mutate an install."""
    journey = Journey(mode, f"invalid-request-{mode}")

    def invalid_request_actionable() -> None:
        request_file = platform_root.parent / f"s039-invalid-request-{mode}.json"
        request_file.write_text(json.dumps({"schema": "kb.create/v2", "platformRoot": ""}) + "\n")
        before = _snapshot_installation_owned_tree(platform_root)
        try:
            result = run_command([launcher, "apply", "--json", "--index", str(stable_index),
                                  "--input", str(request_file)])
            envelope, error = _diagnostic(result, "invalid install request")
            after = _snapshot_installation_owned_tree(platform_root)
            hint = error.get("hint", "")
            retry = ["kb-create", "apply", "--index", str(stable_index), "--input", str(request_file), "--json"]
            if (result.returncode == 0 or envelope.get("ok") is not False
                    or error.get("code") != "KB_INSTALL_INPUT_REQUIRED"
                    or "platformRoot" not in hint or str(request_file) not in hint
                    or retry not in _commands_in_hint(hint)
                    or before != after):
                raise RuntimeError(f"invalid request omitted field repair guidance or exact retry command, or changed installed state: {error}")
        finally:
            request_file.unlink(missing_ok=True)

    journey.step("report the invalid request field and preserve installed state", "platform.install",
                 invalid_request_actionable, cases=["S-039.4"])
    return journey


def run_apply_scenario_step(*, mode: str, launcher: str, stable_index: Path,
                            platform_root: Path, run_command: CommandRunner) -> Journey:
    """Prove direct JSON apply resolves scenario answers into its receipt."""
    journey = Journey(mode, f"apply-scenario-{mode}")
    apply_root = platform_root.parent / f"s039-apply-scenario-{mode}"

    def apply_scenario_and_check_receipt() -> None:
        answers = json.dumps({"cache": "state-broker"}, separators=(",", ":"))
        result = run_command([launcher, "apply", "--json", "--index", str(stable_index),
                              "--platform-root", str(apply_root), "--service-profile", "default",
                              "--gateway-url", unused_loopback_gateway_url(),
                              "--scenario", "commit", "--scenario-answers", answers])
        try:
            apply_result = read_kb_create_cli_result("apply", result)
            if result.returncode != 0 or apply_result.get("ok") is not True:
                raise RuntimeError("apply JSON document did not contain its successful result")
            apply_result = decode_ux_success_result(apply_result)
            request = apply_result.get("receipt", {}).get("plan", {}).get("request", {})
            receipt_value = apply_result.get("receipt", {})
            if (apply_result.get("operation") != "apply" or request.get("platformRoot") != str(apply_root)
                    or request.get("providerPreferences", {}).get("cache") != "state-broker"
                    or not apply_result.get("logPath")):
                raise RuntimeError("apply result receipt omitted the isolated root or selected cache provider")
            assert_commit_marketplace_receipt(receipt_value)
        finally:
            cleanup_installer_fixture_root(apply_root, launcher, run_command)

    journey.step("apply scenario answers and verify the selected provider in the receipt",
                 "platform.install", apply_scenario_and_check_receipt, cases=["S-039.1"])
    return journey


def run_installer_case_steps(*, mode: str, launcher: str, stable_index: Path,
                             update_index: Path, jump_index: Path,
                             canary_index: Path, platform_root: Path,
                             secret_value: str, registry: str,
                             run_command: CommandRunner) -> Journey:
    """Claim request, configuration, doctor-repair, and compatibility cases.

    Install roots used by the request-selection steps are children of the
    journey's already isolated HOME; callers must pass that HOME's paths.
    """
    journey = Journey(mode, f"installer-cases-{mode}")
    host_os = "darwin" if sys.platform == "darwin" else "linux" if sys.platform.startswith("linux") else "unsupported"
    host_arch = {"x86_64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine().lower(), platform.machine().lower())
    try:
        installed_root = active_platform_root(platform_root)
    except FileNotFoundError:
        journey.step("preflight installer case fixtures", "journey.orchestration",
                     lambda: f"no installed platform at {platform_root}")
        return journey
    installed_cli_entry = installed_root / "node_modules/@kb-labs/cli-bin/dist/bin.js"
    required_paths = [*installer_scenario_resources(host_os, host_arch), installed_cli_entry]
    catalog_root = required_paths[0]
    missing_resources = [str(path) for path in required_paths
                         if not (path.is_dir() if path == catalog_root else path.is_file())]
    if missing_resources:
        journey.step("preflight installer case fixtures", "journey.orchestration",
                     lambda: "missing installer journey resource(s): " + ", ".join(missing_resources))
        return journey

    journey.step_guard = installer_primary_host_guard(platform_root, launcher, run_command)
    journey.step("compare installed candidate bytes with sealed provenance", "platform.install",
                 lambda: verify_installed_candidate_provenance(installed_root), cases=["PC-001.19"])
    journey.step("report package-manager stderr when exact-artifact apply fails", "platform.install",
                 lambda: verify_package_manager_failure_diagnostic(
                     launcher=launcher, stable_index=stable_index, platform_root=platform_root,
                     registry=registry, run_command=run_command),
                 cases=["PC-001.2"])
    journey.step("refuse candidate-derived package bytes that disagree with provenance", "platform.install",
                 lambda: run_candidate_provenance_mismatch_step(
                     launcher=launcher, candidate_index=stable_index, installed_root=installed_root,
                     registry=registry, run_command=run_command), cases=["PC-001.19"])

    fixture_dir = installer_case_fixture_root()
    root = str(platform_root)
    run_fixture_group(journey, "PC-001 port ownership", lambda: run_port_conflict_step(
        mode=mode, launcher=launcher, stable_index=stable_index,
        platform_root=platform_root, run_command=run_command))

    # PC-001.4 applies an explicit fresh fixture so the end-to-end installer
    # remains the single main journey install and can continue serving later cases.
    apply_root = platform_root.parent / "pc001-apply-root"
    apply_root.mkdir(parents=True, exist_ok=True)
    selected_plan: dict = {}

    def apply_and_check() -> None:
        selected_plan["serviceGraph"] = _json_command(
            run_command, [launcher, "plan", "--json", "--index", str(stable_index),
                          "--platform-root", str(apply_root),
                          "--service-profile", "default", "--scenario", "commit"],
            "PC-001 selected profile plan").get("plan", {}).get("serviceGraph", {})
        result = _data(run_command([launcher, "apply", "--json", "--index", str(stable_index),
                                   "--platform-root", str(apply_root),
                                   "--service-profile", "default", "--scenario", "commit"]),
                      "PC-001 apply")
        if result.get("operation") != "apply" or not result.get("receipt") or not result.get("logPath"):
            raise RuntimeError("apply result omitted operation, receipt, or logPath")
        assert_apply_shim_owner(result, apply_root)
        assert_commit_marketplace_receipt(result["receipt"])
        status = _data(run_command([launcher, "status", "--json", "--platform-root", str(apply_root)]),
                       "PC-001 apply status")
        host = status.get("host", {})
        if (status.get("installed") is not True or status.get("running") is not True
                or status.get("reachable") is not True or host.get(layout_value('sharedStateDirectory')) != "running"):
            raise RuntimeError(f"successful apply did not leave a running, reachable host: {status}")

    journey.step("apply the resolved default service profile", "platform.install", apply_and_check,
                 cases=["PC-001.4"])

    def isolated_container_install() -> None:
        with tempfile.TemporaryDirectory(prefix="pc001-container-") as temporary:
            parent = Path(temporary)
            install_root = parent / "install"
            request_handle = tempfile.NamedTemporaryFile(prefix="s023-container-update-", suffix=".json")
            request_path = Path(request_handle.name)
            request_handle.close()
            try:
                result = _data(run_command([launcher, "install", "--json", "--index", str(stable_index),
                                            "--platform-root", str(install_root),
                                            "--service-profile", "default", "--scenario", "commit"]),
                               "PC-001 install container")
                current = install_root / layout_value('currentLink')
                versions = install_root / layout_value('versionRoots.path')
                current_target = Path(current.readlink()) if current.is_symlink() else Path()
                if (result.get("operation") != "apply" or sorted(path.name for path in parent.iterdir()) != ["install"]
                        or not current.is_symlink() or current_target.is_absolute()):
                    raise RuntimeError("fresh install wrote outside its container or omitted the relative current link")
                verify_installed_candidate_provenance(current.resolve())
                resolved = current.resolve(strict=True)
                if resolved.parent != versions.resolve(strict=True) or not (resolved / ".kb/v2/receipt.json").is_file():
                    raise RuntimeError("current did not resolve to a complete version root inside the container")
                receipt = json.loads((active_platform_root(install_root) / ".kb/v2/receipt.json").read_text())
                original_version = receipt.get("plan", {}).get("serviceGraph", {}).get("platformVersion")
                for label, index in (("first", update_index), ("second", jump_index)):
                    index_payload = json.loads(index.read_text())
                    target = index_payload.get("channels", {}).get("stable")
                    if not target:
                        raise RuntimeError(f"{label} container update index has no stable platform release")
                    request = dict(receipt.get("plan", {}).get("request", {}))
                    platform_request = dict(request.get("platform", {}))
                    platform_request["version"] = target
                    platform_request.pop("channel", None)
                    request["platform"] = platform_request
                    request["sdk"] = {"version": target}
                    request_path.write_text(json.dumps(request) + "\n")
                    updated = _data(run_command([launcher, "update", "--json", "--index", str(index),
                                                 "--input", str(request_path), "--platform-root", str(install_root)]),
                                    f"S-023.17 {label} update")
                    pending = updated.get("pendingRestart")
                    if (updated.get("hostRestarted") is not False
                            or not isinstance(pending, dict) or pending.get("installedVersion") != target
                            or sorted(path.name for path in parent.iterdir()) != ["install"]):
                        raise RuntimeError(f"{label} update changed outside the install root or restarted the host")
                    receipt = json.loads((active_platform_root(install_root) / ".kb/v2/receipt.json").read_text())
                    status = _data(run_command([launcher, "status", "--platform-root", str(install_root), "--json"]),
                                   f"S-023.17 {label} status")
                    if (status.get("runningVersion") != original_version
                            or status.get("installedVersion") != target
                            or sorted(path.name for path in parent.iterdir()) != ["install"]):
                        raise RuntimeError(f"{label} update changed the running version or wrote outside the root")
                restarted = _data(run_command([launcher, "restart", "--platform-root", str(install_root), "--json"]),
                                  "S-023.17 restart after repeated updates")
                if (restarted.get("pendingRestart") is not None
                        or sorted(path.name for path in parent.iterdir()) != ["install"]):
                    raise RuntimeError("restart did not clear pendingRestart or changed the parent directory")
            finally:
                request_path.unlink(missing_ok=True)
                cleanup_installer_fixture_root(install_root, launcher, run_command)
            if list(parent.iterdir()):
                raise RuntimeError("uninstall left an installation-owned path outside or inside the temporary parent")

        with tempfile.TemporaryDirectory(prefix="pc001-interrupted-install-") as temporary:
            parent = Path(temporary)
            install_root = parent / "install"
            (install_root / layout_value('versionRoots.path') / ".stage-interrupted").mkdir(parents=True)
            (install_root / layout_value('ownershipRecord')).write_text(
                json.dumps({"schema": "kb.create.installation-owner/v1", "installationId": "a" * 32}) + "\n")
            retried = _data(run_command([launcher, "install", "--json", "--index", str(stable_index),
                                         "--platform-root", str(install_root),
                                         "--service-profile", "default", "--scenario", "commit"]),
                            "PC-001 interrupted install retry")
            if (retried.get("operation") != "apply" or not (install_root / layout_value('currentLink')).is_symlink()
                    or (install_root / layout_value('versionRoots.path') / ".stage-interrupted").exists()
                    or sorted(path.name for path in parent.iterdir()) != ["install"]):
                raise RuntimeError("retry did not recover the owned interrupted install container")
            cleanup_installer_fixture_root(install_root, launcher, run_command)
            if list(parent.iterdir()):
                raise RuntimeError("interrupted install retry cleanup left owned paths behind")

        with tempfile.TemporaryDirectory(prefix="pc001-empty-install-root-") as temporary:
            parent = Path(temporary)
            install_root = parent / "install"
            install_root.mkdir()
            try:
                result = _data(run_command([launcher, "install", "--json", "--index", str(stable_index),
                                            "--platform-root", str(install_root),
                                            "--service-profile", "default", "--scenario", "commit"]),
                               "PC-001 empty-root install")
                if (result.get("operation") != "apply" or not (install_root / layout_value('currentLink')).is_symlink()
                        or sorted(path.name for path in parent.iterdir()) != ["install"]):
                    raise RuntimeError("install into an empty target did not create only its versioned container")
            except Exception:
                cleanup_installer_fixture_root(install_root, launcher, run_command)
                raise
            else:
                cleanup_installer_fixture_root(install_root, launcher, run_command)
            if list(parent.iterdir()):
                raise RuntimeError("empty-root install cleanup left owned paths behind")

        with tempfile.TemporaryDirectory(prefix="pc001-interrupted-uninstall-") as temporary:
            parent = Path(temporary)
            install_root = parent / "install"
            (install_root / layout_value('versionRoots.path') / ".stage-interrupted").mkdir(parents=True)
            (install_root / layout_value('ownershipRecord')).write_text(
                json.dumps({"schema": "kb.create.installation-owner/v1", "installationId": "b" * 32}) + "\n")
            foreign = install_root / "foreign.txt"
            foreign.write_text("preserve me\n")
            removed = _data(run_command([launcher, "uninstall", "--yes", "--json", "--platform-root",
                                         str(install_root)]), "PC-001 interrupted install uninstall")
            if (removed.get("operation") != "uninstall" or foreign.read_text() != "preserve me\n"
                    or sorted(path.name for path in install_root.iterdir()) != ["foreign.txt"]):
                raise RuntimeError("uninstall did not remove interrupted owned entries and preserve foreign data")
        with tempfile.TemporaryDirectory(prefix="pc001-foreign-target-") as temporary:
            foreign_root = Path(temporary) / "foreign"
            foreign_root.mkdir()
            foreign_file = foreign_root / "keep.txt"
            foreign_file.write_text("user data\n")
            refused = run_command([launcher, "install", "--json", "--index", str(stable_index),
                                   "--platform-root", str(foreign_root),
                                   "--service-profile", "default", "--scenario", "commit"])
            _, error = _diagnostic(refused, "PC-001 foreign target")
            if (error.get("code") != "KB_INSTALL_LAYOUT_UNSUPPORTED"
                    or "kb-create install --platform-root" not in error.get("hint", "")
                    or foreign_file.read_text() != "user data\n"):
                raise RuntimeError("fresh install did not refuse a foreign non-empty directory unchanged")

        with tempfile.TemporaryDirectory(prefix="pc001-damaged-target-") as temporary:
            damaged_root = Path(temporary) / "damaged"
            (damaged_root / layout_value('currentLink')).mkdir(parents=True)
            before = snapshot_tree(damaged_root)
            refused = run_command([launcher, "install", "--json", "--index", str(stable_index),
                                   "--platform-root", str(damaged_root),
                                   "--service-profile", "default", "--scenario", "commit"])
            _, error = _diagnostic(refused, "PC-001 damaged target")
            if (error.get("code") != "KB_INSTALL_LAYOUT_UNSUPPORTED"
                    or "kb-create install --platform-root" not in error.get("hint", "")
                    or snapshot_tree(damaged_root) != before):
                raise RuntimeError("install did not refuse the damaged current entry unchanged")

        with tempfile.TemporaryDirectory(prefix="s050-foreign-container-") as temporary:
            parent = Path(temporary)
            install_root = parent / "install"
            sibling = parent / "unrelated-sibling"
            sibling.mkdir()
            marker = sibling / "keep.txt"
            marker.write_text("sibling user data\n")
            _data(run_command([launcher, "apply", "--json", "--index", str(stable_index),
                               "--platform-root", str(install_root), "--service-profile", "default",
                               "--scenario", "commit"]), "S-050.8 install")
            foreign = install_root / "keep.txt"
            foreign.write_text("installation-root user data\n")
            removed = _data(run_command([launcher, "uninstall", "--json", "--yes",
                                         "--platform-root", str(install_root)]), "S-050.8 uninstall")
            if (foreign.read_text() != "installation-root user data\n"
                    or marker.read_text() != "sibling user data\n"
                    or removed.get("preservedEntries") != [str(foreign)]
                    or sorted(path.name for path in parent.iterdir()) != ["install", "unrelated-sibling"]):
                raise RuntimeError("uninstall did not preserve and name foreign entries byte-for-byte")
            foreign.unlink()
            install_root.rmdir()

    journey.step("install, update twice, restart, and uninstall inside a fresh container", "platform.update",
                 isolated_container_install, cases=["PC-001.17", "PC-001.18", "S-023.17", "S-050.8", "S-223.4"])

    def inspect_generated_config() -> None:
        config_path = active_platform_root(apply_root) / layout_value('sharedRuntimePaths.kb_kb_config_jsonc.platformPath')
        if not config_path.is_file():
            raise RuntimeError("apply did not generate the runtime config")
        config = json.loads(_without_jsonc_comments(config_path.read_text()))
        if not isinstance(config, dict):
            raise RuntimeError("generated runtime config is not a JSON object")
        receipt = json.loads((active_platform_root(apply_root) / ".kb/v2/receipt.json").read_text())
        graph = receipt.get("plan", {}).get("serviceGraph", {})
        if (selected_plan["serviceGraph"].get("profile") != "default"
                or graph.get("profile") != "default"
                or not _service_ids_match(selected_plan["serviceGraph"], graph)):
            raise RuntimeError("receipt service declarations do not equal the selected profile plan")
        layout = json.loads(workspace_resource("tools", "kb-create", "v2", "contracts", "platform-layout.json").read_text())
        roots_contract = layout.get("versionRoots", {})
        version_dir = apply_root / roots_contract.get("path", layout_value('versionRoots.path'))
        if not apply_root.is_dir() or not (apply_root / layout_value('currentLink')).is_symlink() or not (version_dir / (apply_root / layout_value('currentLink')).resolve().name).is_dir():
            raise RuntimeError("fresh install did not create the install container, stable link, and contract-declared version root")
        doctor = _data(run_command([launcher, "doctor", "--json", "--platform-root", str(apply_root)]),
                       "PC-001 platform layout doctor")
        retained = doctor.get("retention", {})
        if retained.get("versionsDirectory") != str(version_dir):
            raise RuntimeError("doctor did not report the platform-layout version root directory")
        with tempfile.TemporaryDirectory(prefix="pc001-unversioned-") as temporary:
            legacy_root = Path(temporary) / "legacy-platform"
            shutil.copytree(active_platform_root(apply_root), legacy_root, symlinks=True)
            legacy_request = Path(temporary) / "request.json"
            legacy_receipt = legacy_root / ".kb/v2/receipt.json"
            request = json.loads(legacy_receipt.read_text())["plan"]["request"]
            request["platformRoot"] = str(legacy_root)
            legacy_request.write_text(json.dumps(request) + "\n")
            before = hashlib.sha256(legacy_receipt.read_bytes()).digest()
            refused = run_command([launcher, "update", "--json", "--index", str(stable_index),
                                   "--input", str(legacy_request)])
            error = decode_ux_error_result(read_kb_create_cli_result("update", refused))
            after = hashlib.sha256(legacy_receipt.read_bytes()).digest()
            if (refused.returncode == 0 or error.get("code") != "KB_INSTALL_LAYOUT_UNSUPPORTED"
                    or not diagnostic_hint_has_next_command(error) or before != after):
                raise RuntimeError("update did not reject the unversioned root with a reinstall command and preserved bytes")
            for operation, arguments in (
                ("restart", ["--platform-root", str(legacy_root), "--json"]),
                ("rollback", ["--platform-root", str(legacy_root), "--snapshot", "snapshot-from-copy", "--yes", "--json"]),
            ):
                refused = run_command([launcher, operation, *arguments])
                error = decode_ux_error_result(read_kb_create_cli_result(operation, refused))
                if (refused.returncode == 0 or error.get("code") != "KB_INSTALL_LAYOUT_UNSUPPORTED"
                        or not diagnostic_hint_has_next_command(error)
                        or hashlib.sha256(legacy_receipt.read_bytes()).digest() != before):
                    raise RuntimeError(f"{operation} did not refuse the unversioned root unchanged with a reinstall command")

    journey.step("inspect generated runtime config and service declarations", "platform.install",
                 inspect_generated_config, cases=["PC-001.5", "S-023.16", "S-223.3"],
                 requires=("step:apply the resolved default service profile",))

    run_fixture_group(journey, "analytics retention validation", lambda: run_analytics_invalid_retention_step(
        mode=mode, launcher=launcher, platform_root=apply_root, run_command=run_command))

    run_fixture_group(journey, "repeat plan", lambda: run_repeat_plan_readonly_step(
        mode=mode, launcher=launcher, stable_index=stable_index,
        platform_root=platform_root, run_command=run_command))

    def channel_plan(channel: str, index: Path, root_name: str) -> None:
        plan = _json_command(run_command, [launcher, "plan", "--json", "--index", str(index),
                                           "--platform-channel", channel, "--policy", "compatible",
                                           "--platform-root", str(platform_root.parent / root_name)],
                             f"{channel} plan").get("plan", {})
        artifacts = plan.get("artifacts", [])
        if (plan.get("platformChannel") != channel or not plan.get("serviceGraph", {}).get("platformVersion")
                or not artifacts or not all(item.get("sha256") for item in artifacts)):
            raise RuntimeError(f"{channel} plan did not resolve an exact version and immutable hashes")
        applied = _data(run_command([launcher, "apply", "--json", "--index", str(index),
                                     "--platform-channel", channel, "--policy", "compatible",
                                     "--platform-root", str(platform_root.parent / root_name)]),
                        f"{channel} apply")
        if not shim_owner_matches(applied, install_root=platform_root.parent / root_name,
                                  expected_owner=platform_root):
            raise RuntimeError(f"{channel} apply changed the live command owner: {applied.get('shim')}")
        status = _json_command(run_command, [launcher, "status", "--json", "--platform-root",
                                             str(platform_root.parent / root_name)], f"{channel} status")
        installation = status.get("installation", status)
        exact_version = plan["serviceGraph"]["platformVersion"]
        if (not applied.get("receipt") or installation.get("platformChannel") != channel
                or installation.get("platformVersion") != exact_version):
            raise RuntimeError(f"receipt-backed status did not confirm {channel} {exact_version}")
    def verify_stable_spellings() -> None:
        stable_root = platform_root.parent / "s181-stable-root"
        verify_stable_installation_spellings(
            launcher=launcher, index=stable_index, install_root=stable_root,
            shim_owner_root=platform_root, run_command=run_command)

    secret_root = platform_root.parent / "s181-secret-root"
    explicit_gateway_root = platform_root.parent / "pc001-explicit-gateway-root"
    def secret_apply() -> None:
        if not secret_value:
            raise RuntimeError("isolated journey secret is unavailable for S-181.3")
        apply_result = run_command([launcher, "apply", "--json", "--index", str(stable_index),
                                    "--platform-channel", "stable", "--platform-root", str(secret_root),
                                    "--scenario", "custom", "--scenario-answers",
                                    json.dumps({"access.mode": "secured", "admin.email": "journey-admin@example.test",
                                                "admin.tenant": "journey"}),
                                    "--secret-env", "gateway.bootstrap.password=KB_JOURNEY_ADMIN_PASSWORD"])
        payload = _data(apply_result, "secret apply")
        if not shim_owner_matches(payload, install_root=secret_root, expected_owner=platform_root):
            raise RuntimeError(f"secret apply changed the live command owner: {payload.get('shim')}")
        secondary_receipt = json.loads((active_platform_root(secret_root) / ".kb/v2/receipt.json").read_text())
        if secondary_receipt.get("verification", {}).get("hostHealthUrl") != "http://127.0.0.1:4100/health":
            raise RuntimeError("secondary apply did not record its automatically allocated Gateway address")
        shim_path = Path(shutil.which(launcher) or launcher).absolute().parent / "kb"
        if not shim_path.is_symlink() or shim_path.readlink() != platform_root / layout_relative('currentLink', '.kb/v2/bin/kb'):
            raise RuntimeError("secondary apply moved the kb shim away from the primary platform root")
        cli = run_platform_cli(platform_root, ["--help"], run_command)
        if cli.returncode != 0:
            raise RuntimeError(f"the existing kb shim did not run the primary platform CLI: {cli.stdout[-500:]}")
        receipt_path = active_platform_root(secret_root) / ".kb/v2/receipt.json"
        serialized = apply_result.stdout + (receipt_path.read_text() if receipt_path.is_file() else "")
        if secret_value in serialized or "KB_JOURNEY_ADMIN_PASSWORD" in serialized:
            raise RuntimeError("secret apply serialized the secret value or environment-variable name")

    journey.step("apply a secret through an environment reference", "platform.install", secret_apply,
                 cases=["S-181.3", "PC-001.10"])

    refusal_roots = {
        "install": platform_root.parent / "s181-secret-input-install",
        "apply": platform_root.parent / "s181-secret-input-apply",
    }

    def reject_undeclared_secret_inputs() -> None:
        if not secret_value:
            raise RuntimeError("isolated journey secret is unavailable for S-181.6")
        variable = "KB_JOURNEY_ADMIN_PASSWORD"
        mapping = f"operator.unknownSecret={variable}"
        answers = json.dumps({"access.mode": "secured", "admin.email": "journey-admin@example.test",
                              "admin.tenant": "journey"})
        for root in refusal_roots.values():
            if root.exists():
                raise RuntimeError("S-181.6 expected an empty isolated install root")
        empty_before = {name: snapshot_tree(root) for name, root in refusal_roots.items()}
        active = active_platform_root(platform_root)
        installed_before = snapshot_tree(active)
        commands = (
            ("install", [launcher, "install", "--json", "--index", str(stable_index),
                          "--platform-channel", "stable", "--platform-root", str(refusal_roots["install"]),
                          "--scenario", "custom", "--scenario-answers", answers, "--secret-env", mapping]),
            ("apply", [launcher, "apply", "--json", "--index", str(stable_index),
                        "--platform-channel", "stable", "--platform-root", str(refusal_roots["apply"]),
                        "--scenario", "custom", "--scenario-answers", answers, "--secret-env", mapping]),
            ("update", [launcher, "update", "--json", "--index", str(update_index),
                         "--platform-channel", "stable", "--platform-root", str(platform_root),
                         "--secret-env", mapping]),
        )
        for operation, argv in commands:
            result = run_command(argv)
            envelope, error = _diagnostic(result, f"S-181.6 {operation} undeclared secret input")
            output = result.stdout + result.stderr
            if (result.returncode != 2 or envelope.get("ok") is not False
                    or error.get("code") != "KB_INSTALL_SECRET_INPUT_INVALID"
                    or "operator.unknownSecret" not in json.dumps(error)
                    or variable in output or secret_value in output):
                raise RuntimeError(f"S-181.6 {operation} did not refuse the undeclared secret input safely")
        if any(snapshot_tree(root) != empty_before[name] for name, root in refusal_roots.items()):
            raise RuntimeError("S-181.6 refusal wrote files under an empty install root")
        if snapshot_tree(active) != installed_before:
            raise RuntimeError("S-181.6 update refusal changed the installed receipt, config, or secret state")

    journey.step("refuse undeclared secret environment inputs before writing state", "platform.install",
                 reject_undeclared_secret_inputs, cases=["S-181.6"],
                 runners=("service-local:explore", "service-secured:explore"),
                 requires=("step:apply a secret through an environment reference",))

    run_fixture_group(journey, "gateway allocation", lambda: run_gateway_allocation_step(
        mode=mode, launcher=launcher, stable_index=stable_index,
        primary_root=platform_root, automatic_root=secret_root,
        explicit_root=explicit_gateway_root, run_command=run_command))

    def verify_primary_spellings() -> None:
        verify_primary_installation_spellings(
            launcher=launcher, index=stable_index, install_root=platform_root,
            run_command=run_command)

    journey.step("plan and update the primary install through all root spellings",
                 "platform.install", verify_primary_spellings, cases=["PC-001.10"])

    journey.step("plan, apply, and verify stable install", "platform.install",
                 lambda: channel_plan("stable", stable_index, "s181-stable-root"), cases=["S-181.1"])
    journey.step("check status, plan, and update stable install through all root spellings", "platform.install",
                 verify_stable_spellings, cases=["S-181.1"])
    journey.step("plan, apply, and verify canary install", "platform.install",
                 lambda: channel_plan("canary", canary_index, "s181-canary-root"), cases=["S-181.2"])

    run_fixture_group(journey, "stable-root layout contract refusal", lambda: run_stable_layout_contract_refusal_step(
        mode=mode, platform_root=platform_root, run_command=run_command))

    run_fixture_group(journey, "secondary root gateway isolation", lambda: run_secondary_root_gateway_isolation_step(
        mode=mode, launcher=launcher, primary_root=platform_root,
        secondary_root=secret_root, admin_password=secret_value, run_command=run_command))

    def repair_dangling_shim() -> None:
        shim_path = Path(shutil.which(launcher) or launcher).absolute().parent / "kb"
        _data(run_command([launcher, "doctor", "--fix", "--platform-root", str(secret_root), "--json"]),
              "doctor fix live non-owner")
        if not shim_path.is_symlink() or shim_path.readlink() != platform_root / layout_relative('currentLink', '.kb/v2/bin/kb'):
            raise RuntimeError("doctor --fix changed a shim owned by another live platform")
        dangling_root = platform_root.parent / "removed-shim-owner"
        existing_target = platform_root.parent / "arbitrary-kb-target"
        existing_target.write_text("user-owned target bytes")
        missing_target = platform_root.parent / "missing-kb-target"
        foreign_targets = (existing_target, missing_target, dangling_root / layout_relative('currentLink', '.kb/v2/bin/kb'))
        for target in foreign_targets:
            shim_path.unlink(missing_ok=True)
            shim_path.symlink_to(target)
            diagnosis = _data(run_command([launcher, "doctor", "--platform-root", str(platform_root), "--json"]),
                              f"doctor foreign shim {target}")
            human_diagnosis = run_command([launcher, "doctor", "--platform-root", str(platform_root)])
            assert_foreign_shim_diagnosis(diagnosis, human_diagnosis.stdout, shim_path, target, platform_root)
            if shim_path.readlink() != target:
                raise RuntimeError(f"doctor changed foreign shim target {target}")
        other_target = active_platform_root(secret_root) / ".kb/v2/bin/kb"
        shim_path.unlink()
        shim_path.symlink_to(other_target)
        other_diagnosis = _data(run_command([launcher, "doctor", "--platform-root", str(platform_root), "--json"]),
                                "doctor shim owned by another validated installation")
        other_human = run_command([launcher, "doctor", "--platform-root", str(platform_root)])
        assert_other_shim_diagnosis(other_diagnosis, other_human.stdout, shim_path, secret_root, platform_root)
        if shim_path.readlink() != other_target:
            raise RuntimeError("doctor changed the shim owned by another validated installation")

        shim_path.unlink()
        _data(run_command([launcher, "doctor", "--fix", "--platform-root", str(platform_root), "--json"]),
              "doctor fix absent shim after explicit removal")
        if shim_path.resolve() != (platform_root / layout_relative('currentLink', '.kb/v2/bin/kb')).resolve():
            raise RuntimeError("doctor --fix did not link the shim to its requested live platform root")

    journey.step("diagnose and repair a dangling managed kb command", "platform.install",
                 repair_dangling_shim, cases=["S-025.9"])

    def repair_gateway_index() -> None:
        registry_path = gateway_registry_path(launcher)
        root = explicit_gateway_root
        registry_before = registry_path.read_bytes()
        receipt_path = active_platform_root(root) / ".kb/v2/receipt.json"
        receipt_before = receipt_path.read_bytes()
        try:
            invalid_data = '{"schema":1,"roots":[]}'
            registry_path.write_text(invalid_data, encoding="utf-8")
            for operation in ("plan", "apply", "status", "doctor", "uninstall"):
                args = [launcher, operation, "--platform-root", str(root), "--json"]
                if operation in ("plan", "apply"):
                    args += ["--index", str(stable_index)]
                if operation == "uninstall":
                    args.append("--yes")
                result = run_command(args)
                payload = read_gateway_index_refusal(result, f"{operation} unusable Gateway index",
                                                     registry_path, root)
                if registry_path.read_text(encoding="utf-8") != invalid_data:
                    raise RuntimeError(f"{operation} changed the unsupported Gateway index")
                if not receipt_path.is_file() or receipt_path.read_bytes() != receipt_before:
                    raise RuntimeError(f"{operation} changed the installation before registry repair")

            hinted_commands = [shlex.split(command) for command in re.findall(r"`([^`]*)`", payload.get("hint", ""))]
            remove_argv = next((argv for argv in hinted_commands
                                if argv[:2] == ["rm", "--"] and argv[2:] == [str(registry_path)]), None)
            if remove_argv is None:
                raise RuntimeError("the diagnostic did not print the exact index removal command")
            removed = run_command(remove_argv)
            if removed.returncode != 0:
                raise RuntimeError(f"the hinted Gateway index removal command failed: {' '.join(remove_argv)}")
            repaired = _data(run_command([launcher, "doctor", "--fix", "--platform-root", str(root), "--json"]),
                             "doctor fix after removing the unusable Gateway index")
            rebuilt = json.loads(registry_path.read_text(encoding="utf-8"))
            receipt = json.loads(receipt_before)
            rows = [row for row in rebuilt.get("roots", [])
                    if row.get("installationId") == receipt.get("installationId")]
            if repaired.get("operation") != "doctor-fix" or rebuilt.get("schema") != 2 or len(rows) != 1:
                raise RuntimeError(f"doctor fix did not rebuild this root's schema-2 Gateway row: {rebuilt}")
        finally:
            registry_path.write_bytes(registry_before)

    journey.step("diagnose and rebuild an unusable Gateway address index", "platform.install",
                 repair_gateway_index, cases=["S-025.10"])

    def uninstall_non_owner() -> None:
        result = _data(run_command([launcher, "uninstall", "--platform-root", str(secret_root), "--yes", "--json"]),
                       "uninstall non-owning root")
        canonical_owner = str(platform_root.resolve())
        if result.get("shimAction") != "left" or result.get("shimOwner") != canonical_owner:
            raise RuntimeError(f"non-owner uninstall did not report the canonical shim owner: {result}")
        shim_path = Path(shutil.which(launcher) or launcher).absolute().parent / "kb"
        if not shim_path.is_symlink() or shim_path.readlink() != platform_root / layout_relative('currentLink', '.kb/v2/bin/kb'):
            raise RuntimeError("uninstall changed the live owner's kb shim")
        if not (active_platform_root(platform_root) / ".kb/v2/bin/kb").is_file():
            raise RuntimeError("uninstall removed the owning platform CLI")

    journey.step("uninstall a platform that does not own the kb command", "platform.install",
                 uninstall_non_owner, cases=["PC-001.11"])

    run_fixture_group(journey, "offline plan", lambda: run_offline_plan_step(
        mode=mode, launcher=launcher, stable_index=stable_index,
        platform_root=platform_root, run_command=run_command))

    for generated_root in (apply_root, platform_root.parent / "s181-stable-root",
                           platform_root.parent / "s181-canary-root", secret_root,
                           explicit_gateway_root, platform_root.parent / "pc001-explicit-gateway-project",
                           platform_root.parent / "removed-shim-owner",
                           platform_root.parent / "s181-offline-root"):
        shutil.rmtree(generated_root, ignore_errors=True)
    run_fixture_group(journey, "installer fixtures", lambda: run_installer_fixture_steps(
        mode=mode, launcher=launcher, platform_root=platform_root,
        stable_index=stable_index, run_command=run_command))
    return journey


def run_installer_fixture_steps(*, mode: str, launcher: str, platform_root: Path,
                                stable_index: Path, run_command: CommandRunner) -> Journey:
    """Exercise isolated doctor, compatibility, and project-install fixtures."""
    journey = Journey(mode, f"installer-fixtures-{mode}")
    fixture_dir = installer_case_fixture_root()
    host_os = "darwin" if sys.platform == "darwin" else "linux" if sys.platform.startswith("linux") else "unsupported"
    host_arch = {"x86_64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine().lower(), platform.machine().lower())
    if host_os == "unsupported":
        raise RuntimeError("installer compatibility fixtures support only Linux and macOS journey runners")
    matrix = fixture_dir / f"compatibility-matrix-{host_os}-{host_arch}.json"
    missing_binary = fixture_dir / f"missing-host-binary-{host_os}-{host_arch}.json"
    scratch = platform_root.parent / "installer-case-fixtures"
    scratch.mkdir(parents=True, exist_ok=True)

    def strict_matrix_and_range() -> None:
        strict = run_command([launcher, "plan", "--json", "--index", str(matrix),
                              "--platform-version", "3.2.0", "--sdk-version", "3.2.0",
                              "--policy", "strict", "--platform-root", str(scratch / "strict-sdk")])
        _, error = _diagnostic(strict, "strict SDK matrix plan")
        meta = error.get("details", {})
        if strict.returncode == 0 or error.get("code") != "KB_INSTALL_INCOMPATIBLE_COMPONENTS" or not isinstance(meta, dict):
            raise RuntimeError("strict SDK plan did not return KB_INSTALL_INCOMPATIBLE_COMPONENTS")
        if any(meta.get(key) != value for key, value in (("kind", "sdk"), ("id", "sdk"),
                                                          ("selectedVersion", "3.2.0"),
                                                          ("requiredRange", ">=3.0.0 <4.0.0"),
                                                          ("policy", "strict"))):
            raise RuntimeError(f"strict SDK error details are incomplete: {meta}")
        if error.get("hint") != "Use an exact platform/SDK pair from the release matrix or choose --policy compatible.":
            raise RuntimeError("strict SDK refusal omitted its exact correction hint")
        compatible = _data(run_command([launcher, "plan", "--json", "--index", str(matrix),
                                        "--platform-version", "3.2.0", "--sdk-version", "3.2.0",
                                        "--policy", "compatible", "--platform-root", str(scratch / "compatible-sdk")]),
                           "compatible SDK matrix plan")
        if compatible.get("plan", {}).get("serviceGraph", {}).get("platformVersion") != "3.2.0":
            raise RuntimeError("compatible policy did not resolve the indexed SDK in the declared range")

    journey.step("compare strict and compatible SDK matrix selection", "platform.install", strict_matrix_and_range, cases=["S-053.2"])

    def incompatible_adapter() -> None:
        result = run_command([launcher, "plan", "--json", "--index", str(matrix),
                              "--platform-version", "3.2.0", "--sdk-version", "3.0.0",
                              "--adapters", "fixture-adapter@1.0.0", "--policy", "compatible",
                              "--platform-root", str(scratch / "adapter-range")])
        _, error = _diagnostic(result, "adapter range plan")
        meta = error.get("details", {})
        if result.returncode == 0 or error.get("code") != "KB_INSTALL_INCOMPATIBLE_COMPONENTS" or not isinstance(meta, dict):
            raise RuntimeError("out-of-range adapter plan did not return KB_INSTALL_INCOMPATIBLE_COMPONENTS")
        if (meta.get("kind") != "adapter" or meta.get("id") != "fixture-adapter"
                or meta.get("selectedVersion") != "3.2.0" or meta.get("requiredRange") != "<3.2.0"):
            raise RuntimeError(f"adapter range refusal omitted its component details: {meta}")
        if error.get("hint") != "Choose compatible versions or pass an explicit supported provider.":
            raise RuntimeError("adapter range refusal omitted its correction hint")
        if (scratch / "adapter-range").exists():
            raise RuntimeError("adapter range refusal changed the isolated install root")

    journey.step("refuse an adapter outside its platform range", "platform.install", incompatible_adapter, cases=["S-053.4"])

    def installed_component_update(kind: str, component: str, claim: str) -> None:
        root = scratch / f"{claim.replace('.', '-')}-root"
        with _installed_fixture(root, launcher=launcher, index=stable_index, run_command=run_command,
                                label=f"installed {kind} update fixture",
                                selection=("--plugins" if kind == "plugin" else "--adapters",
                                           f"{component}@1.0.0")) as receipt_path:
            def exclude_installed_component(current: bytes) -> bytes:
                receipt = json.loads(current)
                installed = next((item for item in receipt.get("plan", {}).get("artifacts", [])
                                  if item.get("kind") == kind and item.get("id") == component), None)
                if not isinstance(installed, dict):
                    raise RuntimeError(f"product install did not install {kind} {component}; refusing to fabricate its receipt")
                installed["platformRange"] = "<3.2.0"
                return (json.dumps(receipt, indent=2) + "\n").encode()

            receipt_path = installed_path(root, "currentLink", ".kb/v2/receipt.json")
            inject_existing_fault(root, "currentLink", exclude_installed_component, ".kb/v2/receipt.json")
            before_receipt = receipt_path.read_bytes()
            before_files = {str(path.relative_to(root)): path.read_bytes() for path in root.rglob("*") if path.is_file()}
            before_directories = {str(path.relative_to(root)) for path in root.rglob("*") if path.is_dir()}
            result = run_command([launcher, "update", "--json", "--index", str(matrix),
                                  "--platform-version", "3.2.0", "--sdk-version", "3.0.0",
                                  "--policy", "compatible", "--platform-root", str(root)])
            _, error = _diagnostic(result, "installed component update")
            meta = error.get("details", {})
            expected_code = "KB_UPDATE_INCOMPATIBLE"
            expected_hint = catalogued_error_hint(
                "KB_UPDATE_INCOMPATIBLE", kind=kind, id=component,
                selectedVersion="3.2.0", requiredRange="<3.2.0",
            )
            after_files = {str(path.relative_to(root)): path.read_bytes() for path in root.rglob("*") if path.is_file()}
            after_directories = {str(path.relative_to(root)) for path in root.rglob("*") if path.is_dir()}
            if result.returncode == 0 or error.get("code") != expected_code or not isinstance(meta, dict):
                raise RuntimeError(f"incompatible installed {kind} update did not return {expected_code}: {error}")
            if (meta.get("kind") != kind or meta.get("id") != component or meta.get("selectedVersion") != "3.2.0"
                    or meta.get("requiredRange") != "<3.2.0" or error.get("hint") != expected_hint):
                raise RuntimeError(f"installed {kind} refusal omitted its range or correction details: {error}")
            if (receipt_path.read_bytes() != before_receipt or before_files != after_files
                    or before_directories != after_directories):
                raise RuntimeError(f"incompatible {kind} update mutated the active receipt or install root")

    journey.step("refuse update beyond an installed plugin range", "platform.update", lambda: installed_component_update("plugin", "fixture-compat", "S-053.3"), cases=["S-053.3"])

    def sdk_and_binary_ranges() -> None:
        sdk_result = run_command([launcher, "plan", "--json", "--index", str(matrix),
                                  "--platform-version", "3.2.0", "--sdk-version", "4.0.0",
                                  "--policy", "compatible", "--platform-root", str(scratch / "sdk-outside-range")])
        _, sdk_error = _diagnostic(sdk_result, "out-of-range SDK plan")
        sdk_meta = sdk_error.get("details", {})
        if sdk_result.returncode == 0 or sdk_error.get("code") != "KB_INSTALL_INCOMPATIBLE_COMPONENTS" or not isinstance(sdk_meta, dict):
            raise RuntimeError("out-of-range SDK plan did not fail with the typed incompatibility")
        if (sdk_meta.get("kind") != "sdk" or sdk_meta.get("id") != "sdk"
                or sdk_meta.get("selectedVersion") != "4.0.0"
                or sdk_meta.get("requiredRange") != ">=3.0.0 <4.0.0"):
            raise RuntimeError(f"out-of-range SDK refusal omitted component, version, or range: {sdk_meta}")
        if not sdk_error.get("hint"):
            raise RuntimeError("out-of-range SDK refusal omitted its correction hint")
        binary_result = run_command([launcher, "plan", "--json", "--index", str(missing_binary),
                                     "--platform-version", "3.2.0", "--sdk-version", "3.0.0",
                                     "--policy", "compatible", "--platform-root", str(scratch / "missing-binary")])
        _, binary_error = _diagnostic(binary_result, "missing binary plan")
        binary_meta = binary_error.get("details", {})
        if binary_result.returncode == 0 or binary_error.get("code") != "KB_INSTALL_INCOMPATIBLE_COMPONENTS" or not isinstance(binary_meta, dict):
            raise RuntimeError("missing host binary plan did not fail with the typed incompatibility")
        if (binary_meta.get("kind") != "binary"
                or binary_meta.get("id") != "kb-create"
                or binary_meta.get("target") != f"{host_os}/{host_arch}"
                or not binary_error.get("hint")):
            raise RuntimeError(f"missing binary error omitted its binary identity, target, or hint: {binary_error}")

    journey.step("refuse an SDK outside range and a release missing the host binary", "platform.install", sdk_and_binary_ranges, cases=["S-053.5"])

    journey.step("refuse update beyond an installed adapter range", "platform.update", lambda: installed_component_update("adapter", "fixture-adapter", "S-053.6"), cases=["S-053.6"])

    def missing_host_binary_before_mutation() -> None:
        target = scratch / "missing-host-root"
        before_exists = target.exists()
        before = {str(path.relative_to(target)): path.read_bytes() for path in target.rglob("*") if path.is_file()} if target.exists() else {}
        before_directories = {str(path.relative_to(target)) for path in target.rglob("*") if path.is_dir()} if target.exists() else set()
        result = run_command([launcher, "plan", "--json", "--index", str(missing_binary),
                              "--platform-version", "3.2.0", "--sdk-version", "3.0.0",
                              "--policy", "compatible", "--platform-root", str(target)])
        _, error = _diagnostic(result, "missing host binary plan")
        meta = error.get("details", {})
        after = {str(path.relative_to(target)): path.read_bytes() for path in target.rglob("*") if path.is_file()} if target.exists() else {}
        after_directories = {str(path.relative_to(target)) for path in target.rglob("*") if path.is_dir()} if target.exists() else set()
        after_exists = target.exists()
        if result.returncode == 0 or error.get("code") != "KB_INSTALL_INCOMPATIBLE_COMPONENTS" or not isinstance(meta, dict):
            raise RuntimeError("missing host binary did not refuse planning with the typed incompatibility")
        if (meta.get("kind") != "binary"
                or meta.get("id") != "kb-create"
                or meta.get("target") != f"{host_os}/{host_arch}"
                or not error.get("hint")):
            raise RuntimeError("missing binary refusal omitted its kind/id, target, or correction hint")
        if before != after or before_directories != after_directories or before_exists != after_exists:
            raise RuntimeError("missing binary refusal changed the isolated install root")

    journey.step("refuse planning without the runner binary", "platform.install", missing_host_binary_before_mutation, cases=["S-053.7"])

    def incompatible_plugin_sdk_range() -> None:
        for label, platform_selection in (("explicit-version", ["--platform-version", "3.2.0"]),
                                          ("channel", ["--platform-channel", "stable"])):
            target = scratch / f"plugin-sdk-range-{label}"
            result = run_command([launcher, "plan", "--json", "--index", str(matrix),
                                  *platform_selection,
                                  "--plugins", "fixture-sdk-incompat@1.0.0", "--policy", "compatible",
                                  "--platform-root", str(target)])
            _, error = _diagnostic(result, f"plugin sdk-range plan selected by {label}")
            meta = error.get("details", {})
            if result.returncode == 0 or error.get("code") != "KB_INSTALL_INCOMPATIBLE_COMPONENTS" or not isinstance(meta, dict):
                raise RuntimeError(f"incompatible plugin SDK range did not refuse planning with the typed incompatibility: {error}")
            if (meta.get("kind") != "plugin" or meta.get("id") != "fixture-sdk-incompat"
                    or meta.get("selectedVersion") != "3.0.0" or meta.get("requiredRange") != "<3.0.0"):
                raise RuntimeError(f"plugin SDK range refusal omitted its component details: {meta}")
            if error.get("hint") != "Choose compatible versions or pass an explicit supported provider.":
                raise RuntimeError("plugin SDK range refusal omitted its correction hint")
            if target.exists():
                raise RuntimeError("plugin SDK range refusal changed the isolated install root")

    journey.step("refuse a plugin outside its channel-selected SDK range", "platform.install", incompatible_plugin_sdk_range, cases=["S-053.8"])

    def incompatible_plugin_request() -> None:
        result = run_command([launcher, "plan", "--json", "--index", str(matrix),
                              "--platform-version", "3.2.0", "--sdk-version", "3.0.0",
                              "--plugins", "fixture-plugin@1.0.0", "--policy", "strict",
                              "--platform-root", str(scratch / "plugin-request")])
        _, error = _diagnostic(result, "incompatible plugin request")
        if result.returncode == 0 or error.get("code") != "KB_INSTALL_INCOMPATIBLE_COMPONENTS" or "fixture-plugin" not in str(error):
            raise RuntimeError(f"strict incompatible plugin request was not refused: {error}")
        if not error.get("hint"):
            raise RuntimeError("strict incompatible plugin request omitted its correction hint")

    journey.step("refuse a strict incompatible plugin request before mutation", "platform.install", incompatible_plugin_request, cases=["S-181.5"])

    def doctor_finding(*, secret: bool = False) -> None:
        root = scratch / ("s025-secret" if secret else "s025-required")
        requirement = {"id": "fixture.required", "path": "/fixture/required", "required": True,
                       "secret": secret, "hint": "provide the fixture value"}
        with _installed_fixture(root, launcher=launcher, index=stable_index, run_command=run_command,
                                label="doctor required-input fixture") as receipt_path:
            _add_installed_manifest_requirement(root, requirement)
            result = run_command([launcher, "doctor", "--platform-root", str(root), "--json"])
            envelope, payload = _payload(result, "doctor required-input fixture")
            findings = payload.get("findings", [])
            finding = next((item for item in findings if isinstance(item, dict) and item.get("path") == "/fixture/required"), None)
            if (result.returncode != 0 or envelope.get("ok") is not True or payload.get("operation") != "doctor"
                    or payload.get("status") != "unhealthy" or not isinstance(finding, dict)):
                raise RuntimeError("doctor did not return an unhealthy report for the manifest-declared required input")
            if not finding.get("component") or not finding.get("code") or not finding.get("hint"):
                raise RuntimeError(f"doctor finding omitted component, code, or hint: {finding}")
            if not isinstance(payload.get("installation"), dict):
                raise RuntimeError("doctor unhealthy result omitted its structured installation report")
            if secret:
                if _fixture_contains_secret_material(root) or any(
                        value in result.stdout for value in ("fixture-secret-value", "fixture.required=value")):
                    raise RuntimeError("doctor output or isolated files serialized secret material or its value assignment")

    journey.step("diagnose a missing required non-secret config value", "platform.install", lambda: doctor_finding(), cases=["S-025.1"])
    journey.step("diagnose missing secret input without exposing a value", "platform.install", lambda: doctor_finding(secret=True), cases=["S-025.2"])

    def doctor_hostspec_invalid() -> None:
        root = scratch / "s025-hostspec-invalid"
        with _installed_fixture(root, launcher=launcher, index=stable_index, run_command=run_command,
                                label="doctor host-spec fixture") as receipt_path:
            def clear_installed_host_command(current: bytes) -> bytes:
                active = json.loads(current)
                active["plan"]["host"]["command"] = ""
                return (json.dumps(active, indent=2) + "\n").encode()

            receipt_path = installed_path(root, "currentLink", ".kb/v2/receipt.json")
            inject_existing_fault(root, "currentLink", clear_installed_host_command, ".kb/v2/receipt.json")
            result = run_command([launcher, "doctor", "--platform-root", str(root), "--json"])
            envelope, payload = _payload(result, "doctor host-spec mismatch")
            installation = payload.get("installation", {})
            checks = installation.get("checks", []) if isinstance(installation, dict) else []
            failed = [item for item in checks if isinstance(item, dict) and item.get("id") == "host-spec" and item.get("ok") is False]
            if (result.returncode != 0 or envelope.get("ok") is not True
                    or payload.get("operation") != "doctor" or payload.get("status") != "unhealthy"
                    or not failed or failed[0].get("code") != "KB_HOST_SPEC_INVALID"
                    or "command is required" not in str(failed[0].get("detail", ""))
                    or "kb-create apply --platform-root" not in str(failed[0].get("hint", ""))):
                raise RuntimeError("doctor did not report the invalid receipt host specification as an unhealthy diagnosis")

    journey.step("diagnose an invalid host specification from the active receipt", "platform.install", doctor_hostspec_invalid, cases=["S-025.3"])

    def doctor_safe_default() -> None:
        root = scratch / "s025-safe-default"
        requirement = {"id": "fixture.default", "path": "/fixture/default", "required": True,
                       "default": "\"manifest-safe-value\"", "hint": "safe default"}
        with _installed_fixture(root, launcher=launcher, index=stable_index, run_command=run_command,
                                label="doctor safe-default fixture") as receipt_path:
            _add_installed_manifest_requirement(root, requirement)
            result = run_command([launcher, "doctor", "--fix", "--platform-root", str(root), "--json"])
            payload = _data(result, "doctor safe-default repair")
            config = active_path(root, "sharedRuntimePaths.kb_kb_config_jsonc.platformPath").read_text()
            if payload.get("operation") != "doctor-fix" or not payload.get("snapshot", {}).get("id") or "hostRestarted" not in payload:
                raise RuntimeError("doctor --fix omitted operation, snapshot, or host restart result")
            if "manifest-safe-value" not in config:
                raise RuntimeError("doctor --fix did not write the manifest-declared safe default")

    journey.step("apply only a manifest-declared safe default", "platform.install", doctor_safe_default, cases=["S-025.4"])

    def doctor_required_input_after_projection_repair() -> None:
        root = scratch / "s025-required-after-fix"
        requirement = {"id": "fixture.secret", "path": "/fixture/secret", "required": True,
                       "secret": True, "hint": "supply the secret separately"}
        with _installed_fixture(root, launcher=launcher, index=stable_index, run_command=run_command,
                                label="doctor missing-projection fixture") as receipt_path:
            _add_installed_manifest_requirement(root, requirement)
            inject_existing_fault(
                root, "currentLink", lambda _current: None,
                layout_value("sharedRuntimePaths.kb_kb_config_jsonc.platformPath"))
            result = run_command([launcher, "doctor", "--fix", "--platform-root", str(root), "--json"])
            envelope, payload = _payload(result, "doctor fix unresolved input")
            repair = payload.get("repair", {})
            required = repair.get("requiredInput", []) if isinstance(repair, dict) else []
            if result.returncode != 0 or envelope.get("ok") is not True or not required:
                raise RuntimeError("doctor --fix did not preserve unresolved requiredInput in its result")
            if not any(item.get("path") == "/fixture/secret" for item in required if isinstance(item, dict)):
                raise RuntimeError(f"doctor --fix returned the wrong required-input finding: {required}")
            if payload.get("hostRestarted") is not False:
                raise RuntimeError("doctor --fix restarted the host while required input remains unresolved")
            host_status = _data(run_command([launcher, "status", "--platform-root", str(root), "--json"]),
                                "status after unresolved-input doctor repair")
            if host_status.get("host", {}).get(layout_value("sharedStateDirectory")) != "stopped":
                raise RuntimeError("doctor --fix did not keep the host stopped while required input remains unresolved")
            if "fixture-secret-value" in result.stdout:
                raise RuntimeError("doctor --fix serialized a secret value")

    journey.step("preserve unresolved user input in doctor-fix JSON", "platform.install", doctor_required_input_after_projection_repair, cases=["S-025.5"])

    def doctor_failure_dossier() -> None:
        root = scratch / "s025-failure"
        with _installed_fixture(root, launcher=launcher, index=stable_index, run_command=run_command,
                                label="doctor recovery-failure fixture"):
            result = run_command([launcher, "rollback", "--platform-root", str(root), "--snapshot",
                                  "fixture-missing-snapshot", "--yes", "--json"])
            envelope, error = _diagnostic(result, "rollback recovery failure")
            if result.returncode == 0 or envelope.get("ok") is not False:
                raise RuntimeError("rollback unexpectedly accepted a missing recovery snapshot")
            if not all(error.get(key) for key in ("code", "stage", "message", "hint")):
                raise RuntimeError(f"recovery error omitted structured diagnostics: {error}")
            details = error.get("details", {})
            if not details.get("logPath") or not details.get("diagnosticPath"):
                raise RuntimeError("recovery error omitted its log or diagnostic dossier path")
            dossier = Path(details["diagnosticPath"]).read_text()
            if "fixture-secret-value" in dossier:
                raise RuntimeError("diagnostic dossier serialized a secret value")

    journey.step("inspect structured recovery failure diagnostics", "platform.recovery", doctor_failure_dossier, cases=["S-025.6"])

    def install_with_project() -> None:
        root, project = scratch / "s187-with-project", scratch / "s187-project"
        project.mkdir(parents=True, exist_ok=True)
        before = set(project.iterdir())
        try:
            result = run_command([launcher, "install", "--index", str(stable_index),
                                  "--platform-root", str(root), "--project-root", str(project)])
            canonical = str(project.resolve())
            if (result.returncode != 0 or "Verification: platform installed at" not in result.stdout
                    or canonical not in result.stdout or not (active_platform_root(root) / ".kb/v2/receipt.json").is_file()):
                raise RuntimeError("non-interactive install did not verify and register the canonical project path")
            if set(project.iterdir()) != before:
                raise RuntimeError("project registration wrote KB Labs files into the project repository")
        finally:
            cleanup_installer_fixture_root(root, launcher, run_command)

    journey.step("install non-interactively and register a project", "platform.install", install_with_project, cases=["S-187.4"])

    def install_without_project() -> None:
        root = scratch / "s187-no-project"
        try:
            result = run_command([launcher, "install", "--index", str(stable_index), "--platform-root", str(root)])
            if result.returncode != 0 or not _hint_has_argv(result.stdout, kb_command([ "project", "add", "<path>"])):
                raise RuntimeError("install without a project omitted the exact `kb project add <path>` next step")
            receipt = json.loads((active_platform_root(root) / ".kb/v2/receipt.json").read_text())
            if receipt.get("project") or receipt.get("projects"):
                raise RuntimeError("install without a project unexpectedly registered one")
        finally:
            cleanup_installer_fixture_root(root, launcher, run_command)

    journey.step("install without a project and print its registration command", "platform.install", install_without_project, cases=["S-187.5"])

    json_install_journey = run_json_install_project_step(
        mode=mode, launcher=launcher, stable_index=stable_index,
        platform_root=scratch / "s187-json-with-project",
        project_root=scratch / "s187-json-project", run_command=run_command)
    journey.steps.extend(json_install_journey.steps)

    shutil.rmtree(scratch, ignore_errors=True)
    return journey


def run_doctor_root_isolation_step(*, mode: str, launcher: str, stable_index: Path,
                                   platform_root: Path, run_command: CommandRunner) -> Journey:
    """Prove the per-user launcher never controls a different platform root."""
    journey = Journey(mode, f"doctor-root-isolation-{mode}")
    root = platform_root.parent / "installer-case-fixtures" / "s025-root-isolation"
    main_receipt = json.loads((platform_root / layout_relative('currentLink', '.kb/v2/receipt.json')).read_text())
    main_receipt_id = main_receipt.get("id")

    def repair_fixture_without_stopping_main() -> None:
        requirement = {"id": "fixture.default", "path": "/fixture/default", "required": True,
                       "default": "\"manifest-safe-value\"", "hint": "safe default"}
        lifecycle = InstallerHostLifecycle(launcher, run_command)
        with lifecycle.preserve([platform_root]) as initial:
            if not initial[platform_root]:
                lifecycle.set_running(platform_root, True)
            action_error: Exception | None = None
            try:
                isolated_gateway = unused_loopback_gateway_url()
                _seed_installed_fixture(root, launcher=launcher, index=stable_index,
                                         run_command=run_command, label="isolated-root doctor fixture",
                                         gateway_url=isolated_gateway)
                _add_installed_manifest_requirement(root, requirement)
                stop_installer_fixture_host(root, launcher, run_command)
                result = run_command([launcher, "doctor", "--fix", "--platform-root", str(root), "--json"])
                payload = _data(result, "isolated-root doctor repair")
                if payload.get("hostRestarted") is not False:
                    raise RuntimeError("doctor --fix treated another platform root's host as the fixture host")
                fixture_status = _data(run_command([launcher, "status", "--platform-root", str(root), "--json"]),
                                       "isolated platform status")
                if fixture_status.get("host", {}).get(layout_value('sharedStateDirectory')) != "stopped":
                    raise RuntimeError("status for platform B did not report its stopped host")
                main_status = _data(run_command([launcher, "status", "--platform-root", str(platform_root), "--json"]),
                                    "main platform status after isolated-root repair")
                if main_status.get("host", {}).get(layout_value('sharedStateDirectory')) != "running":
                    raise RuntimeError("repairing an isolated root stopped or replaced the main platform host")
                for spelling in (platform_root, platform_root / layout_value('currentLink'), (platform_root / layout_value('currentLink')).resolve()):
                    spelling_status = _data(run_command([launcher, "status", "--platform-root", str(spelling), "--json"]),
                                            f"main platform status through {spelling}")
                    if (spelling_status.get("host", {}).get(layout_value('sharedStateDirectory')) != "running"
                            or spelling_status.get("installation", {}).get("receiptId") != main_receipt_id):
                        raise RuntimeError(f"status through {spelling} did not identify platform A's original running host")
            except Exception as error:
                action_error = error
            try:
                cleanup_installer_fixture_root(root, launcher, run_command)
            except Exception as cleanup_error:
                if action_error is not None:
                    raise RuntimeError(f"{action_error}; fixture cleanup failed: {cleanup_error}") from action_error
                raise
            if action_error is not None:
                raise action_error

    journey.step("repair an isolated root without stopping the running platform", "platform.install",
                 repair_fixture_without_stopping_main, cases=["S-025.7"])

    def refuse_start_for_other_root() -> None:
        try:
            cleanup_installer_fixture_root(root, launcher, run_command)
            gateway_health = main_receipt.get("verification", {}).get("hostHealthUrl", "")
            gateway = urlsplit(gateway_health)
            if not gateway.scheme or not gateway.netloc:
                raise RuntimeError("platform A's active receipt omitted its Gateway health URL")
            main_gateway_url = f"{gateway.scheme}://{gateway.netloc}"
            _seed_installed_fixture(root, launcher=launcher, index=stable_index,
                                    run_command=run_command, label="cross-root start fixture",
                                    gateway_url=main_gateway_url)
            stop_installer_fixture_host(root, launcher, run_command)
            lifecycle = InstallerHostLifecycle(launcher, run_command)
            with lifecycle.preserve([platform_root]) as initial:
                if not initial[platform_root]:
                    lifecycle.set_running(platform_root, True)
                result = run_command([launcher, "start", "--platform-root", str(root), "--json"])
                envelope, error = _diagnostic(result, "cross-root host start")
                details = error.get("meta", error.get("details", {}))
                hint = error.get("hint", "")
                commands = re.findall(r"`([^`]+)`", hint)
                stop_argv = shlex.split(commands[0]) if commands else []
                expected_stop = ["kb-create", "stop", "--platform-root", str(platform_root.resolve())]
                if (result.returncode == 0 or envelope.get("ok") is not False
                        or error.get("code") != "KB_HOST_ALREADY_RUNNING"
                        or str(platform_root.resolve()) not in error.get("message", "")
                        or not isinstance(details, dict) or not details.get("pid")
                        or stop_argv != expected_stop):
                    raise RuntimeError(f"cross-root start did not identify the active platform and runnable stop command: {error}")
                stopped = run_command(stop_argv + ["--json"])
                _data(stopped, "execute printed cross-root stop command")
                main_status = _data(run_command([launcher, "status", "--platform-root", str(platform_root), "--json"]),
                                    "main status after suggested stop command")
                if main_status.get("host", {}).get(layout_value('sharedStateDirectory')) != "stopped":
                    raise RuntimeError("executing the printed stop command did not stop platform A")
        finally:
            action_error = sys.exc_info()[1]
            try:
                cleanup_installer_fixture_root(root, launcher, run_command)
            except Exception as cleanup_error:
                if action_error is not None:
                    raise RuntimeError(f"{action_error}; fixture cleanup failed: {cleanup_error}") from action_error
                raise

    journey.step("refuse to start a second platform while the user's host is running", "platform.install",
                 refuse_start_for_other_root, cases=["S-025.8"])
    return journey
