import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))
from commit_fixture import commit_fixture_source_version


class CommitFixtureTests(unittest.TestCase):
    def test_baseline_version_comes_from_the_commit_fixture_package(self):
        with tempfile.TemporaryDirectory(prefix="kb-commit-source-version-") as temporary:
            workspace = Path(temporary)
            package = workspace / "plugins/commit"
            package.mkdir(parents=True)
            (package / "package.json").write_text(
                '{"name":"@kb-labs/commit","version":"2.120.1"}', encoding="utf-8")

            self.assertEqual(commit_fixture_source_version(workspace), "2.120.1")

    def test_missing_commit_identity_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="kb-commit-source-version-") as temporary:
            workspace = Path(temporary)
            package = workspace / "plugins/commit"
            package.mkdir(parents=True)
            (package / "package.json").write_text('{"name":"other","version":"2.120.1"}', encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "missing package identity or version"):
                commit_fixture_source_version(workspace)
