from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import threading
import unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[2]
STAGER = ROOT / "e2e/journey/stage-versioned-origin-assets.mjs"


class QuietStaticHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


class StaticOriginAssetTests(unittest.TestCase):
    @staticmethod
    def _entry(version: str, filename: str, payload: bytes, url: str) -> dict:
        return {
            "id": "kb-create", "os": "linux", "arch": "amd64", "filename": filename,
            "sha256": hashlib.sha256(payload).hexdigest(), "sizeBytes": len(payload), "url": url,
        }

    @staticmethod
    def _run_stager(candidate: Path, origin: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["node", str(STAGER), str(candidate), str(origin)],
            capture_output=True, text=True, check=False,
        )

    def test_static_origin_serves_resolved_versioned_and_corrupt_binary_routes(self):
        with tempfile.TemporaryDirectory(prefix="journey-static-origin-assets-") as temporary:
            origin = Path(temporary) / "release"
            candidate = origin / "journey-candidate"
            candidate.mkdir(parents=True)
            filename = "kb-create-linux-amd64"
            first_version = "2.120.2-cand.static-fixture"
            second_version = "2.120.3-cand.static-fixture"
            first_bytes = b"first version binary"
            second_bytes = b"second version binary"
            corrupt_bytes = b"corrupt version binary"
            for version, payload in ((first_version, first_bytes), (second_version, second_bytes)):
                binary = candidate / "binaries" / version / filename
                binary.parent.mkdir(parents=True, exist_ok=True)
                binary.write_bytes(payload)
            corrupt = candidate / "checksum-corrupt" / f"{first_version}-bad-checksum" / filename
            corrupt.parent.mkdir(parents=True)
            corrupt.write_bytes(corrupt_bytes)
            (origin / "keep.txt").write_text("unowned origin file", encoding="utf-8")
            (candidate / "release-index-update.json").write_text(json.dumps({
                "schema": "kb.create.release-index/v2",
                "platforms": [{"version": first_version, "binaries": [
                    self._entry(first_version, filename, first_bytes,
                                f"http://origin:8080/journey-candidate/binaries/{first_version}/{filename}"),
                ]}],
            }), encoding="utf-8")
            (candidate / "release-index-update-jump.json").write_text(json.dumps({
                "schema": "kb.create.release-index/v2",
                "platforms": [{"version": second_version, "binaries": [
                    self._entry(second_version, filename, second_bytes,
                                f"http://origin:8080/journey-candidate/binaries/{second_version}/{filename}"),
                ]}],
            }), encoding="utf-8")
            (candidate / "release-index-update-bad-checksum.json").write_text(json.dumps({
                "schema": "kb.create.release-index/v2",
                "platforms": [{"version": first_version, "binaries": [
                    {
                        **self._entry(first_version, filename, first_bytes,
                                      f"http://origin:8080/journey-candidate/checksum-corrupt/{first_version}-bad-checksum/{filename}"),
                    },
                ]}],
            }), encoding="utf-8")

            staged = self._run_stager(candidate, origin)
            self.assertEqual(staged.returncode, 0, staged.stderr)
            self.assertEqual((origin / first_version / filename).read_bytes(), first_bytes)
            self.assertEqual((origin / second_version / filename).read_bytes(), second_bytes)
            self.assertEqual((origin / f"{first_version}-bad-checksum" / filename).read_bytes(), corrupt_bytes)
            self.assertNotEqual(hashlib.sha256(corrupt_bytes).hexdigest(),
                                hashlib.sha256(first_bytes).hexdigest())

            server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietStaticHandler, directory=str(origin)))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base = f"http://127.0.0.1:{server.server_port}"
                for route, expected in (
                    (f"/{first_version}/{filename}", first_bytes),
                    (f"/{second_version}/{filename}", second_bytes),
                    (f"/{first_version}-bad-checksum/{filename}", corrupt_bytes),
                    (f"/journey-candidate/binaries/{first_version}/{filename}", first_bytes),
                    (f"/journey-candidate/checksum-corrupt/{first_version}-bad-checksum/{filename}", corrupt_bytes),
                ):
                    with self.subTest(route=route), urlopen(base + route, timeout=5) as response:
                        self.assertEqual(response.status, 200)
                        body = response.read()
                        self.assertEqual(body, expected)
                        if "bad-checksum" in route:
                            self.assertNotEqual(hashlib.sha256(body).hexdigest(),
                                                hashlib.sha256(first_bytes).hexdigest())
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_refresh_removes_only_previously_owned_aliases(self):
        with tempfile.TemporaryDirectory(prefix="journey-static-origin-refresh-") as temporary:
            origin = Path(temporary) / "release"
            candidate = origin / "journey-candidate"
            candidate.mkdir(parents=True)
            keep = origin / "keep.txt"
            keep.write_text("user fixture", encoding="utf-8")
            filename = "kb-create-linux-amd64"
            old_version = "2.120.2-cand.old"
            new_version = "2.120.3-cand.new"
            old_bytes = b"old"
            new_bytes = b"new"
            for version, payload in ((old_version, old_bytes), (new_version, new_bytes)):
                binary = candidate / "binaries" / version / filename
                binary.parent.mkdir(parents=True, exist_ok=True)
                binary.write_bytes(payload)
            index_path = candidate / "release-index.json"
            index_path.write_text(json.dumps({"platforms": [{"version": old_version, "binaries": [
                self._entry(old_version, filename, old_bytes,
                            f"http://origin:8080/journey-candidate/binaries/{old_version}/{filename}"),
            ]}]}), encoding="utf-8")
            first = self._run_stager(candidate, origin)
            self.assertEqual(first.returncode, 0, first.stderr)
            index_path.write_text(json.dumps({"platforms": [{"version": new_version, "binaries": [
                self._entry(new_version, filename, new_bytes,
                            f"http://origin:8080/journey-candidate/binaries/{new_version}/{filename}"),
            ]}]}), encoding="utf-8")
            second = self._run_stager(candidate, origin)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertFalse((origin / old_version / filename).exists())
            self.assertEqual((origin / new_version / filename).read_bytes(), new_bytes)
            self.assertEqual(keep.read_text(encoding="utf-8"), "user fixture")

    def test_stager_rejects_unsafe_binary_version(self):
        with tempfile.TemporaryDirectory(prefix="journey-static-origin-traversal-") as temporary:
            root = Path(temporary)
            origin = root / "release"
            candidate = origin / "journey-candidate"
            candidate.mkdir(parents=True)
            (candidate / "release-index.json").write_text(json.dumps({"platforms": [{"version": "../escape", "binaries": [
                self._entry("../escape", "kb-create-linux-amd64", b"unsafe",
                            "http://origin:8080/journey-candidate/binaries/../escape/kb-create-linux-amd64"),
            ]}]}), encoding="utf-8")
            result = self._run_stager(candidate, origin)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / "escape" / "kb-create-linux-amd64").exists())

    def test_stager_rejects_symlinked_origin_version_directory(self):
        with tempfile.TemporaryDirectory(prefix="journey-static-origin-symlink-") as temporary:
            root = Path(temporary)
            origin = root / "release"
            candidate = origin / "journey-candidate"
            candidate.mkdir(parents=True)
            outside = root / "outside"
            outside.mkdir()
            version = "2.120.2-cand.symlink"
            filename = "kb-create-linux-amd64"
            payload = b"binary"
            source = candidate / "binaries" / version / filename
            source.parent.mkdir(parents=True)
            source.write_bytes(payload)
            (candidate / "release-index.json").write_text(json.dumps({"platforms": [{"version": version, "binaries": [
                self._entry(version, filename, payload,
                            f"http://origin:8080/journey-candidate/binaries/{version}/{filename}"),
            ]}]}), encoding="utf-8")
            (origin / version).symlink_to(outside, target_is_directory=True)
            result = self._run_stager(candidate, origin)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((outside / filename).exists())


if __name__ == "__main__":
    unittest.main()
