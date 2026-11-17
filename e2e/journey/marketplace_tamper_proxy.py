from __future__ import annotations

import http.client
import json
import os
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit


FAULTS: dict[str, str] = {}


def registry_upstream_headers(headers, internal_secret: str) -> dict[str, str]:
    if not internal_secret:
        raise ValueError("Registry fixture internal secret is empty")
    forwarded = {key: value for key, value in headers.items()
                if key.lower() not in {"host", "connection", "x-internal-secret"}}
    forwarded["x-internal-secret"] = internal_secret
    return forwarded


def tamper_tarball(path: str, body: bytes) -> bytes:
    if not path.endswith("/tarball") or not body:
        return body
    altered = bytearray(body)
    altered[len(altered) // 2] ^= 1
    return bytes(altered)


def gateway_download_url(download_url: str, gateway_base: str) -> str:
    parsed = urlsplit(download_url)
    gateway = urlsplit(gateway_base)
    if (gateway.scheme not in {"http", "https"} or not gateway.netloc
            or not parsed.path.startswith("/api/v1/packages/")):
        raise ValueError("Registry download URL cannot be routed through the journey Gateway")
    return urlunsplit((gateway.scheme, gateway.netloc, f"{gateway.path.rstrip('/')}{parsed.path}",
                       parsed.query, parsed.fragment))


def inject_download_fault(download_url: str, fault: str | None) -> str:
    if fault != "integrity":
        return download_url
    parsed = urlsplit(download_url)
    query = parse_qs(parsed.query)
    query["journey-tamper"] = ["1"]
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path,
                       urlencode(query, doseq=True), parsed.fragment))


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        if self.path != "/__journey/faults":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            faults = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            self.send_error(400)
            return
        if not isinstance(faults, dict) or any(not isinstance(key, str) or value not in {
                "auth", "transport", "signature", "integrity"} for key, value in faults.items()):
            self.send_error(400)
            return
        FAULTS.clear()
        FAULTS.update(faults)
        self.send_response(204)
        self.end_headers()

    def do_GET(self) -> None:
        request = urlsplit(self.path)
        identity = parse_qs(request.query).get("identity", [""])[0]
        fault = FAULTS.get(identity)
        if request.path == "/api/v1/resolve" and fault in {"auth", "transport"}:
            self.send_response(401 if fault == "auth" else 503)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        target = urlsplit(os.environ.get("MARKETPLACE_TAMPER_UPSTREAM", "http://marketplace-registry:5071"))
        secret_file = os.environ.get("MARKETPLACE_TAMPER_INTERNAL_SECRET_FILE", "")
        try:
            internal_secret = Path(secret_file).read_text(encoding="utf-8").strip()
        except OSError as error:
            self.send_error(503, f"Registry fixture internal secret is unavailable: {error}")
            return
        if not internal_secret:
            self.send_error(503, "Registry fixture internal secret is empty")
            return
        connection = http.client.HTTPConnection(target.hostname, target.port or 80, timeout=30)
        headers = registry_upstream_headers(self.headers, internal_secret)
        connection.request("GET", self.path, headers=headers)
        response = connection.getresponse()
        body = response.read()
        response_type = response.getheader("Content-Type", "")
        if request.path == "/api/v1/resolve" and "json" in response_type:
            payload = json.loads(body)
            package = payload.get("package", {})
            download_url = package.get("downloadUrl")
            gateway_base = os.environ.get("MARKETPLACE_TAMPER_GATEWAY_REGISTRY_URL", "").rstrip("/")
            if gateway_base and isinstance(download_url, str):
                try:
                    package["downloadUrl"] = gateway_download_url(download_url, gateway_base)
                except ValueError:
                    pass
                else:
                    payload["package"] = package
            if fault == "signature":
                signature = payload.get("package", {}).get("signature", {})
                value = signature.get("value")
                if isinstance(value, str) and value:
                    signature["value"] = ("A" if value[0] != "A" else "B") + value[1:]
            elif fault == "integrity":
                package = payload.get("package", {})
                download_url = package.get("downloadUrl")
                if isinstance(download_url, str):
                    package["downloadUrl"] = inject_download_fault(download_url, fault)
                    payload["package"] = package
            if gateway_base or fault in {"signature", "integrity"}:
                body = json.dumps(payload).encode()
        headers = [(key, value) for key, value in response.getheaders()
                   if key.lower() not in {"content-length", "connection", "transfer-encoding"}]
        if parse_qs(request.query).get("journey-tamper") == ["1"]:
            body = tamper_tarball(request.path, body)
        self.send_response(response.status)
        for key, value in headers:
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        connection.close()

    def log_message(self, _format: str, *_args: object) -> None:
        return


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8081), Handler).serve_forever()
