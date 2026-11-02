#!/usr/bin/env python3
"""Installed-project plugin scaffold, link, edit, and unlink journey."""
from __future__ import annotations

from kb_invocation import kb_command
from installed_fixture import layout_relative, layout_value
from marketplace_sync_fixture import (
    marketplace_sync_request_count,
    start_marketplace_sync_fixture,
    stop_marketplace_sync_fixture,
)

import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Callable

from service_steps import Journey
from invocations import (
    CompletedProcess,
    decode_ux_error_result,
    decode_ux_success_result,
    invocation_context,
    read_ux_cli_result,
    run_command,
    run_pty_command,
    run_with_runner,
)


PLUGIN_NAME = "demo"
PLUGIN_DIR = Path(".kb/plugins/demo")
ENTRY_DIR = PLUGIN_DIR
CORE_SOURCE = PLUGIN_DIR / "src/core/hello.ts"
ORIGINAL_GREETING = "Hello, ${who} from demo!"
EDITED_GREETING = "Edited demo greeting for ${who}!"


def _run(command: list[str], *, cwd: Path, env: dict[str, str],
         command_runner: Callable[..., CompletedProcess[str]]) -> str:
    result = command_runner(command, cwd=cwd, env=env, text=True, check=False)
    output = (result.stdout or "") + (result.stderr or "")
    if result.returncode != 0:
        detail = " ".join(output.split())
        raise RuntimeError(f"{' '.join(command)} exited {result.returncode}; {detail or 'no output'}")
    return output


def _invoke(command: list[str], *, cwd: Path, env: dict[str, str],
            command_runner: Callable[..., CompletedProcess[str]]) -> CompletedProcess[str]:
    return run_with_runner(command_runner, command, cwd=cwd, env=env, timeout=300)


def _plugins(kb: Path, *, cwd: Path, env: dict[str, str], command_runner) -> list[dict]:
    result = _invoke([str(kb), "marketplace", "plugins", "list", "--json"],
                     cwd=cwd, env=env, command_runner=command_runner)
    data = decode_ux_success_result(read_ux_cli_result(result))
    entries = data.get("entries") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        raise RuntimeError("kb marketplace plugins list --json returned no entries array")
    return entries


def _record_local_anonymous_scope_step(journey: Journey, project: Path, kb_path: Path,
                                       env: dict[str, str], command_runner) -> None:
    """Prove local commands and the newly linked plugin work without a saved session."""
    session_path = Path(env.get("HOME", Path.home())) / ".kb/session.json"

    def local_commands_and_plugin_work() -> str | None:
        if session_path.exists():
            return f"local anonymous command fixture unexpectedly has a saved human session at {session_path}"
        for arguments in (["workflow", "defs", "list", "--json"],
                          ["marketplace", "plugins", "list", "--json"]):
            command = [str(kb_path), *arguments]
            with invocation_context(step_id="S-041.10"):
                result = run_with_runner(command_runner, command, cwd=project, env=env,
                                         timeout=120)
            try:
                payload = read_ux_cli_result(result)
            except ValueError as error:
                return f"{' '.join(command)} returned an invalid UX result: {error}"
            if result.returncode != 0 or payload.get("ok") is not True:
                return f"{' '.join(command)} did not pass the local auth gate: {payload}"

        command = [str(kb_path), "demo", "hello"]
        with invocation_context(step_id="S-041.10"):
            result = run_with_runner(command_runner, command, cwd=project, env=env,
                                     timeout=120)
        output = (result.stdout or "") + (result.stderr or "")
        if result.returncode != 0 or "Hello, World from demo!" not in output:
            return f"{' '.join(command)} did not pass local authorization and invoke the linked plugin: {output.strip()}"
        return None

    journey.step("run local platform and linked-plugin commands without a saved session",
                 "plugin-author", local_commands_and_plugin_work, cases=["S-041.10"])


def _lock_entry(project: Path) -> tuple[dict, str, dict]:
    lock_path = project / layout_value('versionStatePaths.kb_marketplace_lock')
    if not lock_path.is_file():
        raise RuntimeError("project .kb/marketplace.lock was not created by marketplace plugins add")
    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise RuntimeError("project .kb/marketplace.lock is not valid JSON") from error
    plugins = lock.get("plugins") if isinstance(lock, dict) else None
    matches = [
        (plugin_id, entry)
        for plugin_id, entry in plugins.items()
        if isinstance(entry, dict) and entry.get("link") == str(ENTRY_DIR)
    ] if isinstance(plugins, dict) else []
    if len(matches) != 1:
        raise RuntimeError("project .kb/marketplace.lock does not contain one entry for the linked demo package")
    plugin_id, entry = matches[0]
    return lock, plugin_id, entry


def _json_payload(result: CompletedProcess[str], command: list[str]) -> dict:
    payload = decode_ux_success_result(read_ux_cli_result(result))
    if not isinstance(payload, dict):
        raise ValueError(f"`{' '.join(command)}` success data is not a JSON object")
    return payload


def _find_plan(payload: object) -> dict | None:
    if isinstance(payload, dict):
        plan = payload.get("plan")
        if isinstance(plan, dict):
            return plan
        for value in payload.values():
            found = _find_plan(value)
            if found is not None:
                return found
    elif isinstance(payload, list):
        for value in payload:
            found = _find_plan(value)
            if found is not None:
                return found
    return None


def _git(args: list[str], *, project: Path, env: dict[str, str]) -> str:
    command = ["git", *args]
    with invocation_context():
        result = run_with_runner(run_command, command, cwd=project, env=env, timeout=60)
    if result.returncode != 0:
        detail = " ".join((result.stdout or "").split())
        raise RuntimeError(f"{' '.join(command)} exited {result.returncode}; {detail or 'no output'}")
    return result.stdout or ""


def _stage_case_file(project: Path, env: dict[str, str], label: str) -> Path:
    case_dir = project / ".kb" / "journey-commit-cases"
    case_dir.mkdir(parents=True, exist_ok=True)
    path = case_dir / f"{label}.ts"
    path.write_text(f"export const {label.replace('-', '_')} = 'journey fixture';\n", encoding="utf-8")
    _git(["add", str(path.relative_to(project))], project=project, env=env)
    return path


def _validate_plugin_route_help(route: list[str], result: CompletedProcess[str]) -> None:
    if result.returncode == 0:
        return

    output = "\n".join(part for part in (result.stdout, result.stderr) if part).strip()
    error_code = None
    for part in (result.stdout, result.stderr):
        try:
            envelope = json.loads(part)
        except (json.JSONDecodeError, TypeError):
            continue
        error = envelope.get("error") if isinstance(envelope, dict) else None
        if isinstance(error, dict) and isinstance(error.get("code"), str):
            error_code = error["code"]
            break

    if error_code == "KB_RUNTIME_UNKNOWN_COMMAND":
        raise RuntimeError(
            f"journey command {' '.join(route)!r} is absent from the live CLI registry: "
            f"{output or 'no output'}"
        )

    raise RuntimeError(
        f"journey command {' '.join(route)!r} help preflight failed "
        f"(exit {result.returncode}): {output or 'no output'}"
    )


def run_commit_case_steps(journey: Journey, project: Path, kb_path: Path, registry: str,
                          command_runner: Callable[..., CompletedProcess[str]],
                          env: dict[str, str]) -> None:
    """Claim Commit generation, Review, and progress behavior in the installed fixture project."""
    project = project.resolve()
    env = env.copy()
    env["NPM_CONFIG_REGISTRY"] = registry

    def cli(args: list[str], *, step_id: str | None = None) -> CompletedProcess[str]:
        command = [str(kb_path), *args]
        if args[0] in {"commit", "review"}:
            route = args[:next((index for index, token in enumerate(args) if token.startswith("-")), len(args))]
            help_command = [str(kb_path), *route, "--help", "--json"]
            with invocation_context():
                declared = run_with_runner(command_runner, help_command, cwd=project, env=env, timeout=120)
            _validate_plugin_route_help(route, declared)
        context = invocation_context(step_id=step_id) if step_id else invocation_context()
        with context:
            return run_with_runner(command_runner, command, cwd=project, env=env, timeout=180)

    def install_plugins() -> None:
        lock_path = project / ".kb" / "marketplace.lock"
        try:
            lock = json.loads(lock_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError("Commit case flow requires the Marketplace-installed project lock") from error
        plugins = lock.get("plugins") if isinstance(lock, dict) else None
        commit = plugins.get("@kb-labs/commit") if isinstance(plugins, dict) else None
        if (not isinstance(commit, dict) or commit.get("enabled", True) is not True
                or commit.get("package") != "@kb-labs/commit"):
            raise RuntimeError("Commit case flow requires @kb-labs/commit (package @kb-labs/commit) enabled by the Marketplace flow")
        package = "@kb-labs/review"
        result = cli(["marketplace", "install", package, "--json"])
        if result.returncode != 0:
            raise RuntimeError(f"marketplace could not install {package}: {(result.stdout + result.stderr)[-800:]}")

    def ensure_git_fixture() -> None:
        head = run_with_runner(run_command, ["git", "rev-parse", "--verify", "HEAD"],
                               cwd=project, env=env, timeout=60)
        needs_initial_commit = head.returncode != 0
        if needs_initial_commit:
            _git(["init"], project=project, env=env)
            seed = project / ".kb" / "journey-commit-cases" / "seed.txt"
            seed.parent.mkdir(parents=True, exist_ok=True)
            seed.write_text("commit fixture seed\n", encoding="utf-8")
        _git(["config", "user.name", "Journey Fixture"], project=project, env=env)
        _git(["config", "user.email", "journey@example.test"], project=project, env=env)
        if needs_initial_commit:
            _git(["add", ".kb"], project=project, env=env)
            _git(["commit", "-m", "chore: initialize journey fixture"], project=project, env=env)

    prepared = journey.step("prepare Commit and Review case fixtures", "plugin-author",
                            lambda: (install_plugins(), ensure_git_fixture(), None)[-1])
    if prepared.status != "PASS":
        cases = [f"S-014.{step}" for step in range(1, 4)]
        cases.extend(f"S-015.{step}" for step in range(1, 5))
        cases.extend(f"S-030.{step}" for step in range(1, 5))
        cases.extend(f"S-160.{step}" for step in range(1, 5))
        for case_id in cases:
            journey.blocked(f"{case_id} Commit and Review flow", "plugin-author",
                            "blocked because Commit/Review fixture preparation failed", cases=[case_id])
        return

    _stage_case_file(project, env, "s014-generate")
    before_s014 = _git(["rev-parse", "HEAD"], project=project, env=env).strip()
    before_s014_status = _git(["status", "--porcelain=v1", "--untracked-files=all"], project=project, env=env)

    def s014_dry_run() -> None:
        command = ["commit", "commit", "--dry-run", "--json"]
        result = cli(command, step_id="S-014.1")
        payload = _json_payload(result, kb_command([ *command], executable=str(kb_path)))
        plan = _find_plan(payload)
        after = _git(["rev-parse", "HEAD"], project=project, env=env).strip()
        after_status = _git(["status", "--porcelain=v1", "--untracked-files=all"], project=project, env=env)
        if (result.returncode != 0 or not plan or plan.get("metadata", {}).get("llmUsed") is not True
                or payload.get("applied") is not False or after != before_s014 or after_status != before_s014_status):
            raise RuntimeError("S-014.1 expected a preview-only LLM plan without changing Git state")

    journey.step("generate a real-provider Commit plan without applying it", "plugin-author",
                 s014_dry_run, cases=["S-014.1"])

    def s014_provider() -> None:
        adapter_cmd = ["adapter", "list", "--json"]
        adapters_result = cli(adapter_cmd, step_id="S-014.2")
        payload = _json_payload(adapters_result, kb_command([ *adapter_cmd], executable=str(kb_path)))
        raw = json.dumps(payload).lower()
        if "@kb-labs/adapters-openai" not in raw:
            raise RuntimeError("S-014.2 could not identify the configured real LLM provider")

    journey.step("identify the selected real LLM provider", "plugin-author", s014_provider, cases=["S-014.2"])

    _stage_case_file(project, env, "s014-apply")

    def s014_apply() -> None:
        command = ["commit", "commit", "--json"]
        result = cli(command, step_id="S-014.3")
        payload = _json_payload(result, kb_command([ *command], executable=str(kb_path)))
        subject = _git(["log", "-1", "--format=%s"], project=project, env=env).strip()
        if result.returncode != 0 or payload.get("applied") is not True or not subject.startswith(("test(", "chore(", "feat(", "fix(")):
            raise RuntimeError(f"S-014.3 did not create a conventional generated commit: {subject!r}")

    journey.step("apply a generated Commit plan", "plugin-author", s014_apply, cases=["S-014.3"])

    _stage_case_file(project, env, "s015-review")

    def s015_heuristic() -> None:
        command = ["review", "run", "--mode=heuristic"]
        result = cli(command, step_id="S-015.1")
        if result.returncode != 0 or "Files:" not in result.stdout:
            raise RuntimeError("S-015.1 did not complete and identify the reviewed change set")

    journey.step("review changed files with heuristic mode", "plugin-author", s015_heuristic, cases=["S-015.1"])

    def s015_findings() -> None:
        command = ["review", "run", "--mode=heuristic", "--json"]
        result = cli(command, step_id="S-015.2")
        payload = _json_payload(result, kb_command([ *command], executable=str(kb_path)))
        findings = payload.get("findings")
        if not isinstance(findings, list):
            raise RuntimeError("S-015.2 review JSON contains no findings array")
        for finding in findings:
            if (not isinstance(finding, dict) or not isinstance(finding.get("file"), str)
                    or not isinstance(finding.get("line"), int)):
                raise RuntimeError("S-015.2 produced a finding without file path and line reference")

    journey.step("inspect heuristic review findings", "plugin-author", s015_findings, cases=["S-015.2"])

    def s015_json() -> None:
        command = ["review", "run", "--json"]
        result = cli(command, step_id="S-015.3")
        payload = _json_payload(result, kb_command([ *command], executable=str(kb_path)))
        if result.returncode != 0 or not isinstance(payload.get("findings"), list):
            raise RuntimeError("S-015.3 did not return a valid JSON review result")

    journey.step("return a JSON review result", "plugin-author", s015_json, cases=["S-015.3"])

    def missing_llm_review() -> None:
        with invocation_context():
            unbind = run_with_runner(command_runner,
                kb_command([ "adapter", "unbind", "llm", "--scope", "platform", "--json"], executable=str(kb_path)),
                cwd=project, env=env, timeout=60)
        if unbind.returncode != 0:
            raise RuntimeError("could not remove the platform LLM binding for S-015.4")
        command = ["review", "run", "--mode=llm", "--json"]
        result = cli(command, step_id="S-015.4")
        output = result.stdout + result.stderr
        if (result.returncode == 0 or "KB_ADAPTER_UNAVAILABLE" not in output
                or "kb adapter bind llm" not in output):
            raise RuntimeError(f"S-015.4 did not return the typed missing-LLM guidance: {output[-800:]}")
        with invocation_context():
            restore = run_with_runner(command_runner,
                kb_command([ "adapter", "bind", "llm", "@kb-labs/adapters-openai", "--scope", "platform", "--json"], executable=str(kb_path)),
                cwd=project, env=env, timeout=60)
        if restore.returncode != 0:
            raise RuntimeError("could not restore the platform LLM binding after S-015.4")

    journey.step("report missing LLM capability for deep Review", "plugin-author",
                 missing_llm_review, cases=["S-015.4"])

    _stage_case_file(project, env, "s160-dry-run")
    before_s160 = _git(["rev-parse", "HEAD"], project=project, env=env).strip()
    before_s160_status = _git(["status", "--porcelain=v1", "--untracked-files=all"], project=project, env=env)

    def s160_dry_run() -> None:
        command = ["commit", "commit", "--dry-run", "--json"]
        result = cli(command, step_id="S-160.1")
        payload = _json_payload(result, kb_command([ *command], executable=str(kb_path)))
        plan = _find_plan(payload)
        after = _git(["rev-parse", "HEAD"], project=project, env=env).strip()
        after_status = _git(["status", "--porcelain=v1", "--untracked-files=all"], project=project, env=env)
        if (not plan or plan.get("metadata", {}).get("llmUsed") is not True or payload.get("applied") is not False
                or after != before_s160 or after_status != before_s160_status):
            raise RuntimeError("S-160.1 expected JSON preview output without changing Git state")

    journey.step("preview the deterministic fixture Commit plan", "plugin-author",
                 s160_dry_run, cases=["S-160.1"])

    def s160_missing_llm() -> None:
        with invocation_context():
            unbind = run_with_runner(command_runner,
                kb_command([ "adapter", "unbind", "llm", "--scope", "platform", "--json"], executable=str(kb_path)),
                cwd=project, env=env, timeout=60)
        if unbind.returncode != 0:
            raise RuntimeError("could not remove the platform LLM binding for S-160.2")
        command = ["commit", "commit", "--dry-run"]
        result = cli(command, step_id="S-160.2")
        output = result.stdout + result.stderr
        if (result.returncode == 0 or "KB_ADAPTER_UNAVAILABLE" not in output
                or "llm" not in output.lower() or "kb adapter bind llm" not in output):
            raise RuntimeError(f"S-160.2 did not return the typed missing-LLM guidance: {output[-800:]}")
        with invocation_context():
            restore = run_with_runner(command_runner,
                kb_command([ "adapter", "bind", "llm", "@kb-labs/adapters-openai", "--scope", "platform", "--json"], executable=str(kb_path)),
                cwd=project, env=env, timeout=60)
        if restore.returncode != 0:
            raise RuntimeError("could not restore the deterministic fixture LLM binding after S-160.2")

    journey.step("report missing deterministic LLM capability", "plugin-author",
                 s160_missing_llm, cases=["S-160.2"])

    _stage_case_file(project, env, "s160-apply")

    def s160_apply() -> None:
        command = ["commit", "commit", "--json"]
        result = cli(command, step_id="S-160.3")
        payload = _json_payload(result, kb_command([ *command], executable=str(kb_path)))
        subject = _git(["log", "-1", "--format=%s"], project=project, env=env).strip()
        if result.returncode != 0 or payload.get("applied") is not True or subject != "test(journey): verify deterministic commit fixture response":
            raise RuntimeError(f"S-160.3 did not apply the deterministic fixture subject: {subject!r}")

    journey.step("apply the deterministic fixture Commit plan", "plugin-author",
                 s160_apply, cases=["S-160.3"])

    before_s160_noop = _git(["rev-parse", "HEAD"], project=project, env=env).strip()
    before_s160_noop_status = _git(["status", "--porcelain=v1", "--untracked-files=all"], project=project, env=env)

    def s160_no_changes() -> None:
        command = ["commit", "commit", "--json"]
        result = cli(command, step_id="S-160.4")
        payload = _json_payload(result, kb_command([ *command], executable=str(kb_path)))
        plan = _find_plan(payload)
        after = _git(["rev-parse", "HEAD"], project=project, env=env).strip()
        after_status = _git(["status", "--porcelain=v1", "--untracked-files=all"], project=project, env=env)
        if (result.returncode != 0 or not plan or plan.get("commits") != []
                or payload.get("applied") is not False or payload.get("commits") != []
                or after != before_s160_noop or after_status != before_s160_noop_status):
            raise RuntimeError("S-160.4 expected a successful empty result without changing Git state")

    journey.step("return a successful empty Commit result", "plugin-author",
                 s160_no_changes, cases=["S-160.4"])

    _stage_case_file(project, env, "s030-progress")

    def s030_progress() -> str:
        seen: list[str] = []
        command = kb_command([ "commit", "commit", "--dry-run"], executable=str(kb_path))
        with invocation_context(step_id="S-030.1"):
            result, _ = run_pty_command(command, cwd=project, env=env, timeout=90,
                                        on_output=lambda output: seen.append(output) or None)
        text = "".join(seen) or result.stdout
        phases = [match.start() for match in re.finditer(
            r"Analyzing changes|Analyzing with native tools|Re-analyzing with diff context|Plan generated|Generated commit plan",
            text, re.I,
        )]
        if result.returncode != 0 or len(phases) < 3 or not re.search(r"[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]", text):
            raise RuntimeError("S-030.1 did not show active generation progress before a final plan")
        return text

    progress_text = ""
    def claim_s030_progress() -> None:
        nonlocal progress_text
        progress_text = s030_progress()
    journey.step("observe Commit generation progress", "plugin-author",
                 claim_s030_progress, cases=["S-030.1"])

    def s030_phase_update() -> None:
        if not re.search(r"Re-analyzing with diff context|fetching diff|Phase 2", progress_text, re.I):
            raise RuntimeError("S-030.2 did not observe a subsequent generation phase while the command ran")

    journey.step("observe a subsequent Commit generation phase", "plugin-author",
                 s030_phase_update, cases=["S-030.2"])

    _stage_case_file(project, env, "s030-cancel")
    before_cancel = _git(["rev-parse", "HEAD"], project=project, env=env).strip()

    def s030_cancel() -> None:
        sent_interrupt = False
        command = kb_command([ "commit", "commit", "--dry-run"], executable=str(kb_path))
        def interrupt_on_generation(output: str) -> str | None:
            nonlocal sent_interrupt
            if not sent_interrupt and re.search(r"Analyzing with native tools|Re-analyzing with diff context", output, re.I):
                sent_interrupt = True
                return "\x03"
            return None
        with invocation_context(step_id="S-030.3"):
            result, _ = run_pty_command(command, cwd=project, env=env, timeout=90,
                                        on_output=interrupt_on_generation)
        transcript = result.stdout
        if not sent_interrupt or result.returncode == 0 or "EPIPE" in transcript:
            raise RuntimeError("S-030.3 did not interrupt active generation cleanly without worker EPIPE")

    journey.step("interrupt active Commit generation", "plugin-author", s030_cancel, cases=["S-030.3"])

    def s030_history() -> None:
        after = _git(["rev-parse", "HEAD"], project=project, env=env).strip()
        if before_cancel != after:
            raise RuntimeError("S-030.4 found a Git commit created by the interrupted dry-run")

    journey.step("verify cancellation did not create a commit", "plugin-author",
                 s030_history, cases=["S-030.4"])

    def cleanup_review_plugin() -> None:
        command = ["marketplace", "uninstall", "@kb-labs/review", "--json"]
        result = cli(command)
        if result.returncode != 0:
            raise RuntimeError("could not remove the temporary Review plugin fixture")

    journey.step("remove temporary Review plugin fixture", "plugin-author", cleanup_review_plugin)

    def finalize_project_baseline() -> None:
        _git(["add", "-A"], project=project, env=env)
        status = _git(["status", "--porcelain=v1", "--untracked-files=all"], project=project, env=env)
        if not status:
            return
        _git(["commit", "-m", "chore(journey): finalize Commit case fixture"], project=project, env=env)
        remaining = _git(["status", "--porcelain=v1", "--untracked-files=all"], project=project, env=env)
        if remaining:
            raise RuntimeError("Commit case fixture still has staged or untracked changes after finalization")

    finalize_project_baseline()


def run_plugin_author_flow(
    journey: Journey,
    project_root: Path,
    kb_path: Path,
    registry: str,
    *,
    command_runner: Callable[..., CompletedProcess[str]] = run_command,
    base_env: dict[str, str] | None = None,
) -> None:
    """Run S-003 in an installed project and record each catalog step."""
    project = project_root.resolve()
    original_runner = command_runner
    def command_runner(command, **kwargs):
        options = dict(kwargs)
        timeout = options.pop("timeout", 300)
        options.pop("capture_output", None)
        options.pop("text", None)
        options.pop("stdout", None)
        options.pop("stderr", None)
        result = run_with_runner(original_runner, command, timeout=timeout, **options)
        stdout = result.stdout or ""
        stderr = result.stderr or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode(errors="replace")
        if isinstance(stderr, bytes):
            stderr = stderr.decode(errors="replace")
        return CompletedProcess(command, result.returncode, stdout=stdout, stderr=stderr)
    plugin_root = project / PLUGIN_DIR
    entry = project / ENTRY_DIR
    core_source = project / CORE_SOURCE
    child_env = (base_env or os.environ).copy()
    child_env["NPM_CONFIG_REGISTRY"] = registry
    linked = False

    def record(name: str, *, cases: list[str], check: Callable[[], None]) -> bool:
        return journey.step(name, "plugin-author", lambda: check() or None,
                            cases=cases).status == "PASS"

    def _scaffold() -> None:
        _run(kb_command([ "scaffold", "run", "plugin", PLUGIN_NAME,
              "--mode", "standalone", "--yes"], executable=str(kb_path)),
             cwd=project, env=child_env, command_runner=command_runner)
        if not entry.is_dir() or not (entry / "package.json").is_file() or not core_source.is_file():
            raise RuntimeError("kb scaffold run did not create one .kb/plugins/demo package with CLI and core source")
        package = json.loads((entry / "package.json").read_text(encoding="utf-8"))
        if package.get("name") != "@kb-labs/demo":
            raise RuntimeError("generated demo package name does not match its @kb-labs/demo manifest identity")
        command_source = entry / "src/cli/commands/hello.ts"
        source = command_source.read_text(encoding="utf-8")
        marker = "const { greeting } = hello({ who: input.flags.who ?? 'World' });"
        if marker not in source:
            raise RuntimeError("generated demo command no longer matches the scaffold template")
        command_source.write_text(source.replace(
            marker,
            "await ctx.runtime.fs.writeFile('.kb/output/runtime-temp-probe.txt', 'plugin temp fs ok');\n        " + marker,
            1,
        ), encoding="utf-8")

    def _build() -> None:
        _run(["pnpm", "install"], cwd=plugin_root, env=child_env, command_runner=command_runner)
        _run(["pnpm", "build"], cwd=plugin_root, env=child_env, command_runner=command_runner)
        if not (entry / "dist/manifest.js").is_file():
            raise RuntimeError("pnpm -w build did not emit the plugin manifest")

    def _link() -> None:
        nonlocal linked
        _run(kb_command([ "marketplace", "plugins", "add", "--link", ".kb/plugins/demo"], executable=str(kb_path)),
             cwd=project, env=child_env, command_runner=command_runner)
        linked = True
        _, plugin_id, lock_entry = _lock_entry(project)
        listed = _plugins(kb_path, cwd=project, env=child_env, command_runner=command_runner)
        if not any(item.get("id") == plugin_id and item.get("source") == "local"
                   and item.get("scope") == "project" for item in listed if isinstance(item, dict)):
            raise RuntimeError("linked plugin ID is not listed as a local project plugin after marketplace plugins add")
        if lock_entry.get("source") != "local" or lock_entry.get("link") != str(ENTRY_DIR):
            raise RuntimeError("project marketplace.lock does not record demo's local relative link path")

    def _docs_reference() -> None:
        docs_dir = project / "docs"
        docs_dir.mkdir(parents=True, exist_ok=True)
        output_path = docs_dir / "CLI-REFERENCE.md"
        output_path.unlink(missing_ok=True)
        command = kb_command(["docs", "generate-cli-reference", "--output", "docs/CLI-REFERENCE.md"],
                             executable=str(kb_path))
        with invocation_context(step_id="S-003.7"):
            result = _invoke(command, cwd=project, env=child_env, command_runner=command_runner)
        if result.returncode != 0 or not output_path.is_file():
            raise RuntimeError("kb docs generate-cli-reference did not write docs/CLI-REFERENCE.md from the registered project")
        if "# KB Labs CLI Reference" not in output_path.read_text(encoding="utf-8"):
            raise RuntimeError("generated docs/CLI-REFERENCE.md does not contain the CLI reference")

        with tempfile.TemporaryDirectory(prefix="kb-cli-reference-unregistered-") as outside:
            outside_project = Path(outside)
            (outside_project / "docs").mkdir()
            outside_output = outside_project / "docs/CLI-REFERENCE.md"
            with invocation_context(step_id="S-003.7"):
                outside_result = _invoke(command, cwd=outside_project, env=child_env,
                                         command_runner=command_runner)
            if outside_result.returncode == 0 or outside_output.exists():
                raise RuntimeError("kb docs generate-cli-reference succeeded or wrote output outside a registered project")
            try:
                error = read_ux_cli_result(outside_result).get("error", {})
            except ValueError as parse_error:
                raise RuntimeError(f"outside-project docs command returned an invalid UX result: {parse_error}") from parse_error
            if not isinstance(error, dict) or error.get("code") != "KB_PROJECT_UNKNOWN":
                raise RuntimeError("outside-project docs command did not return KB_PROJECT_UNKNOWN")

    def _reject_absolute_plugin_link() -> None:
        fixture_process, marketplace_url, startup_error = start_marketplace_sync_fixture(
            project, child_env, request_recorder=True)
        if startup_error or fixture_process is None or marketplace_url is None:
            raise RuntimeError(startup_error or "Marketplace request recorder did not start")
        try:
            lock_path = project / layout_value('versionStatePaths.kb_marketplace_lock')
            before = lock_path.read_bytes()
            command = kb_command(["marketplace", "plugins", "add", "--link", str(entry.resolve())],
                                 executable=str(kb_path))
            command_env = child_env.copy()
            command_env["KB_MARKETPLACE_URL"] = marketplace_url
            with invocation_context(step_id="S-003.8"):
                result = _invoke(command, cwd=project, env=command_env, command_runner=command_runner)
            request_count = marketplace_sync_request_count(marketplace_url, command_env)
        finally:
            cleanup_error = stop_marketplace_sync_fixture(fixture_process)
        if cleanup_error:
            raise RuntimeError(cleanup_error)
        try:
            payload = read_ux_cli_result(result)
            failure = decode_ux_error_result(payload)
        except ValueError as error:
            raise RuntimeError(f"absolute plugin link returned an invalid UX result: {error}") from error
        message = failure["message"]
        if (result.returncode == 0 or failure["code"] != "KB_RUNTIME_INPUT_INVALID"
                or "The --link path must be relative to the selected scope directory." not in message
                or request_count != 0
                or lock_path.read_bytes() != before):
            raise RuntimeError("absolute --link path was not rejected with its catalog code before Marketplace access or project registration mutation")

    def _invoke_original() -> None:
        help_output = _run(kb_command([ "--help"], executable=str(kb_path)), cwd=project, env=child_env,
                           command_runner=command_runner)
        if "demo" not in help_output:
            raise RuntimeError("kb --help did not list the demo command group")
        output = _run(kb_command([ "demo", "hello"], executable=str(kb_path)), cwd=project, env=child_env,
                      command_runner=command_runner)
        if "Hello, World from demo!" not in output:
            raise RuntimeError("kb demo hello did not print its documented greeting")
        probe = project / ".kb/output/runtime-temp-probe.txt"
        if not probe.is_file() or probe.read_text(encoding="utf-8") != "plugin temp fs ok":
            raise RuntimeError("S-210.1 did not write and persist the plugin temp filesystem probe")

    def _edit_build_invoke() -> None:
        source = core_source.read_text(encoding="utf-8")
        if ORIGINAL_GREETING not in source:
            raise RuntimeError("generated demo greeting source no longer matches the scaffold template")
        core_source.write_text(source.replace(ORIGINAL_GREETING, EDITED_GREETING, 1), encoding="utf-8")
        _run(["pnpm", "build"], cwd=plugin_root, env=child_env, command_runner=command_runner)
        output = _run(kb_command([ "demo", "hello"], executable=str(kb_path)), cwd=project, env=child_env,
                      command_runner=command_runner)
        if "Edited demo greeting for World!" not in output:
            raise RuntimeError("kb demo hello did not show the greeting after rebuilding the edited source")

    def _remove() -> None:
        _, plugin_id, _ = _lock_entry(project)
        _run(kb_command([ "marketplace", "plugins", "remove", plugin_id], executable=str(kb_path)),
             cwd=project, env=child_env, command_runner=command_runner)
        if any(item.get("id") == plugin_id for item in _plugins(
                kb_path, cwd=project, env=child_env, command_runner=command_runner)
               if isinstance(item, dict)):
            raise RuntimeError(f"{plugin_id} remains in the project plugin list after removal")
        lock_path = project / layout_value('versionStatePaths.kb_marketplace_lock')
        if lock_path.exists():
            try:
                plugins = json.loads(lock_path.read_text(encoding="utf-8")).get("plugins", {})
            except json.JSONDecodeError as error:
                raise RuntimeError("project .kb/marketplace.lock became invalid after removal") from error
            if plugin_id in plugins:
                raise RuntimeError(f"{plugin_id} remains in project .kb/marketplace.lock after removal")

    def _record_remove() -> bool:
        return record("remove plugin registration", cases=["S-003.6"], check=_remove)

    scaffolded = record("scaffold plugin", cases=["S-003.1"], check=_scaffold)
    if not scaffolded:
        for name in ("build generated plugin", "add plugin to project", "invoke generated plugin",
                     "rebuild edited plugin", "remove plugin registration"):
            journey.blocked(name, "plugin-author", "blocked because plugin scaffolding failed")
        shutil.rmtree(plugin_root, ignore_errors=True)
        return

    built = record("build generated plugin", cases=["S-003.2"], check=_build)
    if not built:
        for name in ("add plugin to project", "invoke generated plugin",
                     "rebuild edited plugin", "remove plugin registration"):
            journey.blocked(name, "plugin-author", "blocked because the generated plugin did not build")
        shutil.rmtree(plugin_root, ignore_errors=True)
        return

    link_passed = record("add plugin to project", cases=["S-003.3"], check=_link)
    if not link_passed:
        for name in ("invoke generated plugin", "rebuild edited plugin"):
            journey.blocked(name, "plugin-author", "blocked because marketplace plugins add verification failed")
        if linked:
            _record_remove()
        else:
            journey.blocked("remove plugin registration", "plugin-author", "plugin was not added")
        shutil.rmtree(plugin_root, ignore_errors=True)
        return

    if journey.mode == "local":
        _record_local_anonymous_scope_step(journey, project, kb_path, child_env, command_runner)
    record("generate CLI reference in registered plugin workspace", cases=["S-003.7"],
           check=_docs_reference)
    record("reject absolute local plugin link", cases=["S-003.8"],
           check=_reject_absolute_plugin_link)

    try:
        record("invoke generated plugin", cases=["S-003.4", "S-210.1"], check=_invoke_original)
        record("rebuild edited plugin", cases=["S-003.5"], check=_edit_build_invoke)
    finally:
        if linked:
            _record_remove()
        shutil.rmtree(plugin_root, ignore_errors=True)
