from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from invocations import _catalog_exit_status, read_kb_create_cli_result
import jsonl


ROOT = Path(__file__).resolve().parents[2]
TESTDATA = Path(__file__).parent / "testdata"


def catalogued_exit(code: str) -> int:
    return _catalog_exit_status(code)[1]


def read_recorded_fixtures(root: Path) -> int:
    checked = 0
    for status_file in sorted(root.rglob("*.exit")):
        fixture_base = Path(str(status_file)[:-len(".exit")])
        command_file = Path(f"{fixture_base}.command")
        if not command_file.is_file():
            raise AssertionError(f"recorded CLI result {status_file} has no .command metadata")
        output_path = next((Path(f"{fixture_base}{suffix}") for suffix in (".json", ".jsonl")
                            if Path(f"{fixture_base}{suffix}").is_file()), None)
        if output_path is None:
            raise AssertionError(f"recorded CLI result {status_file} has no JSON output")
        command = command_file.read_text(encoding="utf-8").strip()
        returncode = int(status_file.read_text(encoding="utf-8").strip())
        if output_path.suffix == ".jsonl":
            rows = jsonl.read_jsonl(output_path)
            malformed = next((row for row in rows if row.error is not None), None)
            if malformed is not None:
                raise AssertionError(f"recorded CLI JSONL {output_path} has invalid line {malformed.line_number}: {malformed.error}")
            stdout = jsonl.encode_jsonl_records(row.value for row in rows)
        else:
            stdout = output_path.read_text(encoding="utf-8")
        result = subprocess.CompletedProcess(["kb-create", command, "--json"], returncode, stdout, "")
        read_kb_create_cli_result(command, result)
        checked += 1
    return checked


class CatalogExitStatusTest(unittest.TestCase):
    def test_every_recorded_kb_create_result_uses_the_shared_result_owner(self):
        checked = read_recorded_fixtures(TESTDATA)
        self.assertGreater(checked, 0, "no recorded CLI result fixtures were checked")

    def test_nested_fixture_with_wrong_exit_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            nested = Path(temporary) / "new-fixture-directory"
            nested.mkdir()
            source = json.loads((TESTDATA / "gateway-index-plan-refusal.json").read_text())
            (nested / "result.json").write_text(json.dumps(source), encoding="utf-8")
            (nested / "result.command").write_text("plan", encoding="utf-8")
            (nested / "result.exit").write_text("2\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, r"KB_INSTALL_GATEWAY_INDEX_UNAVAILABLE \(operation-failure\).*process status 2"):
                read_recorded_fixtures(Path(temporary))


if __name__ == "__main__":
    unittest.main()
