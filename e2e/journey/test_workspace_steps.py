from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from service_steps import Journey
from installed_fixture import layout_value
from workspace_steps import run_workspace_cli_steps, workspace_checkout_problem


def workspace_root_with_registry_plugin_lock(source_root: Path, fixture_root: Path) -> Path:
    fixture_root.mkdir()
    for entry in source_root.iterdir():
        if entry.name in {".git", ".kb", "node_modules"}:
            continue
        (fixture_root / entry.name).symlink_to(entry, target_is_directory=entry.is_dir())
    kb_dir = fixture_root / ".kb"
    kb_dir.mkdir()
    source_lock = json.loads(
        (source_root / layout_value("versionStatePaths.kb_marketplace_lock")).read_text(encoding="utf-8"))
    release = source_lock.get("plugins", {}).get("@kb-labs/release")
    if not isinstance(release, dict):
        raise AssertionError("workspace fixture requires the release plugin lock entry")
    (kb_dir / "marketplace.lock").write_text(json.dumps({"plugins": {
        "@kb-labs/release": {**release, "link": "./plugins/release"},
    }}), encoding="utf-8")
    config = source_root / ".kb" / "kb.config.jsonc"
    if config.is_file():
        (kb_dir / "kb.config.jsonc").symlink_to(config)
    else:
        (kb_dir / "kb.config.jsonc").write_text("{}\n", encoding="utf-8")
    return fixture_root


class WorkspaceCliStepsTest(unittest.TestCase):
    def test_workspace_precheck_still_requires_manifests_for_explicitly_linked_plugins(self):
        with tempfile.TemporaryDirectory(prefix="kb-workspace-linked-plugin-") as directory:
            root = Path(directory)
            for relative in (
                "cli/bin/dist/bin.js",
                "core/project-registry/dist/index.js",
                "plugins/marketplace-registry/dist/manifest.js",
                "plugins/marketplace-registry/dist/commands/publish.js",
                "plugins",
            ):
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                if relative == "plugins":
                    continue
                path.write_text("", encoding="utf-8")
            (root / "plugins/example/package.json").parent.mkdir(parents=True)
            (root / "plugins/example/package.json").write_text(
                json.dumps({"kb": {"manifest": "dist/manifest.js"}}), encoding="utf-8")
            lock_path = root / layout_value("versionStatePaths.kb_marketplace_lock")
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            lock_path.write_text(json.dumps({"plugins": {
                "@kb-labs/example": {"link": "plugins/example"},
            }}), encoding="utf-8")

            problem = workspace_checkout_problem(root)

        self.assertIsNotNone(problem)
        self.assertIn("plugins/example/dist/manifest.js", problem)

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
        source_root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="kb-workspace-cli-source-") as directory:
            repo_root = workspace_root_with_registry_plugin_lock(source_root, Path(directory) / "workspace")
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
        source_root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="kb-workspace-cli-config-") as directory:
            repo_root = workspace_root_with_registry_plugin_lock(source_root, Path(directory) / "workspace")
            journey = Journey("local", "workspace-cli-project-config-scope")
            run_workspace_cli_steps(journey, repo_root)

        result = journey.result()
        self.assertEqual(result.status, "PASS", result.first_failure)
        self.assertIn("S-203.27", {claim["claimId"] for claim in result.case_run["claims"]})


if __name__ == "__main__":
    unittest.main()
