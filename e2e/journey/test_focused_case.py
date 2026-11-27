import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from focused_case import main
from invocations import invocation_context, run_command


class FocusedCaseTest(unittest.TestCase):
    def test_digest_mismatch_refuses_before_using_the_fixture(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Path(temporary).resolve()
            for name in ("home", "project", "platform"):
                (fixture / name).mkdir()
            version = fixture / "platform" / "versions" / "candidate"
            receipt = version / ".kb" / "v2" / "receipt.json"
            receipt.parent.mkdir(parents=True)
            receipt.write_text(json.dumps({"plan": {"releaseDigest": "old"}}))
            (fixture / "platform" / "current").symlink_to(Path("versions") / "candidate")
            index = fixture / "candidate.json"
            index.write_text(json.dumps({"digest": "new"}))

            with patch("focused_case.run_transitive_npm_dependency_fixture") as run:
                with patch("builtins.print") as output:
                    self.assertEqual(main(["--fixture", str(fixture), "--index", str(index)]), 1)
                run.assert_not_called()
            result = json.loads(output.call_args.args[0])
            self.assertEqual(result["status"], "BLOCKED")
            self.assertEqual(result["releaseDigest"], "old")
            self.assertIn("new", result["message"])

    def test_deadline_is_inherited_by_step_and_refuses_new_commands(self):
        with patch("invocations.subprocess.run") as run:
            with invocation_context(command_deadline=time.monotonic() - 1):
                with invocation_context(step_id="case"):
                    with self.assertRaises(TimeoutError):
                        run_command(["kb", "--version"])
            run.assert_not_called()
