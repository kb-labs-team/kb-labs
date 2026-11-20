"""Run-owned secured Gateway fixture for central Registry author journeys."""
from __future__ import annotations

import json
import os
import secrets
import shutil
import socket
import tempfile
import time
from urllib.parse import urlencode
import urllib.error
import urllib.request
from urllib.request import urlopen as http_opener
from pathlib import Path
from typing import Callable

from invocations import CompletedProcess, open_http, run_command, run_with_runner
import redaction


def _json_yaml(value: object) -> str:
    return json.dumps(value, separators=(",", ":"))


def _loopback_port_available(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            return False
        return True


def _fixture_config(*, port: int, gateway_entry: Path, proxy_url: str,
                    internal_secret: str, password: str, jwt_secret: str) -> tuple[dict, str]:
    gateway = {
        "access": {"mode": "secured"},
        "port": port,
        "auth": {
            "bootstrap": {"adminEmail": "hub-author@journey.example", "tenantId": "journey-hub-author"},
            "bcryptCost": 6,
            "passwordPolicy": {"hibpEnabled": False},
        },
        "upstreams": {
            "marketplaceRegistry": {
                "serviceId": "marketplace-registry",
                "prefix": "/api/v1/marketplace-registry/api/v1",
                "rewritePrefix": "/api/v1",
            },
        },
        "staticTokens": {},
    }
    config = {
        "platform": {
            "adapters": {
                "documentDatabase": "@kb-labs/adapters-sqlite",
                "serviceTransport": "@kb-labs/adapters-service-transport-http",
            },
            "adapterOptions": {
                "documentDatabase": {"filename": "database/kb.sqlite"},
                "serviceTransport": {"services": {"marketplace-registry": {"url": proxy_url}}},
            },
        },
        "gateway": gateway,
    }
    service_yaml = "\n".join((
        "name: isolated central Registry Gateway fixture",
        "groups:",
        "  backend: [gateway]",
        "services:",
        "  gateway:",
        "    name: Central Registry Gateway fixture",
        "    description: Run-owned secured fixture for Hub author auth",
        "    group: backend",
        "    type: node",
        f"    command: node {json.dumps(str(gateway_entry))}",
        f"    port: {port}",
        f"    url: http://127.0.0.1:{port}",
        f"    health_check: http://127.0.0.1:{port}/health",
        "    env:",
        f"      GATEWAY_BOOTSTRAP_ADMIN_PASSWORD: {_json_yaml(password)}",
        f"      GATEWAY_JWT_SECRET: {_json_yaml(jwt_secret)}",
        f"      GATEWAY_INTERNAL_SECRET: {_json_yaml(internal_secret)}",
    )) + "\n"
    return config, service_yaml


class CentralRegistryGatewayFixture:
    """Separate secured Gateway with its own DB, account, origin and Registry route."""

    def __init__(self, root: Path, url: str, email: str, password: str,
                 config_path: Path, runner: Callable[..., CompletedProcess[str]]) -> None:
        self.root = root
        self.url = url
        self.email = email
        self.password = password
        self.config_path = config_path
        self.runner = runner
        self.started = False

    @classmethod
    def start(cls, platform_root: Path, proxy_url: str, internal_secret: str,
              *, port: int = 4010,
              runner: Callable[..., CompletedProcess[str]] = run_command) -> "CentralRegistryGatewayFixture":
        platform_root = platform_root.resolve()
        gateway_entry = platform_root / "node_modules/@kb-labs/gateway-app/dist/bin.js"
        if not gateway_entry.is_file():
            raise RuntimeError("installed platform has no Gateway app entry for the isolated Hub auth fixture")
        fixture_root = Path(tempfile.mkdtemp(prefix="kb-journey-central-gateway-"))
        try:
            if port < 1024 or port > 65535:
                raise ValueError("central Registry Gateway fixture port is outside the valid TCP range")
            password = secrets.token_urlsafe(24)
            jwt_secret = secrets.token_urlsafe(48)
            config, services_yaml = _fixture_config(
                port=port, gateway_entry=gateway_entry,
                proxy_url=proxy_url, internal_secret=internal_secret,
                password=password, jwt_secret=jwt_secret,
            )
            kb_dir = fixture_root / ".kb"
            kb_dir.mkdir(mode=0o700)
            (kb_dir / "database").mkdir(mode=0o700)
            (kb_dir / "kb.config.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
            config_path = kb_dir / "devservices.yaml"
            config_path.write_text(services_yaml, encoding="utf-8")
            for path in (kb_dir / "kb.config.json", config_path):
                path.chmod(0o600)
            fixture = cls(fixture_root, f"http://127.0.0.1:{port}",
                          "hub-author@journey.example", password, config_path, runner)
            port_available_before_start = _loopback_port_available(port)
            command = ["kb-dev", "start", "gateway", "--config", str(config_path), "--net-offset", "0"]
            result = run_with_runner(runner, command, cwd=fixture_root, env=dict(os.environ), timeout=90)
            if result.returncode != 0:
                diagnostics_env = dict(os.environ)
                diagnostics_env.update({
                    "GATEWAY_BOOTSTRAP_ADMIN_PASSWORD": password,
                    "GATEWAY_JWT_SECRET": jwt_secret,
                    "GATEWAY_INTERNAL_SECRET": internal_secret,
                })
                logs_command = ["kb-dev", "logs", "gateway", "--config", str(config_path), "--net-offset", "0"]
                logs = run_with_runner(runner, logs_command, cwd=fixture_root,
                                       env=diagnostics_env, timeout=30)
                raw_details = "\n".join((logs.stdout + logs.stderr).splitlines()[-12:]).strip()
                details = redaction.redact_text(raw_details, diagnostics_env)
                raw_start_output = "\n".join((result.stdout + result.stderr).splitlines()[-12:]).strip()
                start_output = redaction.redact_text(raw_start_output, diagnostics_env)
                node_path = shutil.which("node") or "unavailable"
                bash_path = shutil.which("bash") or "unavailable"
                entry_status = "readable" if os.access(gateway_entry, os.R_OK) else "unreadable"
                evidence = [f"port_available_before_start={str(port_available_before_start).lower()}",
                            f"node_path={node_path}", f"bash_path={bash_path}",
                            f"gateway_entry={entry_status}",
                            f"fixture_state_writable={str(os.access(kb_dir, os.W_OK)).lower()}"]
                if start_output:
                    evidence.append(f"start_output={start_output}")
                if details:
                    evidence.append(f"logs={details}")
                raise RuntimeError("could not start the isolated central Registry Gateway fixture: "
                                   + "; ".join(evidence))
            fixture.started = True
            fixture._wait_ready()
            return fixture
        except Exception:
            shutil.rmtree(fixture_root, ignore_errors=True)
            raise

    def _wait_ready(self) -> None:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                request = urllib.request.Request(f"{self.url}/health")
                status, _body, _headers = open_http(http_opener, request, timeout=1)
                if status == 200:
                    return
            except Exception:
                time.sleep(0.25)
        self.stop()
        raise RuntimeError("isolated central Registry Gateway fixture did not become healthy")

    def verify_anonymous_registry_route(self) -> None:
        identity = f"journey-empty-{secrets.token_hex(8)}"
        query = urlencode({"identity": identity})
        request = urllib.request.Request(
            f"{self.url}/api/v1/marketplace-registry/api/v1/resolve?{query}")
        status, body, _headers = open_http(http_opener, request, timeout=5)
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RuntimeError("central Gateway anonymous Registry route returned invalid JSON") from error
        if status == 401:
            raise RuntimeError("central Gateway rejected an anonymous public Registry read")
        if status != 200 or not isinstance(payload, dict) or payload.get("status") != "not-found":
            raise RuntimeError(f"central Gateway anonymous Registry route returned HTTP {status}")

        publish = urllib.request.Request(
            f"{self.url}/api/v1/marketplace-registry/api/v1/packages/publish",
            data=b"", method="POST")
        status, _body, _headers = open_http(http_opener, publish, timeout=5)
        if status != 401:
            raise RuntimeError(f"anonymous central Hub publish returned HTTP {status}, expected 401")

    def stop(self) -> None:
        if self.started:
            command = ["kb-dev", "stop", "gateway", "--config", str(self.config_path), "--net-offset", "0"]
            run_with_runner(self.runner, command, cwd=self.root, env=dict(os.environ), timeout=30)
            self.started = False
        shutil.rmtree(self.root, ignore_errors=True)

    def __enter__(self) -> "CentralRegistryGatewayFixture":
        return self

    def __exit__(self, _type, _value, _traceback) -> None:
        self.stop()
