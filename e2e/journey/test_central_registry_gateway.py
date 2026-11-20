import json
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))
from central_registry_gateway import (
    CentralRegistryGatewayFixture,
    _fixture_config,
    _structured_start_failure,
)


class CentralRegistryGatewayFixtureTests(unittest.TestCase):
    def test_runner_image_provides_the_standard_kb_dev_command(self):
        dockerfile = (Path(__file__).parent / "Dockerfile.runner").read_text()

        self.assertIn("COPY --from=release-index-sealer /out/kb-dev /usr/local/bin/kb-dev", dockerfile)

    def test_start_failure_extracts_only_allowlisted_manager_diagnostics(self):
        payload = {
            "ok": False,
            "error": {"code": "KB_RUNTIME_COMMAND_FAILED", "message": "never expose this secret-like message"},
            "data": {
                "ok": False,
                "actions": [{
                    "service": "gateway",
                    "action": "failed",
                    "errorCode": "health_check_failed",
                    "logPath": "/tmp/fixture/.kb/logs/gateway.log",
                    "error": "never expose raw stderr",
                }],
            },
        }
        evidence = _structured_start_failure(json.dumps(payload), "", 1)

        self.assertEqual(evidence, {
            "errorCode": "health_check_failed",
            "logPath": "/tmp/fixture/.kb/logs/gateway.log",
        })
        self.assertNotIn("never expose", json.dumps(evidence))

    def test_start_failure_rejects_untyped_or_unknown_error_details(self):
        payload = {
            "ok": False,
            "error": {"code": "KB_RUNTIME_COMMAND_FAILED", "message": "unsafe message"},
            "data": {"ok": False, "actions": [{
                "service": "gateway", "action": "failed",
                "errorCode": "unsafe-stderr-fragment", "logPath": "/tmp/gateway.log",
            }]},
        }
        self.assertIsNone(_structured_start_failure(json.dumps(payload), "", 1))
        payload["data"]["actions"][0]["errorCode"] = ["health_check_failed"]
        self.assertIsNone(_structured_start_failure(json.dumps(payload), "", 1))
        self.assertIsNone(_structured_start_failure("not json with unsafe-stderr-fragment", "", 1))
        self.assertIsNone(_structured_start_failure(json.dumps(payload), "", 0))

    def test_gateway_fixture_reports_typed_start_failure_without_process_text(self):
        payload = {
            "ok": False,
            "error": {"code": "KB_RUNTIME_COMMAND_FAILED", "message": "unsafe process message"},
            "data": {"ok": False, "actions": [{
                "service": "gateway", "action": "failed",
                "errorCode": "health_check_failed", "logPath": "/tmp/fixture/gateway.log",
                "error": "unsafe raw stderr",
            }]},
        }
        calls = []

        def fake_runner(argv, **_kwargs):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 1, json.dumps(payload), "unsafe shell stderr")

        with tempfile.TemporaryDirectory() as temp:
            platform_root = Path(temp)
            gateway_entry = platform_root / "node_modules/@kb-labs/gateway-app/dist/bin.js"
            gateway_entry.parent.mkdir(parents=True)
            gateway_entry.write_text("synthetic entrypoint")
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            with self.assertRaisesRegex(RuntimeError, "manager_error_code=health_check_failed") as raised:
                CentralRegistryGatewayFixture.start(
                    platform_root, "http://127.0.0.1:9", "fixture-secret", port=port, runner=fake_runner)

        self.assertIn("manager_log_path=/tmp/fixture/gateway.log", str(raised.exception))
        self.assertNotIn("unsafe", str(raised.exception))
        self.assertIn("--json", calls[0])

    def test_central_author_gateway_is_distinct_secured_and_narrowly_routed(self):
        config, service_yaml = _fixture_config(
            port=43191,
            gateway_entry=Path("/platform/node_modules/@kb-labs/gateway-app/dist/bin.js"),
            proxy_url="http://marketplace-tamper:8081",
            internal_secret="fixture-only-internal-secret",
            password="fixture-only-author-password",
            jwt_secret="fixture-only-jwt-secret",
        )
        self.assertEqual(config["gateway"]["access"]["mode"], "secured")
        self.assertEqual(config["gateway"]["auth"]["bootstrap"]["tenantId"], "journey-hub-author")
        self.assertEqual(config["gateway"]["upstreams"]["marketplaceRegistry"], {
            "serviceId": "marketplace-registry",
            "prefix": "/api/v1/marketplace-registry/api/v1",
            "rewritePrefix": "/api/v1",
        })
        self.assertEqual(config["platform"]["adapterOptions"]["serviceTransport"]["services"]
                         ["marketplace-registry"]["url"], "http://marketplace-tamper:8081")
        self.assertIn("GATEWAY_BOOTSTRAP_ADMIN_PASSWORD", service_yaml)
        self.assertIn("GATEWAY_JWT_SECRET", service_yaml)
        self.assertNotIn("127.0.0.1:4000", service_yaml)
        self.assertNotIn("__journey/faults", service_yaml)


if __name__ == "__main__":
    unittest.main()
