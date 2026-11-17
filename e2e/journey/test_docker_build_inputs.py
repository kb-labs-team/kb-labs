import fnmatch
import glob
import json
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
    def test_next_build_output_is_excluded_but_deploy_inputs_remain_available(self):
        rules = dockerignore_rules(ROOT / ".dockerignore")
        self.assertTrue(is_dockerignored("sites/web/apps/docs/.next/cache/webpack/server-production/0.pack", rules))
        self.assertTrue(is_dockerignored("sites/web/apps/web/.next/cache/webpack/client-production/0.pack", rules))
        self.assertFalse(is_dockerignored(".kb/deploy/marketplace-registry-app/node_modules/pkg/index.js", rules))
        self.assertFalse(is_dockerignored(".journey/deploy/run.example/state-daemon/node_modules/pkg/index.js", rules))

    def test_isolated_registry_deploy_trees_are_included_but_other_journey_state_is_not(self):
        rules = dockerignore_rules(ROOT / ".dockerignore")
        self.assertFalse(is_dockerignored(".journey/deploy/run.example/state-daemon/node_modules/pkg/index.js", rules))
        self.assertFalse(is_dockerignored(".journey/deploy/run.example/marketplace-registry-app/dist/bootstrap.js", rules))
        self.assertTrue(is_dockerignored(".journey/tmp/node_modules/pkg/index.js", rules))
        self.assertTrue(is_dockerignored(".journey/reports/registry-secret.txt", rules))

    def test_registry_dockerfiles_use_the_selected_platform_deploy_root(self):
        cases = (
            (ROOT / "services/state/daemon/Dockerfile", "state-daemon"),
            (ROOT / "services/marketplace-registry/app/Dockerfile", "marketplace-registry-app"),
        )
        for dockerfile, deploy_tree in cases:
            with self.subTest(dockerfile=dockerfile):
                lines = dockerfile.read_text().splitlines()
                self.assertIn("ARG KB_DEPLOY_ROOT=.kb/deploy", lines)
                self.assertIn(
                    f"COPY --chown=kb:nodejs ${{KB_DEPLOY_ROOT}}/{deploy_tree}/node_modules ./node_modules",
                    lines,
                )
                self.assertIn(
                    f"COPY --chown=kb:nodejs ${{KB_DEPLOY_ROOT}}/{deploy_tree}/dist ./dist",
                    lines,
                )
                self.assertIn(
                    "COPY --chown=kb:nodejs ${KB_DEPLOY_ROOT}/image-default/kb.config.json /app/.kb/kb.config.json",
                    lines,
                )

    def test_registry_consumer_prepares_deploy_inputs_before_building_images(self):
        source = (ROOT / "e2e/journey/run.sh").read_text()
        prepare = source.index("bash e2e/journey/prepare-registry-deploy-artifacts.sh")
        build = source.index("journey_compose build marketplace-state marketplace-registry")
        self.assertLess(prepare, build)
        self.assertIn("KB_JOURNEY_DEPLOY_ROOT=\"$ROOT/.journey/deploy/run-$journey_run_suffix\"", source)
        composition = (ROOT / "services/marketplace-registry/app/scripts/render-journey-composition.mjs").read_text()
        deploy_root_arg = "KB_DEPLOY_ROOT: ${JSON.stringify(process.env.KB_JOURNEY_DEPLOY_ROOT ?? '.kb/deploy')}"
        self.assertEqual(2, composition.count(deploy_root_arg))

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


if __name__ == "__main__":
    unittest.main()
