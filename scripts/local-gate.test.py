#!/usr/bin/env python3
"""Execution tests for the local gate using an isolated fake toolchain."""
import json
import os
from pathlib import Path
import re
import subprocess
import shutil
import tempfile
import unittest


SOURCE_ROOT = Path(__file__).resolve().parents[1]
GATE_SOURCE = SOURCE_ROOT / "scripts/local-gate.sh"


class LocalGateExecutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="local-gate-test-")
        self.root = Path(self.temp.name) / "repo"
        self.bin = Path(self.temp.name) / "bin"
        self.root.mkdir()
        self.bin.mkdir()
        (self.root / "scripts").mkdir()
        (self.root / "scripts/local-gate.sh").write_text(GATE_SOURCE.read_text())
        package_dir = self.root / "packages/fake"
        package_dir.mkdir(parents=True)
        (package_dir / "package.json").write_text('{"name":"@test/gate"}\n')
        (self.root / "tools/kb-create").mkdir(parents=True)
        (self.root / "tools/kb-devkit").mkdir(parents=True)
        cli_bin = self.root / "cli/bin/dist"
        cli_bin.mkdir(parents=True)
        (cli_bin / "bin.js").write_text("// built workspace CLI fixture\n")
        journey = self.root / "e2e/journey"
        journey.mkdir(parents=True)
        (journey / "prepare-candidate.sh").write_text(
            '#!/usr/bin/env bash\necho "candidate $*" >> "$GATE_LOG"\nexit "${FAIL_CANDIDATE:-0}"\n'
        )
        (journey / "run.sh").write_text(
            '#!/usr/bin/env bash\necho "journey $*" >> "$GATE_LOG"\nexit 0\n'
        )
        (journey / "prepare-candidate.sh").chmod(0o755)
        (journey / "run.sh").chmod(0o755)
        (journey / "nightly_report.py").write_text(
            "import json, pathlib, sys\n"
            "args=sys.argv\n"
            "path=pathlib.Path(args[args.index('--json')+1]); path.write_text(json.dumps({'capabilities': []}))\n"
            "path=pathlib.Path(args[args.index('--summary')+1]); path.write_text('ok\\n')\n"
        )
        for name in ("pnpm", "kb-devkit", "go", "gitleaks", "colima", "docker"):
            stub = self.bin / name
            failure_check = (
                'if [[ "$1" == install && "${FAIL_PNPM_INSTALL:-}" == "1" ]]; then exit 1; fi\n'
                if name == "pnpm" else
                'if [[ "${FAIL_' + name.upper().replace('-', '_') + ':-}" == "1" ]]; then exit 1; fi\n'
            )
            stub.write_text(
                f'#!/usr/bin/env bash\nprintf "%s|%s|%s\\n" "{name}" "$*" "${{CI:-}}" >> "$GATE_LOG"\n'
                + failure_check
                + f'if [[ "{name}" == docker && "$1" == image ]]; then exit 1; fi\n'
                + 'exit 0\n'
            )
            stub.chmod(0o755)
        (self.bin / "go").write_text(
            '#!/usr/bin/env bash\n'
            'if [[ "$1" == build ]]; then\n'
            '  while (($#)); do\n'
            '    if [[ "$1" == -o ]]; then output="$2"; shift 2; else shift; fi\n'
            '  done\n'
            '  cat > "$output" <<\'KBDEVKIT\'\n'
            '#!/usr/bin/env bash\n'
            'printf "%s|%s|%s\\n" "kb-devkit" "$*" "${CI:-}" >> "$GATE_LOG"\n'
            'exit 0\n'
            'KBDEVKIT\n'
            '  chmod +x "$output"\n'
            '  exit 0\n'
            'fi\n'
            'exit 0\n'
        )
        (self.bin / "go").chmod(0o755)
        subprocess.run(["git", "init", "-q", "-b", "local/main"], cwd=self.root, check=True)
        subprocess.run(["git", "config", "user.email", "gate-test@example.invalid"], cwd=self.root, check=True)
        subprocess.run(["git", "config", "user.name", "Gate Test"], cwd=self.root, check=True)
        subprocess.run(["git", "add", "packages/fake/package.json"], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "-qm", "baseline"], cwd=self.root, check=True)
        (package_dir / "package.json").write_text('{"name":"@test/gate","version":"changed"}\n')

    def tearDown(self):
        self.temp.cleanup()

    def run_gate(self, *args, **failures):
        log = Path(self.temp.name) / "calls.log"
        env = os.environ.copy()
        env.update({"PATH": f"{self.bin}{os.pathsep}{env['PATH']}", "GATE_LOG": str(log), "TMPDIR": self.temp.name})
        env.update({key: "1" for key in failures})
        result = subprocess.run(
            ["bash", "scripts/local-gate.sh", "batch", *args], cwd=self.root,
            env=env, text=True, capture_output=True,
        )
        reports = sorted((self.root / ".kb/local-gate").glob("*/report.json"))
        report = json.loads(reports[-1].read_text()) if reports else None
        calls = log.read_text().splitlines() if log.exists() else []
        return result, report, calls

    @staticmethod
    def stages(report):
        return {item["name"]: item for item in report["stages"]}

    def test_install_failure_blocks_dependents_but_runs_independent_checks(self):
        result, report, calls = self.run_gate("--keep-going", FAIL_PNPM_INSTALL=1)
        self.assertNotEqual(result.returncode, 0)
        stages = self.stages(report)
        self.assertEqual(report["status"], "FAIL")
        for name in (
            "affected build", "affected lint type-check tests", "kb-create Go tests ./v2",
            "prepare service journey candidate", "Colima start", "local install and service journey",
            "secured install and service journey", "nightly journey aggregation",
        ):
            self.assertEqual(stages[name]["status"], "BLOCKED", name)
            self.assertIn("frozen install failed", stages[name]["reason"])
        self.assertEqual(stages["dependency audit"]["status"], "PASS")
        self.assertEqual(stages["secret scan"]["status"], "PASS")
        self.assertTrue(any(line.startswith("pnpm|install --frozen-lockfile|true") for line in calls))
        self.assertFalse(any(line.startswith("colima|") for line in calls))

    def test_candidate_failure_blocks_journeys_and_skips_colima(self):
        result, report, calls = self.run_gate("--keep-going", FAIL_CANDIDATE=1)
        self.assertNotEqual(result.returncode, 0)
        stages = self.stages(report)
        self.assertEqual(stages["frozen install"]["status"], "PASS")
        self.assertEqual(stages["affected build"]["status"], "PASS")
        self.assertEqual(stages["dependency audit"]["status"], "PASS")
        for name in ("Colima start", "local install and service journey", "secured install and service journey", "nightly journey aggregation"):
            self.assertEqual(stages[name]["status"], "BLOCKED", name)
            self.assertIn("candidate preparation failed", stages[name]["reason"])
        self.assertFalse(any(line.startswith("colima|") for line in calls))
        self.assertFalse(any(line.startswith("journey ") for line in calls))

    def test_dry_run_stage_names_match_passing_report(self):
        dry, _, _ = self.run_gate("--dry-run")
        run, report, _ = self.run_gate("--keep-going")
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertEqual(run.returncode, 0, run.stderr)
        dry_names = [re.sub(r"^\d+\. ", "", line) for line in dry.stdout.splitlines() if re.match(r"^\d+\. ", line)]
        actual_names = [stage["name"] for stage in report["stages"]]
        self.assertEqual(dry_names, actual_names)

    def test_full_dry_run_names_the_release_case_journey_matrix(self):
        dry, _, _ = self.run_gate("--full", "--dry-run")
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertIn("full release case journey matrix", dry.stdout)

    def test_missing_go_reports_a_working_install_step(self):
        no_go_bin = Path(self.temp.name) / "no-go-bin"
        no_go_bin.mkdir()
        dirname = shutil.which("dirname")
        bash = shutil.which("bash")
        self.assertIsNotNone(dirname)
        self.assertIsNotNone(bash)
        (no_go_bin / "dirname").symlink_to(dirname)
        env = os.environ.copy()
        env["PATH"] = str(no_go_bin)
        result = subprocess.run(
            [bash, "scripts/local-gate.sh", "quick", "--packages", "@test/gate"],
            cwd=self.root, env=env, text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 127)
        self.assertIn("Go 1.26 is required", result.stderr)
        self.assertIn("brew install go", result.stderr)
        self.assertIn("scripts/local-gate.sh quick", result.stderr)
        self.assertNotIn("make -C tools/kb-devkit build", result.stderr)

    def test_quick_mode_rejects_full_matrix_flag(self):
        result = subprocess.run(
            ["bash", "scripts/local-gate.sh", "quick", "--full"], cwd=self.root,
            text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("--full is only available with batch", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
