"""Resolve repository-layout resources shared by tests and the runner image."""
from __future__ import annotations

import hashlib
import json
import shlex
import shutil
import sys
from pathlib import Path, PurePosixPath
from typing import Callable, NamedTuple

from journey_values import journey_value


class RunnerImageResource(NamedTuple):
    """One repository input copied into the journey runner image."""

    source: str
    destination: str
    stage_source: str | None = None


class JourneyResourceLayout(NamedTuple):
    """A declared runtime root and config parser entry for one execution context."""

    root: str
    config_parser: str
    missing_step: str


CONFIG_JSONC_RESOURCE = RunnerImageResource(
    ".journey/runner-inputs/config-jsonc-edit.mjs",
    "/opt/kb-journey/core/config/dist/jsonc-edit.mjs",
)
MARKETPLACE_SYNC_BUNDLE = ".journey/runner-inputs/marketplace-sync-server.mjs"
MARKETPLACE_SYNC_LOGO = ".journey/runner-inputs/static/logo.svg"

TOOLCHAIN_STAGE_NAME = "toolchain"
TOOLCHAIN_IMAGE_REPOSITORY = "kb-journey-runner-toolchain"
TOOLCHAIN_IMAGE_LABEL = "org.kb-labs.journey.runner-toolchain"
TOOLCHAIN_IMAGE_BUILD_ARGUMENT = "KB_JOURNEY_TOOLCHAIN_IMAGE"
TOOLCHAIN_DOCKERFILE = "e2e/journey/Dockerfile.runner"
STUDIO_PACKAGE_MANIFEST = "e2e/studio/package.json"

# The slow, rarely-changing runner toolchain layers. They are copied inside the
# `FROM ... AS toolchain` stage of Dockerfile.runner, which e2e/journey/run.sh
# builds and tags from these inputs so per-run cache trimming cannot evict them.
TOOLCHAIN_STAGE_INPUTS = (
    RunnerImageResource("package.json", "/tmp/workspace-package.json"),
    RunnerImageResource(STUDIO_PACKAGE_MANIFEST, "/tmp/studio-package.json"),
)


RUNNER_IMAGE_RESOURCES = (
    RunnerImageResource("tools/kb-create/install.sh", "/usr/local/share/kb-create/install.sh"),
    RunnerImageResource("e2e/journey", "/opt/kb-journey/e2e/journey"),
    RunnerImageResource("e2e/compose-owner.sh", "/opt/kb-journey/e2e/compose-owner.sh"),
    CONFIG_JSONC_RESOURCE,
    RunnerImageResource(
        ".journey/runner-inputs/project-service-path.js",
        "/opt/kb-journey/core/plugin-contracts/dist/project-service-path.js",
        "core/plugin-contracts/dist/project-service-path.js",
    ),
    RunnerImageResource("docs/qa/scenarios", "/opt/kb-journey/docs/qa/scenarios"),
    RunnerImageResource("e2e/platform/fixtures/installer-cases",
                        "/opt/kb-journey/e2e/platform/fixtures/installer-cases"),
    RunnerImageResource(MARKETPLACE_SYNC_BUNDLE,
                        "/opt/kb-journey/e2e/platform/fixtures/marketplace-sync-server.mjs"),
    RunnerImageResource(MARKETPLACE_SYNC_LOGO,
                        "/opt/kb-journey/e2e/platform/fixtures/static/logo.svg"),
    RunnerImageResource("e2e/platform/journey-update-packages.mjs",
                        "/opt/kb-journey/e2e/platform/journey-update-packages.mjs"),
    RunnerImageResource("tools/kb-create/package.json",
                        "/opt/kb-journey/node_modules/kb-create/package.json"),
    RunnerImageResource("tools/kb-create/scripts/package-provenance.mjs",
                        "/opt/kb-journey/node_modules/kb-create/scripts/package-provenance.mjs"),
    RunnerImageResource("tools/kb-create/scripts/platform-release-config.mjs",
                        "/opt/kb-journey/node_modules/kb-create/scripts/platform-release-config.mjs"),
    RunnerImageResource("e2e/platform/registry-manifest.json",
                        "/opt/kb-journey/e2e/platform/registry-manifest.json"),
    RunnerImageResource("e2e/publisher/publish.sh",
                        "/opt/kb-journey/e2e/publisher/publish.sh"),
    RunnerImageResource("core/platform/contracts/ux-result",
                        "/opt/kb-journey/core/platform/contracts/ux-result"),
    RunnerImageResource("core/platform/src/error-envelope/error-envelope.schema.json",
                        "/opt/kb-journey/core/platform/src/error-envelope/error-envelope.schema.json"),
    RunnerImageResource("core/platform/src/error-envelope/errors.catalog.json",
                        "/opt/kb-journey/core/platform/src/error-envelope/errors.catalog.json"),
    RunnerImageResource("tools/kb-create/v2/contracts/platform-layout.json",
                        "/opt/kb-journey/tools/kb-create/v2/contracts/platform-layout.json"),
    RunnerImageResource("core/platform/contracts/ux-result", "/opt/kb-contracts/ux-result"),
    RunnerImageResource("core/platform/src/error-envelope/error-envelope.schema.json",
                        "/opt/kb-contracts/error-envelope.schema.json"),
    RunnerImageResource("e2e/journey/entrypoint.py", "/usr/local/bin/kb-journey-runner"),
    RunnerImageResource("e2e/journey/studio-playwright.config.mjs",
                        "/opt/kb-studio-playwright/playwright.config.mjs"),
    RunnerImageResource(".journey/runner-inputs/studio-specs", "/opt/kb-studio-playwright/specs"),
    RunnerImageResource("tools/clikit/diag/gen/main.go", "/opt/kb-journey/tools/clikit/diag/gen/main.go"),
    RunnerImageResource("tools/kb-create/main.go", "/opt/kb-journey/tools/kb-create/main.go"),
    RunnerImageResource("tools/kb-create/v2/testsupport/wizard-pty/main.go",
                        "/opt/kb-journey/tools/kb-create/v2/testsupport/wizard-pty/main.go"),
    RunnerImageResource("tools/kb-create/v2/testsupport/identity-supervisor/main.go",
                        "/opt/kb-journey/tools/kb-create/v2/testsupport/identity-supervisor/main.go"),
    RunnerImageResource("tools/kb-create/v2/internal/fakehost/main.go",
                        "/opt/kb-journey/tools/kb-create/v2/internal/fakehost/main.go"),
    RunnerImageResource("tools/kb-create/v2/cmd/gen-gateway-bootstrap/main.go",
                        "/opt/kb-journey/tools/kb-create/v2/cmd/gen-gateway-bootstrap/main.go"),
    RunnerImageResource("tools/kb-create/v2/cmd/kb-create-release-index/main.go",
                        "/opt/kb-journey/tools/kb-create/v2/cmd/kb-create-release-index/main.go"),
    RunnerImageResource("tools/kb-create/v2/cmd/kb-create-v2/main.go",
                        "/opt/kb-journey/tools/kb-create/v2/cmd/kb-create-v2/main.go"),
    RunnerImageResource("tools/kb-deploy/main.go", "/opt/kb-journey/tools/kb-deploy/main.go"),
    RunnerImageResource("tools/kb-devkit/main.go", "/opt/kb-journey/tools/kb-devkit/main.go"),
    RunnerImageResource("tools/kb-env/main.go", "/opt/kb-journey/tools/kb-env/main.go"),
    RunnerImageResource("tools/kb-dev/main.go", "/opt/kb-journey/tools/kb-dev/main.go"),
    RunnerImageResource("tools/kb-monitor/main.go", "/opt/kb-journey/tools/kb-monitor/main.go"),
)

JOURNEY_RESOURCE_LAYOUTS = {
    "workspace": JourneyResourceLayout(
        "built workspace checkout", "core/config/dist/index.js",
        "corepack pnpm --filter @kb-labs/core-config build",
    ),
    "runner-image": JourneyResourceLayout(
        "runner image root /opt/kb-journey",
        PurePosixPath(CONFIG_JSONC_RESOURCE.destination).relative_to("/opt/kb-journey").as_posix(),
        "bash e2e/journey/stage-runner-inputs.sh before building the journey image",
    ),
}


def resource_root() -> Path:
    """Return the repository root mirrored by the runner image."""
    return Path(__file__).resolve().parents[2]


def workspace_resource(*parts: str) -> Path:
    """Return a resource using its path relative to the repository root."""
    return resource_root().joinpath(*parts)


def config_parser_source_path() -> Path:
    """Resolve the parser from the explicitly selected workspace or image layout."""
    layout_name = journey_value("KB_JOURNEY_RESOURCE_LAYOUT", "workspace")
    try:
        layout = JOURNEY_RESOURCE_LAYOUTS[layout_name]
    except KeyError as error:
        raise ValueError(
            f"unknown journey resource layout {layout_name!r}; choose one of "
            f"{', '.join(sorted(JOURNEY_RESOURCE_LAYOUTS))}"
        ) from error

    parser_path = workspace_resource(*PurePosixPath(layout.config_parser).parts)
    if not parser_path.is_file():
        raise FileNotFoundError(
            f"journey resource layout {layout_name!r} ({layout.root}) requires "
            f"{layout.config_parser} at {parser_path}; {layout.missing_step}"
        )
    return parser_path


def stage_runner_image_inputs() -> tuple[Path, ...]:
    """Stage declared runner inputs whose repository source is generated or ignored."""
    staged_paths = list(stage_studio_playwright_specs(
        workspace_resource(".journey", "runner-inputs", "studio-specs")))
    staged_paths.append(stage_config_jsonc_parser())
    staged_paths.append(stage_marketplace_sync_fixture())
    staged_paths.append(workspace_resource(*PurePosixPath(MARKETPLACE_SYNC_LOGO).parts))
    for resource in RUNNER_IMAGE_RESOURCES:
        if resource.stage_source is None:
            continue
        built_input = workspace_resource(*PurePosixPath(resource.stage_source).parts)
        if not built_input.is_file():
            raise FileNotFoundError(
                f"The journey runner needs {built_input.relative_to(resource_root())}. "
                "Run `corepack pnpm --filter @kb-labs/plugin-contracts... --workspace-concurrency=2 build` first."
            )
        staged_input = workspace_resource(*PurePosixPath(resource.source).parts)
        staged_input.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(built_input, staged_input)
        staged_paths.append(staged_input)
    if not staged_paths:
        raise RuntimeError("the journey runner resource set declares no staged runner inputs")
    return tuple(staged_paths)


def stage_config_jsonc_parser() -> Path:
    """Bundle the canonical core-config JSONC parser for the isolated runner image."""
    from invocations import run_harness_command

    source = workspace_resource("core", "config", "src", "user-config", "jsonc-edit.ts")
    destination = workspace_resource(*PurePosixPath(CONFIG_JSONC_RESOURCE.source).parts)
    result = run_harness_command([
        str(_esbuild_binary()), str(source), "--bundle", "--platform=node", "--format=esm",
        f"--outfile={destination}",
    ])
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise RuntimeError(f"Core config JSONC parser staging failed: {detail}")
    return destination


def stage_marketplace_sync_fixture() -> Path:
    """Bundle the fixture and its workspace package closure for the runner image."""
    from invocations import run_harness_command

    source = workspace_resource("e2e", "platform", "fixtures", "marketplace-sync-server.mjs")
    destination = workspace_resource(*PurePosixPath(MARKETPLACE_SYNC_BUNDLE).parts)
    destination.parent.mkdir(parents=True, exist_ok=True)
    logo_source = _marketplace_sync_logo_source(run_harness_command)
    logo_destination = workspace_resource(*PurePosixPath(MARKETPLACE_SYNC_LOGO).parts)
    logo_destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(logo_source, logo_destination)
    result = run_harness_command([
        str(_esbuild_binary()), str(source), "--bundle", "--platform=node", "--format=esm",
        "--define:__dirname=import.meta.dirname",
        '--banner:js=import { createRequire as __createRequire } from "node:module"; '
        "const require = __createRequire(import.meta.url);",
        f"--outfile={destination}",
    ])
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise RuntimeError(f"Marketplace sync fixture staging failed: {detail}")
    return destination


def _marketplace_sync_logo_source(
    run_harness_command: Callable[[list[str]], subprocess.CompletedProcess[str]],
) -> Path:
    """Resolve the logo file used by the bundled Fastify Swagger UI plugin."""
    package_manifest = workspace_resource("services", "marketplace", "api", "package.json")
    script = (
        'const path = require("node:path"); '
        'const { createRequire } = require("node:module"); '
        'const appRequire = createRequire(path.resolve(process.argv[1])); '
        'const fastifyRequire = createRequire(appRequire.resolve("fastify")); '
        'process.stdout.write(path.join('
        'path.dirname(fastifyRequire.resolve("@fastify/swagger-ui")), '
        '"static", "logo.svg"));'
    )
    result = run_harness_command(["node", "-e", script, str(package_manifest)])
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise RuntimeError(f"Marketplace sync fixture asset resolution failed: {detail}")
    logo = Path(result.stdout.strip())
    if not logo.is_file():
        raise FileNotFoundError(
            f"Marketplace sync fixture requires the Fastify Swagger UI logo at {logo}."
        )
    return logo


def _esbuild_binary() -> Path:
    candidates = sorted((resource_root() / "node_modules/.pnpm").glob(
        "esbuild@*/node_modules/esbuild/bin/esbuild"))
    if not candidates:
        raise FileNotFoundError(
            "Journey runner inputs cannot be bundled because workspace esbuild is missing. "
            "Build the workspace tooling before preparing the journey runner image."
        )
    return candidates[-1]


def stage_studio_playwright_specs(output_dir: Path | None = None) -> tuple[Path, ...]:
    """Bundle the specs selected by Playwright's own config with workspace imports."""
    root = resource_root()
    config_path = workspace_resource("e2e", "studio", "playwright.config.ts")
    playwright = workspace_resource("e2e", "studio", "node_modules", ".bin", "playwright")
    if not playwright.is_file():
        raise FileNotFoundError(
            f"Studio Playwright CLI is missing at {playwright}. "
            "Restore workspace dependencies with `corepack pnpm install --frozen-lockfile`."
        )
    from invocations import run_harness_command

    listed = run_harness_command([
        str(playwright), "test", "--list", f"--config={config_path}", "--reporter=json",
    ])
    if listed.returncode:
        detail = listed.stderr.strip() or listed.stdout.strip() or f"exit {listed.returncode}"
        raise RuntimeError(f"Studio Playwright spec discovery failed: {detail}")
    inventory = json.loads(listed.stdout)
    config = inventory.get("config")
    if not isinstance(config, dict) or not isinstance(config.get("rootDir"), str):
        raise ValueError("Playwright spec discovery output omitted config.rootDir")
    source_dir = Path(config["rootDir"])
    entries: set[Path] = set()

    def visit_suites(suites: object) -> None:
        if not isinstance(suites, list):
            return
        for suite in suites:
            if not isinstance(suite, dict):
                raise ValueError("Playwright spec discovery returned an invalid suite")
            file = suite.get("file")
            if isinstance(file, str) and file:
                path = Path(file)
                entries.add(path if path.is_absolute() else source_dir / path)
            visit_suites(suite.get("suites"))

    visit_suites(inventory.get("suites"))
    if not entries:
        raise FileNotFoundError(f"Playwright config {config_path} selected no Studio spec files")
    for entry in entries:
        if not entry.is_file():
            raise FileNotFoundError(f"Playwright selected missing Studio spec {entry}")

    destination = output_dir or workspace_resource(".journey", "runner-inputs", "studio-specs")
    shutil.rmtree(destination, ignore_errors=True)
    destination.mkdir(parents=True, exist_ok=True)
    command = [
        str(_esbuild_binary()),
        *(str(entry) for entry in sorted(entries)),
        "--bundle",
        "--platform=node",
        "--format=cjs",
        "--external:@playwright/test",
        f"--outdir={destination}",
        f"--outbase={source_dir}",
    ]
    result = run_harness_command(command)
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise RuntimeError(f"Studio Playwright spec dependency bundle failed: {detail}")
    return tuple(sorted(destination.rglob("*.spec.js")))


def runner_toolchain_stage_text(dockerfile: Path | None = None) -> str:
    """Extract the toolchain build stage: the single declaration of toolchain inputs."""
    path = dockerfile or workspace_resource(*PurePosixPath(TOOLCHAIN_DOCKERFILE).parts)
    lines = path.read_text(encoding="utf-8").splitlines()
    starts = [index for index, line in enumerate(lines)
              if line.startswith("FROM ") and line.split()[-1] == TOOLCHAIN_STAGE_NAME]
    if len(starts) != 1:
        raise ValueError(
            f"{path} must declare exactly one 'FROM ... AS {TOOLCHAIN_STAGE_NAME}' stage owning "
            f"the runner toolchain inputs; found {len(starts)}"
        )
    end = next((index for index in range(starts[0] + 1, len(lines))
                if lines[index].startswith("FROM ")), len(lines))
    return "\n".join(lines[starts[0]:end]).strip()


def runner_toolchain_image(*, dockerfile: Path | None = None,
                           package_manifest_input: Path | None = None,
                           studio_manifest_input: Path | None = None,
                           node_policy_input: Path | None = None) -> str:
    """Derive the tagged toolchain image reference from its exact build inputs.

    The tag hashes the toolchain stage of Dockerfile.runner, the source
    Playwright declaration, the root packageManager declaration used by
    Corepack, and the generated Node base image policy. A changed input yields
    a new tag that the harness builds, while per-run runner-stage changes
    reuse the existing image.
    """
    stage = runner_toolchain_stage_text(dockerfile)
    studio_manifest = studio_manifest_input or workspace_resource(*STUDIO_PACKAGE_MANIFEST.split("/"))
    try:
        studio_dependencies = json.loads(studio_manifest.read_text(encoding="utf-8")).get("devDependencies", {})
    except FileNotFoundError as error:
        raise FileNotFoundError(f"The journey runner toolchain needs Studio's source package.json at {studio_manifest}.") from error
    playwright_version = studio_dependencies.get("@playwright/test") if isinstance(studio_dependencies, dict) else None
    if not isinstance(playwright_version, str) or not playwright_version:
        raise ValueError(f"The journey runner toolchain requires devDependencies.@playwright/test in {studio_manifest}.")
    package_manifest = package_manifest_input or workspace_resource("package.json")
    try:
        package_manager = json.loads(package_manifest.read_text(encoding="utf-8")).get("packageManager")
    except FileNotFoundError as error:
        raise FileNotFoundError(f"The journey runner toolchain needs its workspace package.json at {package_manifest}.") from error
    if not isinstance(package_manager, str) or not package_manager.startswith("pnpm@"):
        raise ValueError(f"The journey runner toolchain requires a pnpm packageManager declaration in {package_manifest}.")
    node_policy = node_policy_input or workspace_resource(
        "tools", "clikit", "toolchain", "node_policy_gen.json")
    try:
        generated_node_policy = json.loads(node_policy.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise FileNotFoundError(f"The journey runner toolchain needs generated Node policy at {node_policy}.") from error
    node_base_image = generated_node_policy.get("nodeBaseImage")
    node_base_image_argument = generated_node_policy.get("nodeBaseImageArgument")
    if not isinstance(node_base_image, str) or not node_base_image:
        raise ValueError(f"The generated Node policy at {node_policy} requires nodeBaseImage.")
    if not isinstance(node_base_image_argument, str) or not node_base_image_argument:
        raise ValueError(f"The generated Node policy at {node_policy} requires nodeBaseImageArgument.")
    digest = hashlib.sha256(
        f"{stage}\n{playwright_version}\n{package_manager}\n"
        f"{node_base_image}\n{node_base_image_argument}".encode("utf-8")
    ).hexdigest()[:16]
    return f"{TOOLCHAIN_IMAGE_REPOSITORY}:{digest}"


def runner_toolchain_contract(*, dockerfile: Path | None = None,
                              package_manifest_input: Path | None = None,
                              studio_manifest_input: Path | None = None,
                              node_policy_input: Path | None = None) -> dict[str, str]:
    """Return the Dockerfile input and derived image used by the runner stage."""
    return {
        "dockerfile": TOOLCHAIN_DOCKERFILE,
        "toolchainStage": TOOLCHAIN_STAGE_NAME,
        "imageLabel": TOOLCHAIN_IMAGE_LABEL,
        "imageArgument": TOOLCHAIN_IMAGE_BUILD_ARGUMENT,
        "imageReference": runner_toolchain_image(dockerfile=dockerfile,
                                                  package_manifest_input=package_manifest_input,
                                                  studio_manifest_input=studio_manifest_input,
                                                  node_policy_input=node_policy_input),
    }


def main() -> int:
    argv = sys.argv[1:]
    try:
        if argv == ["--toolchain-contract"]:
            print(json.dumps(runner_toolchain_contract()))
            return 0
        if argv:
            print(f"unknown journey_resources option: {' '.join(argv)}", file=sys.stderr)
            return 2
        stage_runner_image_inputs()
    except (FileNotFoundError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(error, file=sys.stderr)
        return 2
    return 0


def workspace_tool_entrypoints() -> tuple[Path, ...]:
    """Resolve declared Go tool entrypoints from the workspace resource set."""
    return tuple(
        workspace_resource(*resource.source.split("/"))
        for resource in RUNNER_IMAGE_RESOURCES
        if resource.source.startswith("tools/") and resource.source.endswith("/main.go")
    )


def journey_module(name: str) -> Path:
    """Return a journey script by name; the image keeps the repository layout."""
    return workspace_resource("e2e", "journey", name)


def parse_shell_commands(value: str) -> list[list[str]]:
    """Parse the POSIX words and ``&&`` separators emitted by ShellQuote."""
    lexer = shlex.shlex(value, posix=True, punctuation_chars="&")
    lexer.whitespace_split = True
    commands: list[list[str]] = []
    current: list[str] = []
    for token in lexer:
        if token == "&&":
            if not current:
                raise ValueError("shell command sequence contains an empty command")
            commands.append(current)
            current = []
        elif token.startswith("&"):
            raise ValueError("shell command sequence contains an unsupported operator")
        else:
            current.append(token)
    if not current:
        raise ValueError("shell command sequence contains an empty command")
    commands.append(current)
    return commands


if __name__ == "__main__":
    raise SystemExit(main())


def installer_case_fixture_root() -> Path:
    return workspace_resource("e2e", "platform", "fixtures", "installer-cases")


def case_catalog_root() -> Path:
    return workspace_resource("docs", "qa", "scenarios")


def installed_platform_resource(*parts: str) -> Path:
    """Return a contract shipped separately with the installed platform."""
    return Path("/opt/kb-contracts").joinpath(*parts)


def _platform_layout() -> dict:
    value = json.loads(workspace_resource("tools", "kb-create", "v2", "contracts", "platform-layout.json").read_text())
    if not isinstance(value, dict):
        raise ValueError("platform layout contract is not an object")
    return value


def shared_runtime_file_fingerprints(install_root: Path) -> tuple[str | None, ...]:
    """Return opaque fingerprints for every file projection in the layout contract."""
    projections = _platform_layout().get("sharedRuntimePaths")
    if not isinstance(projections, list):
        raise ValueError("platform layout contract omits shared runtime projections")
    fingerprints = []
    for projection in projections:
        if not isinstance(projection, dict):
            raise ValueError("platform layout contains an invalid shared runtime projection")
        if projection.get("kind") != "file":
            continue
        state_path = projection.get("statePath")
        if not isinstance(state_path, str) or not state_path:
            raise ValueError("platform layout file projection omits its state path")
        try:
            contents = (Path(install_root) / state_path).read_bytes()
        except FileNotFoundError:
            fingerprints.append(None)
        else:
            fingerprints.append(hashlib.sha256(contents).hexdigest())
    return tuple(fingerprints)


def current_link_path(install_root: Path) -> Path:
    """Resolve the current link by its platform-layout identity."""
    from installed_fixture import installed_path
    return installed_path(install_root, "currentLink")


def version_roots_path(install_root: Path) -> Path:
    """Resolve the versions directory by its platform-layout identity."""
    from installed_fixture import installed_path
    return installed_path(install_root, "versionRoots.path")


def active_platform_root(install_root: Path) -> Path:
    """Resolve the active version through the installed-fixture path owner."""
    from installed_fixture import active_platform_root as resolve_active
    return resolve_active(install_root)


def installer_record_path(install_root: Path, record: str) -> Path:
    """Resolve an installer-owned record through the installed-root owner."""
    from installed_fixture import installed_path
    return installed_path(install_root, f"installerRecords.{record}")


def snapshot_tree(root: Path) -> dict[str, tuple[str, bytes | str | None]]:
    """Capture file content and links below root."""
    snapshot = {}
    for path in root.rglob("*"):
        relative = str(path.relative_to(root))
        if path.is_symlink():
            snapshot[relative] = ("symlink", str(path.readlink()))
        elif path.is_dir():
            snapshot[relative] = ("directory", None)
        elif path.is_file():
            snapshot[relative] = ("file", path.read_bytes())
    return snapshot


def snapshot_state_tree(root: Path) -> dict[str, tuple[str, int, int, bytes | str | None]]:
    """Capture shared state bytes and filesystem metadata below root."""
    snapshot = {}
    root_info = root.lstat()
    snapshot["."] = ("directory", root_info.st_mode, root_info.st_mtime_ns, None)
    for path in root.rglob("*"):
        relative = str(path.relative_to(root))
        info = path.lstat()
        if path.is_symlink():
            snapshot[relative] = ("symlink", info.st_mode, info.st_mtime_ns, str(path.readlink()))
        elif path.is_dir():
            snapshot[relative] = ("directory", info.st_mode, info.st_mtime_ns, None)
        elif path.is_file():
            snapshot[relative] = ("file", info.st_mode, info.st_mtime_ns, path.read_bytes())
    return snapshot


def read_installed_platform_resource(*parts: str) -> bytes:
    """Read an installed-platform contract and fail if that installed copy is missing."""
    return installed_platform_resource(*parts).read_bytes()


def installer_scenario_resources(host_os: str, host_arch: str) -> list[Path]:
    """List all repository and installed contract resources used by installer cases."""
    catalog = case_catalog_root()
    fixture_root = installer_case_fixture_root()
    return [
        catalog,
        *sorted(catalog.glob("*.md")),
        workspace_resource("core", "platform", "contracts", "ux-result", "machine-result.schema.json"),
        workspace_resource("core", "platform", "src", "error-envelope", "error-envelope.schema.json"),
        workspace_resource("tools", "kb-create", "v2", "contracts", "platform-layout.json"),
        fixture_root / f"compatibility-matrix-{host_os}-{host_arch}.json",
        fixture_root / f"missing-host-binary-{host_os}-{host_arch}.json",
        installed_platform_resource("ux-result", "machine-result.schema.json"),
        installed_platform_resource("error-envelope.schema.json"),
    ]
