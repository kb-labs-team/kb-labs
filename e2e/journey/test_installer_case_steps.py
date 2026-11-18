from __future__ import annotations

import ast
import base64
import fnmatch
import hashlib
import subprocess
import shlex
import tempfile
import unittest
import json
import os
import re
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

import jsonl
import installer_case_steps
from test_catalog_exit_status import catalogued_exit
from installer_case_steps import (_add_installed_manifest_requirement, _data, _seed_installed_fixture,
                                  cleanup_installer_fixture_root,
                                  run_doctor_root_isolation_step,
                                  run_analytics_invalid_retention_step, run_installer_case_steps,
                                  run_apply_scenario_step,
                                  run_invalid_request_step,
                                  run_offline_plan_step, run_repeat_plan_readonly_step,
                                  run_platform_cli, run_secondary_root_gateway_isolation_step,
                                  run_stable_layout_contract_refusal_step,
                                  run_gateway_allocation_step, run_port_conflict_step,
                                  assert_root_offset, run_json_install_project_step,
                                  installer_primary_host_guard, run_fixture_group,
                                  run_uninstall_decline_step, run_missing_project_request_steps, _service_ids_match,
                                  _snapshot_installation_owned_tree, shim_owner_matches,
                                  assert_foreign_shim_diagnosis, assert_other_shim_diagnosis,
                                  assert_gateway_index_diagnosis, verify_installation_spellings,
                                  add_installed_host_stop_case_step)
from installer_case_steps import verify_package_manager_failure_diagnostic
from installer_case_steps import read_gateway_index_refusal
from installer_case_steps import (verify_primary_installation_spellings,
                                  verify_stable_installation_spellings)
from installed_fixture import active_path
from installer_case_steps import (assert_immutable_publish_conflict,
                                  assert_provenance_mismatch_refusal)
from invocations import PtyCommandTimeout, decode_ux_error_result, read_kb_create_cli_result
from journey_resources import active_platform_root, case_catalog_root
from service_steps import Journey
from installed_fixture import layout_value


class InstalledHostStopJourneyTests(unittest.TestCase):
    def test_stop_case_runs_installed_stop_then_confirms_stopped_status(self):
        with tempfile.TemporaryDirectory(prefix="journey-installed-stop-") as directory:
            root = Path(directory)
            calls = []

            def runner(command, **kwargs):
                calls.append((command, kwargs))
                if command[1] == "stop":
                    data = {"operation": "stop"}
                else:
                    data = {"running": False, "host": {layout_value("sharedStateDirectory"): "stopped"}}
                return subprocess.CompletedProcess(command, 0,
                                                   json.dumps({"ok": True, "data": data}), "")

            journey = Journey("local", "installed-stop")
            add_installed_host_stop_case_step(journey, root, {"HOME": directory}, runner=runner)

        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][0], ["kb-create", "stop", "--platform-root", str(root), "--json"])
        self.assertEqual(calls[1][0], ["kb-create", "status", "--platform-root", str(root), "--json"])
        self.assertEqual(journey.steps[-1].cases, ["PC-002.4"])
        self.assertEqual(journey.steps[-1].status, "PASS")

    def test_stop_case_fails_when_status_still_reports_running(self):
        with tempfile.TemporaryDirectory(prefix="journey-installed-stop-running-") as directory:
            root = Path(directory)

            def runner(command, **kwargs):
                data = {"operation": "stop"} if command[1] == "stop" else {
                    "running": True, "host": {layout_value("sharedStateDirectory"): "running"}}
                return subprocess.CompletedProcess(command, 0,
                                                   json.dumps({"ok": True, "data": data}), "")

            journey = Journey("local", "installed-stop-running")
            add_installed_host_stop_case_step(journey, root, {"HOME": directory}, runner=runner)

        self.assertEqual(journey.steps[-1].status, "FAIL")
        self.assertIn("status", journey.steps[-1].message)
from test_install_layout import create_test_install_container, move_test_platform_into_container
from test_catalog_exit_status import catalogued_exit
from service_steps import Journey, record_candidate_provenance
from service_port_assertions import assert_service_ports_preserved


def kb_create_stream(envelope: dict, exit_code: int) -> str:
    terminal = {"ok": True, "data": None,
                "meta": {"stream": {"terminal": True, "exitCode": exit_code}}}
    return jsonl.encode_jsonl_records((envelope, terminal))


def fake_product_install(args: list[str]) -> None:
    """Model install output from the layout contract, independently of a seeder's expectation."""
    layout = json.loads((Path(__file__).parents[2] / "tools/kb-create/v2/contracts/platform-layout.json").read_text())
    install_root = Path(args[args.index("--platform-root") + 1])
    version_root = install_root / layout["versionRoots"]["path"] / "1.0.0"
    version_root.mkdir(parents=True)
    for entry in layout["ownedEntries"]:
        if entry == layout["currentLink"]:
            continue
        path = install_root / entry
        if entry == layout["ownershipRecord"]:
            path.write_text(json.dumps({"schema": "kb.create.installation-owner/v1", "installationId": "a" * 32}))
        else:
            path.mkdir(parents=True, exist_ok=True)
    (install_root / layout["currentLink"]).symlink_to(Path(layout["versionRoots"]["path"]) / "1.0.0")
    for projection in [layout["platformDataRoot"], *layout["sharedRuntimePaths"]]:
        state = install_root / projection["statePath"]
        if projection.get("kind", "directory") == "directory":
            state.mkdir(parents=True, exist_ok=True)
        else:
            state.parent.mkdir(parents=True, exist_ok=True)
            state.write_text("{}\n")
        target = version_root / projection["platformPath"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.symlink_to(os.path.relpath(state, target.parent), target_is_directory=projection.get("kind", "directory") == "directory")
    package = "@kb-labs/journey-fixture"
    package_root = version_root / "node_modules" / package
    package_root.mkdir(parents=True)
    artifact = {"id": "journey-fixture", "kind": "plugin", "package": package, "version": "1.0.0", "config": []}
    (package_root / "package.json").write_text(json.dumps({"name": package, "version": "1.0.0"}))
    (package_root / "kb-create.manifest.json").write_text(json.dumps({
        "schema": "kb.create.artifact-manifest/v2", "id": artifact["id"],
        "package": package, "version": "1.0.0", "requirements": []}))
    receipt_path = version_root / ".kb/v2/receipt.json"
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    receipt_path.write_text(json.dumps({"id": "product-install-fixture", "plan": {"artifacts": [artifact]}}))


def layout_owned_path_literals(source: str, layout: dict) -> list[str]:
    """Find checked-in path spellings owned by platform-layout.json."""
    paths = set(layout["ownedEntries"])
    paths.update((layout["currentLink"], layout["versionRoots"]["path"],
                  layout["sharedStateDirectory"], layout["installerStateDirectory"],
                  layout["hostStateDirectory"], layout["ownershipRecord"],
                  layout["ownershipRecordStagingPrefix"]))
    paths.update((layout["platformDataRoot"]["platformPath"], layout["platformDataRoot"]["statePath"]))
    for projection in layout["sharedRuntimePaths"]:
        paths.update((projection["platformPath"], projection["statePath"]))
    paths.update(entry["path"] for entry in layout["versionStatePaths"])
    paths.update(layout["runtimeStatePaths"])
    paths.update(value for key, value in layout["installerRecords"].items() if key != "snapshotRetention")

    violations = []
    tree = ast.parse(source)
    parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}

    def is_path_literal(node: ast.Constant) -> bool:
        parent = parents.get(node)
        if isinstance(parent, ast.BinOp) and isinstance(parent.op, ast.Div):
            return True
        if isinstance(parent, ast.Call):
            function = parent.func
            if ((isinstance(function, ast.Name) and function.id in {"Path", "open"})
                    or (isinstance(function, ast.Attribute) and function.attr == "joinpath")):
                return True
        if isinstance(parent, (ast.Assign, ast.AnnAssign)):
            targets = parent.targets if isinstance(parent, ast.Assign) else [parent.target]
            return any(isinstance(target, ast.Name)
                       and any(part in target.id.lower() for part in ("path", "root", "file", "dir"))
                       for target in targets)
        return "/" in node.value or node.value.startswith(".")

    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        value = node.value.replace("\\", "/")
        if is_path_literal(node) and any(value == path or value.startswith(path + "/") for path in paths):
            violations.append(f"line {node.lineno}: {node.value!r}")
    return violations


def journey_layout_path_violations(journey_root: Path, layout: dict, owner_module: Path) -> list[str]:
    """Scan every non-test journey module outside the installed-fixture owner."""
    owner = owner_module.resolve()
    violations = []
    for source_path in sorted(Path(journey_root).rglob("*.py")):
        if not source_path.is_file() or source_path.resolve() == owner:
            continue
        if fnmatch.fnmatchcase(source_path.name, "test_*.py"):
            continue
        relative = source_path.relative_to(journey_root)
        for violation in layout_owned_path_literals(source_path.read_text(), layout):
            violations.append(f"{relative}:{violation}")
    return violations


class InstallerCaseStepsTest(unittest.TestCase):
    def test_package_manager_failure_diagnostic_requires_exit_stderr_and_transcript(self):
        with tempfile.TemporaryDirectory(prefix="journey-pnpm-failure-") as temporary:
            home = Path(temporary)
            platform_root = home / "kb-platform"
            platform_root.mkdir()
            index = home / "release-index.json"
            index.write_text("{}\n")
            failure_root = platform_root.parent / "pc001-pnpm-failure-root"
            stderr = "x149-pnpm-fixture: registry unavailable"
            log = home / "apply.log"
            log.write_text(stderr + "\n")
            diagnostic = home / "apply.json"
            diagnostic.write_text("{}\n")

            def run_command(args, **kwargs):
                if args[1] == "plan":
                    payload = {"ok": True, "data": {"plan": {"request": {
                        "platformRoot": str(failure_root),
                    }}}}
                    return subprocess.CompletedProcess(args, 0, json.dumps(payload), "")
                self.assertEqual(args[1], "apply")
                self.assertIn(str(home / "pc001-pnpm-failure-bin"), kwargs["env"]["PATH"])
                error = {
                    "code": "KB_INSTALL_APPLY_FAILED",
                    "message": "The operation did not reach a verified installation.",
                    "hint": "Inspect the local log.",
                    "correlationId": "a" * 32,
                    "details": {
                        "packageManagerExitCode": "47",
                        "packageManagerStderrTail": stderr,
                        "logPath": str(log),
                        "diagnosticPath": str(diagnostic),
                    },
                }
                return subprocess.CompletedProcess(args, 1, json.dumps({"ok": False, "error": error}), "")

            verify_package_manager_failure_diagnostic(
                launcher="kb-create", stable_index=index, platform_root=platform_root,
                registry="http://registry.test", run_command=run_command,
            )

            def dropped_stderr(args, **kwargs):
                result = run_command(args, **kwargs)
                if args[1] == "apply":
                    response = json.loads(result.stdout)
                    response["error"]["details"].pop("packageManagerStderrTail")
                    result.stdout = json.dumps(response)
                return result

            with self.assertRaisesRegex(RuntimeError, "exit code or stderr tail"):
                verify_package_manager_failure_diagnostic(
                    launcher="kb-create", stable_index=index, platform_root=platform_root,
                    registry="http://registry.test", run_command=dropped_stderr,
                )

    def test_diagnostic_hint_contains_the_command_declared_in_details(self):
        command = "next-step"
        self.assertTrue(installer_case_steps.diagnostic_hint_has_next_command({
            "details": {"nextCommand": command},
            "hint": f"Run `{command}`.",
        }))
        self.assertFalse(installer_case_steps.diagnostic_hint_has_next_command({
            "details": {"nextCommand": command},
            "hint": "Choose a fresh writable path.",
        }))

    def test_active_platform_path_resolves_through_the_product_current_link(self):
        with tempfile.TemporaryDirectory(prefix="journey-active-platform-path-") as temporary:
            root = Path(temporary)
            platform = root / "platform"

            def install(args):
                fake_product_install(args)
                return subprocess.CompletedProcess(args, 0, "", "")

            index = root / "release-index.json"
            index.write_text("{}\n")
            _seed_installed_fixture(platform, launcher="kb-create", index=index,
                                    run_command=install, label="active path fixture")
            config = active_path(platform, "sharedRuntimePaths.kb_kb_config_jsonc.platformPath")
            self.assertTrue(config.is_file())
            self.assertEqual(config.resolve(), (platform / "versions/1.0.0/.kb/kb.config.jsonc").resolve())

    def test_immutable_publish_conflict_assertion_uses_catalogue_and_compares_digests(self):
        package = "@kb-labs/sample"
        version = "1.0.0-cand.abcdef123456"
        with tempfile.TemporaryDirectory(prefix="journey-publish-conflict-") as temporary:
            tarball = Path(temporary) / "sample.tgz"
            tarball.write_bytes(b"changed package bytes")
            local_integrity = "sha512-" + base64.b64encode(
                hashlib.sha512(tarball.read_bytes()).digest()).decode()
            message = installer_case_steps.catalogued_error_message(
                "KB_RELEASE_VERSION_CONFLICT").format(package=package, version=version)
            hint = installer_case_steps.catalogued_error_hint(
                "KB_RELEASE_VERSION_CONFLICT", package=package, version=version)
            result = subprocess.CompletedProcess(
                ["sh", "publish.sh"], 1,
                f"ERROR KB_RELEASE_VERSION_CONFLICT: {message}\n{hint}\n"
                f"Registry digest: sha512-existing; local digest: {local_integrity}.\n", "")

            assert_immutable_publish_conflict(result, package=package, version=version,
                                              changed_tarball=tarball)

            with self.assertRaisesRegex(RuntimeError, "accepted a package version"):
                assert_immutable_publish_conflict(
                    subprocess.CompletedProcess(result.args, 0, result.stdout, ""),
                    package=package, version=version, changed_tarball=tarball)

    def test_provenance_mismatch_assertion_requires_catalogued_refusal_and_unactivated_root(self):
        expected = "a" * 64
        actual = "b" * 64
        with tempfile.TemporaryDirectory(prefix="journey-provenance-refusal-") as temporary:
            install_root = Path(temporary) / "install"
            install_root.mkdir()
            package = "@kb-labs/sample"
            package_path = f"node_modules/{package}"
            values = {"package": package, "field": "digest", "expected": expected,
                      "actual": actual, "packagePath": package_path,
                      "digestVersion": "kb-dist-digest/v1"}
            result = subprocess.CompletedProcess(
                ["kb-create", "install", "--json"], 1,
                kb_create_stream({"ok": False, "error": {
                    "code": "KB_INSTALL_PROVENANCE_MISMATCH",
                    "message": installer_case_steps.catalogued_error_message(
                        "KB_INSTALL_PROVENANCE_MISMATCH").format_map(values),
                    "hint": installer_case_steps.catalogued_error_hint(
                        "KB_INSTALL_PROVENANCE_MISMATCH", **values),
                    "cause": f"expected dist digest {expected}; actual dist digest {actual}",
                    "details": {**values},
                }}, 1), "")

            assert_provenance_mismatch_refusal(
                result, install_root=install_root, package=package,
                expected_dist=expected)

            partial_version = install_root / "versions" / "partial"
            partial_version.mkdir(parents=True)
            with self.assertRaisesRegex(RuntimeError, "created a version root"):
                assert_provenance_mismatch_refusal(
                    result, install_root=install_root, package=package,
                    expected_dist=expected)

    def test_installed_candidate_provenance_compares_executed_package_digests(self):
        with tempfile.TemporaryDirectory(prefix="journey-installed-candidate-provenance-") as temporary:
            root = Path(temporary)
            (root / ".kb/v2").mkdir(parents=True)
            (root / ".kb/v2/installed-provenance.json").write_text(json.dumps({
                "packages": [{"name": "@kb-labs/sample", "version": "1.0.0",
                              "integrity": "sha512-sample", "installedPath": "node_modules/@kb-labs/sample",
                              "sourceRevision": "revision", "contentDigest": "installed-digest"}]}))
            (root / ".kb/v2/receipt.json").write_text(json.dumps({"plan": {"artifacts": [{
                "package": "@kb-labs/sample", "version": "1.0.0",
                "provenance": {"distSha256": "sealed-digest"}}]}}))
            with self.assertRaisesRegex(RuntimeError, "installed executed package dist digests differ"):
                installer_case_steps.verify_installed_candidate_provenance(root)

    def test_installed_candidate_provenance_rejects_missing_shipped_package(self):
        with tempfile.TemporaryDirectory(prefix="journey-installed-missing-package-") as temporary:
            root = Path(temporary)
            (root / ".kb/v2").mkdir(parents=True)
            (root / ".kb/v2/installed-provenance.json").write_text(json.dumps({
                "packages": [{"name": "@kb-labs/sample", "version": "1.0.0",
                              "integrity": "sha512-sample", "installedPath": "node_modules/@kb-labs/sample",
                              "sourceRevision": "revision", "contentDigest": "sample-digest"}]}))
            (root / ".kb/v2/receipt.json").write_text(json.dumps({"plan": {"artifacts": [
                {"package": "@kb-labs/sample", "version": "1.0.0",
                 "provenance": {"distSha256": "sample-digest"}},
                {"package": "@kb-labs/cli-bin", "version": "1.0.0",
                 "provenance": {"distSha256": "cli-digest"}},
            ]}}))
            with self.assertRaisesRegex(RuntimeError, "installed package closure differs"):
                installer_case_steps.verify_installed_candidate_provenance(root)

    def test_journey_steps_resolve_layout_paths_by_identity(self):
        journey_root = Path(__file__).parents[2]
        layout = json.loads((journey_root / "tools/kb-create/v2/contracts/platform-layout.json").read_text())
        journey_modules = journey_root / "e2e/journey"
        violations = journey_layout_path_violations(
            journey_modules, layout, journey_modules / "installed_fixture.py")
        self.assertEqual(violations, [])

        platform_paths = sorted({
            projection["platformPath"]
            for projection in [layout["platformDataRoot"], *layout["sharedRuntimePaths"]]
        })
        self.assertTrue(platform_paths)
        for platform_path in platform_paths:
            write_routes = (
                f"open(root / {platform_path!r}, 'w')",
                f"Path(root / {platform_path!r}).write_text('')",
                f"shutil.copy(source, root / {platform_path!r})",
                f"os.replace(source, root / {platform_path!r})",
                f"subprocess.run(['cp', source, root / {platform_path!r}])",
            )
            for route in write_routes:
                violations_for_route = layout_owned_path_literals(f"def seed(root, source):\n    {route}\n", layout)
                self.assertTrue(violations_for_route,
                                f"write route {route!r} did not detect exact platform path {platform_path!r}")

        owned_literals = platform_paths
        with tempfile.TemporaryDirectory(prefix="journey-layout-rail-") as temp:
            module_root = Path(temp) / "journey"
            nested_steps = module_root / "steps"
            nested_steps.mkdir(parents=True)
            owner_module = module_root / "installed_fixture.py"
            mutation_source = "\n".join(f"OWNED_PATH = {value!r}" for value in owned_literals) + "\n"
            owner_module.write_text(mutation_source)
            (module_root / "test_probe.py").write_text(mutation_source)
            clean_step = nested_steps / "clean.py"
            clean_step.write_text("def step(root):\n    return root\n")
            self.assertEqual(journey_layout_path_violations(module_root, layout, owner_module), [])
            mutated_step = nested_steps / "new_layout_probe.py"
            mutated_step.write_text(mutation_source)
            nested_violations = journey_layout_path_violations(module_root, layout, owner_module)
            self.assertEqual(len(nested_violations), len(owned_literals))
            self.assertIn("steps/new_layout_probe.py", nested_violations[0])

        joined_mutation = "def step(root):\n    return root / \"state\" / \"cache\"\n"
        self.assertTrue(layout_owned_path_literals(joined_mutation, layout),
                        "slash-joined Path segments that form a layout path must make the rail red")

    def test_installation_spelling_matrix_uses_case_verbs_and_scenario_shim_owner(self):
        with tempfile.TemporaryDirectory(prefix="journey-install-spellings-") as temp:
            home = Path(temp)
            install_root = home / "platform"
            active_root = install_root / "versions" / "v1"
            active_root.mkdir(parents=True)
            (install_root / "current").symlink_to("versions/v1", target_is_directory=True)
            launcher = home / ".local" / "bin" / "kb-create"
            launcher.parent.mkdir(parents=True)
            (launcher.parent / "kb").symlink_to(install_root / "current/.kb/v2/bin/kb")
            first_owner = [install_root]
            registry = home / ".local" / "share" / "kb-create" / "gateway-roots.json"
            registry.parent.mkdir(parents=True)
            writer_fixture = Path(__file__).parent / "testdata" / "gateway-roots-schema2.json"
            writer_registry = json.loads(writer_fixture.read_text())
            self.assertEqual(writer_registry["schema"], 2)
            self.assertTrue(writer_registry["roots"][0]["platformRoot"].endswith("/current"))
            installation_id = writer_registry["roots"][0]["installationId"]
            gateway_url = writer_registry["roots"][0]["url"]
            registry.write_bytes(writer_fixture.read_bytes())
            (active_root / ".kb/v2").mkdir(parents=True)
            (active_root / ".kb/v2/receipt.json").write_text(json.dumps({
                "id": "receipt-one", "installationId": installation_id,
                "plan": {"platformChannel": "stable", "serviceGraph": {"platformVersion": "1.2.3"},
                         "request": {"gatewayUrl": gateway_url}},
                "verification": {"hostHealthUrl": gateway_url + "/health"},
            }))
            calls = []

            def run_command(args):
                calls.append(args)
                operation = args[1]
                requested_root = Path(args[args.index("--platform-root") + 1])
                # Model the installed product's already registered installation. The
                # response depends on the command and root, never on the helper's expectation.
                if requested_root not in (install_root, install_root / "current", active_root.resolve()):
                    raise AssertionError(f"unregistered install spelling: {requested_root}")
                if operation == "plan":
                    payload = {"plan": {"request": {"gatewayUrl": gateway_url},
                                         "serviceGraph": {"platformVersion": "1.2.3"}}}
                elif operation == "status":
                    is_installation_spelling = requested_root in {
                        install_root, install_root / "current", active_root.resolve()
                    }
                    payload = {"installation": {"receiptId": "receipt-one", "platformVersion": "1.2.3",
                                                 "platformChannel": "stable"},
                               "shim": {"linked": is_installation_spelling and first_owner[0] == install_root,
                                        "owner": str(first_owner[0].resolve())}}
                elif operation == "update":
                    payload = {"operation": "update", "alreadyUpToDate": True}
                else:
                    raise AssertionError(f"unexpected operation: {operation}")
                return subprocess.CompletedProcess(args, 0, json.dumps({"ok": True, "data": payload}), "")

            expected_spellings = [str(install_root), str(install_root / "current"), str(active_root.resolve())]
            verify_primary_installation_spellings(
                launcher=str(launcher), index=home / "stable-index.json", install_root=install_root,
                run_command=run_command)
            self.assertEqual([call[1] for call in calls], ["plan", "status", "update", "status"] * 3)
            self.assertEqual([call[-1] for call in calls],
                             [spelling for spelling in expected_spellings for _ in (0, 1, 2, 3)])

            calls.clear()
            first_owner[0] = home / "primary-platform"
            (launcher.parent / "kb").unlink()
            (launcher.parent / "kb").symlink_to(first_owner[0] / "current/.kb/v2/bin/kb")
            verify_stable_installation_spellings(
                launcher=str(launcher), index=home / "stable-index.json", install_root=install_root,
                shim_owner_root=first_owner[0], run_command=run_command)
            self.assertEqual([call[1] for call in calls], ["status", "plan", "status", "update", "status"] * 3)
            self.assertEqual([call[-1] for call in calls],
                             [spelling for spelling in expected_spellings for _ in (0, 1, 2, 3, 4)])

            with self.assertRaisesRegex(RuntimeError, "scenario owner"):
                verify_installation_spellings(
                    launcher=str(launcher), index=home / "stable-index.json", install_root=install_root,
                    channel="stable", version="1.2.3", gateway_url=gateway_url,
                    installation_id=installation_id, receipt_id="receipt-one", operations=("plan", "update"),
                    shim_owner_root=home / "secondary", run_command=run_command)

    def test_shim_owner_expectation_uses_the_first_product_owner(self):
        with tempfile.TemporaryDirectory(prefix="journey-shim-owner-") as temp:
            root = Path(temp) / "platform"
            root.mkdir()
            other = Path(temp) / "other"
            other.mkdir()
            owner_result = {"shim": {"linked": True, "owner": str(root.resolve())}}
            other_result = {"shim": {"linked": False, "owner": str(root.resolve())}}
            self.assertTrue(shim_owner_matches(owner_result, install_root=root, expected_owner=root))
            self.assertTrue(shim_owner_matches(other_result, install_root=other, expected_owner=root))
            self.assertFalse(shim_owner_matches(
                {"shim": {"linked": False, "owner": str(root.resolve())}},
                install_root=other, expected_owner=other),
                "mutating owner expectation from linked=true to false must fail")

    def test_foreign_shim_expectation_requires_context_and_ordered_commands(self):
        with tempfile.TemporaryDirectory(prefix="journey-shim-foreign-") as temp:
            root = Path(temp) / "platform"
            link = Path(temp) / "bin" / "kb"
            target = Path(temp) / "removed" / "current" / ".kb/v2/bin/kb"
            hint = (f"The `kb` link '{link}' points to '{target}'. It cannot be mapped to a validated installation, "
                    "so KB Labs considers it foreign and will not change it. Inspect the target first, then run "
                    f"'rm' '--' '{link}' to remove this link and 'kb-create' 'doctor' '--fix' "
                    f"'--platform-root' '{root}' to recreate the shim.")
            data = {"findings": [{"code": "KB_INSTALL_SHIM_DANGLING", "path": str(link), "hint": hint}]}
            assert_foreign_shim_diagnosis(data, hint, link, target, root)
            with self.assertRaisesRegex(RuntimeError, "ordered cleanup/repair"):
                assert_foreign_shim_diagnosis(data, hint.replace(str(target), "wrong target"), link, target, root)

    def test_other_shim_expectation_requires_owner_and_explicit_switch(self):
        with tempfile.TemporaryDirectory(prefix="journey-shim-other-") as temp:
            root = Path(temp) / "platform"
            owner = Path(temp) / "other"
            link = Path(temp) / "bin" / "kb"
            hint = (f"The `kb` link '{link}' points to validated installation '{owner.resolve()}'. "
                    "KB Labs leaves it with that installation. To switch deliberately, inspect the target, "
                    f"run 'rm' '--' '{link}' to remove this link, then run 'kb-create' 'doctor' '--fix' "
                    f"'--platform-root' '{root}' to recreate it for the requested installation.")
            data = {"installation": {"checks": [{"id": "kb-command-shim", "hint": hint}]}}
            assert_other_shim_diagnosis(data, hint, link, owner, root)
            with self.assertRaisesRegex(RuntimeError, "deliberate switch"):
                assert_other_shim_diagnosis(data, hint.replace(str(owner.resolve()), "wrong owner"),
                                            link, owner, root)

    # case: S-025.10
    def test_gateway_index_diagnosis_requires_reason_and_ordered_recovery_commands(self):
        with tempfile.TemporaryDirectory(prefix="journey-gateway-index-diagnosis-") as temp:
            root = Path(temp) / "platform"
            index = Path(temp) / ".kb" / "launcher" / "gateway-roots.json"
            hint = (f"Remove the derived index with 'rm' '--' '{index}', then run "
                    f"'kb-create' 'doctor' '--fix' '--platform-root' '{root}' to rebuild it.")
            error = {"code": "KB_INSTALL_GATEWAY_INDEX_UNAVAILABLE",
                     "message": f"The Gateway address index at {index} cannot be used: unsupported schema 1.",
                     "hint": hint}
            assert_gateway_index_diagnosis({"error": error}, index, root)
            with self.assertRaisesRegex(RuntimeError, "Gateway index diagnostic"):
                assert_gateway_index_diagnosis({"error": {**error, "message": error["message"].replace("unsupported schema 1", "malformed")}},
                                               index, root)

    def test_gateway_index_refusal_reader_accepts_recorded_document_for_apply(self):
        fixtures = Path(__file__).parent / "testdata"
        expected_hint = (
            "Remove the derived index with `'rm' '--' "
            "'/tmp/kb-journey-home-utz9qm1f/.kb/launcher/gateway-roots.json'`, then run `"
            "'kb-create' 'doctor' '--fix' '--platform-root' "
            "'/tmp/kb-journey-home-utz9qm1f/pc001-explicit-gateway-root'` to rebuild it from the installation receipt."
        )
        for command, fixture in (("plan", "gateway-index-plan-refusal.json"),
                                 ("apply", "gateway-index-plan-refusal.json")):
            with self.subTest(command=command):
                expected_exit = int((fixtures / "gateway-index-plan-refusal.exit").read_text().strip())
                result = subprocess.CompletedProcess(["kb-create", command, "--json"], expected_exit,
                                                    (fixtures / fixture).read_text(), "")
                envelope = read_kb_create_cli_result(command, result)
                error = decode_ux_error_result(envelope)
                self.assertEqual(error["code"], "KB_INSTALL_GATEWAY_INDEX_UNAVAILABLE")
                self.assertEqual(error["hint"], expected_hint)
                self.assertEqual(expected_exit, catalogued_exit(error["code"]))
                self.assertEqual(expected_exit, 1)

    def test_s025_gateway_index_refusals_follow_each_command_output_form(self):
        fixtures = Path(__file__).parent / "testdata"
        plan_stdout = (fixtures / "gateway-index-plan-refusal.json").read_text()
        root = Path("/tmp/kb-journey-home-utz9qm1f/pc001-explicit-gateway-root")
        index = Path("/tmp/kb-journey-home-utz9qm1f/.kb/launcher/gateway-roots.json")
        error = json.loads(plan_stdout)["error"]
        document = json.dumps({"ok": False, "error": error})
        outputs = {
            "plan": (plan_stdout, 1),
            "apply": (document, 1),
            "status": (document, 1),
            "doctor": (document, 1),
            "uninstall": (document, 1),
            "rm": ("", 0),
            "doctor-fix": (json.dumps({"ok": True, "data": {"operation": "doctor-fix"}}), 0),
        }
        calls = []

        def fake_runner(args):
            operation = ("rm" if args[0] == "rm" else
                         "doctor-fix" if args[1] == "doctor" and "--fix" in args else args[1])
            stdout, returncode = outputs[operation]
            calls.append((operation, args))
            return subprocess.CompletedProcess(args, returncode, stdout, "")

        for operation in ("plan", "apply", "status", "doctor", "uninstall"):
            args = ["kb-create", operation, "--platform-root", str(root), "--json"]
            if operation in ("plan", "apply"):
                args += ["--index", str(fixtures / "unused-index.json")]
            if operation == "uninstall":
                args.append("--yes")
            refusal = fake_runner(args)
            parsed = read_gateway_index_refusal(refusal, operation, index, root)
            self.assertEqual(parsed["code"], "KB_INSTALL_GATEWAY_INDEX_UNAVAILABLE")
            self.assertEqual(refusal.returncode, catalogued_exit(parsed["code"]))
        self.assertEqual([name for name, _ in calls],
                         ["plan", "apply", "status", "doctor", "uninstall"])
        apply_failure = decode_ux_error_result(read_kb_create_cli_result(
            "apply", subprocess.CompletedProcess(["kb-create", "apply", "--json"],
                                                  outputs["apply"][1], outputs["apply"][0], "")))
        self.assertEqual(apply_failure["code"], "KB_INSTALL_GATEWAY_INDEX_UNAVAILABLE")

        hinted_commands = [shlex.split(command) for command in re.findall(r"`([^`]*)`", error["hint"])]
        remove_argv = next(argv for argv in hinted_commands if argv[:2] == ["rm", "--"])
        self.assertEqual(remove_argv, ["rm", "--", str(index)])
        removed = fake_runner(remove_argv)
        self.assertEqual(removed.returncode, 0)
        repaired = fake_runner(["kb-create", "doctor", "--fix", "--platform-root", str(root), "--json"])
        self.assertEqual(_data(repaired, "doctor fix after removing index")["operation"], "doctor-fix")
        self.assertEqual(calls[-1][0], "doctor-fix")

    def test_install_refusal_is_a_case_fail_with_the_product_envelope(self):
        journey = Journey("local")
        envelope = {"code": "KB_INSTALL_LAYOUT_UNSUPPORTED", "message": "foreign target",
                    "cause": "foreign bytes found", "hint": "choose a fresh writable path"}
        stdout = jsonl.encode_jsonl_records((
            {"ok": False, "error": envelope},
            {"ok": True, "data": None,
             "meta": {"stream": {"terminal": True, "exitCode": 1}}},
        ))

        parsed = installer_case_steps.parse_install_refusal(
            subprocess.CompletedProcess(["kb-create", "install", "--json"], 1, stdout, ""))
        self.assertIsNotNone(parsed)
        message = (f"{parsed['code']}: {parsed['message']}; cause={parsed.get('cause', '')}; "
                   f"hint={parsed.get('hint', '')}")
        journey.step("JSON install progress", "platform.install", lambda: message,
                     cases=["PC-001.17"], details=lambda: {"productEnvelope": parsed})

        result = journey.result()
        self.assertEqual(parsed, envelope)
        self.assertEqual(result.status, "FAIL")
        self.assertEqual(result.first_failure["name"], "JSON install progress")
        self.assertEqual(result.first_failure["cases"], ["PC-001.17"])
        self.assertEqual(result.first_failure["details"]["productEnvelope"], envelope)
        self.assertEqual(result.case_run["claims"],
                         [{"claimId": "PC-001.17", "kind": "journey", "status": "FAIL"}])

    def test_j52_installer_sequence_attributes_leak_and_keeps_later_rows(self):
        with tempfile.TemporaryDirectory(prefix="journey-host-lifecycle-") as temp:
            root = Path(temp) / "platform"
            active = create_test_install_container(root)
            receipt = active / ".kb/v2/receipt.json"
            receipt.parent.mkdir(parents=True)
            receipt.write_text(json.dumps({"plan": {"host": {"healthUrl": "http://127.0.0.1:4000/health"}}}))
            state = {"running": False}
            calls = []

            def run_command(args):
                calls.append(args)
                if args[0] == "lsof":
                    if state["running"]:
                        return subprocess.CompletedProcess(args, 0, "p4321\ncMainThread\n", "")
                    return subprocess.CompletedProcess(args, 1, "", "")
                operation = args[1]
                if operation == "status":
                    host = {"state": "running", "pid": 4321} if state["running"] else {"state": "stopped"}
                    payload = {"ok": True, "data": {"host": host}}
                    return subprocess.CompletedProcess(args, 0, json.dumps(payload), "")
                if operation == "start":
                    state["running"] = True
                elif operation == "stop":
                    state["running"] = False
                return subprocess.CompletedProcess(args, 0, '{"ok":true,"data":{}}', "")

            journey = Journey("local")
            journey.step_guard = installer_primary_host_guard(root, "kb-create", run_command)
            journey.step("plan, apply, and verify stable install", "platform.install", lambda: None,
                         cases=["S-181.1"])
            journey.step("plan, apply, and verify canary install", "platform.install", lambda: None,
                         cases=["S-181.2"])
            journey.step("apply a secret through an environment reference", "platform.install",
                         lambda: run_command(["kb-create", "start", "--platform-root", str(root), "--json"]),
                         cases=["S-181.3"])
            def offline_plan():
                if state["running"]:
                    run_command(["kb-create", "stop", "--platform-root", str(root), "--json"])
                self.assertFalse(state["running"], "S-181.4 inherited S-181.3 host state")
                return None
            journey.step("resolve a fresh request from the local artifact cache", "platform.install", offline_plan,
                         cases=["S-181.4"])
            journey.step("continue installer case fixtures", "platform.install", lambda: None,
                         cases=["S-181.5"])

        self.assertEqual([step.status for step in journey.steps], ["PASS", "PASS", "FAIL", "PASS", "PASS"])
        self.assertIn("S-181.3", journey.steps[2].cases)
        self.assertIn("root", journey.steps[2].message)
        self.assertIn("pid 4321", journey.steps[2].message)
        self.assertIn("4000", journey.steps[2].message)
        self.assertFalse(state["running"])
        self.assertEqual([step.name for step in journey.steps], [
            "plan, apply, and verify stable install", "plan, apply, and verify canary install",
            "apply a secret through an environment reference",
            "resolve a fresh request from the local artifact cache", "continue installer case fixtures",
        ])

    def test_nested_fixture_journey_leak_is_attributed_to_its_group_and_rows_are_kept(self):
        with tempfile.TemporaryDirectory(prefix="journey-host-lifecycle-") as temp:
            root = Path(temp) / "platform"
            active = create_test_install_container(root)
            receipt = active / ".kb/v2/receipt.json"
            receipt.parent.mkdir(parents=True)
            receipt.write_text(json.dumps({"plan": {"host": {"healthUrl": "http://127.0.0.1:4000/health"}}}))
            state = {"running": False}

            def run_command(args):
                if args[0] == "lsof":
                    if state["running"]:
                        return subprocess.CompletedProcess(args, 0, "p4321\ncMainThread\n", "")
                    return subprocess.CompletedProcess(args, 1, "", "")
                if args[1] == "status":
                    host = {"state": "running", "pid": 4321} if state["running"] else {"state": "stopped"}
                    return subprocess.CompletedProcess(args, 0, json.dumps({"ok": True, "data": {"host": host}}), "")
                state["running"] = args[1] == "start"
                return subprocess.CompletedProcess(args, 0, '{"ok":true,"data":{}}', "")

            def leaking_fixture() -> Journey:
                fixture = Journey("local", "nested-fixture")
                fixture.step("nested claim passes", "platform.install", lambda: None, cases=["S-181.4"],
                             details=lambda: {"evidence": "kept"})
                fixture.blocked("nested claim is blocked", "platform.install", "needs a registry",
                                cases=["S-181.5"])
                run_command(["kb-create", "start", "--platform-root", str(root), "--json"])
                return fixture

            journey = Journey("local")
            journey.step_guard = installer_primary_host_guard(root, "kb-create", run_command)
            run_fixture_group(journey, "offline plan", leaking_fixture)
            run_fixture_group(journey, "clean group", lambda: Journey("local", "clean-fixture"))

        self.assertEqual([(step.name, step.status) for step in journey.steps], [
            ("installer fixture group: offline plan", "FAIL"),
            ("nested claim passes", "PASS"),
            ("nested claim is blocked", "BLOCKED"),
        ])
        self.assertIn("'offline plan' changed primary host run-state", journey.steps[0].message)
        self.assertIn("pid 4321", journey.steps[0].message)
        self.assertEqual(journey.steps[1].details, {"evidence": "kept"})
        self.assertEqual(journey.steps[2].cases, ["S-181.5"])
        self.assertFalse(state["running"])

    def test_nested_fixture_journey_reports_its_claims_when_the_guard_cannot_observe_the_host(self):
        def failing_status(args):
            return subprocess.CompletedProcess(args, 2, '{"ok":false,"error":{"code":"FAKE_FAILURE"}}', "")

        def fixture() -> Journey:
            nested = Journey("local", "nested-fixture")
            nested.step("nested claim still reports", "platform.install", lambda: "product failure",
                        cases=["S-181.4"])
            return nested

        with tempfile.TemporaryDirectory(prefix="journey-host-lifecycle-") as temp:
            journey = Journey("local")
            journey.step_guard = installer_primary_host_guard(Path(temp), "kb-create", failing_status)
            run_fixture_group(journey, "offline plan", fixture)

        self.assertEqual([(step.name, step.status, step.cases) for step in journey.steps], [
            ("installer fixture group: offline plan", "FAIL", []),
            ("nested claim still reports", "FAIL", ["S-181.4"]),
        ])

    # case: S-187.7
    def test_missing_project_request_claims_check_error_and_platform_root_absence(self):
        with tempfile.TemporaryDirectory(prefix="journey-missing-project-install-test-") as temp:
            root = Path(temp)
            platform = root / "platform"
            index = root / "release-index.json"
            index.write_text("{}")
            calls = []
            bin_dir = root / "bin"
            bin_dir.mkdir()
            launcher = bin_dir / "kb-create"
            shim_target = root / "existing-kb"
            shim_target.write_text("existing shim target")
            (bin_dir / "kb").symlink_to(shim_target)
            registry_dir = root / ".kb"
            registry_dir.mkdir()
            registry = registry_dir / "projects.json"
            registry.write_text('{"projects":[{"path":"existing-project"}]}')

            def run_command(args):
                calls.append(args)
                project = args[args.index("--project-root") + 1]
                error = {"code": "KB_INSTALL_INPUT_REQUIRED", "message": "project directory must exist",
                         "hint": f"Create it with 'mkdir' '-p' '{project}' or pass an existing project directory."}
                envelope = {"ok": False, "error": error}
                output = (kb_create_stream(envelope, 2) if args[1] == "install"
                          else json.dumps(envelope))
                return subprocess.CompletedProcess(args, 2, output, "")

            journey = run_missing_project_request_steps(mode="local", launcher=str(launcher), stable_index=index,
                                                        home=root, run_command=run_command)
            self.assertEqual(journey.steps[0].cases, ["S-187.7"])
            self.assertEqual(journey.steps[0].status, "PASS", journey.steps[0].message)
            self.assertEqual(calls[0][1:3], ["install", "--json"])
            self.assertEqual(journey.steps[1].cases, ["S-187.8"])
            self.assertEqual(journey.steps[1].status, "PASS", journey.steps[1].message)
            self.assertEqual([call[1] for call in calls], ["install", "plan", "apply"])

    # case: S-039.1
    def test_apply_scenario_claim_checks_single_document_and_receipt_preference(self):
        with tempfile.TemporaryDirectory(prefix="journey-apply-scenario-") as temp:
            root = Path(temp)
            platform = root / "platform"
            index = root / "release-index.json"
            index.write_text("{}")
            calls = []

            def run_command(args):
                calls.append(args)
                receipt = {"plan": {"request": {
                    "platformRoot": args[args.index("--platform-root") + 1],
                    "providerPreferences": {"cache": "state-broker"},
                    "scenarioId": "commit",
                }, "artifacts": []}, "marketplaceInstalls": [
                    {"spec": "@kb-labs/commit", "id": "@kb-labs/commit", "version": "1.2.3", "source": "registry"},
                ]}
                apply_result = {"operation": "apply", "receipt": receipt, "logPath": "/tmp/apply.log"}
                return subprocess.CompletedProcess(args, 0,
                    json.dumps({"ok": True, "data": apply_result}), "")

            with patch.object(installer_case_steps, "unused_loopback_gateway_url",
                              return_value="http://127.0.0.1:4999"):
                journey = run_apply_scenario_step(mode="local", launcher="kb-create", stable_index=index,
                                                  platform_root=platform, run_command=run_command)
            claim = next(step for step in journey.steps if step.cases == ["S-039.1"])
            self.assertEqual(claim.status, "PASS", claim.message)
            self.assertEqual(calls[0], [
                "kb-create", "apply", "--json", "--index", str(index),
                "--platform-root", str(root / "s039-apply-scenario-local"),
                "--service-profile", "default", "--gateway-url", "http://127.0.0.1:4999",
                "--scenario", "commit",
                "--scenario-answers", '{"cache":"state-broker"}',
            ])

    def test_commit_scenario_receipt_rejects_release_index_plugin(self):
        receipt = {"plan": {"request": {"scenarioId": "commit"}, "artifacts": [
            {"id": "@kb-labs/commit"},
        ]}, "marketplaceInstalls": [
            {"spec": "@kb-labs/commit", "id": "@kb-labs/commit", "version": "1.2.3", "source": "registry"},
        ]}
        with self.assertRaisesRegex(RuntimeError, "incorrectly resolved from the release index"):
            installer_case_steps.assert_commit_marketplace_receipt(receipt)

    def test_commit_scenario_receipt_requires_requested_spec(self):
        receipt = {"plan": {"request": {"scenarioId": "commit"}, "artifacts": []},
                   "marketplaceInstalls": [{"id": "@kb-labs/commit", "version": "1.2.3", "source": "npm"}]}
        with self.assertRaisesRegex(RuntimeError, "requested spec"):
            installer_case_steps.assert_commit_marketplace_receipt(receipt)

    def test_apply_shim_owner_uses_the_canonical_platform_root(self):
        with tempfile.TemporaryDirectory(prefix="journey-apply-shim-owner-") as temp:
            root = Path(temp)
            installer_case_steps.assert_apply_shim_owner(
                {"shim": {"linked": True, "owner": str(root.resolve())}}, root)
            with self.assertRaisesRegex(RuntimeError, "canonical platform root"):
                installer_case_steps.assert_apply_shim_owner(
                    {"shim": {"linked": False, "owner": str(root.resolve())}}, root)

    # case: S-039.1
    def test_apply_scenario_claim_rejects_receipt_with_wrong_provider(self):
        with tempfile.TemporaryDirectory(prefix="journey-apply-scenario-wrong-") as temp:
            root = Path(temp)
            platform = root / "platform"
            apply_root = root / "s039-apply-scenario-local"
            index = root / "release-index.json"
            index.write_text("{}")

            def run_command(args):
                apply_result = {"operation": "apply", "receipt": {"plan": {"request": {
                    "platformRoot": str(apply_root), "providerPreferences": {"cache": "other"},
                }}}, "logPath": "/tmp/apply.log"}
                return subprocess.CompletedProcess(args, 0,
                    json.dumps({"ok": True, "data": apply_result}), "")

            journey = run_apply_scenario_step(mode="local", launcher="kb-create", stable_index=index,
                                              platform_root=platform, run_command=run_command)
            claim = next(step for step in journey.steps if step.cases == ["S-039.1"])
            self.assertEqual(claim.status, "FAIL")
            self.assertIn("selected cache provider", claim.message)

    # case: S-039.4
    def test_invalid_request_claim_checks_field_repair_hint_and_preserves_state(self):
        with tempfile.TemporaryDirectory(prefix="journey-invalid-request-") as temp:
            root = Path(temp)
            platform = root / "platform"
            platform.mkdir()
            (platform / "receipt.json").write_text("unchanged\n")
            index = root / "index.json"
            index.write_text("{}")
            calls = []
            requests = []

            def run_command(args):
                calls.append(args)
                index_path = args[args.index("--index") + 1]
                request_path = args[args.index("--input") + 1]
                requests.append(json.loads(Path(request_path).read_text()))
                error = {"code": "KB_INSTALL_INPUT_REQUIRED", "message": "request is invalid",
                         "hint": (f"Correct platformRoot in request file '{request_path}', then retry: "
                                  f"kb-create apply --index '{index_path}' --input '{request_path}' --json")}
                return subprocess.CompletedProcess(args, 2,
                    json.dumps({"ok": False, "error": error}), "")

            journey = run_invalid_request_step(mode="local", launcher="kb-create", stable_index=index,
                                               platform_root=platform, run_command=run_command)

            claim = next(step for step in journey.steps if step.cases == ["S-039.4"])
            self.assertEqual(claim.status, "PASS", claim.message)
            self.assertEqual(calls[0][1:3], ["apply", "--json"])
            self.assertEqual(requests[0]["platformRoot"], "")

    def test_apply_result_helper_decodes_single_result_document(self):
        result = subprocess.CompletedProcess(["kb-create", "apply", "--json"], 0,
            '{"ok":true,"data":{"operation":"apply","receipt":{},"logPath":"/tmp/apply.log"}}', "")
        self.assertEqual(_data(result, "apply")['operation'], "apply")

    def test_root_offset_assertion_checks_services_and_transport_urls(self):
        plan = {"serviceGraph": {"services": [{"id": "gateway", "port": 4100},
                                               {"id": "marketplace", "port": 5170}]},
                "configPatches": [{"path": "/platform/adapterOptions", "json": json.dumps({
                    "serviceTransport": {"services": {
                        "gateway": {"url": "http://127.0.0.1:4100"},
                        "marketplace": {"url": "http://127.0.0.1:5170"},
                    }},
                })}]}
        assert_root_offset(plan, {"gateway": 4000, "marketplace": 5070},
                           {"gateway": 4000, "marketplace": 5070}, 100, "secondary root")
        plan["serviceGraph"]["services"][1]["port"] = 5270
        with self.assertRaisesRegex(RuntimeError, "service ports"):
            assert_root_offset(plan, {"gateway": 4000, "marketplace": 5070},
                               {"gateway": 4000, "marketplace": 5070}, 100, "secondary root")

    # case: PC-001.13, PC-001.14, PC-001.15
    def test_lifecycle_port_assertion_rejects_service_or_transport_drift(self):
        before = {"serviceGraph": {"services": [{"id": "gateway", "port": 4100},
                                                {"id": "marketplace", "port": 5170}]},
                  "configPatches": [{"path": "/platform/adapterOptions", "json": json.dumps({
                      "serviceTransport": {"services": {
                          "gateway": {"url": "http://127.0.0.1:4100"},
                          "marketplace": {"url": "http://127.0.0.1:5170"},
                      }},
                  })}]}
        assert_service_ports_preserved(before, before, "update")
        changed_service = deepcopy(before)
        changed_service["serviceGraph"]["services"][1]["port"] += 1
        with self.assertRaisesRegex(RuntimeError, "service graph ports"):
            assert_service_ports_preserved(before, changed_service, "rollback")
        changed_transport = deepcopy(before)
        transport = json.loads(changed_transport["configPatches"][0]["json"])
        transport["serviceTransport"]["services"]["marketplace"]["url"] = "http://127.0.0.1:5171"
        changed_transport["configPatches"][0]["json"] = json.dumps(transport)
        with self.assertRaisesRegex(RuntimeError, "service transport ports"):
            assert_service_ports_preserved(before, changed_transport, "restart")

    def test_json_custom_scenario_install_claim_checks_project_registry_and_cleans_host(self):
        with tempfile.TemporaryDirectory(prefix="journey-json-install-project-") as temp:
            root = Path(temp)
            platform = root / "platform"
            project = root / "project"
            index = root / "index.json"
            index.write_text("{}")
            calls = []

            def run_command(args, **kwargs):
                calls.append(args)
                if args[1] == "install":
                    install_root = Path(args[args.index("--platform-root") + 1])
                    self.assertTrue(install_root.is_dir(), "JSON installer fixture root must exist before install")
                    try:
                        active = active_platform_root(install_root)
                    except FileNotFoundError:
                        active = create_test_install_container(install_root)
                    receipt_path = active / ".kb/v2/receipt.json"
                    first_install = not receipt_path.exists()
                    previous_receipt = None
                    if receipt_path.exists():
                        previous_receipt = json.loads(receipt_path.read_text())
                        selected = args[args.index("--project-root") + 1] if "--project-root" in args else ""
                        selected_path = str(Path(selected).absolute()) if selected else ""
                        if selected and selected_path not in {
                                previous_receipt.get("projectSelectedPath"),
                                previous_receipt.get("projectCanonicalPath")}:
                            refusal = ('{"ok":false,"error":{"code":"KB_INSTALL_PROJECT_SELECTION_CHANGED",'
                                '"area":"install","stage":"resolve","severity":"error",'
                                '"retryable":false,"message":"The selected project path spelling differs from the project selection recorded by this installation.",'
                                "\"hint\":\"Run `'kb' 'auth' 'login' '--gateway-url' 'URL' '--email' 'EMAIL'`, "
                                "then `'kb' 'project' 'add' 'PATH'`, then `'kb' 'project' 'show' 'PATH'`.\","
                                '"correlationId":"fixture"}}')
                            return subprocess.CompletedProcess(args, 2,
                                kb_create_stream(json.loads(refusal), 2), "")
                    active_root = active_platform_root(install_root)
                    (active_root / ".kb/v2/bin").mkdir(parents=True, exist_ok=True)
                    selected = args[args.index("--project-root") + 1] if "--project-root" in args else ""
                    selected_path = str(Path(selected).absolute()) if selected else ""
                    canonical_path = str(Path(selected).resolve()) if selected else ""
                    receipt_data = {"schema": "kb.create.receipt/v3", "projectSelectedPath": selected_path,
                                    "projectCanonicalPath": canonical_path,
                                    "projectId": "prj_0123456789abcdef" if selected else "",
                                    "plan": {"request": {
                        "platformRoot": str(install_root),
                        "projectRoot": selected}},
                        "verification": {"hostHealthUrl": "http://127.0.0.1:45678/health"}}
                    if previous_receipt and previous_receipt.get("projectId"):
                        for field in ("projectSelectedPath", "projectCanonicalPath", "projectId"):
                            receipt_data[field] = previous_receipt[field]
                    (active_root / ".kb/v2/receipt.json").write_text(json.dumps(receipt_data))
                    (active_root / ".kb/v2/bin/kb").write_text("fixture")
                    if first_install and "--project-root" in args:
                        selected_path = canonical_path
                        registry_path = Path.home() / ".kb/projects.json"
                        registry_path.parent.mkdir(parents=True, exist_ok=True)
                        entries = json.loads(registry_path.read_text()).get("projects", []) if registry_path.exists() else []
                        entries.append({"id": "prj_0123456789abcdef", "path": selected_path})
                        registry_path.write_text(json.dumps({"projects": entries}))
                    if "--secret-env" in args:
                        selected_path = str(Path(args[args.index("--project-root") + 1]).resolve())
                        registry_path = Path.home() / ".kb/projects.json"
                        registry_path.parent.mkdir(parents=True, exist_ok=True)
                        registry_path.write_text(json.dumps({"projects": [{"id": "prj_0123456789abcdef", "path": selected_path}]}))
                        return subprocess.CompletedProcess(args, 0,
                            "First administrator credentials (shown once)\nPassword: x18-journey-first-admin\n"
                            f"Verification: project registered. Next: run `'kb-create' 'status'` and "
                            f"`'kb' 'project' 'show' '{selected_path}'`.\n", "")
                    result_data = {"operation": "apply" if not first_install else "install", "receipt": receipt_data}
                    result = {"ok": True, "data": result_data}
                    if args[1] == "install":
                        result["meta"] = {"stream": {"result": True}}
                    output = kb_create_stream(result, 0) if args[1] == "install" else json.dumps(result)
                    return subprocess.CompletedProcess(args, 0, output, "")
                if args[1] == "update":
                    return subprocess.CompletedProcess(args, 0,
                        '{"ok":true,"data":{"ok":true,"alreadyUpToDate":true}}', "")
                if args[1] == "apply":
                    error = ('{"ok":false,"error":{"code":"KB_INSTALL_PROJECT_SELECTION_CHANGED",'
                        '"area":"install","stage":"resolve","severity":"error",'
                        '"retryable":false,"message":"The selected project path spelling differs from the project selection recorded by this installation.",'
                        "\"hint\":\"Run `'kb' 'auth' 'login' '--gateway-url' 'URL' '--email' 'EMAIL'`, "
                        "then `'kb' 'project' 'add' 'PATH'`, then `'kb' 'project' 'show' 'PATH'`.\","
                        '"correlationId":"fixture"}}')
                    return subprocess.CompletedProcess(args, 2, error, "")
                if args[1] == "project":
                    if len(args) > 2 and args[2] == "show":
                        registry_path = Path.home() / ".kb/projects.json"
                        projects = json.loads(registry_path.read_text()).get("projects", []) if registry_path.exists() else []
                        project = next((entry for entry in projects
                                        if entry.get("path") == str(Path(args[3]).resolve())), None)
                        if project is None and projects:
                            project = projects[-1]
                        project = project or {"id": "prj_0123456789abcdef", "path": str(Path(args[3]).resolve())}
                        return subprocess.CompletedProcess(args, 0, json.dumps({"ok": True, "data": {
                            "project": project}}), "")
                    if len(args) > 2 and args[2] == "add":
                        selected_path = str(Path(args[3]).resolve())
                        registry_path = Path.home() / ".kb/projects.json"
                        registry_path.parent.mkdir(parents=True, exist_ok=True)
                        entries = []
                        if registry_path.exists():
                            entries = json.loads(registry_path.read_text()).get("projects", [])
                        if not any(entry.get("path") == selected_path for entry in entries):
                            entries.append({"id": "prj_0123456789abcdef", "path": selected_path})
                        registry_path.write_text(json.dumps({"projects": entries}))
                    return subprocess.CompletedProcess(args, 0, json.dumps({"ok": True, "data": {
                        "project": {"id": "prj_0123456789abcdef", "path": str(Path(args[3]).resolve())},
                        "alreadyExisted": True}}), "")
                if args[1] == "status":
                    return subprocess.CompletedProcess(args, 0, json.dumps({"ok": True, "data": {
                        "host": {"state": "running"}, "running": True, "reachable": True}}), "")
                if args[1] == "auth":
                    if kwargs.get("input") != "x18-journey-first-admin\n":
                        return subprocess.CompletedProcess(args, 1, "", "missing password stdin")
                    session_path = Path.home() / ".kb/session.json"
                    session_path.parent.mkdir(parents=True, exist_ok=True)
                    session_path.write_text("{}")
                    return subprocess.CompletedProcess(args, 0, "Logged in.\n", "")
                return subprocess.CompletedProcess(args, 0, '{"ok":true,"data":{}}', "")

            isolated_home = root / "home"
            with patch.dict(os.environ, {"HOME": str(isolated_home),
                                        "KB_JOURNEY_RUNNER_SELECTOR": "agent:commit"}):
                journey = run_json_install_project_step(mode="local", launcher="kb-create", stable_index=index,
                                                        platform_root=platform, project_root=project,
                                                        run_command=run_command)
            self.assertEqual(journey.steps[0].cases, ["S-187.6"])
            self.assertEqual(journey.steps[0].status, "PASS", journey.steps[0].message)
            self.assertEqual(journey.steps[1].cases, ["S-124.14"])
            self.assertEqual(journey.steps[1].status, "PASS", journey.steps[1].message)
            self.assertEqual(journey.steps[2].cases, ["S-187.11"])
            self.assertEqual(journey.steps[2].status, "PASS", journey.steps[2].message)
            self.assertEqual(journey.steps[3].cases, ["S-187.12"])
            self.assertEqual(journey.steps[3].status, "PASS", journey.steps[3].message)
            self.assertEqual(journey.steps[4].cases, ["S-187.9"])
            self.assertEqual(journey.steps[4].status, "PASS", journey.steps[4].message)
            install_args = calls[0]
            self.assertIn("--json", install_args)
            self.assertEqual(install_args[install_args.index("--scenario") + 1], "custom")
            self.assertEqual(install_args[install_args.index("--project-root") + 1], str(project))
            self.assertIn("update", [call[1] for call in calls])
            update_args = next(call for call in calls if call[1] == "update")
            self.assertEqual(update_args[1], "update")
            self.assertEqual(update_args[update_args.index("--input") + 1], str(platform.parent / "s187-receipt-request.json"))
            with patch.dict(os.environ, {"HOME": str(isolated_home),
                                         "KB_JOURNEY_ADMIN_PASSWORD": "x18-journey-first-admin",
                                         "KB_JOURNEY_RUNNER_SELECTOR": "agent-secured:commit"}), \
                    patch.object(installer_case_steps, "evidence_run_command", run_command):
                secured_journey = run_json_install_project_step(mode="secured", launcher="kb-create", stable_index=index,
                                                                platform_root=platform, project_root=project,
                                                                run_command=run_command)
            secured_step = next(step for step in secured_journey.steps if "secured first install" in step.name)
            self.assertEqual(secured_step.cases, ["S-187.10", "S-187.11", "S-187.12"])
            self.assertEqual(secured_step.status, "PASS", secured_step.message)
            self.assertFalse((isolated_home / ".kb/session.json").exists())

    def test_installer_fixture_cleanup_stops_running_host_before_removing_root(self):
        with tempfile.TemporaryDirectory(prefix="journey-installer-cleanup-") as temp:
            root = Path(temp) / "platform"
            receipt = root / ".kb/v2/receipt.json"
            receipt.parent.mkdir(parents=True)
            receipt.write_text("{}")
            move_test_platform_into_container(root)
            calls = []

            def run_command(args):
                calls.append(args[1])
                payload = {"host": {"state": "running"}} if args[1] == "status" else {}
                return subprocess.CompletedProcess(args, 0,
                    json.dumps({"ok": True, "data": payload}), "")

            cleanup_installer_fixture_root(root, "kb-create", run_command)

        self.assertEqual(calls, ["status", "stop", "uninstall"])
        self.assertFalse(root.exists())

    def test_fixture_cleanup_failure_is_recorded_with_the_step_failure(self):
        with tempfile.TemporaryDirectory(prefix="journey-installer-cleanup-failure-") as temp:
            root = Path(temp) / "platform"
            receipt = root / ".kb/v2/receipt.json"
            receipt.parent.mkdir(parents=True)
            receipt.write_text("{}")
            move_test_platform_into_container(root)

            def fail_cleanup(args):
                raise RuntimeError(f"cleanup {args[1]} failed")

            journey = Journey("local", "fixture-cleanup-preserves-step-failure")
            step_error = RuntimeError("S-023.17 lifecycle assertion failed")

            def fail_step():
                try:
                    raise step_error
                finally:
                    cleanup_installer_fixture_root(root, "kb-create", fail_cleanup)

            journey.step("isolated installer lifecycle", "platform.install", fail_step, cases=["S-023.17"])

        result = journey.steps[-1]
        self.assertEqual(result.status, "FAIL")
        self.assertIn("S-023.17 lifecycle assertion failed", result.message)
        self.assertIn("fixture cleanup also failed: cleanup status failed", result.message)
        self.assertEqual(step_error.args[0], result.message)

    def test_offline_plan_step_primes_and_uses_its_own_root_cache(self):
        with tempfile.TemporaryDirectory(prefix="journey-offline-plan-") as temp:
            root = Path(temp)
            index = root / "release-index.json"
            index.write_text("{}")
            calls = []

            def run_command(args):
                calls.append(args)
                if args[1] == "status":
                    payload = {"ok": True, "data": {"host": {"state": "stopped"},
                              "running": False, "reachable": False}}
                elif args[1] == "apply":
                    payload = {"ok": True, "data": {"operation": "apply"}}
                else:
                    payload = {"ok": True, "data": {"plan": {"request": {"source": "offline"},
                              "artifacts": [{"resolvedFrom": "cache"}]}}}
                output = json.dumps(payload)
                return subprocess.CompletedProcess(args, 0, output, "")

            journey = run_offline_plan_step(mode="local", launcher="kb-create", stable_index=index,
                                            platform_root=root, run_command=run_command)

        self.assertEqual(journey.steps[0].cases, ["S-181.4"])
        self.assertEqual(journey.steps[0].status, "PASS", journey.steps[0].message)
        self.assertEqual([call[1] for call in calls], ["status", "apply", "plan", "status"])
        self.assertNotIn("--offline", calls[1])
        self.assertIn("--offline", calls[2])
        cache_root = root.parent / "s181-offline-root"
        self.assertEqual(calls[1][calls[1].index("--platform-root") + 1], str(cache_root))
        self.assertEqual(calls[2][calls[2].index("--platform-root") + 1], str(cache_root))

    def test_platform_cli_resolves_the_requested_roots_executable(self):
        with tempfile.TemporaryDirectory(prefix="journey-platform-cli-") as temp:
            root = Path(temp)
            executable = root / ".kb/v2/bin/kb"
            executable.parent.mkdir(parents=True)
            executable.touch()
            active = move_test_platform_into_container(root)
            calls = []
            run_platform_cli(root, ["adapter", "list", "--json"],
                             lambda args: calls.append(args) or subprocess.CompletedProcess(args, 0, "", ""))

        self.assertEqual(calls, [[str(active.resolve() / ".kb/v2/bin/kb"), "adapter", "list", "--json"]])

    def test_secondary_root_gateway_isolation_checks_running_and_stopped_legs(self):
        with tempfile.TemporaryDirectory(prefix="journey-secondary-gateway-") as temp:
            parent = Path(temp)
            primary, secondary = parent / "root-a", parent / "root-b"
            running = {primary: False, secondary: False}
            for root, installation, port in ((primary, "installation-a", 4000),
                                             (secondary, "installation-b", 4100)):
                (root / ".kb/v2/bin").mkdir(parents=True)
                (root / ".kb/v2/bin/kb").touch()
                (root / ".kb/v2/receipt.json").write_text(json.dumps({
                    "installationId": installation,
                    "plan": {"request": {"gatewayUrl": f"http://127.0.0.1:{port}"}},
                    "verification": {"hostHealthUrl": f"http://127.0.0.1:{port}/health"},
                }))
            for root in (primary, secondary):
                move_test_platform_into_container(root)
            calls = []

            def run_command(args, **kwargs):
                calls.append((args, kwargs))
                if args[0] == "kb-create":
                    command = args[1]
                    root = Path(args[args.index("--platform-root") + 1])
                    if command == "status":
                        is_running = running[root]
                        data = {"host": {"state": "running" if is_running else "stopped"},
                                "running": is_running, "reachable": is_running}
                    elif command == "start":
                        running[root] = True
                        data = {"operation": "start"}
                    else:
                        running[root] = False
                        data = {"operation": "stop"}
                    return subprocess.CompletedProcess(args, 0,
                        json.dumps({"ok": True, "data": data}), "")
                root = secondary
                if "login" in args:
                    self.assertIn("--password-stdin", args)
                    self.assertNotIn("fixture-admin-secret", args)
                    self.assertEqual(kwargs.get("input"), "fixture-admin-secret\n")
                    return subprocess.CompletedProcess(args, 0, '{"ok":true,"data":{}}', "")
                if running[root]:
                    payload = {"ok": True, "data": {"adapters": [{"id": "analytics-sqlite"}]}}
                    return subprocess.CompletedProcess(args, 0, json.dumps(payload), "")
                payload = {"ok": False, "error": {
                    "code": "KB_HOST_UNREACHABLE", "message": "secondary Gateway is stopped",
                    "hint": f'Run "kb-create start --platform-root {secondary}" and retry the command.',
                    "details": {"address": "http://127.0.0.1:4100"},
                }}
                return subprocess.CompletedProcess(args, 1, json.dumps(payload), "")

            journey = run_secondary_root_gateway_isolation_step(
                mode="local", launcher="kb-create", primary_root=primary,
                secondary_root=secondary, admin_password="fixture-admin-secret", run_command=run_command,
            )

        self.assertEqual(journey.steps[0].cases, ["PC-001.12"])
        self.assertEqual(journey.steps[0].status, "PASS", journey.steps[0].message)
        self.assertFalse(running[primary])
        self.assertFalse(running[secondary])
        adapter_calls = [args for args, _ in calls if args[0].endswith("/.kb/v2/bin/kb") and "adapter" in args]
        self.assertEqual(len(adapter_calls), 2)
        login_calls = [(args, kwargs) for args, kwargs in calls if "login" in args]
        self.assertEqual(len(login_calls), 1)
        self.assertEqual(login_calls[0][0][login_calls[0][0].index("--gateway-url") + 1], "http://127.0.0.1:4100")
        self.assertNotIn("fixture-admin-secret", repr(login_calls[0][0]))

    # case: S-054.23
    def test_stable_layout_contract_refusal_restores_both_contract_paths(self):
        with tempfile.TemporaryDirectory(prefix="journey-stable-layout-refusal-") as temp:
            root = Path(temp) / "platform"
            root.mkdir(parents=True)
            executable = root / ".kb/v2/bin/kb"
            executable.parent.mkdir(parents=True)
            executable.touch()
            move_test_platform_into_container(root)
            active = active_platform_root(root)
            contract_suffix = (".kb", "v2", "platform-layout.json")
            active_contract = active.joinpath(*contract_suffix)
            stable_contract = root.joinpath(*contract_suffix)
            contract_source = Path(__file__).parents[2] / "tools/kb-create/v2/contracts/platform-layout.json"
            original_active = contract_source.read_bytes()
            active_contract.parent.mkdir(parents=True, exist_ok=True)
            active_contract.write_bytes(original_active)
            os.chmod(active_contract, 0o640)
            root_before = installer_case_steps.snapshot_tree(root)
            expected_path = root / "current" / Path(*contract_suffix)
            calls = []

            def run_command(args):
                calls.append(args)
                envelope = {"ok": False, "error": {
                    "code": "KB_CONFIG_INVALID",
                    "message": "fixture failure",
                    "details": {
                        "contractPath": str(expected_path),
                        "remedyOperation": "update",
                        "remedyPlatformRoot": str(root),
                    },
                }}
                return subprocess.CompletedProcess(args, 1, json.dumps(envelope), "")

            journey = run_stable_layout_contract_refusal_step(
                mode="local", platform_root=root, run_command=run_command)

            self.assertEqual(journey.steps[0].cases, ["S-054.23"])
            self.assertEqual(journey.steps[0].status, "PASS", journey.steps[0].message)
            self.assertEqual(installer_case_steps.snapshot_tree(root), root_before)
            self.assertEqual(active_contract.stat().st_mode & 0o777, 0o640)
            self.assertFalse(stable_contract.exists())
            self.assertFalse(stable_contract.parent.exists())
            self.assertEqual(calls[0][1:], ["adapter", "list", "--json"])

    def test_stable_layout_refusal_restores_existing_stable_contract_mode(self):
        with tempfile.TemporaryDirectory(prefix="journey-stable-layout-mode-") as temp:
            root = Path(temp) / "platform"
            root.mkdir(parents=True)
            executable = root / ".kb/v2/bin/kb"
            executable.parent.mkdir(parents=True)
            executable.touch()
            move_test_platform_into_container(root)
            active = active_platform_root(root)
            contract_suffix = (".kb", "v2", "platform-layout.json")
            active_contract = active.joinpath(*contract_suffix)
            stable_contract = root.joinpath(*contract_suffix)
            contract_source = Path(__file__).parents[2] / "tools/kb-create/v2/contracts/platform-layout.json"
            active_contract.parent.mkdir(parents=True, exist_ok=True)
            active_contract.write_bytes(contract_source.read_bytes())
            stable_contract.parent.mkdir(parents=True, exist_ok=True)
            stable_contract.write_bytes(b"pre-existing stable-root bytes\n")
            os.chmod(stable_contract, 0o640)
            root_before = installer_case_steps.snapshot_tree(root)
            calls = []

            def run_command(args):
                calls.append(args)
                expected_path = root / "current" / Path(*contract_suffix)
                envelope = {"ok": False, "error": {
                    "code": "KB_CONFIG_INVALID",
                    "message": "fixture failure",
                    "details": {
                        "contractPath": str(expected_path),
                        "remedyOperation": "update",
                        "remedyPlatformRoot": str(root),
                    },
                }}
                return subprocess.CompletedProcess(args, 1, json.dumps(envelope), "")

            journey = run_stable_layout_contract_refusal_step(
                mode="local", platform_root=root, run_command=run_command)

            self.assertEqual(journey.steps[0].status, "PASS", journey.steps[0].message)
            self.assertEqual(installer_case_steps.snapshot_tree(root), root_before)
            self.assertEqual(stable_contract.read_bytes(), b"pre-existing stable-root bytes\n")
            self.assertEqual(stable_contract.stat().st_mode & 0o777, 0o640)

    def test_gateway_allocation_step_checks_default_allocation_and_explicit_override(self):
        with tempfile.TemporaryDirectory(prefix="journey-gateway-allocation-") as temp:
            parent = Path(temp)
            primary, automatic, explicit = parent / "root-a", parent / "root-b", parent / "root-c"
            index = parent / "release-index.json"
            index.write_text("{}")
            for root, port, service_port in ((primary, 4000, 5070), (automatic, 4100, 5170)):
                (root / ".kb/v2").mkdir(parents=True)
                (root / ".kb/v2/receipt.json").write_text(json.dumps({
                    "verification": {"hostHealthUrl": f"http://127.0.0.1:{port}/health"},
                    "plan": {"serviceGraph": {"services": [
                        {"id": "gateway", "port": port}, {"id": "marketplace", "port": service_port},
                    ]}, "configPatches": [{"path": "/platform/adapterOptions", "json": json.dumps({
                        "serviceTransport": {"services": {
                            "gateway": {"url": f"http://127.0.0.1:{port}"},
                            "marketplace": {"url": f"http://127.0.0.1:{service_port}"},
                        }},
                    })}]},
                }))
            for root in (primary, automatic):
                move_test_platform_into_container(root)
            calls = []

            def run_command(args):
                calls.append(args)
                command = args[1]
                if command == "status":
                    return subprocess.CompletedProcess(args, 0, json.dumps({"ok": True, "data": {
                        "host": {"state": "running"},
                    }}), "")
                if command == "stop":
                    return subprocess.CompletedProcess(args, 0, json.dumps({"ok": True, "data": {}}), "")
                if command == "uninstall":
                    return subprocess.CompletedProcess(args, 0, json.dumps({"ok": True, "data": {}}), "")
                if command == "plan":
                    root = Path(args[args.index("--platform-root") + 1])
                    port = 4300 if root.name == "root-d" else 4100
                    payload = {"plan": {"request": {"gatewayUrl": f"http://127.0.0.1:{port}"},
                                        "host": {"healthUrl": f"http://127.0.0.1:{port}/health"},
                                        "serviceGraph": {"services": [
                                            {"id": "gateway", "port": port},
                                            {"id": "marketplace", "port": port + 1070},
                                        ]}, "configPatches": [{"path": "/platform/adapterOptions", "json": json.dumps({
                                            "serviceTransport": {"services": {
                                                "gateway": {"url": f"http://127.0.0.1:{port}"},
                                                "marketplace": {"url": f"http://127.0.0.1:{port + 1070}"},
                                            }},
                                        })}]}}
                    return subprocess.CompletedProcess(args, 0,
                        json.dumps({"ok": True, "data": payload}), "")
                root = Path(args[args.index("--platform-root") + 1])
                gateway = args[args.index("--gateway-url") + 1]
                port = gateway.rsplit(":", 1)[1]
                active = create_test_install_container(root)
                (active / ".kb/v2").mkdir(parents=True)
                receipt = {"verification": {"hostHealthUrl": f"http://127.0.0.1:{port}/health"},
                           "plan": {"serviceGraph": {"services": [
                               {"id": "gateway", "port": int(port)},
                               {"id": "marketplace", "port": int(port) + 1070},
                           ]}, "configPatches": [{"path": "/platform/adapterOptions", "json": json.dumps({
                               "serviceTransport": {"services": {
                                   "gateway": {"url": f"http://127.0.0.1:{port}"},
                                   "marketplace": {"url": f"http://127.0.0.1:{int(port) + 1070}"},
                               }},
                           })}]}}
                (active / ".kb/v2/receipt.json").write_text(json.dumps(receipt))
                payload = {"receipt": receipt, "shim": {"linked": False, "owner": str(primary.resolve())}}
                records = [
                    {"ok": True, "data": {"phase": "Install packages", "state": "completed"}},
                    {"ok": True, "data": payload, "meta": {"stream": {"result": True}}},
                    {"ok": True, "data": None, "meta": {"stream": {"terminal": True, "exitCode": 0}}},
                ]
                return subprocess.CompletedProcess(args, 0, jsonl.encode_jsonl_records(records), "")

            journey = run_gateway_allocation_step(mode="local", launcher="kb-create", stable_index=index,
                                                  primary_root=primary, automatic_root=automatic,
                                                  explicit_root=explicit, run_command=run_command)

        self.assertEqual(journey.steps[0].cases, ["PC-001.10", "PC-001.16"])
        self.assertEqual(journey.steps[0].status, "PASS", journey.steps[0].message)
        self.assertEqual([call[1] for call in calls], ["stop", "install", "plan", "plan", "status", "stop"])
        self.assertEqual(calls[1][calls[1].index("--gateway-url") + 1], "http://127.0.0.1:4200")
        self.assertEqual(calls[1][calls[1].index("--project-root") + 1],
                         str(explicit.parent / "pc001-explicit-gateway-project"))
        self.assertEqual(calls[2][calls[2].index("--platform-root") + 1], str(explicit.parent / "root-d"))

    def test_port_conflict_claim_binds_the_gateway_port_from_the_plan(self):
        with tempfile.TemporaryDirectory(prefix="journey-port-conflict-") as temp:
            root = Path(temp) / "platform"
            root.mkdir()
            conflict_root = root.parent / "pc001-port-conflict-root"
            index = Path(temp) / "release-index.json"
            index.write_text("{}")
            calls = []

            def run_command(args):
                calls.append(args)
                if args[1] == "plan":
                    payload = {"ok": True, "data": {"plan": {
                        "host": {"healthUrl": "http://127.0.0.1:4173/health"}}}}
                    return subprocess.CompletedProcess(args, 0, json.dumps(payload), "")
                error = {"code": "KB_INSTALL_PORT_IN_USE", "area": "install", "stage": "preflight",
                         "severity": "error", "retryable": False, "message": "port is in use",
                         "hint": "Stop process 42 (fixture), then rerun `kb-create apply --platform-root '" + str(conflict_root) + "'`. Use `kb-create apply --platform-root '" + str(conflict_root) + "' --gateway-url 'http://127.0.0.1:4273'`.",
                         "details": {"port": "4173", "pid": "42", "command": "fixture"}}
                return subprocess.CompletedProcess(args, 1,
                    json.dumps({"ok": False, "error": error}), "")

            with patch.object(installer_case_steps, "unused_loopback_gateway_url",
                              return_value="http://127.0.0.1:4199"), \
                    patch("installer_case_steps.socket.socket") as socket_factory:
                journey = run_port_conflict_step(mode="local", launcher="kb-create", stable_index=index,
                                                 platform_root=root, run_command=run_command)
            owner = socket_factory.return_value.__enter__.return_value

        self.assertEqual(journey.steps[0].cases, ["PC-001.9"])
        self.assertEqual(journey.steps[0].status, "PASS", journey.steps[0].message)
        owner.bind.assert_called_once_with(("127.0.0.1", 4173))
        self.assertEqual([args[1] for args in calls], ["plan", "apply"])
        self.assertEqual(calls[0][calls[0].index("--gateway-url") + 1], "http://127.0.0.1:4199")
        self.assertEqual(calls[1][calls[1].index("--gateway-url") + 1], "http://127.0.0.1:4199")

    def test_repeat_plan_compares_install_owned_files_while_host_stays_running(self):
        with tempfile.TemporaryDirectory(prefix="journey-repeat-plan-") as temp:
            root = Path(temp) / "platform"
            marker = root / ".kb/receipt.json"
            marker.parent.mkdir(parents=True)
            marker.write_text('{"receipt":"stable"}\n')
            index = Path(temp) / "release-index.json"
            index.write_text("{}")
            calls = []
            status_calls = 0

            def run_command(args):
                nonlocal status_calls
                calls.append(args)
                command = args[1]
                if command == "status":
                    status_calls += 1
                    running = status_calls > 1
                    data = {"host": {"state": "running" if running else "stopped"},
                            "running": running, "reachable": running}
                elif command == "start":
                    data = {"operation": "start"}
                elif command == "plan":
                    data = {"plan": {"planHash": "same", "artifacts": [{"id": "platform"}],
                                     "serviceGraph": {"platformVersion": "2.0.0"}}}
                elif command == "stop":
                    data = {"operation": "stop"}
                else:
                    data = {"operation": command}
                return subprocess.CompletedProcess(args, 0, json.dumps({"ok": True, "data": data}), "")

            journey = run_repeat_plan_readonly_step(mode="local", launcher="kb-create", stable_index=index,
                                                    platform_root=root, run_command=run_command)

        self.assertEqual(journey.steps[0].cases, ["PC-001.8"])
        self.assertEqual(journey.steps[0].status, "PASS", journey.steps[0].message)
        self.assertEqual([args[1] for args in calls],
                         ["status", "start", "plan", "plan", "status", "status", "stop"])

    def test_repeat_plan_allows_runtime_state_changes_from_running_host(self):
        with tempfile.TemporaryDirectory(prefix="journey-repeat-plan-runtime-state-") as temp:
            root = Path(temp) / "platform"
            create_test_install_container(root)
            log_dir = root / "state/logs"
            log_dir.mkdir(parents=True)
            index = Path(temp) / "release-index.json"
            index.write_text("{}")
            calls = []

            def run_command(args):
                calls.append(args[1])
                command = args[1]
                if command == "status":
                    data = {"host": {"state": "running"}, "running": True, "reachable": True}
                elif command == "plan":
                    (log_dir / "host-runtime.log").write_text("runtime update\n")
                    data = {"plan": {"planHash": "same", "artifacts": [], "serviceGraph": {}}}
                else:
                    data = {"operation": command}
                return subprocess.CompletedProcess(args, 0, json.dumps({"ok": True, "data": data}), "")

            journey = run_repeat_plan_readonly_step(mode="local", launcher="kb-create", stable_index=index,
                                                    platform_root=root, run_command=run_command)
            installed_files = _snapshot_installation_owned_tree(root)
            self.assertEqual((log_dir / "host-runtime.log").read_text(), "runtime update\n")

        self.assertEqual(journey.steps[0].status, "PASS", journey.steps[0].message)
        self.assertEqual(calls, ["status", "plan", "plan", "status", "status"])
        self.assertNotIn("state/logs/host-runtime.log", installed_files)
        self.assertFalse(any(path.endswith(".kb/logs/host-runtime.log") for path in installed_files))

    def test_repeat_plan_excludes_database_under_declared_shared_runtime_path(self):
        with tempfile.TemporaryDirectory(prefix="journey-repeat-plan-database-") as temp:
            root = Path(temp) / "platform"
            create_test_install_container(root)
            database_dir = root / "state/data/database"
            database_dir.mkdir(parents=True)
            (database_dir / "kb.sqlite-wal").write_bytes(b"before")
            index = Path(temp) / "release-index.json"
            index.write_text("{}")

            def run_command(args):
                command = args[1]
                if command == "status":
                    data = {"host": {"state": "running"}, "running": True, "reachable": True}
                elif command == "plan":
                    (database_dir / "kb.sqlite-wal").write_bytes(b"after")
                    data = {"plan": {"planHash": "same", "artifacts": [], "serviceGraph": {}}}
                else:
                    data = {"operation": command}
                return subprocess.CompletedProcess(args, 0, json.dumps({"ok": True, "data": data}), "")

            journey = run_repeat_plan_readonly_step(mode="local", launcher="kb-create", stable_index=index,
                                                    platform_root=root, run_command=run_command)
            installed_files = _snapshot_installation_owned_tree(root)

        self.assertEqual(journey.steps[0].status, "PASS", journey.steps[0].message)
        self.assertNotIn("state/data/database/kb.sqlite-wal", installed_files)

    def test_invalid_retention_stops_running_host_before_start_and_restores_it(self):
        with tempfile.TemporaryDirectory(prefix="journey-invalid-retention-") as temp:
            root = Path(temp) / "platform"
            active = create_test_install_container(root)
            config_path = active / ".kb/kb.config.jsonc"
            config_path.parent.mkdir(parents=True, exist_ok=True)
            config_path.write_text(json.dumps({"platform": {}}))
            calls = []
            running = True

            def run_command(args):
                nonlocal running
                calls.append(args[1])
                command = args[1]
                if command == "status":
                    data = {"host": {"state": "running" if running else "stopped"}}
                    return subprocess.CompletedProcess(args, 0, json.dumps({"ok": True, "data": data}), "")
                if command in {"stop", "start"}:
                    if command == "start":
                        invalid = json.loads(config_path.read_text())["platform"].get("adapterOptions", {}).get("analytics", {}).get("retentionDays") == 0
                        if invalid:
                            running = False
                            error = {"code": "KB_CONFIG_INVALID", "message": "retentionDays must be a positive integer",
                                     "hint": "kb config set --scope platform platform.adapterOptions.analytics.retentionDays 90"}
                            return subprocess.CompletedProcess(args, 1, json.dumps({"ok": False, "error": error}), "")
                        running = True
                        return subprocess.CompletedProcess(args, 0,
                                                            json.dumps({"ok": True, "data": {"operation": "start"}}), "")
                    running = False
                    return subprocess.CompletedProcess(args, 0,
                                                        json.dumps({"ok": True, "data": {"operation": "stop"}}), "")
                return subprocess.CompletedProcess(args, 0, "", "")

            journey = run_analytics_invalid_retention_step(mode="local", launcher="kb-create",
                                                           platform_root=root, run_command=run_command)

        self.assertEqual(journey.steps[0].status, "PASS", journey.steps[0].message)
        self.assertEqual(calls, ["status", "stop", "start", "status", "start"])

    def test_missing_installer_fixture_is_claimless_preflight_failure(self):
        with tempfile.TemporaryDirectory(prefix="journey-missing-installer-fixture-") as temp:
            root = Path(temp)
            stable, update, jump, canary = (root / "stable.json", root / "update.json",
                                            root / "jump.json", root / "canary.json")
            stable.write_text("{}")
            update.write_text("{}")
            jump.write_text("{}")
            canary.write_text("{}")
            create_test_install_container(root)
            calls = []
            with patch("installer_case_steps.installer_scenario_resources",
                       return_value=[root / "missing-host-binary-linux-amd64.json"]):
                journey = run_installer_case_steps(
                    mode="local", launcher="kb-create", stable_index=stable,
                    update_index=update, jump_index=jump, canary_index=canary,
                    platform_root=root, secret_value="secret", registry="http://registry.test",
                    run_command=lambda args: calls.append(args),
                )

        self.assertEqual(len(journey.steps), 1)
        self.assertEqual(journey.steps[0].capability, "journey.orchestration")
        self.assertEqual(journey.steps[0].cases, [])
        self.assertEqual(journey.steps[0].status, "FAIL")
        self.assertIn("missing-host-binary", journey.steps[0].message)
        self.assertIn("node_modules/@kb-labs/cli-bin/dist/bin.js", journey.steps[0].message)
        self.assertEqual(calls, [])

    def test_repeat_plan_reports_changed_added_and_removed_paths(self):
        with tempfile.TemporaryDirectory(prefix="journey-repeat-plan-diff-") as temp:
            root = Path(temp) / "platform"
            root.mkdir()
            (root / "changed.txt").write_text("before")
            (root / "removed.txt").write_text("remove")
            index = Path(temp) / "release-index.json"
            index.write_text("{}")

            def run_command(args):
                command = args[1]
                if command == "status":
                    return subprocess.CompletedProcess(args, 0, json.dumps({"ok": True, "data": {
                        "host": {"state": "running"}, "running": True, "reachable": True}}), "")
                if command == "plan" and not (root / "added.txt").exists():
                    (root / "changed.txt").write_text("after")
                    (root / "removed.txt").unlink()
                    (root / "added.txt").write_text("new")
                return subprocess.CompletedProcess(args, 0, json.dumps({"ok": True, "data": {
                    "plan": {"planHash": "same", "artifacts": [], "serviceGraph": {}}}}), "")

            journey = run_repeat_plan_readonly_step(mode="local", launcher="kb-create", stable_index=index,
                                                    platform_root=root, run_command=run_command)

        self.assertEqual(journey.steps[0].status, "FAIL")
        self.assertIn("changed (1): changed.txt", journey.steps[0].message)
        self.assertIn("added (1): added.txt", journey.steps[0].message)
        self.assertIn("removed (1): removed.txt", journey.steps[0].message)

    def test_repeat_plan_fails_when_restarted_host_is_unhealthy(self):
        with tempfile.TemporaryDirectory(prefix="journey-repeat-plan-unhealthy-") as temp:
            root = Path(temp) / "platform"
            root.mkdir()
            index = Path(temp) / "release-index.json"
            index.write_text("{}")
            status_calls = 0

            def run_command(args):
                nonlocal status_calls
                command = args[1]
                if command == "status":
                    status_calls += 1
                    healthy = status_calls == 1
                    data = {"host": {"state": "running" if healthy else "stopped"},
                            "running": healthy, "reachable": healthy}
                elif command == "plan":
                    data = {"plan": {"planHash": "same", "artifacts": [], "serviceGraph": {}}}
                else:
                    data = {"operation": command}
                return subprocess.CompletedProcess(args, 0, json.dumps({"ok": True, "data": data}), "")

            journey = run_repeat_plan_readonly_step(mode="local", launcher="kb-create", stable_index=index,
                                                    platform_root=root, run_command=run_command)

        self.assertEqual(journey.steps[0].status, "FAIL")
        self.assertIn("host health", journey.steps[0].message)

    def test_repeat_plan_limits_displayed_paths_and_reports_total(self):
        from installer_case_steps import _format_snapshot_changes

        message = _format_snapshot_changes({"changed": [f"file-{index:02d}" for index in range(22)],
                                            "added": [], "removed": []})

        self.assertIn("changed (22):", message)
        self.assertIn("22 path(s) total, showing 20 of 22", message)
        self.assertNotIn("file-20", message)

    def test_repeat_plan_snapshot_excludes_layout_runtime_state(self):
        with tempfile.TemporaryDirectory(prefix="journey-layout-runtime-state-") as temp:
            root = Path(temp)
            layout_path = Path(__file__).resolve().parents[2] / "tools/kb-create/v2/contracts/platform-layout.json"
            layout = json.loads(layout_path.read_text(encoding="utf-8"))
            data_state_path = Path(layout["platformDataRoot"]["statePath"])
            version_root = root / "versions/v1"
            (version_root / ".kb").mkdir(parents=True)
            (root / "state/logs").mkdir(parents=True)
            (root / "state/logs/host.log").write_text("runtime\n")
            (root / data_state_path).mkdir(parents=True)
            (root / data_state_path / "db.sqlite").write_text("runtime\n")
            (root / "state/user-owned.txt").write_text("include this\n")
            (root / "state/kb.config.jsonc").write_text("{}\n")
            (version_root / ".kb/logs").symlink_to(Path("../../../state/logs"), target_is_directory=True)
            (version_root / ".kb/kb.config.jsonc").symlink_to(Path("../../../state/kb.config.jsonc"))
            (root / "current").symlink_to(Path("versions/v1"), target_is_directory=True)
            (version_root / "immutable.txt").write_text("versioned\n")
            snapshot = _snapshot_installation_owned_tree(root)

        self.assertIn("current", snapshot)
        self.assertIn("versions/v1/immutable.txt", snapshot)
        self.assertNotIn("versions/v1/.kb/kb.config.jsonc", snapshot)
        self.assertNotIn("versions/v1/.kb/logs/host.log", snapshot)
        self.assertNotIn("state/logs/host.log", snapshot)
        self.assertNotIn(str(data_state_path / "db.sqlite"), snapshot)
        self.assertNotIn("state/kb.config.jsonc", snapshot)
        self.assertIn("state/user-owned.txt", snapshot)

    def test_receipt_service_graph_must_match_selected_plan_services(self):
        planned = {"services": [{"id": "api"}, {"id": "worker"}]}
        declared = {"services": [{"id": "api"}]}

        self.assertFalse(_service_ids_match(planned, declared))

    def test_offline_plan_requires_cache_resolution_for_every_artifact(self):
        with tempfile.TemporaryDirectory(prefix="journey-offline-plan-provenance-") as temp:
            root = Path(temp)
            index = root / "release-index.json"
            index.write_text("{}")

            def run_command(args):
                if args[1] == "apply":
                    payload = {"ok": True, "data": {"operation": "apply"}}
                    output = json.dumps(payload)
                else:
                    payload = {"ok": True, "data": {"plan": {"request": {"source": "offline"}, "artifacts": [
                        {"id": "platform", "resolvedFrom": "cache"},
                        {"id": "kb-dev", "resolvedFrom": "registry", "resolvedUrl": "https://example.test/kb-dev"},
                    ]}}}
                    output = json.dumps(payload)
                return subprocess.CompletedProcess(args, 0, output, "")

            journey = run_offline_plan_step(mode="local", launcher="kb-create", stable_index=index,
                                            platform_root=root, run_command=run_command)

        self.assertEqual(journey.steps[0].status, "FAIL")
        self.assertIn("network resolution", journey.steps[0].message)

    def test_candidate_mismatch_is_typed_orchestration_failure_without_claims(self):
        with tempfile.TemporaryDirectory(prefix="journey-candidate-provenance-") as temp:
            report = Path(temp) / "candidate.json"
            journey = Journey("local", "candidate-provenance-test")
            step = record_candidate_provenance(journey, "abc1234", {
                "version": "2.0.0", "commit": "def5678",
            })
            journey.write_json(report)
            payload = json.loads(report.read_text())

        self.assertEqual(step.status, "FAIL")
        self.assertEqual(journey.result().case_run["claims"], [])
        self.assertEqual(len(payload["steps"]), 1)
        step = payload["steps"][0]
        self.assertEqual(step["capability"], "journey.orchestration")
        self.assertEqual(step["details"]["code"], "KB_JOURNEY_CANDIDATE_MISMATCH")
        self.assertIn("abc1234", step["message"])
        self.assertIn("def5678", step["message"])

    def test_candidate_short_commit_matches_checkout_revision(self):
        with tempfile.TemporaryDirectory(prefix="journey-candidate-provenance-") as temp:
            report = Path(temp) / "candidate.json"
            journey = Journey("local", "candidate-provenance-test")
            step = record_candidate_provenance(journey, "abc1234567890", {
                "version": "2.0.0", "commit": "abc1234",
            })
            journey.write_json(report)

        self.assertEqual(step.status, "PASS")
        self.assertEqual(journey.result().case_run["claims"], [])

    def test_invalid_analytics_retention_claim_requires_catalogued_start_error(self):
        with tempfile.TemporaryDirectory(prefix="journey-invalid-analytics-retention-") as temp:
            root = Path(temp)
            version_root = root / "versions/v1"
            config_path = root / "state/kb.config.jsonc"
            config_path.parent.mkdir(parents=True)
            config_path.write_text('{"platform":{"adapterOptions":{"analytics":{"retentionDays":90}}}}\n')
            (version_root / ".kb").mkdir(parents=True)
            (version_root / ".kb/kb.config.jsonc").symlink_to(Path("../../../state/kb.config.jsonc"))
            (root / "current").symlink_to(Path("versions/v1"), target_is_directory=True)
            calls = []

            def run_command(args):
                calls.append(args)
                if args[1] == "start":
                    self.assertEqual(json.loads(config_path.read_text())["platform"]["adapterOptions"]["analytics"]["retentionDays"], 0)
                    payload = {"ok": True, "data": {"operation": "start", "host": {"pid": 363}}}
                    return subprocess.CompletedProcess(args, 0, json.dumps(payload), "")
                return subprocess.CompletedProcess(args, 0, json.dumps({"ok": True, "data": {"operation": "stop"}}), "")

            journey = run_analytics_invalid_retention_step(mode="local", launcher="kb-create",
                                                           platform_root=root, run_command=run_command)

        self.assertEqual(journey.steps[0].cases, ["S-191.7"])
        self.assertEqual(journey.steps[0].status, "FAIL")
        self.assertEqual([call[1] for call in calls], ["status", "start", "status"])
        self.assertEqual(calls[1][calls[1].index("--platform-root") + 1], str(root))

    def test_doctor_root_isolation_claim_checks_repair_and_main_status(self):
        with tempfile.TemporaryDirectory(prefix="journey-doctor-isolation-") as temp:
            root = Path(temp)
            source = root / "KB Labs ' primary"
            receipt = source / ".kb/v2/receipt.json"
            receipt.parent.mkdir(parents=True)
            main_gateway_health_url = "http://127.0.0.1:4100/health"
            receipt.write_text(json.dumps({"verification": {"hostHealthUrl": main_gateway_health_url},
                                           "plan": {"artifacts": [
                {"kind": "platform", "id": "platform", "package": "@kb/platform", "version": "1.0.0"},
            ]}}))
            move_test_platform_into_container(source)
            calls = []
            primary_running = False
            fixture_running = {}
            installed_at_cross_root_start = False

            def run_command(args):
                nonlocal primary_running
                calls.append(args)
                if args[1] == "install":
                    fake_product_install(args)
                    fixture_root = Path(args[args.index("--platform-root") + 1])
                    fixture_running[fixture_root] = True
                    output = {"ok": True, "data": {"operation": "apply"}}
                elif args[1] == "uninstall":
                    fixture_root = Path(args[args.index("--platform-root") + 1])
                    import shutil
                    shutil.rmtree(fixture_root, ignore_errors=True)
                    fixture_running.pop(fixture_root, None)
                    output = {"ok": True, "data": {"operation": "uninstall"}}
                elif args[1:3] == ["doctor", "--fix"]:
                    output = {"ok": True, "data": {"operation": "doctor-fix", "hostRestarted": False}}
                elif args[1] == "start" and str(source) in args:
                    primary_running = True
                    output = {"ok": True, "data": {"operation": "start"}}
                elif args[1] == "start":
                    requested_root = Path(args[args.index("--platform-root") + 1])
                    nonlocal installed_at_cross_root_start
                    installed_at_cross_root_start = (requested_root / "current/.kb/v2/receipt.json").is_file()
                    if not installed_at_cross_root_start:
                        output = {"ok": False, "error": {"code": "KB_INSTALL_LAYOUT_UNSUPPORTED",
                                   "message": "the requested platform root has no installed receipt",
                                   "hint": "install the platform before starting it"}}
                        return subprocess.CompletedProcess(args, 1, json.dumps(output), "")
                    output = {"ok": False, "error": {"code": "KB_HOST_ALREADY_RUNNING",
                               "message": f"The KB Labs host for platform root {source.resolve()} is already running (pid 42).",
                               "hint": f"Stop that platform first with `kb-create stop --platform-root {shlex.quote(str(source.resolve()))}`.",
                               "meta": {"pid": "42"}}}
                    return subprocess.CompletedProcess(args, 1, json.dumps(output), "")
                elif args[1] == "stop":
                    fixture_root = Path(args[args.index("--platform-root") + 1])
                    if fixture_root in fixture_running:
                        fixture_running[fixture_root] = False
                    else:
                        primary_running = False
                    output = {"ok": True, "data": {"operation": "stop"}}
                elif args[1] == "status" and Path(args[args.index("--platform-root") + 1]) in {
                        source, source / "current", (source / "current").resolve()}:
                    output = {"ok": True, "data": {"host": {"state": "running" if primary_running else "stopped"}}}
                elif args[1] == "status":
                    requested = Path(args[args.index("--platform-root") + 1])
                    state = "running" if fixture_running.get(requested, False) else "stopped"
                    output = {"ok": True, "data": {"host": {"state": state}}}
                else:
                    output = {"ok": True, "data": {"host": {"state": "running"}}}
                return subprocess.CompletedProcess(args, 0, json.dumps(output), "")

            stable_index = root / "stable-index.json"
            stable_index.write_text("{}")
            journey = run_doctor_root_isolation_step(mode="local", launcher="kb-create", stable_index=stable_index,
                                                     platform_root=source, run_command=run_command)

        self.assertEqual(journey.steps[0].cases, ["S-025.7"])
        self.assertEqual(journey.steps[0].status, "PASS")
        self.assertGreaterEqual(sum(call[1] == "start" and str(source) in call for call in calls), 2)
        self.assertEqual(journey.steps[1].cases, ["S-025.8"])
        self.assertEqual(journey.steps[1].status, "PASS")
        isolated_installs = [call for call in calls if call[1] == "install"
                             and "s025-root-isolation" in call[call.index("--platform-root") + 1]]
        self.assertEqual(len(isolated_installs), 2,
                         "S-025.8 must create its own installed fixture when selected independently")
        self.assertTrue(installed_at_cross_root_start)
        fixture_install = isolated_installs[1]
        self.assertIn("--gateway-url", fixture_install)
        self.assertEqual(fixture_install[fixture_install.index("--gateway-url") + 1],
                         main_gateway_health_url.removesuffix("/health"),
                         "S-025.8 must make B claim A's receipt-recorded Gateway URL")
        self.assertEqual(calls[-1][1], "uninstall")

    def test_fixture_seeder_uses_product_install_and_requirement_is_an_explicit_fault(self):
        with tempfile.TemporaryDirectory(prefix="journey-doctor-fixture-") as temp:
            root = Path(temp)
            target = root / "fixture"
            requirement = {"id": "fixture.required", "path": "/fixture/required", "required": True,
                           "secret": False, "hint": "configure fixture"}
            calls = []

            def run_command(args):
                calls.append(args)
                fake_product_install(args)
                return subprocess.CompletedProcess(args, 0, "", "")

            index = root / "index.json"
            index.write_text("{}")
            receipt_path = _seed_installed_fixture(target, launcher="kb-create", index=index,
                                                   run_command=run_command, label="doctor fixture")
            self.assertEqual(calls[0][1], "install")
            self.assertEqual(calls[0][calls[0].index("--index") + 1], str(index))
            self.assertEqual(calls[0][calls[0].index("--platform-root") + 1], str(target))
            _add_installed_manifest_requirement(target, requirement)
            target_active = active_platform_root(target)
            receipt = json.loads(receipt_path.read_text())
            manifest_path = target_active / "node_modules/@kb-labs/journey-fixture/kb-create.manifest.json"
            manifest = json.loads(manifest_path.read_text())
            fixture_artifact = receipt["plan"]["artifacts"][0]
            self.assertEqual(fixture_artifact["config"], [requirement])
            self.assertEqual(manifest["requirements"], [requirement])

    def test_fault_injection_refuses_to_create_a_layout_target(self):
        from installed_fixture import inject_existing_fault

        with tempfile.TemporaryDirectory(prefix="journey-fault-owner-") as temp:
            root = Path(temp) / "fixture"
            with self.assertRaisesRegex(RuntimeError, "not created by product install"):
                inject_existing_fault(root, "sharedRuntimePaths.kb_kb_config_jsonc.platformPath", lambda _before: b"{}");
            self.assertFalse((root / ".kb/kb.config.jsonc").exists())

    def test_uninstall_decline_claim_fails_for_a_failed_fake_response(self):
        with tempfile.TemporaryDirectory(prefix="journey-uninstall-decline-") as temp:
            receipt = Path(temp) / "receipt.json"
            receipt.write_text('{"id":"unchanged"}')

            def fake_pty(args, *, on_output):
                self.assertEqual(on_output("Continue? [y/N] "), "n\n")
                return subprocess.CompletedProcess(args, 2, "KB_INSTALL_CONFIRMATION_REQUIRED", ""), 0.0

            journey = run_uninstall_decline_step(mode="local", args=["kb-create", "uninstall"],
                                                 receipt_path=receipt, run_pty=fake_pty)
            self.assertEqual(journey.steps[0].cases, ["S-050.3"])
            self.assertEqual(journey.steps[0].status, "FAIL")

    # case: S-050.3
    def test_uninstall_decline_claim_accepts_catalogued_operation_failure(self):
        with tempfile.TemporaryDirectory(prefix="journey-uninstall-decline-") as temp:
            receipt = Path(temp) / "receipt.json"
            receipt.write_text('{"id":"unchanged"}')

            def fake_pty(args, *, on_output):
                self.assertEqual(on_output("Continue? [y/N] "), "n\n")
                return subprocess.CompletedProcess(args, 1, "KB_INSTALL_OPERATION_CANCELLED", ""), 0.0

            journey = run_uninstall_decline_step(mode="local", args=["kb-create", "uninstall"],
                                                 receipt_path=receipt, run_pty=fake_pty)
            self.assertEqual(journey.steps[0].cases, ["S-050.3"])
            self.assertEqual(journey.steps[0].status, "PASS")

    # case: S-050.3
    def test_uninstall_decline_timeout_keeps_transcript_without_exported_state(self):
        with tempfile.TemporaryDirectory(prefix="journey-uninstall-timeout-") as temp:
            receipt = Path(temp) / "receipt.json"
            receipt.write_text('{"id":"unchanged"}')

            def fake_pty(args, *, on_output):
                raise PtyCommandTimeout(args, 120, "partial confirmation prompt")

            journey = run_uninstall_decline_step(mode="local", args=["kb-create", "uninstall"],
                                                 receipt_path=receipt, run_pty=fake_pty)
            self.assertEqual(journey.steps[0].cases, ["S-050.3"])
            self.assertEqual(journey.steps[0].status, "FAIL")
            self.assertIn("partial confirmation prompt", journey.steps[0].message)

    def test_each_claim_fails_when_the_cli_returns_a_failed_envelope(self):
        with tempfile.TemporaryDirectory(prefix="journey-installer-cases-") as temp:
            root = Path(temp)
            stable = root / "stable.json"
            update = root / "update.json"
            jump = root / "jump.json"
            canary = root / "canary.json"
            stable.write_text('{"platforms": []}')
            update.write_text('{"channels":{"stable":"2.0.0"}}')
            jump.write_text('{"channels":{"stable":"3.0.0"}}')
            canary.write_text('{"platforms": []}')
            installed = root / "installed"
            installed_active = create_test_install_container(installed)
            installed_cli_entry = installed_active / "node_modules/@kb-labs/cli-bin/dist/bin.js"
            installed_cli_entry.parent.mkdir(parents=True)
            installed_cli_entry.write_text("export {};\n")

            def fail_every_command(args):
                return subprocess.CompletedProcess(args, 2, '{"ok":false,"error":{"code":"FAKE_FAILURE"}}', "")

            with patch.dict(os.environ, {"KB_JOURNEY_RUNNER_SELECTOR": "service-local:explore"}), \
                    patch("installer_case_steps.installer_scenario_resources",
                          return_value=[case_catalog_root()]):
                journey = run_installer_case_steps(mode="local", launcher="kb-create", stable_index=stable,
                                                   update_index=update, jump_index=jump, canary_index=canary,
                                                   platform_root=installed,
                                                   secret_value="journey-test-secret",
                                                   registry="http://registry.test",
                                                   run_command=fail_every_command)
            claims = {claim: status for step in journey.steps for claim in step.cases
                      for status in [step.status]}
            owners = {claim: step.name for step in journey.steps for claim in step.cases}
            expected = {"PC-001.2", "PC-001.4", "PC-001.5", "PC-001.8", "PC-001.9", "PC-001.10", "PC-001.11", "PC-001.12", "PC-001.16", "PC-001.17", "PC-001.18", "PC-001.19", "S-050.8", "S-023.16", "S-023.17", "S-223.3", "S-223.4", "S-025.9", "S-025.10", "S-181.1", "S-181.2",
                        "S-181.3", "S-181.4", "S-181.5", "S-181.6", "S-025.1", "S-025.2", "S-054.23",
                        "S-025.3", "S-025.4", "S-025.5", "S-025.6", "S-191.7",
                        "S-053.2", "S-053.3", "S-053.4", "S-053.5", "S-053.6", "S-053.7", "S-053.8",
                        "S-187.4", "S-187.5", "S-187.6", "S-187.9", "S-187.11", "S-187.12", "S-124.14"}
            self.assertEqual(set(claims), expected)
            self.assertEqual(owners["S-023.17"], "install, update twice, restart, and uninstall inside a fresh container")
            blocked = {"PC-001.5", "S-023.16", "S-223.3", "S-181.6"}
            self.assertTrue(all(claims[claim] == "BLOCKED" for claim in blocked))
            self.assertTrue(all(claims[claim] == "FAIL" for claim in expected - blocked))


if __name__ == "__main__":
    unittest.main()
