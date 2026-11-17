from __future__ import annotations

import hashlib
import http.server
import io
import json
import sys
import shutil
import tarfile
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from registry_candidate import allocate_candidate_root, preflight_release_graph, stage_verified_batch_candidate


def package_tarball(directory: Path, package: str, version: str, marker: str = "built") -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    package_root = directory / "package"
    shutil.rmtree(package_root, ignore_errors=True)
    package_root.mkdir()
    (package_root / "package.json").write_text(json.dumps({"name": package, "version": version}))
    (package_root / "index.js").write_text(marker)
    archive_path = directory / f"{package.split('/')[-1]}-{version}.tgz"
    with tarfile.open(archive_path, "w:gz") as archive:
        archive.add(package_root, arcname="package")
    return archive_path


class RegistryMetadataHandler(http.server.BaseHTTPRequestHandler):
    metadata: dict[str, dict] = {}

    def do_GET(self):
        package = self.path.lstrip("/").replace("%2f", "/").replace("%2F", "/")
        payload = self.metadata.get(package)
        self.send_response(200 if payload is not None else 404)
        self.end_headers()
        if payload is not None:
            self.wfile.write(json.dumps(payload).encode())

    def log_message(self, *_args):
        pass


class RegistryCandidateTests(unittest.TestCase):
    # case: S-268.1
    def test_batch_candidate_stages_only_verified_registry_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            subprocess = __import__("subprocess")
            subprocess.run(["git", "init", "-q"], cwd=workspace, check=True)
            subprocess.run(["git", "config", "user.email", "journey@example.test"], cwd=workspace, check=True)
            subprocess.run(["git", "config", "user.name", "Journey Test"], cwd=workspace, check=True)
            (workspace / "source.txt").write_text("candidate source\n")
            subprocess.run(["git", "add", "source.txt"], cwd=workspace, check=True)
            subprocess.run(["git", "commit", "-qm", "candidate"], cwd=workspace, check=True)
            sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=workspace, text=True).strip()
            archive_path = root / "build-candidate.tar"
            contents = {
                "./.journey/release/journey-candidate/release-index.json": b'{"platforms": []}\n',
                "./.journey/release/journey-candidate/kb-create-linux-amd64": b"candidate binary",
                "./e2e/packages/commit.tgz": b"packed Commit",
                "./core/config/dist/index.js": b"built output outside Registry root",
            }
            with tarfile.open(archive_path, "w") as archive:
                for name, data in contents.items():
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
            run = root / "run.json"
            run.write_text(json.dumps({"commit": sha}))
            metadata = root / "batch-metadata.json"
            metadata.write_text(json.dumps({"commit": sha, "candidateArchiveSha256": hashlib.sha256(
                archive_path.read_bytes()).hexdigest()}))

            candidate = stage_verified_batch_candidate(workspace, root / "candidates", run, metadata, archive_path)

            self.assertEqual((candidate / "packages/commit.tgz").read_bytes(), b"packed Commit")
            self.assertEqual((candidate / "release/journey-candidate/release-index.json").read_bytes(),
                             contents["./.journey/release/journey-candidate/release-index.json"])
            self.assertFalse((candidate / "core").exists())
            self.assertEqual(json.loads((candidate / "source-identity.json").read_text())["gitHead"], sha)
            (workspace / "source.txt").write_text("modified source\n")
            with self.assertRaisesRegex(ValueError, "clean checkout"):
                stage_verified_batch_candidate(workspace, root / "candidates", run, metadata, archive_path)
            (workspace / "source.txt").write_text("candidate source\n")
            archive_path.write_bytes(archive_path.read_bytes() + b"tampered")
            with self.assertRaisesRegex(ValueError, "digest"):
                stage_verified_batch_candidate(workspace, root / "candidates", run, metadata, archive_path)
            self.assertEqual(len(list((root / "candidates").iterdir())), 1)

    # case: S-268.1
    def test_batch_candidate_rejects_foreign_sha_and_unsafe_archive_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            subprocess = __import__("subprocess")
            subprocess.run(["git", "init", "-q"], cwd=workspace, check=True)
            subprocess.run(["git", "config", "user.email", "journey@example.test"], cwd=workspace, check=True)
            subprocess.run(["git", "config", "user.name", "Journey Test"], cwd=workspace, check=True)
            (workspace / "source.txt").write_text("candidate source\n")
            subprocess.run(["git", "add", "source.txt"], cwd=workspace, check=True)
            subprocess.run(["git", "commit", "-qm", "candidate"], cwd=workspace, check=True)
            archive_path = root / "build-candidate.tar"
            def write_archive(extra: tarfile.TarInfo) -> None:
                with tarfile.open(archive_path, "w") as archive:
                    for name in ("./.journey/release/journey-candidate/release-index.json",
                                 "./e2e/packages/commit.tgz"):
                        data = b"fixture"
                        member = tarfile.TarInfo(name)
                        member.size = len(data)
                        archive.addfile(member, io.BytesIO(data))
                    if extra.isfile():
                        extra.size = len(b"fixture")
                        archive.addfile(extra, io.BytesIO(b"fixture"))
                    else:
                        archive.addfile(extra)

            write_archive(tarfile.TarInfo("./e2e/packages/../escape"))
            metadata = root / "batch-metadata.json"
            metadata.write_text(json.dumps({"commit": "foreign", "candidateArchiveSha256": hashlib.sha256(
                archive_path.read_bytes()).hexdigest()}))
            run = root / "run.json"
            run.write_text(json.dumps({"commit": "foreign"}))
            with self.assertRaisesRegex(ValueError, "bound to foreign"):
                stage_verified_batch_candidate(workspace, root / "candidates", run, metadata, archive_path)
            sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=workspace, text=True).strip()
            run.write_text(json.dumps({"commit": sha}))
            unsafe_members = [tarfile.TarInfo("./e2e/packages/../escape"),
                              tarfile.TarInfo("/tmp/escape"),
                              tarfile.TarInfo("./e2e/packages/escape-link"),
                              tarfile.TarInfo("./e2e/packages/escape-hardlink")]
            unsafe_members[2].type = tarfile.SYMTYPE
            unsafe_members[2].linkname = "/tmp/escape"
            unsafe_members[3].type = tarfile.LNKTYPE
            unsafe_members[3].linkname = "../../escape"
            for member in unsafe_members:
                with self.subTest(entry=member.name, kind=member.type):
                    write_archive(member)
                    metadata.write_text(json.dumps({"commit": sha, "candidateArchiveSha256": hashlib.sha256(
                        archive_path.read_bytes()).hexdigest()}))
                    with self.assertRaisesRegex(ValueError, "unsafe"):
                        stage_verified_batch_candidate(workspace, root / "candidates", run, metadata, archive_path)
            self.assertFalse((root / "candidates").exists())

    def test_allocate_records_dirty_tree_identity_and_never_reuses_a_candidate_root(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory) / "workspace"
            workspace.mkdir()
            subprocess = __import__("subprocess")
            subprocess.run(["git", "init", "-q"], cwd=workspace, check=True)
            subprocess.run(["git", "config", "user.email", "journey@example.test"], cwd=workspace, check=True)
            subprocess.run(["git", "config", "user.name", "Journey Test"], cwd=workspace, check=True)
            source = workspace / "tracked.py"
            source.write_text("base\n")
            subprocess.run(["git", "add", "tracked.py"], cwd=workspace, check=True)
            subprocess.run(["git", "commit", "-qm", "base"], cwd=workspace, check=True)
            source.write_text("dirty\n")
            parent = Path(directory) / "candidates"

            first = allocate_candidate_root(workspace, parent)
            identity = json.loads((first / "source-identity.json").read_text())
            self.assertTrue(identity["dirty"])
            self.assertEqual(len(identity["sourceTreeSha256"]), 64)
            self.assertTrue((first / "packages").is_dir())
            self.assertTrue((first / "release").is_dir())
            self.assertTrue((first / "reports").is_dir())
            self.assertNotEqual(first, allocate_candidate_root(workspace, parent))
            self.assertTrue((first / "source-identity.json").is_file())

    def test_preflight_reuses_exact_existing_versions_and_only_stages_missing_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = "@kb-labs/demo"
            existing = package_tarball(root / "packages", package, "1.0.0", "existing")
            new = package_tarball(root / "packages", package, "1.1.0", "new")
            index = {"platforms": [{"id": "platform", "version": "1.0.0",
                                    "package": package, "sha256": hashlib.sha256(existing.read_bytes()).hexdigest(),
                                    "tarball": f"http://verdaccio:4873/{package}/-/{existing.name}",
                                    "members": [{"id": "new", "version": "1.1.0", "package": package,
                                                 "sha256": hashlib.sha256(new.read_bytes()).hexdigest(),
                                                 "tarball": f"http://verdaccio:4873/{package}/-/{new.name}"}]}]}
            index_path = root / "release-index.json"
            index_path.write_text(json.dumps(index))
            existing_integrity = "sha512-" + __import__("base64").b64encode(
                hashlib.sha512(existing.read_bytes()).digest()).decode()
            RegistryMetadataHandler.metadata = {package: {"versions": {
                "1.0.0": {"dist": {"integrity": existing_integrity}},
            }}}
            server = http.server.HTTPServer(("127.0.0.1", 0), RegistryMetadataHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.shutdown)
            self.addCleanup(server.server_close)
            self.addCleanup(thread.join, 2)
            publish_dir = root / "publish"

            plan = preflight_release_graph(index_path, root / "packages",
                                           f"http://127.0.0.1:{server.server_port}", publish_dir)

            self.assertEqual((plan["graphArtifacts"], plan["reused"], plan["toPublish"]), (2, 1, 1))
            self.assertFalse((publish_dir / existing.name).exists())
            self.assertTrue((publish_dir / new.name).is_file())

    def test_preflight_rejects_non_loopback_registries_and_immutable_byte_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = package_tarball(root / "packages", "@kb-labs/demo", "1.0.0")
            index = {"sdks": [{"id": "sdk", "version": "1.0.0", "package": "@kb-labs/demo",
                               "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                               "tarball": f"http://verdaccio:4873/@kb-labs/demo/-/{archive.name}"}]}
            index_path = root / "release-index.json"
            index_path.write_text(json.dumps(index))
            with self.assertRaisesRegex(ValueError, "loopback HTTP"):
                preflight_release_graph(index_path, root / "packages", "https://registry.npmjs.org",
                                        root / "publish")
            RegistryMetadataHandler.metadata = {"@kb-labs/demo": {"versions": {
                "1.0.0": {"dist": {"integrity": "sha512-not-the-candidate"}},
            }}}
            server = http.server.HTTPServer(("127.0.0.1", 0), RegistryMetadataHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.shutdown)
            self.addCleanup(server.server_close)
            self.addCleanup(thread.join, 2)
            with self.assertRaisesRegex(ValueError, "different bytes"):
                preflight_release_graph(index_path, root / "packages", f"http://127.0.0.1:{server.server_port}",
                                        root / "publish")
            self.assertFalse((root / "publish").exists())

    def test_empty_target_publishes_candidate_even_when_historical_baseline_differs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            packages = root / "packages"
            archive = package_tarball(packages, "@kb-labs/demo", "1.0.0", "candidate")
            historical = root / "historical"
            old = package_tarball(root / "old-source", "@kb-labs/demo", "1.0.0", "old bytes")
            historical.mkdir()
            shutil.copyfile(old, historical / archive.name)
            index = {"sdks": [{"id": "sdk", "version": "1.0.0", "package": "@kb-labs/demo",
                               "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                               "tarball": f"http://verdaccio:4873/@kb-labs/demo/-/{archive.name}"}]}
            index_path = root / "release-index.json"
            index_path.write_text(json.dumps(index))
            RegistryMetadataHandler.metadata = {}
            server = http.server.HTTPServer(("127.0.0.1", 0), RegistryMetadataHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.shutdown)
            self.addCleanup(server.server_close)
            self.addCleanup(thread.join, 2)

            plan = preflight_release_graph(index_path, packages,
                                           f"http://127.0.0.1:{server.server_port}", root / "publish")

            self.assertEqual((plan["reused"], plan["toPublish"]), (0, 1))
            self.assertTrue((root / "publish" / archive.name).is_file())

    def test_preflight_checks_transitive_platform_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            packages = root / "packages"
            root_tarball = package_tarball(packages, "@kb-labs/root", "2.0.0")
            package_tarball(packages, "@kb-labs/dependency", "2.0.0")
            root_manifest = {"name": "@kb-labs/root", "version": "2.0.0",
                             "dependencies": {"@kb-labs/dependency": "2.0.0"}}
            package_root = root / "unpack"
            (package_root / "package").mkdir(parents=True)
            (package_root / "package" / "package.json").write_text(json.dumps(root_manifest))
            (package_root / "package" / "index.js").write_text("built")
            root_tarball.unlink()
            root_tarball = packages / "root-2.0.0.tgz"
            with tarfile.open(root_tarball, "w:gz") as archive:
                archive.add(package_root / "package", arcname="package")
            index = {"platforms": [{"id": "platform", "version": "2.0.0", "package": "@kb-labs/root",
                                    "sha256": hashlib.sha256(root_tarball.read_bytes()).hexdigest(),
                                    "tarball": f"http://verdaccio:4873/@kb-labs/root/-/{root_tarball.name}"}]}
            index_path = root / "release-index.json"
            index_path.write_text(json.dumps(index))
            RegistryMetadataHandler.metadata = {}
            server = http.server.HTTPServer(("127.0.0.1", 0), RegistryMetadataHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.shutdown)
            self.addCleanup(server.server_close)
            self.addCleanup(thread.join, 2)
            plan = preflight_release_graph(index_path, packages, f"http://127.0.0.1:{server.server_port}",
                                           root / "publish")
            self.assertEqual(plan["graphArtifacts"], 2)
            self.assertEqual({item["package"] for item in plan["publish"]},
                             {"@kb-labs/root", "@kb-labs/dependency"})

            self.assertEqual(plan["toPublish"], 2)


if __name__ == "__main__":
    unittest.main()
