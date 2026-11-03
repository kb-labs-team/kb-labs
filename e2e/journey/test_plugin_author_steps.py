import json
import os
import subprocess
import tempfile
import unittest
import urllib.request
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))
from plugin_author_steps import _validate_plugin_route_help, run_commit_case_steps, run_plugin_author_flow
from service_steps import Journey
from invocations import open_http
from marketplace_sync_fixture import (
    marketplace_sync_request_count,
    start_marketplace_sync_fixture,
    stop_marketplace_sync_fixture,
)


FAKE_KB = r'''#!/usr/bin/env python3
import json
import os
import signal
import subprocess
import sys
import tty
from pathlib import Path

args = sys.argv[1:]
root = Path.cwd()
declared_plugin_commands = {("commit", "commit"), ("review", "run")}
help_args = args[:-2] if args[-2:] == ["--help", "--json"] else args[:-1]
is_help = args[-2:] == ["--help", "--json"] or args[-1:] == ["--help"]
if is_help and tuple(help_args) in declared_plugin_commands:
    print("Registered plugin command help")
    raise SystemExit(0)
log = Path(os.environ["FAKE_JOURNEY_LOG"])
with log.open("a", encoding="utf-8") as stream:
    stream.write("kb " + " ".join(args) + "\n")
plugin = root / ".kb/plugins/demo"
lock_path = root / ".kb/marketplace.lock"
if args[:6] == ["scaffold", "run", "plugin", "demo", "--mode", "standalone"] and args[6:] == ["--yes"]:
    plugin.mkdir(parents=True)
    (plugin / "src/cli/commands").mkdir(parents=True)
    core = plugin / "src/core/hello.ts"
    core.parent.mkdir(parents=True, exist_ok=True)
    (plugin / "package.json").write_text('{"name":"@kb-labs/demo","version":"0.1.0","kb":{"manifest":"manifest.json"}}')
    (plugin / "manifest.json").write_text(json.dumps({"id": "@kb-labs/demo"}))
    (plugin / "src/cli/commands/hello.ts").write_text(
        "const { greeting } = hello({ who: input.flags.who ?? 'World' });\n")
    core.write_text('return { greeting: `Hello, ${who} from demo!` };\n')
elif args[:3] == ["marketplace", "plugins", "add"]:
    link_path = args[args.index("--link") + 1]
    if link_path.startswith("/"):
        request_log = os.environ.get("FAKE_MARKETPLACE_URL_LOG")
        if request_log:
            Path(request_log).write_text(os.environ.get("KB_MARKETPLACE_URL", ""), encoding="utf-8")
        print(json.dumps({"ok": False, "error": {"code": "KB_RUNTIME_INPUT_INVALID",
            "message": "The --link path must be relative to the selected scope directory."}}))
        raise SystemExit(1)
    if os.environ.get("KB_MARKETPLACE_URL"):
        import urllib.request
        request = urllib.request.Request(
            os.environ["KB_MARKETPLACE_URL"].rstrip("/") + "/api/v1/marketplace/packages/link",
            data=b"{}", headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(request, timeout=10):
            pass
    if os.environ.get("FAIL_MARKETPLACE_ADD"):
        print("simulated marketplace plugins add failure")
        raise SystemExit(1)
    if not (root / link_path / "package.json").is_file():
        raise SystemExit("plugin package is missing")
    manifest = json.loads((root / link_path / "manifest.json").read_text())
    plugin_id = manifest["id"]
    lock_path.write_text(json.dumps({"schema": "kb.marketplace/3", "plugins": {plugin_id: {
        "source": "local", "link": link_path, "enabled": True
    }}}))
elif args[:4] == ["marketplace", "plugins", "list", "--json"]:
    plugins = json.loads(lock_path.read_text()).get("plugins", {}) if lock_path.exists() else {}
    entries = [{"id": key, "source": value["source"], "scope": "project"}
               for key, value in plugins.items()]
    print(json.dumps({"ok": True, "data": {"entries": entries, "total": len(entries)}}))
    if os.environ.get("FAKE_DISCOVERY_WARNING"):
        print("[discover] non-blocking diagnostic", file=sys.stderr)
elif args[:4] == ["workflow", "defs", "list", "--json"]:
    print(json.dumps({"ok": True, "data": {"defs": []}}))
elif args[:2] == ["docs", "generate-cli-reference"]:
    if not (root / ".kb/kb.config.json").is_file():
        print(json.dumps({"ok": False, "error": {"code": "KB_PROJECT_UNKNOWN",
            "message": "The current directory is not a registered project."}}))
        raise SystemExit(1)
    output = Path(args[args.index("--output") + 1])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("# KB Labs CLI Reference\n", encoding="utf-8")
    print(f"CLI reference generated: {output}")
elif args[:3] == ["marketplace", "plugins", "remove"]:
    lock = json.loads(lock_path.read_text())
    lock["plugins"].pop(args[3], None)
    lock_path.write_text(json.dumps(lock))
elif args[:2] == ["marketplace", "install"]:
    print(json.dumps({"ok": True, "data": {"scope": "project"}}))
elif args[:2] == ["marketplace", "uninstall"]:
    print(json.dumps({"ok": True, "data": {}}))
elif args[:2] == ["adapter", "list"]:
    print(json.dumps({"ok": True, "data": {"adapters": [{
        "slot": "llm", "implementation": "@kb-labs/adapters-openai"
    }]}}))
elif args[:3] == ["config", "get", "platform.adapterOptions.llm.baseURL"]:
    print(json.dumps({"ok": True, "data": {"value": "http://mock-llm:8317/v1"}}))
elif args[:3] == ["adapter", "unbind", "llm"]:
    (root / ".kb/llm-unbound").write_text("true")
    print(json.dumps({"ok": True, "data": {}}))
elif args[:3] == ["adapter", "bind", "llm"]:
    (root / ".kb/llm-unbound").unlink(missing_ok=True)
    print(json.dumps({"ok": True, "data": {}}))
elif args[:3] == ["commit", "commit", "--dry-run"]:
    staged = subprocess.run(["git", "diff", "--cached", "--name-only"], cwd=root,
                            capture_output=True, text=True, check=True).stdout
    if (root / ".kb/llm-unbound").exists():
        print(json.dumps({"ok": False, "error": {"code": "KB_ADAPTER_UNAVAILABLE",
            "message": "Adapter llm is not configured.", "hint": "kb adapter bind llm @kb-labs/adapters-openai"}}))
        raise SystemExit(1)
    if "s030-cancel.ts" in staged:
        tty.setraw(sys.stdin.fileno())
        print("⠋ Analyzing changes...", flush=True)
        print("⠙ Analyzing with native tools...", flush=True)
        if sys.stdin.read(1) == "\x03":
            print("Interrupted")
            raise SystemExit(130)
    if "s030-progress.ts" in staged:
        print("⠋ Analyzing changes...", flush=True)
        print("⠙ Analyzing with native tools...", flush=True)
        print("Re-analyzing with diff context (Phase 2)...", flush=True)
        print("Plan generated", flush=True)
        raise SystemExit(0)
    print(json.dumps({"ok": True, "data": {"plan": {"metadata": {"llmUsed": True}}, "applied": False}}))
elif args[:2] == ["commit", "commit"]:
    changes = subprocess.run(["git", "status", "--porcelain=v1", "--untracked-files=all"],
                             cwd=root, capture_output=True, text=True, check=True).stdout
    if not changes:
        print(json.dumps({"ok": True, "data": {"plan": {"commits": []}, "applied": False, "pushed": False, "commits": []}}))
        raise SystemExit(0)
    subprocess.run(["git", "commit", "-m", "test(journey): verify deterministic commit fixture response"],
                   cwd=root, capture_output=True, text=True, check=True)
    if "--json" in args:
        print(json.dumps({"ok": True, "data": {"plan": {"metadata": {"llmUsed": True}}, "applied": True,
                          "pushed": False, "commits": [{"message": "test(journey): verify deterministic commit fixture response"}]}}))
    else:
        print("Commits created successfully")
elif args[:3] == ["review", "run", "--mode=heuristic"] and "--json" not in args:
    print("Files: 1\nFindings: 0\n")
elif args[:3] == ["review", "run", "--mode=heuristic"]:
    print(json.dumps({"ok": True, "data": {"findings": [{"file": ".kb/journey-commit-cases/s015-review.ts", "line": 1}], "metadata": {"mode": "heuristic", "analyzedFiles": 1}}}))
elif args[:2] == ["review", "run"] and "--mode=llm" in args:
    if (root / ".kb/llm-unbound").exists():
        print(json.dumps({"ok": False, "error": {"code": "KB_ADAPTER_UNAVAILABLE",
            "message": "Adapter llm is not configured.", "hint": "kb adapter bind llm @kb-labs/adapters-openai"}}))
        raise SystemExit(1)
    print(json.dumps({"ok": True, "data": {"findings": []}}))
elif args[:2] == ["review", "run"]:
    print(json.dumps({"ok": True, "data": {"findings": []}}))
elif args == ["--help"]:
    print("Commands: demo")
elif args == ["demo", "hello"]:
    built = plugin / ".built-output"
    if not built.exists():
        raise SystemExit("plugin has not been built")
    probe = root / ".kb/output/runtime-temp-probe.txt"
    probe.parent.mkdir(parents=True, exist_ok=True)
    probe.write_text("plugin temp fs ok")
    print(built.read_text())
else:
    raise SystemExit("unexpected kb command: " + " ".join(args))
'''


FAKE_PNPM = r'''#!/usr/bin/env python3
import os
import sys
from pathlib import Path

args = sys.argv[1:]
with Path(os.environ["FAKE_JOURNEY_LOG"]).open("a", encoding="utf-8") as stream:
    stream.write("pnpm " + " ".join(args) + "\n")
if args == ["install"]:
    raise SystemExit(0)
if args == ["build"]:
    if os.environ.get("FAIL_PNPM_BUILD"):
        detail = os.environ.get("LONG_BUILD_ERROR", "simulated build error")
        print(detail)
        raise SystemExit(2)
    plugin = Path.cwd()
    source = (plugin / "src/core/hello.ts").read_text()
    output = "Edited demo greeting for World!" if "Edited demo greeting" in source else "Hello, World from demo!"
    (plugin / "dist").mkdir(parents=True, exist_ok=True)
    (plugin / "dist/manifest.js").write_text("export default {};\n")
    (plugin / ".built-output").write_text(output)
    raise SystemExit(0)
raise SystemExit("unexpected pnpm command: " + " ".join(args))
'''


class PluginAuthorJourneyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kb-plugin-author-")
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.project = self.home / "project"
        self.bin = self.home / ".local/bin"
        self.project.mkdir(parents=True)
        (self.project / ".kb").mkdir()
        (self.project / ".kb/kb.config.json").write_text("{}")
        self.bin.mkdir(parents=True)
        self.kb = self.bin / "kb"
        self.pnpm = self.bin / "pnpm"
        self.kb.write_text(FAKE_KB)
        self.pnpm.write_text(FAKE_PNPM)
        self.kb.chmod(0o755)
        self.pnpm.chmod(0o755)
        self.log = self.root / "commands.log"
        self.env = os.environ.copy()
        self.env.update({
            "HOME": str(self.home),
            "PATH": f"{self.bin}:{self.env.get('PATH', '')}",
            "FAKE_JOURNEY_LOG": str(self.log),
            "FAKE_MARKETPLACE_URL_LOG": str(self.root / "marketplace-url.log"),
        })

    def tearDown(self):
        self.temp.cleanup()

    def test_fake_cli_rejects_unregistered_nested_plugin_routes(self):
        result = subprocess.run([str(self.kb), "commit", "bogus", "--help"],
                                cwd=self.project, env=self.env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)

    def test_nonzero_route_help_reports_preflight_failure_and_actual_output(self):
        result = subprocess.CompletedProcess(
            [str(self.kb), "commit", "commit", "--help", "--json"],
            1,
            "",
            "plugin startup failed while loading configuration",
        )

        with self.assertRaises(RuntimeError) as raised:
            _validate_plugin_route_help(["commit", "commit"], result)

        self.assertEqual(str(raised.exception),
                         "journey command 'commit commit' help preflight failed (exit 1): "
                         "plugin startup failed while loading configuration")

    def test_only_unknown_command_result_reports_route_absent(self):
        result = subprocess.CompletedProcess(
            [str(self.kb), "commit", "bogus", "--help", "--json"],
            2,
            json.dumps({"ok": False, "error": {"code": "KB_RUNTIME_UNKNOWN_COMMAND"}}),
            "",
        )

        with self.assertRaises(RuntimeError) as raised:
            _validate_plugin_route_help(["commit", "bogus"], result)

        self.assertEqual(str(raised.exception),
                         "journey command 'commit bogus' is absent from the live CLI registry: "
                         '{"ok": false, "error": {"code": "KB_RUNTIME_UNKNOWN_COMMAND"}}')

    def run_flow(self, *, mode="local", fail_build=False):
        if fail_build:
            self.env["FAIL_PNPM_BUILD"] = "1"
        journey = Journey(mode, "plugin-author-fixture")
        run_plugin_author_flow(journey, self.project, self.kb, "http://verdaccio:4873",
                               command_runner=subprocess.run, base_env=self.env)
        return journey.result()

    def test_marketplace_sync_fixture_records_marketplace_requests(self):
        process, marketplace_url, startup_error = start_marketplace_sync_fixture(
            self.project, self.env, request_recorder=True)
        self.assertIsNone(startup_error, startup_error)
        self.assertIsNotNone(process)
        self.assertIsNotNone(marketplace_url)
        self.addCleanup(stop_marketplace_sync_fixture, process)

        request = urllib.request.Request(
            f"{marketplace_url}/api/v1/marketplace/packages/link",
            data=b"{}", headers={"Content-Type": "application/json"}, method="POST")
        status, _, _ = open_http(urllib.request.urlopen, request, timeout=10, env=self.env)
        self.assertEqual(status, 204)

        self.assertEqual(marketplace_sync_request_count(marketplace_url, self.env), 1)

    # case: S-014.1
    def test_commit_and_review_case_steps_are_claimed_from_fake_cli_responses(self):
        (self.project / ".kb/marketplace.lock").write_text(json.dumps({
            "schema": "kb.marketplace/3",
            "plugins": {"@kb-labs/commit": {
                "enabled": True,
                "version": "2.120.1",
                "integrity": "sha256-fixture",
                "source": "marketplace",
                "package": "@kb-labs/commit",
            }},
        }))
        journey = Journey("local", "commit-case-fixture")
        run_commit_case_steps(journey, self.project, self.kb, "http://verdaccio:4873",
                              subprocess.run, self.env)
        result = journey.result()
        expected = {
            *(f"S-014.{step}" for step in range(1, 4)),
            *(f"S-015.{step}" for step in range(1, 5)),
            *(f"S-030.{step}" for step in range(1, 5)),
            *(f"S-160.{step}" for step in range(1, 5)),
        }
        claims = {claim["claimId"]: claim["status"] for claim in result.case_run["claims"]}
        self.assertTrue(expected.issubset(claims))
        self.assertEqual({step: claims[step] for step in ("S-014.1", "S-014.2", "S-014.3")}, {
            "S-014.1": "PASS", "S-014.2": "PASS", "S-014.3": "PASS",
        })
        self.assertEqual({step: claims[step] for step in ("S-015.1", "S-015.2", "S-015.3", "S-015.4")}, {
            "S-015.1": "PASS", "S-015.2": "PASS", "S-015.3": "PASS", "S-015.4": "PASS",
        })
        self.assertEqual({step: claims[step] for step in ("S-160.1", "S-160.2", "S-160.3", "S-160.4")}, {
            "S-160.1": "PASS", "S-160.2": "PASS", "S-160.3": "PASS", "S-160.4": "PASS",
        }, result.steps)
        self.assertEqual({step: claims[step] for step in ("S-030.1", "S-030.2", "S-030.3", "S-030.4")}, {
            "S-030.1": "PASS", "S-030.2": "PASS", "S-030.3": "PASS", "S-030.4": "PASS",
        })

    def test_commit_and_review_fixture_finishes_with_a_clean_worktree(self):
        (self.project / ".kb/marketplace.lock").write_text(json.dumps({
            "schema": "kb.marketplace/3",
            "plugins": {"@kb-labs/commit": {
                "enabled": True,
                "version": "2.120.1",
                "integrity": "sha256-fixture",
                "source": "marketplace",
                "package": "@kb-labs/commit",
            }},
        }))

        journey = Journey("local", "commit-case-clean-worktree")
        run_commit_case_steps(journey, self.project, self.kb, "http://verdaccio:4873",
                              subprocess.run, self.env)

        status = subprocess.run(["git", "status", "--porcelain=v1", "--untracked-files=all"],
                                cwd=self.project, capture_output=True, text=True, check=True)
        self.assertEqual(status.stdout, "", journey.result().steps)

    def test_commit_fixture_recovers_repository_without_head(self):
        (self.project / ".git").mkdir()
        (self.project / ".kb/marketplace.lock").write_text(json.dumps({
            "schema": "kb.marketplace/3",
            "plugins": {"@kb-labs/commit": {
                "enabled": True,
                "version": "2.120.1",
                "integrity": "sha256-fixture",
                "source": "marketplace",
                "package": "@kb-labs/commit",
            }},
        }))

        journey = Journey("local", "commit-case-headless-repository")
        run_commit_case_steps(journey, self.project, self.kb, "http://verdaccio:4873",
                              subprocess.run, self.env)

        result = journey.result()
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.project,
                              capture_output=True, text=True, check=True)
        self.assertTrue(head.stdout.strip())
        self.assertEqual(result.steps[0]["status"], "PASS", result.steps)

    # case: S-003.1
    # case: S-003.7, S-003.8, S-041.10
    # case: S-210.1
    def test_scaffold_add_edit_invoke_and_remove_records_all_case_steps(self):
        result = self.run_flow()

        self.assertEqual(result.status, "PASS")
        self.assertEqual(
            [step["cases"] for step in result.steps],
            [["S-003.1"], ["S-003.2"], ["S-003.3"], ["S-041.10"], ["S-003.7"],
             ["S-003.8"], ["S-003.4", "S-210.1"], ["S-003.5"], ["S-003.6"]],
        )
        claims = {claim["claimId"]: claim["status"] for claim in result.case_run["claims"]}
        self.assertEqual({case_id: claims[case_id] for case_id in
                          ("S-003.7", "S-003.8", "S-041.10")},
                         {"S-003.7": "PASS", "S-003.8": "PASS", "S-041.10": "PASS"})
        self.assertEqual(
            {claim["claimId"]: (claim["kind"], claim["status"])
             for claim in result.case_run["claims"]},
            {f"S-003.{step}": ("journey", "PASS") for step in range(1, 9)}
            | {"S-041.10": ("journey", "PASS"), "S-210.1": ("journey", "PASS")},
        )
        self.assertEqual(json.loads((self.project / ".kb/marketplace.lock").read_text())["plugins"], {})
        marketplace_url = (self.root / "marketplace-url.log").read_text(encoding="utf-8")
        self.assertTrue(marketplace_url.startswith("http://127.0.0.1:"))
        commands = self.log.read_text().splitlines()
        self.assertEqual(commands[:15], [
            "kb scaffold run plugin demo --mode standalone --yes",
            "pnpm install",
            "pnpm build",
            "kb marketplace plugins add --link .kb/plugins/demo",
            "kb marketplace plugins list --json",
            "kb workflow defs list --json",
            "kb marketplace plugins list --json",
            "kb demo hello",
            "kb docs generate-cli-reference --output docs/CLI-REFERENCE.md",
            "kb docs generate-cli-reference --output docs/CLI-REFERENCE.md",
            f"kb marketplace plugins add --link {self.project / '.kb/plugins/demo'}",
            "kb --help",
            "kb demo hello",
            "pnpm build",
            "kb demo hello",
        ])
        self.assertTrue(commands[15].startswith("kb marketplace plugins remove "))
        self.assertEqual(commands[16:], ["kb marketplace plugins list --json"])
        self.assertFalse((self.project / ".kb/plugins/demo").exists())
        self.assertEqual(json.loads((self.project / ".kb/marketplace.lock").read_text())["plugins"], {})

    def test_secured_profile_runs_the_same_author_flow(self):
        result = self.run_flow(mode="secured")

        self.assertEqual(result.status, "PASS")
        self.assertTrue(all(step["mode"] == "secured" for step in result.steps))
        claims = {claim["claimId"]: claim["status"] for claim in result.case_run["claims"]}
        self.assertEqual(claims["S-003.7"], "PASS")
        self.assertEqual(claims["S-003.8"], "PASS")
        self.assertNotIn("S-041.10", claims)

    # case: S-003.3
    def test_parseable_plugin_list_stdout_survives_discovery_stderr(self):
        self.env["FAKE_DISCOVERY_WARNING"] = "1"
        result = self.run_flow()

        self.assertEqual(result.status, "PASS", result.steps)
        claims = {claim["claimId"]: claim["status"] for claim in result.case_run["claims"]}
        self.assertEqual(claims["S-003.3"], "PASS")

    def test_build_failure_is_reported_and_generated_files_are_cleaned(self):
        result = self.run_flow(fail_build=True)

        self.assertEqual(result.status, "FAIL")
        self.assertEqual(result.first_failure["name"], "build generated plugin")
        self.assertIn("pnpm build exited 2; simulated build error", result.first_failure["message"])
        self.assertEqual(result.case_run["claims"], [
            {"claimId": "S-003.1", "kind": "journey", "status": "PASS"},
            {"claimId": "S-003.2", "kind": "journey", "status": "FAIL"},
        ])
        self.assertFalse((self.project / ".kb/plugins/demo").exists())

    def test_build_failure_keeps_the_complete_pnpm_policy_diagnostic(self):
        self.env["FAIL_PNPM_BUILD"] = "1"
        self.env["LONG_BUILD_ERROR"] = "ERR_PNPM_MINIMUM_RELEASE_AGE" + "x" * 800

        result = self.run_flow()

        self.assertIn("ERR_PNPM_MINIMUM_RELEASE_AGE", result.first_failure["message"])

    def test_add_failure_is_recorded_without_masking_it_with_a_blocked_step_error(self):
        self.env["FAIL_MARKETPLACE_ADD"] = "1"

        result = self.run_flow()

        self.assertEqual(result.status, "FAIL")
        self.assertEqual(result.first_failure["name"], "add plugin to project")
        self.assertIn("simulated marketplace plugins add failure", result.first_failure["message"])
        self.assertEqual(result.steps[-1]["status"], "BLOCKED")
        self.assertEqual(result.steps[-1]["name"], "remove plugin registration")
        self.assertIn("plugin was not added", result.steps[-1]["message"])


if __name__ == "__main__":
    unittest.main()
