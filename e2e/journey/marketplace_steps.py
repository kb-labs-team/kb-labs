"""Installed marketplace and adapter journeys for the shared service runner."""
from __future__ import annotations

from kb_invocation import kb_command

from project_service_path import project_service_path

import base64
import json
import os
import re
import shutil
import tempfile
import tarfile
import time
from urllib.parse import urlencode, urlsplit, urlunsplit
import urllib.request
from pathlib import Path
from pathlib import PurePosixPath
from typing import Callable

from journey_resources import active_platform_root, workspace_resource
from installed_fixture import layout_value
from platform_snapshot import _platform_snapshot
from journey_selection import read_journey_selection
from hermetic_cli import run_hermetic_cli
from service_steps import Journey
from gateway_sessions import gateway_session
from invocations import (
    CompletedProcess,
    catalogued_error_hint,
    catalogued_error_message,
    decode_ux_error_result,
    decode_ux_success_result,
    export_project_identity_to_child_environment,
    invocation_context,
    open_http,
    read_ux_cli_result,
    read_ux_http_result,
    run_command,
    run_with_runner,
    store_report_secret,
)
from plugin_author_steps import preflight_installed_plugin_command, run_commit_case_steps
from commit_fixture import commit_fixture_source_version


CommandRunner = Callable[..., CompletedProcess[str]]


def _installed_gateway_url(env: dict[str, str]) -> str:
    """Read the active install's verified Gateway URL, as the CLI auth gate does."""
    platform_root = env.get("KB_JOURNEY_PLATFORM_ROOT")
    if not platform_root:
        raise RuntimeError("secured marketplace journey cannot resolve its installed Gateway receipt")
    receipt_path = active_platform_root(Path(platform_root)) / ".kb" / "v2" / "receipt.json"
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("secured marketplace journey cannot read the active Gateway receipt") from error
    health_url = receipt.get("verification", {}).get("hostHealthUrl")
    if not isinstance(health_url, str) or not health_url:
        raise RuntimeError("secured marketplace journey receipt has no verified Gateway URL")
    parsed = urlsplit(health_url)
    path = parsed.path.removesuffix("/health").rstrip("/")
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", "")).rstrip("/")


def marketplace_platform_config_path(platform_root: Path) -> Path:
    """Resolve the installed config through the active version's shared-state link."""
    return active_platform_root(platform_root) / layout_value(
        "sharedRuntimePaths.kb_kb_config_jsonc.platformPath")


def _assert_registry_gateway_config(env: dict[str, str]) -> None:
    platform_root = env.get("KB_JOURNEY_PLATFORM_ROOT")
    registry_upstream = env.get("KB_JOURNEY_MARKETPLACE_REGISTRY_URL")
    if not platform_root or not registry_upstream:
        raise RuntimeError("Registry journey has no installed Gateway route fixture")
    config_path = active_platform_root(Path(platform_root)) / ".kb" / "kb.config.jsonc"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    route = config.get("gateway", {}).get("upstreams", {}).get("marketplaceRegistry")
    transport = (config.get("platform", {}).get("adapterOptions", {})
                 .get("serviceTransport", {}).get("services", {}).get("marketplace-registry"))
    sources = config.get("marketplace", {}).get("sources", [])
    if (route != {"serviceId": "marketplace-registry",
                  "prefix": "/api/v1/marketplace-registry", "rewritePrefix": ""}
            or not isinstance(transport, dict) or transport.get("url") != registry_upstream
            or not isinstance(sources, list) or not sources
            or not isinstance(sources[0], dict)
            or sources[0].get("url") != f"{_installed_gateway_url(env)}/api/v1/marketplace-registry"):
        raise RuntimeError("Registry source, Gateway route, and isolated upstream do not form one route")


def commit_publish_command(package_root: str | Path) -> list[str]:
    return ["hub", "publish", "--path", str(Path(package_root)), "--json"]


def _publish_fixture_command(workspace_root: str | Path, package_path: str) -> list[str]:
    return ["hub", "publish", "--path", str(Path(workspace_root) / package_path), "--json"]


def _publish_workspace_fixture(workspace_root: Path, package_path: str, env: dict[str, str],
                               runner: CommandRunner) -> CompletedProcess[str]:
    registry_url = env.get("KB_JOURNEY_MARKETPLACE_PUBLISH_URL")
    author_handle = env.get("KB_JOURNEY_MARKETPLACE_AUTHOR_HANDLE")
    if not registry_url or not author_handle:
        raise RuntimeError("journey Registry publish configuration is missing; enable the marketplace-registry lane")
    workspace_cli = workspace_root / "cli" / "bin" / "dist" / "bin.js"
    publish = _publish_fixture_command(workspace_root, package_path)
    command = ["node", str(workspace_cli), *publish]
    publish_env = dict(env)
    publish_env["KB_REGISTRY_URL"] = env.get("KB_REGISTRY_URL", registry_url)
    publish_env["KB_REGISTRY_AUTHOR_HANDLE"] = author_handle
    gateway_login = None
    if read_journey_selection(env).runner_selector.endswith(":secured"):
        email = env.get("KB_JOURNEY_ADMIN_EMAIL", "")
        password = env.get("KB_JOURNEY_ADMIN_PASSWORD", "")
        if not email or not password:
            raise RuntimeError("secured Registry fixture publishing needs the journey administrator credentials")
        gateway_login = (_installed_gateway_url(env), email, password)
    journey_platform_root = env.get("KB_JOURNEY_PLATFORM_ROOT")
    if not journey_platform_root:
        raise RuntimeError("Registry fixture publishing needs the active installed platform root")
    return run_hermetic_cli(
        command, cwd=workspace_root, env=publish_env, runner=runner,
        workspace_root=workspace_root,
        installed_platform_root=active_platform_root(Path(journey_platform_root)),
        gateway_login=gateway_login,
    )


def _run(command: list[str], *, cwd: Path, env: dict[str, str], runner: CommandRunner,
         input: str | None = None) -> CompletedProcess[str]:
    return run_with_runner(runner, command, cwd=cwd, env=env, timeout=300, input=input)


def _publish_npm_fixture_package(package_dir: Path, registry: str, cwd: Path,
                                 env: dict[str, str], runner: CommandRunner, *,
                                 http_opener: Callable[..., object] = urllib.request.urlopen) -> None:
    """Register a throwaway Verdaccio user and publish with registry-scoped auth."""
    parsed_registry = urlsplit(registry)
    if parsed_registry.scheme not in {"http", "https"} or not parsed_registry.netloc:
        raise RuntimeError("S-010.8 requires an HTTP npm fixture registry")

    username = "kb-journey"
    password = "kb-journey"
    user_url = f"{registry.rstrip('/')}/-/user/org.couchdb.user:{username}"
    body = json.dumps({"name": username, "password": password, "email": "kb-journey@local"}).encode()
    request = urllib.request.Request(
        user_url, data=body, headers={"Content-Type": "application/json"}, method="PUT")
    try:
        with http_opener(request, timeout=10) as response:
            status = getattr(response, "status", None)
            if status is None:
                status = response.getcode()
    except urllib.error.HTTPError as error:
        status = error.code
    if status not in (200, 201, 409):
        raise RuntimeError(f"S-010.8 Verdaccio user registration failed (status {status})")

    auth = base64.b64encode(f"{username}:{password}".encode()).decode("ascii")
    userconfig = cwd / ".kb-journey-npmrc"
    userconfig.write_text(
        f"//{parsed_registry.netloc}/:_auth={auth}\n"
        f"//{parsed_registry.netloc}/:always-auth=true\n"
        f"registry={registry.rstrip('/')}/\n",
        encoding="utf-8",
    )
    userconfig.chmod(0o600)
    publish_env = dict(env)
    publish_env["npm_config_userconfig"] = str(userconfig)
    command = ["npm", "publish", str(package_dir), "--json", f"--registry={registry}"]
    _output(_run(command, cwd=cwd, env=publish_env, runner=runner), command)


def _transitive_npm_fixture_ids(suffix: str) -> tuple[str, str]:
    """Return a platform plugin id and an ordinary npm dependency id."""
    return (f"@kb-labs/journey-transitive-plugin-{suffix}",
            f"journey-transitive-dependency-{suffix}")


def _transitive_npm_fixture_dependencies(dependency_id: str, sdk_version: str) -> dict[str, dict[str, str]]:
    """Keep the private npm dependency distinct from the platform-provided SDK peer."""
    return {
        "dependencies": {dependency_id: "1.0.0"},
        "peerDependencies": {"@kb-labs/sdk": sdk_version},
    }


def _output(result: CompletedProcess[str], command: list[str]) -> str:
    if result.returncode != 0:
        detail = " ".join(f"{result.stdout or ''} {result.stderr or ''}".split())
        try:
            envelope = read_ux_cli_result(result)
        except (json.JSONDecodeError, ValueError):
            envelope = None
        if isinstance(envelope, dict) and envelope.get("ok") is False:
            error = decode_ux_error_result(envelope)
            detail = "; ".join(part for part in (
                str(error.get("code") or ""),
                str(error.get("message") or ""),
                f"hint: {error['hint']}" if error.get("hint") else "",
            ) if part)
        if len(detail) > 2200:
            detail = f"{detail[:1700]} … {detail[-500:]}"
        raise RuntimeError(f"`{' '.join(command)}` exited {result.returncode}: {detail}")
    return result.stdout


def _registry_version(package_id: str, registry: str, project: Path, env: dict[str, str],
                      runner: CommandRunner) -> str:
    command = ["npm", "view", package_id, "version", "--json", f"--registry={registry}"]
    result = run_with_runner(runner, command, cwd=project, env=env, timeout=120)
    raw = _output(result, command)
    try:
        version = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"`{' '.join(command)}` returned invalid version JSON: {raw[:300]!r}") from error
    if not isinstance(version, str) or not version:
        raise RuntimeError(f"`{' '.join(command)}` did not resolve one published version")
    return version


def _json(result: CompletedProcess[str], command: list[str]) -> dict:
    _output(result, command)
    try:
        value = read_ux_cli_result(result)
    except (json.JSONDecodeError, ValueError) as error:
        raise RuntimeError(f"`{' '.join(command)}` returned an invalid UX result: {error}") from error
    data = decode_ux_success_result(value)
    if not isinstance(data, dict):
        raise RuntimeError(f"`{' '.join(command)}` returned non-object UX data")
    return data


def validate_commit_status_response(status: int, payload: object) -> None:
    data = payload.get("data") if isinstance(payload, dict) else None
    if status != 200 or not isinstance(data, dict) or data.get("scope") != "root":
        raise RuntimeError(f"Commit status route returned an unexpected response: HTTP {status} {payload!r}")


def validate_unmounted_commit_response(status: int, payload: object) -> None:
    failure = payload.get("error") if isinstance(payload, dict) else None
    if (status != 404 or not isinstance(payload, dict) or payload.get("ok") is not False
            or not isinstance(failure, dict)
            or failure.get("code") != "KB_PLUGIN_NOT_INSTALLED"
            or failure.get("message") != "Plugin is not installed in this project."
            or failure.get("hint") != "Run `kb marketplace install @kb-labs/commit` in this project."
            or not isinstance(failure.get("correlationId"), str) or not failure["correlationId"]):
        raise RuntimeError(f"unmounted Commit route returned an unexpected gateway failure: HTTP {status} {payload!r}")


def _commit_project_fixture_entry(lock: object, version: str, *, marketplace_source: str = "npm",
                                  signature_status: str = "unsigned") -> dict | None:
    plugins = lock.get("plugins") if isinstance(lock, dict) else None
    entry = plugins.get("@kb-labs/commit") if isinstance(plugins, dict) else None
    if (isinstance(lock, dict) and lock.get("schema") == "kb.marketplace/3"
            and isinstance(entry, dict) and entry.get("version") == version
            and entry.get("package") == "@kb-labs/commit" and entry.get("integrity")
            and entry.get("marketplaceSource") == marketplace_source
            and entry.get("signatureStatus") == signature_status
            and entry.get("source") == "marketplace" and entry.get("enabled") is True):
        return entry
    return None


def wait_for_marketplace_ready(project: Path, env: dict[str, str], runner: CommandRunner,
                               *, timeout: float = 60) -> None:
    """Wait for the installed product's marketplace health check before registry reads."""
    command = kb_command([ "marketplace", "plugins", "doctor", "--scope", "project", "--json"])
    deadline = time.monotonic() + timeout
    last_problem = "health check did not return"
    while time.monotonic() < deadline:
        result = _run(command, cwd=project, env=env, runner=runner)
        try:
            payload = read_ux_cli_result(result)
        except ValueError as error:
            last_problem = str(error)
            raise RuntimeError(f"marketplace doctor returned an invalid UX result: {last_problem}") from error
        if result.returncode == 0 and isinstance(payload, dict) and payload.get("ok") is True:
            return
        last_problem = (result.stderr or result.stdout or f"exit {result.returncode}").strip()[-800:]
        time.sleep(0.5)
    raise RuntimeError(
        "marketplace did not become healthy within 60 seconds; "
        f"`{' '.join(command)}` last reported: {last_problem}; "
        "check the journey registry and rerun `e2e/journey/run.sh --no-build`."
    )


def _project_config(root: Path) -> tuple[Path, dict]:
    config_file = root / ".kb" / "kb.config.json"
    try:
        value = json.loads(config_file.read_text())
    except FileNotFoundError:
        value = {}
    except json.JSONDecodeError as error:
        raise RuntimeError(f"project config is invalid JSON at {config_file}: {error}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"project config must contain a JSON object: {config_file}")
    return config_file, value


def _entries(payload: dict) -> list[dict]:
    entries = payload.get("entries")
    if not isinstance(entries, list):
        raise RuntimeError("`kb marketplace plugins list --json` returned no entries array")
    return entries


def run_plugin_policy_diagnostic_step(journey: Journey, project: Path, registry: str,
                                      env: dict[str, str], runner: CommandRunner) -> None:
    """Prove a malformed project policy blocks the installed third-party fixture only."""
    fixture_package = "@kb-labs/e2e-analytics-emitter"
    config_file = project / ".kb" / "kb.config.json"

    def verify() -> None:
        install = ["marketplace", "install", fixture_package, "--json"]
        _json(_run(kb_command([ *install]), cwd=project, env=env, runner=runner), install)
        original = config_file.read_bytes() if config_file.exists() else None
        try:
            config_file.parent.mkdir(parents=True, exist_ok=True)
            config = json.loads(original) if original is not None else {}
            config["plugins"] = {**(config.get("plugins", {}) if isinstance(config.get("plugins"), dict) else {}), "block": 7}
            config_file.write_text(json.dumps(config, indent=2) + "\n")

            doctor = ["marketplace", "plugins", "doctor", "--scope", "project", "--json"]
            result = _run(kb_command([ *doctor]), cwd=project, env=env, runner=runner)
            try:
                envelope = read_ux_cli_result(result)
                error = decode_ux_error_result(envelope)
            except (json.JSONDecodeError, ValueError) as parse_error:
                raise RuntimeError("marketplace doctor did not return its typed policy diagnostic") from parse_error
            diagnostics = error.get("diagnostics") if isinstance(error, dict) else None
            expected_hint = f"kb marketplace plugins doctor --scope project"
            if result.returncode == 0 or not isinstance(diagnostics, list) or not any(
                isinstance(item, dict)
                and item.get("code") == "PLUGIN_POLICY_TYPE_INVALID"
                and item.get("path") == str(config_file)
                and expected_hint in str(item.get("hint", ""))
                and fixture_package in str(item.get("message", ""))
                for item in diagnostics
            ):
                raise RuntimeError("marketplace doctor omitted the typed plugins.block diagnostic, config path, or repair hint")

            blocked = ["journey", "analytics", "emit", "--marker", "policy-blocked", "--json"]
            blocked_result = _run(kb_command([ *blocked]), cwd=project, env=env, runner=runner)
            if blocked_result.returncode == 0:
                raise RuntimeError("third-party analytics command remained registered with an invalid project policy")
            blocked_error = decode_ux_error_result(read_ux_cli_result(blocked_result))
            if fixture_package in str(blocked_error.get("message", "")):
                raise RuntimeError("third-party analytics command ran instead of being excluded from discovery")

            first_party = ["version", "--json"]
            _json(_run(kb_command([ *first_party]), cwd=project, env=env, runner=runner), first_party)
        finally:
            if original is None:
                config_file.unlink(missing_ok=True)
            else:
                config_file.write_bytes(original)

    with invocation_context(step_id="S-203.25"):
        journey.step("malformed project plugin policy blocks marketplace plugins and preserves shipped commands",
                     "marketplace", verify, cases=["S-203.25"])


def validate_shared_failure(result: CompletedProcess[str], *, json_mode: bool,
                            code: str, message: str, hint: str,
                            marketplace_source_kinds: tuple[str, ...] = ()) -> None:
    """Validate the common human or machine failure contract used by S-051."""
    if result.returncode == 0:
        raise AssertionError("failing command unexpectedly exited successfully")
    if json_mode:
        payload = read_ux_cli_result(result)
        error = decode_ux_error_result(payload)
        if not isinstance(error, dict) or (error.get("code"), error.get("message"), error.get("hint")) != (code, message, hint):
            raise AssertionError(f"JSON failure does not match {code}")
        if code == "KB_PLUGIN_NOT_FOUND":
            cause = error.get("cause")
            if not isinstance(cause, str) or not marketplace_source_kinds:
                raise AssertionError("Marketplace not-found omitted configured source results")
            results = [tuple(part.strip().split(": ", maxsplit=1)) for part in cause.split("; ")]
            if (len(results) != len(marketplace_source_kinds)
                    or any(len(result) != 2 or result[0] != kind or not result[1].startswith("not-found-")
                           for result, kind in zip(results, marketplace_source_kinds))):
                raise AssertionError("Marketplace not-found did not report each configured source result")
        return
    output = " ".join(f"{result.stdout or ''} {result.stderr or ''}".split())
    if f"{message} [{code}]" not in output or "Hint:" not in output or hint not in output:
        raise AssertionError(f"human failure does not match {code}")
    if "Traceback" in output or output.lstrip().startswith("{"):
        raise AssertionError("human failure exposed a stack trace or raw JSON")


def configured_marketplace_source_kinds(status: dict) -> tuple[str, ...]:
    sources = status.get("marketplaceSources")
    if not isinstance(sources, list):
        raise RuntimeError("kb-create status did not report the configured Marketplace sources")
    source_kinds = tuple(source.get("kind") for source in sources if isinstance(source, dict))
    if len(source_kinds) != len(sources) or not all(isinstance(kind, str) and kind for kind in source_kinds):
        raise RuntimeError("kb-create status returned an invalid configured Marketplace source list")
    return source_kinds


def authenticate_secured_marketplace(journey: Journey, project: Path, env: dict[str, str],
                                     runner: CommandRunner) -> None:
    """Clear both credential stores, prove the auth refusal, then log in as admin."""
    if journey.mode != "secured":
        return

    logout = kb_command(["auth", "logout", "--json"])
    with invocation_context(step_id="marketplace.unauthenticated-session"):
        logout_result = _run(logout, cwd=project, env=env, runner=runner)
    if logout_result.returncode != 0:
        raise RuntimeError("could not clear saved Gateway credentials before unauthenticated marketplace checks")

    gateway = _installed_gateway_url(env)

    def assert_auth_required(step_id: str, scope_args: list[str]) -> None:
        command = kb_command(["marketplace", "plugins", "list", *scope_args, "--json"])
        with invocation_context(step_id=step_id):
            result = _run(command, cwd=project, env=env, runner=runner)
        try:
            payload = read_ux_cli_result(result)
        except (json.JSONDecodeError, ValueError) as error:
            raise RuntimeError(f"unauthenticated marketplace list returned an invalid UX result: {error}") from error
        failure = decode_ux_error_result(payload) if result.returncode else None
        details = failure.get("details") if isinstance(failure, dict) else None
        if (result.returncode == 0 or not isinstance(failure, dict)
                or failure.get("code") != "KB_AUTH_REQUIRED"
                or failure.get("message") != catalogued_error_message("KB_AUTH_REQUIRED")
                or failure.get("hint") != catalogued_error_hint(
                    "KB_AUTH_REQUIRED", gatewayUrl=gateway)
                or not isinstance(details, dict) or details.get("gatewayUrl") != gateway):
            raise RuntimeError("unauthenticated marketplace list did not return KB_AUTH_REQUIRED with the login hint")

    def assert_both_marketplace_scopes_require_auth() -> None:
        for scope in ([], ["--scope", "platform"]):
            assert_auth_required("S-041.7", scope)

    journey.step("secured marketplace requires a saved CLI session", "marketplace",
                 assert_both_marketplace_scopes_require_auth, cases=["S-041.7"])


    journey.step("S-010.6 secured marketplace requires the catalogued login error", "marketplace",
                 lambda: assert_auth_required("S-010.6", ["--scope", "platform"]), cases=["S-010.6"],
                 runners=("service-secured:explore",))

    email = env.get("KB_JOURNEY_ADMIN_EMAIL", "admin@example.com")
    password = env.get("KB_JOURNEY_ADMIN_PASSWORD", "")
    if not password:
        raise RuntimeError("secured marketplace journey needs KB_JOURNEY_ADMIN_PASSWORD")
    login = kb_command([ "auth", "login", "--gateway-url", gateway,
             "--email", email, "--password-stdin", "--json"])
    with invocation_context(step_id="marketplace.authenticated-session"):
        result = _run(login, cwd=project, env=env, runner=runner, input=password + "\n")
    if result.returncode != 0:
        raise RuntimeError("secured admin CLI login failed; check the isolated journey credentials")

    status = kb_command([ "auth", "status", "--json"])
    with invocation_context(step_id="marketplace.authenticated-session"):
        auth_status = _json(_run(status, cwd=project, env=env, runner=runner), status)
    session = gateway_session(auth_status, gateway)
    if not isinstance(session, dict) or session.get("authenticated") is not True:
        raise RuntimeError("secured marketplace CLI login did not save a user session")

    command = kb_command([ "marketplace", "plugins", "list", "--scope", "platform", "--json"])
    with invocation_context(step_id="marketplace.authenticated-session"):
        resumed = _run(command, cwd=project, env=env, runner=runner)
    payload = read_ux_cli_result(resumed)
    failure = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(failure, dict) and failure.get("code") == "KB_AUTH_REQUIRED":
        raise RuntimeError("authenticated marketplace list still returned KB_AUTH_REQUIRED")


def prepare_commit_project_fixture(journey: Journey, project_root: str | Path, registry: str,
                                   env: dict[str, str] | None = None,
                                   runner: CommandRunner = run_command) -> dict | None:
    """Install the shared Commit pin from the Release 1 default npm source."""
    project = Path(project_root).resolve()
    base_env = dict(os.environ if env is None else env)
    export_project_identity_to_child_environment(base_env, project_root=str(project))
    captured: dict[str, dict] = {}

    def install_fixture() -> None:
        if base_env.get("KB_JOURNEY_MARKETPLACE_REGISTRY_URL"):
            _assert_registry_gateway_config(base_env)
        wait_for_marketplace_ready(project, base_env, runner)
        workspace = Path(base_env.get("KB_JOURNEY_WORKSPACE_ROOT", Path(__file__).resolve().parents[2]))
        version = commit_fixture_source_version(workspace)
        command = ["marketplace", "install", f"@kb-labs/commit@{version}", "--json"]
        result = _json(_run(kb_command(command), cwd=project, env=base_env, runner=runner), command)
        installed = result.get("installed")
        if (result.get("scope") != "project" or not isinstance(installed, list)
                or not any(isinstance(item, dict) and item.get("id") == "@kb-labs/commit"
                           and item.get("version") == version and item.get("source") == "npm"
                           and item.get("signatureStatus") == "unsigned" for item in installed)):
            raise RuntimeError("project fixture install did not report the selected Commit npm version")
        lock = json.loads((project / ".kb" / "marketplace.lock").read_text())
        entry = _commit_project_fixture_entry(lock, version)
        if entry is None:
            raise RuntimeError("project fixture install did not establish its npm-provenance Commit lock entry")
        captured["entry"] = dict(entry)

    journey.step("produce Commit project fixture", "marketplace-fixtures", install_fixture,
                 role="lifecycle")
    return captured.get("entry")


def publish_commit_update_fixture(registry: str, source_version: str, env: dict[str, str],
                                   runner: CommandRunner = run_command) -> str:
    """Publish the next-major Commit package to the journey npm registry.

    The candidate package set carries only workspace-source artifacts, so the
    newer version an update case needs is derived here from the published
    Commit candidate and published by the shared immutable publisher.
    """
    major = source_version.split(".", 1)[0]
    if not major.isdigit():
        raise RuntimeError(f"Commit source version is not semver: {source_version}")
    update_version = f"{int(major) + 1}.0.0"
    with tempfile.TemporaryDirectory(prefix="kb-commit-update-fixture-") as directory:
        root = Path(directory)
        source_dir, unpacked, output = root / "source", root / "unpacked", root / "publish"
        for path in (source_dir, unpacked, output):
            path.mkdir()
        npm_env = dict(env)
        npm_env.update({"HOME": str(root), "npm_config_cache": str(root / ".npm-cache"),
                        "npm_config_userconfig": str(root / ".npmrc")})
        pack = ["npm", "pack", f"@kb-labs/commit@{source_version}", f"--registry={registry}",
                "--pack-destination", str(source_dir)]
        _output(run_with_runner(runner, pack, cwd=root, env=npm_env, timeout=300), pack)
        tarballs = sorted(source_dir.glob("*.tgz"))
        if len(tarballs) != 1:
            raise RuntimeError(f"`{' '.join(pack)}` produced {len(tarballs)} tarballs")
        extract = ["tar", "-xzf", str(tarballs[0]), "-C", str(unpacked)]
        _output(run_with_runner(runner, extract, cwd=root, env=npm_env, timeout=120), extract)
        package_dir = unpacked / "package"
        manifest_path = package_dir / "package.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("name") != "@kb-labs/commit" or manifest.get("version") != source_version:
            raise RuntimeError("registry Commit artifact does not match the Commit source identity")
        manifest["version"] = update_version
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        repack = ["npm", "pack", "--ignore-scripts", "--pack-destination", str(output)]
        _output(run_with_runner(runner, repack, cwd=package_dir, env=npm_env, timeout=300), repack)
        publish_env = dict(npm_env)
        publish_env.update({
            "PUBLISH_PACKAGES_DIR": str(output),
            "PUBLISH_PARALLELISM": "1",
            "VERDACCIO_URL": registry,
            "KB_ERROR_CATALOG_PATH": str(workspace_resource(
                "core", "platform", "src", "error-envelope", "errors.catalog.json")),
        })
        publish = ["sh", str(workspace_resource("e2e", "publisher", "publish.sh"))]
        _output(run_with_runner(runner, publish, cwd=root, env=publish_env, timeout=300), publish)
    return update_version


def _release_version_tuple(version: str) -> tuple[int, int, int]:
    match = re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version)
    if not match:
        raise RuntimeError("Registry Commit fixture requires a stable semantic package version")
    return tuple(int(part) for part in match.groups())


def _registry_resolve_exact_commit_version(env: dict[str, str], version: str) -> dict | None:
    gateway_url = _installed_gateway_url(env).rstrip("/")
    registry_api = f"{gateway_url}/api/v1/marketplace-registry/api/v1"
    query = urlencode({"identity": "@kb-labs/commit", "version": version})
    request = urllib.request.Request(f"{registry_api}/resolve?{query}", headers={"Accept": "application/json"})
    status, body, _ = open_http(urllib.request.urlopen, request, timeout=30, env=env)
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, TypeError) as error:
        raise RuntimeError("Gateway Registry version probe returned invalid JSON") from error
    if status == 200 and isinstance(payload, dict) and payload.get("status") == "found":
        package = payload.get("package")
        if isinstance(package, dict) and package.get("id") == "@kb-labs/commit" and package.get("version") == version:
            return package
        raise RuntimeError("Gateway Registry version probe returned a mismatched Commit package")
    if (status == 200 and isinstance(payload, dict)
            and payload.get("status") in {"not-found-owned", "not-found-unowned"}):
        return None
    raise RuntimeError("Gateway Registry could not confirm whether the Commit fixture version is available")


def _registry_commit_base_versions(workspace: Path, active_platform: Path, env: dict[str, str]) -> list[str]:
    source_version = commit_fixture_source_version(workspace)
    versions = [source_version]
    active_root = Path(active_platform)
    platform_lock = active_root / layout_value("versionStatePaths.kb_marketplace_lock")
    if platform_lock.is_file():
        try:
            lock = json.loads(platform_lock.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError("active platform Marketplace lock is unreadable") from error
        plugins = lock.get("plugins") if isinstance(lock, dict) else None
        commit = plugins.get("@kb-labs/commit") if isinstance(plugins, dict) else None
        pinned_version = commit.get("version") if isinstance(commit, dict) else None
        if isinstance(pinned_version, str) and pinned_version:
            versions.append(pinned_version)

    kb_home_value = env.get("KB_HOME", "").strip()
    kb_home = (Path(kb_home_value).expanduser().resolve() if kb_home_value
               else (Path(env.get("HOME", str(Path.home()))) / ".kb").resolve())
    entries = kb_home / "store" / "entries"
    key_prefix = "@kb-labs+commit@"
    if entries.is_dir():
        for entry in entries.glob(f"{key_prefix}*"):
            version = entry.name[len(key_prefix):]
            if version:
                versions.append(version)
    for version in versions:
        _release_version_tuple(version)
    return versions


def _next_free_registry_commit_version(workspace: Path, active_platform: Path,
                                        env: dict[str, str]) -> str:
    base_versions = _registry_commit_base_versions(workspace, active_platform, env)
    base = max(base_versions, key=_release_version_tuple)
    major, minor, patch = _release_version_tuple(base)
    for _ in range(100):
        patch += 1
        candidate = f"{major}.{minor}.{patch}"
        store_entries = (Path(env.get("KB_HOME", str(Path(env.get("HOME", str(Path.home()))) / ".kb")))
                         / "store" / "entries")
        if (store_entries / f"@kb-labs+commit@{candidate}").exists():
            continue
        if _registry_resolve_exact_commit_version(env, candidate) is None:
            return candidate
    raise RuntimeError("could not find an unused higher Commit version in the Registry and extension store")


def _prepare_registry_commit_publish_package(workspace: Path, fixture_parent: Path,
                                            active_platform: Path, env: dict[str, str],
                                            runner: CommandRunner = run_command) -> tuple[Path, str]:
    source_root = workspace / "plugins" / "commit"
    if not source_root.resolve().is_relative_to(workspace.resolve()):
        raise RuntimeError("active Commit fixture package is outside the journey workspace")
    source_package_path = source_root / "package.json"
    try:
        source_package = json.loads(source_package_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("active Commit fixture package manifest is unavailable") from error
    package_name = source_package.get("name")
    source_version = source_package.get("version")
    if package_name != "@kb-labs/commit" or not isinstance(source_version, str):
        raise RuntimeError("active Commit fixture package identity is invalid")
    fixture_version = _next_free_registry_commit_version(workspace, active_platform, env)
    manifest_field = source_package.get("kb", {}).get("manifest") if isinstance(source_package.get("kb"), dict) else None
    if not isinstance(manifest_field, str):
        raise RuntimeError("active Commit fixture package does not declare its compiled manifest")
    manifest_js = (source_root / manifest_field).resolve()
    manifest_json = manifest_js.with_suffix(".json")
    if (source_root.resolve() not in manifest_js.parents or not manifest_js.is_file()
            or not manifest_json.is_file()):
        raise RuntimeError("active Commit fixture compiled manifest files are unavailable")
    try:
        static_manifest = json.loads(manifest_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("active Commit fixture static manifest is invalid") from error
    if static_manifest.get("id") != package_name:
        raise RuntimeError("active Commit package name and compiled manifest identity differ")

    fixture_root = fixture_parent / "commit"
    fixture_root.mkdir(parents=True, exist_ok=False)
    # Run the same workspace-aware pack step used by release staging before
    # moving the package outside the workspace. pnpm resolves workspace:*
    # references only while packing from the real workspace package root.
    pack_dir = fixture_parent / "workspace-pack"
    pack_dir.mkdir(parents=True, exist_ok=False)
    pack = run_with_runner(runner, ["pnpm", "pack", "--pack-destination", str(pack_dir)],
                           cwd=source_root, env=env, timeout=300)
    if pack.returncode != 0:
        raise RuntimeError("pnpm workspace pack failed for the active Commit fixture")
    packed_name = (pack.stdout or "").strip().splitlines()
    if not packed_name:
        raise RuntimeError("pnpm workspace pack returned no Commit tarball path")
    tarball = Path(packed_name[-1].strip())
    if not tarball.is_absolute():
        tarball = pack_dir / tarball
    try:
        tarball = tarball.resolve(strict=True)
    except OSError as error:
        raise RuntimeError("pnpm workspace pack did not create its Commit tarball") from error
    if pack_dir.resolve() not in tarball.parents or not tarball.is_file():
        raise RuntimeError("pnpm workspace pack returned a tarball outside its isolated output directory")
    try:
        with tarfile.open(tarball, "r:gz") as archive:
            for member in archive.getmembers():
                member_path = PurePosixPath(member.name)
                if (member_path.is_absolute() or ".." in member_path.parts
                        or not member_path.parts or member_path.parts[0] != "package"):
                    raise RuntimeError("pnpm workspace pack returned an unsafe package path")
                relative = Path(*member_path.parts[1:])
                if not relative.parts:
                    continue
                destination = fixture_root / relative
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                if member.isfile():
                    source = archive.extractfile(member)
                    if source is None:
                        raise RuntimeError("pnpm workspace pack returned an unreadable Commit file")
                    with source, destination.open("wb") as output:
                        shutil.copyfileobj(source, output)
                    destination.chmod(member.mode & 0o777)
                    continue
                raise RuntimeError("pnpm workspace pack returned an unsupported Commit archive entry")
    except (OSError, tarfile.TarError) as error:
        raise RuntimeError("pnpm workspace pack returned an invalid Commit tarball") from error
    finally:
        tarball.unlink(missing_ok=True)
    try:
        packed_package = json.loads((fixture_root / "package.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("pnpm workspace pack did not include a valid Commit package manifest") from error
    if (packed_package.get("name") != package_name or packed_package.get("version") != source_version):
        raise RuntimeError("pnpm workspace pack changed the active Commit package identity or version")
    for section in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        dependencies = packed_package.get(section)
        if isinstance(dependencies, dict) and any(
                isinstance(spec, str) and spec.startswith("workspace:") for spec in dependencies.values()):
            raise RuntimeError("pnpm workspace pack left an unresolved workspace dependency in the Commit artifact")
    packed_package["version"] = fixture_version
    (fixture_root / "package.json").write_text(
        json.dumps(packed_package, indent=2) + "\n", encoding="utf-8")
    packed_manifest_field = packed_package.get("kb", {}).get("manifest")
    if not isinstance(packed_manifest_field, str):
        raise RuntimeError("pnpm workspace pack omitted the active Commit compiled manifest path")
    packed_manifest = Path(packed_manifest_field)
    if packed_manifest.is_absolute() or ".." in packed_manifest.parts:
        raise RuntimeError("pnpm workspace pack returned an unsafe Commit manifest path")
    manifest_js = fixture_root / packed_manifest
    manifest_json = manifest_js.with_suffix(".json")
    if not manifest_js.is_file() or not manifest_json.is_file():
        raise RuntimeError("pnpm workspace pack omitted the active Commit compiled manifest files")
    try:
        packed_static_manifest = json.loads(manifest_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("pnpm workspace pack returned an invalid Commit static manifest") from error
    if packed_static_manifest.get("id") != package_name:
        raise RuntimeError("pnpm workspace pack changed the active Commit manifest identity")
    installed_node_modules = Path(active_platform) / "node_modules"
    if not installed_node_modules.is_dir():
        raise RuntimeError("active platform package dependencies are unavailable for the Commit publisher")
    (fixture_root / "node_modules").symlink_to(installed_node_modules, target_is_directory=True)
    package = json.loads((fixture_root / "package.json").read_text(encoding="utf-8"))
    package["version"] = fixture_version
    (fixture_root / "package.json").write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")
    return fixture_root, fixture_version


def prepare_registry_commit_project_fixture(journey: Journey, project_root: str | Path, registry: str,
                                            env: dict[str, str] | None = None,
                                            runner: CommandRunner = run_command) -> dict | None:
    """Publish and install Commit for the Registry runner's isolated project."""
    project = Path(project_root).resolve()
    base_env = dict(os.environ if env is None else env)
    export_project_identity_to_child_environment(base_env, project_root=str(project))
    captured: dict[str, dict] = {}

    def assert_direct_registry_denied() -> None:
        registry_api = base_env.get("KB_JOURNEY_MARKETPLACE_PUBLISH_URL", "").removesuffix("/api/v1")
        if not registry_api:
            raise RuntimeError("journey Registry direct-access check has no service URL")
        direct_request = urllib.request.Request(
            f"{registry_api}/api/v1/resolve?identity=%40kb-labs%2Fcommit")
        status, body, _ = open_http(urllib.request.urlopen, direct_request, timeout=30, env=base_env)
        direct_payload = read_ux_http_result(body, status)
        direct_error = direct_payload.get("error") if isinstance(direct_payload, dict) else None
        if status != 401 or not isinstance(direct_error, dict) or direct_error.get("code") != "KB_AUTH_REQUIRED":
            raise RuntimeError("direct Registry resolve was not denied without the Gateway internal secret")

    journey.step("direct Registry access is denied without Gateway identity", "marketplace-fixtures",
                 assert_direct_registry_denied, cases=["S-268.1"], role="lifecycle",
                 runners=("service-marketplace-registry:local", "service-marketplace-registry:secured"))

    def assert_gateway_registry_ready() -> None:
        gateway_request = urllib.request.Request(f"{_installed_gateway_url(base_env)}/ready")
        status, body, _ = open_http(urllib.request.urlopen, gateway_request, timeout=30, env=base_env)
        payload = read_ux_http_result(body, status)
        data = payload.get("data") if isinstance(payload, dict) else None
        components = data.get("components") if isinstance(data, dict) else None
        registry_component = components.get("upstream:marketplaceRegistry") if isinstance(components, dict) else None
        if (status != 200 or not isinstance(data, dict) or data.get("ready") is not True
                or not isinstance(registry_component, dict) or registry_component.get("ready") is not True):
            raise RuntimeError("Gateway readiness did not report the protected Marketplace Registry upstream as ready")

    journey.step("Gateway reports protected Registry ready", "marketplace-fixtures",
                 assert_gateway_registry_ready, cases=["S-268.23"], role="lifecycle",
                 runners=("service-marketplace-registry:local", "service-marketplace-registry:secured"))

    def install_fixture() -> None:
        _assert_registry_gateway_config(base_env)
        wait_for_marketplace_ready(project, base_env, runner)
        base_env["KB_REGISTRY_URL"] = (
            f"{_installed_gateway_url(base_env)}/api/v1/marketplace-registry/api/v1")
        workspace = Path(base_env.get("KB_JOURNEY_WORKSPACE_ROOT", Path(__file__).resolve().parents[2]))
        active_platform = active_platform_root(Path(base_env["KB_JOURNEY_PLATFORM_ROOT"]))
        with tempfile.TemporaryDirectory(
                prefix="kb-registry-commit-publish-", dir=base_env.get("HOME")) as fixture_directory:
            commit_package, expected_version = _prepare_registry_commit_publish_package(
                workspace, Path(fixture_directory), active_platform, base_env, runner)
            published = _json(_publish_workspace_fixture(workspace, str(commit_package), base_env, runner),
                               commit_publish_command(commit_package))
        version = published.get("version")
        if version != expected_version:
            raise RuntimeError("Registry publisher returned a Commit version different from the prepared package")
        resolved_package = _registry_resolve_exact_commit_version(base_env, version)
        if (not isinstance(resolved_package, dict) or resolved_package.get("id") != "@kb-labs/commit"
                or resolved_package.get("version") != version or not resolved_package.get("integrity")):
            raise RuntimeError("Registry resolve did not return the published Commit package and integrity")
        for fixture_path in ("e2e/journey/fixtures/analytics-emitter", "plugins/qa"):
            publication = _json(_publish_workspace_fixture(workspace, fixture_path, base_env, runner),
                                _publish_fixture_command(workspace, fixture_path))
            if not isinstance(publication.get("version"), str) or not publication.get("version"):
                raise RuntimeError(f"kb hub publish did not return a version for {fixture_path}")
        command = ["marketplace", "install", "@kb-labs/commit", "--json"]
        result = _json(_run(kb_command(command), cwd=project, env=base_env, runner=runner), command)
        installed = result.get("installed")
        if (result.get("scope") != "project" or not isinstance(installed, list)
                or not any(isinstance(item, dict) and item.get("id") == "@kb-labs/commit"
                           and item.get("version") == version and item.get("source") == "registry"
                           and item.get("signatureStatus") == "verified" for item in installed)):
            raise RuntimeError("Registry fixture install did not return the selected Commit version")
        lock = json.loads((project / ".kb" / "marketplace.lock").read_text())
        entry = _commit_project_fixture_entry(lock, version, marketplace_source="registry",
                                              signature_status="verified")
        if entry is None:
            raise RuntimeError("Registry fixture install did not record the verified Commit lock entry")
        if entry.get("integrity") != resolved_package.get("integrity"):
            raise RuntimeError("Registry install lock integrity differs from the published exact-version resolution")
        captured["entry"] = dict(entry)

    journey.step("publish and install Commit through Registry", "marketplace-fixtures", install_fixture,
                 role="lifecycle", runners=("service-marketplace-registry:local",
                                            "service-marketplace-registry:secured"))

    def assert_registry_provenance() -> None:
        entry = captured.get("entry")
        if (not isinstance(entry, dict) or entry.get("marketplaceSource") != "registry"
                or entry.get("signatureStatus") != "verified" or not entry.get("integrity")):
            raise RuntimeError("Commit lock entry does not prove Registry provenance and signature verification")

    journey.step("verify Commit Registry signature and provenance", "marketplace-fixtures",
                 assert_registry_provenance, cases=["S-268.1"],
                 requires=("step:publish and install Commit through Registry",),
                 runners=("service-marketplace-registry:local", "service-marketplace-registry:secured"))
    return captured.get("entry")


def _set_marketplace_proxy_faults(project: Path, env: dict[str, str], runner: CommandRunner,
                                  faults: dict[str, str]) -> None:
    proxy = env.get("KB_JOURNEY_MARKETPLACE_REGISTRY_URL")
    if not proxy:
        raise RuntimeError("Marketplace Registry mirror URL was not provided by the journey composition")
    request = urllib.request.Request(
        f"{proxy.rstrip('/')}/__journey/faults", data=json.dumps(faults).encode(),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    status, _, _ = open_http(urllib.request.urlopen, request, timeout=30, env=env)
    if status != 204:
        raise RuntimeError(f"Marketplace journey mirror refused fault configuration: HTTP {status}")


def _assert_catalogued_marketplace_failure(project: Path, env: dict[str, str], runner: CommandRunner,
                                            package: str, code: str) -> None:
    command = ["marketplace", "install", package, "--json"]
    result = _run(kb_command(command), cwd=project, env=env, runner=runner)
    try:
        payload = read_ux_cli_result(result)
        failure = decode_ux_error_result(payload)
    except (json.JSONDecodeError, ValueError) as error:
        raise RuntimeError(f"`kb {' '.join(command)}` returned no rendered catalogue envelope") from error
    expected_hint = catalogued_error_hint(code, package=package, scope="project")
    expected_message = catalogued_error_message(code)
    if (result.returncode == 0 or not isinstance(failure, dict)
            or failure.get("code") != code or failure.get("message") != expected_message
            or failure.get("hint") != expected_hint):
        raise RuntimeError(f"`kb {' '.join(command)}` did not render catalogue error {code} and its exact hint")


def run_ordered_source_journey_steps(journey: Journey, project_root: str | Path,
                                    env: dict[str, str], runner: CommandRunner) -> None:
    """Exercise ordered source choice, typed failures, persistence, and old-lock refusal."""
    project = Path(project_root).resolve()
    package = "@kb-labs/commit"
    lock_path = project / ".kb" / "marketplace.lock"

    def assert_npm_fallback() -> None:
        command = ["marketplace", "install", "journey-npm-only-fixture", "--json"]
        result = _json(_run(kb_command(command), cwd=project, env=env, runner=runner), command)
        installed = result.get("installed")
        if not isinstance(installed, list) or not any(
                isinstance(item, dict) and item.get("id") == "journey-npm-only-fixture"
                and item.get("source") == "npm" and item.get("signatureStatus") == "unsigned"
                for item in installed):
            raise RuntimeError("the unowned npm fixture was not reported as unsigned/npm")
        lock = json.loads(lock_path.read_text())
        entry = lock.get("plugins", {}).get("journey-npm-only-fixture")
        if not isinstance(entry, dict) or entry.get("marketplaceSource") != "npm" \
                or entry.get("signatureStatus") != "unsigned" or not entry.get("integrity"):
            raise RuntimeError("the npm fallback lock entry omitted source, integrity, or unsigned status")
        doctor = ["marketplace", "plugins", "doctor", "--scope", "project", "--json"]
        report = _json(_run(kb_command(doctor), cwd=project, env=env, runner=runner), doctor)
        encoded = json.dumps(report, sort_keys=True)
        if "journey-npm-only-fixture" not in encoded or '"npm"' not in encoded or '"unsigned"' not in encoded:
            raise RuntimeError("marketplace doctor did not expose the npm fallback provenance")

    journey.step("fallback to configured npm only for an unowned identity", "marketplace",
                 assert_npm_fallback, cases=["S-268.2"],
                 requires=("step:publish and install Commit through Registry",),
                 runners=("service-marketplace-registry:local", "service-marketplace-registry:secured"))

    def assert_no_fallback_for_source_failures() -> None:
        original_lock = lock_path.read_bytes()
        fallback_package = "journey-npm-only-fixture"
        try:
            for fault, code in (("auth", "KB_MARKETPLACE_AUTH_FAILED"),
                                ("transport", "KB_MARKETPLACE_TRANSPORT_FAILED")):
                _set_marketplace_proxy_faults(project, env, runner, {fallback_package: fault})
                _assert_catalogued_marketplace_failure(project, env, runner, fallback_package, code)
                if lock_path.read_bytes() != original_lock:
                    raise RuntimeError(f"{fault} failure changed the Marketplace lock")
        finally:
            _set_marketplace_proxy_faults(project, env, runner, {})

    journey.step("source auth and transport errors never fall through to npm", "marketplace",
                 assert_no_fallback_for_source_failures, cases=["S-268.3"],
                 requires=("step:fallback to configured npm only for an unowned identity",),
                 runners=("service-marketplace-registry:local", "service-marketplace-registry:secured"))

    def assert_signature_and_integrity_fail_closed() -> None:
        original_lock = lock_path.read_bytes()
        workspace = Path(env.get("KB_JOURNEY_WORKSPACE_ROOT", Path(__file__).resolve().parents[2]))
        active_platform = active_platform_root(Path(env["KB_JOURNEY_PLATFORM_ROOT"]))
        publish_env = dict(env)
        publish_env["KB_REGISTRY_URL"] = (
            f"{_installed_gateway_url(env).rstrip('/')}/api/v1/marketplace-registry/api/v1")
        with tempfile.TemporaryDirectory(prefix="kb-registry-integrity-test-",
                                         dir=env.get("HOME")) as fixture_directory:
            fixture_package, test_version = _prepare_registry_commit_publish_package(
                workspace, Path(fixture_directory), active_platform, publish_env, runner)
            publication = _json(
                _publish_workspace_fixture(workspace, str(fixture_package), publish_env, runner),
                commit_publish_command(fixture_package))
        if publication.get("version") != test_version:
            raise RuntimeError("Registry integrity fixture published a different Commit version")
        resolved = _registry_resolve_exact_commit_version(publish_env, test_version)
        if (not isinstance(resolved, dict) or resolved.get("id") != package
                or resolved.get("version") != test_version or not resolved.get("integrity")):
            raise RuntimeError("Registry did not resolve the uncached integrity test version and its pin")
        previous_lock = json.loads(original_lock)
        previous_entry = previous_lock.get("plugins", {}).get(package)
        previous_version = previous_entry.get("version") if isinstance(previous_entry, dict) else None
        if (not isinstance(previous_version, str)
                or _release_version_tuple(test_version) <= _release_version_tuple(previous_version)):
            raise RuntimeError("Registry integrity test version is not higher than the installed project pin")

        kb_home_value = env.get("KB_HOME", "").strip()
        kb_home = (Path(kb_home_value).expanduser() if kb_home_value
                   else Path(env.get("HOME", str(Path.home()))) / ".kb")
        test_store_entry = kb_home / "store" / "entries" / f"@kb-labs+commit@{test_version}"
        if test_store_entry.exists():
            raise RuntimeError("Registry integrity test version is already installed in the extension store")
        try:
            for fault, code in (("signature", "KB_MARKETPLACE_SIGNATURE_INVALID"),
                                ("integrity", "KB_MARKETPLACE_INTEGRITY_MISMATCH")):
                _set_marketplace_proxy_faults(project, env, runner, {package: fault})
                _assert_catalogued_marketplace_failure(project, env, runner, package, code)
                if lock_path.read_bytes() != original_lock:
                    raise RuntimeError(f"{fault} failure changed the Marketplace lock")
                if test_store_entry.exists():
                    raise RuntimeError(f"{fault} failure installed the unverified Commit version")
        finally:
            _set_marketplace_proxy_faults(project, env, runner, {})

    journey.step("signature and integrity failures never fall through or commit a lock", "marketplace",
                 assert_signature_and_integrity_fail_closed, cases=["S-268.4"],
                 requires=("step:source auth and transport errors never fall through to npm",),
                 runners=("service-marketplace-registry:local", "service-marketplace-registry:secured"))

    def assert_registry_reserved_identity() -> None:
        _assert_catalogued_marketplace_failure(project, env, runner,
                                                "@kb-labs/commit-unpublished", "KB_MARKETPLACE_IDENTITY_RESERVED")

    journey.step("Registry-owned namespace identities never resolve from npm", "marketplace",
                 assert_registry_reserved_identity, cases=["S-268.5"],
                 requires=("step:signature and integrity failures never fall through or commit a lock",),
                 runners=("service-marketplace-registry:local", "service-marketplace-registry:secured"))

    def assert_update_persists_and_reports_sources() -> None:
        platform_root = Path(env["KB_JOURNEY_PLATFORM_ROOT"]).resolve()
        index = Path(env["HOME"]) / ".local" / "share" / "kb-create" / "release-index.json"
        key = env.get("KB_JOURNEY_MARKETPLACE_PUBLIC_KEY", "")
        args = ["kb-create", "update", "--json", "--index", str(index), "--platform-root", str(platform_root),
                "--registry", env.get("KB_JOURNEY_REGISTRY", "")]
        args[0] = env.get("KB_JOURNEY_KB_CREATE_PATH", args[0])
        result = run_with_runner(runner, args, cwd=project, env=env, timeout=1200)
        _output(result, args)
        store_report_secret(env, "KB_JOURNEY_MARKETPLACE_TOKEN",
                            "journey-registry-token-reference-test-value",
                            "journey Marketplace Registry redaction test credential")
        expected_url = f"{_installed_gateway_url(env)}/api/v1/marketplace-registry"
        token = env.get("KB_JOURNEY_MARKETPLACE_TOKEN", "")
        if not expected_url or not key or not token:
            raise RuntimeError("journey Marketplace source URL or secret references are absent from the installer environment")
        config_path = marketplace_platform_config_path(platform_root)
        raw_config = config_path.read_text()
        if ("${KB_JOURNEY_MARKETPLACE_PUBLIC_KEY}" not in raw_config
                or "${KB_JOURNEY_MARKETPLACE_TOKEN}" not in raw_config
                or key in raw_config or token in raw_config):
            raise RuntimeError("kb-create did not preserve Marketplace secret references without literal values")
        launcher = env.get("KB_JOURNEY_KB_CREATE_PATH", "kb-create")
        for command in ([launcher, "status", "--json", "--platform-root", str(platform_root)],
                        [launcher, "doctor", "--json", "--platform-root", str(platform_root)]):
            status = run_with_runner(runner, command, cwd=project, env=env, timeout=120)
            data = _json(status, command)
            sources = data.get("marketplaceSources")
            serialized = json.dumps(sources, sort_keys=True)
            if ("registry" not in serialized or expected_url not in serialized
                    or key in serialized or token in serialized):
                raise RuntimeError(f"`{' '.join(command)}` did not report redacted effective Marketplace sources")

    journey.step("update preserves Marketplace sources and status and doctor redact credentials", "marketplace",
                 assert_update_persists_and_reports_sources, cases=["S-268.6"],
                 requires=("step:Registry-owned namespace identities never resolve from npm",),
                 runners=("service-marketplace-registry:local", "service-marketplace-registry:secured"))

    def assert_tampered_mirror_refused() -> None:
        original_lock = lock_path.read_bytes()
        _set_marketplace_proxy_faults(project, env, runner, {package: "integrity"})
        try:
            _assert_catalogued_marketplace_failure(project, env, runner,
                                                   package, "KB_MARKETPLACE_INTEGRITY_MISMATCH")
            if lock_path.read_bytes() != original_lock:
                raise RuntimeError("tampered Registry mirror changed the Marketplace lock")
        finally:
            _set_marketplace_proxy_faults(project, env, runner, {})

    journey.step("tampered Registry mirror fails with the catalogue integrity error", "marketplace",
                 assert_tampered_mirror_refused, cases=["S-268.7"],
                 requires=("step:update preserves Marketplace sources and status and doctor redact credentials",),
                 runners=("service-marketplace-registry:local", "service-marketplace-registry:secured"))

    def assert_missing_provenance_refusal() -> None:
        original = lock_path.read_bytes()
        try:
            lock = json.loads(original)
            entry = lock.get("plugins", {}).get(package)
            if not isinstance(entry, dict):
                raise RuntimeError("Commit fixture lock entry disappeared before provenance mutation")
            for field in ("marketplaceSource", "integrity", "signatureStatus"):
                entry.pop(field, None)
            lock_path.write_text(json.dumps(lock, indent=2) + "\n")
            command = ["marketplace", "plugins", "doctor", "--scope", "project", "--json"]
            result = _run(kb_command(command), cwd=project, env=env, runner=runner)
            payload = read_ux_cli_result(result)
            failure = decode_ux_error_result(payload)
            code = "KB_MARKETPLACE_PROVENANCE_REQUIRED"
            expected_hint = catalogued_error_hint(code, package=package, scope="project")
            if (result.returncode == 0 or failure.get("code") != code
                    or failure.get("message") != catalogued_error_message(code)
                    or failure.get("hint") != expected_hint):
                raise RuntimeError("doctor did not render the catalogue provenance refusal and exact reinstall command")
        finally:
            lock_path.write_bytes(original)

    journey.step("doctor refuses a Marketplace lock without recorded provenance", "marketplace",
                 assert_missing_provenance_refusal, cases=["S-268.8"],
                 requires=("step:tampered Registry mirror fails with the catalogue integrity error",),
                 runners=("service-marketplace-registry:local", "service-marketplace-registry:secured"))


def _run_marketplace_lifecycle_steps(journey: Journey, project_root: str | Path, registry: str,
                          project_id: str,
                          env: dict[str, str] | None = None,
                          runner: CommandRunner = run_command,
                          http_opener: Callable[..., object] = urllib.request.urlopen,
                          commit_case_hook: Callable[[], None] | None = None,
                          fixture_entry: dict | None = None) -> None:
    """Execute S-010 and S-047 in the isolated installed platform."""
    project = Path(project_root).resolve()
    base_env = dict(os.environ if env is None else env)
    export_project_identity_to_child_environment(base_env, project_root=str(project))
    platform_root = Path(base_env.get("KB_JOURNEY_PLATFORM_ROOT", str(Path(base_env["HOME"]) / "kb-platform"))).resolve()
    def cli(args: list[str], cwd: Path = project) -> CompletedProcess[str]:
        preflight_installed_plugin_command(args, cwd, base_env, runner, Path("kb"))
        return _run(kb_command(args), cwd=cwd, env=base_env, runner=runner)

    commit_package = "@kb-labs/commit"
    unrelated_package = "@kb-labs/review"
    authenticate_secured_marketplace(journey, project, base_env, runner)

    def assert_shared_errors() -> None:
        platform_root = Path(base_env.get("KB_JOURNEY_PLATFORM_ROOT", str(Path(base_env["HOME"]) / "kb-platform"))).resolve()
        status_command = [base_env.get("KB_JOURNEY_KB_CREATE_PATH", "kb-create"),
                          "status", "--json", "--platform-root", str(platform_root)]
        status = _json(run_with_runner(runner, status_command, cwd=project, env=base_env, timeout=120), status_command)
        source_kinds = configured_marketplace_source_kinds(status)
        failures = (
            (["marketplace", "install", "journey-not-published"], "KB_PLUGIN_NOT_FOUND", "plugin", "journey-not-published"),
            (["adapter", "bind", "storage", "@kb-labs/adapters-not-installed"], "KB_ADAPTER_NOT_INSTALLED", "package", "@kb-labs/adapters-not-installed"),
        )
        for command, code, value_name, value in failures:
            message = catalogued_error_message(code).format_map({value_name: value})
            hint = catalogued_error_hint(code, **{value_name: value})
            for json_mode in (False, True):
                with_flags = [*command, *( ["--json"] if json_mode else [])]
                with invocation_context(step_id="S-051.2" if code == "KB_PLUGIN_NOT_FOUND" else "S-051.3"):
                    result = _run(kb_command([ *with_flags]), cwd=project, env=base_env, runner=runner)
                validate_shared_failure(result, json_mode=json_mode, code=code, message=message, hint=hint,
                                         marketplace_source_kinds=source_kinds if code == "KB_PLUGIN_NOT_FOUND" else ())
    journey.step("marketplace and adapter failures use the shared envelope", "marketplace",
                 assert_shared_errors, cases=["S-051.2", "S-051.3", "S-051.4"])
    with invocation_context(step_id="S-010.1"):
        wait_for_marketplace_ready(project, base_env, runner)
        run_plugin_policy_diagnostic_step(journey, project, registry, base_env, runner)
        # The malformed-policy diagnostic is an independent assertion. Its
        # result does not determine whether the marketplace can install the
        # Commit fixture that produces the project lock state.
        commit_version = (fixture_entry or {}).get("version")
        if not isinstance(commit_version, str) or not commit_version:
            raise RuntimeError("published Commit fixture has no version to pin in lifecycle checks")
        commit_install_package = (fixture_entry or {}).get("package")
        if not isinstance(commit_install_package, str) or not commit_install_package:
            raise RuntimeError("published Commit fixture has no package identity to pin in lifecycle checks")

    def install_npm_plugin_with_private_transitive_dependency() -> None:
        suffix = str(time.time_ns())
        plugin_id, dependency_id = _transitive_npm_fixture_ids(suffix)
        version = "1.0.0"
        marker = f"configured-npm-source-{suffix}"
        sdk_package = active_platform_root(platform_root) / "node_modules" / "@kb-labs" / "sdk" / "package.json"
        try:
            sdk_version = json.loads(sdk_package.read_text(encoding="utf-8")).get("version")
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError("S-010.8 cannot read the installed SDK version for its fixture plugin") from error
        if not isinstance(sdk_version, str) or not sdk_version:
            raise RuntimeError("S-010.8 fixture plugin requires the installed platform SDK version")

        fixture_root = Path(tempfile.mkdtemp(prefix="kb-marketplace-transitive-dependency-"))
        dependency_dir = fixture_root / "dependency"
        plugin_dir = fixture_root / "plugin"
        (dependency_dir / "dist").mkdir(parents=True)
        (plugin_dir / "dist" / "commands").mkdir(parents=True)
        try:
            (dependency_dir / "package.json").write_text(json.dumps({
                "name": dependency_id,
                "version": version,
                "type": "module",
                "main": "./index.js",
                "exports": {".": "./index.js"},
                "files": ["index.js"],
                "license": "UNLICENSED",
            }), encoding="utf-8")
            (dependency_dir / "index.js").write_text(
                f"export const marker = {json.dumps(marker)};\n", encoding="utf-8")
            manifest = {
                "schema": "kb.plugin/3",
                "id": plugin_id,
                "version": version,
                "display": {
                    "name": "Marketplace transitive dependency fixture",
                    "description": "Verifies a package dependency published only to the configured npm source.",
                },
                "permissions": {"platform": {}},
                "platform": {"requires": []},
                "cli": {
                    "groupMeta": [{"path": "journey", "describe": "Journey fixture commands"}],
                    "commands": [{
                        "path": "journey transitive show",
                        "describe": "Return a marker imported from the transitive fixture dependency",
                        "operationType": "execute",
                        "handler": "./commands/show.js#default",
                    }],
                },
            }
            (plugin_dir / "package.json").write_text(json.dumps({
                "name": plugin_id,
                "version": version,
                "type": "module",
                "main": "./dist/manifest.js",
                "exports": {".": "./dist/manifest.js"},
                "files": ["dist/manifest.js", "dist/manifest.json", "dist/commands/*.js"],
                "kb": {
                    "manifest": "./dist/manifest.js",
                    "requiredOutputs": ["./dist/manifest.json", "./dist/commands/show.js"],
                },
                **_transitive_npm_fixture_dependencies(dependency_id, sdk_version),
                "license": "UNLICENSED",
            }), encoding="utf-8")
            (plugin_dir / "dist" / "manifest.js").write_text(
                f"export const manifest = {json.dumps(manifest)};\n", encoding="utf-8")
            (plugin_dir / "dist" / "commands" / "show.js").write_text(
                "import { defineCommand } from '@kb-labs/sdk';\n"
                f"import {{ marker }} from {json.dumps(dependency_id)};\n"
                "export default defineCommand({ id: 'journey:transitive-show', description: 'Check dependency resolution', "
                "handler: { async execute() { return { ok: true, result: { marker } }; } } });\n",
                encoding="utf-8")

            workspace = Path(base_env.get("KB_JOURNEY_WORKSPACE_ROOT", Path(__file__).resolve().parents[2]))
            manifest_command = [
                "node", str(workspace / "infra" / "devkit" / "tsup" / "emit-manifest-json.mjs"),
                "--module", str(plugin_dir / "dist" / "manifest.js"),
                "--output", str(plugin_dir / "dist" / "manifest.json"),
            ]
            _output(_run(manifest_command, cwd=project, env=base_env, runner=runner), manifest_command)
            for package_dir in (dependency_dir, plugin_dir):
                _publish_npm_fixture_package(package_dir, registry, fixture_root,
                                             base_env, runner)

            install = ["marketplace", "install", f"{plugin_id}@{version}", "--scope", "project", "--json"]
            installed_result = _json(cli(install), install)
            installed = installed_result.get("installed")
            if (installed_result.get("scope") != "project" or not isinstance(installed, list)
                    or not any(isinstance(item, dict) and item.get("id") == plugin_id
                               and item.get("version") == version and item.get("source") == "npm"
                               for item in installed)):
                raise RuntimeError("S-010.8 Marketplace did not report the npm fixture plugin as installed")

            lock_path = project / ".kb" / "marketplace.lock"
            lock = json.loads(lock_path.read_text(encoding="utf-8"))
            entry = lock.get("plugins", {}).get(plugin_id) if isinstance(lock, dict) else None
            if (not isinstance(entry, dict) or entry.get("package") != plugin_id
                    or entry.get("version") != version or entry.get("marketplaceSource") != "npm"
                    or not entry.get("integrity")):
                raise RuntimeError("S-010.8 install did not record the plugin's npm source and integrity in the project lock")

            listed = ["marketplace", "plugins", "list", "--scope", "project", "--json"]
            entries = _entries(_json(cli(listed), listed))
            if not any(item.get("id") == plugin_id and item.get("version") == version for item in entries):
                raise RuntimeError("S-010.8 fixture plugin was not discoverable in the project plugin list")

            show = ["journey", "transitive", "show", "--json"]
            output = _json(cli(show), show)
            if marker not in json.dumps(output, sort_keys=True):
                raise RuntimeError("S-010.8 fixture command did not load its dependency from the configured npm source")
        finally:
            try:
                lock = json.loads((project / ".kb" / "marketplace.lock").read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                lock = {}
            plugins = lock.get("plugins", {}) if isinstance(lock, dict) else {}
            if isinstance(plugins, dict) and plugin_id in plugins:
                uninstall = ["marketplace", "uninstall", plugin_id, "--scope", "project", "--json"]
                _output(_run(kb_command(uninstall), cwd=project, env=base_env, runner=runner), uninstall)
            shutil.rmtree(fixture_root, ignore_errors=True)

    register_transitive_npm_dependency_step(
        journey, install_npm_plugin_with_private_transitive_dependency)

    # S-047 requires a second project plugin to survive target uninstall.
    unrelated_version = _registry_version(unrelated_package, registry, project, base_env, runner)
    install_unrelated = ["marketplace", "install", f"{unrelated_package}@{unrelated_version}", "--json"]
    sealed_platform_before_unrelated = _platform_snapshot(platform_root)
    unrelated_install = _json(cli(install_unrelated), install_unrelated)
    unrelated_installed = unrelated_install.get("installed")
    if not isinstance(unrelated_installed, list) or len(unrelated_installed) != 1:
        raise RuntimeError("npm-installed unrelated fixture did not return one installed plugin identity")
    unrelated_plugin_id = unrelated_installed[0].get("id")
    if not isinstance(unrelated_plugin_id, str) or not unrelated_plugin_id:
        raise RuntimeError("npm-installed unrelated fixture did not return its canonical plugin ID")
    if (unrelated_installed[0].get("version") != unrelated_version
            or unrelated_installed[0].get("source") != "npm"):
        raise RuntimeError("npm-installed unrelated fixture did not preserve its selected npm version")
    unrelated_entry = json.loads((project / ".kb" / "marketplace.lock").read_text()).get("plugins", {}).get(unrelated_plugin_id)
    locked_unrelated_version = unrelated_entry.get("version") if isinstance(unrelated_entry, dict) else None
    if locked_unrelated_version != unrelated_version:
        raise RuntimeError("npm-installed unrelated fixture did not produce its selected version in the lock")
    if _platform_snapshot(platform_root) != sealed_platform_before_unrelated:
        raise RuntimeError("marketplace install changed the platform receipt or installed package versions")

    lock_file = project / ".kb" / "marketplace.lock"
    before = json.loads(lock_file.read_text()) if lock_file.exists() else {"plugins": {}}
    if commit_package not in before.get("plugins", {}):
        raise RuntimeError(f"{commit_package} fixture is missing before the marketplace lifecycle")
    commit_install_spec = f"{commit_install_package}@{commit_version}"
    install_commit = ["marketplace", "install", commit_install_spec, "--json"]
    install_commit_platform = ["marketplace", "install", commit_install_spec,
                              "--scope", "platform", "--json"]
    sealed_platform_before = _platform_snapshot(platform_root)
    def install_exact_commit() -> None:
        project_result = _json(cli(install_commit), install_commit)
        project_installed = project_result.get("installed")
        if (project_result.get("scope") != "project" or not isinstance(project_installed, list)
                or not any(isinstance(item, dict) and item.get("id") == commit_package
                           and item.get("version") == commit_version and item.get("source") == "npm"
                           for item in project_installed)):
            raise RuntimeError(f"project marketplace install did not return the selected plugin version as JSON: {project_result!r}; expected {commit_package}@{commit_version}")
        platform_result = _json(cli(install_commit_platform), install_commit_platform)
        platform_installed = platform_result.get("installed")
        if (platform_result.get("scope") != "platform" or not isinstance(platform_installed, list)
                or not any(isinstance(item, dict) and item.get("id") == commit_package
                           and item.get("version") == commit_version and item.get("source") == "npm"
                           for item in platform_installed)):
            raise RuntimeError("platform marketplace install did not return the selected plugin version as JSON")
        project_lock = json.loads(lock_file.read_text())
        project_entry = project_lock.get("plugins", {}).get(commit_package)
        if (project_lock.get("schema") != "kb.marketplace/3" or not isinstance(project_entry, dict)
                or project_entry.get("version") != commit_version
                or project_entry.get("package") != "@kb-labs/commit"
                or not project_entry.get("integrity")):
            raise RuntimeError("project marketplace install did not record the portable exact plugin identity")
        platform_lock_file = active_platform_root(platform_root) / ".kb" / "marketplace.lock"
        try:
            platform_lock = json.loads(platform_lock_file.read_text())
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError("platform marketplace install did not write a readable lock") from error
        platform_entry = platform_lock.get("plugins", {}).get(commit_package)
        if (platform_lock.get("schema") != "kb.marketplace/3" or not isinstance(platform_entry, dict)
                or platform_entry.get("version") != commit_version
                or platform_entry.get("package") != "@kb-labs/commit"
                or not platform_entry.get("integrity")
                or platform_entry.get("source") != "marketplace"):
            raise RuntimeError("platform marketplace install did not record the portable exact plugin identity")
        if _platform_snapshot(platform_root) != sealed_platform_before:
            raise RuntimeError("marketplace install changed the platform receipt or installed package versions")
    def prepare_clean_scopes_for_s010() -> None:
        for scope in ("platform", "project"):
            command = ["marketplace", "uninstall", commit_package, "--scope", scope, "--json"]
            _output(cli(command), command)
        platform_lock = json.loads((active_platform_root(platform_root) / ".kb" / "marketplace.lock").read_text())
        if commit_package in platform_lock.get("plugins", {}):
            raise RuntimeError("S-192 requires Commit to be absent from the platform marketplace lock")
        if commit_package in json.loads(lock_file.read_text()).get("plugins", {}):
            raise RuntimeError("S-192 project setup did not remove the prior Commit pin")

    journey.step("prepare clean scopes for the S-010 install", "marketplace",
                 prepare_clean_scopes_for_s010, role="lifecycle")
    journey.step("install exact marketplace plugin into both scopes", "marketplace",
                 install_exact_commit, cases=["S-010.1"],
                 requires=("step:prepare clean scopes for the S-010 install",))

    gateway = base_env.get("KB_JOURNEY_BASE_URL", "http://127.0.0.1:4000").rstrip("/")

    def assert_unknown_service_does_not_start_runtime() -> None:
        if not project_id:
            raise RuntimeError("S-192 requires the registered project identity from project-registered state")
        headers = {"Authorization": f"Bearer {base_env.get('KB_JOURNEY_SERVICE_TOKEN', '')}"}
        unknown_url = f"{gateway}{project_service_path(project_id, 'unknown-service', 'health')}"
        status, raw, _ = open_http(http_opener, urllib.request.Request(unknown_url, headers=headers), timeout=30, env=base_env)
        unknown = read_ux_http_result(raw, status)
        if status != 404 or unknown.get("error", {}).get("code") != "KB_PROJECT_SERVICE_NOT_FOUND":
            raise RuntimeError("unknown project service did not return catalogued KB_PROJECT_SERVICE_NOT_FOUND")
        health_status, health_raw, _ = open_http(
            http_opener, urllib.request.Request(f"{gateway}/health", headers=headers), timeout=30, env=base_env,
        )
        health = read_ux_http_result(health_raw, health_status)
        runtimes = health.get("data", {}).get("projectRuntimes", {}).get("runtimes", [])
        if health_status != 200 or any(
            isinstance(runtime, dict) and runtime.get("projectId") == project_id for runtime in runtimes
        ):
            raise RuntimeError("unknown project service acquired a project runtime")

    journey.step("reject an unknown project service without starting its runtime", "marketplace",
                 assert_unknown_service_does_not_start_runtime, cases=["S-192.1"])

    def verify_s192_project_only_precondition() -> None:
        for scope in ("platform", "project"):
            command = ["marketplace", "uninstall", commit_package, "--scope", scope, "--json"]
            _output(cli(command), command)
        platform_lock = json.loads((active_platform_root(platform_root) / ".kb" / "marketplace.lock").read_text())
        project_lock = json.loads(lock_file.read_text())
        if commit_package in platform_lock.get("plugins", {}):
            raise RuntimeError("S-192 requires Commit to be absent from the platform marketplace lock")
        if commit_package in project_lock.get("plugins", {}):
            raise RuntimeError("S-192 requires Commit to be absent from the project marketplace lock before install")
        if not project_id:
            raise RuntimeError("S-192 requires the registered project identity from project-registered state")
        request = urllib.request.Request(
            f"{gateway}{project_service_path(project_id, 'rest', 'plugins/commit/status')}",
            headers={"Authorization": f"Bearer {base_env.get('KB_JOURNEY_SERVICE_TOKEN', '')}"},
        )
        status, raw, _ = open_http(http_opener, request, timeout=30, env=base_env)
        try:
            payload = read_ux_http_result(raw, status)
        except json.JSONDecodeError as error:
            raise RuntimeError("S-192 pre-install Commit route did not return a JSON gateway envelope") from error
        validate_unmounted_commit_response(status, payload)

    journey.step("verify S-192 platform and project pins and route are absent before install", "marketplace",
                 verify_s192_project_only_precondition, cases=["S-192.7"],
                 requires=("step:install exact marketplace plugin into both scopes",))

    def install_commit_for_project_lifecycle() -> None:
        result = _json(cli(install_commit), install_commit)
        installed = result.get("installed")
        if (result.get("scope") != "project" or not isinstance(installed, list)
                or not any(isinstance(item, dict) and item.get("id") == commit_package
                           and item.get("version") == commit_version for item in installed)):
            raise RuntimeError("project marketplace install did not return the selected plugin version as JSON")

    journey.step("install Commit into the project for the route lifecycle", "marketplace",
                 install_commit_for_project_lifecycle, cases=["S-192.2"],
                 requires=("step:verify S-192 platform and project pins and route are absent before install",))

    try:
        if commit_case_hook is None:
            run_commit_case_steps(journey, project, Path("kb"), registry, runner, base_env)
        else:
            commit_case_hook()
    except Exception as error:
        journey.step("prepare Commit case fixture state", "marketplace", lambda: str(error))

    route = f"{gateway}{project_service_path(project_id, 'rest', 'plugins/commit/status')}"

    def assert_commit_status_route() -> None:
        if not project_id:
            raise RuntimeError("S-192 requires the registered project identity from project-registered state")
        headers = {"Authorization": f"Bearer {base_env.get('KB_JOURNEY_SERVICE_TOKEN', '')}"}
        request = urllib.request.Request(route, headers=headers)
        status, raw, _ = open_http(http_opener, request, timeout=30, env=base_env)
        try:
            payload = read_ux_http_result(raw, status)
        except json.JSONDecodeError as error:
            raise RuntimeError("Commit status route did not return JSON") from error
        validate_commit_status_response(status, payload)

    journey.step("GET the installed project Commit status route", "marketplace",
                 assert_commit_status_route, cases=["S-192.3"],
                 requires=("step:install Commit into the project for the route lifecycle",))

    listed = ["marketplace", "plugins", "list", "--json"]
    def assert_marketplace_list() -> None:
        payload = _json(cli(listed), listed)
        entry = next((item for item in _entries(payload) if item.get("id") == commit_package), None)
        if not entry or entry.get("version") != commit_version or entry.get("enabled") is not True:
            raise RuntimeError(f"plugin list omitted the enabled exact pin {commit_package}@{commit_version}")
    journey.step("list installed project plugins", "marketplace", assert_marketplace_list, cases=["S-010.2"],
                 requires=("step:install Commit into the project for the route lifecycle",))

    def assert_commit_lock() -> None:
        lock = json.loads(lock_file.read_text())
        if _commit_project_fixture_entry(lock, commit_version) is None:
            raise RuntimeError("project lock entry does not preserve package, exact version, integrity, source and enabled state")
    journey.step("inspect exact v3 marketplace lock entry", "marketplace", assert_commit_lock, cases=["S-010.3"],
                 requires=("step:install Commit into the project for the route lifecycle",))

    commit_open = ["commit", "plan", "show", "--json"]
    def assert_commit_command() -> None:
        payload = _json(cli(commit_open), commit_open)
        if payload.get("hasPlan") is not False:
            raise RuntimeError(f"`kb commit plan show --json` did not return its documented empty-plan result: {payload!r}")
    journey.step("load installed Commit handler with platform SDK and invoke its documented command", "marketplace", assert_commit_command,
                 cases=["S-010.4"], requires=("step:install Commit into the project for the route lifecycle",))

    gateway_doctor = ["marketplace", "plugins", "doctor", "--scope", "project", "--json"]
    def assert_cli_plugin_gateway() -> None:
        payload = _json(cli(gateway_doctor), gateway_doctor)
    journey.step("invoke gateway-backed plugin command through installed CLI", "marketplace",
                 assert_cli_plugin_gateway, cases=["S-010.7"],
                 requires=("step:install Commit into the project for the route lifecycle",))

    def assert_stopped_host_error() -> None:
        stop_command = ["kb-create", "stop", "--platform-root", str(platform_root), "--json"]
        stop = _run(stop_command, cwd=platform_root, env=base_env, runner=runner)
        _output(stop, stop_command)
        command = kb_command([ "marketplace", "plugins", "doctor", "--scope", "project", "--json"])
        try:
            with invocation_context(step_id="S-203.14"):
                result = _run(command, cwd=project, env=base_env, runner=runner)
            try:
                payload = read_ux_cli_result(result)
            except ValueError as error:
                raise RuntimeError("gateway-backed plugin command did not return a JSON error envelope") from error
            failure = decode_ux_error_result(payload)
            if (result.returncode != 1 or not isinstance(failure, dict)
                    or failure.get("code") != "KB_HOST_UNREACHABLE"
                    or failure.get("hint") != 'Run "kb-create start", or "kb-create doctor" if the host should already be running.'):
                raise RuntimeError(f"stopped host returned an unexpected gateway error: {payload!r}")
        finally:
            start_command = ["kb-create", "start", "--platform-root", str(platform_root), "--json"]
            start = _run(start_command, cwd=platform_root, env=base_env, runner=runner)
            _output(start, start_command)

    journey.step("report catalogued error when the installed host is stopped", "marketplace",
                 assert_stopped_host_error, cases=["S-203.14"])

    def assert_default_gateway_config() -> None:
        config_path = active_platform_root(platform_root) / ".kb" / "kb.config.jsonc"
        config = json.loads(config_path.read_text())
        gateway = config.get("gateway")
        if not isinstance(gateway, dict) or "port" in gateway:
            raise RuntimeError("fresh platform fixture must leave gateway.port at its service default")
        command = kb_command([ "marketplace", "plugins", "doctor", "--scope", "project", "--json"])
        with invocation_context(step_id="S-203.15"):
            result = _run(command, cwd=project, env=base_env, runner=runner)
        payload = _json(result, command)

    journey.step("resolve the default gateway address for CLI plugins", "marketplace",
                 assert_default_gateway_config, cases=["S-203.15"])

    def assert_invalid_gateway_port_error() -> None:
        invalid_env = {**base_env, "GATEWAY_PORT": "not-a-port"}
        command = kb_command([ "marketplace", "plugins", "doctor", "--scope", "project", "--json"])
        with invocation_context(step_id="S-203.16"):
            result = _run(command, cwd=project, env=invalid_env, runner=runner)
        try:
            payload = read_ux_cli_result(result)
        except ValueError as error:
            raise RuntimeError("invalid gateway port did not return a JSON config error") from error
        failure = decode_ux_error_result(payload)
        if (result.returncode != 1 or not isinstance(failure, dict)
                or failure.get("code") != "KB_CONFIG_INVALID"
                or "GATEWAY_PORT" not in failure.get("message", "")
                or "integer from 1 through 65535" not in failure.get("message", "")
                or failure.get("hint") != 'Run "unset GATEWAY_PORT", then retry the command to use the service default port.'):
            raise RuntimeError(f"invalid gateway port returned an unexpected config error: {payload!r}")

    journey.step("report a catalogued config error for an invalid gateway port", "marketplace",
                 assert_invalid_gateway_port_error, cases=["S-203.16"])

    def assert_reinstall_idempotent() -> None:
        _output(cli(install_commit), install_commit)
        lock = json.loads(lock_file.read_text())
        if sum(1 for package_id in lock.get("plugins", {}) if package_id == commit_package) != 1:
            raise RuntimeError("reinstall created a duplicate project marketplace lock entry")
        entry = lock["plugins"][commit_package]
        if entry.get("version") != commit_version:
            raise RuntimeError("reinstall changed the requested exact plugin version")
    journey.step("repeat exact install without duplicate pin", "marketplace", assert_reinstall_idempotent,
                 cases=["S-010.5"], requires=("step:install Commit into the project for the route lifecycle",))

    def set_plugin_enabled(command: list[str], action: str, enabled: bool, step_id: str) -> None:
        with invocation_context(step_id=step_id):
            result = cli(command)
        expected = f"{action} @kb-labs/commit (project)"
        output = " ".join(f"{result.stdout or ''} {result.stderr or ''}".split())
        if result.returncode != 0 or expected not in output:
            raise RuntimeError(f"{command!r} did not report {expected!r}: {output!r}")
        entry = json.loads(lock_file.read_text()).get("plugins", {}).get(commit_package)
        if not isinstance(entry, dict) or entry.get("enabled") is not enabled:
            raise RuntimeError(f"{commit_package} was not {'enabled' if enabled else 'disabled'} in the project lock")

    def assert_disabled() -> None:
        set_plugin_enabled(["marketplace", "plugins", "disable", "@kb-labs/commit"],
                           "Disabled", False, "S-011.1")
    journey.step("disable installed Commit plugin", "marketplace", assert_disabled, cases=["S-011.1"],
                 requires=("step:install Commit into the project for the route lifecycle",))

    def assert_disabled_list() -> None:
        command = ["marketplace", "plugins", "list"]
        with invocation_context(step_id="S-011.2"):
            result = cli(command)
        output = " ".join(f"{result.stdout or ''} {result.stderr or ''}".split())
        if result.returncode != 0 or "disabled" not in output.lower() or "⏸" not in output:
            raise RuntimeError(f"marketplace list did not show the disabled count and row marker: {output!r}")
    journey.step("confirm disabled Commit appears in list", "marketplace", assert_disabled_list, cases=["S-011.2"],
                 requires=("step:disable installed Commit plugin",))

    def assert_command_hidden() -> None:
        command = ["commit", "--help"]
        with invocation_context(step_id="S-011.3"):
            result = cli(command)
        if result.returncode == 0:
            raise RuntimeError("Commit commands remain discoverable while the plugin is disabled")
    journey.step("confirm disabled Commit commands are unavailable", "marketplace", assert_command_hidden,
                 cases=["S-011.3"], requires=("step:disable installed Commit plugin",))

    def assert_enabled() -> None:
        set_plugin_enabled(["marketplace", "plugins", "enable", "@kb-labs/commit"],
                           "Enabled", True, "S-011.4")
    journey.step("enable installed Commit plugin", "marketplace", assert_enabled, cases=["S-011.4"],
                 requires=("step:disable installed Commit plugin",))

    def assert_enabled_list_and_command() -> None:
        list_command = ["marketplace", "plugins", "list"]
        with invocation_context(step_id="S-011.5"):
            list_result = cli(list_command)
        output = " ".join(f"{list_result.stdout or ''} {list_result.stderr or ''}".split())
        if (list_result.returncode != 0 or "enabled" not in output.lower()
                or "✅" not in output or "commit" not in output.lower()):
            raise RuntimeError(f"marketplace list did not show enabled Commit: {output!r}")
        command = ["commit", "--help"]
        with invocation_context(step_id="S-011.5"):
            help_result = cli(command)
        if help_result.returncode != 0:
            raise RuntimeError("Commit commands remain unavailable after enabling the plugin")
    journey.step("confirm enabled Commit appears and commands are available", "marketplace",
                 assert_enabled_list_and_command, cases=["S-011.5"],
                 requires=("step:enable installed Commit plugin",))

    def assert_missing_disable_preserves_lock() -> None:
        before_lock = lock_file.read_bytes()
        command = ["marketplace", "plugins", "disable", "@kb-labs/not-installed"]
        with invocation_context(step_id="S-011.6"):
            result = cli(command)
        output = " ".join(f"{result.stdout or ''} {result.stderr or ''}".split()).lower()
        if result.returncode == 0 or not any(text in output for text in ("not found", "cannot be found", "not installed")):
            raise RuntimeError(f"disabling an uninstalled package did not report that it is unavailable: {output!r}")
        if lock_file.read_bytes() != before_lock:
            raise RuntimeError("disabling an uninstalled package changed the marketplace lock")
    journey.step("reject disabling an uninstalled plugin without changing the lock", "marketplace",
                 assert_missing_disable_preserves_lock, cases=["S-011.6"],
                 requires=("step:install Commit into the project for the route lifecycle",))

    update_fixture: dict[str, str] = {}

    def publish_update_fixture() -> None:
        workspace = Path(base_env.get("KB_JOURNEY_WORKSPACE_ROOT", Path(__file__).resolve().parents[2]))
        update_fixture["version"] = publish_commit_update_fixture(
            registry, commit_fixture_source_version(workspace), base_env, runner)
    journey.step("publish next-major Commit update fixture", "marketplace-fixtures", publish_update_fixture,
                 requires=("step:install Commit into the project for the route lifecycle",))

    def update_commit() -> None:
        command = ["marketplace", "update", "@kb-labs/commit", "--scope", "project", "--json"]
        with invocation_context(step_id="S-012.1"):
            result = cli(command)
        payload = _json(result, command)
        if (result.returncode != 0 or payload.get("scope") != "project"
                or not isinstance(payload.get("installed"), list)
                or not isinstance(payload.get("warnings"), list)):
            raise RuntimeError("marketplace update did not report a successful result")
        if not any(isinstance(item, dict) and item.get("id") == commit_package
                   and item.get("version") == update_fixture["version"]
                   for item in payload["installed"]):
            raise RuntimeError(f"marketplace update did not report Commit {update_fixture['version']}")
    journey.step("update installed Commit version", "marketplace", update_commit, cases=["S-012.1"],
                 requires=("step:publish next-major Commit update fixture",))

    def assert_updated_pin() -> None:
        command = ["marketplace", "plugins", "list", "--scope", "project", "--json"]
        with invocation_context(step_id="S-012.2"):
            payload = _json(cli(command), command)
        entry = next((item for item in _entries(payload) if item.get("id") == commit_package), None)
        lock_entry = json.loads(lock_file.read_text()).get("plugins", {}).get(commit_package)
        if (not isinstance(entry, dict) or not isinstance(lock_entry, dict)
                or entry.get("version") != lock_entry.get("version") or not lock_entry.get("integrity")):
            raise RuntimeError("plugin list and marketplace lock do not show the same exact version and integrity")
    journey.step("verify updated Commit pin in list and lock", "marketplace", assert_updated_pin,
                 cases=["S-012.2"], requires=("step:update installed Commit version",))

    def assert_updated_command() -> None:
        command = ["commit", "--help"]
        with invocation_context(step_id="S-012.3"):
            result = cli(command)
        if result.returncode != 0:
            raise RuntimeError("Commit command group is unavailable after update")
    journey.step("confirm Commit commands remain available after update", "marketplace",
                 assert_updated_command, cases=["S-012.3"],
                 requires=("step:update installed Commit version",))

    def assert_unknown_update_preserves_pin() -> None:
        before = json.loads(lock_file.read_text()).get("plugins", {}).get(commit_package)
        command = ["marketplace", "update", "@kb-labs/not-published", "--scope", "project", "--json"]
        with invocation_context(step_id="S-012.4"):
            result = cli(command)
        payload = _json(result, command)
        after = json.loads(lock_file.read_text()).get("plugins", {}).get(commit_package)
        warnings = payload.get("warnings")
        if (result.returncode != 0 or not isinstance(warnings, list)
                or not any("@kb-labs/not-published" in str(warning) for warning in warnings)
                or before != after):
            raise RuntimeError("unknown package update did not warn while preserving the Commit pin")
    journey.step("reject unknown package update and preserve Commit pin", "marketplace",
                 assert_unknown_update_preserves_pin, cases=["S-012.4"],
                 requires=("step:install Commit into the project for the route lifecycle",))

    uninstall_commit = ["marketplace", "uninstall", commit_package, "--json"]
    def uninstall_target() -> None:
        with invocation_context(step_id="S-192.4"):
            _output(cli(uninstall_commit), uninstall_commit)
            platform_lock = json.loads((active_platform_root(platform_root) / ".kb" / "marketplace.lock").read_text())
            if commit_package in platform_lock.get("plugins", {}):
                raise RuntimeError("project uninstall changed the S-192 platform prerequisite: Commit is pinned there")
            if not project_id:
                raise RuntimeError("S-192 requires the registered project identity from project-registered state")
            request = urllib.request.Request(route, headers={
                "Authorization": f"Bearer {base_env.get('KB_JOURNEY_SERVICE_TOKEN', '')}"})
            status, raw, _ = open_http(http_opener, request, timeout=30, env=base_env)
        try:
            payload = read_ux_http_result(raw, status)
        except json.JSONDecodeError as error:
            raise RuntimeError("unmounted Commit status route did not return a JSON gateway envelope") from error
        validate_unmounted_commit_response(status, payload)
    journey.step("uninstall target project plugin", "marketplace",
                 uninstall_target,
                 cases=["S-047.1", "S-192.4"],
                 requires=("step:GET the installed project Commit status route",))

    def assert_unrelated_remains() -> None:
        payload = _json(cli(listed), listed)
        entries = _entries(payload)
        if any(item.get("id") == commit_package for item in entries):
            raise RuntimeError(f"uninstalled target {commit_package} remains in the project plugin list")
        unrelated = next((item for item in entries if item.get("id") == unrelated_plugin_id), None)
        if not unrelated or unrelated.get("version") != unrelated_version or unrelated.get("enabled") is not True:
            raise RuntimeError(f"unrelated project plugin did not remain installed and enabled: {unrelated!r}")
    journey.step("list confirms target absent and unrelated plugin remains", "marketplace", assert_unrelated_remains,
                 cases=["S-047.2"], requires=("step:uninstall target project plugin",))

    def assert_lock_and_unrelated_plugin() -> None:
        lock = json.loads(lock_file.read_text())
        if commit_package in lock.get("plugins", {}):
            raise RuntimeError("project lock still pins the uninstalled target plugin")
        command = ["commit", "plan", "show", "--json"]
        with invocation_context(step_id="S-047.3"):
            unavailable = cli(command)
        failure = decode_ux_error_result(read_ux_cli_result(unavailable))
        if (unavailable.returncode != 2 or failure.get("code") != "KB_RUNTIME_UNKNOWN_COMMAND"
                or "commit plan show" not in failure.get("message", "")):
            raise RuntimeError(f"removed command did not return its typed unknown-command error: {failure!r}")
        command = ["review", "--help"]
        result = cli(command)
        if result.returncode != 0:
            raise RuntimeError("unrelated Review plugin command did not run successfully")
    journey.step("verify lock removal and invoke unrelated project plugin", "marketplace", assert_lock_and_unrelated_plugin,
             cases=["S-047.3"], requires=("step:uninstall target project plugin",))

    def reinstall_commit_and_assert_route() -> None:
        reinstall = ["marketplace", "install", commit_install_spec, "--json"]
        installed = _json(cli(reinstall), reinstall)
        entries = installed.get("installed")
        if not isinstance(entries, list) or not any(
            isinstance(item, dict) and item.get("id") == commit_package
            and item.get("version") == commit_version for item in entries
        ):
            raise RuntimeError("S-192 reinstall did not restore the selected Commit version")
        if not project_id:
                raise RuntimeError("S-192 requires the registered project identity from project-registered state")
        request = urllib.request.Request(route, headers={
            "Authorization": f"Bearer {base_env.get('KB_JOURNEY_SERVICE_TOKEN', '')}"})
        status, raw, _ = open_http(http_opener, request, timeout=30, env=base_env)
        try:
            payload = read_ux_http_result(raw, status)
        except json.JSONDecodeError as error:
            raise RuntimeError("reinstalled Commit status route did not return JSON") from error
        validate_commit_status_response(status, payload)
    journey.step("reinstall Commit and call its project REST route", "marketplace",
                 reinstall_commit_and_assert_route, cases=["S-192.5"],
                 requires=("step:uninstall target project plugin",))

    def reject_rest_internal_mount_prefix() -> None:
        legacy_url = f"{gateway}{project_service_path(project_id, 'rest', 'api/v1/plugins/commit/status')}"
        request = urllib.request.Request(legacy_url, headers={
            "Authorization": f"Bearer {base_env.get('KB_JOURNEY_SERVICE_TOKEN', '')}"})
        status, raw, _ = open_http(http_opener, request, timeout=30, env=base_env)
        payload = read_ux_http_result(raw, status)
        if status != 404 or payload.get("error", {}).get("code") != "KB_RUNTIME_RESOURCE_NOT_FOUND":
            raise RuntimeError("REST's internal /api/v1 mount prefix remained publicly reachable")

    journey.step("reject REST's internal API mount in public URLs", "marketplace",
                 reject_rest_internal_mount_prefix, cases=["S-192.6"],
                 requires=("step:reinstall Commit and call its project REST route",))


def register_transitive_npm_dependency_step(
    journey: Journey,
    check: Callable[[], str | None],
):
    """Register S-010.8 on the service journeys that execute Marketplace lifecycle flows."""
    return journey.step(
        "install npm plugin with dependency from configured npm source",
        "marketplace",
        check,
        cases=["S-010.8"],
        runners=("service-local:explore", "service-secured:explore"),
    )


def run_marketplace_steps(journey: Journey, project_root: str | Path, project_id: str, registry: str,
                          env: dict[str, str] | None = None,
                          runner: CommandRunner = run_command,
                          http_opener: Callable[..., object] = urllib.request.urlopen,
                          commit_case_hook: Callable[[], None] | None = None,
                          *, fixture_entry: dict | None = None) -> None:
    """Run marketplace assertions and preserve the independent project fixture."""
    project = Path(project_root).resolve()
    base_env = dict(os.environ if env is None else env)
    export_project_identity_to_child_environment(base_env, project_root=str(project))

    def restore_fixture() -> None:
        if not isinstance(fixture_entry, dict):
            raise RuntimeError("marketplace lifecycle has no captured Commit fixture lock entry to restore")
        version = fixture_entry.get("version")
        if not isinstance(version, str) or not version:
            raise RuntimeError("captured Commit fixture lock entry has no exact version")
        package = fixture_entry.get("package")
        if not isinstance(package, str) or not package:
            raise RuntimeError("captured Commit fixture lock entry has no package name")
        lock_file = project / ".kb" / "marketplace.lock"
        try:
            lock = json.loads(lock_file.read_text())
        except (OSError, json.JSONDecodeError):
            lock = {}
        entry = lock.get("plugins", {}).get("@kb-labs/commit") if isinstance(lock, dict) else None
        if entry == fixture_entry:
            return
        if isinstance(entry, dict):
            uninstall = kb_command([ "marketplace", "uninstall", "@kb-labs/commit", "--json"])
            _output(_run(uninstall, cwd=project, env=base_env, runner=runner), uninstall)
        install = kb_command(["marketplace", "install", f"{package}@{version}", "--json"])
        _output(_run(install, cwd=project, env=base_env, runner=runner), install)
        lock = json.loads(lock_file.read_text())
        entry = lock.get("plugins", {}).get("@kb-labs/commit")
        if entry != fixture_entry:
            raise RuntimeError("marketplace lifecycle cleanup did not restore the complete captured Commit fixture lock entry")

    try:
        _run_marketplace_lifecycle_steps(journey, project, registry, project_id, base_env, runner,
                                         http_opener, commit_case_hook, fixture_entry)
    finally:
        journey.step("restore Commit project fixture after marketplace lifecycle", "marketplace-fixtures",
                     restore_fixture, role="lifecycle")
