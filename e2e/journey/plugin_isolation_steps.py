from __future__ import annotations

from kb_invocation import kb_command

import json
import os
from pathlib import Path
import tempfile

from invocations import (decode_ux_success_result, invocation_context, read_ux_cli_result,
                         run_command, store_report_secret)
from installed_fixture import inject_existing_version_fault, installed_fixture
from service_steps import Journey


def run_project_plugin_availability_steps(journey: Journey, cli: str, project_a: Path,
                                         project_b: Path, env: dict[str, str], *, runner=run_command) -> None:
    """Check that each repository reports its other project's plugin as unavailable (S-197.5)."""
    def unavailable(project: Path, args: list[str], package: str, step_id: str,
                    command_env: dict[str, str]) -> str | None:
        with invocation_context(step_id=step_id):
            result = run_command(kb_command([ *args], executable=cli), cwd=project, env=command_env, runner=runner, timeout=180)
        if result.returncode == 0:
            return f"{package} command resolved from {project.name} although it is not installed in that project"
        output = "\n".join((result.stdout or "", result.stderr or ""))
        if package not in output or "marketplace install" not in output.lower():
            return f"{project.name} did not report {package} as unavailable with its install command"
        return None

    def check(command_env: dict[str, str]) -> str | None:
        failure = unavailable(
            project_a, ["review", "run", "--mode=heuristic", "--json"],
            "@kb-labs/review", "S-197.5", command_env,
        )
        if failure:
            return failure
        return unavailable(
            project_b, ["commit", "commit", "--dry-run", "--json"],
            "@kb-labs/commit", "S-197.5", command_env,
        )

    def check_in_isolated_platform() -> str | None:
        platform_root = Path(env.get("KB_PLATFORM_ROOT", ""))
        if not platform_root.is_dir():
            return check(env)
        with tempfile.TemporaryDirectory(prefix="kb-project-plugin-scope-", dir=env.get("HOME")) as temp:
            fixture_root = Path(temp) / "platform"
            home = Path(env["HOME"])
            launcher = str(home / ".local/bin/kb-create")
            index = home / ".local/share/kb-create/release-index.json"
            installer_secret = env.get("KB_JOURNEY_ADMIN_PASSWORD")
            if not installer_secret:
                return "plugin isolation fixture install requires KB_JOURNEY_ADMIN_PASSWORD from the installed journey"
            installer_env = env.copy()
            store_report_secret(installer_env, "KB_JOURNEY_ADMIN_PASSWORD", installer_secret,
                                "plugin isolation fixture install password")

            def install_command(args: list[str]):
                with invocation_context(step_id="S-197.5"):
                    return run_command(args, cwd=project_a, env=installer_env, runner=runner, timeout=1200)

            with installed_fixture(fixture_root, launcher=launcher, index=index,
                                   run_command=install_command, label="plugin isolation fixture"):
                def remove_commit_plugin(current: bytes) -> bytes:
                    lock = json.loads(current)
                    lock.get("plugins", {}).pop("@kb-labs/commit", None)
                    return (json.dumps(lock, indent=2) + "\n").encode()

                inject_existing_version_fault(fixture_root, "versionStatePaths.kb_marketplace_lock", remove_commit_plugin)
                isolated_env = {**env, "KB_PLATFORM_ROOT": str(fixture_root)}
                return check(isolated_env)

    journey.step("reject cross-project plugin commands with install guidance", "plugins",
                 check_in_isolated_platform, cases=["S-197.5"])

    def review_project_b() -> str | None:
        fixture = project_b / "journey-review-fixture.txt"
        if fixture.exists():
            return "Project B already contains the review fixture path"
        fixture.write_text("Project B review fixture.\n", encoding="utf-8")
        try:
            staged = run_command(
                ["git", "-C", str(project_b), "add", "--", str(fixture)],
                cwd=project_b, env=env, runner=runner, timeout=30,
            )
            if staged.returncode != 0:
                return f"could not stage the Project B review fixture: {(staged.stderr or staged.stdout).strip()}"
            with invocation_context(step_id="S-197.3"):
                result = run_command(
                    kb_command([ "review", "run", "--mode=heuristic", "--json"], executable=cli),
                    cwd=project_b, env=env, runner=runner, timeout=180,
                )
            if result.returncode != 0:
                return f"heuristic Review failed in Project B: {(result.stderr or result.stdout).strip()}"
            try:
                payload = decode_ux_success_result(read_ux_cli_result(result))
            except ValueError as error:
                return f"heuristic Review returned an invalid UX result: {error}"
            result_data = payload
            metadata = result_data.get("metadata") if isinstance(result_data, dict) else None
            analyzed = metadata.get("analyzedFiles") if isinstance(metadata, dict) else None
            if (not isinstance(metadata, dict) or metadata.get("mode") != "heuristic"
                    or not isinstance(analyzed, int) or analyzed < 1):
                return "heuristic Review did not report an analyzed Project B change"
            findings = result_data.get("findings", [])
            if not isinstance(findings, list):
                return "heuristic Review returned an invalid findings list"
            for finding in findings:
                file_path = finding.get("file") if isinstance(finding, dict) else None
                if isinstance(file_path, str) and Path(file_path).is_absolute():
                    if not Path(file_path).is_relative_to(project_b.resolve()):
                        return f"Review included a finding outside Project B: {file_path}"
            return None
        finally:
            run_command(
                ["git", "-C", str(project_b), "reset", "--", str(fixture)],
                cwd=project_b, env=env, runner=runner, timeout=30,
            )
            fixture.unlink(missing_ok=True)

    journey.step("review changed files from Project B with the heuristic engine", "review",
                 review_project_b, cases=["S-197.3"])
