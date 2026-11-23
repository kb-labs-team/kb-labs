"""Two local npm registries for the installed platform routing journey.

Registry A serves the Marketplace plugin metadata and tarball. Registry B
serves only the plugin's dependency and requires the disposable journey token.
Request evidence stores package names and authorization outcomes, never headers.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import threading
import tarfile
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import quote, unquote, urlsplit


PLUGIN = "@fixture/platform-plugin"
DEPENDENCY = "@fixture/platform-dependency"
VERSION = "1.0.0"


def _tarball(files: dict[str, bytes]) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, content in sorted(files.items()):
            entry = tarfile.TarInfo(f"package/{name}")
            entry.size = len(content)
            entry.mode = 0o644
            entry.uid = entry.gid = 0
            entry.uname = entry.gname = ""
            entry.mtime = 0
            archive.addfile(entry, io.BytesIO(content))
    return output.getvalue()


@dataclass
class _Package:
    name: str
    tarball: bytes
    dependencies: dict[str, str]
    manifest_field: str | None = None

    @property
    def integrity(self) -> str:
        digest = hashlib.sha512(self.tarball).digest()
        return f"sha512-{base64.b64encode(digest).decode('ascii')}"

    @property
    def shasum(self) -> str:
        return hashlib.sha1(self.tarball).hexdigest()


class _NpmRegistry:
    def __init__(self, *, token: str | None = None):
        self._token = token
        self._packages: dict[str, _Package] = {}
        self._requests: list[dict[str, Any]] = []
        registry = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, _format: str, *_args: object) -> None:
                return

            def do_GET(self) -> None:
                path = unquote(urlsplit(self.path).path).lstrip("/")
                tarball_path = path.rpartition("/-/")
                is_tarball = bool(tarball_path[1])
                package_name = tarball_path[0] if is_tarball else path
                authorized = registry._authorized(self.headers.get("authorization", ""))
                registry._requests.append({
                    "package": package_name,
                    "kind": "tarball" if is_tarball else "metadata",
                    "authorized": authorized,
                })
                if not authorized:
                    self.send_response(401)
                    self.send_header("WWW-Authenticate", "Bearer")
                    self.end_headers()
                    return
                package = registry._packages.get(package_name)
                if package is None:
                    self.send_error(404)
                    return
                if is_tarball:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(len(package.tarball)))
                    self.end_headers()
                    self.wfile.write(package.tarball)
                    return

                version_data: dict[str, Any] = {
                    "name": package.name,
                    "version": VERSION,
                    "dependencies": package.dependencies,
                    "dist": {
                        "tarball": registry.tarball_url(package),
                        "integrity": package.integrity,
                        "shasum": package.shasum,
                    },
                }
                if package.manifest_field:
                    version_data["kb"] = {"manifest": package.manifest_field}
                body = json.dumps({
                    "name": package.name,
                    "dist-tags": {"latest": VERSION},
                    "versions": {VERSION: version_data},
                }).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        host, port = self._server.server_address
        self.url = f"http://{host}:{port}"

    def _authorized(self, header: str) -> bool:
        if self._token is None:
            return True
        expected = f"Bearer {self._token}"
        return hmac.compare_digest(header, expected)

    def add(self, package: _Package) -> None:
        self._packages[package.name] = package

    def tarball_url(self, package: _Package) -> str:
        filename = package.name.rsplit("/", 1)[-1]
        return f"{self.url}/{quote(package.name, safe='')}/-/{filename}-{VERSION}.tgz"

    def requests(self) -> list[dict[str, Any]]:
        return [dict(item) for item in self._requests]

    def clear_requests(self) -> None:
        self._requests.clear()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


class PlatformRegistryRoutingFixture:
    """Local source and dependency registries with redacted auth evidence."""

    def __init__(self, token: str):
        self.auth_token = token
        self.source = _NpmRegistry()
        self.dependencies = _NpmRegistry(token=token)
        plugin_manifest = json.dumps({
            "schema": "kb.plugin/3", "id": PLUGIN, "version": VERSION,
        }).encode()
        self.source.add(_Package(
            PLUGIN,
            _tarball({
                "package.json": json.dumps({
                    "name": PLUGIN,
                    "version": VERSION,
                    "type": "module",
                    "kb": {"manifest": "./dist/manifest.js"},
                    "dependencies": {DEPENDENCY: VERSION},
                }).encode(),
                "dist/manifest.json": plugin_manifest,
            }),
            {DEPENDENCY: VERSION},
            "./dist/manifest.js",
        ))
        self.dependencies.add(_Package(
            DEPENDENCY,
            _tarball({
                "package.json": json.dumps({
                    "name": DEPENDENCY, "version": VERSION, "type": "module",
                }).encode(),
                "index.js": b"export const fixture = true;\n",
            }),
            {},
        ))

    def __enter__(self) -> "PlatformRegistryRoutingFixture":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def clear_requests(self) -> None:
        self.source.clear_requests()
        self.dependencies.clear_requests()

    def request_summary(self) -> dict[str, list[dict[str, Any]]]:
        return {
            "source": self.source.requests(),
            "dependencies": self.dependencies.requests(),
        }

    def close(self) -> None:
        self.dependencies.close()
        self.source.close()
