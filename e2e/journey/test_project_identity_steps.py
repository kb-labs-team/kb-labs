from __future__ import annotations

import sys
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from installed_fixture import configure_hermetic_cli_fixture
from invocations import catalogued_error_hint, catalogued_error_message
from kb_invocation import kb_command
from project_identity_steps import (run_project_identity_steps, run_project_registration_case_steps,
                                    run_project_registry_corruption_case_step, run_project_registry_steps)
from service_steps import Journey


class ProjectIdentityStepsTest(unittest.TestCase):
    # case: S-204.7
    def test_unregistered_cwd_reports_unknown_project_and_add_hint(self):
        repo_root = Path(__file__).resolve().parents[2]
        journey = Journey("local", "project-identity")
        run_project_identity_steps(journey, repo_root)

        result = journey.result()
        claims = {claim["claimId"] for claim in result.case_run["claims"]}
        self.assertEqual(result.status, "PASS", result.first_failure)
        self.assertEqual(claims, {"S-204.7"})

    # case: S-043.1-.7, S-196.1-.4, S-199.1, S-199.6
    def test_project_registry_steps_reject_fake_registration_failure_then_claim_scope_checks(self):
        with tempfile.TemporaryDirectory(prefix="c07-project-identity-home-") as home:
            platform_root = Path(home) / "platform"
            (platform_root / ".kb").mkdir(parents=True)
            (platform_root / ".kb" / "marketplace.lock").write_text(json.dumps({
                "schema": "kb.marketplace/3",
                "plugins": {},
            }))
            env = {"HOME": home, "KB_HOME": str(Path(home) / ".kb"), "KB_PLATFORM_ROOT": str(platform_root)}
            Path(env["KB_HOME"]).mkdir()
            calls = []
            registrations = {}
            locks = {}
            project_configs = {}

            def fake_runner(command, **kwargs):
                cwd = Path(kwargs["cwd"]).resolve()
                args = command[1:]
                calls.append((cwd, args))
                if args[:2] == ["project", "add"]:
                    project = Path(args[2]).resolve()
                    identifier = f"prj_{len(registrations) + 1}"
                    registrations[project] = identifier
                    return subprocess.CompletedProcess(command, 0, json.dumps({
                        "ok": True, "data": {"project": {"id": identifier, "path": str(project)}},
                    }), "")
                if args[:2] == ["project", "list"]:
                    rows = [{"id": identifier, "path": str(project)} for project, identifier in registrations.items()]
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "data": {"projects": rows}}), "")
                if args[:2] == ["marketplace", "install"]:
                    package = args[2].split("@2.120.1")[0]
                    manifest_id = {
                        "@kb-labs/qa": "@kb-labs/qa",
                        "@kb-labs/commit": "@kb-labs/commit",
                        "@kb-labs/mind": "@kb-labs/mind",
                    }.get(package, package)
                    target = (Path(env["KB_PLATFORM_ROOT"])
                              if "--scope" in args and args[args.index("--scope") + 1] == "platform" else cwd)
                    locks.setdefault(target, {})[manifest_id] = {
                        "version": "2.120.1",
                        "integrity": "sha256-fixture",
                        "source": "marketplace",
                        "enabled": True,
                        "package": package,
                    }
                    lock = target / ".kb" / "marketplace.lock"
                    lock.parent.mkdir(parents=True, exist_ok=True)
                    lock.write_text(json.dumps({"plugins": locks[cwd]}))
                    return subprocess.CompletedProcess(command, 0, '{"ok":true}', "")
                if args[:2] == ["adapter", "list"]:
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "data": {"adapters": []}}), "")
                if args[:2] == ["project", "show"]:
                    root = next((path for path in registrations if cwd == path or path in cwd.parents), cwd)
                    project = registrations.get(root)
                    row = {"id": project, "path": str(root)}
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "data": {"project": row}}), "")
                if args[:2] == ["config", "set"]:
                    root = next((path for path in registrations if cwd == path or path in cwd.parents), cwd)
                    project_configs[root] = json.loads(args[3])
                    return subprocess.CompletedProcess(command, 0, '{"ok":true}', "")
                if args[:2] == ["config", "show"]:
                    root = next((path for path in registrations if cwd == path or path in cwd.parents), None)
                    if root is None:
                        return subprocess.CompletedProcess(command, 1, json.dumps({"ok": False, "error": {
                            "code": "KB_PROJECT_UNKNOWN", "message": "Project is not registered.",
                            "hint": "Run kb project add <path> or cd into a registered project.",
                        }}), "")
                    return subprocess.CompletedProcess(command, 0, json.dumps({
                        "ok": True, "data": {"project": {"id": registrations[root]},
                            "rows": [{"field": "plugins.commit.scope.scopes", "source": "project",
                                      "value": project_configs[root]}]},
                    }), "")
                if args[:3] == ["mcp", "config", "codex"]:
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "data": {
                        "projectId": registrations[cwd],
                        "url": f"http://localhost:4000/api/v1/projects/{registrations[cwd]}/mcp",
                    }}), "")
                if args == ["--version"]:
                    return subprocess.CompletedProcess(command, 0, "2.120.1\n", "")
                return subprocess.CompletedProcess(command, 0, "command help\n", "")

            with patch("project_identity_steps._registry_version", return_value="2.120.1"):
                with patch("project_identity_steps.run_with_runner", side_effect=lambda _runner, command, **opts: fake_runner(command, **opts)):
                    red = Journey("local", "project-registry-red")
                    def fail_add(command, **kwargs):
                        if command[1:3] == ["project", "add"]:
                            return subprocess.CompletedProcess(command, 1, "", "fake registration failure")
                        return fake_runner(command, **kwargs)
                    with patch("project_identity_steps.run_with_runner", side_effect=lambda _runner, command, **opts: fail_add(command, **opts)):
                        run_project_registry_steps(red, "kb", env, "http://registry.test", runner=fake_runner)
                    red_claims = {claim["claimId"]: claim["status"] for claim in red.result().case_run["claims"]}
                    self.assertEqual(red_claims["S-043.1"], "FAIL")

                    registrations.clear()
                    locks.clear()
                    green = Journey("local", "project-registry-green")
                    run_project_registry_steps(green, "kb", env, "http://registry.test", runner=fake_runner)

        result = green.result()
        self.assertEqual(result.status, "PASS", result.first_failure)
        claims = {claim["claimId"] for claim in result.case_run["claims"]}
        self.assertTrue({"S-043.1", "S-043.2", "S-043.3", "S-043.4", "S-043.5", "S-043.6", "S-043.7",
                         "S-196.1", "S-196.2", "S-196.3", "S-196.4", "S-199.1", "S-199.6"} <= claims)

    # case: S-124.1-.6, S-124.8-.9, S-051.1
    def test_installed_project_registration_cases_claim_real_cli_actions(self):
        with tempfile.TemporaryDirectory(prefix="c07-project-registration-home-") as home:
            repo_root = Path(__file__).resolve().parents[2]
            env = configure_hermetic_cli_fixture(
                Path(home), env=os.environ,
                source_config=repo_root / ".kb" / "kb.config.jsonc")

            def real_cli_runner(command, **kwargs):
                return subprocess.run(["node", *command], **kwargs)

            journey = Journey("local", "project-registration-cases")
            run_project_registration_case_steps(
                journey, repo_root / "cli/bin/dist/bin.js", env, runner=real_cli_runner)

        result = journey.result()
        claims = {claim["claimId"]: claim["status"] for claim in result.case_run["claims"]}
        expected = {"S-124.1", "S-124.2", "S-124.3", "S-124.4", "S-124.5", "S-124.6",
                    "S-124.8", "S-124.9", "S-051.1"}
        self.assertEqual(result.status, "PASS", result.first_failure)
        self.assertEqual({case_id for case_id in claims if case_id in expected}, expected)
        self.assertTrue(all(claims[case_id] == "PASS" for case_id in expected))

    # case: S-124.12
    def test_corrupt_registry_record_does_not_hide_valid_projects_from_cli(self):
        with tempfile.TemporaryDirectory(prefix="c07-project-registry-corrupt-home-") as home:
            repo_root = Path(__file__).resolve().parents[2]
            env = configure_hermetic_cli_fixture(
                Path(home), env=os.environ,
                source_config=repo_root / ".kb" / "kb.config.jsonc")
            cli = repo_root / "cli/bin/dist/bin.js"
            outside = Path(home) / "outside"
            good = outside / "good-project"
            other_good = outside / "other-good-project"
            corrupt = outside / "corrupt-project"
            good.mkdir(parents=True)
            other_good.mkdir()
            corrupt.mkdir()

            def invoke(*args: str, cwd: Path = outside):
                return subprocess.run(["node", *kb_command([*args], executable=str(cli))],
                                      cwd=cwd, env=env, capture_output=True, text=True, check=False)

            good_add = invoke("project", "add", str(good), "--json")
            other_good_add = invoke("project", "add", str(other_good), "--json")
            corrupt_add = invoke("project", "add", str(corrupt), "--json")
            self.assertEqual(good_add.returncode, 0, good_add.stderr or good_add.stdout)
            self.assertEqual(other_good_add.returncode, 0, other_good_add.stderr or other_good_add.stdout)
            self.assertEqual(corrupt_add.returncode, 0, corrupt_add.stderr or corrupt_add.stdout)
            good_id = json.loads(good_add.stdout)["data"]["project"]["id"]
            other_good_id = json.loads(other_good_add.stdout)["data"]["project"]["id"]
            registry_file = Path(env["KB_HOME"]) / "projects.json"
            contents = json.loads(registry_file.read_text(encoding="utf-8"))
            bad_record = next(record for record in contents["projects"] if record["path"] == str(corrupt.resolve()))
            bad_index = contents["projects"].index(bad_record)
            bad_record["id"] = "prj_0000000000000000"
            self.assertNotEqual(bad_record["id"], good_id)
            registry_file.write_text(json.dumps(contents), encoding="utf-8")
            valid_ids_before_corruption = {good_id, other_good_id}

            listed = invoke("project", "list", "--json")
            self.assertEqual(listed.returncode, 0, listed.stderr or listed.stdout)
            list_payload = json.loads(listed.stdout)
            self.assertEqual(valid_ids_before_corruption,
                             {row["id"] for row in list_payload["data"]["projects"]})
            self.assertNotIn(bad_record["id"], {row["id"] for row in list_payload["data"]["projects"]})
            diagnostics = list_payload["data"]["diagnostics"]
            self.assertEqual(len(diagnostics), 1)
            self.assertEqual(diagnostics[0]["path"], bad_record["path"])
            self.assertEqual(diagnostics[0]["code"], "KB_PROJECT_REGISTRY_CORRUPT")
            self.assertIn(bad_record["id"], diagnostics[0]["message"])
            self.assertNotIn("id", diagnostics[0])
            expected_registry_path = str(registry_file).replace(str(Path(env["HOME"]).resolve()), "~", 1)
            self.assertEqual(diagnostics[0]["hint"], catalogued_error_hint(
                "KB_PROJECT_REGISTRY_CORRUPT", file=expected_registry_path))

            human = invoke("project", "list")
            human_output = human.stdout + human.stderr
            normalized_human_output = " ".join(human_output.replace("│", " ").split())
            self.assertEqual(human.returncode, 0, human_output)
            self.assertIn("Project registry warnings", normalized_human_output)
            self.assertIn(bad_record["id"], normalized_human_output)
            self.assertIn(bad_record["path"], normalized_human_output)
            self.assertIn(" ".join(diagnostics[0]["hint"].split()), normalized_human_output)
            expected_message = catalogued_error_message("KB_PROJECT_REGISTRY_CORRUPT").format(
                file=expected_registry_path,
                reason=(f"projects[{bad_index}].id {bad_record['id']} does not match registered path "
                        f"{bad_record['path'].replace(str(Path(env['HOME']).resolve()), '~', 1)}"))
            self.assertIn(" ".join(expected_message.split()), normalized_human_output)

            scoped = invoke("config", "show", "--json", cwd=corrupt)
            self.assertNotEqual(scoped.returncode, 0)
            scoped_error = json.loads(scoped.stderr or scoped.stdout)["error"]
            self.assertEqual(scoped_error["code"], "KB_PROJECT_REGISTRY_CORRUPT")
            self.assertNotEqual(scoped_error["code"], "KB_PROJECT_UNKNOWN")
            self.assertEqual(scoped_error["hint"], catalogued_error_hint(
                "KB_PROJECT_REGISTRY_CORRUPT", file=scoped_error["details"]["file"]))
            self.assertNotIn("Traceback", scoped.stderr + scoped.stdout)

            shown = invoke("project", "show", bad_record["id"], "--json")
            self.assertNotEqual(shown.returncode, 0)
            error = json.loads(shown.stderr or shown.stdout)["error"]
            self.assertEqual(error["code"], "KB_PROJECT_REGISTRY_CORRUPT")
            self.assertEqual(error["hint"], catalogued_error_hint(
                "KB_PROJECT_REGISTRY_CORRUPT", file=error["details"]["file"]))
            self.assertNotIn("Traceback", shown.stderr + shown.stdout)
            self.assertEqual(json.loads(registry_file.read_text(encoding="utf-8")), contents)

    # case: S-051.1
    def test_unregistered_human_project_show_matches_catalogue_with_home_redaction(self):
        with tempfile.TemporaryDirectory(prefix="c07-project-human-error-home-") as home:
            repo_root = Path(__file__).resolve().parents[2]
            env = configure_hermetic_cli_fixture(
                Path(home), env=os.environ,
                source_config=repo_root / ".kb" / "kb.config.jsonc")
            # This invocation captures stdout/stderr through pipes. The CLI contract is
            # plain output for a non-TTY when neither color override is requested.
            env.pop("FORCE_COLOR", None)
            env.pop("NO_COLOR", None)
            cli = repo_root / "cli/bin/dist/bin.js"
            project = Path(home) / "unregistered-project"
            project.mkdir()
            initialized = subprocess.run(
                ["git", "init", "--quiet", str(project)], cwd=home,
                env=env, capture_output=True, text=True, check=False)
            self.assertEqual(initialized.returncode, 0, initialized.stderr)
            result = subprocess.run(
                ["node", *kb_command(["project", "show"], executable=str(cli))],
                cwd=project, env=env, capture_output=True, text=True, check=False)
            redacted_path = str(project).replace(str(Path(home).resolve()), "~", 1)
            expected_message = catalogued_error_message("KB_PROJECT_UNKNOWN").format(path=redacted_path)
            expected_hint = catalogued_error_hint("KB_PROJECT_UNKNOWN", path=redacted_path)
            output = result.stdout + result.stderr
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(
                output.strip(),
                f"◆  Error\n│\n│  {expected_message} [KB_PROJECT_UNKNOWN]\n│  Hint: {expected_hint}\n│\n└  ✗",
            )
            self.assertFalse(output.lstrip().startswith("{"))
            self.assertNotIn("Traceback", output)
            self.assertNotIn(" at ", output)

    # case: S-124.12
    def test_installed_registry_corruption_step_restores_fixture_and_claims_real_cli_behavior(self):
        with tempfile.TemporaryDirectory(prefix="c07-project-registry-corruption-step-") as home:
            repo_root = Path(__file__).resolve().parents[2]
            env = configure_hermetic_cli_fixture(
                Path(home), env=os.environ,
                source_config=repo_root / ".kb" / "kb.config.jsonc")
            cli = repo_root / "cli/bin/dist/bin.js"
            valid_project = Path(home) / "valid-project"
            second_valid_project = Path(home) / "second-valid-project"
            valid_project.mkdir()
            second_valid_project.mkdir()
            added = subprocess.run(
                ["node", *kb_command(["project", "add", str(valid_project), "--json"], executable=str(cli))],
                cwd=home, env=env, capture_output=True, text=True, check=False)
            self.assertEqual(added.returncode, 0, added.stderr or added.stdout)
            valid_id = json.loads(added.stdout)["data"]["project"]["id"]
            second_added = subprocess.run(
                ["node", *kb_command(["project", "add", str(second_valid_project), "--json"], executable=str(cli))],
                cwd=home, env=env, capture_output=True, text=True, check=False)
            self.assertEqual(second_added.returncode, 0, second_added.stderr or second_added.stdout)
            second_valid_id = json.loads(second_added.stdout)["data"]["project"]["id"]
            valid_ids = {valid_id, second_valid_id}
            registry_file = Path(env["KB_HOME"]) / "projects.json"
            original = registry_file.read_bytes()
            restarts = []
            corrupted_snapshot = []
            latest_registry_bytes = [registry_file.read_bytes()]

            def runner(command, **kwargs):
                current_registry_bytes = registry_file.read_bytes()
                if (corrupted_snapshot and current_registry_bytes != corrupted_snapshot[0]
                        and current_registry_bytes != original):
                    raise AssertionError(f"registry bytes changed before command {command!r}")
                if command[0] == "kb-create":
                    restarts.append(command)
                    return subprocess.CompletedProcess(command, 0, '{"ok":true}', "")
                if "project" in command and "add" in command:
                    result = subprocess.run(["node", *command], **kwargs)
                    latest_registry_bytes[0] = registry_file.read_bytes()
                    return result
                if ("project" in command and "list" in command and "--json" in command
                        and current_registry_bytes != latest_registry_bytes[0] and not corrupted_snapshot):
                    corrupted_snapshot.append(registry_file.read_bytes())
                if "logs" in command and "query" in command:
                    if not corrupted_snapshot or registry_file.read_bytes() != corrupted_snapshot[0]:
                        raise AssertionError("project registry bytes changed before the final host log observation")
                    return subprocess.CompletedProcess(command, 0, json.dumps({"ok": True, "data": {
                        "logs": [{"code": "KB_PROJECT_REGISTRY_CORRUPT"}],
                    }}), "")
                return subprocess.run(["node", *command], **kwargs)

            def gateway_request(path: str, _token: str):
                if path == "/api/v1/projects":
                    return 200, [{"id": project_id} for project_id in sorted(valid_ids)], {}
                if any(project_id in path for project_id in valid_ids):
                    return 200, {"status": "healthy"}, {}
                registry = json.loads(registry_file.read_text(encoding="utf-8"))
                bad_record = next(record for record in registry["projects"]
                                  if record["path"].endswith("corrupt-project"))
                bad_index = registry["projects"].index(bad_record)
                details = {
                    "file": "~/.kb/projects.json",
                    "reason": f"projects[{bad_index}].id {bad_record['id']} does not match registered path {bad_record['path']}",
                }
                return 500, {
                    "code": "KB_PROJECT_REGISTRY_CORRUPT",
                    "message": catalogued_error_message("KB_PROJECT_REGISTRY_CORRUPT").format_map(details),
                    "hint": catalogued_error_hint("KB_PROJECT_REGISTRY_CORRUPT", file=details["file"]),
                    "details": details,
                }, {}

            journey = Journey("local", "project-registry-corruption")
            run_project_registry_corruption_case_step(
                journey, str(cli), env, Path(env["KB_PLATFORM_ROOT"]), valid_id,
                "service-token", gateway_request, runner=runner)

            result = journey.result()
            claims = {claim["claimId"]: claim["status"] for claim in result.case_run["claims"]}
            self.assertEqual(result.status, "PASS", result.first_failure)
            self.assertEqual(claims, {"S-124.12": "PASS"})
            self.assertEqual(registry_file.read_bytes(), original)
            self.assertEqual(len(restarts), 2)


if __name__ == "__main__":
    unittest.main()
