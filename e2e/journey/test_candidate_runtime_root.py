import pathlib
import subprocess
import unittest


REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[2]
KB_CREATE_ROOT = REPOSITORY_ROOT / "tools" / "kb-create"


class CandidateRuntimeRootTests(unittest.TestCase):
    # case: S-262.13
    def test_invalid_preparation_inputs_render_diagnostic(self):
        result = subprocess.run(
            ["go", "run", "./cmd/candidate-runtime-root"],
            cwd=KB_CREATE_ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("Hint:", result.stderr, "expected a rendered human diagnostic on stderr")


if __name__ == "__main__":
    unittest.main()
