from __future__ import annotations

import os
from pathlib import Path
import stat
import tempfile
import unittest

import report_directory_guard


class ReportDirectoryGuardTests(unittest.TestCase):
    def test_creates_missing_directory_owned_by_runner(self):
        with tempfile.TemporaryDirectory(prefix="journey-report-owner-") as temp:
            root = Path(temp)
            reports = root / "reports"
            evidence = root / "reports-owner.log"

            report_directory_guard.ensure_report_directory(reports, evidence)

            metadata = reports.lstat()
            self.assertTrue(stat.S_ISDIR(metadata.st_mode))
            self.assertEqual(metadata.st_uid, os.getuid())
            self.assertEqual(metadata.st_gid, os.getgid())
            self.assertEqual(metadata.st_mode & 0o700, 0o700)
            self.assertEqual(metadata.st_mode & 0o022, 0)
            self.assertIn("phase=before-create", evidence.read_text())
            self.assertIn("phase=after-create", evidence.read_text())

    def test_does_not_change_existing_safe_directory_mode(self):
        with tempfile.TemporaryDirectory(prefix="journey-report-owner-") as temp:
            root = Path(temp)
            reports = root / "reports"
            reports.mkdir(mode=0o700)
            reports.chmod(0o700)
            before_mode = stat.S_IMODE(reports.lstat().st_mode)

            report_directory_guard.ensure_report_directory(reports, root / "evidence.log")

            self.assertEqual(stat.S_IMODE(reports.lstat().st_mode), before_mode)

    def test_rejects_insecure_existing_directory_without_changing_it(self):
        with tempfile.TemporaryDirectory(prefix="journey-report-owner-") as temp:
            root = Path(temp)
            reports = root / "reports"
            reports.mkdir(mode=0o777)
            reports.chmod(0o777)
            evidence = root / "evidence.log"

            with self.assertRaisesRegex(report_directory_guard.ReportDirectoryError, "unsafe mode"):
                report_directory_guard.ensure_report_directory(reports, evidence)

            self.assertEqual(stat.S_IMODE(reports.lstat().st_mode), 0o777)
            self.assertIn("phase=before-create", evidence.read_text())

    def test_rejects_report_symlink(self):
        with tempfile.TemporaryDirectory(prefix="journey-report-owner-") as temp:
            root = Path(temp)
            reports = root / "reports"
            target = root / "target"
            target.mkdir()
            reports.symlink_to(target, target_is_directory=True)

            with self.assertRaisesRegex(report_directory_guard.ReportDirectoryError, "real directory"):
                report_directory_guard.ensure_report_directory(reports, root / "evidence.log")


if __name__ == "__main__":
    unittest.main()
