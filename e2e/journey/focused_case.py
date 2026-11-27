"""Run S-010.8 with an already installed, disposable local candidate."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import tempfile
import time
from urllib.parse import urlsplit
from urllib.request import build_opener, ProxyHandler

from invocations import invocation_context
from journey_resources import active_platform_root
from journey_selection import read_journey_selection
from marketplace_steps import marketplace_platform_config_path, run_transitive_npm_dependency_fixture
from redaction import redact_text
from service_steps import Journey


def local_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1"} or parsed.username:
        raise ValueError("the focused case requires a loopback Gateway and npm fixture registry")
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, required=True,
                        help="disposable root with home/, platform/ and project/")
    parser.add_argument("--index", type=Path, required=True, help="release index of the expected installed candidate")
    args = parser.parse_args(argv)
    started = time.monotonic()
    report = {"status": "BLOCKED", "evidence": "local-diagnostic"}
    try:
        fixture = args.fixture.resolve()
        platform, home, project = (fixture / name for name in ("platform", "home", "project"))
        for directory in (platform, home, project):
            if directory.is_symlink() or not directory.is_dir():
                raise ValueError(f"{directory} must be a directory in the isolated fixture")
        expected = json.loads(args.index.read_text(encoding="utf-8"))["digest"]
        active = active_platform_root(platform).resolve()
        if not active.is_relative_to(platform):
            raise ValueError("the active install points outside the isolated fixture")
        receipt = json.loads((active / ".kb/v2/receipt.json").read_text(encoding="utf-8"))
        digest = receipt["plan"]["releaseDigest"]
        report["releaseDigest"] = digest
        if not expected or digest != expected:
            raise ValueError(f"installed candidate digest is {digest}, expected {expected}")
        config = json.loads(marketplace_platform_config_path(platform).read_text(encoding="utf-8"))
        sources = config["marketplace"]["sources"]
        if config["gateway"]["access"]["mode"] != "local" or len(sources) != 1 or sources[0]["kind"] != "npm":
            raise ValueError("the fixture must run in local mode with one isolated npm source")
        registry = local_url(sources[0]["url"])
        health_url = local_url(receipt["verification"]["hostHealthUrl"])
        opener = build_opener(ProxyHandler({})).open
        for url in (health_url, registry.rstrip("/") + "/-/ping"):
            with opener(url, timeout=3):
                pass

        bin_dir = active / ".kb/v2/bin"
        if not os.access(bin_dir / "kb", os.X_OK):
            raise ValueError("the candidate does not contain its installed kb launcher")
        env = {
            "HOME": str(home),
            "PATH": os.pathsep.join((str(bin_dir), os.environ.get("PATH", os.defpath))),
            "KB_JOURNEY_PLATFORM_ROOT": str(platform),
        }
        selection = read_journey_selection({"KB_JOURNEY_RUNNER_SELECTOR": "service-local:explore"})
        journey = Journey("local", selection=selection)
        evidence = Path(tempfile.mkdtemp(prefix="focused-", dir=fixture))
        report["invocations"] = str(evidence)

        def bounded_http(request, *, timeout):
            remaining = started + 115 - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("focused case exhausted its two-minute budget")
            return opener(request, timeout=min(timeout, remaining))

        with invocation_context(report_root=evidence, command_deadline=started + 115):
            run_transitive_npm_dependency_fixture(
                journey, project, platform, registry, env, http_opener=bounded_http, marketplace_ready=True,
            )
        step, = journey.steps
        report.update(case=step.cases[0], status=step.status, message=step.message, assertSeconds=step.duration_seconds)
    except (OSError, ValueError, KeyError) as error:
        report["message"] = str(error)

    report["seconds"] = round(time.monotonic() - started, 3)
    print(json.dumps({**report, "message": redact_text(report["message"])}))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
