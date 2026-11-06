from __future__ import annotations

import json
import subprocess
import unittest

import jsonl
from invocations import read_kb_create_cli_result, read_ux_cli_result, read_ux_cli_stream, run_command


class InvocationExitStatusRailTests(unittest.TestCase):
    def test_ux_jsonl_stream_keeps_unicode_separators_inside_a_record(self):
        unusual = "NEL\x85 LS\u2028 FS\x1c"
        stdout = jsonl.encode_jsonl_records((
            {"ok": True, "data": {"message": unusual}},
            {"ok": True, "data": None, "meta": {"stream": {
                "terminal": True, "exitCode": 0,
            }}},
        ))
        result = subprocess.CompletedProcess(["kb-create", "install", "--json"], 0, stdout, "")
        self.assertEqual(read_ux_cli_stream(result)[0]["data"]["message"], unusual)

    def test_fake_runner_cannot_pass_wrong_catalogued_status(self):
        stdout = json.dumps({"ok": False, "error": {
            "code": "KB_INSTALL_GATEWAY_INDEX_UNAVAILABLE",
            "message": "Gateway index unavailable",
        }})
        result = subprocess.CompletedProcess(["kb-create", "plan", "--json"], 2, stdout, "")
        with self.assertRaisesRegex(ValueError, r"KB_INSTALL_GATEWAY_INDEX_UNAVAILABLE \(operation-failure\).*process status 2"):
            run_command(["kb-create", "plan", "--json"], runner=lambda *_args, **_kwargs: result)

    def test_plain_mapping_or_custom_result_cannot_enter_the_decoder(self):
        values = ({"stdout": '{"ok":true,"data":{}}', "returncode": 0},
                  type("ResultLike", (), {"stdout": '{"ok":true,"data":{}}', "returncode": 0})())
        for value in values:
            with self.subTest(type=type(value).__name__), self.assertRaisesRegex(ValueError, "requires a subprocess.CompletedProcess"):
                read_ux_cli_result(value)

    def test_process_and_terminal_status_mismatch_names_the_catalogued_error(self):
        stdout = jsonl.encode_jsonl_records(({"ok": False, "error": {
            "code": "KB_INSTALL_GATEWAY_INDEX_UNAVAILABLE",
            "message": "Gateway index unavailable",
        }}, {"ok": True, "data": None, "meta": {"stream": {
            "terminal": True, "exitCode": 2,
        }}}))
        result = subprocess.CompletedProcess(["kb-create", "install", "--json"], 1, stdout, "")
        with self.assertRaisesRegex(ValueError, r"KB_INSTALL_GATEWAY_INDEX_UNAVAILABLE \(operation-failure\).*process status 1.*terminal status 2"):
            read_ux_cli_stream(result)


if __name__ == "__main__":
    unittest.main()
