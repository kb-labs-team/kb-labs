import json
import unittest
from pathlib import Path

from release_index import stable_platform_version


class ReleaseIndexTest(unittest.TestCase):
    def test_reads_stable_version_from_sealed_v2_index(self):
        fixture = Path(__file__).parents[1] / "platform" / "fixtures" / "release-index-v2.json"
        index = json.loads(fixture.read_text())
        platform = next(artifact for artifact in index["platforms"] if artifact["id"] == "platform")
        self.assertEqual(stable_platform_version(index), platform["version"])

    def test_reads_canary_version_by_channel_name(self):
        from release_index import channel_platform_version
        index = {"channels": {"canary": "2.120.3-canary.1"}}
        self.assertEqual(channel_platform_version(index, "canary"), "2.120.3-canary.1")
