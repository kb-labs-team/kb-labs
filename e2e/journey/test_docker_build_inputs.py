import fnmatch
import glob
import json
import re
import shlex
import unittest
from pathlib import Path


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

    def test_e2e_platform_serves_the_prepared_candidate_binary_from_origin(self):
        compose_path = ROOT / "e2e" / "docker-compose.yml"
        compose = compose_path.read_text()
        workflow = (ROOT / ".github" / "workflows" / "reusable-e2e-platform-build.yml").read_text()
        preparation = (ROOT / "e2e" / "platform" / "prepare-container-binaries.sh").read_text()
        staging = (ROOT / "e2e" / "platform" / "stage-release-binaries.mjs").read_text()

        self.assertIn("  origin:\n", compose)
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

    def test_e2e_platform_uses_installed_cli_and_restarts_for_oauth_override(self):
        entrypoint = (ROOT / "e2e" / "platform" / "entrypoint.sh").read_text()
        apply_index = entrypoint.index("kb-create apply \\")
        project_add_index = entrypoint.index('kb project add "$PLATFORM_ROOT"')
        override_index = entrypoint.index('cat > "$PLATFORM_ROOT/current/.kb/kb.config.override.json"')
        restart_index = entrypoint.index('kb-create restart --platform-root "$PLATFORM_ROOT"')

        self.assertLess(entrypoint.index('export GATEWAY_BOOTSTRAP_ADMIN_EMAIL GATEWAY_BOOTSTRAP_ADMIN_PASSWORD'),
                        apply_index)
        self.assertIn('"access.mode": "secured"', entrypoint)
        self.assertIn('--scenario custom --scenario-answers "$SCENARIO_ANSWERS"', entrypoint)
        self.assertIn('--secret-env gateway.bootstrap.password=GATEWAY_BOOTSTRAP_ADMIN_PASSWORD', entrypoint)
        self.assertLess(apply_index, project_add_index)
        self.assertLess(apply_index, override_index)
        self.assertLess(override_index, restart_index)
        self.assertIn('"clientSecretEnv": "OIDC_CORP_CLIENT_SECRET"', entrypoint)
        self.assertNotIn('node "$PLATFORM_ROOT/node_modules/@kb-labs/cli-bin/dist/bin.js"', entrypoint)
        self.assertNotIn('\nkb-create start --platform-root', entrypoint)


if __name__ == "__main__":
    unittest.main()
