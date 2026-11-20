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
        if self.path == "/__journey/faults":
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
            return
        self._forward("POST")

    def _forward(self, method: str) -> None:
        target = urlsplit(os.environ.get("MARKETPLACE_TAMPER_UPSTREAM", "http://marketplace-registry:5071"))
        if target.scheme != "http" or not target.hostname:
            self.send_error(502)
            return
        length_header = self.headers.get("Content-Length")
        transfer_encoding = self.headers.get("Transfer-Encoding", "").lower()
        try:
            if length_header is not None:
                body = self.rfile.read(int(length_header))
            elif transfer_encoding == "chunked":
                body = self._read_chunked_body()
            else:
                body = None
        except (ValueError, OverflowError):
            self.send_error(400)
            return
        connection = http.client.HTTPConnection(target.hostname, target.port or 80, timeout=30)
        headers = {key: value for key, value in self.headers.items()
                   if key.lower() not in {"host", "connection", "transfer-encoding"}}
        try:
            connection.request(method, self.path, body=body, headers=headers)
            response = connection.getresponse()
            response_body = response.read()
            response_headers = [(key, value) for key, value in response.getheaders()
                                if key.lower() not in {"content-length", "connection", "transfer-encoding"}]
            self.send_response(response.status)
            for key, value in response_headers:
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(response_body)))
            self.end_headers()
            self.wfile.write(response_body)
        except OSError:
            self.send_error(502)
        finally:
            connection.close()

    def _read_chunked_body(self) -> bytes:
        chunks: list[bytes] = []
        while True:
            size_line = self.rfile.readline().split(b";", 1)[0].strip()
            try:
                size = int(size_line, 16)
            except ValueError as error:
                raise ValueError("invalid chunked request body") from error
            if size == 0:
                while self.rfile.readline().strip():
                    pass
                return b"".join(chunks)
            chunk = self.rfile.read(size)
            if len(chunk) != size or self.rfile.read(2) != b"\r\n":
                raise ValueError("truncated chunked request body")
            chunks.append(chunk)

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
