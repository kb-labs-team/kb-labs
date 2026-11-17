"""Focused contract tests for Steward's public artifact journey checks."""
from __future__ import annotations

import json
import unittest
from subprocess import CompletedProcess

from steward_artifact_steps import _backup, _review, _run_job, STEWARD_COLLECTIONS


class StewardArtifactStepTests(unittest.TestCase):
    def test_review_checks_exact_stale_and_upcoming_sections(self):
        review = ("# Steward daily review\n**last backup: never**\n"
                  "## Stale commitments (1)\nS301 stale (cmt1)\n"
                  "## Upcoming (1)\nS301 upcoming — 2026-11-18\n"
                  "## Active projects (1)\nS301 project\n")
        _review(review.encode(), stale_marker="S301 stale", upcoming_marker="S301 upcoming",
                project_marker="S301 project", expected_backup="last backup: never")

        misplaced = review.replace("## Upcoming (1)\nS301 upcoming", "## Stale commitments (1)\nS301 upcoming")
        with self.assertRaisesRegex(RuntimeError, "upcoming commitment .* in upcoming section"):
            _review(misplaced.encode(), stale_marker="S301 stale", upcoming_marker="S301 upcoming",
                    project_marker="S301 project", expected_backup="last backup: never")

    def test_backup_requires_both_distinct_commitments_and_all_collections(self):
        snapshot = {"exportedAt": 123, "collections": {name: [] for name in STEWARD_COLLECTIONS}}
        snapshot["collections"]["projects"] = [{"name": "S301 project"}]
        snapshot["collections"]["commitments"] = [
            {"text": "S301 stale"}, {"text": "S301 upcoming"},
        ]
        _backup(json.dumps(snapshot).encode(), project_marker="S301 project",
                stale_marker="S301 stale", upcoming_marker="S301 upcoming")

        snapshot["collections"]["commitments"].pop()
        with self.assertRaisesRegex(RuntimeError, "upcoming commitment"):
            _backup(json.dumps(snapshot).encode(), project_marker="S301 project",
                    stale_marker="S301 stale", upcoming_marker="S301 upcoming")

    def test_job_commands_use_configured_cli_path_and_registered_plugin_job_references(self):
        seen = []

        def runner(command, **_kwargs):
            seen.append(command)
            return CompletedProcess(command, 0, json.dumps({"ok": True, "data": {"status": "success"}}), "")

        for job_id in ("daily-review", "export-backup"):
            _run_job(job_id, project_root="/tmp/project",
                     env={"KB_JOURNEY_CLI_PATH": "/journey/bin/kb"}, runner=runner)
        self.assertEqual([command[0] for command in seen], ["/journey/bin/kb", "/journey/bin/kb"])
        self.assertEqual([arg for command in seen for arg in command if arg.startswith("--handler=")], [
            "--handler=plugin:@kb-labs/steward/job/daily-review",
            "--handler=plugin:@kb-labs/steward/job/export-backup",
        ])


if __name__ == "__main__":
    unittest.main()
