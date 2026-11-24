from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import invocations
from journey_evidence import (apply_clean_install_case_evidence, capture_clean_install_artifacts,
                              clean_install_evidence_profile)
from scoreboard import build_scoreboard
from service_steps import Journey


class CleanInstallCaseEvidenceTests(unittest.TestCase):
    def test_profile_uses_observed_node_major_and_cli_surface(self):
        with patch("journey_evidence.platform.system", return_value="Linux"), \
             patch("journey_evidence.subprocess.run") as run:
            run.return_value.stdout = "v24.1.0\n"
            self.assertEqual(clean_install_evidence_profile(), {
                "os": "linux", "runtime": "node-24", "surface": "cli",
            })

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
            evidence_run_id = "installer-local-attempt-one"
            attempt_root = report_root / "qa-attempts" / evidence_run_id
            with invocations.invocation_context(report_root=attempt_root, step_id="PC-001.2"):
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
                report_root=report_root, run_id=evidence_run_id, claim_id="PC-001.2",
                config_path=config_link, installation_root=platform_root,
                invocation_log_path=attempt_root / "invocations" / "calls.jsonl",
            )
            result = apply_clean_install_case_evidence(
                case_run, journey.result().__dict__["steps"], claim_id="PC-001.2",
                profile={"os": "linux-x64", "runner": "service-local:explore"},
                candidate_digest=digest, candidate_verified=provenance.status == "PASS",
                artifacts=artifacts, evidence_run_id=evidence_run_id,
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
    def test_successive_attempts_keep_candidate_profile_and_step_logs_separate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            report_root = root / "run-record"
            report_root.mkdir()
            platform_root = root / "platform"
            config_target = platform_root / "state" / "kb.config.jsonc"
            config_target.parent.mkdir(parents=True)
            config_link = platform_root / "current" / ".kb" / "kb.config.jsonc"
            config_link.parent.mkdir(parents=True)
            config_link.symlink_to(Path("../../state/kb.config.jsonc"))
            results = []

            for suffix, output, profile, digest in (
                ("one", "first attempt", {"os": "linux-x64", "runner": "service-local:explore"}, "1" * 64),
                ("two", "second attempt", {"os": "linux-arm64", "runner": "service-secured:explore"}, "2" * 64),
            ):
                config_target.write_text(json.dumps({"attempt": suffix, "port": 4000}) + "\n")
                Journey.reset_run_registry()
                journey = Journey("local", "installer-local")
                provenance = journey.step("candidate provenance", "journey.orchestration", lambda: None)
                evidence_run_id = f"installer-local-{suffix}"
                attempt_root = report_root / "qa-attempts" / evidence_run_id
                with invocations.invocation_context(report_root=attempt_root, step_id="PC-001.2"):
                    command = invocations.run_command(
                        [sys.executable, "-c", f"print({output!r})"], cwd=root,
                        env={"KB_JOURNEY_HOME_LABEL": "main"}, timeout=10,
                    )
                journey.step("clean install leaves a running host", "platform.install",
                              lambda: None if command.returncode == 0 else "installer failed",
                              cases=["PC-001.2"])
                case_run = journey.result().__dict__["case_run"]
                artifacts = capture_clean_install_artifacts(
                    report_root=report_root, run_id=evidence_run_id, claim_id="PC-001.2",
                    config_path=config_link, installation_root=platform_root,
                    invocation_log_path=attempt_root / "invocations" / "calls.jsonl",
                )
                results.append((apply_clean_install_case_evidence(
                    case_run, journey.result().__dict__["steps"], claim_id="PC-001.2", profile=profile,
                    candidate_digest=digest, candidate_verified=provenance.status == "PASS",
                    artifacts=artifacts, evidence_run_id=evidence_run_id,
                ), report_root))

            first, second = results
            self.assertNotEqual(first[0]["runId"], second[0]["runId"])
            self.assertEqual(first[0]["candidateId"], f"sha256:{'1' * 64}")
            self.assertEqual(second[0]["candidateId"], f"sha256:{'2' * 64}")
            self.assertNotEqual(first[0]["profile"], second[0]["profile"])
            first_claim, second_claim = first[0]["claims"][0], second[0]["claims"][0]
            first_log = (first[1] / first_claim["logRef"]).read_text()
            second_log = (second[1] / second_claim["logRef"]).read_text()
            first_config = (first[1] / first_claim["configRef"]).read_text()
            second_config = (second[1] / second_claim["configRef"]).read_text()
            self.assertIn("first attempt", first_log)
            self.assertNotIn("second attempt", first_log)
            self.assertIn("second attempt", second_log)
            self.assertNotIn("first attempt", second_log)
            self.assertIn('"attempt": "one"', first_config)
            self.assertIn('"attempt": "two"', second_config)
            self.assertNotEqual(first_claim["logRef"], second_claim["logRef"])
            self.assertNotEqual(first_claim["configRef"], second_claim["configRef"])

    # case: S-315.2
    def test_failed_provenance_and_invalid_utf8_log_never_make_valid_candidate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            report_root = root / "run-record"
            report_root.mkdir()
            evidence_run_id = "installer-failed-attempt"
            attempt_root = report_root / "qa-attempts" / evidence_run_id
            calls = attempt_root / "invocations" / "calls.jsonl"
            calls.parent.mkdir(parents=True)
            calls.write_bytes(b'{"step_id":"PC-001.2","stdout":"invalid \xff byte"}\n')
            case_run = {
                "schema": "kb.qa-case-run/v2", "runId": "installer-failed", "mode": "local",
                "claims": [{"claimId": "PC-001.2", "kind": "journey", "status": "FAIL"}],
            }
            steps = [{"name": "candidate provenance", "status": "FAIL", "details": {"candidateCommit": "mismatch"}}]
            artifacts = capture_clean_install_artifacts(
                report_root=report_root, run_id=evidence_run_id, claim_id="PC-001.2",
                config_path=root / "missing-config", installation_root=root,
                invocation_log_path=calls,
            )
            result = apply_clean_install_case_evidence(
                case_run, steps, claim_id="PC-001.2", profile={}, candidate_digest="b" * 64,
                candidate_verified=False, artifacts=artifacts, evidence_run_id=evidence_run_id,
            )

            self.assertEqual(result["claims"][0]["status"], "FAIL")
            self.assertNotIn("candidateId", result)
            self.assertNotIn("configRef", result["claims"][0])
            self.assertIn("logRef", result["claims"][0])
            self.assertIn("\ufffd", (report_root / result["claims"][0]["logRef"]).read_text())

    # case: S-315.2
    def test_targeted_case_run_keeps_selection_in_generated_scoreboard(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            reports = root / "reports"
            catalog = root / "catalog"
            reports.mkdir()
            catalog.mkdir()
            (catalog / "PC-001-clean-install.md").write_text(
                "---\nid: PC-001\ntitle: Clean install\nstatus: active\nrelease: false\n"
                "modes: [local]\n---\n"
                "| PC-001.1 | First observable result | expected result |\n"
                "| PC-001.2 | Install is running | expected result |\n",
                encoding="utf-8",
            )
            case_run = {
                "schema": "kb.qa-case-run/v2", "runId": "targeted-install", "mode": "local",
                "selection": ["PC-001.2"], "selectedClaims": ["PC-001.2"],
                "claims": [
                    {"claimId": "PC-001.1", "kind": "journey", "status": "PASS"},
                    {"claimId": "PC-001.2", "kind": "journey", "status": "PASS"},
                ],
            }
            result = apply_clean_install_case_evidence(
                case_run, [{"name": "candidate provenance", "status": "PASS"}], claim_id="PC-001.2",
                profile={}, candidate_digest=None, candidate_verified=False,
                artifacts={}, evidence_run_id="targeted-install",
            )
            (reports / "installer-case-local-agent-commit-default.json").write_text(
                json.dumps({"case_run": result, "steps": []}), encoding="utf-8",
            )

            scoreboard = build_scoreboard(reports, catalog, ["local"])

            self.assertEqual(scoreboard["selection"], ["PC-001.2"])
            pc_case = next(item for item in scoreboard["cases"] if item["id"] == "PC-001")
            self.assertEqual(pc_case["claimedCount"], 0)


if __name__ == "__main__":
    unittest.main()
