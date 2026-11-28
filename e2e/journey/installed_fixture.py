"""Single owner for product-created installed-root fixtures and controlled damage."""
from __future__ import annotations

import json
import os
import shutil
import socket
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Iterator, Mapping, Optional

from journey_resources import config_parser_source_path, workspace_resource

if TYPE_CHECKING:
    from invocations import CompletedProcess


PathTransform = Callable[[bytes], Optional[bytes]]


def _layout() -> dict:
    source = workspace_resource("tools", "kb-create", "v2", "contracts", "platform-layout.json")
    value = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("platform layout contract is not an object")
    return value


def _path_slug(value: str) -> str:
    return "_".join(part.strip(".").replace(".", "_") for part in Path(value).parts)


def _layout_path_values() -> dict[str, str]:
    contract = _layout()
    paths = {
        "currentLink": contract["currentLink"],
        "versionRoots.path": contract["versionRoots"]["path"],
        "sharedStateDirectory": contract["sharedStateDirectory"],
        "kbHomeDirectory": contract["kbHomeDirectory"],
        "installerStateDirectory": contract["installerStateDirectory"],
        "hostStateDirectory": contract["hostStateDirectory"],
        "hostLogFiles.residue": contract["hostLogFiles"]["residue"],
        "hostLogFiles.structured": contract["hostLogFiles"]["structured"],
        "ownershipRecord": contract["ownershipRecord"],
        "ownershipRecordStagingPrefix": contract["ownershipRecordStagingPrefix"],
        "platformDataRoot.platformPath": contract["platformDataRoot"]["platformPath"],
        "platformDataRoot.statePath": contract["platformDataRoot"]["statePath"],
        "packageManagerStateDirectories.installer.path":
            contract["packageManagerStateDirectories"]["installer"]["path"],
    }
    for projection in contract["sharedRuntimePaths"]:
        slug = _path_slug(projection["platformPath"])
        for field in ("platformPath", "statePath"):
            identity = f"sharedRuntimePaths.{slug}.{field}"
            if identity in paths:
                raise ValueError(f"platform layout has ambiguous path identity {identity!r}")
            paths[identity] = projection[field]
    for value in contract["runtimeStatePaths"]:
        slug = _path_slug(value)
        identity = f"runtimeStatePaths.{slug}"
        if identity in paths:
            raise ValueError(f"platform layout has ambiguous path identity {identity!r}")
        paths[identity] = value
    for entry in contract["versionStatePaths"]:
        value = entry["path"]
        if not isinstance(value, str) or not value:
            raise ValueError("platform layout version-state path omits its path")
        slug = _path_slug(value)
        identity = f"versionStatePaths.{slug}"
        if identity in paths:
            raise ValueError(f"platform layout has ambiguous path identity {identity!r}")
        paths[identity] = value
    paths.update({f"installerRecords.{name}": value
                  for name, value in contract["installerRecords"].items() if isinstance(value, str)})
    return paths


def _identity_value(identity: str) -> str:
    try:
        return _layout_path_values()[identity]
    except KeyError as error:
        raise ValueError(f"platform layout identity {identity!r} does not name a declared path") from error


def layout_value(identity: str) -> str:
    """Read one relative path value by its platform-layout.json identity."""
    return _identity_value(identity)


def layout_relative(identity: str, suffix: str) -> str:
    """Resolve a child spelling beneath a layout-owned path identity."""
    base = Path(_identity_value(identity))
    child = Path(suffix)
    if child.is_absolute() or ".." in child.parts:
        raise ValueError(f"path suffix escapes layout identity {identity!r}")
    return str(base / child)


def unused_loopback_gateway_url() -> str:
    """Select a currently unused loopback port for an isolated product fixture."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return f"http://127.0.0.1:{probe.getsockname()[1]}"


def installed_path(root: Path, identity: str, *suffix: str) -> Path:
    """Resolve an installed path from a layout identity and optional children."""
    path = Path(root) / _identity_value(identity)
    for part in suffix:
        child = Path(part)
        if child.is_absolute() or ".." in child.parts:
            raise ValueError(f"path suffix escapes layout identity {identity!r}")
        path /= child
    return path


def preserved_user_state_files(root: Path) -> tuple[Path, ...]:
    """Return every file the platform layout declares as preserved user state."""
    contract = _layout()
    files = []
    for projection in contract["sharedRuntimePaths"]:
        if projection.get("preserveUserState") is not True or projection.get("kind") != "file":
            continue
        files.append(installed_path(root, "currentLink", projection["platformPath"]))
    for entry in contract["versionStatePaths"]:
        if entry.get("preserveUserState") is not True or entry.get("kind") != "file":
            continue
        files.append(installed_path(root, "currentLink", entry["path"]))
    return tuple(files)


def active_path(root: Path, identity: str, *suffix: str) -> Path:
    """Resolve a platform content path inside the product-selected version."""
    return installed_path(active_platform_root(root), identity, *suffix)


def active_platform_root(root: Path) -> Path:
    """Resolve the active product-created version from declared layout links."""
    root = Path(root)
    current = installed_path(root, "currentLink")
    versions = installed_path(root, "versionRoots.path")
    if not current.is_symlink():
        if not root.exists() or (root.is_dir() and not any(root.iterdir())):
            raise FileNotFoundError(f"no installed platform at {root}")
        raise ValueError(f"unsupported platform layout at {root}: current is not a symlink")
    target = current.readlink()
    if target.is_absolute():
        raise ValueError(f"unsupported platform layout at {root}: current link is not relative")
    try:
        active = current.resolve(strict=True)
        active.relative_to(versions.resolve(strict=True))
    except (OSError, ValueError) as error:
        raise ValueError(f"unsupported platform layout at {root}: current does not select a complete version") from error
    if not active.is_dir():
        raise ValueError(f"unsupported platform layout at {root}: current does not select a directory")
    return active


def _mutate_existing_target(target: Path, transform: PathTransform, identity: str) -> Path:
    try:
        before = target.read_bytes()
    except FileNotFoundError as error:
        raise RuntimeError(f"fixture fault target was not created by product install: {target}") from error
    after = transform(before)
    if after is None:
        target.unlink()
    else:
        target.write_bytes(after)
    return target


def inject_existing_fault(root: Path, identity: str, transform: PathTransform, *suffix: str) -> Path:
    """Mutate or remove an existing product-created file; never create a target."""
    return _mutate_existing_target(installed_path(root, identity, *suffix), transform, identity)


def inject_existing_version_fault(root: Path, identity: str, transform: PathTransform,
                                 *suffix: str) -> Path:
    """Mutate or remove an existing file inside the product-created active version."""
    target = active_platform_root(root) / _identity_value(identity)
    for part in suffix:
        child = Path(part)
        if child.is_absolute() or ".." in child.parts:
            raise ValueError(f"path suffix escapes layout identity {identity!r}")
        target /= child
    return _mutate_existing_target(target, transform, identity)


def write_local_access_mode(platform_root: Path, source_config: Path | None = None) -> Path:
    """Create a platform config fixture with explicit local access mode."""
    config_path = Path(platform_root) / ".kb" / "kb.config.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    if source_config is None:
        config = {"gateway": {"access": {"mode": "local"}}}
    else:
        from invocations import run_command

        workspace_root = Path(__file__).resolve().parents[2]
        for source in workspace_root.iterdir():
            if source.name in {".git", ".kb", "node_modules"}:
                continue
            destination = Path(platform_root) / source.name
            if not destination.exists() and not destination.is_symlink():
                destination.symlink_to(source, target_is_directory=source.is_dir())
        modules_link = Path(platform_root) / "node_modules"
        if modules_link.is_symlink():
            modules_link.unlink()
        if not modules_link.exists():
            modules_link.symlink_to(
                workspace_root / "node_modules" / ".pnpm" / "node_modules", target_is_directory=True)
        parser_module = config_parser_source_path().as_uri()
        script = (
            "import { readFileSync, writeFileSync } from 'node:fs'; "
            "const { parseJsonc } = await import(process.argv[1]); "
            "const config = parseJsonc(readFileSync(process.argv[2], 'utf8')); "
            "config.gateway ??= {}; config.gateway.access ??= {}; "
            "config.gateway.access.mode = 'local'; "
            "writeFileSync(process.argv[3], JSON.stringify(config));"
        )
        result = run_command(
            ["node", "--input-type=module", "-e", script, parser_module, str(source_config), str(config_path)],
            cwd=workspace_root, timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError(f"could not create local-mode config fixture: {result.stderr or result.stdout}")
        return Path(platform_root)
    config_path.write_text(json.dumps(config), encoding="utf-8")
    return Path(platform_root)


def _stage_workspace_node_modules(platform_root: Path, workspace_root: Path,
                                  installed_platform_root: Path) -> None:
    """Stage private module links, sourcing platform adapters from the active install."""
    destination_root = platform_root / "node_modules"
    if destination_root.is_symlink():
        destination_root.unlink()
    elif destination_root.exists() and not destination_root.is_dir():
        raise RuntimeError("hermetic platform node_modules fixture is not a directory")
    destination_root.mkdir(parents=True, exist_ok=True)

    destination_scope = destination_root / "@kb-labs"
    for source_root in (workspace_root / "node_modules" / ".pnpm" / "node_modules",
                        workspace_root / "node_modules"):
        if not source_root.is_dir():
            continue
        for source in source_root.iterdir():
            if source.name in {".bin", ".pnpm"}:
                continue
            if source.name.startswith("@") and source.is_dir():
                scope = destination_root / source.name
                scope.mkdir(parents=True, exist_ok=True)
                for package in source.iterdir():
                    target = scope / package.name
                    if not target.exists() and not target.is_symlink():
                        target.symlink_to(package, target_is_directory=True)
            else:
                target = destination_root / source.name
                if not target.exists() and not target.is_symlink():
                    target.symlink_to(source, target_is_directory=True)

    installed_scope = installed_platform_root / "node_modules" / "@kb-labs"
    provenance_path = installed_platform_root / ".kb" / "v2" / "installed-provenance.json"
    try:
        provenance_value = json.loads(provenance_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("active platform adapter provenance is unavailable") from error
    provenance = provenance_value.get("packages") if isinstance(provenance_value, dict) else None
    if not isinstance(provenance, list):
        raise RuntimeError("active platform adapter provenance is invalid")
    installed_packages = {
        package.get("name"): package for package in provenance
        if isinstance(package, dict) and isinstance(package.get("name"), str)
    }
    destination_scope.mkdir(parents=True, exist_ok=True)
    if not installed_scope.is_dir():
        raise RuntimeError("active platform adapter package directory is unavailable")
    for source in installed_scope.iterdir():
        name = source.name
        if not name.startswith("adapters-"):
            continue
        package_name = f"@kb-labs/{name}"
        record = installed_packages.get(package_name)
        package_path = source / "package.json"
        try:
            package_manifest = json.loads(package_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"active platform adapter {package_name} is incomplete") from error
        expected_path = f"node_modules/@kb-labs/{name}"
        if (not isinstance(record, dict) or record.get("installedPath") != expected_path
                or record.get("version") != package_manifest.get("version")
                or package_manifest.get("name") != package_name):
            raise RuntimeError(f"active platform adapter {package_name} does not match installed provenance")
        target = destination_scope / name
        if target.is_symlink():
            target.unlink()
        elif target.exists():
            raise RuntimeError(f"hermetic adapter target {package_name} is not a managed link")
        target.symlink_to(source, target_is_directory=True)


def _merge_installed_platform_adapters(platform_root: Path, workspace_lock_path: Path,
                                        installed_platform_root: Path) -> None:
    """Use active-install adapter records while retaining workspace plugin entries."""
    installed_lock_path = installed_platform_root / layout_value("versionStatePaths.kb_marketplace_lock")
    try:
        workspace_lock = json.loads(workspace_lock_path.read_text(encoding="utf-8"))
        installed_lock = json.loads(installed_lock_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("workspace or active platform marketplace lock is unavailable") from error
    if not isinstance(workspace_lock, dict) or not isinstance(installed_lock, dict):
        raise RuntimeError("workspace or active platform marketplace lock is invalid")
    adapters = installed_lock.get("adapters")
    if not isinstance(adapters, dict):
        raise RuntimeError("active platform marketplace lock has no adapter entries")

    staged_adapters: dict[str, dict] = {}
    for adapter_id, entry in adapters.items():
        if not isinstance(adapter_id, str) or not isinstance(entry, dict):
            raise RuntimeError("active platform marketplace adapter entry is invalid")
        resolved_path = entry.get("resolvedPath")
        if not isinstance(resolved_path, str) or not resolved_path:
            raise RuntimeError(f"active platform adapter {adapter_id} has no resolved package path")
        relative_path = Path(resolved_path)
        if (relative_path.is_absolute() or ".." in relative_path.parts
                or len(relative_path.parts) != 3 or relative_path.parts[:2] != ("node_modules", "@kb-labs")
                or not relative_path.parts[2].startswith("adapters-")):
            raise RuntimeError(f"active platform adapter {adapter_id} does not resolve to an installed adapter package")
        package_root = platform_root / relative_path
        try:
            manifest = json.loads((package_root / "package.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"staged active platform adapter {adapter_id} is unavailable") from error
        package_name = manifest.get("name") if isinstance(manifest, dict) else None
        package_version = manifest.get("version") if isinstance(manifest, dict) else None
        expected_name = f"@kb-labs/{relative_path.parts[2]}"
        if (package_name != expected_name or not isinstance(package_version, str)
                or entry.get("version") != package_version):
            raise RuntimeError(f"staged active platform adapter {adapter_id} has an invalid package manifest")
        staged_adapters[adapter_id] = entry

    workspace_lock["adapters"] = staged_adapters
    workspace_lock_path.write_text(json.dumps(workspace_lock, indent=2) + "\n", encoding="utf-8")


def configure_hermetic_cli_fixture(
    home: Path,
    *,
    env: Mapping[str, str] | None = None,
    workspace_root: Path | None = None,
    installed_platform_root: Path | None = None,
    source_config: Path | None = None,
    platform_root: Path | None = None,
) -> dict[str, str]:
    """Own isolated CLI HOME, platform config, and optional workspace lock roots."""
    home = Path(home)
    home.mkdir(parents=True, exist_ok=True)
    fixture_env = dict(os.environ if env is None else env)
    for key in ("KB_PLATFORM_ROOT", "KB_PROJECT_ROOT", "KB_HOME", "KB_NET_OFFSET", "FORCE_COLOR"):
        fixture_env.pop(key, None)

    fixture_env["HOME"] = str(home)
    kb_home = home / ".kb"
    fixture_env["KB_HOME"] = str(kb_home)

    root = Path(platform_root) if platform_root is not None else home / "platform"
    if workspace_root is not None:
        workspace_root = Path(workspace_root).resolve()
        if source_config is None:
            candidate_config = workspace_root / layout_value(
                "sharedRuntimePaths.kb_kb_config_jsonc.platformPath")
            if candidate_config.is_file():
                source_config = candidate_config

    root = write_local_access_mode(root, source_config)
    if workspace_root is not None and installed_platform_root is not None:
        _stage_workspace_node_modules(root, workspace_root, Path(installed_platform_root).resolve())
    fixture_env["KB_PLATFORM_ROOT"] = str(root)

    if workspace_root is not None:
        relative_lock = layout_value("versionStatePaths.kb_marketplace_lock")
        source_lock = workspace_root / relative_lock
        destination_lock = root / relative_lock
        if source_lock.resolve() != destination_lock.resolve():
            destination_lock.parent.mkdir(parents=True, exist_ok=True)
            if source_lock.is_file():
                shutil.copy2(source_lock, destination_lock)
            else:
                destination_lock.write_text(json.dumps({"schema": "kb.marketplace/3", "plugins": {}}),
                                            encoding="utf-8")
        if installed_platform_root is not None:
            _merge_installed_platform_adapters(
                root, destination_lock, Path(installed_platform_root).resolve())
        plugin_root = root / "plugins"
        source_plugins = workspace_root / "plugins"
        # In a staged workspace checkout the platform root and workspace root
        # are the same directory. Keep its existing plugins link in that case;
        # unlinking it and linking the path back to itself creates an ELOOP.
        same_plugins_path = plugin_root.absolute() == source_plugins.absolute()
        if not same_plugins_path:
            try:
                same_plugins_path = plugin_root.resolve() == source_plugins.resolve()
            except (OSError, RuntimeError):
                # A pre-existing bad link is repaired by the normal replacement
                # below; do not let its resolution failure mask the setup error.
                pass
        if not same_plugins_path:
            if plugin_root.is_symlink():
                plugin_root.unlink()
            if not plugin_root.exists():
                plugin_root.symlink_to(source_plugins, target_is_directory=True)
        journey_root = root / "e2e"
        journey_source = workspace_root / "e2e"
        if journey_source.is_symlink():
            journey_source = journey_source.resolve()
        if journey_root.is_symlink():
            journey_root.unlink()
        if not journey_root.exists() and journey_source.is_dir():
            shutil.copytree(journey_source, journey_root, symlinks=True)
        fixture_env["KB_PROJECT_ROOT"] = str(root)

    return fixture_env


def install_fixture_root(root: Path, *, launcher: str, index: Path, run_command: Callable[..., CompletedProcess],
                         label: str, selection: tuple[str, str] | None = None,
                         gateway_url: str | None = None) -> Path:
    """Obtain a complete installation only through the product installer."""
    args = [launcher, "install", "--json", "--index", str(index), "--platform-root", str(root),
            "--service-profile", "default", "--scenario", "explore",
            "--secret-env", "gateway.bootstrap.password=KB_JOURNEY_ADMIN_PASSWORD"]
    if selection:
        args.extend(selection)
    if gateway_url:
        args.extend(("--gateway-url", gateway_url))
    result = run_command(args)
    if result.returncode != 0:
        raise RuntimeError(f"{label}: product install exited {result.returncode}")
    receipt_path = installed_path(root, "currentLink", ".kb/v2/receipt.json")
    if not receipt_path.is_file():
        raise RuntimeError(f"{label}: product install omitted its active receipt")
    return receipt_path



def add_installed_manifest_requirement(root: Path, requirement: dict) -> None:
    """Inject one diagnostic requirement into product-created receipt and manifest files."""
    receipt_identity = "currentLink"
    receipt_suffix = (".kb/v2/receipt.json",)
    receipt_path = installed_path(root, receipt_identity, *receipt_suffix)
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    artifacts = receipt.get("plan", {}).get("artifacts", [])
    selected = next((item for item in artifacts if item.get("kind") != "binary" and item.get("package")), None)
    if not isinstance(selected, dict):
        raise RuntimeError("product-installed fixture has no package artifact for a manifest requirement")
    manifest_suffix = ("node_modules", selected["package"], "kb-create.manifest.json")
    manifest_path = installed_path(root, receipt_identity, *manifest_suffix)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    receipt_requirements = list(selected.get("config", []))
    manifest_requirements = list(manifest.get("requirements", []))
    if requirement in receipt_requirements or requirement in manifest_requirements:
        raise RuntimeError("manifest requirement fixture was already present before its fault injection")
    selected["config"] = [*receipt_requirements, requirement]
    manifest["requirements"] = [*manifest_requirements, requirement]
    inject_existing_fault(root, receipt_identity,
                          lambda _current: (json.dumps(manifest) + "\n").encode(), *manifest_suffix)
    inject_existing_fault(root, receipt_identity,
                          lambda _current: (json.dumps(receipt, indent=2) + "\n").encode(), *receipt_suffix)


def stop_fixture_host(root: Path, launcher: str, run_command: Callable[..., CompletedProcess]) -> None:
    from platform_update_steps import _json_command

    receipt_path = installed_path(root, "currentLink", ".kb/v2/receipt.json")
    if receipt_path.is_file():
        status = _json_command(run_command, [launcher, "status", "--platform-root", str(root), "--json"],
                               f"host lifecycle status for {root}")
        if status.get("host", {}).get("state") == "running":
            _json_command(run_command, [launcher, "stop", "--platform-root", str(root), "--json"],
                          f"stop fixture host for {root}")


def cleanup_fixture_root(root: Path, launcher: str, run_command: Callable[..., CompletedProcess]) -> None:
    """Uninstall a product-created fixture, then remove its enclosing temp root."""
    from platform_update_steps import _json_command

    primary_error = sys.exc_info()[1]
    try:
        stop_fixture_host(root, launcher, run_command)
        if installed_path(root, "currentLink", ".kb/v2/receipt.json").is_file():
            _json_command(run_command, [launcher, "uninstall", "--platform-root", str(root), "--yes", "--json"],
                          f"uninstall installer fixture root {root}")
        if root.exists() or root.is_symlink():
            shutil.rmtree(root)
    except BaseException as cleanup_error:
        if primary_error is None:
            raise
        primary_error.args = (f"{primary_error}; fixture cleanup also failed: {cleanup_error}",)


@contextmanager
def installed_fixture(root: Path, *, launcher: str, index: Path,
                      run_command: Callable[..., CompletedProcess], label: str,
                      selection: tuple[str, str] | None = None) -> Iterator[Path]:
    try:
        receipt_path = install_fixture_root(root, launcher=launcher, index=index,
                                            run_command=run_command, label=label, selection=selection)
        yield receipt_path
    except BaseException:
        cleanup_fixture_root(root, launcher, run_command)
        raise
    else:
        cleanup_fixture_root(root, launcher, run_command)
