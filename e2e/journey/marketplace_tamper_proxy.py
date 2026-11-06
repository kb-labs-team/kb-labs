from __future__ import annotations

import http.client
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit


FAULTS: dict[str, str] = {}


def tamper_tarball(path: str, body: bytes) -> bytes:
    if not path.endswith("/tarball") or not body:
        return body
    altered = bytearray(body)
    altered[len(altered) // 2] ^= 1
    return bytes(altered)


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
        connection = http.client.HTTPConnection(target.hostname, target.port or 80, timeout=30)
        connection.request("GET", self.path, headers={key: value for key, value in self.headers.items()
                                                       if key.lower() not in {"host", "connection"}})
        response = connection.getresponse()
        body = response.read()
        response_type = response.getheader("Content-Type", "")
        if request.path == "/api/v1/resolve" and fault in {"signature", "integrity"} and "json" in response_type:
            payload = json.loads(body)
            if fault == "signature":
                signature = payload.get("package", {}).get("signature", {})
                value = signature.get("value")
                if isinstance(value, str) and value:
                    signature["value"] = ("A" if value[0] != "A" else "B") + value[1:]
            else:
                package = payload.get("package", {})
                download_url = package.get("downloadUrl")
                if isinstance(download_url, str):
                    parsed = urlsplit(download_url)
                    query = parse_qs(parsed.query)
                    query["journey-tamper"] = ["1"]
                    package["downloadUrl"] = urlunsplit((parsed.scheme, parsed.netloc, parsed.path,
                                                          urlencode(query, doseq=True), parsed.fragment))
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
