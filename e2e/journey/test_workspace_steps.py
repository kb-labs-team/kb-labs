from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from service_steps import Journey
from workspace_steps import run_workspace_cli_steps


class WorkspaceCliStepsTest(unittest.TestCase):
    def test_missing_workspace_checkout_fails_once_with_all_workspace_claims(self):
        with tempfile.TemporaryDirectory(prefix="kb-workspace-missing-") as directory:
            journey = Journey("local", "workspace-cli-missing")
            run_workspace_cli_steps(journey, Path(directory))

        result = journey.result()
        self.assertEqual(len(result.steps), 1)
        self.assertIn("workspace checkout", result.steps[0]["message"])
        self.assertIn("KB_JOURNEY_WORKSPACE_ROOT", result.steps[0]["message"])
        claims = {claim["claimId"] for claim in result.case_run["claims"]}
        self.assertEqual(claims, {
            "S-179.2", "S-179.3", "S-179.4", "S-179.5", "S-179.13", "S-179.33",
            "S-142.5", "S-203.1", "S-203.19", "S-204.7",
        })

    def test_workspace_cli_loads_plugins_and_validates_cases(self):
        repo_root = Path(__file__).resolve().parents[2]
        journey = Journey("local", "workspace-cli")
        run_workspace_cli_steps(journey, repo_root)

        result = journey.result()
        claims = {claim["claimId"] for claim in result.case_run["claims"]}
        self.assertEqual(result.status, "PASS", result.first_failure)
        self.assertEqual(claims, {
            "S-179.2", "S-179.3", "S-179.4", "S-179.5", "S-179.13", "S-179.33", "S-142.5", "S-203.1", "S-203.19",
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
