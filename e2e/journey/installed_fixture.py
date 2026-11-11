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
        "installerStateDirectory": contract["installerStateDirectory"],
        "hostStateDirectory": contract["hostStateDirectory"],
        "ownershipRecord": contract["ownershipRecord"],
        "ownershipRecordStagingPrefix": contract["ownershipRecordStagingPrefix"],
        "platformDataRoot.platformPath": contract["platformDataRoot"]["platformPath"],
        "platformDataRoot.statePath": contract["platformDataRoot"]["statePath"],
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


def configure_hermetic_cli_fixture(
    home: Path,
    *,
    env: Mapping[str, str] | None = None,
    workspace_root: Path | None = None,
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
            source_config = workspace_root / layout_value(
                "sharedRuntimePaths.kb_kb_config_jsonc.platformPath")

    root = write_local_access_mode(root, source_config)
    fixture_env["KB_PLATFORM_ROOT"] = str(root)

    if workspace_root is not None:
        relative_lock = layout_value("versionStatePaths.kb_marketplace_lock")
        source_lock = workspace_root / relative_lock
        destination_lock = root / relative_lock
        if source_lock.resolve() != destination_lock.resolve():
            destination_lock.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_lock, destination_lock)
        journey_root = root / "e2e"
        journey_source = workspace_root / "e2e"
        if journey_source.is_symlink():
            journey_source = journey_source.resolve()
        if journey_root.is_symlink():
            journey_root.unlink()
        if not journey_root.exists():
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
