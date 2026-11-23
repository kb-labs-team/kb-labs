from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

import invocations
from journey_evidence import apply_clean_install_case_evidence, capture_clean_install_artifacts
from service_steps import Journey


class CleanInstallCaseEvidenceTests(unittest.TestCase):
    # case: S-315.2
    def test_real_journey_invocation_and_platform_config_symlink_are_captured(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            report_root = root / "run-record"
            report_root.mkdir()
            platform_root = root / "platform"
            config_target = platform_root / "state" / "kb.config.jsonc"
            config_target.parent.mkdir(parents=True)
            config_target.write_text(
                '{\n// installed config\n"databaseUrl":"redis://journey:p%40ss@cache.internal:6379/0",\n}\n'
            )
            config_link = platform_root / "current" / ".kb" / "kb.config.jsonc"
            config_link.parent.mkdir(parents=True)
            config_link.symlink_to(Path("../../state/kb.config.jsonc"))

            Journey.reset_run_registry()
            journey = Journey("local", "installer-local")
            provenance = journey.step(
                "candidate provenance", "journey.orchestration", lambda: None,
                details=lambda: {"candidateCommit": "source-commit"},
            )
            with invocations.invocation_context(report_root=report_root, step_id="PC-001.2"):
                command = invocations.run_command(
                    [sys.executable, "-c", "print('install complete redis://journey:p%40ss@cache.internal:6379/0')"],
                    cwd=root,
                    env={"KB_JOURNEY_HOME_LABEL": "main"},
                    timeout=10,
                )
            journey.step("clean install leaves a running host", "platform.install",
                          lambda: None if command.returncode == 0 else "installer failed",
                          cases=["PC-001.2"])
            case_run = journey.result().__dict__["case_run"]
            digest = "a" * 64
            artifacts = capture_clean_install_artifacts(
                report_root=report_root, run_id=case_run["runId"],
                config_path=config_link, installation_root=platform_root,
                invocation_log_path=report_root / "invocations" / "calls.jsonl",
            )
            result = apply_clean_install_case_evidence(
                case_run, journey.result().__dict__["steps"],
                profile={"os": "linux-x64", "runner": "service-local:explore"},
                candidate_digest=digest, candidate_verified=provenance.status == "PASS",
                artifacts=artifacts,
            )

            self.assertEqual(result["schema"], "kb.qa-case-run/v3")
            self.assertEqual(result["candidateId"], f"sha256:{digest}")
            claim = result["claims"][0]
            self.assertEqual(claim["status"], "PASS")
            self.assertEqual(claim["configDigest"], hashlib.sha256((report_root / claim["configRef"]).read_bytes()).hexdigest())
            self.assertEqual(claim["logDigest"], hashlib.sha256((report_root / claim["logRef"]).read_bytes()).hexdigest())
            config_contents = (report_root / claim["configRef"]).read_text()
            log_contents = (report_root / claim["logRef"]).read_text()
            self.assertIn("[REDACTED]@cache.internal", config_contents)
            self.assertIn("[REDACTED]@cache.internal", log_contents)
            self.assertNotIn("p%40ss", config_contents + log_contents)
            self.assertIn("install complete", log_contents)

    # case: S-315.2
    def test_failed_provenance_and_invalid_utf8_log_never_make_valid_candidate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            report_root = root / "run-record"
            report_root.mkdir()
            calls = report_root / "invocations" / "calls.jsonl"
            calls.parent.mkdir()
            calls.write_bytes(b'{"step_id":"PC-001.2","stdout":"invalid \xff byte"}\n')
            case_run = {
                "schema": "kb.qa-case-run/v2", "runId": "installer-failed", "mode": "local",
                "claims": [{"claimId": "PC-001.2", "kind": "journey", "status": "FAIL"}],
            }
            steps = [{"name": "candidate provenance", "status": "FAIL", "details": {"candidateCommit": "mismatch"}}]
            artifacts = capture_clean_install_artifacts(
                report_root=report_root, run_id=case_run["runId"],
                config_path=root / "missing-config", installation_root=root,
                invocation_log_path=calls,
            )
            result = apply_clean_install_case_evidence(
                case_run, steps, profile={}, candidate_digest="b" * 64,
                candidate_verified=False, artifacts=artifacts,
            )

            self.assertEqual(result["claims"][0]["status"], "FAIL")
            self.assertNotIn("candidateId", result)
            self.assertNotIn("configRef", result["claims"][0])
            self.assertIn("logRef", result["claims"][0])
            self.assertIn("\ufffd", (report_root / result["claims"][0]["logRef"]).read_text())


if __name__ == "__main__":
    unittest.main()
