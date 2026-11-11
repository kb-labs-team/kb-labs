import os
import pathlib
import json
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
BUILDER = ROOT / "e2e" / "publisher" / "build-image.sh"


class PublisherBuildTests(unittest.TestCase):
    def test_build_owner_uses_repository_root_for_all_copy_sources(self):
        with tempfile.TemporaryDirectory(prefix="kb-publisher-build-") as temp:
            bin_dir = pathlib.Path(temp) / "bin"
            bin_dir.mkdir()
            capture = pathlib.Path(temp) / "docker-args"
            docker = bin_dir / "docker"
            docker.write_text("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CAPTURE\"\n")
            docker.chmod(0o755)
            env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}", CAPTURE=str(capture))
            subprocess.run(["bash", str(BUILDER)], cwd=ROOT, env=env, check=True)
            args = capture.read_text().splitlines()

        context = pathlib.Path(args[-1])
        self.assertEqual(context, ROOT)
        dockerfile = (ROOT / "e2e/publisher/Dockerfile").read_text().splitlines()
        for line in dockerfile:
            fields = line.split()
            if fields and fields[0] == "COPY":
                for source in fields[1:-1]:
                    self.assertTrue((context / source).exists(), source)

    def test_workflows_invoke_the_publisher_owner(self):
        workflows = [
            ".github/workflows/ci-pr.yml",
            ".github/workflows/ci.yml",
            ".github/workflows/reusable-e2e-platform-build.yml",
            ".github/workflows/reusable-e2e-playwright.yml",
            ".github/workflows/reusable-e2e-docker.yml",
            ".github/workflows/reusable-launcher-e2e.yml",
        ]
        for workflow in workflows:
            result = subprocess.run(
                ["ruby", "-rjson", "-ryaml", "-e", "puts JSON.generate(YAML.load_file(ARGV.fetch(0)))", str(ROOT / workflow)],
                cwd=ROOT,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            workflow_data = json.loads(result.stdout)
            action_steps = []

            def visit(value):
                if isinstance(value, dict):
                    if value.get("uses") == "./.github/actions/build-publisher":
                        action_steps.append(value)
                    for nested in value.values():
                        visit(nested)
                elif isinstance(value, list):
                    for nested in value:
                        visit(nested)

            visit(workflow_data)
            self.assertTrue(action_steps, workflow)


if __name__ == "__main__":
    unittest.main()
