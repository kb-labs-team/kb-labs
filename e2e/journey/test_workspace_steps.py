from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from service_steps import Journey
from installed_fixture import layout_value
from journey_resources import config_parser_source_path
from invocations import run_command
from workspace_steps import run_workspace_cli_steps, workspace_checkout_problem


def workspace_root_with_registry_plugin_lock(source_root: Path, fixture_root: Path) -> Path:
    fixture_root.mkdir()
    for entry in source_root.iterdir():
        if entry.name in {".git", ".kb", "node_modules"}:
            continue
        (fixture_root / entry.name).symlink_to(entry, target_is_directory=entry.is_dir())
    kb_dir = fixture_root / ".kb"
    kb_dir.mkdir()
    lock = {
        "schema": "kb.marketplace/3",
        "plugins": {
            "@kb-labs/release": {
                "source": "local",
                "link": "./plugins/release",
                "enabled": True,
            },
        },
        "adapters": {},
    }
    (kb_dir / "marketplace.lock").write_text(json.dumps(lock), encoding="utf-8")
    config = source_root / ".kb" / "kb.config.jsonc"
    if config.is_file():
        output_config = kb_dir / "kb.config.jsonc"
        script = (
            "import { readFileSync, writeFileSync } from 'node:fs'; "
            "const { parseJsonc } = await import(process.argv[1]); "
            "const config = parseJsonc(readFileSync(process.argv[2], 'utf8')); "
            "config.marketplace ??= {}; config.marketplace.sync ??= {}; "
            "config.marketplace.sync.include = ['plugins/release', 'plugins/review', 'plugins/mind', "
            "'plugins/agents', 'adapters/fs']; "
            "writeFileSync(process.argv[3], JSON.stringify(config));"
        )
        result = run_command(
            ["node", "--input-type=module", "-e", script,
             config_parser_source_path().as_uri(), str(config), str(output_config)],
            cwd=source_root,
            timeout=30,
        )
        if result.returncode != 0:
            raise AssertionError(f"could not prepare scoped workspace config fixture: {result.stderr or result.stdout}")
    else:
        raise AssertionError("workspace fixture requires .kb/kb.config.jsonc")
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

    def test_registry_sync_fixture_roots_are_in_registry_build_closure(self):
        result = run_command(
            ["node", "e2e/journey/registry-build-roots.mjs"],
            cwd=Path(__file__).resolve().parents[2],
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        roots = set((result.stdout or "").strip().split(","))
        self.assertTrue({
            "@kb-labs/release",
            "@kb-labs/review",
            "@kb-labs/mind",
            "@kb-labs/agents",
            "@kb-labs/adapters-fs",
        }.issubset(roots))

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
