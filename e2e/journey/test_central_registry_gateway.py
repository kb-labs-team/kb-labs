import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))
from central_registry_gateway import _fixture_config


class CentralRegistryGatewayFixtureTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
