"""Installed CLI help and catalogued unknown-command journey checks."""
from __future__ import annotations

from pathlib import Path
import json
import os
import re
from typing import Callable, Mapping

from invocations import CompletedProcess, TimeoutExpired, catalogued_error_hint, run_command, run_harness_command
from installed_fixture import active_platform_root
from kb_invocation import kb_command
from service_steps import Journey


def check_installed_cli_contract(
    env: Mapping[str, str],
    *,
    runner: Callable[..., CompletedProcess[str]] | None = None,
) -> str | None:
    home = Path(env["HOME"])
    binaries = (home / ".local" / "bin" / "kb", home / ".local" / "bin" / "kb-create")
    for executable in binaries:
        if not executable.is_file():
            return f"installed CLI binary is missing at {executable}"
        for arguments in (("--help",), ("help",)):
            command = kb_command(arguments, executable=executable)
            result = run_command(command, cwd=home, env=env, timeout=30, runner=runner)
            output = f"{result.stdout or ''}\n{result.stderr or ''}"
            has_usage = ("usage:" in output.lower()
                         or f"{executable.name} <command>" in output)
            if result.returncode != 0 or not has_usage:
                return f"{executable.name} {' '.join(arguments)} did not return usage successfully"

        command = kb_command(("__kb_journey_unknown_command__",), executable=executable)
        result = run_command(command, cwd=home, env=env, timeout=30, runner=runner)
        output = f"{result.stdout or ''}\n{result.stderr or ''}"
        expected_hint = catalogued_error_hint("KB_RUNTIME_UNKNOWN_COMMAND", binary=executable.name)
        if result.returncode == 0 or "KB_RUNTIME_UNKNOWN_COMMAND" not in output or expected_hint not in output:
            return f"{executable.name} unknown command did not report its catalogued help hint"
    return None


def check_installed_cli_node_engine(
    env: Mapping[str, str],
    *,
    runner: Callable[..., CompletedProcess[str]] | None = None,
) -> str | None:
    platform_root = Path(env["KB_JOURNEY_PLATFORM_ROOT"])
    launcher_value = env.get("KB_JOURNEY_KB_CREATE_PATH")
    if not launcher_value:
        return "BLOCKED: journey did not provide KB_JOURNEY_KB_CREATE_PATH for the installed shim"
    unsupported_value = env.get("KB_TEST_OLD_NODE")
    supported_value = env.get("KB_TEST_SUPPORTED_NODE")
    if not unsupported_value or not supported_value:
        return "BLOCKED: set KB_TEST_OLD_NODE and KB_TEST_SUPPORTED_NODE to explicitly provision both Node.js versions"
    shim = Path(launcher_value).with_name("kb")
    try:
        version_root = active_platform_root(platform_root)
    except (OSError, ValueError) as error:
        return f"installed platform root is unavailable: {error}"
    if not shim.is_file():
        return f"installed kb shim is missing at {shim}"

    unsupported = Path(unsupported_value)
    supported = Path(supported_value)

    # Follow the installed CLI package's declared bin entry and resolve its runtime dependency
    # with Node's ESM resolver, matching cli/bin's installed-policy lookup.
    try:
        cli_manifest_path = version_root / "node_modules" / "@kb-labs" / "cli-bin" / "package.json"
        cli_manifest = json.loads(cli_manifest_path.read_text(encoding="utf-8"))
        if cli_manifest.get("name") != "@kb-labs/cli-bin":
            return f"installed CLI package identity is invalid at {cli_manifest_path}"
        bin_entry = cli_manifest.get("bin", {}).get("kb")
        if not isinstance(bin_entry, str):
            return f"installed CLI package does not declare bin.kb at {cli_manifest_path}"
        cli_entry = cli_manifest_path.parent / bin_entry
        if not cli_entry.is_file():
            return f"installed CLI entry is missing at {cli_entry}"
        policy_script = (
            "import { readFileSync } from 'node:fs'; "
            "import { fileURLToPath, pathToFileURL } from 'node:url'; "
            "const runtime = import.meta.resolve('@kb-labs/plugin-runtime', pathToFileURL(process.argv[1])); "
            "const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', runtime)), 'utf8')); "
            "if (manifest.name !== '@kb-labs/plugin-runtime') throw new Error('runtime package identity mismatch'); "
            "process.stdout.write(JSON.stringify(manifest));"
        )
        policy_result = run_harness_command(
            [str(supported), "--experimental-import-meta-resolve", "--input-type=module", "-e",
             policy_script, str(cli_entry)], cwd=version_root, timeout=15)
        if policy_result.returncode != 0:
            return f"cannot resolve installed runtime Node policy: {policy_result.stderr.strip()}"
        manifest = json.loads(policy_result.stdout)
        match = re.fullmatch(r"(\d+)\.x", manifest["engines"]["node"])
        if not match:
            return f"installed runtime declares an unsupported Node policy resolved from {cli_entry}"
        required_major = int(match.group(1))
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError, TimeoutExpired) as error:
        return f"cannot read the installed runtime Node policy: {error}"
    versions: dict[Path, str] = {}
    for candidate in (unsupported, supported):
        if not candidate.is_file():
            return f"provisioned Node.js executable is missing: {candidate}"
        version_result = run_harness_command([str(candidate), "--version"], timeout=10)
        if version_result.returncode != 0:
            return f"cannot read Node.js version from {candidate}: {version_result.stderr.strip()}"
        version = version_result.stdout.strip().removeprefix("v")
        version_match = re.fullmatch(r"(\d+)\.\d+\.\d+", version)
        if not version_match:
            return f"Node.js executable returned an invalid version: {candidate} => {version!r}"
        versions[candidate] = version
    unsupported_major = int(versions[unsupported].split(".")[0])
    supported_major = int(versions[supported].split(".")[0])
    if unsupported_major >= required_major or supported_major != required_major:
        return (f"journey requires explicit Node.js {required_major} and a different major; "
                f"received {versions[unsupported]} and {versions[supported]}")

    base_env = dict(env)
    original_path = base_env.get("PATH", os.defpath)

    def invoke(node: Path, arguments: tuple[str, ...]) -> CompletedProcess[str]:
        command_env = dict(base_env)
        command_env["PATH"] = os.pathsep.join((str(node.parent), original_path))
        return run_command(kb_command(arguments, executable=shim), cwd=platform_root,
                           env=command_env, timeout=30, runner=runner)

    text = invoke(unsupported, ("marketplace", "plugins", "list", "--help"))
    text_output = f"{text.stdout or ''}\n{text.stderr or ''}"
    actual_version = versions[unsupported]
    if (text.returncode == 0 or "KB_NODE_VERSION_UNSUPPORTED" not in text_output
            or f"Node.js {actual_version} is unsupported" not in text_output
            or f"requires major {required_major}" not in text_output
            or f"nvm install {required_major} && nvm use {required_major}" not in text_output
            or "ERR_MODULE_NOT_FOUND" in text_output or " at file:" in text_output):
        return f"installed kb shim did not render the Node engine diagnostic: {text_output.strip()}"

    json_result = invoke(unsupported, ("marketplace", "plugins", "list", "--help", "--json"))
    if json_result.returncode == 0 or json_result.stderr:
        return f"installed kb shim returned an invalid JSON-mode engine failure: {json_result.stderr}"
    try:
        response = json.loads(json_result.stdout)
    except (TypeError, json.JSONDecodeError) as error:
        return f"installed kb shim did not return JSON engine diagnostics: {error}; output={json_result.stdout!r}"
    error = response.get("error", {})
    if (response.get("ok") is not False or error.get("code") != "KB_NODE_VERSION_UNSUPPORTED"
            or error.get("details", {}).get("actualVersion") != actual_version
            or error.get("details", {}).get("requiredMajor") != str(required_major)
            or f"nvm install {required_major} && nvm use {required_major}" not in error.get("hint", "")
            or "ERR_MODULE_NOT_FOUND" in json_result.stdout):
        return f"installed kb shim returned the wrong JSON engine diagnostic: {json_result.stdout}"

    supported_result = invoke(supported, ("marketplace", "plugins", "list", "--help"))
    supported_output = f"{supported_result.stdout or ''}\n{supported_result.stderr or ''}"
    if supported_result.returncode != 0 or not re.search(r"usage|marketplace", supported_output, re.IGNORECASE):
        return f"installed kb shim did not return help with Node.js {required_major}: {supported_output.strip()}"
    return None


def run_installed_cli_contract_steps(
    journey: Journey,
    env: Mapping[str, str],
    *,
    runner: Callable[..., CompletedProcess[str]] | None = None,
) -> None:
    journey.step(
        "installed CLI root help and unknown-command hints",
        "cli-contract",
        lambda: check_installed_cli_contract(env, runner=runner),
        cases=["S-258.1"],
    )
    journey.step(
        "installed kb shim rejects unsupported Node and accepts the required major",
        "cli-contract",
        lambda: check_installed_cli_node_engine(env, runner=runner),
        cases=["S-260.7"],
    )
