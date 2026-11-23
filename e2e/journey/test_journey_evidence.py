from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from journey_evidence import collect_clean_install_case_evidence


class CleanInstallCaseEvidenceTests(unittest.TestCase):
    # case: S-315.2
    def test_collects_redacted_config_and_only_observed_step_invocations(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            report_root = root / "run"
            report_root.mkdir()
            config = root / "kb.config.jsonc"
            config.write_text('{\n// generated config\n"gateway":{"token":"long-test-secret-value","clientSecret":"literal-secret",},"port":4000,\n}\n')
            calls = report_root / "invocations" / "calls.jsonl"
            calls.parent.mkdir(parents=True)
            calls.write_text("\n".join(json.dumps(record) for record in [
                {"step_id": "PC-001.2", "kind": "command", "argv": ["kb-create", "install"], "stdout": "installed"},
                {"step_id": "PC-001.4", "kind": "command", "argv": ["kb-create", "apply"], "stdout": "not this step"},
            ]) + "\n")
            case_run = {
                "schema": "kb.qa-case-run/v2", "runId": "installer-local", "mode": "local",
                "claims": [{"claimId": "PC-001.2", "kind": "journey", "status": "PASS"}],
            }
            steps = [{"name": "candidate provenance", "status": "PASS", "details": {"candidateCommit": "abc123"}}]
            with patch.dict("os.environ", {"LONG_TEST_TOKEN": "long-test-secret-value"}, clear=False):
                result = collect_clean_install_case_evidence(
                    case_run, steps, report_root=report_root, config_path=config,
                    invocation_log_path=calls,
                    profile={"os": "linux-x64", "runner": "service-local:explore"},
                )

            self.assertEqual(result["schema"], "kb.qa-case-run/v3")
            self.assertEqual(result["candidateId"], "git:abc123")
            claim = result["claims"][0]
            self.assertEqual(claim["status"], "PASS")
            config_artifact = report_root / claim["configRef"]
            log_artifact = report_root / claim["logRef"]
            config_contents = config_artifact.read_text()
            log_contents = log_artifact.read_text()
            self.assertNotIn("long-test-secret-value", config_contents)
            self.assertNotIn("literal-secret", config_contents)
            self.assertIn("[REDACTED]", config_contents)
            self.assertIn("installed", log_contents)
            self.assertNotIn("not this step", log_contents)
            self.assertEqual(claim["configDigest"], hashlib.sha256(config_artifact.read_bytes()).hexdigest())
            self.assertEqual(claim["logDigest"], hashlib.sha256(log_artifact.read_bytes()).hexdigest())

    # case: S-315.2
    def test_missing_artifacts_or_candidate_never_fabricate_complete_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            root.mkdir(exist_ok=True)
            result = collect_clean_install_case_evidence(
                {"schema": "kb.qa-case-run/v2", "runId": "r1", "mode": "local",
                 "claims": [{"claimId": "PC-001.2", "kind": "journey", "status": "FAIL"}]},
                [{"name": "candidate provenance", "status": "FAIL", "details": {"identityError": "absent"}}],
                report_root=root, config_path=root / "missing-config", invocation_log_path=root / "missing-calls",
                profile={},
            )
            self.assertNotIn("candidateId", result)
            self.assertNotIn("profile", result)
            claim = result["claims"][0]
            self.assertEqual(claim["status"], "FAIL")
            self.assertNotIn("configRef", claim)
            self.assertNotIn("configDigest", claim)
            self.assertNotIn("logRef", claim)
            self.assertNotIn("logDigest", claim)


if __name__ == "__main__":
    unittest.main()
