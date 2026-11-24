import json
import tempfile
import unittest
from pathlib import Path

from gateway_sessions import SavedGatewaySession


class SavedGatewaySessionTests(unittest.TestCase):
    def test_expire_and_remove_only_the_selected_origin(self):
        with tempfile.TemporaryDirectory() as home:
            path = Path(home) / "sessions.json"
            other = {"gatewayUrl": "https://other.test", "expiresAt": 77}
            target = {"gatewayUrl": "https://gateway.test", "expiresAt": 99}
            path.write_text(json.dumps({"version": 1, "sessions": [other, target]}))
            status = {"sessions": [
                {**other, "authenticated": True, "path": "/unrelated"},
                {**target, "authenticated": True, "path": str(path)},
            ]}
            selected = SavedGatewaySession.from_status(status, "https://gateway.test:443/path")
            selected.expire()
            self.assertEqual(json.loads(path.read_text())["sessions"], [other, {**target, "expiresAt": 0}])
            selected.remove()
            self.assertEqual(json.loads(path.read_text())["sessions"], [other])

    def test_missing_and_ambiguous_gateway_fail_without_fallback(self):
        record = {"gatewayUrl": "https://gateway.test", "authenticated": True, "path": "/unrelated"}
        for entries, gateway in (([record], "https://other.test"), ([record, record], "https://gateway.test")):
            with self.subTest(gateway=gateway), self.assertRaises(AssertionError):
                SavedGatewaySession.from_status({"sessions": entries}, gateway)
