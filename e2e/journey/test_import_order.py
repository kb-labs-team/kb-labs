from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from test_docker_build_inputs import copy_instructions


JOURNEY_DIR = Path(__file__).resolve().parent
REPOSITORY_ROOT = JOURNEY_DIR.parents[1]
RUNNER_DOCKERFILE = JOURNEY_DIR / "Dockerfile.runner"


def _docker_copy_resources() -> list[tuple[str, str]]:
    return copy_instructions(RUNNER_DOCKERFILE, final_stage_only=True)


def _docker_installed_runner_modules(resources: list[tuple[str, str]], journey_root: Path) -> set[str]:
    modules: set[str] = set()
    for source, destination in resources:
        if not destination.startswith("/usr/local/bin/"):
            continue
        source_path = Path(source)
        if source_path.suffix == ".py" and source_path.is_relative_to(Path("e2e/journey")):
            modules.add(_module_name(journey_root / source_path.relative_to("e2e/journey"), journey_root))
    return modules


def _module_name(source: Path, journey_root: Path = JOURNEY_DIR) -> str:
    relative = source.relative_to(journey_root).with_suffix("")
    parts = list(relative.parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def _journey_modules(journey_root: Path = JOURNEY_DIR,
                     resources: list[tuple[str, str]] | None = None) -> list[str]:
    modules = {
        _module_name(source, journey_root)
        for source in journey_root.rglob("*.py")
        if "__pycache__" not in source.parts
    }
    modules.update(_docker_installed_runner_modules(resources or _docker_copy_resources(), journey_root))
    return sorted(module for module in modules if module)


class JourneyImportOrderTests(unittest.TestCase):
    def test_runner_image_keeps_ux_contract_at_its_repository_relative_path(self):
        from journey_resources import RUNNER_IMAGE_RESOURCES

        resource = next(item for item in RUNNER_IMAGE_RESOURCES
                        if item.source == "core/platform/contracts/ux-result")
        self.assertEqual(
            resource.destination,
            "/opt/kb-journey/core/platform/contracts/ux-result",
        )

    def test_workspace_layout_resolves_the_built_config_parser(self):
        env = os.environ.copy()
        env.pop("KB_JOURNEY_RESOURCE_LAYOUT", None)
        env["PYTHONPATH"] = str(JOURNEY_DIR)
        resolved = subprocess.run(
            [sys.executable, "-B", "-c",
             "from journey_resources import config_parser_source_path; "
             "print(config_parser_source_path())"],
            cwd=REPOSITORY_ROOT, env=env, text=True, capture_output=True, check=False,
        )
        self.assertEqual(resolved.returncode, 0, resolved.stderr or resolved.stdout)
        self.assertEqual(Path(resolved.stdout.strip()), REPOSITORY_ROOT / "core/config/dist/index.js")

        imported = subprocess.run(
            ["node", "--input-type=module", "-e",
             "const { parseJsonc } = await import(process.argv[1]); "
             "if (parseJsonc('{\\\"ok\\\":true}').ok !== true) process.exit(1)",
             (REPOSITORY_ROOT / "core/config/dist/index.js").as_uri()],
            cwd=REPOSITORY_ROOT, env=env, text=True, capture_output=True, check=False,
        )
        self.assertEqual(imported.returncode, 0, imported.stderr or imported.stdout)

    def test_unknown_resource_layout_has_a_named_diagnostic(self):
        env = os.environ.copy()
        env["KB_JOURNEY_RESOURCE_LAYOUT"] = "unrecognized-layout"
        env["PYTHONPATH"] = str(JOURNEY_DIR)
        result = subprocess.run(
            [sys.executable, "-B", "-c",
             "from journey_resources import config_parser_source_path; config_parser_source_path()"],
            cwd=REPOSITORY_ROOT, env=env, text=True, capture_output=True, check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unknown journey resource layout 'unrecognized-layout'", result.stderr)

    def test_runner_layout_names_a_missing_parser_and_recovery_command(self):
        with tempfile.TemporaryDirectory(prefix="journey-missing-layout-") as temporary:
            journey_root = Path(temporary) / "e2e/journey"
            journey_root.mkdir(parents=True)
            shutil.copy2(JOURNEY_DIR / "journey_resources.py", journey_root / "journey_resources.py")
            shutil.copy2(JOURNEY_DIR / "journey_values.py", journey_root / "journey_values.py")
            env = os.environ.copy()
            env["PYTHONPATH"] = str(journey_root)
            env["KB_JOURNEY_RESOURCE_LAYOUT"] = "runner-image"
            result = subprocess.run(
                [sys.executable, "-B", "-c",
                 "from journey_resources import config_parser_source_path; config_parser_source_path()"],
                cwd=journey_root, env=env, text=True, capture_output=True, check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("journey resource layout 'runner-image'", result.stderr)
            self.assertIn("core/config/dist/jsonc-edit.mjs", result.stderr)
            self.assertIn("bash e2e/journey/stage-runner-inputs.sh", result.stderr)

    def test_runner_inputs_are_materialized_by_the_runner_stage(self):
        staged = subprocess.run(
            ["bash", str(JOURNEY_DIR / "stage-runner-inputs.sh")],
            cwd=REPOSITORY_ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(
            staged.returncode,
            0,
            f"runner input stage failed\nstdout:\n{staged.stdout}\nstderr:\n{staged.stderr}",
        )

    def test_runner_marketplace_fixture_starts_from_its_bundled_workspace_closure(self):
        from journey_resources import stage_marketplace_sync_fixture, workspace_resource
        from marketplace_sync_fixture import marketplace_sync_fixture_command

        stage_marketplace_sync_fixture()
        bundle = workspace_resource(".journey", "runner-inputs", "marketplace-sync-server.mjs")
        with tempfile.TemporaryDirectory(prefix="journey-marketplace-runner-root-") as temporary:
            process = subprocess.Popen(
                marketplace_sync_fixture_command(temporary, fixture_path=bundle),
                cwd=REPOSITORY_ROOT,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            try:
                stdout, stderr = process.communicate(timeout=3)
            except subprocess.TimeoutExpired as error:
                process.terminate()
                stdout, stderr = process.communicate(timeout=3)
                self.assertEqual(process.returncode, 0, stderr)
                self.assertTrue(stdout.splitlines(), "bundled Marketplace fixture did not emit its URL")
                self.assertTrue(json.loads(stdout.splitlines()[0])["url"].startswith("http://127.0.0.1:"))
            else:
                self.fail(f"bundled Marketplace fixture exited before serving: {stdout}\n{stderr}")

    def test_marketplace_fixture_command_uses_plain_node(self):
        from marketplace_sync_fixture import marketplace_sync_fixture_command

        command = marketplace_sync_fixture_command(Path("/tmp/marketplace-root"),
                                                   fixture_path=Path("/tmp/fixture.mjs"))
        self.assertEqual(command, ["node", "/tmp/fixture.mjs", "/tmp/marketplace-root"])

    def test_every_journey_module_imports_first_in_a_fresh_interpreter(self):
        env = os.environ.copy()
        env["PYTHONPATH"] = str(JOURNEY_DIR)
        for module in _journey_modules():
            with self.subTest(module=module):
                result = subprocess.run(
                    [sys.executable, "-B", "-c", f"import {module}"],
                    cwd=JOURNEY_DIR,
                    env=env,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(
                    result.returncode,
                    0,
                    f"first import of journey module {module!r} failed\n"
                    f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}",
                )

    def test_dockerfile_copies_match_the_declared_runner_resources(self):
        from journey_resources import RUNNER_IMAGE_RESOURCES, workspace_resource

        # The declared runtime image inputs are the inventory; other workspace
        # tools can be build-time-only and do not belong in this container.
        declared = {(resource.source, resource.destination) for resource in RUNNER_IMAGE_RESOURCES}
        copied = set(_docker_copy_resources())
        self.assertEqual(
            copied,
            declared,
            f"Dockerfile.runner COPY resources differ from journey_resources.py; "
            f"undeclared={sorted(copied - declared)}, not_copied={sorted(declared - copied)}",
        )

    def test_copied_runner_tree_resolves_resources_and_imports_its_modules(self):
        staged = subprocess.run(
            ["bash", str(JOURNEY_DIR / "stage-runner-inputs.sh")],
            cwd=REPOSITORY_ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(staged.returncode, 0, staged.stderr or staged.stdout)
        resources = _docker_copy_resources()
        with tempfile.TemporaryDirectory(prefix="journey-runner-image-") as temporary:
            image_root = Path(temporary)
            for source, destination in resources:
                source_path = REPOSITORY_ROOT / source
                target_path = image_root / destination.lstrip("/")
                if source_path.is_dir():
                    shutil.copytree(source_path, target_path, dirs_exist_ok=True)
                else:
                    target_path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source_path, target_path)

            journey_root = image_root / "opt/kb-journey/e2e/journey"
            command_bin = image_root / "command-bin"
            command_bin.mkdir()
            docker = command_bin / "docker"
            docker.write_text(
                "#!/bin/sh\n"
                "if [ \"$1 $2\" = 'compose version' ]; then exit 0; fi\n"
                "exit 0\n",
                encoding="utf-8",
            )
            docker.chmod(0o755)
            git = command_bin / "git"
            git.write_text("#!/bin/sh\nprintf 'runner-image-test\\n'\n", encoding="utf-8")
            git.chmod(0o755)
            run = subprocess.run(
                ["bash", str(journey_root / "run.sh"), "--render-compose-config"],
                cwd=image_root / "opt/kb-journey",
                env={**os.environ, "PATH": f"{command_bin}{os.pathsep}{os.environ['PATH']}"},
                text=True, capture_output=True, check=False,
            )
            self.assertEqual(
                run.returncode,
                0,
                f"copied runner could not resolve its shared Compose owner\n"
                f"stdout:\n{run.stdout}\nstderr:\n{run.stderr}",
            )

            env = os.environ.copy()
            env["PYTHONPATH"] = str(journey_root)
            probe = "\n".join((
                "import sys",
                "from pathlib import Path",
                "from pathlib import PurePosixPath",
                "from journey_resources import RUNNER_IMAGE_RESOURCES, workspace_resource",
                "image_root = Path(sys.argv[1])",
                "for resource in RUNNER_IMAGE_RESOURCES:",
                "    if resource.destination.startswith('/opt/kb-journey/'):",
                "        relative = resource.destination.removeprefix('/opt/kb-journey/')",
                "        path = workspace_resource(*PurePosixPath(relative).parts)",
                "    else:",
                "        path = image_root / resource.destination.lstrip('/')",
                "    if not path.exists():",
                "        raise SystemExit(f'missing runner image resource {resource.source} at {resource.destination}')",
            ))
            result = subprocess.run(
                [sys.executable, "-B", "-c", probe, str(image_root)], cwd=journey_root,
                env=env, text=True, capture_output=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

            parser = subprocess.run(
                [sys.executable, "-B", "-c",
                 "from journey_resources import config_parser_source_path; "
                 "print(config_parser_source_path())"],
                cwd=journey_root,
                env={**env, "KB_JOURNEY_RESOURCE_LAYOUT": "runner-image"},
                text=True, capture_output=True, check=False,
            )
            self.assertEqual(parser.returncode, 0, parser.stderr or parser.stdout)
            parser_import = subprocess.run(
                ["node", "--input-type=module", "-e",
                 "const { parseJsonc } = await import(process.argv[1]); "
                 "if (parseJsonc('{\\\"ok\\\":true}').ok !== true) process.exit(1)",
                 Path(parser.stdout.strip()).as_uri()],
                cwd=journey_root,
                env={**env, "KB_JOURNEY_RESOURCE_LAYOUT": "runner-image"},
                text=True, capture_output=True, check=False,
            )
            self.assertEqual(parser_import.returncode, 0, parser_import.stderr or parser_import.stdout)

            for module in _journey_modules(journey_root, resources):
                with self.subTest(module=module):
                    imported = subprocess.run(
                        [sys.executable, "-B", "-c", f"import {module}"], cwd=journey_root,
                        env=env, text=True, capture_output=True, check=False,
                    )
                    self.assertEqual(
                        imported.returncode,
                        0,
                        f"first import in the Docker COPY tree failed for {module!r}\n"
                        f"stdout:\n{imported.stdout}\nstderr:\n{imported.stderr}",
                    )


if __name__ == "__main__":
    unittest.main()
