from __future__ import annotations

import sys
import tempfile
import unittest
import platform
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from service_steps import Journey
from journey_selection import read_journey_selection
from select_from_cases import _case_declarations
from devkit_cache_steps import DEVKIT_CACHE_CLAIMS, run_devkit_cache_steps
from workspace_steps import DEVKIT_ZONE_CLAIMS, run_devkit_zone_steps, run_workspace_cli_steps


class WorkspaceCliStepsTest(unittest.TestCase):
    def test_missing_workspace_checkout_fails_once_with_all_workspace_claims(self):
        with tempfile.TemporaryDirectory(prefix="kb-workspace-missing-") as directory:
            journey = Journey("local", "workspace-cli-missing")
            run_workspace_cli_steps(journey, Path(directory))

        result = journey.result()
        self.assertEqual(len(result.steps), 14)
        self.assertIn("workspace checkout", result.steps[0]["message"])
        self.assertIn("KB_JOURNEY_WORKSPACE_ROOT", result.steps[0]["message"])
        claims = {claim["claimId"] for claim in result.case_run["claims"]}
        self.assertEqual(claims, {
            "S-179.2", "S-179.3", "S-179.4", "S-179.5", "S-179.13", "S-179.33",
            "S-142.5", "S-203.1", "S-203.19", "S-204.7",
        })
        zone_statuses = {case_id: step["status"] for step in result.steps
                         for case_id in step.get("cases", []) if case_id in DEVKIT_ZONE_CLAIMS}
        self.assertEqual(zone_statuses, {claim: "BLOCKED" for claim in DEVKIT_ZONE_CLAIMS})
        cache_statuses = {case_id: step["status"] for step in result.steps
                          for case_id in step.get("cases", []) if case_id in DEVKIT_CACHE_CLAIMS}
        self.assertEqual(cache_statuses, {claim: "BLOCKED" for claim in DEVKIT_CACHE_CLAIMS})

    def test_devkit_zone_journey_executes_the_real_candidate_binary(self):
        repo_root = Path(__file__).resolve().parents[2]
        journey = Journey("local", "devkit-zone-cli")
        run_devkit_zone_steps(journey, repo_root)

        result = journey.result()
        statuses = {claim["claimId"]: claim["status"] for claim in result.case_run["claims"]}
        self.assertEqual(statuses, {claim: "PASS" for claim in DEVKIT_ZONE_CLAIMS}, result.first_failure)
        self.assertEqual(result.status, "PASS", result.first_failure)

    def test_devkit_cache_journey_executes_the_real_candidate_binary(self):
        repo_root = Path(__file__).resolve().parents[2]
        journey = Journey("local", "devkit-cache-cli", selection=read_journey_selection({
            "KB_JOURNEY_RUNNER_SELECTOR": "service-local:explore",
        }))
        run_devkit_cache_steps(journey, repo_root)

        result = journey.result()
        statuses = {claim["claimId"]: claim["status"] for claim in result.case_run["claims"]}
        self.assertEqual(statuses, {claim: "PASS" for claim in DEVKIT_CACHE_CLAIMS}, result.first_failure)
        self.assertEqual(result.status, "PASS", result.first_failure)

    def test_cache_claims_have_concrete_local_service_steps(self):
        root = Path(__file__).resolve().parents[2]
        source = "e2e/journey/devkit_cache_steps.py"
        declarations = _case_declarations(source, root).values()
        steps = {claim for step in declarations for claim in step.get("cases") or ()}
        self.assertEqual(steps, set(DEVKIT_CACHE_CLAIMS))
        self.assertTrue(all(step["runners"] == ["service-local:explore"]
                            for step in declarations if step.get("cases")))
        flows = _case_declarations("e2e/journey/service_runner.py", root).values()
        workspace = next(flow for flow in flows if flow["name"] == "workspace CLI flows")
        self.assertTrue(steps.issubset(workspace.get("cases") or ()))

    def test_selected_source_only_claim_runs_without_other_cache_probes(self):
        selection = read_journey_selection({
            "KB_JOURNEY_SELECTED_STEPS": "S-298.8",
            "KB_JOURNEY_RUNNER_SELECTOR": "service-local:explore",
        })
        journey = Journey("local", "devkit-cache-source-only", selection=selection)
        run_devkit_cache_steps(journey, Path(__file__).resolve().parents[2])
        result = journey.result()
        executed = [step for step in result.steps if step["status"] != "SKIPPED"]
        self.assertEqual([(step["cases"], step["status"]) for step in executed],
                         [(["S-298.8"], "PASS")], result.first_failure)

    def test_missing_or_incompatible_devkit_binary_blocks_all_zone_claims(self):
        with tempfile.TemporaryDirectory(prefix="kb-devkit-zone-binary-absent-") as temporary:
            repo_root = Path(temporary)
            journey = Journey("local", "devkit-zone-cli-missing")
            run_devkit_zone_steps(journey, repo_root)
        result = journey.result()
        statuses = {case_id: step["status"] for step in result.steps
                    for case_id in step.get("cases", []) if case_id in DEVKIT_ZONE_CLAIMS}
        self.assertEqual(statuses, {claim: "BLOCKED" for claim in DEVKIT_ZONE_CLAIMS})

        with tempfile.TemporaryDirectory(prefix="kb-devkit-zone-binary-incompatible-") as temporary:
            repo_root = Path(temporary)
            binary = repo_root / "tools" / "kb-devkit" / "kb-devkit"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b"not-a-linux-executable")
            binary.chmod(0o755)
            journey = Journey("local", "devkit-zone-cli-incompatible")
            run_devkit_zone_steps(journey, repo_root)
        result = journey.result()
        blocked_steps = [step for step in result.steps if step.get("cases")]
        statuses = {case_id: step["status"] for step in blocked_steps
                    for case_id in step.get("cases", []) if case_id in DEVKIT_ZONE_CLAIMS}
        self.assertEqual(statuses, {claim: "BLOCKED" for claim in DEVKIT_ZONE_CLAIMS})
        expected_format = {
            "Linux": "supported Linux ELF",
            "Darwin": "supported Darwin Mach-O",
        }.get(platform.system())
        self.assertIsNotNone(expected_format, f"test runner OS is unsupported: {platform.system()}")
        self.assertTrue(all(expected_format in step["message"] for step in blocked_steps))

    def test_workspace_cli_loads_plugins_and_validates_cases(self):
        repo_root = Path(__file__).resolve().parents[2]
        journey = Journey("local", "workspace-cli", selection=read_journey_selection({
            "KB_JOURNEY_RUNNER_SELECTOR": "service-local:explore",
        }))
        run_workspace_cli_steps(journey, repo_root)

        result = journey.result()
        claims = {claim["claimId"] for claim in result.case_run["claims"]}
        self.assertEqual(result.status, "PASS", result.first_failure)
        self.assertEqual(claims, {
            "S-179.2", "S-179.3", "S-179.4", "S-179.5", "S-179.13", "S-179.33", "S-179.50", "S-179.51", "S-179.52", *DEVKIT_CACHE_CLAIMS, "S-142.5", "S-203.1", "S-203.19",
            "S-203.27",
        })

    def test_workspace_cli_reports_project_scope_config_recovery_command(self):
        repo_root = Path(__file__).resolve().parents[2]
        journey = Journey("local", "workspace-cli-project-config-scope")
        run_workspace_cli_steps(journey, repo_root)

        result = journey.result()
        self.assertEqual(result.status, "PASS", result.first_failure)
        self.assertIn("S-203.27", {claim["claimId"] for claim in result.case_run["claims"]})


if __name__ == "__main__":
    unittest.main()
