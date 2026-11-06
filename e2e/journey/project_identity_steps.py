from __future__ import annotations

from kb_invocation import kb_command
from installed_fixture import configure_hermetic_cli_fixture, layout_relative, layout_value

from project_service_path import project_service_path

import json
import os
import tempfile
from pathlib import Path

from service_steps import Journey
from invocations import (
    CompletedProcess,
    decode_ux_error_result,
    decode_ux_success_result,
    invocation_context,
    catalogued_error_hint,
    catalogued_error_message,
    read_ux_cli_result,
    run_command,
    run_with_runner,
)
from marketplace_steps import _output, _registry_version


def _cli_success(result: CompletedProcess[str]):
    return decode_ux_success_result(read_ux_cli_result(result))


def _cli_error(result: CompletedProcess[str]):
    return decode_ux_error_result(read_ux_cli_result(result))


def run_project_registry_steps(journey: Journey, cli: str, env: dict[str, str], registry: str,
                               runner=run_command) -> None:
    """Register two disposable repositories and prove their CLI scope boundaries."""
    command_runner = runner

    def run(cwd: Path, *args: str, step_id: str) -> CompletedProcess[str]:
        with invocation_context(step_id=step_id):
            return run_with_runner(command_runner, kb_command([ *args], executable=cli), cwd=cwd, env=env, timeout=180)

    with tempfile.TemporaryDirectory(prefix="kb-project-registry-", dir=env.get("HOME")) as directory:
        fixture_root = Path(directory)
        projects = (fixture_root / "project-a", fixture_root / "project-b")
        for project in projects:
            project.mkdir()
            initialized = run_command(["git", "init", "--quiet", str(project)], cwd=fixture_root,
                                      env=env, timeout=30)
            if initialized.returncode != 0:
                journey.step("prepare project registry fixtures", "projects",
                             lambda: f"could not initialize {project.name}: {initialized.stderr.strip()}")
                return
        ids: dict[Path, str] = {}

        def registration() -> str | None:
            for project in projects:
                if (project / ".kb").exists():
                    return f"{project.name} fixture unexpectedly contains .kb before registration"
            step_ids = ("S-043.1", "S-196.1")
            if len(projects) != len(step_ids):
                raise RuntimeError("project registry fixture step mapping is incomplete")
            for project, step_id in zip(projects, step_ids):
                result = run(project, "project", "add", str(project), "--json", step_id=step_id)
                if result.returncode != 0:
                    return f"kb project add failed for {project.name}: {(result.stderr or result.stdout).strip()}"
                try:
                    payload = _cli_success(result)
                except ValueError as error:
                    return f"kb project add returned an invalid UX result for {project.name}: {error}"
                row = payload.get("project", {}) if isinstance(payload, dict) else {}
                identifier = row.get("id") if isinstance(row, dict) else None
                path = row.get("path") if isinstance(row, dict) else None
                if not isinstance(identifier, str) or not identifier or path != str(project.resolve()):
                    return f"kb project add omitted the canonical ID or path for {project.name}"
                ids[project] = identifier
            if ids[projects[0]] == ids[projects[1]] or (projects[1] / ".kb").exists():
                return "project registrations were not distinct or project B was modified"
            return None

        journey.step("register isolated project A and B", "projects", registration,
                     cases=["S-043.1", "S-196.1"])

        def list_projects() -> str | None:
            result = run(fixture_root, "project", "list", "--json", step_id="S-043.2")
            if result.returncode != 0:
                return f"kb project list failed: {(result.stderr or result.stdout).strip()}"
            try:
                payload = _cli_success(result)
            except ValueError as error:
                return f"kb project list returned an invalid UX result: {error}"
            rows = payload.get("projects", []) if isinstance(payload, dict) else []
            found = {(row.get("id"), row.get("path")) for row in rows if isinstance(row, dict)}
            expected = {(ids.get(project), str(project.resolve())) for project in projects}
            if not expected <= found:
                return "kb project list omitted one or both registered roots"
            return None

        journey.step("list both registered projects", "projects", list_projects, cases=["S-043.2"],
                     requires=("step:register isolated project A and B",))

        def install_scoped_plugins() -> str | None:
            for project, package in ((projects[0], "@kb-labs/qa"),
                                     (projects[1], "@kb-labs/commit")):
                version = _registry_version(package, registry, project, env, command_runner)
                args = ["marketplace", "install", f"{package}@{version}", "--json"]
                result = run(project, *args, step_id="S-043.3")
                if result.returncode != 0:
                    return f"Marketplace install of {package} failed: {(result.stderr or result.stdout).strip()}"
            locks = []
            for project in projects:
                lock_path = project / ".kb" / "marketplace.lock"
                try:
                    locks.append(json.loads(lock_path.read_text()).get("plugins", {}))
                except (OSError, json.JSONDecodeError):
                    return f"{project.name} marketplace lock was missing or invalid after installation"
            if "@kb-labs/qa" not in locks[0] or "@kb-labs/commit" in locks[0]:
                return "Project A's marketplace lock did not contain only its QA install"
            if "@kb-labs/commit" not in locks[1] or "@kb-labs/qa" in locks[1]:
                return "Project B's marketplace lock did not contain only its Commit install"
            return None

        journey.step("install distinct plugins into project A and B", "marketplace", install_scoped_plugins,
                     cases=["S-043.3"], requires=("step:register isolated project A and B",))

        def mind_plugin_scope() -> str | None:
            package = "@kb-labs/mind"
            version = _registry_version(package, registry, projects[0], env, command_runner)
            result = run(projects[0], "marketplace", "install", f"{package}@{version}", "--json",
                         step_id="S-199.1")
            if result.returncode != 0:
                return f"Mind Marketplace install failed: {(result.stderr or result.stdout).strip()}"
            locks = []
            for project in projects:
                try:
                    locks.append(json.loads((project / layout_value('versionStatePaths.kb_marketplace_lock')).read_text()).get("plugins", {}))
                except (OSError, json.JSONDecodeError):
                    return f"{project.name} marketplace lock could not be inspected"
            if "@kb-labs/mind" not in locks[0] or "@kb-labs/commit" in locks[0]:
                return "Project A did not retain Mind without Project B's Commit plugin"
            if "@kb-labs/commit" not in locks[1] or "@kb-labs/mind" in locks[1]:
                return "Project B did not retain Commit without Project A's Mind plugin"
            return None

        journey.step("install Mind into project A and verify plugin lock isolation", "marketplace",
                     mind_plugin_scope, cases=["S-199.1"],
                     requires=("step:register isolated project A and B",))

        def adapter_bindings() -> str | None:
            outputs = []
            for project in projects:
                result = run(project, "adapter", "list", "--json", step_id="S-043.4")
                if result.returncode != 0:
                    return f"adapter list failed in {project.name}: {(result.stderr or result.stdout).strip()}"
                try:
                    payload = _cli_success(result)
                except ValueError as error:
                    return f"adapter list returned an invalid UX result in {project.name}: {error}"
                outputs.append(payload)
                for config in (project / ".kb" / "kb.config.json", project / ".kb" / "kb.config.jsonc"):
                    if config.exists() and '"adapters"' in config.read_text():
                        return f"{project.name} config contains project-scoped adapter settings"
            if outputs[0] != outputs[1]:
                return "registered projects resolved different platform adapter bindings"
            return None

        journey.step("resolve shared platform adapters in both projects", "adapters", adapter_bindings,
                     cases=["S-043.4"], requires=("step:register isolated project A and B",))

        def show_projects() -> str | None:
            for project in projects:
                result = run(project, "project", "show", "--json", step_id="S-043.5")
                if result.returncode != 0:
                    return f"project show failed in {project.name}: {(result.stderr or result.stdout).strip()}"
                try:
                    payload = _cli_success(result)
                except ValueError as error:
                    return f"project show returned an invalid UX result in {project.name}: {error}"
                row = payload.get("project", {}) if isinstance(payload, dict) else {}
                if not isinstance(row, dict) or row.get("id") != ids[project] or row.get("path") != str(project.resolve()):
                    return f"project show did not identify {project.name}'s registered root"
            return None

        journey.step("resolve project show from each repository", "projects", show_projects,
                     cases=["S-043.5"], requires=("step:register isolated project A and B",))

        def current_project_identity() -> str | None:
            listed = run(fixture_root, "project", "list", "--json", step_id="S-196.2")
            if listed.returncode != 0:
                return f"project list failed: {(listed.stderr or listed.stdout).strip()}"
            try:
                payload = _cli_success(listed)
            except ValueError as error:
                return f"project list returned an invalid UX result: {error}"
            rows = payload.get("projects", []) if isinstance(payload, dict) else []
            expected = {(ids[project], str(project.resolve())) for project in projects}
            found = {(row.get("id"), row.get("path")) for row in rows if isinstance(row, dict)}
            if not expected <= found:
                return "project list omitted a registered project ID or root"
            for project in projects:
                result = run(project, "project", "show", "--json", step_id="S-196.2")
                try:
                    current = _cli_success(result).get("project", {})
                except ValueError as error:
                    return f"project show returned an invalid UX result in {project.name}: {error}"
                if (result.returncode != 0 or current.get("id") != ids[project]
                        or current.get("path") != str(project.resolve())):
                    return f"project show selected the wrong registered root from {project.name}"
            return None

        journey.step("list and select each current project", "projects", current_project_identity,
                     cases=["S-196.2"], requires=("step:register isolated project A and B",))

        def project_plugin_commands() -> str | None:
            commands = ((projects[0], ("qa", "cases", "list", "--help"), "@kb-labs/qa"),
                        (projects[1], ("commit", "plan", "show", "--help"), "@kb-labs/commit"))
            for project, args, package in commands:
                result = run(project, *args, step_id="S-043.6")
                if result.returncode != 0:
                    return f"project-scoped {package} command failed in {project.name}: {(result.stderr or result.stdout).strip()}"
            return None

        journey.step("resolve project scoped plugin commands", "plugins", project_plugin_commands,
                     cases=["S-043.6"], requires=("step:register isolated project A and B",))

        def platform_plugin_is_available() -> str | None:
            version = _registry_version("@kb-labs/qa", registry, projects[0], env, command_runner)
            install = run(projects[0], "marketplace", "install", f"@kb-labs/qa@{version}",
                          "--scope", "platform", "--json", step_id="S-043.7")
            if install.returncode != 0:
                return f"Platform-scope install of @kb-labs/qa failed: {(install.stderr or install.stdout).strip()}"
            project_lock_path = projects[0] / ".kb" / "marketplace.lock"
            platform_lock_path = Path(env.get("KB_PLATFORM_ROOT", "")) / ".kb" / "marketplace.lock"
            try:
                project_plugins = json.loads(project_lock_path.read_text()).get("plugins", {})
                platform_plugins = json.loads(platform_lock_path.read_text()).get("plugins", {})
            except (OSError, json.JSONDecodeError):
                return "could not inspect the project and platform plugin scopes"
            if "@kb-labs/qa" not in project_plugins or "@kb-labs/qa" not in platform_plugins:
                return "the same QA plugin ID was not installed at both project and platform scope"
            result = run(projects[0], "qa", "cases", "list", "--help", step_id="S-043.7")
            if result.returncode != 0:
                return f"the shared QA command was unavailable from project A: {(result.stderr or result.stdout).strip()}"
            return None

        journey.step("resolve platform plugin alongside project plugins", "plugins",
                     platform_plugin_is_available, cases=["S-043.7"],
                     requires=("step:register isolated project A and B",))

        def project_mcp_config() -> str | None:
            for project in projects:
                result = run(project, "mcp", "config", "codex", "--json", step_id="S-199.6")
                if result.returncode != 0:
                    return f"mcp config codex failed in {project.name}: {(result.stderr or result.stdout).strip()}"
                try:
                    payload = _cli_success(result)
                except ValueError as error:
                    return f"mcp config codex returned an invalid UX result in {project.name}: {error}"
                expected_url = project_service_path(ids[project], "mcp")
                if (payload.get("projectId") != ids[project]
                        or not isinstance(payload.get("url"), str)
                        or expected_url not in payload["url"]):
                    return f"mcp config codex did not return {project.name}'s registered project endpoint"
            return None

        journey.step("render MCP client config for both projects", "mcp", project_mcp_config,
                     cases=["S-199.6"], requires=("step:register isolated project A and B",))

        def current_project_config() -> str | None:
            for project in projects:
                value = json.dumps([{
                    "id": f"journey-{project.name}", "label": project.name, "path": ".",
                }])
                with invocation_context(step_id="journey.setup"):
                    configured = run_with_runner(command_runner,
                        kb_command([ "config", "set", "plugins.commit.scope.scopes", value, "--json"], executable=cli),
                        cwd=project, env=env, timeout=180)
                if configured.returncode != 0:
                    return f"could not prepare a project-specific config fixture for {project.name}"
                nested = project / "nested"
                nested.mkdir()
                result = run(nested, "config", "show", "--json", step_id="S-196.3")
                if result.returncode != 0:
                    return f"config show failed from {project.name} subdirectory: {(result.stderr or result.stdout).strip()}"
                try:
                    payload = _cli_success(result)
                except ValueError as error:
                    return f"config show returned an invalid UX result from {project.name} subdirectory: {error}"
                rows = payload.get("rows", []) if isinstance(payload, dict) else []
                scopes = next((row for row in rows if isinstance(row, dict)
                               and row.get("field") == "plugins.commit.scope.scopes"), None)
                if (not isinstance(scopes, dict) or scopes.get("source") not in ("project", "both")
                        or scopes.get("value") != json.loads(value)):
                    return f"config show did not return {project.name}'s project-scoped config from its subdirectory"
            return None

        journey.step("resolve effective config from each project subdirectory", "projects", current_project_config,
                     cases=["S-196.3"], requires=("step:register isolated project A and B",))

        def unknown_project_and_local_command() -> str | None:
            result = run(fixture_root, "config", "show", "--json", step_id="S-196.4")
            try:
                error = _cli_error(result)
            except ValueError as error:
                return f"config show outside registered projects returned an invalid UX result: {error}"
            if result.returncode == 0 or error.get("code") != "KB_PROJECT_UNKNOWN":
                return "project-scoped config show outside registered roots did not return KB_PROJECT_UNKNOWN"
            hint = error.get("hint", "")
            if "kb project add" not in hint and "cd" not in hint:
                return "KB_PROJECT_UNKNOWN did not explain the project registration or cd recovery"
            local = run(fixture_root, "--version", step_id="S-196.4")
            if local.returncode != 0:
                return "local-only --version failed outside registered projects"
            return None

        journey.step("reject unknown project context and keep local CLI commands available", "projects",
                     unknown_project_and_local_command, cases=["S-196.4"],
                     requires=("step:register isolated project A and B",))


def run_project_registration_case_steps(journey: Journey, cli: str, env: dict[str, str],
                                         runner=run_command) -> None:
    """Prove the installed CLI project registration contract from outside projects."""
    with tempfile.TemporaryDirectory(prefix="kb-project-registration-cases-", dir=env.get("HOME")) as directory:
        root = Path(directory)
        outside = root / "outside"
        outside.mkdir()
        projects = {name: root / name for name in ("project-a", "project-b", "project-c", "moved-project")}
        for project in projects.values():
            project.mkdir()
        ids: dict[str, str] = {}

        def run(cwd: Path, *args: str) -> CompletedProcess[str]:
            return run_with_runner(runner, kb_command([*args], executable=cli), cwd=cwd,
                                   env=env, timeout=120)

        def add_project(name: str) -> tuple[dict | None, str | None]:
            project = projects[name]
            result = run(outside, "project", "add", str(project), "--json")
            if result.returncode != 0:
                return None, f"kb project add failed for {name}: {(result.stderr or result.stdout).strip()}"
            try:
                payload = _cli_success(result)
            except ValueError as error:
                return None, f"kb project add returned an invalid UX result for {name}: {error}"
            row = payload.get("project", {}) if isinstance(payload, dict) else {}
            if not isinstance(row, dict) or row.get("path") != str(project.resolve()):
                return None, f"kb project add omitted the canonical path for {name}"
            identifier = row.get("id")
            if not isinstance(identifier, str) or not identifier:
                return None, f"kb project add omitted the ID for {name}"
            ids[name] = identifier
            return row, None

        def add_first() -> str | None:
            row, error = add_project("project-a")
            if error:
                return error
            if (projects["project-a"] / ".kb").exists():
                return "kb project add created .kb in project A"
            if not row.get("name"):
                return "kb project add omitted the project name"
            return None

        journey.step("register a project from outside registered projects", "projects", add_first,
                     cases=["S-124.1"])

        def add_without_kb() -> str | None:
            row, error = add_project("project-b")
            if error:
                return error
            if (projects["project-b"] / ".kb").exists():
                return "kb project add created .kb in project B"
            listed = run(outside, "project", "list", "--json")
            try:
                payload = _cli_success(listed)
            except ValueError as error:
                return f"project list returned an invalid UX result: {error}"
            rows = payload.get("projects", []) if isinstance(payload, dict) else []
            if not any(isinstance(item, dict) and item.get("id") == row.get("id")
                       and item.get("path") == str(projects["project-b"].resolve()) for item in rows):
                return "project list omitted the project without .kb"
            return None

        journey.step("register a directory without .kb", "projects", add_without_kb,
                     cases=["S-124.5"], requires=("step:register a project from outside registered projects",))

        def list_registered() -> str | None:
            result = run(outside, "project", "list", "--json")
            try:
                payload = _cli_success(result)
            except ValueError as error:
                return f"project list returned an invalid UX result: {error}"
            rows = payload.get("projects", []) if isinstance(payload, dict) else []
            by_id = {item.get("id"): item for item in rows if isinstance(item, dict)}
            for name in ("project-a", "project-b"):
                row = by_id.get(ids[name])
                if (not isinstance(row, dict) or row.get("path") != str(projects[name].resolve())
                        or row.get("name") != name or not isinstance(row.get("status"), str)):
                    return f"project list omitted complete registry details for {name}"
            if result.returncode != 0:
                return "project list failed outside registered projects"
            return None

        journey.step("list registered projects from outside them", "projects", list_registered,
                     cases=["S-124.2", "S-124.9"], requires=("step:register a directory without .kb",))

        def show_explicit() -> str | None:
            result = run(outside, "project", "show", ids["project-a"], "--json")
            try:
                payload = _cli_success(result)
            except ValueError as error:
                return f"project show returned an invalid UX result: {error}"
            row = payload.get("project", {}) if isinstance(payload, dict) else {}
            state_dir = row.get("stateDir")
            if (row.get("id") != ids["project-a"] or row.get("path") != str(projects["project-a"].resolve())
                    or row.get("name") != "project-a" or row.get("declaration") != "missing"
                    or not isinstance(row.get("status"), str) or not isinstance(state_dir, str)
                    or not Path(state_dir).is_absolute()):
                return "project show omitted the registered project's identity, declaration, status, or state directory"
            return None

        journey.step("show a project by ID from outside it", "projects", show_explicit,
                     cases=["S-124.3"], requires=("step:register a project from outside registered projects",))

        def show_unknown_path() -> str | None:
            result = run(outside, "project", "show", str(projects["moved-project"]), "--json")
            try:
                error = _cli_error(result)
            except ValueError as failure:
                return f"unknown project path returned an invalid UX result: {failure}"
            details = error.get("details", {})
            hint = error.get("hint", "")
            path = details.get("path", "") if isinstance(details, dict) else ""
            fixture_home = Path(env["HOME"]).resolve()
            redacted_path = path.replace(str(fixture_home), "~", 1) if isinstance(path, str) else ""
            expected_hint = catalogued_error_hint("KB_PROJECT_UNKNOWN", path=redacted_path)
            if (result.returncode == 0 or error.get("code") != "KB_PROJECT_UNKNOWN"
                    or not path or hint != expected_hint):
                return "project show did not return KB_PROJECT_UNKNOWN with its registration command"
            listed = run(outside, "project", "list", "--json")
            try:
                rows = _cli_success(listed).get("projects", [])
            except ValueError as failure:
                return f"project list returned an invalid UX result after unknown lookup: {failure}"
            if any(isinstance(item, dict) and item.get("path") == str(projects["moved-project"].resolve()) for item in rows):
                return "unknown project lookup changed the registry"
            return None

        journey.step("show an unregistered project path", "projects", show_unknown_path,
                     cases=["S-124.4"], requires=("step:register a project from outside registered projects",))

        def add_human() -> str | None:
            result = run(outside, "project", "add", str(projects["project-c"]))
            output = (result.stdout + result.stderr).strip()
            if result.returncode != 0 or "registered" not in output.lower() or output.startswith("{"):
                return "human project add did not report successful registration"
            if (projects["project-c"] / ".kb").exists():
                return "human project add created .kb in project C"
            return None

        journey.step("register a directory without .kb with human output", "projects", add_human,
                     cases=["S-124.6"], requires=("step:register a directory without .kb",))

        def remove_project() -> str | None:
            project_data = run(outside, "project", "show", ids["project-a"], "--json")
            try:
                row = _cli_success(project_data).get("project", {})
            except ValueError as error:
                return f"project show returned an invalid UX result before removal: {error}"
            state_dir = Path(row.get("stateDir", ""))
            if not str(state_dir) or state_dir == Path("."):
                return "project show omitted the runtime state directory before removal"
            (projects["project-a"] / ".kb").mkdir()
            (projects["project-a"] / ".kb" / "user-data").write_text("preserve project data\n", encoding="utf-8")
            state_dir.mkdir(parents=True, exist_ok=True)
            (state_dir / "user-data").write_text("preserve runtime state\n", encoding="utf-8")
            result = run(outside, "project", "remove", ids["project-a"], "--yes", "--json")
            try:
                payload = _cli_success(result)
            except ValueError as error:
                return f"project remove returned an invalid UX result: {error}"
            if result.returncode != 0 or payload.get("project", {}).get("id") != ids["project-a"]:
                return "project remove did not return the removed project"
            if (not projects["project-a"].is_dir()
                    or not (projects["project-a"] / ".kb" / "user-data").is_file()
                    or not (state_dir / "user-data").is_file()):
                return "project remove deleted the project folder, .kb data, or runtime state"
            listed = run(outside, "project", "list", "--json")
            try:
                rows = _cli_success(listed).get("projects", [])
            except ValueError as error:
                return f"project list returned an invalid UX result after removal: {error}"
            if any(isinstance(item, dict) and item.get("id") == ids["project-a"] for item in rows):
                return "project list still contains the removed project"
            return None

        journey.step("remove a project registration without deleting its folder", "projects", remove_project,
                     cases=["S-124.8"], requires=("step:register a project from outside registered projects",))

        def unknown_human_show() -> str | None:
            initialized = run_command(["git", "init", "--quiet", str(projects["moved-project"])],
                                      cwd=outside, env=env, timeout=30)
            if initialized.returncode != 0:
                return f"could not initialize unregistered project fixture: {initialized.stderr.strip()}"
            json_result = run(projects["moved-project"], "project", "show", "--json")
            try:
                error = _cli_error(json_result)
            except ValueError as failure:
                return f"JSON project show returned an invalid UX result: {failure}"
            if json_result.returncode == 0 or error.get("code") != "KB_PROJECT_UNKNOWN":
                return "JSON project show did not return KB_PROJECT_UNKNOWN for the initialized unregistered project"
            result = run(projects["moved-project"], "project", "show")
            output = (result.stdout + result.stderr).strip()
            fixture_home = Path(env["HOME"]).resolve()
            fixture_path = str(projects["moved-project"].resolve()).replace(str(fixture_home), "~", 1)
            expected_message = catalogued_error_message("KB_PROJECT_UNKNOWN").format(path=fixture_path)
            expected_hint = catalogued_error_hint("KB_PROJECT_UNKNOWN", path=fixture_path)
            expected_output = f"◆  Error\n│\n│  {expected_message} [KB_PROJECT_UNKNOWN]\n│  Hint: {expected_hint}\n│\n└  ✗"
            if result.returncode == 0 or output != expected_output:
                return "project show did not render the exact catalogue-owned KB_PROJECT_UNKNOWN message and hint"
            if output.startswith("{") or "Traceback" in output or " at " in output:
                return "project show printed JSON or a stack trace for KB_PROJECT_UNKNOWN"
            return None

        journey.step("show an initialized unregistered project in human mode", "projects", unknown_human_show,
                     cases=["S-051.1"], requires=("step:show an unregistered project path",))


def run_project_registry_corruption_case_step(
    journey: Journey,
    cli: str,
    env: dict[str, str],
    platform_root: Path,
    valid_project_id: str,
    service_token: str,
    gateway_request,
    runner=run_command,
) -> None:
    """Exercise one corrupt installed registry record through the CLI and host."""
    def verify_corrupt_record() -> str | None:
        registry_file = Path(env["KB_HOME"]) / "projects.json"
        original = registry_file.read_bytes() if registry_file.exists() else None
        failure: str | None = None
        cleanup_failure: str | None = None

        def invoke(cwd: Path, *args: str) -> CompletedProcess[str]:
            return run_with_runner(runner, kb_command([*args], executable=cli), cwd=cwd,
                                   env=env, timeout=120)

        def restart_host() -> CompletedProcess[str]:
            return run_with_runner(
                runner,
                ["kb-create", "restart", "--platform-root", str(platform_root), "--json"],
                cwd=Path(env["HOME"]), env=env, timeout=300,
            )

        with tempfile.TemporaryDirectory(prefix="kb-corrupt-project-registry-", dir=env["HOME"]) as directory:
            fixture = Path(directory)
            corrupt_project = fixture / "corrupt-project"
            corrupt_project.mkdir()
            try:
                added = invoke(fixture, "project", "add", str(corrupt_project), "--json")
                if added.returncode != 0:
                    failure = f"could not register the corruption fixture: {(added.stderr or added.stdout).strip()}"
                else:
                    try:
                        added_row = _cli_success(added).get("project", {})
                    except ValueError as error:
                        failure = f"registry fixture registration returned invalid CLI output: {error}"
                    else:
                        registered_id = added_row.get("id") if isinstance(added_row, dict) else None
                        if not isinstance(registered_id, str) or not registered_id:
                            failure = "registry fixture registration omitted its project ID"
                        else:
                            contents = json.loads(registry_file.read_text(encoding="utf-8"))
                            record_index = next((index for index, item in enumerate(contents["projects"])
                                                 if isinstance(item, dict) and item.get("id") == registered_id), None)
                            record = contents["projects"][record_index] if record_index is not None else None
                            if not isinstance(record, dict):
                                failure = "registry fixture record was not persisted"
                            else:
                                before_corruption = invoke(fixture, "project", "list", "--json")
                                try:
                                    before_rows = _cli_success(before_corruption).get("projects", [])
                                except ValueError as error:
                                    failure = f"could not snapshot valid projects before corruption: {error}"
                                    before_rows = []
                                valid_project_ids = {
                                    item.get("id") for item in before_rows
                                    if isinstance(item, dict) and isinstance(item.get("id"), str)
                                    and item.get("id") != registered_id
                                }
                                if not valid_project_ids or valid_project_id not in valid_project_ids:
                                    failure = "pre-corruption registry listing omitted its valid projects"
                                registered_ids = {item.get("id") for item in contents["projects"]
                                                  if isinstance(item, dict)}
                                sequence = 0
                                corrupt_id = f"prj_{sequence:016x}"
                                while corrupt_id in registered_ids:
                                    sequence += 1
                                    corrupt_id = f"prj_{sequence:016x}"
                                record["id"] = corrupt_id
                                registry_file.write_text(json.dumps(contents), encoding="utf-8")
                                corrupted_registry_bytes = registry_file.read_bytes()
                                redacted_record_path = str(record.get("path", "")).replace(
                                    str(Path(env["HOME"]).resolve()), "~", 1)
                                reason = f"projects[{record_index}].id {corrupt_id} does not match registered path {redacted_record_path}"
                                redacted_registry_file = str(registry_file).replace(
                                    str(Path(env["HOME"]).resolve()), "~", 1)
                                expected_diagnostic_message = catalogued_error_message(
                                    "KB_PROJECT_REGISTRY_CORRUPT").format(
                                        file=redacted_registry_file, reason=reason)
                                expected_diagnostic_hint = catalogued_error_hint(
                                    "KB_PROJECT_REGISTRY_CORRUPT", file=redacted_registry_file)

                                if failure is None:
                                    listed = invoke(fixture, "project", "list", "--json")
                                    try:
                                        list_result = _cli_success(listed)
                                        listed_rows = list_result.get("projects", [])
                                        diagnostics = list_result.get("diagnostics", [])
                                    except ValueError as error:
                                        failure = f"project list failed with a corrupt registry record: {error}"
                                    else:
                                        listed_ids = {item.get("id") for item in listed_rows if isinstance(item, dict)}
                                        if (listed.returncode != 0 or listed_ids != valid_project_ids
                                                or corrupt_id in listed_ids):
                                            failure = "project list did not preserve the complete valid project set"
                                        elif len(diagnostics) != 1 or not isinstance(diagnostics[0], dict) or (
                                            diagnostics[0].get("path") != record.get("path")
                                            or diagnostics[0].get("code") != "KB_PROJECT_REGISTRY_CORRUPT"
                                            or diagnostics[0].get("severity") != "warning"
                                            or diagnostics[0].get("message") != expected_diagnostic_message
                                            or diagnostics[0].get("hint") != expected_diagnostic_hint
                                            or "id" in diagnostics[0]
                                        ):
                                            failure = "project list omitted the catalogue-owned diagnostic for the corrupt record"

                                if failure is None:
                                    human = invoke(fixture, "project", "list")
                                    human_output = " ".join((human.stdout + human.stderr).split())
                                    if (human.returncode != 0 or "Project registry warnings" not in human_output
                                            or corrupt_id not in human_output
                                            or record.get("path", "") not in human_output
                                            or expected_diagnostic_message not in human_output
                                            or expected_diagnostic_hint not in human_output):
                                        failure = "human project list omitted the catalogue warning block, record identity, message, or hint"

                                if failure is None:
                                    scoped = invoke(corrupt_project, "config", "show", "--json")
                                    try:
                                        scoped_error = _cli_error(scoped)
                                    except ValueError as decode_error:
                                        failure = f"project-scoped command returned invalid corruption output: {decode_error}"
                                    else:
                                        scoped_file = scoped_error.get("details", {}).get("file", "")
                                        if (scoped.returncode == 0
                                                or scoped_error.get("code") != "KB_PROJECT_REGISTRY_CORRUPT"
                                                or scoped_error.get("hint") != catalogued_error_hint(
                                                    "KB_PROJECT_REGISTRY_CORRUPT", file=scoped_file)
                                                or scoped_error.get("code") == "KB_PROJECT_UNKNOWN"):
                                            failure = "project-scoped command hid registry corruption as an unknown project"

                                if failure is None:
                                    shown = invoke(fixture, "project", "show", corrupt_id, "--json")
                                    try:
                                        error = _cli_error(shown)
                                    except ValueError as decode_error:
                                        failure = f"project show returned invalid corruption output: {decode_error}"
                                    else:
                                        file_detail = error.get("details", {}).get("file", "")
                                        if (shown.returncode == 0 or error.get("code") != "KB_PROJECT_REGISTRY_CORRUPT"
                                                or error.get("hint") != catalogued_error_hint(
                                                    "KB_PROJECT_REGISTRY_CORRUPT", file=file_detail)
                                                or "kb project add" not in error.get("hint", "")):
                                            failure = "project show omitted the catalogued registry recovery error"
                                        if failure is None:
                                            human = invoke(fixture, "project", "show", corrupt_id)
                                            output = (human.stdout + human.stderr).strip()
                                            if (human.returncode == 0 or "KB_PROJECT_REGISTRY_CORRUPT" not in output
                                                    or error.get("hint") not in output
                                                    or output.startswith("{") or "Traceback" in output
                                                    or " at " in output):
                                                failure = "human project show omitted its typed error or printed a stack trace"

                                if failure is None:
                                    restarted = restart_host()
                                    if restarted.returncode != 0:
                                        failure = f"host restart failed with corrupt registry: {(restarted.stderr or restarted.stdout).strip()}"
                                    else:
                                        status, project_rows, _ = gateway_request("/api/v1/projects", service_token)
                                        host_ids = {item.get("id") for item in project_rows if isinstance(item, dict)} if isinstance(project_rows, list) else set()
                                        if status != 200 or host_ids != valid_project_ids:
                                            failure = "host did not list the complete valid project set after restart"
                                        for project_id in sorted(valid_project_ids) if failure is None else ():
                                            good_status, good_health, _ = gateway_request(
                                                project_service_path(project_id, "rest", "health"), service_token)
                                            if (good_status != 200 or not isinstance(good_health, dict)
                                                    or good_health.get("status") not in {"healthy", "degraded"}):
                                                failure = f"host did not serve valid project {project_id} after restart"
                                                break
                                        if failure is None:
                                            bad_status, bad_error, _ = gateway_request(
                                                project_service_path(corrupt_id, "rest", "health"), service_token)
                                            bad_details = bad_error.get("details", {}) if isinstance(bad_error, dict) else {}
                                            expected_bad_message = catalogued_error_message(
                                                "KB_PROJECT_REGISTRY_CORRUPT").format_map(bad_details)
                                            raw_exception_message = f"Project registry {registry_file} is invalid: {reason}"
                                            response_json = json.dumps(bad_error)
                                            if (bad_status != 500 or not isinstance(bad_error, dict)
                                                    or bad_error.get("code") != "KB_PROJECT_REGISTRY_CORRUPT"
                                                    or bad_error.get("message") != expected_bad_message
                                                    or bad_error.get("hint") != catalogued_error_hint(
                                                        "KB_PROJECT_REGISTRY_CORRUPT",
                                                        file=bad_error.get("details", {}).get("file", ""))
                                                    or "stack" in bad_error
                                                    or "cause" in bad_error
                                                    or "stack" in response_json.lower()
                                                    or raw_exception_message in response_json
                                                    or "Error:" in response_json
                                                    or " at " in response_json):
                                                failure = "host did not return the catalogued registry error for the corrupt project"
                                            if failure is None:
                                                logs = invoke(fixture, "logs", "query", "--level", "error",
                                                              "--limit", "100", "--json")
                                                try:
                                                    log_rows = _cli_success(logs).get("logs", [])
                                                except ValueError as error:
                                                    failure = f"host error log query returned invalid output: {error}"
                                                else:
                                                    relevant = [json.dumps(item) for item in log_rows
                                                                if isinstance(item, dict)]
                                                    if not any("KB_PROJECT_REGISTRY_CORRUPT" in row for row in relevant):
                                                        failure = "host log query omitted the registry corruption diagnostic"
                                                    elif any("Traceback" in row or "Error:" in row or " at " in row
                                                             for row in relevant):
                                                        failure = "host log exposed a raw stack trace for registry corruption"
                                if failure is None and registry_file.read_bytes() != corrupted_registry_bytes:
                                    failure = "CLI or host observation changed the corrupted project registry bytes"
            except Exception as error:
                failure = f"project registry corruption journey failed: {error}"
            finally:
                try:
                    if original is None:
                        registry_file.unlink(missing_ok=True)
                    else:
                        registry_file.write_bytes(original)
                    restored = restart_host()
                    if restored.returncode != 0:
                        cleanup_failure = "host restart failed after restoring the project registry"
                except Exception as error:
                    cleanup_failure = f"could not restore the project registry fixture: {error}"

        if failure and cleanup_failure:
            return f"{failure}; cleanup also failed: {cleanup_failure}"
        return failure or cleanup_failure

    journey.step("isolate one corrupt registry record from valid projects", "projects", verify_corrupt_record,
                 cases=["S-124.12"])


def run_project_identity_steps(journey: Journey, repo_root: Path) -> None:
    cli = repo_root / "cli/bin/dist/bin.js"

    def project_show_outside_registry() -> str | None:
        with tempfile.TemporaryDirectory(prefix="kb-project-identity-home-") as home, \
                tempfile.TemporaryDirectory(prefix="kb-project-identity-cwd-") as cwd:
            env = configure_hermetic_cli_fixture(
                Path(home), env=os.environ,
                source_config=repo_root / ".kb" / "kb.config.jsonc")
            result = run_command(
                ["node", str(cli), "project", "show", "--json"],
                cwd=cwd,
                env=env,
                capture_output=True,
                text=True,
                check=False,
                timeout=120,
            )
            try:
                error = _cli_error(result)
            except ValueError as error:
                return f"project show returned an invalid UX result: {error}"
            payload = error
            if result.returncode == 0 or error.get("code") != "KB_PROJECT_UNKNOWN":
                return f"unregistered cwd returned unexpected result: {payload}"
            if "kb project add" not in error.get("hint", ""):
                return f"unknown project hint did not explain registration: {error}"
            if (Path(cwd) / ".kb").exists():
                return "project show created a .kb directory in the unregistered repository"
            return None

    journey.step(
        "reject project identity outside the registry",
        "project",
        project_show_outside_registry,
        cases=["S-204.7"],
    )
