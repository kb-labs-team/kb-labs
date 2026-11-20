import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

from candidate_cache import INPUT_PATHS, create_candidate_cache, verify_candidate_cache


class PreparedCandidateCacheTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="journey-prepared-candidate-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.cache = self.root / "prepared-candidate-cache"
        self.runtime = {
            "runnerOs": "Linux",
            "runnerArch": "X64",
            "imageVersion": "ubuntu-24.04-20261118.1.0",
            "node": "v24.11.0",
            "go": "go version go1.26.8 linux/amd64",
            "pnpm": "11.4.0",
        }
        for path in INPUT_PATHS:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f"tracked input: {path}\n", encoding="utf-8")
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=self.root, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=self.root, check=True)
        subprocess.run(["git", "add", "."], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "-qm", "fixture"], cwd=self.root, check=True)
        self.source_sha = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=self.root, text=True,
        ).strip()
        self.archive = self.root / "build-candidate.tar"
        self._write_archive(self.source_sha[:7])

    def _write_archive(self, source_revision, *, bad_index_checksum=False):
        release = self.root / "release"
        release.mkdir(exist_ok=True)
        index = {
            "schemaVersion": 2,
            "provenance": [{
                "sourceRevision": source_revision,
                "package": "@kb-labs/core-test",
                "version": "1.2.3",
                "distSha256": "a" * 64,
                "integrity": "sha512-c2FtcGxl",
            }],
        }
        index_path = release / "release-index.json"
        index_bytes = (json.dumps(index, sort_keys=True) + "\n").encode()
        index_path.write_bytes(index_bytes)
        binary = release / "kb-create"
        binary.write_bytes(b"fixture binary")
        (release / "checksums.txt").write_text(
            f"{'0' * 64 if bad_index_checksum else hashlib.sha256(index_bytes).hexdigest()}  release-index.json\n"
            f"{hashlib.sha256(binary.read_bytes()).hexdigest()}  kb-create\n",
            encoding="utf-8",
        )
        archived = self.root / ".journey/release/journey-candidate"
        archived.mkdir(parents=True, exist_ok=True)
        for item in release.iterdir():
            (archived / item.name).write_bytes(item.read_bytes())
        self.archive.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(self.archive, "w") as tar:
            tar.add(archived, arcname="./.journey/release/journey-candidate")

    def _create(self):
        return create_candidate_cache(self.root, self.archive, self.cache, self.runtime)

    def test_exact_source_inputs_archive_and_sealed_provenance_allow_reuse(self):
        manifest = self._create()

        valid, reason = verify_candidate_cache(self.root, self.cache, self.runtime)

        self.assertTrue(valid, reason)
        self.assertEqual(manifest["sourceSha"], self.source_sha)
        self.assertEqual(manifest["releaseSourceRevision"], self.source_sha[:7])
        self.assertEqual(manifest["candidateArchiveSha256"], hashlib.sha256(self.archive.read_bytes()).hexdigest())
        self.assertTrue(manifest["candidateReleaseIndexSha256"])
        self.assertTrue(manifest["inputFingerprint"])

    def test_source_commit_change_forbids_reuse(self):
        self._create()
        (self.root / "later-change").write_text("new source\n", encoding="utf-8")
        subprocess.run(["git", "add", "later-change"], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "-qm", "new source"], cwd=self.root, check=True)

        valid, reason = verify_candidate_cache(self.root, self.cache, self.runtime)

        self.assertFalse(valid)
        self.assertIn("source SHA", reason)

    def test_changed_lock_input_forbids_reuse_even_for_the_same_commit(self):
        self._create()
        target = self.root / INPUT_PATHS[0]
        target.write_text("different lock input\n", encoding="utf-8")

        valid, reason = verify_candidate_cache(self.root, self.cache, self.runtime)

        self.assertFalse(valid)
        self.assertIn("input", reason.lower())

    def test_changed_runner_toolchain_forbids_reuse(self):
        self._create()
        runtime = dict(self.runtime, go="go version go1.26.9 linux/amd64")

        valid, reason = verify_candidate_cache(self.root, self.cache, runtime)

        self.assertFalse(valid)
        self.assertIn("fingerprint", reason.lower())

    def test_tampered_candidate_archive_forbids_reuse(self):
        self._create()
        with self.archive.open("ab") as archive:
            archive.write(b"tampered")
        (self.cache / "build-candidate.tar").write_bytes(self.archive.read_bytes())

        valid, reason = verify_candidate_cache(self.root, self.cache, self.runtime)

        self.assertFalse(valid)
        self.assertIn("checksum", reason.lower())

    def test_foreign_sealed_provenance_cannot_be_cached(self):
        self._write_archive("other-source")

        with self.assertRaisesRegex(ValueError, "provenance"):
            self._create()

    def test_release_index_checksum_must_match_candidate_checksums(self):
        self._write_archive(self.source_sha[:7], bad_index_checksum=True)

        with self.assertRaisesRegex(ValueError, "checksum"):
            self._create()

    def test_archive_paths_must_not_escape_the_workspace(self):
        with tarfile.open(self.archive, "w") as archive:
            escaped = self.root / "escape.txt"
            escaped.write_text("outside candidate", encoding="utf-8")
            archive.add(escaped, arcname="../escape.txt")

        with self.assertRaisesRegex(ValueError, "unsafe path"):
            self._create()


if __name__ == "__main__":
    unittest.main()
