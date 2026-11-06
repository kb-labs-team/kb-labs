from __future__ import annotations

import http.client
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import threading
import unittest
from io import BytesIO
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from test_environment import isolated_environment


ROOT = Path(__file__).resolve().parents[2]
REGISTRY = ROOT / "e2e/journey/candidate-package-registry.mjs"
CLEAR_CANDIDATES = ROOT / "e2e/verdaccio/clear-candidates.sh"


class CandidatePackageRegistryTests(unittest.TestCase):
    def _run_service_without_owner_source(self, temporary: str, service_call: str) -> tuple[subprocess.CompletedProcess[str], Path]:
        root = Path(temporary)
        workspace = root / "unrelated-workspace"
        (workspace / "tools/kb-create").mkdir(parents=True)
        bin_dir = root / "bin"
        bin_dir.mkdir()
        operations = root / "service-operations.txt"
        for name, script in {
            "go": '#!/bin/sh\nprintf "go\\n" >> "$SERVICE_OPERATIONS"\nexit 0\n',
            "node": '#!/bin/sh\nprintf "node\\n" >> "$SERVICE_OPERATIONS"\nprintf "http://127.0.0.1:49666\\n"\n',
            "python3": '#!/bin/sh\nprintf "python3\\n" >> "$SERVICE_OPERATIONS"\nexit 0\n',
            "curl": '#!/bin/sh\nprintf "curl\\n" >> "$SERVICE_OPERATIONS"\nexit 0\n',
            "sh": '#!/bin/sh\nprintf "sh\\n" >> "$SERVICE_OPERATIONS"\nexit 0\n',
            "sudo": '#!/bin/sh\nprintf "sudo\\n" >> "$SERVICE_OPERATIONS"\nexit 0\n',
        }.items():
            command = bin_dir / name
            command.write_text(script, encoding="utf-8")
            command.chmod(0o755)
        env = isolated_environment(
            root / "home", bin_dir, required_tools=("bash", "mktemp"),
            overrides={"RUNNER_TEMP": str(root), "SERVICE_OPERATIONS": str(operations)},
        )
        registry_pipe = root / "registry.pipe"
        os.mkfifo(registry_pipe)
        script = (
            'source "$1"; source "$2"; COMPOSE_AVAILABLE=1; '
            'journey_start_registry() { return 0; }; '
            f'{service_call} "$3"; service_status=$?; '
            'if [[ -n "${JOURNEY_CANDIDATE_REGISTRY_PID:-}" ]]; then '
            'wait "$JOURNEY_CANDIDATE_REGISTRY_PID" 2>/dev/null || true; fi; '
            'exit "$service_status"'
        )
        result = subprocess.run(
            ["bash", "-c", script, "candidate-service-no-owner", str(ROOT / "e2e/compose-owner.sh"),
             str(ROOT / "e2e/journey/candidate-services.sh"), str(registry_pipe)],
            cwd=workspace, env=env, capture_output=True, text=True, check=False,
        )
        return result, operations

    def _start_compose_registry(self, temporary: str) -> tuple[subprocess.CompletedProcess[str], list[str], Path, list[str]]:
        root = Path(temporary)
        workspace = root / "workspace"
        bin_dir = root / "bin"
        bin_dir.mkdir()
        (workspace / "e2e/journey").mkdir(parents=True)
        (workspace / "e2e/verdaccio").mkdir(parents=True)
        (workspace / "pnpm-workspace.yaml").write_text("packages: []\n", encoding="utf-8")
        shutil.copy2(ROOT / "e2e/compose-owner.sh", workspace / "e2e/compose-owner.sh")
        shutil.copy2(ROOT / "e2e/journey/candidate-services.sh", workspace / "e2e/journey/candidate-services.sh")
        shutil.copy2(REGISTRY, workspace / "e2e/journey/candidate-package-registry.mjs")
        shutil.copy2(CLEAR_CANDIDATES, workspace / "e2e/verdaccio/clear-candidates.sh")
        calls_path = root / "compose-calls.txt"
        clear_path = root / "cleared-storage-script.sh"
        registry_pipe = root / "registry.pipe"
        os.mkfifo(registry_pipe)
        candidate_registry_args = root / "candidate-registry-args.txt"
        docker = bin_dir / "docker"
        docker.write_text(
            "#!/bin/sh\n"
            "printf '%s\\n' \"$*\" >> \"$FAKE_DOCKER_CALLS\"\n"
            "case \"$*\" in\n"
            "  *'compose version') exit 0 ;;\n"
            "  *' port verdaccio 4873') printf '127.0.0.1:49183\\n'; exit 0 ;;\n"
            "  *'run --rm --no-deps --entrypoint sh verdaccio -s -- /verdaccio/storage') cat > \"$FAKE_CLEAR_SCRIPT\"; exit 0 ;;\n"
            "  *'up -d --wait verdaccio') exit 0 ;;\n"
            "  *'stop verdaccio') exit 0 ;;\n"
            "esac\n"
            "exit 97\n",
            encoding="utf-8",
        )
        docker.chmod(0o755)
        npx = bin_dir / "npx"
        npx.write_text("#!/bin/sh\nprintf 'npx\\n' >> \"$FAKE_DOCKER_CALLS\"\nexit 97\n", encoding="utf-8")
        npx.chmod(0o755)
        node = bin_dir / "node"
        node.write_text(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$FAKE_NODE_ARGS\"\n"
            "printf 'http://127.0.0.1:49666\\n'\n",
            encoding="utf-8",
        )
        node.chmod(0o755)
        env = isolated_environment(
            root / "home", bin_dir, required_tools=("bash", "cat"),
            overrides={"FAKE_DOCKER_CALLS": str(calls_path), "FAKE_CLEAR_SCRIPT": str(clear_path),
                       "FAKE_NODE_ARGS": str(candidate_registry_args)},
        )
        result = subprocess.run(
            ["bash", "-c",
             'source e2e/compose-owner.sh; source e2e/journey/candidate-services.sh; '
             'journey_compose_init "$1"; journey_start_candidate_registry "$1/e2e/packages" '
             '"$1/.journey/release/journey-candidate" "$2"; journey_stop_registry; '
             'printf "%s\\n" "$JOURNEY_CANDIDATE_REGISTRY_URL"',
             "journey-registry-test", str(workspace), str(registry_pipe)],
            cwd=workspace, env=env, capture_output=True, text=True, check=False,
        )
        calls = calls_path.read_text(encoding="utf-8").splitlines()
        node_args = candidate_registry_args.read_text(encoding="utf-8").splitlines()
        return result, calls, clear_path, node_args

    def test_host_registry_upstream_uses_compose_published_port(self):
        with tempfile.TemporaryDirectory(prefix="journey-compose-registry-port-") as temporary:
            result, calls, _, node_args = self._start_compose_registry(temporary)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Journey registry: http://127.0.0.1:49183", result.stderr)
        self.assertTrue(any(call.endswith("port verdaccio 4873") for call in calls), calls)
        self.assertEqual(node_args[-1], "http://127.0.0.1:49183", node_args)
        self.assertIn("Journey candidate registry: http://127.0.0.1:49666", result.stdout)
        self.assertNotIn("127.0.0.1:4873", result.stdout)

    def test_candidate_runtime_requires_owner_workspace_source(self):
        with tempfile.TemporaryDirectory(prefix="journey-runtime-no-owner-") as temporary:
            result, operations = self._run_service_without_owner_source(
                temporary, 'journey_install_candidate_runtime index.json packages install-root',
            )
            operations_exist = operations.exists()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(operations_exist)
        self.assertTrue(result.stderr)

    def test_candidate_registry_requires_owner_workspace_source(self):
        with tempfile.TemporaryDirectory(prefix="journey-registry-no-owner-") as temporary:
            result, operations = self._run_service_without_owner_source(
                temporary, 'journey_start_candidate_registry packages candidate',
            )
            operations_exist = operations.exists()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(operations_exist)
        self.assertTrue(result.stderr)

    def test_host_services_require_owner_workspace_source(self):
        with tempfile.TemporaryDirectory(prefix="journey-host-no-owner-") as temporary:
            result, operations = self._run_service_without_owner_source(
                temporary, 'journey_start_host_services',
            )
            operations_exist = operations.exists()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(operations_exist)
        self.assertTrue(result.stderr)

    # case: S-195.6
    def test_candidate_runtime_install_uses_compose_registry(self):
        with tempfile.TemporaryDirectory(prefix="journey-candidate-runtime-registry-") as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            bin_dir = root / "bin"
            bin_dir.mkdir()
            (workspace / "e2e/journey").mkdir(parents=True)
            (workspace / "e2e/verdaccio").mkdir(parents=True)
            (workspace / "tools/kb-create").mkdir(parents=True)
            (workspace / "pnpm-workspace.yaml").write_text("packages: []\n", encoding="utf-8")
            shutil.copy2(ROOT / "e2e/compose-owner.sh", workspace / "e2e/compose-owner.sh")
            shutil.copy2(ROOT / "e2e/journey/candidate-services.sh", workspace / "e2e/journey/candidate-services.sh")
            shutil.copy2(CLEAR_CANDIDATES, workspace / "e2e/verdaccio/clear-candidates.sh")
            calls_path = root / "compose-calls.txt"
            clear_path = root / "cleared-storage-script.sh"
            go_args = root / "go-args.txt"
            docker = bin_dir / "docker"
            docker.write_text(
                "#!/bin/sh\n"
                "printf '%s\\n' \"$*\" >> \"$FAKE_DOCKER_CALLS\"\n"
                "case \"$*\" in\n"
                "  *'compose version') exit 0 ;;\n"
                "  *' port verdaccio 4873') printf '127.0.0.1:49183\\n'; exit 0 ;;\n"
                "  *'run --rm --no-deps --entrypoint sh verdaccio -s -- /verdaccio/storage') cat > \"$FAKE_CLEAR_SCRIPT\"; exit 0 ;;\n"
                "  *'up -d --wait verdaccio'|*'stop verdaccio') exit 0 ;;\n"
                "esac\nexit 97\n",
                encoding="utf-8",
            )
            docker.chmod(0o755)
            go = bin_dir / "go"
            go.write_text(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$FAKE_GO_ARGS\"\nprintf '/runtime/content\\n'\n",
                encoding="utf-8",
            )
            go.chmod(0o755)
            npx = bin_dir / "npx"
            npx.write_text("#!/bin/sh\nprintf 'npx\\n' >> \"$FAKE_DOCKER_CALLS\"\nexit 97\n", encoding="utf-8")
            npx.chmod(0o755)
            env = isolated_environment(
                root / "home", bin_dir, required_tools=("bash", "cat"),
                overrides={"FAKE_DOCKER_CALLS": str(calls_path), "FAKE_CLEAR_SCRIPT": str(clear_path),
                           "FAKE_GO_ARGS": str(go_args)},
            )
            result = subprocess.run(
                ["bash", "-c",
                 'source e2e/compose-owner.sh; source e2e/journey/candidate-services.sh; '
                 'journey_compose_init "$PWD"; '
                 'runtime_root="$(journey_install_candidate_runtime index.json packages root)"; '
                 'printf "RUNTIME_ROOT=%s\\n" "$runtime_root"; journey_stop_registry',
                 "journey-candidate-runtime-test"],
                cwd=workspace, env=env, capture_output=True, text=True, check=False,
            )
            compose_calls = calls_path.read_text(encoding="utf-8").splitlines()
            package_manager_args = go_args.read_text(encoding="utf-8").splitlines()
            workspace_paths = {path.relative_to(workspace).as_posix() for path in workspace.rglob("*")}

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "RUNTIME_ROOT=/runtime/content\n")
        self.assertIn("Journey registry: http://127.0.0.1:49183", result.stderr)
        self.assertTrue(any(call.endswith("port verdaccio 4873") for call in compose_calls), compose_calls)
        self.assertIn("--registry", package_manager_args)
        registry_index = package_manager_args.index("--registry")
        self.assertEqual(package_manager_args[registry_index + 1], "http://127.0.0.1:49183")
        self.assertNotIn("registry.npmjs.org", package_manager_args)
        self.assertFalse(any("npx" in call or "verdaccio@" in call for call in compose_calls), compose_calls)
        self.assertEqual(len([call for call in compose_calls if call.startswith("compose ")]), 5, compose_calls)
        self.assertEqual(workspace_paths, {
            "pnpm-workspace.yaml", "e2e", "e2e/journey", "e2e/compose-owner.sh", "e2e/journey/candidate-services.sh",
            "e2e/verdaccio", "e2e/verdaccio/clear-candidates.sh", "tools", "tools/kb-create",
        })

    # case: S-195.6
    def test_workspace_install_uses_compose_registry(self):
        with tempfile.TemporaryDirectory(prefix="journey-workspace-install-registry-") as temporary:
            root = Path(temporary)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            calls_path = root / "compose-calls.txt"
            clear_path = root / "cleared-storage-script.sh"
            pnpm_args = root / "pnpm-args.txt"
            docker = bin_dir / "docker"
            docker.write_text(
                "#!/bin/sh\n"
                "printf '%s\\n' \"$*\" >> \"$FAKE_DOCKER_CALLS\"\n"
                "case \"$*\" in\n"
                "  *'compose version') exit 0 ;;\n"
                "  *' port verdaccio 4873') printf '127.0.0.1:49183\\n'; exit 0 ;;\n"
                "  *'run --rm --no-deps --entrypoint sh verdaccio -s -- /verdaccio/storage') cat > \"$FAKE_CLEAR_SCRIPT\"; exit 0 ;;\n"
                "  *'up -d --wait verdaccio') exit 0 ;;\n"
                "esac\nexit 97\n",
                encoding="utf-8",
            )
            docker.chmod(0o755)
            pnpm = bin_dir / "pnpm"
            pnpm.write_text(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$FAKE_PNPM_ARGS\"\n",
                encoding="utf-8",
            )
            pnpm.chmod(0o755)
            env = isolated_environment(
                root / "home", bin_dir, required_tools=("bash", "cat", "dirname"),
                overrides={"FAKE_DOCKER_CALLS": str(calls_path), "FAKE_CLEAR_SCRIPT": str(clear_path),
                           "FAKE_PNPM_ARGS": str(pnpm_args)},
            )
            result = subprocess.run(
                ["bash", str(ROOT / "e2e/journey/install-workspace-dependencies.sh")],
                cwd=ROOT, env=env, capture_output=True, text=True, check=False,
            )
            compose_calls = calls_path.read_text(encoding="utf-8").splitlines()
            install_args = pnpm_args.read_text(encoding="utf-8").splitlines()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(any(call.endswith("port verdaccio 4873") for call in compose_calls), compose_calls)
        self.assertEqual(install_args, ["install", "--frozen-lockfile", "--registry", "http://127.0.0.1:49183"])
        self.assertNotIn("registry.npmjs.org", install_args)

    # case: S-195.3
    def test_host_registry_lifecycle_has_no_second_config_or_storage_owner(self):
        with tempfile.TemporaryDirectory(prefix="journey-compose-registry-owner-") as temporary:
            result, calls, clear_script, _ = self._start_compose_registry(temporary)
            cleared = clear_script.read_text(encoding="utf-8")
            directory_names = {path.name for path in Path(temporary).iterdir()}
            workspace_paths = {path.relative_to(Path(temporary) / "workspace").as_posix()
                               for path in (Path(temporary) / "workspace").rglob("*")}
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len([call for call in calls if call.startswith("compose ")]), 5, calls)
        self.assertFalse(any("npx" in call or "verdaccio@" in call for call in calls), calls)
        self.assertIn("@kb-labs%2f*", cleared)
        self.assertEqual(directory_names, {"workspace", "bin", "home", "compose-calls.txt", "cleared-storage-script.sh",
                                           "candidate-registry-args.txt", "registry.pipe"})
        self.assertEqual(workspace_paths, {
            "pnpm-workspace.yaml", "e2e", "e2e/journey", "e2e/compose-owner.sh", "e2e/journey/candidate-services.sh",
            "e2e/journey/candidate-package-registry.mjs",
            "e2e/verdaccio", "e2e/verdaccio/clear-candidates.sh",
        })

    def test_candidate_registry_uses_cached_uplink_and_serves_current_tarball(self):
        with tempfile.TemporaryDirectory(prefix="journey-candidate-registry-") as temporary:
            root = Path(temporary)
            packages = root / "packages"
            candidate = root / "candidate"
            packages.mkdir()
            candidate.mkdir()
            (candidate / "release-index.json").write_text("{}", encoding="utf-8")
            tarball = packages / "candidate.tgz"
            self._write_tarball(tarball, "first candidate")
            upstream_requests: list[str] = []

            class UpstreamHandler(BaseHTTPRequestHandler):
                def do_GET(self):  # noqa: N802
                    upstream_requests.append(self.path)
                    payload = json.dumps({"name": "third-party", "servedBy": "cache"}).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)

                def log_message(self, *_args):
                    pass

            upstream = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
            upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
            upstream_thread.start()
            process = None
            try:
                process = subprocess.Popen(
                    ["node", str(REGISTRY), str(packages), str(candidate), "0",
                     f"http://127.0.0.1:{upstream.server_port}"],
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                )
                registry_url = process.stdout.readline().strip()
                process.stdout.close()
                self.assertTrue(registry_url.startswith("http://127.0.0.1:"), registry_url)
                self.assertEqual(self._get_json(registry_url, "/third-party"),
                                 {"name": "third-party", "servedBy": "cache"})
                self.assertEqual(upstream_requests, ["/third-party"])

                metadata = self._get_json(registry_url, "/@kb-labs%2fsample")
                tarball_path = metadata["versions"]["1.0.0"]["dist"]["tarball"]
                package_body = self._get(registry_url, tarball_path)
                self.assertEqual(self._tar_content(package_body), b"first candidate")

                process.terminate()
                process.wait(timeout=5)
                self._write_tarball(tarball, "updated candidate")
                process = subprocess.Popen(
                    ["node", str(REGISTRY), str(packages), str(candidate), "0",
                     f"http://127.0.0.1:{upstream.server_port}"],
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                )
                registry_url = process.stdout.readline().strip()
                process.stdout.close()
                self.assertEqual(self._tar_content(self._get(
                    registry_url, self._get_json(registry_url, "/@kb-labs%2fsample")
                    ["versions"]["1.0.0"]["dist"]["tarball"])), b"updated candidate")
            finally:
                if process is not None and process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)
                if process is not None and process.stdout is not None and not process.stdout.closed:
                    process.stdout.close()
                upstream.shutdown()
                upstream.server_close()
                upstream_thread.join(timeout=5)

    # case: S-195.3
    def test_candidate_scope_cleanup_preserves_third_party_cache(self):
        with tempfile.TemporaryDirectory(prefix="journey-verdaccio-cache-") as temporary:
            storage = Path(temporary)
            candidate = storage / "@kb-labs%2fsample"
            third_party = storage / "lodash"
            candidate.mkdir()
            third_party.mkdir()
            (candidate / "package.json").write_text("{}", encoding="utf-8")
            (third_party / "package.json").write_text("{}", encoding="utf-8")
            result = subprocess.run(["sh", str(CLEAR_CANDIDATES), str(storage)],
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(candidate.exists())
            self.assertTrue((third_party / "package.json").is_file())

    @staticmethod
    def _write_tarball(path: Path, content: str) -> None:
        with tempfile.TemporaryDirectory(prefix="journey-tarball-") as temporary:
            package = Path(temporary) / "package"
            package.mkdir()
            (package / "package.json").write_text(
                json.dumps({"name": "@kb-labs/sample", "version": "1.0.0"}),
                encoding="utf-8",
            )
            (package / "content.txt").write_text(content, encoding="utf-8")
            with tarfile.open(path, "w:gz") as archive:
                archive.add(package, arcname="package")

    @staticmethod
    def _tar_content(data: bytes) -> bytes:
        with tarfile.open(fileobj=BytesIO(data), mode="r:gz") as archive:
            return archive.extractfile("package/content.txt").read()

    @staticmethod
    def _get(url: str, path: str) -> bytes:
        from urllib.parse import urlsplit

        parsed = urlsplit(url)
        connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=5)
        connection.request("GET", path)
        response = connection.getresponse()
        body = response.read()
        if response.status != 200:
            raise AssertionError(f"GET {path} returned {response.status}: {body!r}")
        connection.close()
        return body

    @classmethod
    def _get_json(cls, url: str, path: str) -> dict:
        return json.loads(cls._get(url, path))


if __name__ == "__main__":
    unittest.main()
