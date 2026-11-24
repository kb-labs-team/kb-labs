from __future__ import annotations

import os
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from installed_fixture import configure_hermetic_cli_fixture


def isolated_environment(home: Path, fixture_bin: Path, *, required_tools=(), overrides=None) -> dict[str, str]:
    """Build child env from explicit tools and fixtures, never the caller env."""
    tool_bin = home / ".journey-test-path"
    tool_bin.mkdir(parents=True, exist_ok=True)
    for tool in required_tools:
        name = tool[0] if isinstance(tool, (list, tuple)) else tool
        resolved = shutil.which(name)
        if resolved is None:
            raise FileNotFoundError(f"required journey test tool is unavailable: {name}")
        source = Path(resolved).resolve()
        target = tool_bin / name
        if not target.exists():
            target.symlink_to(source)
    env = {
        "HOME": str(home),
        "PATH": os.pathsep.join((str(fixture_bin), str(tool_bin))),
        "LANG": "C.UTF-8",
        "TERM": "xterm-256color",
    }
    env.update(overrides or {})
    return env


def require_compose_command(test_case) -> list[str]:
    """Resolve Compose through the workspace owner or skip its missing precondition."""
    owner = Path(__file__).resolve().parents[1] / "compose-owner.sh"
    resolved = subprocess.run(["bash", str(owner), "resolve"], capture_output=True, text=True, check=False)
    if resolved.returncode != 0:
        test_case.skipTest(resolved.stderr.strip())
    return json.loads(resolved.stdout)


class ComposeCommandTests(unittest.TestCase):
    def test_workspace_owner_selects_available_compose_command(self):
        command = require_compose_command(self)
        self.assertIn(command, (["docker", "compose"], ["docker-compose"]))

    def test_isolated_path_stages_only_the_compose_executable(self):
        command = require_compose_command(self)
        with tempfile.TemporaryDirectory(prefix="journey-compose-tool-") as temporary:
            env = isolated_environment(
                Path(temporary) / "home",
                Path(temporary) / "bin",
                required_tools=(tuple(command),),
            )
            tool_bin = Path(env["PATH"].split(os.pathsep)[1])
            self.assertTrue((tool_bin / command[0]).is_symlink())
            if len(command) > 1:
                self.assertFalse((tool_bin / command[1]).exists())

    def test_hermetic_cli_fixture_does_not_inherit_forced_color(self):
        with tempfile.TemporaryDirectory(prefix="journey-cli-color-") as temporary:
            env = configure_hermetic_cli_fixture(
                Path(temporary),
                env={"FORCE_COLOR": "1", "PATH": os.environ.get("PATH", "")},
            )
        self.assertNotIn("FORCE_COLOR", env)

    def test_hermetic_workspace_fixture_resolves_local_plugins_from_workspace(self):
        with tempfile.TemporaryDirectory(prefix="journey-workspace-plugins-") as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            (workspace / ".kb").mkdir(parents=True)
            (workspace / "plugins" / "sample").mkdir(parents=True)
            (workspace / "e2e").mkdir()
            (workspace / "node_modules" / ".pnpm" / "node_modules" / "test-dependency").mkdir(parents=True)
            (workspace / ".kb" / "marketplace.lock").write_text(
                json.dumps({"schema": "kb.marketplace/3", "plugins": {
                    "@kb-labs/workspace-fixture": {"source": "local", "resolvedPath": "plugins/sample"},
                }, "adapters": {"workspace-adapter": {
                    "version": "workspace", "resolvedPath": "./adapters/workspace",
                }}}), encoding="utf-8")
            installed = root / "active-platform"
            adapter = installed / "node_modules" / "@kb-labs" / "adapters-pino"
            adapter.mkdir(parents=True)
            (adapter / "package.json").write_text(json.dumps({
                "name": "@kb-labs/adapters-pino", "version": "2.120.1",
            }), encoding="utf-8")
            (installed / ".kb" / "v2").mkdir(parents=True)
            (installed / ".kb" / "v2" / "installed-provenance.json").write_text(json.dumps({
                "schema": "kb.create.installed-provenance/v1", "packages": [{
                    "name": "@kb-labs/adapters-pino", "version": "2.120.1",
                    "installedPath": "node_modules/@kb-labs/adapters-pino",
                }],
            }), encoding="utf-8")
            (installed / ".kb" / "marketplace.lock").write_text(json.dumps({
                "schema": "kb.marketplace/3", "plugins": {}, "adapters": {
                    "pino-logger": {
                        "version": "2.120.1",
                        "resolvedPath": "node_modules/@kb-labs/adapters-pino",
                        "enabled": True,
                        "source": "platform",
                    },
                },
            }), encoding="utf-8")
            with patch("installed_fixture.write_local_access_mode", side_effect=lambda platform_root, _source_config: platform_root):
                env = configure_hermetic_cli_fixture(
                    root / "home", env={}, workspace_root=workspace,
                    installed_platform_root=installed,
                )

            staged_plugins = Path(env["KB_PLATFORM_ROOT"]) / "plugins"
            self.assertTrue(staged_plugins.is_symlink())
            self.assertEqual(staged_plugins.resolve(), (workspace / "plugins").resolve())
            self.assertEqual(env["KB_PROJECT_ROOT"], env["KB_PLATFORM_ROOT"])
            staged_adapter = Path(env["KB_PLATFORM_ROOT"]) / "node_modules" / "@kb-labs" / "adapters-pino"
            self.assertTrue(staged_adapter.is_symlink())
            self.assertEqual(staged_adapter.resolve(), adapter.resolve())
            self.assertTrue((Path(env["KB_PLATFORM_ROOT"]) / "node_modules" / "test-dependency").is_symlink())
            lock = json.loads((Path(env["KB_PLATFORM_ROOT"]) / ".kb" / "marketplace.lock").read_text())
            self.assertEqual(lock["plugins"], {
                "@kb-labs/workspace-fixture": {"source": "local", "resolvedPath": "plugins/sample"},
            })
            self.assertEqual(lock["adapters"]["pino-logger"]["resolvedPath"],
                             "node_modules/@kb-labs/adapters-pino")
            self.assertNotIn("workspace-adapter", lock["adapters"])
            self.assertTrue((Path(env["KB_PLATFORM_ROOT"]) / lock["adapters"]["pino-logger"]["resolvedPath"]
                             / "package.json").is_file())


def stage_cli_root(repository_root: Path, target_root: Path) -> Path:
    """Stage the built CLI under an isolated installed root without workspace config."""
    shutil.copytree(repository_root / "cli" / "bin" / "dist", target_root / "cli" / "bin" / "dist")
    package_modules = target_root / "cli" / "bin" / "node_modules"
    package_modules.symlink_to(repository_root / "cli" / "bin" / "node_modules", target_is_directory=True)
    (target_root / "node_modules").symlink_to(repository_root / "node_modules", target_is_directory=True)
    return target_root
