import json
import tempfile
import unittest
from pathlib import Path

from batch_summary import requested_area, write_mode_metadata


class ProductAreaBatchSummaryTests(unittest.TestCase):
    # case: S-262.18
    def test_area_batch_metadata_keeps_product_area_and_resolved_case_ids(self):
        with tempfile.TemporaryDirectory(prefix="journey-area-metadata-") as temporary:
            root = Path(temporary)
            source = root / "shared.json"
            destination = root / "mode.json"
            source.write_text(json.dumps({"stageDurationsSeconds": {
                "reset": 0, "build": 0, "unit": 0, "candidate": 0,
                "local": 0, "secured": 0, "total": 0,
            }}))

            write_mode_metadata(source, destination, "local", "PASS", 12,
                                "S-010,S-268", "", "marketplace", "S-026")

            metadata = json.loads(destination.read_text())
        self.assertEqual(metadata["requestedArea"], "marketplace")
        self.assertEqual(metadata["requestedSelection"], ["S-010", "S-268"])
        self.assertEqual(metadata["requestedAreaUncoveredCases"], ["S-026"])

    # case: S-262.18
    def test_area_summary_selection_is_validated_and_distinct_from_full_batch(self):
        self.assertEqual(requested_area("@area:studio"), "studio")
        self.assertIsNone(requested_area("S-120,S-121"))
        for invalid in ("@area:", "@area:Studio", "@area:studio all"):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "product area selection"):
                requested_area(invalid)


if __name__ == "__main__":
    unittest.main()
