import unittest
from pathlib import Path
import sys
import subprocess
import tempfile
import socket

sys.path.insert(0, str(Path(__file__).parent))
from central_registry_gateway import CentralRegistryGatewayFixture, _loopback_port_available, _fixture_config


class CentralRegistryGatewayFixtureTests(unittest.TestCase):
    def test_fixture_port_probe_detects_a_busy_loopback_port(self):
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            port = occupied.getsockname()[1]

            self.assertFalse(_loopback_port_available(port))
        self.assertTrue(_loopback_port_available(0))

    def test_runner_image_provides_the_standard_kb_dev_command(self):
        dockerfile = (Path(__file__).parent / "Dockerfile.runner").read_text()

        self.assertIn("COPY --from=release-index-sealer /out/kb-dev /usr/local/bin/kb-dev", dockerfile)

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

    def test_failed_start_reports_redacted_kb_dev_logs(self):
        with tempfile.TemporaryDirectory(prefix="journey-central-gateway-platform-") as temp:
            entry = Path(temp) / "node_modules/@kb-labs/gateway-app/dist/bin.js"
            entry.parent.mkdir(parents=True)
            entry.write_text("// fixture entry")
            calls = []
            def runner(argv, **_kwargs):
                calls.append(argv)
                if argv[1] == "start":
                    return subprocess.CompletedProcess(argv, 1, "", "KB_RUNTIME_COMMAND_FAILED")
                return subprocess.CompletedProcess(argv, 0,
                    "ERROR gateway failed to bind; GATEWAY_INTERNAL_SECRET=fixture-internal-secret-value\n", "")

            with self.assertRaisesRegex(RuntimeError, "gateway failed to bind") as raised:
                CentralRegistryGatewayFixture.start(
                    Path(temp), "http://marketplace-tamper:8081", "fixture-internal-secret-value",
                    runner=runner)

            self.assertIn("[REDACTED]", str(raised.exception))
            self.assertNotIn("fixture-internal-secret-value", str(raised.exception))
            self.assertIn("node_path=", str(raised.exception))
            self.assertIn("port_available_before_start=true", str(raised.exception))
            self.assertEqual([call[1] for call in calls], ["start", "logs"])


if __name__ == "__main__":
    unittest.main()
