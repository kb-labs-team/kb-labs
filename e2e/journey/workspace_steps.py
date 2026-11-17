from __future__ import annotations

from installed_fixture import configure_hermetic_cli_fixture, layout_relative, layout_value
from marketplace_sync_fixture import start_marketplace_sync_fixture, stop_marketplace_sync_fixture

import json
import os
import platform
import shutil
import struct
import sys
import tempfile
from pathlib import Path

from service_steps import Journey
from devkit_cache_steps import run_devkit_cache_steps
from invocations import (
    CompletedProcess,
    TimeoutExpired,
    decode_ux_error_result,
    decode_ux_success_result,
    invocation_context,
    read_ux_cli_result,
    run_command,
    run_harness_command,
)


def workspace_checkout_problem(repo_root: Path) -> str | None:
    required = (
        "cli/bin/dist/bin.js",
        "core/project-registry/dist/index.js",
        "plugins/marketplace-registry/dist/manifest.js",
        "plugins/marketplace-registry/dist/commands/publish.js",
        layout_value('versionStatePaths.kb_marketplace_lock'),
        "plugins",
    )
    missing = [path for path in required if not (repo_root / path).exists()]
    lock_path = repo_root / layout_value('versionStatePaths.kb_marketplace_lock')
    if lock_path.is_file():
        try:
            lock = json.loads(lock_path.read_text(encoding="utf-8"))
            for plugin in lock.get("plugins", {}).values():
                relative_root = plugin.get("link")
                if not isinstance(relative_root, str):
                    continue
                package_root = repo_root / relative_root
                package_json = package_root / "package.json"
                try:
                    manifest_path = json.loads(package_json.read_text(encoding="utf-8")).get("kb", {}).get("manifest")
                except (OSError, json.JSONDecodeError, AttributeError):
                    missing.append(f"{relative_root}/package.json")
                    continue
                if isinstance(manifest_path, str) and not (package_root / manifest_path).is_file():
                    missing.append(f"{relative_root}/{manifest_path.removeprefix('./')}")
        except (OSError, json.JSONDecodeError, AttributeError):
            missing.append(".kb/marketplace.lock (valid workspace plugin registry)")
    if missing:
        return (
            f"workspace checkout {repo_root} is missing {', '.join(missing)}; "
            "stage the repository at KB_JOURNEY_WORKSPACE_ROOT and run "
            "`kb-devkit run build --affected` before the journey"
        )
    return None


def _stage_workspace_checkout(repo_root: Path, stage_root: Path) -> Path:
    """Stage a writable workspace root whose platform and registered project identities coincide."""
    stage_root.mkdir(parents=True)
    for entry in repo_root.iterdir():
        if entry.name in {".git", ".kb", "node_modules"}:
            continue
        (stage_root / entry.name).symlink_to(entry, target_is_directory=entry.is_dir())
    staged_kb = stage_root / ".kb"
    staged_kb.mkdir()
    shutil.copy2(repo_root / ".kb" / "marketplace.lock", staged_kb / "marketplace.lock")
    (staged_kb / "kb.config.jsonc").symlink_to(repo_root / ".kb" / "kb.config.jsonc")
    return stage_root


DEVKIT_ZONE_CLAIMS = ("S-179.50", "S-179.51", "S-179.52")


def devkit_binary_problem(binary: Path) -> str | None:
    """Fail closed when the journey image cannot execute the candidate DevKit binary."""
    if not binary.is_file():
        return f"BLOCKED: candidate kb-devkit binary is missing at {binary}; restore the devkit-cli artifact"
    if not os.access(binary, os.X_OK):
        return f"BLOCKED: candidate kb-devkit binary is not executable at {binary}; chmod it after artifact download"
    try:
        data = binary.read_bytes()[:64]
        if sys.platform.startswith("linux"):
            if data[:4] != b"\x7fELF" or len(data) < 20 or data[5] not in (1, 2):
                return f"BLOCKED: candidate kb-devkit is not a supported Linux ELF binary: {binary}"
            endian = "<" if data[5] == 1 else ">"
            machine_code = struct.unpack_from(endian + "H", data, 18)[0]
            expected = {62: "x86_64", 183: "aarch64"}.get(machine_code)
        elif sys.platform == "darwin":
            if data[:4] == b"\xcf\xfa\xed\xfe":
                endian = "<"
            elif data[:4] == b"\xfe\xed\xfa\xcf":
                endian = ">"
            else:
                return f"BLOCKED: candidate kb-devkit is not a supported Darwin Mach-O binary: {binary}"
            machine_code = struct.unpack_from(endian + "I", data, 4)[0]
            expected = {0x01000007: "x86_64", 0x0100000C: "aarch64"}.get(machine_code)
        else:
            return f"BLOCKED: candidate kb-devkit does not support journey runner OS {platform.system()}"
    except OSError as error:
        return f"BLOCKED: cannot inspect candidate kb-devkit binary {binary}: {error}"
    actual = platform.machine().lower()
    actual = {"amd64": "x86_64", "arm64": "aarch64"}.get(actual, actual)
    if expected is None or expected != actual:
        return (f"BLOCKED: candidate kb-devkit targets {expected or f'machine {machine_code}'}, "
                f"but journey runner is {platform.system()}/{actual}; rebuild with matching GOOS/GOARCH")
    return None


def _write_devkit_fixture(root: Path) -> None:
    packages = {
        "platform": '{"name":"@fixture/platform"}',
        "plugin": '{"name":"@fixture/plugin","dependencies":{"@fixture/platform":"workspace:*"}}',
        "service": '{"name":"@fixture/service"}',
        "site": '{"name":"@fixture/site"}',
    }
    for name, package_json in packages.items():
        package_dir = root / "packages" / name
        (package_dir / "src").mkdir(parents=True, exist_ok=True)
        (package_dir / "package.json").write_text(package_json + "\n", encoding="utf-8")
        (package_dir / "src" / "change.ts").write_text("export const changed = true\n", encoding="utf-8")
    (root / "package.json").write_text('{"name":"zone-fixture","private":true,"workspaces":["packages/*"]}\n', encoding="utf-8")
    (root / ".gitignore").write_text(".kb/\n**/dist/\n", encoding="utf-8")
    config_text = '''schemaVersion: 2
workspace:
  zones:
    platform: ["packages/platform"]
    plugins: ["packages/plugin"]
    services: ["packages/service"]
    sites: ["packages/site"]
  categories:
    sites:
      match: ["packages/site"]
      preset: node-lib
      defaultBuild: false
    packages:
      match: ["packages/*"]
      preset: node-lib
tasks:
  build:
    command: 'sh -c "mkdir -p dist && printf built > dist/marker"'
    inputs: ["package.json", "src/**"]
    outputs: ["dist/**"]
    deps: ["^build"]
'''
    (root / "devkit.yaml").write_text(config_text, encoding="utf-8")
    for args in (("init", "--quiet"), ("config", "user.name", "Zone Journey"),
                 ("config", "user.email", "zone-journey@example.test"),
                 ("add", "--all"), ("commit", "--quiet", "-m", "baseline")):
        completed = run_harness_command(["git", *args], cwd=root)
        if completed.returncode != 0:
            raise RuntimeError(f"git {' '.join(args)} failed: {completed.stderr or completed.stdout}")


def _devkit_json(binary: Path, root: Path, home: Path, *args: str) -> tuple[dict, int]:
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(home), "CI": "1"}
    result = run_command([str(binary), "run", "build", *args, "--json"], cwd=root, env=env, timeout=60)
    try:
        envelope = json.loads(result.stdout or "")
    except json.JSONDecodeError as error:
        raise ValueError(f"kb-devkit {' '.join(args)} did not return JSON: {error}") from error
    return envelope, result.returncode


def _result_packages(envelope: dict) -> list[str]:
    data = envelope.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("results"), list):
        raise ValueError("kb-devkit JSON did not contain data.results")
    return [item.get("package", item.get("Package")) for item in data["results"] if isinstance(item, dict)]


def run_devkit_zone_steps(journey: Journey, repo_root: Path, *, unavailable_reason: str | None = None) -> None:
    """Exercise zone selection using the candidate's actual kb-devkit executable."""
    binary = repo_root / "tools" / "kb-devkit" / "kb-devkit"
    binary_problem = unavailable_reason or devkit_binary_problem(binary)
    if binary_problem is None:
        try:
            help_result = run_command([str(binary), "--help"], cwd=repo_root,
                                      env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")}, timeout=30)
            if help_result.returncode != 0:
                binary_problem = (f"BLOCKED: candidate kb-devkit could not execute --help "
                                  f"(exit {help_result.returncode}): {help_result.stderr or help_result.stdout}")
        except (OSError, TimeoutExpired) as error:
            binary_problem = f"BLOCKED: candidate kb-devkit is incompatible with this runner: {error}"

    if binary_problem:
        for claim in DEVKIT_ZONE_CLAIMS:
            journey.step(f"candidate kb-devkit is available for {claim}", "workspace-cli",
                         lambda reason=binary_problem: reason, cases=[claim])
        return

    with tempfile.TemporaryDirectory(prefix="kb-devkit-zone-journey-") as temporary:
        root = Path(temporary) / "workspace"
        root.mkdir()
        home = Path(temporary) / "home"
        home.mkdir()
        try:
            _write_devkit_fixture(root)
        except (OSError, RuntimeError) as error:
            reason = f"BLOCKED: could not prepare the DevKit zone fixture: {error}"
            for claim in DEVKIT_ZONE_CLAIMS:
                journey.step(f"DevKit fixture is available for {claim}", "workspace-cli",
                             lambda reason=reason: reason, cases=[claim])
            return

        def zone_contract() -> str | None:
            try:
                platform_result, code = _devkit_json(binary, root, home, "--zone", "platform")
                if code != 0 or platform_result.get("ok") is not True:
                    return f"platform zone build failed: {platform_result}"
                if _result_packages(platform_result) != ["@fixture/platform"]:
                    return f"platform zone results were {_result_packages(platform_result)}"

                plugin_zone, code = _devkit_json(binary, root, home, "--zone", "plugins")
                if code != 0 or plugin_zone.get("ok") is not True:
                    return f"plugins zone build failed: {plugin_zone}"
                plugin_results = _result_packages(plugin_zone)
                if plugin_results != ["@fixture/platform", "@fixture/plugin"]:
                    return f"plugins zone results were {plugin_results}; expected ordered upstream closure"
                if any(name in plugin_results for name in ("@fixture/service", "@fixture/site")):
                    return f"plugins zone included unrelated roots: {plugin_results}"

                product_result, code = _devkit_json(binary, root, home, "--zones", "sites,services")
                if code != 0 or product_result.get("ok") is not True:
                    return f"sites,services zone build failed: {product_result}"
                product_packages = set(_result_packages(product_result))
                if product_packages != {"@fixture/service", "@fixture/site"}:
                    return f"sites,services results were {sorted(product_packages)}"

                plain_result, code = _devkit_json(binary, root, home)
                if code != 0 or plain_result.get("ok") is not True:
                    return f"plain workspace build failed: {plain_result}"
                if "@fixture/site" in _result_packages(plain_result):
                    return "plain build unexpectedly selected the defaultBuild:false site package"
                return None
            except (KeyError, TypeError, ValueError, OSError, TimeoutExpired) as error:
                return f"DevKit zone build contract could not be observed: {error}"

        journey.step("build configured zones and upstream dependencies", "workspace-cli",
                     zone_contract, cases=["S-179.50"])

        def affected_contract() -> str | None:
            try:
                package_result, code = _devkit_json(binary, root, home, "--zone", "plugins",
                                                    "--packages", "@fixture/plugin")
                if code != 0 or package_result.get("ok") is not True:
                    return f"package and zone intersection failed: {package_result}"
                package_results = _result_packages(package_result)
                if package_results != ["@fixture/platform", "@fixture/plugin"]:
                    return f"package and zone intersection results were {package_results}; expected ordered upstream closure"
                if any(name in package_results for name in ("@fixture/service", "@fixture/site")):
                    return f"package and zone intersection included unrelated roots: {package_results}"

                (root / "packages/plugin/src/change.ts").write_text("export const changed = false\n", encoding="utf-8")
                (root / "packages/site/src/change.ts").write_text("export const changed = false\n", encoding="utf-8")
                selected, code = _devkit_json(binary, root, home, "--zones", "plugins,services",
                                              "--affected", "--diff-only")
                if code != 0 or selected.get("ok") is not True:
                    return f"affected zone build failed: {selected}"
                results = _result_packages(selected)
                if results != ["@fixture/platform", "@fixture/plugin"]:
                    return f"affected plugins,services results were {results}; expected platform upstream and plugin only"

                (root / "packages/plugin/src/change.ts").write_text("export const changed = true\n", encoding="utf-8")
                no_op, code = _devkit_json(binary, root, home, "--zone", "plugins",
                                           "--affected", "--diff-only")
                if code != 0 or no_op.get("ok") is not True or _result_packages(no_op):
                    return f"affected changes outside selected zones were not a successful no-op: {no_op}"
                summary = no_op.get("data", {}).get("summary", {})
                expected_summary = {
                    "scheduled": 0, "passed": 0, "failed": 0, "cached": 0,
                    "blocked": 0, "notAffected": 0, "blockedTasks": [],
                }
                if summary != expected_summary:
                    return f"affected zone no-op summary was {summary}; expected {expected_summary}"
                if no_op.get("data", {}).get("elapsed") != "0s":
                    return f"affected zone no-op elapsed was {no_op.get('data', {}).get('elapsed')!r}; expected '0s'"
                if no_op.get("data", {}).get("results") != []:
                    return f"affected zone no-op results were {no_op.get('data', {}).get('results')!r}; expected []"
                return None
            except (KeyError, TypeError, ValueError, OSError, TimeoutExpired) as error:
                return f"DevKit affected zone contract could not be observed: {error}"

        journey.step("intersect zones with explicit and affected selection", "workspace-cli",
                     affected_contract, cases=["S-179.51"])

        def invalid_contract() -> str | None:
            try:
                unknown, code = _devkit_json(binary, root, home, "--zone", "missing")
                if code == 0 or unknown.get("ok") is not False:
                    return f"unknown zone unexpectedly succeeded: {unknown}"
                if unknown.get("error", {}).get("code") != "KB_RUNTIME_INPUT_INVALID":
                    return f"unknown zone did not return KB_RUNTIME_INPUT_INVALID: {unknown}"
                if "missing" not in unknown.get("error", {}).get("message", "") or "kb-devkit deps" not in unknown.get("error", {}).get("hint", ""):
                    return f"unknown zone diagnostic did not identify the selection and inspection command: {unknown}"
                mismatch, code = _devkit_json(binary, root, home, "--zone", "platform",
                                             "--packages", "@fixture/plugin")
                if code == 0 or mismatch.get("ok") is not False:
                    return f"empty package-zone intersection unexpectedly succeeded: {mismatch}"
                if mismatch.get("error", {}).get("code") != "KB_RUNTIME_INPUT_INVALID":
                    return f"empty package-zone intersection did not return KB_RUNTIME_INPUT_INVALID: {mismatch}"
                if "@fixture/plugin" not in mismatch.get("error", {}).get("message", "") or "platform" not in mismatch.get("error", {}).get("message", "") or "kb-devkit deps" not in mismatch.get("error", {}).get("hint", ""):
                    return f"empty intersection diagnostic did not identify the selection and inspection command: {mismatch}"

                config_path = root / "devkit.yaml"
                original_config = config_path.read_text(encoding="utf-8")
                gap_config = original_config.replace(
                    'platform: ["packages/platform"]', 'platform: ["packages/no-such-platform"]', 1)
                if gap_config == original_config:
                    return "could not prepare workspace zone gap probe"
                config_path.write_text(gap_config, encoding="utf-8")
                gap, code = _devkit_json(binary, root, home)
                config_path.write_text(original_config, encoding="utf-8")
                if code == 0 or gap.get("ok") is not False:
                    return f"unclassified package from a zone gap unexpectedly succeeded: {gap}"
                if gap.get("error", {}).get("code") != "KB_RUNTIME_INPUT_INVALID" or "packages/platform" not in gap.get("error", {}).get("message", "") or "kb-devkit deps" not in gap.get("error", {}).get("hint", ""):
                    return f"zone gap diagnostic did not identify the package and inspection command: {gap}"

                overlap_config = original_config.replace(
                    'plugins: ["packages/plugin"]', 'plugins: ["packages/plugin", "packages/platform"]', 1)
                if overlap_config == original_config:
                    return "could not prepare workspace zone overlap probe"
                config_path.write_text(overlap_config, encoding="utf-8")
                overlap, code = _devkit_json(binary, root, home)
                config_path.write_text(original_config, encoding="utf-8")
                if code == 0 or overlap.get("ok") is not False:
                    return f"package matched by overlapping zones unexpectedly succeeded: {overlap}"
                overlap_error = overlap.get("error", {})
                if (overlap_error.get("code") != "KB_RUNTIME_INPUT_INVALID" or
                        "packages/platform" not in overlap_error.get("message", "") or
                        "matches multiple workspace zones" not in overlap_error.get("message", "") or
                        "plugins" not in overlap_error.get("message", "") or
                        "platform" not in overlap_error.get("message", "") or
                        "kb-devkit deps" not in overlap_error.get("hint", "")):
                    return f"zone overlap diagnostic did not identify the package, matches, and inspection command: {overlap}"
                return None
            except (KeyError, TypeError, ValueError, OSError, TimeoutExpired) as error:
                return f"DevKit invalid selector contract could not be observed: {error}"

        journey.step("reject unknown, empty, gap, and overlapping zone selections", "workspace-cli",
                     invalid_contract, cases=["S-179.52"])


def run_workspace_cli_steps(journey: Journey, repo_root: Path, *, prechecked: bool = False) -> None:
    if not prechecked:
        problem = workspace_checkout_problem(repo_root)
        if problem:
            journey.step(
                "workspace checkout is staged and built",
                "workspace-cli",
                lambda: problem,
                cases=[
                    "S-179.2", "S-179.3", "S-179.4", "S-179.5", "S-179.13", "S-179.33",
                    "S-142.5", "S-203.1", "S-203.19", "S-204.7",
                ],
            )
            run_devkit_zone_steps(journey, repo_root, unavailable_reason=f"BLOCKED: workspace checkout is unavailable: {problem}")
            run_devkit_cache_steps(journey, repo_root)
            return

    cli = repo_root / "cli/bin/dist/bin.js"
    with tempfile.TemporaryDirectory(prefix="kb-workspace-cli-home-") as home:
        workspace_root = _stage_workspace_checkout(repo_root, Path(home) / "workspace")
        env = configure_hermetic_cli_fixture(
            Path(home), env=os.environ, workspace_root=workspace_root,
            platform_root=workspace_root, source_config=workspace_root / ".kb" / "kb.config.jsonc")
        env["GATEWAY_PORT"] = "1"
        cli = workspace_root / "cli/bin/dist/bin.js"

        def run(*args: str) -> CompletedProcess[str]:
            return run_command(["node", str(cli), *args], cwd=workspace_root, env=env, timeout=120)

        def register_checkout() -> str | None:
            result = run_command(
                [
                    "node", "--input-type=module", "-e",
                    "const { createProjectRegistry } = await import(process.argv[1]); "
                    "await createProjectRegistry({ env: process.env }).add(process.argv[2]);",
                    str(workspace_root / "core/project-registry/dist/index.js"),
                    str(workspace_root),
                ],
                cwd=workspace_root,
                env=env,
                capture_output=True,
                text=True,
                check=False,
                timeout=120,
            )
            if result.returncode != 0:
                return f"could not register workspace checkout in isolated KB_HOME: {result.stderr or result.stdout}"
            return None

        def validate_cases() -> str | None:
            registration_error = register_checkout()
            if registration_error:
                return registration_error
            result = run("qa", "cases", "validate", "--json")
            if result.returncode != 0:
                return f"workspace QA case validation failed (exit {result.returncode}): {result.stderr or result.stdout}"
            try:
                envelope = read_ux_cli_result(result)
                payload = decode_ux_success_result(envelope)
            except ValueError as error:
                return f"workspace QA case validation did not return JSON: {error}"
            if not isinstance(payload, dict) or payload.get("valid") is not True:
                return "workspace QA case validation data did not report valid cases"
            return None

        journey.step("validate QA cases with the workspace CLI", "workspace-cli", validate_cases, cases=["S-179.2", "S-203.1"])

        def check_system_command_envelopes() -> str | None:
            commands = (
                (("version",), "version"),
                (("auth", "status"), "authenticated"),
                (("project", "list"), "projects"),
                (("webhook", "list"), "webhooks"),
                (("qa", "coverage", "show", "--level", "all", "--mode", "local"), "cases"),
            )
            for command, expected_field in commands:
                result = run(*command, "--json")
                try:
                    envelope = read_ux_cli_result(result)
                    if envelope["ok"]:
                        payload = decode_ux_success_result(envelope)
                        if not isinstance(payload, dict) or expected_field not in payload:
                            return f"{' '.join(('kb', *command, '--json'))} did not place {expected_field!r} in data"
                    else:
                        decode_ux_error_result(envelope)
                except (KeyError, ValueError) as error:
                    return f"{' '.join(('kb', *command, '--json'))} did not return one ADR-0049 envelope: {error}"
            return None

        journey.step(
            "read JSON results from installed system commands",
            "workspace-cli",
            check_system_command_envelopes,
            cases=["S-203.19"],
        )

        def reject_invalid_project_config_path() -> str | None:
            result = run("config", "set", "someSection.key", "1", "--scope", "project", "--json")
            try:
                envelope = read_ux_cli_result(result)
            except ValueError as error:
                return f"project config write did not return one JSON envelope: {error}"
            if envelope.get("ok") is not False:
                return "invalid project config path unexpectedly succeeded"
            try:
                error = decode_ux_error_result(envelope)
            except (KeyError, ValueError) as error:
                return f"project config write returned an invalid error envelope: {error}"
            details = error.get("details", {})
            command = details.get("nextCommand")
            if (error.get("code") != "KB_CONFIG_INVALID"
                    or details.get("path") != "someSection.key"
                    or command != "kb config set plugins.someSection.key 1"
                    or command not in error.get("hint", "")
                    or "reason" in details):
                return "project config write omitted its catalogued recovery command or emitted internal metadata"
            if result.returncode == 0:
                return "invalid project config write exited successfully"
            return None

        journey.step(
            "show a catalogued recovery command for an invalid project config path",
            "workspace-cli",
            reject_invalid_project_config_path,
            cases=["S-203.27"],
        )

        def list_workspace_adapters() -> str | None:
            result = run("adapter", "list", "--json")
            if result.returncode != 0:
                return f"workspace adapter listing failed (exit {result.returncode}): {result.stderr or result.stdout}"
            try:
                envelope = read_ux_cli_result(result)
                payload = decode_ux_success_result(envelope)
            except ValueError as error:
                return f"workspace adapter listing did not return JSON: {error}"
            if not isinstance(payload, dict):
                return "workspace adapter listing returned non-object UX data"
            rows = payload.get("adapters", [])
            adapter_rows = {row.get("slot"): row for row in rows if isinstance(row, dict)}
            implementations = {slot: row.get("implementation") for slot, row in adapter_rows.items()}
            expected = {
                "storage": "@kb-labs/adapters-fs",
                "cache": "@kb-labs/adapters-state-broker",
                "eventBus": "@kb-labs/adapters-eventbus-cache",
                "documentDatabase": "@kb-labs/adapters-sqlite",
                "kvStore": "@kb-labs/adapters-sqlite/kv",
                "logger": "@kb-labs/adapters-pino",
                "logRingBuffer": "@kb-labs/adapters-log-ringbuffer",
                "logPersistence": "@kb-labs/adapters-log-document",
                "analytics": "@kb-labs/adapters-analytics-sqlite",
                "serviceTransport": "@kb-labs/adapters-service-transport-http",
            }
            missing = [slot for slot, package in expected.items() if implementations.get(slot) != package]
            if missing:
                return f"workspace adapter listing did not resolve configured workspace packages for: {', '.join(missing)}"
            unknown = [slot for slot in expected if adapter_rows[slot].get("runtimeStatus") != "unknown"
                       or adapter_rows[slot].get("mode") != "unknown"
                       or adapter_rows[slot].get("action", {}).get("command") != f'kb-create start --platform-root "{env["KB_PLATFORM_ROOT"]}"']
            if unknown:
                return f"stopped host adapter rows did not report unknown status with the platform-root start command for: {', '.join(unknown)}"
            return None

        journey.step("list configured workspace adapters", "workspace-cli", list_workspace_adapters, cases=["S-179.5"])

        def list_plugin_commands() -> str | None:
            with invocation_context(step_id="S-179.3"):
                result = run("--help")
            if result.returncode != 0:
                return f"workspace CLI help failed (exit {result.returncode}): {result.stderr or result.stdout}"
            expected_groups = ("qa", "marketplace", "workflow", "commit", "release", "review", "mind", "agent")
            missing = [group for group in expected_groups if group not in result.stdout]
            if missing:
                return f"workspace CLI help is missing plugin groups: {', '.join(missing)}"
            return None

        journey.step("list workspace plugin command groups", "workspace-cli", list_plugin_commands, cases=["S-179.3"])

        def unavailable_locked_workspace_plugin() -> str | None:
            fixture_root = Path(home) / "unbuilt-workspace"
            kb_dir = fixture_root / ".kb"
            package_dir = fixture_root / "plugins/release"
            kb_dir.mkdir(parents=True)
            for source in repo_root.iterdir():
                if source.name in {".kb", ".git", "plugins"}:
                    continue
                (fixture_root / source.name).symlink_to(source, target_is_directory=source.is_dir())
            fixture_plugins = fixture_root / "plugins"
            fixture_plugins.mkdir()
            for source in (repo_root / "plugins").iterdir():
                if source.name == "release":
                    continue
                (fixture_plugins / source.name).symlink_to(source, target_is_directory=True)
            package_dir.mkdir()
            for source in (repo_root / "plugins/release").iterdir():
                if source.name not in {"package.json", "dist"}:
                    (package_dir / source.name).symlink_to(source, target_is_directory=source.is_dir())
            (package_dir / "package.json").write_text(json.dumps({
                "name": "@kb-labs/release",
                "kb": {"manifest": "./dist/manifest.js"},
            }), encoding="utf-8")
            locked = json.loads((repo_root / layout_value('versionStatePaths.kb_marketplace_lock')).read_text())
            locked["plugins"]["@kb-labs/release"]["link"] = "./plugins/release"
            config_source = repo_root / ".kb/kb.config.json"
            if not config_source.exists():
                config_source = repo_root / layout_value('sharedRuntimePaths.kb_kb_config_jsonc.platformPath')
            isolated_lock = locked
            (kb_dir / "marketplace.lock").write_text(json.dumps(isolated_lock), encoding="utf-8")
            isolated_env = configure_hermetic_cli_fixture(
                fixture_root,
                env=env,
                workspace_root=fixture_root,
                source_config=config_source,
                platform_root=fixture_root,
            )
            with invocation_context(step_id="S-179.13"):
                help_result = run_command(["node", str(cli), "--help"], cwd=fixture_root,
                                          env=isolated_env, timeout=120)
            help_text = "\n".join((help_result.stdout or "", help_result.stderr or ""))
            if help_result.returncode != 0 or "release" not in help_text or "pnpm build" not in help_text:
                return ("workspace help did not identify the unbuilt locked release plugin and pnpm build: "
                        f"exit={help_result.returncode} output={help_text[:3000]}")
            with invocation_context(step_id="S-179.13"):
                command_result = run_command(["node", str(cli), "release", "plan", "--json"],
                                             cwd=fixture_root, env=isolated_env, timeout=120)
            try:
                envelope = read_ux_cli_result(command_result)
                error = decode_ux_error_result(envelope)
            except ValueError as error:
                return f"unbuilt release command returned an invalid UX result: {error}"
            if (command_result.returncode == 0 or not isinstance(error, dict)
                    or error.get("code") != "KB_PLUGIN_NOT_FOUND"
                    or "pnpm build" not in str(error.get("hint", ""))):
                return ("unbuilt release command did not return typed KB_PLUGIN_NOT_FOUND with pnpm build guidance: "
                        f"exit={command_result.returncode} stdout={(command_result.stdout or '')[:800]} "
                        f"stderr={(command_result.stderr or '')[:800]}")
            return None

        journey.step("diagnose an unbuilt locked workspace plugin", "workspace-cli",
                     unavailable_locked_workspace_plugin, cases=["S-179.13"])

        def verify_agent_command_namespaces() -> str | None:
            with invocation_context(step_id="S-142.5"):
                help_result = run("--help")
            help_text = "\n".join((help_result.stdout or "", help_result.stderr or ""))
            if help_result.returncode != 0:
                return "workspace CLI help failed while checking agent namespaces"
            if "tried to register \"agent register\"" in help_text or "namespace \"agent\" is owned" in help_text:
                return "workspace CLI reported an agent namespace collision"
            if "workspace" not in help_text or "agent" not in help_text:
                return "workspace or Agents command namespace is missing from help"
            with invocation_context(step_id="S-142.5"):
                workspace_help = run("workspace", "--help")
            workspace_text = "\n".join((workspace_help.stdout or "", workspace_help.stderr or ""))
            if workspace_help.returncode != 0 or any(name not in workspace_text for name in ("register", "status", "list")):
                return "Workspace Agent commands are not listed under the workspace namespace"
            with invocation_context(step_id="S-142.5"):
                agent_help = run("agent", "--help")
            agent_text = "\n".join((agent_help.stdout or "", agent_help.stderr or ""))
            if agent_help.returncode != 0 or not any(name in agent_text for name in ("run", "history")):
                return "Agents commands are not listed under the agent namespace"
            return None

        journey.step("keep host and project agent command namespaces distinct", "workspace-cli",
                     verify_agent_command_namespaces, cases=["S-142.5"])

        def verify_synced_workspace_lock() -> str | None:
            process, marketplace_url, startup_error = start_marketplace_sync_fixture(workspace_root, env)
            if startup_error:
                return startup_error
            if process is None or marketplace_url is None:
                return "Marketplace sync fixture did not return a process and URL"
            previous_url = env.get("KB_MARKETPLACE_URL")
            env["KB_MARKETPLACE_URL"] = marketplace_url
            try:
                sync = run("marketplace", "sync", "--scope", "project", "--json")
            finally:
                if previous_url is None:
                    env.pop("KB_MARKETPLACE_URL", None)
                else:
                    env["KB_MARKETPLACE_URL"] = previous_url
                cleanup_error = stop_marketplace_sync_fixture(process)
            if cleanup_error:
                return cleanup_error
            if sync.returncode != 0:
                return f"workspace marketplace sync failed (exit {sync.returncode}): {sync.stderr or sync.stdout}"
            try:
                lock = json.loads((workspace_root / layout_value('versionStatePaths.kb_marketplace_lock')).read_text())
            except (OSError, json.JSONDecodeError) as error:
                return f"staged workspace marketplace lock could not be read: {error}"
            expected_plugins = ("@kb-labs/release", "@kb-labs/review", "@kb-labs/mind", "@kb-labs/agents")
            missing_plugins = [plugin for plugin in expected_plugins if plugin not in lock.get("plugins", {})]
            adapters = lock.get("adapters", {})
            if lock.get("schema") != "kb.marketplace/3":
                return "workspace marketplace lock does not use schema kb.marketplace/3"
            if missing_plugins:
                return f"workspace marketplace lock is missing plugin entries: {', '.join(missing_plugins)}"
            if not adapters:
                return "workspace marketplace lock has no machine-level adapter entries"
            return None

        journey.step("verify synced workspace plugins and adapters in the v3 lock", "workspace-cli", verify_synced_workspace_lock, cases=["S-179.4", "S-179.33"])

        run_devkit_zone_steps(journey, repo_root)
        run_devkit_cache_steps(journey, repo_root)
