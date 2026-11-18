#!/usr/bin/env python3
"""Tests for the fail-closed source-to-harness overlay boundary."""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from reuse_candidate_overlay import (EXPECTED_DIFF, OVERLAY_PATHS, apply_harness_overlay,
                                     parse_and_validate_raw_diff, prepare_candidate_source)


def raw_entry(path: str, *, status: str = "M", old_mode: str = "100644",
              new_mode: str = "100644") -> bytes:
    if status == "A":
        old_mode = "000000"
    header = f":{old_mode} {new_mode} 0123456789 9876543210 {status}".encode("ascii")
    return header + b"\0" + path.encode("utf-8") + b"\0"


class ReuseCandidateOverlayTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def valid_raw_diff(self) -> bytes:
        return b"".join(raw_entry(path, status=status, old_mode=old, new_mode=new)
                        for path, (status, old, new) in sorted(EXPECTED_DIFF.items()))

    def test_raw_diff_accepts_only_exact_reviewed_paths_and_modes(self) -> None:
        self.assertEqual(set(parse_and_validate_raw_diff(self.valid_raw_diff())), set(OVERLAY_PATHS))

    def test_raw_diff_rejects_unexpected_path_missing_entry_and_duplicate(self) -> None:
        valid = self.valid_raw_diff()
        with self.assertRaisesRegex(ValueError, "unexpected=.*plugins/evil.py"):
            parse_and_validate_raw_diff(valid.replace(b"scripts/ci/journey-batch-selection.test.mjs",
                                                       b"plugins/evil.py"))
        with self.assertRaisesRegex(ValueError, "missing="):
            parse_and_validate_raw_diff(valid[:-len(raw_entry("scripts/ci/journey-batch-selection.test.mjs"))])
        duplicate = valid + raw_entry("e2e/journey/runner.py")
        with self.assertRaisesRegex(ValueError, "repeats path"):
            parse_and_validate_raw_diff(duplicate)

    def test_raw_diff_rejects_mode_changes_renames_deletes_and_symlinks(self) -> None:
        bad_cases = (
            (raw_entry("e2e/journey/runner.py", old_mode="100755"), "mismatched"),
            (raw_entry("e2e/journey/runner.py", status="R100"), "mismatched"),
            (raw_entry("e2e/journey/runner.py", status="D", new_mode="000000"), "mismatched"),
            (raw_entry("e2e/journey/runner.py", new_mode="120000"), "mismatched"),
        )
        for bad_entry, diagnostic in bad_cases:
            with self.subTest(bad_entry=bad_entry):
                raw = self.valid_raw_diff().replace(raw_entry("e2e/journey/runner.py"), bad_entry)
                with self.assertRaisesRegex(ValueError, diagnostic):
                    parse_and_validate_raw_diff(raw)

    def git(self, root: Path, *args: str) -> str:
        return subprocess.run(["git", "-C", str(root), *args], check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True).stdout.strip()

    def commit(self, root: Path, message: str) -> str:
        self.git(root, "add", "--all")
        self.git(root, "-c", "user.name=Journey Test", "-c", "user.email=journey@example.invalid",
                 "commit", "-m", message)
        return self.git(root, "rev-parse", "HEAD")

    # case: S-262.19
    def test_overlay_keeps_source_head_and_changes_only_five_allowlisted_files(self) -> None:
        harness = self.root / "harness"
        harness.mkdir()
        self.git(harness, "init", "-q")
        for path, (status, _, _) in EXPECTED_DIFF.items():
            if status == "M":
                target = harness / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("source\n", encoding="utf-8")
        (harness / "run.json").write_text('{"commit":"source-sha"}\n', encoding="utf-8")
        source_sha = self.commit(harness, "source")
        for path, (status, _, _) in EXPECTED_DIFF.items():
            target = harness / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"harness\r\n")
        harness_sha = self.commit(harness, "harness")
        source_root = self.root / "candidate-source"
        manifest_path = self.root / "overlay.json"

        manifest = prepare_candidate_source(harness, source_sha, harness_sha, source_root, manifest_path)

        self.assertEqual(self.git(source_root, "rev-parse", "HEAD"), source_sha)
        self.assertEqual(manifest["overlayPaths"], [], "validation does not overlay before artifact verification")
        self.assertEqual((source_root / OVERLAY_PATHS[0]).read_bytes(), b"source\n")
        self.assertEqual((source_root / "run.json").read_text(encoding="utf-8"),
                         '{"commit":"source-sha"}\n')

        manifest = apply_harness_overlay(harness, source_root, manifest_path)

        self.assertEqual(set(item["path"] for item in manifest["overlayPaths"]), set(OVERLAY_PATHS))
        for path in OVERLAY_PATHS:
            self.assertEqual((source_root / path).read_bytes(), b"harness\r\n")
        self.assertEqual((source_root / ".github/workflows/journey-batch.yml").read_bytes(),
                         b"source\n", "workflow control code is not copied into the source checkout")
        self.assertFalse((source_root / "e2e/journey/reuse_case_verdict.py").exists(),
                         "the verdict helper remains sourced from the harness checkout")
        self.assertIn("candidateSourceSha", manifest)
        self.assertIn("harnessSha", manifest)
        self.assertEqual((source_root / "run.json").read_text(encoding="utf-8"),
                         '{"commit":"source-sha"}\n', "producer identity is never rewritten")

    def test_unrelated_harness_ancestry_is_rejected(self) -> None:
        harness = self.root / "harness"
        unrelated = self.root / "unrelated"
        for root in (harness, unrelated):
            root.mkdir()
            self.git(root, "init", "-q")
            (root / "base.txt").write_text(root.name + "\n", encoding="utf-8")
            self.commit(root, "independent root")
        source_sha = self.git(unrelated, "rev-parse", "HEAD")
        harness_sha = self.git(harness, "rev-parse", "HEAD")
        with self.assertRaisesRegex(ValueError, "not an ancestor"):
            prepare_candidate_source(harness, source_sha, harness_sha,
                                     self.root / "candidate", self.root / "manifest.json")


if __name__ == "__main__":
    unittest.main()
