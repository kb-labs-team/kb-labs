import fnmatch
import glob
import json
import os
import re
import shlex
import subprocess
import unittest
from pathlib import Path

from test_environment import require_compose_command


ROOT = Path(__file__).resolve().parents[2]


def dockerignore_rules(path):
    rules = []
    for line in path.read_text().splitlines():
        pattern = line.strip()
        if not pattern or pattern.startswith("#"):
            continue
        negated = pattern.startswith("!")
        if negated:
            pattern = pattern[1:]
        pattern = pattern.strip("/")
        if pattern and pattern != ".":
            rules.append((pattern, negated))
    return rules


def is_dockerignored(path, rules):
    """Apply Docker's last-matching-rule behavior to a context-relative path."""
    parts = Path(path).as_posix().strip("/").split("/")
    ignored = False
    for pattern, negated in rules:
        if "/" not in pattern:
            matched = any(fnmatch.fnmatchcase(part, pattern) for part in parts)
        else:
            prefixes = ["/".join(parts[:index]) for index in range(1, len(parts) + 1)]
            matched = any(fnmatch.fnmatchcase(prefix, pattern) for prefix in prefixes)
        if matched:
            ignored = not negated
    return ignored


def copy_instructions(dockerfile, *, final_stage_only=False):
    resources = []
    lines = dockerfile.read_text().splitlines()
    if final_stage_only:
        stage_starts = [index for index, line in enumerate(lines) if line.lstrip().startswith("FROM ")]
        if stage_starts:
            lines = lines[stage_starts[-1]:]
    for line in lines:
        if not line.lstrip().startswith("COPY "):
            continue
        instruction = line.strip()[len("COPY "):]
        if instruction.startswith("["):
            values = json.loads(instruction)
            sources, destination = values[:-1], values[-1]
            for source in sources:
                target = f"{destination.rstrip('/')}/{Path(source).name}" if len(sources) > 1 else destination
                resources.append((source, target))
            continue
        tokens = shlex.split(instruction)
        if any(token.startswith("--from=") for token in tokens):
            continue
        source_tokens = []
        for token in tokens[:-1]:
            if token.startswith("--"):
                continue
            source_tokens.append(token)
        destination = tokens[-1]
        for source in source_tokens:
            target = f"{destination.rstrip('/')}/{Path(source).name}" if len(source_tokens) > 1 else destination
            resources.append((source, target))
    return resources


def copy_sources(dockerfile):
    return (source for source, _destination in copy_instructions(dockerfile))


class DockerBuildInputsTest(unittest.TestCase):
    @staticmethod
    def _compose_service(compose, service):
        match = re.search(
            rf"(?ms)^  {re.escape(service)}:\n(.*?)(?=^  [A-Za-z0-9_-]+:\n|^volumes:\n|\Z)",
            compose,
        )
        if not match:
            return ""
        return match.group(1)

    def test_copy_sources_are_available_in_the_root_docker_context(self):
        rules = dockerignore_rules(ROOT / ".dockerignore")
        dockerfile = ROOT / "e2e/journey/Dockerfile.runner"
        excluded = []

        for source in copy_sources(dockerfile):
            matches = glob.glob(str(ROOT / source), recursive=True)
            candidates = [Path(match).relative_to(ROOT).as_posix() for match in matches]
            if not candidates:
                candidates = [source]
            for candidate in candidates:
                path = ROOT / candidate
                paths = [candidate]
                if path.is_dir():
                    paths.extend(item.relative_to(ROOT).as_posix() for item in path.rglob("*"))
                excluded.extend(item for item in paths if is_dockerignored(item, rules))

        self.assertEqual([], excluded,
                         f"Dockerfile COPY sources are excluded by .dockerignore: {sorted(set(excluded))}")

    def test_e2e_platform_overlay_serves_the_prepared_candidate_binary_from_origin(self):
        compose_path = ROOT / "e2e" / "docker-compose.platform.yml"
        compose = compose_path.read_text()
        workflow = (ROOT / ".github" / "workflows" / "reusable-e2e-platform-build.yml").read_text()
        preparation = (ROOT / "e2e" / "platform" / "prepare-container-binaries.sh").read_text()
        staging = (ROOT / "e2e" / "platform" / "stage-release-binaries.mjs").read_text()
        base_compose = (ROOT / "e2e" / "docker-compose.yml").read_text()

        self.assertIn("  origin:\n", compose)
        self.assertNotIn("  origin:\n", base_compose)
        origin = self._compose_service(compose, "origin")
        self.assertIn("python:3.12-alpine", origin)
        staged_path = re.search(r'^output="\$root/([^"\n]+)"$', preparation, re.MULTILINE).group(1)
        mount_source = re.search(r"^\s*- ([^:\n]+):/release/journey-candidate:ro$", origin, re.MULTILINE).group(1)
        self.assertEqual((ROOT / staged_path).resolve(), (compose_path.parent / mount_source).resolve())
        self.assertIn("http.server", origin)
        self.assertIn("/journey-candidate/kb-create-linux-amd64", origin)

        platform = self._compose_service(compose, "platform")
        self.assertRegex(platform, r"(?s)depends_on:.*?origin:\s*\n\s+condition: service_healthy")
        self.assertRegex(workflow, rf"(?m)^\s+{re.escape(staged_path)}\s+\\$")
        self.assertIn("--asset-base-url http://origin:8080/journey-candidate", preparation)
        self.assertIn("copyFileSync(artifact.path, join(outputDirectory, artifact.name))", staging)

    # case: S-262.23
    def test_platform_overlay_preserves_local_and_ci_registry_storage(self):
        compose = require_compose_command(self)
        base = "e2e/docker-compose.yml"
        ci = "e2e/docker-compose.ci.yml"
        platform = "e2e/docker-compose.platform.yml"

        def render(*files):
            env = os.environ.copy()
            env.pop("COMPOSE_FILE", None)
            command = [*compose]
            for file in files:
                command.extend(("-f", file))
            command.extend(("config", "--format", "json"))
            result = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)

        local = render(base, platform)
        local_origin = local["services"]["origin"]
        self.assertIn("/release/journey-candidate", {mount["target"] for mount in local_origin["volumes"]})
        verdaccio_mount = next(mount for mount in local["services"]["verdaccio"]["volumes"]
                               if mount["target"] == "/verdaccio/storage")
        self.assertEqual(verdaccio_mount["type"], "volume")
        self.assertEqual(verdaccio_mount["source"], "verdaccio-storage")

        ci_platform = render(base, ci, platform)
        verdaccio_mounts = ci_platform["services"]["verdaccio"]["volumes"]
        self.assertTrue(any(mount.get("type") == "bind" and mount["target"] == "/verdaccio/storage"
                            for mount in verdaccio_mounts))

        docker_workflow = (ROOT / ".github" / "workflows" / "reusable-e2e-docker.yml").read_text()
        playwright_workflow = (ROOT / ".github" / "workflows" / "reusable-e2e-playwright.yml").read_text()
        launcher_workflow = (ROOT / ".github" / "workflows" / "reusable-launcher-e2e.yml").read_text()
        self.assertIn("e2e/docker-compose.platform.yml", docker_workflow)
        self.assertIn("e2e/docker-compose.platform.yml", playwright_workflow)
        self.assertNotIn("e2e/docker-compose.platform.yml", launcher_workflow)

    # case: S-262.23
    def test_e2e_readiness_waits_for_registered_project_after_install(self):
        entrypoint = (ROOT / "e2e" / "platform" / "entrypoint.sh").read_text()
        apply = entrypoint.index("kb-create apply \\")
        fixtures = entrypoint.index("mkdir -p .kb/workflows")
        login = entrypoint.index("| kb auth login")
        register = entrypoint.index('kb project add "$PLATFORM_ROOT"')
        configure_provider = entrypoint.index('kb config set --scope platform gateway.auth.providers')
        restart = entrypoint.index('kb-create restart --platform-root')
        host_readiness = entrypoint.index('curl -sf http://localhost:4000/ready')
        ready = entrypoint.index('touch "$READY_FILE"')
        self.assertLess(apply, fixtures)
        self.assertLess(fixtures, login)
        self.assertLess(login, register)
        self.assertLess(register, configure_provider)
        provider_setup = entrypoint[register:restart]
        self.assertIn('clientSecretEnv: "OIDC_CORP_CLIENT_SECRET"', provider_setup)
        self.assertNotIn("$OIDC_CORP_CLIENT_SECRET", provider_setup)
        self.assertIn("--allow-plain-secret", provider_setup)
        self.assertIn("Fixture OAuth config command failed", provider_setup)
        self.assertLess(configure_provider, restart)
        self.assertLess(restart, host_readiness)
        self.assertLess(host_readiness, ready)
        self.assertNotIn("/auth/providers", entrypoint)
        self.assertIn('test -f /tmp/kb-e2e-ready', (ROOT / "e2e" / "docker-compose.platform.yml").read_text())
        for workflow in ("reusable-e2e-docker.yml", "reusable-e2e-playwright.yml"):
            content = (ROOT / ".github" / "workflows" / workflow).read_text()
            self.assertIn("docker compose exec -T platform test -f /tmp/kb-e2e-ready", content)
            self.assertIn("docker compose ps --all --status exited --quiet platform", content)


if __name__ == "__main__":
    unittest.main()
