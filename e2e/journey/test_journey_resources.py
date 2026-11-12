import tempfile
import unittest
from pathlib import Path

from installed_fixture import installed_path, layout_value
from journey_resources import (active_platform_root, current_link_path, host_log_tails,
                               host_structured_log_problem, parse_shell_commands, version_roots_path)


class HostLogSeamTest(unittest.TestCase):
    def host_state(self, root: Path) -> Path:
        state = installed_path(root, "hostStateDirectory")
        state.mkdir(parents=True)
        return state

    def test_started_host_must_have_written_its_structured_log(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state = self.host_state(root)
            self.assertIn("wrote no structured log", host_structured_log_problem(root))
            structured = state / layout_value("hostLogFiles.structured")
            structured.write_text("not a record\n")
            self.assertIn("no log record", host_structured_log_problem(root))
            structured.write_text('{"level":30,"time":1,"msg":"host started"}\n')
            self.assertIsNone(host_structured_log_problem(root))

    def test_failure_diagnostics_carry_the_tail_of_both_host_logs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state = self.host_state(root)
            (state / layout_value("hostLogFiles.residue")).write_text("residue-cause\n")
            (state / layout_value("hostLogFiles.structured")).write_text('{"level":50,"msg":"structured-cause"}\n')
            tails = host_log_tails(root)
            self.assertIn("residue-cause", tails)
            self.assertIn("structured-cause", tails)


class ActivePlatformRootTest(unittest.TestCase):
    def test_missing_and_empty_targets_have_no_platform_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            with self.assertRaises(FileNotFoundError):
                active_platform_root(parent / "missing")
            empty = parent / "empty"
            empty.mkdir()
            with self.assertRaises(FileNotFoundError):
                active_platform_root(empty)

    def test_invalid_container_does_not_fall_back_to_install_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            install_root = Path(temporary) / "install"
            install_root.mkdir()
            (install_root / "foreign.txt").write_text("foreign")
            with self.assertRaisesRegex(ValueError, "current is not a symlink"):
                active_platform_root(install_root)


    def test_valid_container_resolves_current(self):
        with tempfile.TemporaryDirectory() as temporary:
            install_root = Path(temporary) / "install"
            version = install_root / "versions" / "1.0.0"
            version.mkdir(parents=True)
            install_root.joinpath("current").symlink_to(Path("versions") / "1.0.0")
            self.assertEqual(active_platform_root(install_root), version.resolve())

    def test_container_rejects_current_link_outside_version_roots(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            install_root = parent / "install"
            version_roots_path(install_root).mkdir(parents=True)
            foreign = parent / "foreign"
            foreign.mkdir()
            current_link_path(install_root).symlink_to(Path("../foreign"))
            with self.assertRaisesRegex(ValueError, "does not select a complete version"):
                active_platform_root(install_root)


class ShellHintParserTest(unittest.TestCase):
    def test_parses_shell_quote_grammar_and_command_separator(self):
        sequence = "'kb-create' 'stop' '--platform-root' 'a'\"'\"'b' && 'kb-create' 'apply'"
        self.assertEqual(parse_shell_commands(sequence),
                         [["kb-create", "stop", "--platform-root", "a'b"],
                          ["kb-create", "apply"]])

    def test_rejects_malformed_command_sequences(self):
        for sequence in ("", "cmd &&", "cmd & next", "&& cmd"):
            with self.subTest(sequence=sequence), self.assertRaises(ValueError):
                parse_shell_commands(sequence)


if __name__ == "__main__":
    unittest.main()
