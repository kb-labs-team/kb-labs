from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from invocations import catalogued_error_hint
from secured_connection_steps import (validate_case_response, validate_cli_case,
                                      validate_hidden_health_response, validate_local_health_response)


class SecuredConnectionContractTests(unittest.TestCase):
    # The fake gateway/CLI failure is deliberately supplied to every exact claim
    # validator; each documented step must turn that failure into a red claim.
    def test_fake_gateway_failures_make_each_http_claim_red(self):
        for case_id in ("S-042.1", "S-042.2", "S-042.3", "S-042.5", "S-042.6",
                        "S-005.4", "S-005.5"):
            with self.subTest(case_id=case_id), self.assertRaisesRegex(AssertionError, case_id):
                validate_case_response(case_id, 503, {}, expected="gateway.test")

    def test_fake_cli_failures_make_each_cli_claim_red(self):
        for case_id in ("S-005.2", "S-005.3", "S-031.1", "S-031.2",
                        "S-031.3", "S-031.4", "S-042.4"):
            with self.subTest(case_id=case_id), self.assertRaisesRegex(AssertionError, case_id):
                validate_cli_case(case_id, 1, "simulated command failure with stack trace", {})

    def test_s041_15_requires_identical_hidden_not_found_responses(self):
        health_body = {"ok": False, "error": {
            "code": "KB_RUNTIME_RESOURCE_NOT_FOUND", "message": "Resource not found.",
            "correlationId": "health-request",
        }}
        unknown_body = {"ok": False, "error": {
            "code": "KB_RUNTIME_RESOURCE_NOT_FOUND", "message": "Resource not found.",
            "correlationId": "unknown-request",
        }}
        validate_hidden_health_response(404, health_body, 404, unknown_body)

        for health_status, body in (
            (200, health_body),
            (404, {"ok": False, "error": {**health_body["error"], "code": "KB_AUTH_REQUIRED"}}),
            (404, {"ok": False, "error": {**health_body["error"], "activeAdmins": 0}}),
            (404, {"ok": False, "error": {**health_body["error"], "message": "different"}}),
            (404, {"ok": False, "error": {"code": "KB_RUNTIME_RESOURCE_NOT_FOUND"}, "readiness": {}}),
        ):
            with self.subTest(status=health_status, body=body), self.assertRaises(AssertionError):
                validate_hidden_health_response(health_status, body, 404, unknown_body)

    def test_s041_15_requires_local_anonymous_readiness_output(self):
        readiness = {"authEnabled": True, "tenantId": "tenant", "activeAdmins": 1,
                     "bootstrap": {"status": "ready"}, "issues": []}
        validate_local_health_response(200, {"ok": True, "data": readiness})
        for status, body in ((401, {"ok": False}), (200, {"ok": True, "data": {}})):
            with self.subTest(status=status, body=body), self.assertRaises(AssertionError):
                validate_local_health_response(status, body)

    def test_s031_session_status_requires_the_canonical_path(self):
        payload = {"ok": True, "data": {"sessions": [{
            "authenticated": True, "tokenExpired": True, "gatewayUrl": "https://gateway.test",
            "path": "/tmp/cli-home/.kb/session.json",
        }]}}
        validate_cli_case("S-031.1", 0, "", payload, gateway="https://gateway.test")
        payload["data"]["sessions"][0].pop("path")
        with self.assertRaisesRegex(AssertionError, "S-031.1"):
            validate_cli_case("S-031.1", 0, "", payload, gateway="https://gateway.test")

    def test_s042_reset_link_requires_the_enveloped_reset_url_and_expiry(self):
        payload = {"ok": True, "data": {"resetUrl": "https://gateway.test/reset/secret", "expiresAt": 123456}}
        validate_cli_case("S-042.4", 0, "", payload)
        with self.assertRaisesRegex(AssertionError, "S-042.4"):
            validate_cli_case("S-042.4", 0, "", {"ok": True, "reset_token": "secret"})

    def test_case_specific_denial_and_consumption_responses_pass(self):
        validate_case_response("S-042.3", 422,
                               {"code": "KB_AUTH_INVALID_INVITE", "hint": "Request a new invite"})
        validate_case_response("S-042.6", 400, {
            "code": "KB_AUTH_INVALID_PASSWORD_RESET", "hint": "Request a new link",
        })
        validate_case_response("S-005.5", 403, {
            "code": "KB_AUTH_FORBIDDEN", "message": "Permission denied: users:read", "hint": "Ask an administrator",
        })

    def test_revoked_session_sign_in_hint_is_not_mistaken_for_a_stack_trace(self):
        validate_cli_case(
            "S-031.3", 1,
            "KB_AUTH_SESSION_REVOKED: The saved Gateway session was revoked. "
            + catalogued_error_hint("KB_AUTH_SESSION_REVOKED", gatewayUrl="<url>"),
        )

    def test_client_apply_claim_requires_client_profile_empty_services_and_shim(self):
        sealed_index = {"provenance": [{
            "package": "@kb-labs/cli-bin", "version": "2.0.0", "sourceRevision": "candidate-revision",
            "integrity": "sha512-candidate-integrity", "contentScope": "dist", "distSha256": "candidate-dist-digest",
        }]}
        payload = {"ok": True, "data": {
            "profile": "client", "services": [], "shim": {"path": "/tmp/kb"},
            "receipt": {"plan": {
                "request": {"platformRoot": "/tmp/client"},
                "artifacts": [{
                    "package": "@kb-labs/cli-bin", "version": "2.0.0",
                    "provenance": {
                        "sourceRevision": "candidate-revision", "integrity": "sha512-candidate-integrity",
                        "contentScope": "dist", "distSha256": "candidate-dist-digest",
                    },
                }],
            }},
        }}
        validate_cli_case("S-005.1", 0, "", payload, root="/tmp/client", sealed_index=sealed_index)
        for key, value in (("profile", "default"), ("services", ["gateway"]), ("shim", None)):
            invalid = {**payload, "data": {**payload["data"], key: value}}
            with self.subTest(key=key), self.assertRaisesRegex(AssertionError, "S-005.1"):
                validate_cli_case("S-005.1", 0, "", invalid, root="/tmp/client", sealed_index=sealed_index)

        invalid_provenance = {**payload, "data": {**payload["data"], "receipt": {"plan": {
            **payload["data"]["receipt"]["plan"], "artifacts": [{
                **payload["data"]["receipt"]["plan"]["artifacts"][0],
                "provenance": {"sourceRevision": "candidate-revision"},
            }],
        }}}}
        with self.assertRaisesRegex(AssertionError, "S-005.1"):
            validate_cli_case("S-005.1", 0, "", invalid_provenance,
                              root="/tmp/client", sealed_index=sealed_index)


if __name__ == "__main__":
    unittest.main()
