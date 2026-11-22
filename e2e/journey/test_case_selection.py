from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import select_from_cases
from select_from_cases import (read_coverage_result, runners_for_case_selection,
                               case_ids_for_area, uncovered_case_ids_for_area,
                               selection_from_coverage, selectors_from_coverage)
from service_steps import Journey
from service_steps import FlowGraph
from journey_selection import JourneySelection
from select_from_cases import _case_declarations
from installed_fixture import configure_hermetic_cli_fixture, layout_value


def coverage(mode: str, *, source: str, kind: str = "journey", status: str = "active", release: bool = True):
    root = Path(__file__).resolve().parents[2]
    line = next(iter(_case_declarations(source, root)))
    return {
        "mode": mode,
        "cases": [{
            "id": "S-042",
            "area": "marketplace",
            "status": status,
            "release": release,
            "steps": [{"stepId": "S-042.1", "claims": [{"source": source, "kind": kind, "line": line}]}],
        }],
    }


class CaseJourneySelectionTests(unittest.TestCase):
    # case: S-262.18
    def test_product_area_selects_active_qa_cases_by_catalog_area(self):
        marketplace = {"mode": "local", "cases": [
            {"id": "S-010", "area": "marketplace", "status": "active", "steps": [
                {"stepId": "S-010.1", "claims": [{"kind": "journey", "source": "e2e/journey/runner.py"}]},
            ]},
            {"id": "S-268", "area": "marketplace", "status": "active", "steps": [
                {"stepId": "S-268.1", "claims": [{"kind": "journey", "source": "e2e/journey/marketplace_steps.py"}]},
            ]},
            {"id": "S-026", "area": "marketplace", "status": "active", "steps": [
                {"stepId": "S-026.1", "claims": []},
            ]},
            {"id": "S-047", "area": "marketplace", "status": "planned"},
            {"id": "S-120", "area": "studio", "status": "active", "steps": [
                {"stepId": "S-120.1", "claims": [{"kind": "journey", "source": "e2e/studio/fresh-host.spec.ts"}]},
            ]},
        ]}
        secured = {"mode": "secured", "cases": [
            marketplace["cases"][0], marketplace["cases"][1], marketplace["cases"][2],
            {"id": "S-047", "area": "marketplace", "status": "planned"},
            marketplace["cases"][4],
        ]}

        self.assertEqual(case_ids_for_area([marketplace, secured], "marketplace"), ["S-010", "S-268"])
        self.assertEqual(uncovered_case_ids_for_area([marketplace, secured], "marketplace"), ["S-026"])
        self.assertEqual(case_ids_for_area([marketplace, secured], "studio"), ["S-120"])
        with self.assertRaisesRegex(ValueError, "unknown or empty product area"):
            case_ids_for_area([marketplace], "registry")
        with self.assertRaisesRegex(ValueError, "lowercase QA area slug"):
            case_ids_for_area([marketplace], "Marketplace")
        broken = {"mode": "secured", "cases": [
            {"id": "S-010", "area": "platform-core", "status": "active"},
        ]}
        with self.assertRaisesRegex(ValueError, "inconsistent product areas"):
            case_ids_for_area([marketplace, broken], "marketplace")

    # case: S-262.18
    def test_coverage_reader_attaches_areas_from_the_qa_case_catalog(self):
        def fake_cli(command, **_kwargs):
            if command[2:5] == ["qa", "cases", "list"]:
                payload = {"ok": True, "data": {"cases": [
                    {"id": "S-010", "area": "marketplace"},
                ]}}
            else:
                mode = command[command.index("--mode") + 1]
                payload = {"ok": True, "data": {"mode": mode, "cases": [
                    {"id": "S-010", "status": "active", "steps": []},
                ]}}
            return subprocess.CompletedProcess(command, 0, json.dumps(payload), "")

        with patch.object(select_from_cases, "run_hermetic_cli", side_effect=fake_cli):
            results = select_from_cases.coverage_results(Path("/workspace"))

        self.assertEqual([item["cases"][0]["area"] for item in results], ["marketplace", "marketplace"])

    # case: S-262.18
    def test_coverage_reader_keeps_active_catalog_cases_without_journey_claims(self):
        def fake_cli(command, **_kwargs):
            if command[2:5] == ["qa", "cases", "list"]:
                payload = {"ok": True, "data": {"cases": [
                    {"id": "S-026", "area": "marketplace", "status": "active"},
                ]}}
            else:
                mode = command[command.index("--mode") + 1]
                payload = {"ok": True, "data": {"mode": mode, "cases": []}}
            return subprocess.CompletedProcess(command, 0, json.dumps(payload), "")

        with patch.object(select_from_cases, "run_hermetic_cli", side_effect=fake_cli):
            results = select_from_cases.coverage_results(Path("/workspace"))

        for mode in results:
            self.assertEqual(mode["cases"], [{
                "id": "S-026", "area": "marketplace", "status": "active", "steps": [],
            }])
        self.assertEqual(uncovered_case_ids_for_area(results, "marketplace"), ["S-026"])

    def test_commit_default_and_registry_lane_step_graphs_are_disjoint(self):
        root = Path(__file__).resolve().parents[2]
        source = "e2e/journey/marketplace_steps.py"
        declarations = _case_declarations(source, root)

        def coverage_for(case_id: str, step_ids: set[str], release: bool) -> dict:
            steps = []
            for step_id in sorted(step_ids):
                lines = [line for line, declaration in declarations.items()
                         if step_id in declaration.get("cases", ())]
                self.assertTrue(lines, f"{step_id} has no journey declaration in {source}")
                steps.append({"stepId": step_id, "claims": [{
                    "kind": "journey", "source": source, "line": lines[0],
                }]})
            return {"mode": "local", "cases": [{
                "id": case_id, "status": "active", "release": release, "steps": steps,
            }]}

        default = selection_from_coverage(
            [coverage_for("S-047", {"S-047.1"}, release=True)], "S-047.1")
        registry_steps = {f"S-268.{number}" for number in range(1, 9)}
        registry = selection_from_coverage(
            [coverage_for("S-268", registry_steps, release=False)], ",".join(sorted(registry_steps)))

        self.assertEqual(default["steps"], ["S-047.1"])
        self.assertNotIn("marketplace-registry", default["composeProfiles"])
        self.assertEqual(set(registry["steps"]), registry_steps)
        self.assertEqual(registry["runners"], ["service-marketplace-registry:local"])
        self.assertEqual(registry["composeProfiles"], ["marketplace-registry"])

        from service_runner import service_selection_groups
        default_groups = service_selection_groups(runner_selector="service-local:explore")
        registry_groups = service_selection_groups(runner_selector="service-marketplace-registry:local")
        default_lifecycle = set(default_groups["marketplace-lifecycle"].get("cases", ()))
        registry_lifecycle = set(registry_groups["marketplace-lifecycle"].get("cases", ()))
        default_registry = set(default_groups["marketplace-registry"].get("cases", ()))
        registry_registry = set(registry_groups["marketplace-registry"].get("cases", ()))
        registry_adapter = set(registry_groups["adapters"].get("cases", ()))
        self.assertIn("S-047.1", default_lifecycle)
        self.assertNotIn("S-268.1", default_lifecycle)
        self.assertNotIn("S-268.1", registry_lifecycle)
        self.assertTrue(registry_steps <= registry_registry)
        self.assertNotIn("S-047.1", registry_registry)
        self.assertFalse(registry_steps.intersection(registry_adapter))
        selection = JourneySelection(
            requested=tuple(sorted(registry_steps)),
            claims=frozenset(registry_steps),
            owning_steps={name: tuple(cases) for name, cases in registry["selectedOwningSteps"].items()},
            prerequisite_steps=frozenset(registry["prerequisiteSteps"]),
            prerequisite_flows=frozenset(registry["prerequisiteFlows"]),
            capabilities=frozenset(registry["capabilities"]),
            runner_selector=registry["runners"][0],
            requested_runners=registry["runners"][0],
        )
        journey = Journey("local", "registry-selection-excludes-adapters", selection=selection)
        graph = FlowGraph(journey, {name: spec["depends_on"] for name, spec in registry_groups.items()},
                          groups=registry_groups)
        adapter_calls = []
        adapter_flow = graph.flow(
            "adapter defaults flow", "adapters", "adapter", lambda: adapter_calls.append("ran"),
            cases=["S-054.1", "S-048.1"], record_empty_success=False,
        )
        self.assertEqual(adapter_flow, "SKIPPED")
        self.assertEqual(adapter_calls, [])
        # Imported declaration closure must not accidentally claim the unrelated MCP case.
        for cases in (default_lifecycle, registry_lifecycle, default_registry, registry_registry,
                      registry_adapter):
            self.assertNotIn("S-140.1", cases)

    def test_hermetic_fixture_stages_declared_lock_at_its_shared_root(self):
        repository = Path(__file__).resolve().parents[2]
        lock_path = Path(layout_value("versionStatePaths.kb_marketplace_lock"))
        with tempfile.TemporaryDirectory(prefix="journey-hermetic-fixture-") as temporary:
            home = Path(temporary) / "home"
            env = configure_hermetic_cli_fixture(home, env={}, workspace_root=repository)
            platform_root = Path(env["KB_PLATFORM_ROOT"])
            project_root = Path(env["KB_PROJECT_ROOT"])

            self.assertEqual(platform_root, project_root)
            self.assertEqual((platform_root / lock_path).read_bytes(),
                             (repository / lock_path).read_bytes())

    # case: S-203.1
    def test_coverage_cli_reader_requires_success_envelope(self):
        self.assertEqual(read_coverage_result(
            subprocess.CompletedProcess(["kb", "qa", "coverage", "show"], 0, '{"ok":true,"data":{"mode":"local","cases":[]}}', ""),
        ), {"mode": "local", "cases": []})
        for stdout, returncode in (
            ('{"mode":"local","cases":[]}', 0),
            ('{"ok":false,"error":{"code":"KB_TEST","message":"failed"}}', 1),
            ('{"ok":true,"data":{}}', 1),
        ):
            with self.subTest(stdout=stdout, returncode=returncode), self.assertRaises(ValueError):
                read_coverage_result(subprocess.CompletedProcess(["kb", "qa", "coverage", "show"], returncode, stdout, ""))

    def test_selector_runs_coverage_without_caller_home_or_platform_overrides(self):
        with tempfile.TemporaryDirectory() as caller_home:
            captured = []

            def invoke(command, **options):
                captured.append(options["env"])
                mode = command[command.index("--mode") + 1]
                return subprocess.CompletedProcess(command, 0, json.dumps({
                    "ok": True, "data": {"mode": mode, "cases": [{
                        "id": "S-042", "status": "active", "release": True,
                        "steps": [{"stepId": "S-042.1", "claims": [{
                            "kind": "journey", "source": "e2e/journey/service_runner.py",
                            "line": next(iter(_case_declarations(
                                "e2e/journey/service_runner.py", Path(__file__).resolve().parents[2]))),
                        }]}],
                    }]},
                }), "")

            output = StringIO()
            with patch.dict(os.environ, {
                "HOME": caller_home,
                "KB_HOME": "/caller/kb-home",
                "KB_PLATFORM_ROOT": "/caller/platform",
                "KB_NET_OFFSET": "731",
                "KB_JOURNEY_CASES": "S-042",
            }, clear=False), patch("hermetic_cli.run_command", side_effect=invoke), redirect_stdout(output):
                self.assertEqual(select_from_cases.main(), 0)

            self.assertEqual(len(captured), 2)
            for child_env in captured:
                self.assertNotEqual(child_env["HOME"], caller_home)
                self.assertFalse(Path(child_env["HOME"]).exists())
                self.assertEqual(Path(child_env["KB_HOME"]), Path(child_env["HOME"]) / ".kb")
                self.assertEqual(Path(child_env["KB_PLATFORM_ROOT"]), Path(child_env["HOME"]) / "platform")
                self.assertNotIn("KB_NET_OFFSET", child_env)
            self.assertEqual(json.loads(output.getvalue()), {
                "selection": ["S-042"], "steps": ["S-042.1"],
                "owners": {"service-local:explore": ["S-042.1"],
                           "service-secured:explore": ["S-042.1"]},
                "runners": ["service-local:explore", "service-secured:explore"],
                "prerequisiteSteps": [], "prerequisiteFlows": [],
                "stepSources": ["e2e/journey/service_runner.py"], "capabilities": ["gateway"],
                "composeProfiles": [],
                "selectedOwningSteps": {"platform readiness (gateway + project workflow)": ["S-042.1"]},
                "selectedClaimOwners": {"platform readiness (gateway + project workflow)": ["S-042.1"]},
            })

    # case: S-262.8
    def test_selector_main_limits_case_owners_to_the_requested_batch_mode(self):
        def invoke(command, **_options):
            mode = command[command.index("--mode") + 1]
            payload = {"ok": True, "data": coverage(
                mode, source="e2e/journey/secured_connection_steps.py")}
            return subprocess.CompletedProcess(command, 0, json.dumps(payload), "")

        output = StringIO()
        with patch.dict(os.environ, {
                "KB_JOURNEY_CASES": "S-042.1",
                "KB_JOURNEY_SELECTION_MODE": "local",
                "KB_JOURNEY_ONLY": "",
        }, clear=False), patch("hermetic_cli.run_command", side_effect=invoke), redirect_stdout(output):
            self.assertEqual(select_from_cases.main(), 0)

        self.assertEqual(json.loads(output.getvalue())["runners"], ["agent:commit"])

    def test_selector_failure_includes_decoded_cli_error_envelope(self):
        failure = {"ok": False, "error": {
            "code": "KB_CONFIG_INVALID",
            "message": "Saved authentication file .kb/credentials.json is invalid.",
            "hint": "Run \"kb auth login\" to replace the saved authentication data, then retry the command.",
        }}

        def invoke(command, **_options):
            return subprocess.CompletedProcess(command, 1, json.dumps(failure), "")

        with patch("hermetic_cli.run_command", side_effect=invoke), patch.dict(
            os.environ, {"KB_JOURNEY_CASES": "S-042"}, clear=False,
        ):
            with self.assertRaisesRegex(ValueError, "KB_CONFIG_INVALID; Saved authentication file") as raised:
                select_from_cases.main()
        self.assertIn("hint: Run \"kb auth login\"", str(raised.exception))

    def test_selects_only_entry_points_with_active_release_journey_claims(self):
        results = [
            coverage("local", source="e2e/journey/service_runner.py"),
            coverage("secured", source="e2e/journey/service_runner.py"),
            coverage("local", source="e2e/journey/runner.py", kind="unit"),
            coverage("local", source="e2e/journey/runner.py", status="historical"),
            coverage("local", source="e2e/journey/runner.py", release=False),
        ]
        self.assertEqual(selectors_from_coverage(results), ["service-local:explore", "service-secured:explore"])

    def test_selects_the_installer_entry_point_for_a_journey_claim(self):
        self.assertEqual(
            selectors_from_coverage([coverage("local", source="e2e/journey/runner.py")]),
            ["agent:commit"],
        )

    # case: S-262.8
    def test_partial_batch_runners_follow_selected_claim_owners_by_mode(self):
        results = [
            coverage("local", source="e2e/journey/secured_connection_steps.py"),
            coverage("secured", source="e2e/journey/secured_connection_steps.py"),
        ]

        self.assertEqual(runners_for_case_selection(results, "S-042.1", "local"), ["agent:commit"])
        self.assertEqual(runners_for_case_selection(results, "S-042.1", "secured"),
                         ["agent-secured:commit"])

    # case: S-262.8
    def test_partial_batch_filters_claims_owned_by_different_modes(self):
        source = "e2e/journey/service_runner.py"
        root = Path(__file__).resolve().parents[2]
        declarations = _case_declarations(source, root)
        local_line = next(line for line, declaration in declarations.items()
                          if "S-045.4" in declaration.get("cases", ()))
        secured_line = next(line for line, declaration in declarations.items()
                            if "S-045.5" in declaration.get("cases", ()))
        results = []
        for mode in ("local", "secured"):
            results.append({
                "mode": mode,
                "cases": [{
                    "id": "S-045",
                    "status": "active",
                    "release": True,
                    "steps": [
                        {"stepId": "S-045.4", "claims": [{
                            "source": source, "kind": "journey", "line": local_line,
                        }]},
                        {"stepId": "S-045.5", "claims": [{
                            "source": source, "kind": "journey", "line": secured_line,
                        }]},
                    ],
                }],
            })

        self.assertEqual(runners_for_case_selection(results, "S-045.4,S-045.5", "local"),
                         ["service-local:explore"])
        self.assertEqual(runners_for_case_selection(results, "S-045.4,S-045.5", "secured"),
                         ["service-secured:explore"])

    # case: S-262.8
    def test_partial_batch_mode_without_selected_owners_returns_empty(self):
        self.assertEqual(runners_for_case_selection(
            [coverage("local", source="e2e/journey/secured_connection_steps.py")], "S-042.1", "secured"), [])

    # case: S-262.8
    def test_partial_batch_keeps_all_same_mode_claim_owners(self):
        source = "e2e/journey/installer_case_steps.py"
        root = Path(__file__).resolve().parents[2]
        line = next(line for line, declaration in _case_declarations(source, root).items()
                    if "S-187.11" in declaration.get("cases", ()))
        results = [{
            "mode": "local",
            "cases": [{
                "id": "S-187",
                "status": "active",
                "release": True,
                "steps": [{"stepId": "S-187.11", "claims": [{
                    "source": source, "kind": "journey", "line": line,
                }]}],
            }],
        }]
        self.assertEqual(runners_for_case_selection(
            results, "S-187.11", "local"),
            ["agent:commit", "service-local:explore"],
        )

    def test_rejects_unknown_coverage_modes(self):
        with self.assertRaisesRegex(ValueError, "unsupported QA coverage mode"):
            selectors_from_coverage([coverage("nightly", source="e2e/journey/service_runner.py")])

    def test_resolves_cases_and_steps_from_the_qa_claim_registry(self):
        result = selection_from_coverage([
            coverage("local", source="e2e/journey/service_runner.py"),
            coverage("secured", source="e2e/journey/service_runner.py"),
        ], "S-042,S-042.1")
        self.assertEqual(result, {
            "selection": ["S-042", "S-042.1"], "steps": ["S-042.1"],
            "owners": {"service-local:explore": ["S-042.1"],
                       "service-secured:explore": ["S-042.1"]},
            "runners": ["service-local:explore", "service-secured:explore"],
            "prerequisiteSteps": [], "prerequisiteFlows": [],
            "stepSources": ["e2e/journey/service_runner.py"], "capabilities": ["gateway"],
            "composeProfiles": [],
            "selectedOwningSteps": {"platform readiness (gateway + project workflow)": ["S-042.1"]},
            "selectedClaimOwners": {"platform readiness (gateway + project workflow)": ["S-042.1"]},
        })

    def test_rejects_unknown_case_or_step_id_by_name(self):
        with self.assertRaisesRegex(ValueError, "S-999"):
            selection_from_coverage([coverage("local", source="e2e/journey/service_runner.py")], "S-999")

    def test_case_selection_refuses_unclaimed_steps_before_runner_start(self):
        result = coverage("local", source="e2e/journey/service_runner.py")
        result["cases"][0]["id"] = "PC-002"
        result["cases"][0]["steps"].append({"stepId": "PC-002.4", "claims": []})
        with self.assertRaisesRegex(ValueError, r"PC-002.*unclaimed.*PC-002.4"):
            selection_from_coverage([result], "PC-002")

    def test_only_filters_resolved_runners_and_reports_omitted_owners(self):
        results = [
            coverage("local", source="e2e/journey/runner.py"),
            coverage("secured", source="e2e/journey/runner.py"),
        ]
        with patch.dict(os.environ, {"KB_JOURNEY_ONLY": "agent:commit,agent-secured:commit"}):
            resolved = selection_from_coverage(results, "S-042.1")
        self.assertEqual(resolved["runners"], ["agent-secured:commit", "agent:commit"])
        with patch.dict(os.environ, {"KB_JOURNEY_ONLY": "agent:commit"}):
            local = selection_from_coverage(results, "S-042.1")
        self.assertEqual(local["runners"], ["agent:commit"])
        with patch.dict(os.environ, {"KB_JOURNEY_ONLY": "service-local:explore"}):
            with self.assertRaisesRegex(ValueError, r"agent:commit owns S-042.1: KB_JOURNEY_CASES=S-042.1 KB_JOURNEY_ONLY=agent:commit"):
                selection_from_coverage(results, "S-042.1")

    def test_full_run_runner_plan_still_uses_all_active_claim_owners(self):
        results = [
            coverage("local", source="e2e/journey/runner.py"),
            coverage("secured", source="e2e/journey/runner.py"),
        ]
        self.assertEqual(selectors_from_coverage(results), ["agent-secured:commit", "agent:commit"])

    def test_resolve_only_does_not_write_journey_reports(self):
        root = Path(__file__).resolve().parents[2]
        reports = root / ".journey" / "reports"
        before = {path.relative_to(root).as_posix(): (path.stat().st_size, path.stat().st_mtime_ns)
                  for path in reports.rglob("*") if path.is_file()} if reports.exists() else None
        with tempfile.TemporaryDirectory(prefix="journey-resolve-home-") as home:
            env = os.environ.copy()
            env.update({"KB_JOURNEY_ONLY": "agent:commit", "HOME": home})
            for key in ("KB_JOURNEY_CASES", "KB_PLATFORM_ROOT", "KB_HOME", "KB_NET_OFFSET"):
                env.pop(key, None)
            result = subprocess.run(["bash", "e2e/journey/run.sh", "--resolve-only"], cwd=root, env=env,
                                    capture_output=True, text=True, check=False, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('"front_door": "agent"', result.stdout)
        after = {path.relative_to(root).as_posix(): (path.stat().st_size, path.stat().st_mtime_ns)
                 for path in reports.rglob("*") if path.is_file()} if reports.exists() else None
        self.assertEqual(after, before)

    def test_real_resolve_only_keeps_s181_and_mcp_claim_owners(self):
        root = Path(__file__).resolve().parents[2]
        expected = {
            ("S-181.7", "local"): ("agent:commit", "platform.install"),
            ("S-181.7", "secured"): ("agent-secured:commit", "platform.install"),
            ("S-140.5", "local"): ("service-local:explore", "mcp"),
            ("S-140.5", "secured"): ("service-secured:explore", "mcp"),
        }
        for (case_id, mode), (selector, capability) in expected.items():
            with self.subTest(case=case_id, mode=mode):
                env = os.environ.copy()
                env.update({"KB_JOURNEY_CASES": case_id, "KB_JOURNEY_SELECTION_MODE": mode})
                for key in ("KB_JOURNEY_ONLY", "KB_JOURNEY_SELECTED_STEPS",
                            "KB_JOURNEY_SELECTED_OWNING_STEPS", "KB_JOURNEY_PREREQUISITE_STEPS"):
                    env.pop(key, None)
                result = subprocess.run(
                    ["bash", "e2e/journey/run.sh", "--resolve-only"], cwd=root, env=env,
                    capture_output=True, text=True, check=False, timeout=120,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                resolved = json.loads(result.stdout)
                self.assertEqual(resolved["selection"], [case_id])
                self.assertEqual(resolved["runners"], [selector])
                self.assertIn(capability, resolved["capabilities"])
                if case_id == "S-181.7":
                    self.assertIn("install and reapply generated secrets from the offline artifact cache",
                                  resolved["selectedOwningSteps"])
                else:
                    self.assertIn("project MCP cross-project isolation", resolved["selectedOwningSteps"])

    def test_runner_variant_registration_is_enforced_when_claim_executes(self):
        with patch.dict(os.environ, {
                "KB_JOURNEY_SELECTED_STEPS": "S-040.3",
                "KB_JOURNEY_RUNNER_SELECTOR": "agent:commit",
        }, clear=False):
            journey = Journey("local", "wrong-variant")
            result = journey.step("post-install running status", "platform.install", lambda: None,
                                  cases=["S-040.3"], runners=("human:default",))
        self.assertEqual(result.status, "FAIL")
        self.assertIn("registered for runner(s) human:default", result.message)

    def test_unselected_runner_variant_registration_is_not_emitted(self):
        with patch.dict(os.environ, {"KB_JOURNEY_RUNNER_SELECTOR": "agent:commit"}, clear=False):
            journey = Journey("local", "wrong-unselected-variant")
            result = journey.step("human-only install", "platform.install", lambda: None,
                                  cases=["S-040.1"], runners=("human:default",))
        self.assertEqual(result.status, "SKIPPED")

    def test_every_registry_claim_is_reachable_by_step_selection(self):
        result = coverage("local", source="e2e/journey/service_runner.py")
        case = result["cases"][0]
        case["steps"] = [
            {"stepId": f"S-042.{number}", "claims": [{
                "kind": "journey", "source": "e2e/journey/service_runner.py",
                "line": next(iter(_case_declarations("e2e/journey/service_runner.py",
                                                       Path(__file__).resolve().parents[2])))}]}
            for number in (1, 2, 3)
        ]
        for step in case["steps"]:
            step_id = step["stepId"]
            self.assertEqual(selection_from_coverage([result], step_id)["steps"], [step_id])

    def test_unselected_claimed_step_is_reported_skipped_and_not_claimed(self):
        with patch.dict("os.environ", {"KB_JOURNEY_CASES": "S-042", "KB_JOURNEY_SELECTED_STEPS": "S-042.1"}):
            journey = Journey("local")
            skipped = journey.step("other step", "auth", lambda: self.fail("check must not run"),
                                   cases=["S-042.2"])
            self.assertEqual(skipped.status, "SKIPPED")
            self.assertEqual(skipped.message, "not selected")
            unclaimed = journey.step("unclaimed helper", "auth", lambda: self.fail("helper must not run"))
            self.assertEqual(unclaimed.status, "SKIPPED")
            self.assertEqual(journey.result().case_run["claims"], [])
            case_run = journey.result().case_run
            self.assertNotIn("partial", case_run)
            self.assertEqual(case_run["selection"], ["S-042"])

if __name__ == "__main__":
    unittest.main()
