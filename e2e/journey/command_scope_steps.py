from __future__ import annotations

from installed_fixture import configure_hermetic_cli_fixture, layout_relative, layout_value

import json
import os
import tempfile
from pathlib import Path

from invocations import decode_ux_success_result, read_ux_cli_result, run_command
from service_steps import Journey


def run_command_scope_steps(journey: Journey, repo_root: Path) -> None:
    cli = repo_root / "cli/bin/dist/bin.js"

    def platform_project_commands_work_outside_registry() -> str | None:
        with tempfile.TemporaryDirectory(prefix="kb-command-scope-home-") as home, \
                tempfile.TemporaryDirectory(prefix="kb-command-scope-cwd-") as cwd, \
                tempfile.TemporaryDirectory(prefix="kb-command-scope-project-") as project:
            env = configure_hermetic_cli_fixture(
                Path(home), env=os.environ,
                workspace_root=repo_root,
                source_config=Path(__file__).resolve().parents[2] / ".kb" / "kb.config.jsonc")
            env.pop("KB_PROJECT_ROOT", None)

            def invoke(args: list[str]) -> tuple[int, dict]:
                result = run_command(
                    ["node", str(cli), *args],
                    cwd=cwd,
                    env=env,
                    capture_output=True,
                    text=True,
                    check=False,
                    timeout=120,
                )
                try:
                    return result.returncode, read_ux_cli_result(result)
                except ValueError as error:
                    raise AssertionError(f"{args!r} returned an invalid UX result: {error}") from error

            code, added = invoke(["project", "add", project, "--json"])
            if code != 0 or added.get("ok") is not True:
                return f"platform-scoped project add failed outside registry: {added}"
            project_id = added.get("data", {}).get("project", {}).get("id")
            if not project_id:
                return f"project add did not return an ID: {added}"

            code, listed = invoke(["project", "list", "--json"])
            if code != 0 or listed.get("ok") is not True:
                return f"platform-scoped project list failed outside registry: {listed}"
            if not any(row.get("id") == project_id for row in listed.get("data", {}).get("projects", [])):
                return f"project list omitted the registered project: {listed}"

            code, shown = invoke(["project", "show", project_id, "--json"])
            if code != 0 or shown.get("ok") is not True:
                return f"platform-scoped project show failed outside registry: {shown}"
            if shown.get("data", {}).get("project", {}).get("id") != project_id:
                return f"project show resolved the wrong explicit reference: {shown}"

            code, unknown = invoke(["config", "show", "--json"])
            error = unknown.get("error", {})
            if code == 0 or unknown.get("ok") is not False or error.get("code") != "KB_PROJECT_UNKNOWN":
                return f"project-scoped command did not return KB_PROJECT_UNKNOWN: {unknown}"
            hint = error.get("hint", "")
            if "kb project add" not in hint:
                return f"project-unknown hint lacks next action: {error}"
            return None

    journey.step(
        "resolve declared command scopes outside registered projects",
        "project",
        platform_project_commands_work_outside_registry,
        cases=["S-124.10"],
    )

    def global_help_and_version_do_not_initialize_a_project() -> str | None:
        with tempfile.TemporaryDirectory(prefix="kb-global-flags-home-") as home, \
                tempfile.TemporaryDirectory(prefix="kb-global-flags-cwd-") as cwd:
            env = configure_hermetic_cli_fixture(
                Path(home), env=os.environ,
                workspace_root=repo_root,
                source_config=Path(__file__).resolve().parents[2] / ".kb" / "kb.config.jsonc")
            env.pop("KB_PROJECT_ROOT", None)
            for args in (["--help"], ["--version"]):
                result = run_command(
                    ["node", str(cli), *args],
                    cwd=cwd,
                    env=env,
                    capture_output=True,
                    text=True,
                    check=False,
                    timeout=120,
                )
                if result.returncode != 0:
                    return f"{args!r} failed outside project registry: {result.stderr or result.stdout}"
                if not result.stdout.strip():
                    return f"{args!r} produced no output"
                if (Path(cwd) / ".kb").exists():
                    return f"{args!r} created .kb in an unregistered directory"
                if Path(env["KB_HOME"]).exists():
                    return f"{args!r} created platform state at KB_HOME"
            return None

    journey.step(
        "run global help and version outside registered projects",
        "cli",
        global_help_and_version_do_not_initialize_a_project,
        cases=["S-054.17", "PC-002.6"],
    )

    def platform_commands_work_without_project_or_config() -> str | None:
        with tempfile.TemporaryDirectory(prefix="kb-platform-command-home-") as home, \
                tempfile.TemporaryDirectory(prefix="kb-platform-command-cwd-") as cwd:
            env = configure_hermetic_cli_fixture(
                Path(home), env=os.environ,
                workspace_root=repo_root,
                source_config=Path(__file__).resolve().parents[2] / ".kb" / "kb.config.jsonc")
            env.pop("KB_PROJECT_ROOT", None)
            for args in (["hello", "--json"], ["logs", "query", "--json"]):
                result = run_command(
                    ["node", str(cli), *args],
                    cwd=cwd,
                    env=env,
                    capture_output=True,
                    text=True,
                    check=False,
                    timeout=120,
                )
                if result.returncode != 0:
                    return f"platform command {args!r} failed outside a registered project: {result.stderr or result.stdout}"
                try:
                    envelope = read_ux_cli_result(result)
                    payload = decode_ux_success_result(envelope)
                except ValueError as error:
                    return f"platform command {args!r} returned an invalid UX result: {error}"
                if args[0] == "hello":
                    if (not isinstance(payload, dict) or payload.get("message") != "Hello World"
                            or payload.get("status") != "ready"):
                        return f"platform command {args!r} returned unexpected greeting: {payload}"
            if (Path(cwd) / ".kb").exists():
                return "platform commands created project state in the unregistered cwd"
            return None

    journey.step(
        "run greeting and platform log query without project configuration",
        "cli",
        platform_commands_work_without_project_or_config,
        cases=["PC-002.7", "S-203.9"],
    )


def run_config_failure_steps(journey: Journey, repo_root: Path) -> None:
    cli = repo_root / "cli/bin/dist/bin.js"

    def invalid_project_configs_fail_before_handler() -> str | None:
        with tempfile.TemporaryDirectory(prefix="kb-config-failure-home-") as home, \
                tempfile.TemporaryDirectory(prefix="kb-config-failure-cwd-") as cwd, \
                tempfile.TemporaryDirectory(prefix="kb-config-failure-projects-") as projects:
            env = configure_hermetic_cli_fixture(
                Path(home), env=os.environ,
                workspace_root=repo_root,
                source_config=Path(__file__).resolve().parents[2] / ".kb" / "kb.config.jsonc")
            env.pop("KB_PROJECT_ROOT", None)

            def invoke(args: list[str], command_cwd: Path = cwd) -> tuple[int, dict]:
                result = run_command(
                    ["node", str(cli), *args], cwd=command_cwd, env=env,
                    capture_output=True, text=True, check=False, timeout=120,
                )
                try:
                    return result.returncode, read_ux_cli_result(result)
                except ValueError as error:
                    raise AssertionError(f"{args!r} returned an invalid UX result: {error}") from error

            project = Path(projects) / "registered"
            project.mkdir()
            code, added = invoke(["project", "add", str(project), "--json"])
            if code != 0 or added.get("ok") is not True:
                return f"could not register config fixture: {added}"
            state = Path(env["KB_HOME"]) / layout_value('sharedStateDirectory') / added["data"]["project"]["id"]
            settings = state / "config.jsonc"

            def expect_failure(target: Path, expected_hint: str, contents: str | None = None, directory: bool = False) -> str | None:
                if target.exists():
                    if target.is_dir():
                        import shutil
                        shutil.rmtree(target)
                    else:
                        target.unlink()
                if directory:
                    target.mkdir(parents=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(contents or "", encoding="utf-8")
                code, result = invoke(["config", "show", "--json"], project)
                error = result.get("error", {})
                if code != 1 or result.get("ok") is not False or error.get("code") != "KB_CONFIG_INVALID":
                    return f"invalid config at {target} did not fail with KB_CONFIG_INVALID: {result}"
                if str(target) not in error.get("message", "") or expected_hint not in error.get("hint", ""):
                    return f"config error omitted {target} or its expected repair hint: {error}"
                return None

            failure = expect_failure(settings, "python3 -m json.tool", '{ "platform": ')
            if failure:
                return failure
            failure = expect_failure(settings, "ls -l", directory=True)
            if failure:
                return failure
            failure = expect_failure(settings, "sed -n", "[]")
            if failure:
                return failure

            overlays = state / "overlays"
            def expect_overlay(target: Path, expected_hint: str, contents: str | None = None, directory: bool = False) -> str | None:
                if overlays.exists():
                    import shutil
                    shutil.rmtree(overlays)
                settings.write_text("{}", encoding="utf-8")
                return expect_failure(target, expected_hint, contents, directory)

            failure = expect_overlay(overlays / "broken.jsonc", "python3 -m json.tool", "{ broken")
            if failure:
                return failure
            failure = expect_overlay(overlays / "unreadable.jsonc", "ls -l", directory=True)
            if failure:
                return failure
            failure = expect_overlay(overlays / "array.jsonc", "sed -n", "[1,2,3]")
            if failure:
                return failure
            return None

    journey.step(
        "report malformed and unreadable config before command execution",
        "cli",
        invalid_project_configs_fail_before_handler,
        cases=["S-203.8"],
    )
