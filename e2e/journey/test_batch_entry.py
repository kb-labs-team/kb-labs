import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from test_environment import isolated_environment
from scoreboard import build_scoreboard

REPO = Path(__file__).resolve().parents[2]
ENTRY_SHELL = shutil.which("dash") or "sh"


class JourneyBatchEntryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="journey-batch-entry-")
        self.root = Path(self.temporary.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        (self.root / "e2e/journey").mkdir(parents=True)
        (self.root / "e2e/scripts").mkdir(parents=True)
        (self.root / "core/fixture/dist").mkdir(parents=True)
        (self.root / "pnpm-workspace.yaml").write_text("packages: []\n")
        (self.root / "package.json").write_text('{"name":"journey-fixture","private":true}\n')
        (self.root / "core/fixture/package.json").write_text('{"name":"fixture-build-output","private":true}\n')
        (self.root / "prompts").mkdir()
        (self.root / "tools/kb-devkit").mkdir(parents=True)
        shutil.copy2(REPO / "e2e/journey/batch.sh", self.root / "e2e/journey/batch.sh")
        shutil.copy2(REPO / "e2e/journey/batch_summary.py", self.root / "e2e/journey/batch_summary.py")
        shutil.copy2(REPO / "e2e/journey/scoreboard_contract.py", self.root / "e2e/journey/scoreboard_contract.py")
        shutil.copy2(REPO / "e2e/journey/preflight.sh", self.root / "e2e/journey/preflight.sh")
        shutil.copy2(REPO / "e2e/journey/prepare-candidate.sh", self.root / "e2e/journey/prepare-candidate.sh")
        shutil.copy2(
            REPO / "e2e/scripts/check-frozen-lockfile.sh",
            self.root / "e2e/scripts/check-frozen-lockfile.sh",
        )
        shutil.copy2(REPO / "e2e/scripts/build-pack-extras.mjs", self.root / "e2e/scripts/build-pack-extras.mjs")
        self.calls = self.root / "calls.log"
        import json
        self.scoreboard_fixtures = {}
        for mode in ("local", "secured"):
            catalog = self.root / f"catalog-{mode}"
            reports = self.root / f"reports-{mode}"
            catalog.mkdir()
            reports.mkdir()
            scoreboard = build_scoreboard(reports, catalog, [mode])
            fixture = self.root / f"scoreboard-{mode}.json"
            fixture.write_text(json.dumps(scoreboard), encoding="utf-8")
            self.scoreboard_fixtures[mode] = fixture
        self._script(self.root / "e2e/journey/run.sh", '''#!/bin/sh
printf 'journey %s %s\\n' "$KB_JOURNEY_ONLY" "$*" >> "$CALLS"
if [ "$*" = "--down" ] && [ "${FAIL_RESET:-}" = 1 ]; then
  printf 'reset failure fixture\\n' >&2
  exit 8
fi
if [ "$*" = "--down" ] && [ "${BLOCK_RESET:-}" = 1 ]; then
  printf 'ready\\n' >&"$READY_FD"
  cat "$BLOCK_FIFO"
fi
case "$KB_JOURNEY_ONLY" in
  service-local:explore) mode=local ;;
  service-secured:explore) mode=secured ;;
  *) mode=reset ;;
esac
if [ -n "$KB_JOURNEY_ONLY" ] && [ ! -s "$ROOT/core/fixture/dist/index.js" ]; then
  printf 'candidate build artifact missing\\n' >&2
  exit 10
fi
if [ -n "${KB_JOURNEY_CASES:-}" ]; then
  printf 'cases %s\\n' "$KB_JOURNEY_CASES" >> "$CALLS"
fi
mkdir -p "$REPORTS"
if [ "${OMIT_SCOREBOARD:-}" != "$mode" ]; then
  case "$mode" in
    local) cp "$SCOREBOARD_LOCAL" "$REPORTS/case-scoreboard.json" ;;
    secured) cp "$SCOREBOARD_SECURED" "$REPORTS/case-scoreboard.json" ;;
  esac
fi
printf '%s report\\n' "$mode" > "$REPORTS/$mode.json"
if [ "$mode" = "${FAIL_MODE:-}" ] && [ ! -f "$ATTEMPT_MARKER" ]; then
  : > "$ATTEMPT_MARKER"
  if [ "${FAIL_KIND:-infra}" = infra ]; then
    printf 'failed to solve: fixture image failure\\n'
  else
    printf 'journey assertion failed\\n'
  fi
  exit 1
fi
exit 0
''')
        self._script(self.root / "e2e/journey/prepare-candidate.sh", '''#!/bin/sh
printf 'candidate\\n' >> "$CALLS"
if [ "${FAIL_CANDIDATE:-}" = 1 ]; then printf 'candidate failure fixture\\n'; exit 9; fi
mkdir -p "$ROOT/.journey/runner-inputs" "$ROOT/e2e/packages" "$ROOT/core/fixture/dist"
printf 'built artifact\\n' > "$ROOT/core/fixture/dist/index.js"
printf 'runner input\\n' > "$ROOT/.journey/runner-inputs/fixture.txt"
printf 'candidate package\\n' > "$ROOT/e2e/packages/candidate.tgz"
exit 0
''')
        self._script(self.bin / "node", '''#!/bin/sh
case "$*" in
  *scripts/ci/run-remote-stage.mjs*)
    "$REMOTE_DEVKIT_EXECUTABLE" > "$REMOTE_STAGE_LOG" 2>&1
    result=$?
    cat "$REMOTE_STAGE_LOG"
    exit "$result"
    ;;
esac
case "$*" in
  *build-pack-extras.mjs*) exit 0 ;;
esac
case "$*" in
  *--build-outputs*)
    printf 'build-output-check\\n' >> "$CALLS"
    if [ "${FAIL_OUTPUT_CHECK:-}" = 1 ]; then
      printf 'preflight fixture failed\\n'
      exit 1
    fi
    exit 0
    ;;
esac
exit 2
''')
        self._script(self.bin / "corepack", '''#!/bin/sh
exit 0
''')
        self._script(self.bin / "python3", '''#!/bin/sh
printf 'unit\\n' >> "$CALLS"
if [ "${FAIL_UNIT:-}" = 1 ]; then
  printf 'unit failure fixture\\n'
  exit 1
fi
exit 0
''')
        self._script(self.bin / "go", '''#!/bin/sh
{
  printf 'go build'
  for arg in "$@"; do
    [ "$arg" = "-trimpath" ] && printf ' -trimpath'
  done
  printf '\n'
} >> "$CALLS"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    cat > "$1" <<'SCRIPT'
#!/bin/sh
printf 'build\\n' >> "$CALLS"
if [ "${FAIL_AFFECTED_BUILD:-}" = 1 ]; then
  printf 'affected build fixture failure\\n'
  exit 1
fi
exit 0
SCRIPT
    chmod +x "$1"
    exit 0
  fi
  shift
done
exit 2
''')
        self._script(self.bin / "git", '''#!/bin/sh
[ "$1 $2" = "rev-parse HEAD" ] && { echo deadbeef; exit 0; }
if [ "$1" = "-C" ] && [ "$3 $4 $5" = "rev-parse --short HEAD" ]; then
  echo deadbee
  exit 0
fi
if [ "$1 $2 $3" = "rev-parse --verify --quiet" ]; then
  [ "${MISSING_BASE_REF:-}" = "$4" ] && exit 1
  echo deadbeef
  exit 0
fi
exit 2
''')
        self._script(self.bin / "pnpm", '''#!/bin/sh
[ "$*" = "-r list --depth -1 --parseable" ] || exit 2
printf '%s\\n' "$ROOT" "$ROOT/core/fixture"
''')
        real_tar = shutil.which("tar")
        self._script(self.bin / "tar", '''#!/bin/sh
if [ "${FAIL_TAR:-}" = 1 ]; then
  printf 'archive failure fixture\\n' >&2
  exit 4
fi
exec "$REAL_TAR" "$@"
''')
        self.env = {
            **isolated_environment(
                Path(self.root / "home"), self.bin,
                required_tools=("git", "dirname", "mkdir", "mktemp", "date", "rm", "cat", "cp", "grep", "env", "chmod", "mv", "node", "bash", "tar"),
            ),
            "CALLS": str(self.calls),
            "REPORTS": str(self.root / ".journey/reports"),
            "ATTEMPT_MARKER": str(self.root / "first-attempt"),
            "BLOCK_FIFO": str(self.root / "reset.fifo"),
            "KB_DEVKIT_BASE_REF": "origin/master",
            "ROOT": str(self.root),
            "BATCH_PYTHON": sys.executable,
            "REAL_TAR": real_tar,
            "SCOREBOARD_LOCAL": str(self.scoreboard_fixtures["local"]),
            "SCOREBOARD_SECURED": str(self.scoreboard_fixtures["secured"]),
        }
        Path(self.env["REPORTS"]).mkdir(parents=True)

    def tearDown(self):
        self.temporary.cleanup()

    def _script(self, path, contents):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents)
        path.chmod(0o755)

    def _run(self, mode="", failure_kind="infra", missing_base_ref="", fail_build=False):
        env = dict(self.env)
        if mode:
            env["FAIL_MODE"] = mode
            env["FAIL_KIND"] = failure_kind
        if missing_base_ref:
            env["KB_DEVKIT_BASE_REF"] = missing_base_ref
            env["MISSING_BASE_REF"] = missing_base_ref + "^{commit}"
        if fail_build:
            env["FAIL_AFFECTED_BUILD"] = "1"
        return subprocess.run(
            [ENTRY_SHELL, str(self.root / "e2e/journey/batch.sh"), str(self.root / "out")],
            cwd=self.root,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_mode_without_scoreboard_fails_with_entry_cause(self):
        env = dict(self.env, OMIT_SCOREBOARD="local")
        result = subprocess.run(
            [ENTRY_SHELL, str(self.root / "e2e/journey/batch.sh"), str(self.root / "out")],
            cwd=self.root, env=env, text=True, capture_output=True, check=False,
        )
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("produced no case scoreboard", result.stderr)
        self.assertIn("entry exited with 0", result.stderr)

    # case: S-262.1
    def test_entry_runs_product_steps_in_order_and_exports_both_modes(self):
        result = self._run()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertNotIn("not found", result.stderr)
        calls = self.calls.read_text().splitlines()
        self.assertEqual(calls, [
            "journey  --down",
            "go build -trimpath",
            "build",
            "build-output-check",
            "candidate",
            "unit",
            "journey service-local:explore --no-build",
            "journey service-secured:explore --no-build",
        ])
        self.assertTrue((self.root / "out/local/local.json").is_file())
        self.assertTrue((self.root / "out/secured/secured.json").is_file())
        for stage_log in ("reset.log", "build.log", "release-build-output-check.log", "unit.log", "candidate.log"):
            self.assertTrue((self.root / "out/shared" / stage_log).is_file(), stage_log)
        for mode in ("local", "secured"):
            self.assertTrue((self.root / f"out/{mode}/batch.log").is_file())
        self.assertIn("deadbeef", (self.root / "out/shared/run.json").read_text())
        summary = (self.root / "out/shared/summary.md").read_text()
        self.assertIn("- Commit: `deadbeef`", summary)
        self.assertIn("- Baseline: `j28`", summary)
        self.assertIn("- Build base: `origin/master`", summary)
        self.assertEqual([line for line in summary.splitlines() if line.startswith("- Result:")], ["- Result: PASS"])
        import json
        for mode in ("local", "secured"):
            metadata = json.loads((self.root / f"out/{mode}/batch-metadata.json").read_text())
            self.assertEqual(metadata["mode"], mode)
            self.assertEqual(metadata["result"], "PASS")
            self.assertEqual(set(metadata["stageDurationsSeconds"]), {
                "reset", "build", "unit", "candidate", "local", "secured", "total",
            })
            self.assertTrue(all(isinstance(value, int) and value >= 0
                                for value in metadata["stageDurationsSeconds"].values()))

    # case: S-262.2
    def test_secured_product_failure_is_reported_non_gating_and_keeps_batch_green(self):
        result = self._run("secured", failure_kind="product")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        summary = (self.root / "out/shared/summary.md").read_text()
        self.assertIn("secured: FAIL (non-gating for Release 1)", summary)
        self.assertIn("- Result: PASS", summary)
        import json
        self.assertEqual(json.loads((self.root / "out/secured/batch-metadata.json").read_text())["result"], "FAIL")

    # case: S-262.2
    def test_secured_mode_job_exits_successfully_after_recording_non_gating_product_failure(self):
        producer = self.root / "producer"
        prepared = subprocess.run(
            [ENTRY_SHELL, str(self.root / "e2e/journey/batch.sh"), "prepare", str(producer)],
            cwd=self.root, env=self.env, text=True, capture_output=True, check=False,
        )
        self.assertEqual(prepared.returncode, 0, prepared.stderr + prepared.stdout)
        result = subprocess.run(
            [ENTRY_SHELL, str(self.root / "e2e/journey/batch.sh"), "mode", "secured",
             str(producer), str(self.root / "secured-artifact")],
            cwd=self.root,
            env={**self.env, "FAIL_MODE": "secured", "FAIL_KIND": "product"},
            text=True, capture_output=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        mode_dir = self.root / "secured-artifact/secured"
        self.assertIn("Result: FAIL (non-gating for Release 1)", (mode_dir / "batch.log").read_text())
        import json
        self.assertEqual(json.loads((mode_dir / "batch-metadata.json").read_text())["result"], "FAIL")

    # case: S-262.2
    def test_local_product_failure_fails_batch(self):
        result = self._run("local", failure_kind="product")
        self.assertNotEqual(result.returncode, 0)
        summary = (self.root / "out/shared/summary.md").read_text()
        self.assertIn("local: FAIL (gating)", summary)
        self.assertIn("- Result: FAIL", summary)

    # case: S-262.8
    def test_explicit_case_set_is_forwarded_to_the_mode_runner(self):
        producer = self.root / "producer"
        prepared = subprocess.run(
            [ENTRY_SHELL, str(self.root / "e2e/journey/batch.sh"), "prepare", str(producer)],
            cwd=self.root, env=self.env, text=True, capture_output=True, check=False,
        )
        self.assertEqual(prepared.returncode, 0, prepared.stderr + prepared.stdout)
        result = subprocess.run(
            [ENTRY_SHELL, str(self.root / "e2e/journey/batch.sh"), "mode", "local",
             str(producer), str(self.root / "local-artifact"), "--cases", "S-023,S-024"],
            cwd=self.root, env=self.env, text=True, capture_output=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("cases S-023,S-024", self.calls.read_text().splitlines())

    # case: S-262.1
    def test_mode_refuses_a_candidate_artifact_from_another_commit(self):
        producer = self.root / "producer"
        prepared = subprocess.run(
            [ENTRY_SHELL, str(self.root / "e2e/journey/batch.sh"), "prepare", str(producer)],
            cwd=self.root, env=self.env, text=True, capture_output=True, check=False,
        )
        self.assertEqual(prepared.returncode, 0, prepared.stderr + prepared.stdout)
        run_metadata = producer / "shared/run.json"
        run_metadata.write_text('{"commit":"another-commit","baseline":"main"}\n')

        result = subprocess.run(
            [ENTRY_SHELL, str(self.root / "e2e/journey/batch.sh"), "mode", "local",
             str(producer), str(self.root / "local-artifact")],
            cwd=self.root, env=self.env, text=True, capture_output=True, check=False,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("candidate artifact is bound to another-commit, checked out deadbeef", result.stderr)
        self.assertNotIn("journey service-local:explore --no-build", self.calls.read_text().splitlines())

    # case: S-262.8
    def test_partial_scoreboards_cannot_produce_a_passing_batch_verdict(self):
        import json
        original_gates = {}
        for mode, fixture in self.scoreboard_fixtures.items():
            scoreboard = json.loads(fixture.read_text())
            original_gates[mode] = scoreboard["releaseGate"]
            scoreboard["selection"] = ["S-023.1", "S-024.1"] if mode == "local" else []
            scoreboard["releaseGate"] = {"modes": "gate-path-must-not-be-read"}
            fixture.write_text(json.dumps(scoreboard), encoding="utf-8")

        result = self._run()
        self.assertNotEqual(result.returncode, 0, result.stderr + result.stdout)
        summary = (self.root / "out/shared/summary.md").read_text()
        self.assertIn("- Result: PARTIAL", summary)
        self.assertIn("## Stage durations", summary)
        self.assertIn("local=[S-023.1, S-024.1]; secured=[]", summary)

        for mode, fixture in self.scoreboard_fixtures.items():
            scoreboard = json.loads(fixture.read_text())
            scoreboard["selection"] = []
            scoreboard["releaseGate"] = original_gates[mode]
            fixture.write_text(json.dumps(scoreboard), encoding="utf-8")
        full_result = self._run()
        self.assertEqual(full_result.returncode, 0, full_result.stderr + full_result.stdout)
        self.assertIn("- Result: PASS", (self.root / "out/shared/summary.md").read_text())

    # case: S-262.8
    def test_empty_release_gate_cannot_turn_local_failure_into_pass(self):
        import json
        for fixture in self.scoreboard_fixtures.values():
            scoreboard = json.loads(fixture.read_text())
            scoreboard["releaseGate"]["modes"] = []
            fixture.write_text(json.dumps(scoreboard), encoding="utf-8")

        result = self._run("local", failure_kind="product")

        self.assertNotEqual(result.returncode, 0, result.stderr + result.stdout)
        summary = (self.root / "out/shared/summary.md").read_text()
        self.assertNotIn("- Result: PASS", summary)
        self.assertIn("- Result: FAIL", summary)
        self.assertIn(
            f"next: e2e/journey/batch.sh mode local {self.root / 'out'} "
            f"{self.root / 'out/.artifact-local'}",
            result.stderr,
        )

    # case: S-262.8
    def test_finalizer_refuses_empty_release_gate_declarations(self):
        import json
        for fixture in self.scoreboard_fixtures.values():
            scoreboard = json.loads(fixture.read_text())
            scoreboard["releaseGate"]["modes"] = []
            fixture.write_text(json.dumps(scoreboard), encoding="utf-8")

        result = self._run()

        self.assertNotEqual(result.returncode, 0, result.stderr + result.stdout)
        summary = (self.root / "out/shared/summary.md").read_text()
        self.assertNotIn("- Result: PASS", summary)
        self.assertIn("releaseGate.modes must equal ['local']; got []", summary)

    # case: S-262.8
    def test_finalizer_refuses_missing_release_gate_declarations(self):
        import json
        for fixture in self.scoreboard_fixtures.values():
            scoreboard = json.loads(fixture.read_text())
            scoreboard.pop("releaseGate")
            fixture.write_text(json.dumps(scoreboard), encoding="utf-8")

        result = self._run()

        self.assertNotEqual(result.returncode, 0, result.stderr + result.stdout)
        summary = (self.root / "out/shared/summary.md").read_text()
        self.assertNotIn("- Result: PASS", summary)
        self.assertIn("releaseGate.modes must equal ['local']; got None", summary)

    # case: S-262.8
    def test_scoreboard_contract_does_not_duplicate_partiality(self):
        import json
        for fixture in self.scoreboard_fixtures.values():
            scoreboard = json.loads(fixture.read_text())
            self.assertNotIn("partial", scoreboard)

    # case: S-262.1
    def test_replaced_candidate_archive_cannot_reach_mode_or_summary_pass(self):
        result = self._run()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        producer = self.root / "out/.artifact-local/shared/build-candidate.tar"
        if not producer.is_file():
            producer = self.root / "out/shared/build-candidate.tar"
        producer.write_bytes(b"substituted candidate archive")

        mode_result = subprocess.run(
            [ENTRY_SHELL, str(self.root / "e2e/journey/batch.sh"), "mode", "local",
             str(self.root / "out"), str(self.root / "tampered-local")],
            cwd=self.root, env=self.env, text=True, capture_output=True, check=False,
        )
        self.assertNotEqual(mode_result.returncode, 0, mode_result.stderr + mode_result.stdout)
        self.assertIn("candidate archive digest", mode_result.stderr)
        self.assertIn(f"next: e2e/journey/batch.sh prepare {self.root / 'out'}", mode_result.stderr)
        summary_result = subprocess.run(
            [sys.executable, str(self.root / "e2e/journey/batch_summary.py"),
             str(self.root / "summary"), str(self.root / "out"),
             str(self.root / "out/.artifact-local"), str(self.root / "out/.artifact-secured")],
            cwd=self.root, env=self.env, text=True, capture_output=True, check=False,
        )
        self.assertNotEqual(summary_result.returncode, 0, summary_result.stderr + summary_result.stdout)
        self.assertIn(f"next: e2e/journey/batch.sh prepare {self.root / 'out'}", summary_result.stderr)
        self.assertNotIn("- Result: PASS", (self.root / "summary/shared/summary.md").read_text())

    # case: S-262.8
    def test_summary_rejects_mixed_commit_identities_at_finalization(self):
        import json
        producer = self.root / "producer"
        local = self.root / "local-artifact"
        secured = self.root / "secured-artifact"
        # Reuse a successful, fully produced fixture batch before changing only its commit identities.
        self._run()
        for mode, directory in (("shared", producer), ("local", local), ("secured", secured)):
            (directory / mode).mkdir(parents=True)
            shutil.copytree(self.root / f"out/{mode}", directory / mode, dirs_exist_ok=True)
        run = json.loads((producer / "shared/run.json").read_text())
        run["commit"] = "sha-a"
        (producer / "shared/run.json").write_text(json.dumps(run))
        for mode, directory, commit in (("shared", producer, "sha-a"),
                                        ("local", local, "sha-b"),
                                        ("secured", secured, "sha-c")):
            metadata_path = directory / mode / "batch-metadata.json"
            metadata = json.loads(metadata_path.read_text())
            metadata["commit"] = commit
            metadata_path.write_text(json.dumps(metadata))

        result = subprocess.run(
            [sys.executable, str(self.root / "e2e/journey/batch_summary.py"),
             str(self.root / "mixed-summary"), str(producer), str(local), str(secured)],
            cwd=self.root, env=self.env, text=True, capture_output=True, check=False,
        )
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("commit", result.stderr)
        summary_path = self.root / "mixed-summary/shared/summary.md"
        if summary_path.exists():
            self.assertNotIn("- Result: PASS", summary_path.read_text())
            self.assertIn("- Result: FAIL", summary_path.read_text())
        for mode in ("shared", "local", "secured"):
            metadata_path = self.root / f"mixed-summary/{mode}/batch-metadata.json"
            if metadata_path.exists():
                self.assertEqual(json.loads(metadata_path.read_text())["result"], "FAIL")

    # case: S-262.1
    def test_shared_preflight_failure_fails_batch_even_when_product_lanes_do_not_run(self):
        result = self._run(fail_build=True)
        self.assertNotEqual(result.returncode, 0)
        summary = (self.root / "out/shared/summary.md").read_text()
        self.assertIn("- Failed stage: `build`", summary)
        self.assertIn("- Result: FAIL", summary)

    # case: S-262.1, S-262.2
    def test_producer_artifact_flows_through_both_mode_entrypoints_into_shared_layout(self):
        producer = self.root / "producer"
        baseline = 'batch "quoted" label'
        result = subprocess.run(
            [ENTRY_SHELL, str(self.root / "e2e/journey/batch.sh"), "prepare", str(producer), baseline],
            cwd=self.root, env=self.env, text=True, capture_output=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertTrue((producer / "shared/build-candidate.tar").is_file())
        self.assertTrue((producer / "shared/batch-metadata.json").is_file())

        mode_outputs = {}
        for mode in ("local", "secured"):
            output = self.root / f"{mode}-artifact"
            result = subprocess.run(
                [ENTRY_SHELL, str(self.root / "e2e/journey/batch.sh"), "mode", mode,
                 str(producer), str(output)],
                cwd=self.root, env=self.env, text=True, capture_output=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            mode_outputs[mode] = output
            self.assertTrue((output / mode / "batch-metadata.json").is_file())
            self.assertTrue((output / mode / "batch.log").is_file())

        collected = self.root / "collected"
        result = subprocess.run(
            [ENTRY_SHELL, str(self.root / "e2e/journey/batch.sh"), "summarize",
             str(collected), str(producer), str(mode_outputs["local"]), str(mode_outputs["secured"])],
            cwd=self.root, env=self.env, text=True, capture_output=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertTrue((collected / "shared/batch-metadata.json").is_file())
        self.assertTrue((collected / "local/batch-metadata.json").is_file())
        self.assertTrue((collected / "secured/batch-metadata.json").is_file())
        summary = (collected / "shared/summary.md").read_text()
        self.assertIn(f"- Baseline: `{baseline}`", summary)
        for stage in ("reset", "build", "unit", "candidate", "local", "secured", "total"):
            self.assertRegex(summary, rf"(?m)^- {stage}: [0-9]+ seconds$", msg=stage)
        for mode in ("local", "secured"):
            import json
            metadata = json.loads((collected / mode / "batch-metadata.json").read_text())
            self.assertEqual(metadata["mode"], mode)
            self.assertEqual(set(metadata["stageDurationsSeconds"]), {
                "reset", "build", "unit", "candidate", "local", "secured", "total",
            })

    # case: S-262.2
    def test_summary_preserves_available_evidence_when_mode_metadata_is_missing(self):
        producer = self.root / "producer"
        local = self.root / "local-artifact"
        secured = self.root / "secured-artifact"
        for directory in (producer / "shared", local / "local", secured / "secured"):
            directory.mkdir(parents=True)
        (producer / "shared/batch-metadata.json").write_text('{"result":"PASS","stageDurationsSeconds":{}}\n')
        (producer / "shared/run.json").write_text('{"commit":"deadbeef"}\n')
        (producer / "shared/build.log").write_text("build evidence\n")
        (producer / "shared/unit.log").write_text("unit evidence\n")
        (producer / "shared/candidate.log").write_text("candidate evidence\n")
        (local / "local/batch.log").write_text("local evidence\n")
        (local / "local/batch-metadata.json").write_text('{"stageDurationsSeconds":{}}\n')
        (secured / "secured/batch.log").write_text("secured evidence\n")

        output = self.root / "collected"
        result = subprocess.run(
            [sys.executable, str(self.root / "e2e/journey/batch_summary.py"),
             str(output), str(producer), str(local), str(secured)],
            cwd=self.root, env=self.env, text=True, capture_output=True, check=False,
        )

        self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
        for relative in (
            "shared/batch-metadata.json", "shared/run.json", "shared/build.log",
            "shared/unit.log", "shared/candidate.log", "local/batch-metadata.json",
            "local/batch.log", "secured/batch.log",
        ):
            self.assertTrue((output / relative).is_file(), relative)
        summary = (output / "shared/summary.md").read_text()
        self.assertIn("Missing batch metadata", summary)
        self.assertIn("secured/batch-metadata.json", summary)

    # case: S-262.2
    def test_mode_entry_rejects_a_missing_producer_archive_with_a_recovery_step(self):
        missing_producer = self.root / "missing-producer"
        result = subprocess.run(
            [ENTRY_SHELL, str(self.root / "e2e/journey/batch.sh"), "mode", "local",
             str(missing_producer), str(self.root / "mode-output")],
            cwd=self.root, env=self.env, text=True, capture_output=True, check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("producer artifact is missing its build-candidate.tar", result.stderr)
        self.assertIn("next: rerun the producer with e2e/journey/batch.sh prepare", result.stderr)


    # case: S-262.1
    def test_candidate_failure_stops_shared_lane_before_unit_and_modes(self):
        result = subprocess.run(
            [ENTRY_SHELL, str(self.root / "e2e/journey/batch.sh"), str(self.root / "out")],
            cwd=self.root, env={**self.env, "FAIL_CANDIDATE": "1"},
            text=True, capture_output=True, check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        calls = self.calls.read_text().splitlines()
        self.assertIn("candidate", calls)
        self.assertNotIn("unit", calls)
        self.assertFalse(any(row.startswith("journey service-") for row in calls))
        self.assertIn("candidate failure fixture", (self.root / "out/shared/candidate.log").read_text())
        self.assertIn("- Failed stage: `candidate`", (self.root / "out/shared/summary.md").read_text())
        self.assertIn("next: e2e/journey/prepare-candidate.sh", result.stderr)

    # case: S-262.1
    def test_reset_failure_summary_has_one_final_result(self):
        result = subprocess.run(
            [ENTRY_SHELL, str(self.root / "e2e/journey/batch.sh"), "prepare", str(self.root / "out")],
            cwd=self.root, env={**self.env, "FAIL_RESET": "1"},
            text=True, capture_output=True, check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        summary = (self.root / "out/shared/summary.md").read_text()
        self.assertEqual([line for line in summary.splitlines() if line.startswith("- Result:")],
                         ["- Result: FAIL"])
        self.assertIn("reset failure fixture", (self.root / "out/shared/reset.log").read_text())

    # case: S-262.1
    def test_candidate_archive_failure_is_reported_in_shared_metadata(self):
        result = subprocess.run(
            [ENTRY_SHELL, str(self.root / "e2e/journey/batch.sh"), "prepare", str(self.root / "out")],
            cwd=self.root, env={**self.env, "FAIL_TAR": "1"},
            text=True, capture_output=True, check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("archive failure fixture", (self.root / "out/shared/candidate-package.log").read_text())
        summary = (self.root / "out/shared/summary.md").read_text()
        self.assertIn("- Failed stage: `candidate`", summary)
        self.assertIn("- Stage log: `candidate-package.log`", summary)
        self.assertIn('next: tar -cf "', result.stderr)
        import json
        metadata = json.loads((self.root / "out/shared/batch-metadata.json").read_text())
        self.assertEqual(metadata["result"], "FAIL")

    # case: S-262.4
    def test_shared_devkit_build_is_path_independent_for_digest_cache(self):
        result = self._run()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        go_builds = [row for row in self.calls.read_text().splitlines()
                     if row.startswith("go build ")]
        self.assertEqual(len(go_builds), 1)
        self.assertEqual(go_builds[0], "go build -trimpath")

    # case: S-262.1
    def test_entry_retries_only_a_docker_image_build_failure_once(self):
        result = self._run("local")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        local_runs = [row for row in self.calls.read_text().splitlines()
                      if row == "journey service-local:explore --no-build"]
        self.assertEqual(len(local_runs), 2)
        self.assertTrue((self.root / "out/local/infra-failed.log").is_file())
        self.assertEqual(
            sum(row == "journey service-secured:explore --no-build"
                for row in self.calls.read_text().splitlines()),
            1,
        )

    # case: S-262.1
    def test_entry_does_not_retry_a_non_image_failure(self):
        result = self._run("local", "ordinary")
        self.assertNotEqual(result.returncode, 0)
        local_runs = [row for row in self.calls.read_text().splitlines()
                      if row == "journey service-local:explore --no-build"]
        self.assertEqual(len(local_runs), 1)
        secured_runs = [row for row in self.calls.read_text().splitlines()
                        if row == "journey service-secured:explore --no-build"]
        self.assertEqual(len(secured_runs), 1)
        self.assertFalse((self.root / "out/local/infra-failed.log").exists())
        self.assertTrue((self.root / "out/local/local.json").is_file())
        self.assertTrue((self.root / "out/secured/secured.json").is_file())
        self.assertFalse((self.root / "out/local/secured.json").exists())
        self.assertFalse((self.root / "out/secured/local.json").exists())
        self.assertTrue((self.root / "out/secured/batch.log").is_file())
        for mode in ("local", "secured"):
            for stage_log in ("reset.log", "build.log", "unit.log", "candidate.log"):
                self.assertTrue((self.root / f"out/{mode}/{stage_log}").is_file())
            import json
            mode_metadata = json.loads((self.root / f"out/{mode}/batch-metadata.json").read_text())
            self.assertEqual(mode_metadata["mode"], mode)
        summary = (self.root / "out/shared/summary.md").read_text()
        self.assertEqual([line for line in summary.splitlines() if line.startswith("- Result:")], ["- Result: FAIL"])

    # case: S-262.1
    def test_interrupted_entry_finalizes_one_result_and_timing_metadata(self):
        import select
        import signal

        fifo = Path(self.env["BLOCK_FIFO"])
        os.mkfifo(fifo)
        ready_read, ready_write = os.pipe()
        env = {**self.env, "BLOCK_RESET": "1", "READY_FD": str(ready_write)}
        process = subprocess.Popen(
            [ENTRY_SHELL, str(self.root / "e2e/journey/batch.sh"), str(self.root / "out")],
            cwd=self.root,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            pass_fds=(ready_write,),
        )
        os.close(ready_write)
        try:
            ready, _, _ = select.select([ready_read], [], [], 10)
            self.assertTrue(ready, "batch did not reach the blocking reset fixture")
            self.assertEqual(os.read(ready_read, 6), b"ready\n")
            os.killpg(process.pid, signal.SIGTERM)
            _, stderr = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 143, stderr)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate(timeout=10)
            os.close(ready_read)
        summary = (self.root / "out/shared/summary.md").read_text()
        self.assertEqual([line for line in summary.splitlines() if line.startswith("- Result:")], ["- Result: INTERRUPTED"])
        import json
        metadata = json.loads((self.root / "out/shared/batch-metadata.json").read_text())
        self.assertGreaterEqual(metadata["stageDurationsSeconds"]["reset"], 0)
        self.assertEqual(metadata["result"], "INTERRUPTED")

    # case: S-262.1
    def test_entry_names_missing_base_ref_before_affected_build(self):
        result = self._run(missing_base_ref="origin/master")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("affected-build base ref 'origin/master' is missing", result.stderr)
        self.assertIn("next: git fetch --all --prune", result.stderr)
        self.assertNotIn("not found", result.stderr)
        self.assertFalse(self.calls.exists())
        self.assertTrue((self.root / "out/shared/summary.md").is_file())
        self.assertTrue((self.root / "out/shared/batch-metadata.json").is_file())
        self.assertTrue((self.root / "out/shared/build.log").is_file())

    # case: S-262.2
    def test_unit_failure_summary_points_to_relative_stage_log(self):
        env = {**self.env, "FAIL_UNIT": "1"}
        result = subprocess.run(
            [ENTRY_SHELL, str(self.root / "e2e/journey/batch.sh"), str(self.root / "out")],
            cwd=self.root,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        summary = (self.root / "out/shared/summary.md").read_text()
        self.assertIn("- Failed stage: `unit`", summary)
        self.assertIn("- Stage log: `unit.log`", summary)
        self.assertEqual([line for line in summary.splitlines() if line.startswith("- Result:")], ["- Result: FAIL"])
        self.assertEqual((self.root / "out/shared/unit.log").read_text(), "unit failure fixture\n")

    # case: S-262.1
    def test_entry_declares_shared_artifacts_before_build_failure(self):
        artifact_outputs = self.root / "github-output"
        result = subprocess.run(
            [ENTRY_SHELL, str(self.root / "e2e/journey/batch.sh"), str(self.root / "out")],
            cwd=self.root,
            env={**self.env, "FAIL_AFFECTED_BUILD": "1", "GITHUB_OUTPUT": str(artifact_outputs)},
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("devkit affected build failed", result.stderr)
        self.assertNotIn("not found", result.stderr)
        shared = self.root / "out/shared"
        self.assertTrue((shared / "summary.md").is_file())
        self.assertTrue((shared / "batch-metadata.json").is_file())
        self.assertTrue((shared / "build.log").is_file())
        declarations = dict(line.split("=", 1) for line in artifact_outputs.read_text().splitlines())
        self.assertEqual(declarations, {
            "artifact_shared": str(shared),
            "artifact_local": str(self.root / "out/local"),
            "artifact_secured": str(self.root / "out/secured"),
        })
        self.assertFalse((self.root / "out/local").exists())
        self.assertFalse((self.root / "out/secured").exists())

    # case: S-262.2
    def test_workflow_splits_shared_producer_and_parallel_mode_consumers(self):
        workflow = REPO / ".github/workflows/journey-batch.yml"
        parsed = subprocess.run(
            ["node", "-e", "const fs=require('fs');const y=require('js-yaml').load(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(JSON.stringify(y))", str(workflow)],
            cwd=REPO,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(parsed.returncode, 0, parsed.stderr)
        import json
        spec = json.loads(parsed.stdout)
        self.assertIn("workflow_dispatch", spec["on"])
        self.assertEqual(spec["on"]["push"]["branches"], ["batch/**"])
        self.assertIn("pull_request", spec["on"])
        self.assertIn("baseline", spec["on"]["workflow_dispatch"]["inputs"])
        self.assertIn("recorded in batch metadata", spec["on"]["workflow_dispatch"]["inputs"]["baseline"]["description"])
        self.assertNotIn("cases", spec["on"]["workflow_dispatch"]["inputs"])
        self.assertEqual(spec["jobs"]["producer"]["outputs"]["cases_b64"], "${{ steps.selection.outputs.cases_b64 }}")
        self.assertEqual(spec["jobs"]["local"]["env"]["BATCH_CASES_B64"], "${{ needs.producer.outputs.cases_b64 }}")
        self.assertEqual(spec["jobs"]["secured"]["env"]["BATCH_CASES_B64"], "${{ needs.producer.outputs.cases_b64 }}")
        for mode in ("local", "secured"):
            command = next(step["run"] for step in spec["jobs"][mode]["steps"]
                           if step.get("name") == f"Run {mode} journey stage")
            self.assertIn('base64 --decode', command)
            self.assertIn(f'--cases "$BATCH_CASES"', command)
        self.assertNotIn("docs/**", spec["on"]["pull_request"]["paths"])
        self.assertEqual(spec["concurrency"]["group"], "journey-batch")
        jobs = spec["jobs"]
        self.assertEqual(set(jobs), {"producer", "local", "secured", "summary"})
        producer_steps = jobs["producer"]["steps"]
        selection_step = next(step for step in producer_steps if step.get("id") == "selection")
        self.assertIn('GITHUB_REF_NAME##*/cases/', selection_step["run"])
        producer_entry = next(step for step in producer_steps if step.get("name") == "Produce shared build and candidate")
        self.assertEqual(
            producer_entry["run"],
            'node scripts/ci/run-remote-stage.mjs --journey-batch-prepare "$BATCH_PRODUCER_OUTPUT" "$BATCH_BASELINE"',
        )
        self.assertEqual(jobs["producer"]["timeout-minutes"], 60)
        self.assertEqual(jobs["local"]["needs"], "producer")
        self.assertEqual(jobs["secured"]["needs"], "producer")
        self.assertEqual(jobs["summary"]["needs"], ["producer", "local", "secured"])
        self.assertEqual(jobs["local"]["timeout-minutes"], 180)
        self.assertEqual(jobs["secured"]["timeout-minutes"], 120)
        self.assertFalse(jobs["local"].get("strategy", {}).get("fail-fast", True))
        self.assertFalse(jobs["secured"].get("strategy", {}).get("fail-fast", True))
        for mode in ("local", "secured"):
            steps = jobs[mode]["steps"]
            self.assertTrue(any(step.get("uses", "").startswith("actions/download-artifact@")
                                and step.get("with", {}).get("name") == "journey-build-candidate"
                                for step in steps))
            run = next(step for step in steps if "batch.sh" in step.get("run", ""))
            self.assertIn(f'e2e/journey/batch.sh mode {mode} "$BATCH_PRODUCER_INPUT" "$BATCH_OUTPUT" --cases "$BATCH_CASES"', run["run"])
            upload = next(step for step in steps if step.get("uses", "").startswith("actions/upload-artifact@"))
            self.assertEqual(upload["with"]["name"], f"journey-{mode}")
        shared_upload = next(step for step in jobs["summary"]["steps"]
                             if step.get("uses", "").startswith("actions/upload-artifact@"))
        self.assertEqual(shared_upload["with"]["name"], "journey-shared")
        build_upload = next(step for step in producer_steps
                            if step.get("uses", "").startswith("actions/upload-artifact@"))
        self.assertEqual(build_upload["with"]["name"], "journey-build-candidate")
        summary_downloads = [step["with"]["name"] for step in jobs["summary"]["steps"]
                             if step.get("uses", "").startswith("actions/download-artifact@")]
        self.assertEqual(summary_downloads, [
            "journey-build-candidate", "journey-local", "journey-secured",
        ])
        summary_stage = next(step for step in jobs["summary"]["steps"]
                             if step.get("id") == "summarize")
        self.assertNotIn("continue-on-error", summary_stage)
        self.assertEqual(jobs["local"]["strategy"]["fail-fast"], False)
        self.assertEqual(jobs["secured"]["strategy"]["fail-fast"], False)
        node_setup = next(step for step in producer_steps if step.get("uses", "").startswith("actions/setup-node@"))
        self.assertEqual(node_setup["with"]["node-version-file"], "package.json")

    # case: S-262.1
    def test_missing_release_output_fails_build_stage_before_candidate(self):
        env = {**self.env, "FAIL_OUTPUT_CHECK": "1"}
        result = subprocess.run(
            [ENTRY_SHELL, str(self.root / "e2e/journey/batch.sh"), str(self.root / "out")],
            cwd=self.root, env=env, text=True, capture_output=True, check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        build_log = (self.root / "out/shared/build.log").read_text()
        self.assertIn("preflight fixture failed", build_log)
        self.assertNotIn("candidate", self.calls.read_text())
        self.assertIn("- Failed stage: `build`", (self.root / "out/shared/summary.md").read_text())

    # case: S-262.1
    def test_candidate_output_preflight_fails_before_package_packing(self):
        shutil.copy2(REPO / "e2e/journey/prepare-candidate.sh", self.root / "e2e/journey/prepare-candidate.sh")
        shutil.copy2(REPO / "e2e/compose-owner.sh", self.root / "e2e/compose-owner.sh")
        shutil.copy2(REPO / "e2e/journey/candidate-services.sh", self.root / "e2e/journey/candidate-services.sh")
        compose_source = self.root / "compose-workspace-source.txt"
        self._script(self.bin / "docker", '''#!/bin/sh
if [ "$1 $2" = "compose version" ]; then
  printf '%s' "${KB_JOURNEY_WORKSPACE_SOURCE:-}" > "$COMPOSE_SOURCE"
  exit 0
fi
exit 1
''')
        env = {**self.env, "FAIL_OUTPUT_CHECK": "1", "COMPOSE_SOURCE": str(compose_source)}
        result = subprocess.run(
            ["bash", str(self.root / "e2e/journey/prepare-candidate.sh")],
            cwd=self.root, env=env, text=True, capture_output=True, check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("preflight fixture failed", result.stdout)
        self.assertEqual(compose_source.read_text(), str(self.root))
        self.assertFalse((self.root / "e2e/packages").exists())


if __name__ == "__main__":
    unittest.main()
