import base64
import hashlib
import io
import json
import os
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[2]
PUBLISHER = ROOT / "e2e" / "publisher" / "publish.sh"


class PublisherConflictTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kb-publisher-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.packages = self.root / "packages"
        self.packages.mkdir()
        self.tarball = self.packages / "sample-1.2.3.tgz"
        self.write_tarball(self.tarball, "1.2.3", "default")
        self.local_integrity = self.integrity(self.tarball)
        self.local_shasum = hashlib.sha1(self.tarball.read_bytes()).hexdigest()
        self.publish_log = self.root / "published-digests.txt"
        self.tag_log = self.root / "published-tags.txt"
        self._write_executable(
            "curl",
            "#!/bin/sh\n"
            "case \"$*\" in *'/-/ping'*) printf 'pong\\n' ;; *) printf '{}\\n' ;; esac\n",
        )
        self._write_executable(
            "npm",
            "#!/bin/sh\n"
            "case \"$1\" in\n"
            "  config) exit 0 ;;\n"
            "  whoami) [ \"${PUBLISH_AUTH_FAIL:-0}\" = 0 ] && { echo e2e; exit 0; }; exit 1 ;;\n"
            "  publish) printf 'sha512-%s\\n' \"$(python3 -c 'import hashlib,sys; print(hashlib.sha512(open(sys.argv[1],\"rb\").read()).hexdigest())' \"$2\")\" >> \"$PUBLISH_LOG\"; "
            "metadata=$(tar -xOzf \"$2\" package/package.json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d[\"name\"]+\"@\"+d[\"version\"])'); "
            "tag=latest; while [ \"$#\" -gt 0 ]; do if [ \"$1\" = --tag ]; then tag=$2; shift 2; else shift; fi; done; "
            "printf '%s %s\\n' \"$metadata\" \"$tag\" >> \"$PUBLISH_TAG_LOG\"; "
            "if [ \"$PUBLISH_REJECT_OLD_LATEST\" = 1 ] && [ \"$metadata\" = '@kb-labs/sample@2.120.1' ] && [ \"$tag\" = latest ]; then echo 'npm ERR! Cannot implicitly apply latest because 2.120.2 is higher'; exit 1; fi; "
            "if [ \"$PUBLISH_CONFLICT\" = 1 ]; then echo 'npm ERR! code EPUBLISHCONFLICT: 409 already exists'; exit 1; fi; "
            "echo published; exit 0 ;;\n"
            "  view) [ \"$PUBLISH_CONFLICT\" = 1 ] || exit 1; case \"$*\" in *dist.integrity*) printf '%s\\n' \"$REGISTRY_INTEGRITY\" ;; "
            "*) printf '%s\\n' \"$REGISTRY_SHASUM\" ;; esac ;;\n"
            "  *) exit 2 ;;\n"
            "esac\n",
        )

    def _write_executable(self, name, contents):
        path = self.bin / name
        path.write_text(contents)
        path.chmod(0o755)

    def write_tarball(self, path, version, marker):
        path.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(path, "w:gz") as archive:
            files = {
                "package/package.json": json.dumps(
                    {"name": "@kb-labs/sample", "version": version}
                ).encode(),
                "package/build-marker.txt": marker.encode(),
            }
            for name, contents in files.items():
                info = tarfile.TarInfo(name)
                info.size = len(contents)
                archive.addfile(info, io.BytesIO(contents))

    def integrity(self, path):
        return "sha512-" + base64.b64encode(hashlib.sha512(path.read_bytes()).digest()).decode()

    def publish(self, registry_integrity="", registry_shasum="", conflict=True, packages_dir=None, reject_old_latest=False, auth_failure=False):
        resolution = subprocess.run(
            ["bash", str(ROOT / "e2e" / "compose-owner.sh"), "resolve"],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(resolution.returncode, 0, resolution.stderr)
        compose_command = json.loads(resolution.stdout)
        diagnostic_next = " ".join([
            *compose_command, "-f", "e2e/docker-compose.yml", "-f",
            "e2e/journey/docker-compose.yml", "logs", "verdaccio",
        ])
        self.publisher_diagnostic_next = diagnostic_next
        env = os.environ.copy()
        env.update(
            {
                "PATH": f"{self.bin}:{env['PATH']}",
                "VERDACCIO_URL": "http://registry.invalid",
                "KB_ERROR_CATALOG_PATH": str(ROOT / "core/platform/src/error-envelope/errors.catalog.json"),
                "PUBLISH_PACKAGES_DIR": str(packages_dir or self.packages),
                "PUBLISH_LOG": str(self.publish_log),
                "PUBLISH_TAG_LOG": str(self.tag_log),
                "PUBLISH_CONFLICT": "1" if conflict else "0",
                "PUBLISH_REJECT_OLD_LATEST": "1" if reject_old_latest else "0",
                "PUBLISH_AUTH_FAIL": "1" if auth_failure else "0",
                "PUBLISHER_DIAGNOSTIC_NEXT": diagnostic_next,
                "PUBLISH_PARALLELISM": "1",
                "REGISTRY_INTEGRITY": registry_integrity,
                "REGISTRY_SHASUM": registry_shasum,
            }
        )
        return subprocess.run(
            ["sh", str(PUBLISHER)],
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )

    # case: S-195.5
    def test_higher_stable_publishes_before_lower_stable_with_valid_tags(self):
        packages_dir = self.root / "versions"
        self.write_tarball(packages_dir / "01-higher.tgz", "2.120.2", "higher")
        self.write_tarball(packages_dir / "02-lower.tgz", "2.120.1", "lower")
        self.write_tarball(packages_dir / "03-canary.tgz", "2.120.3-canary.1", "canary")

        result = self.publish(conflict=False, packages_dir=packages_dir, reject_old_latest=True)

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(
            self.tag_log.read_text().splitlines(),
            [
                "@kb-labs/sample@2.120.2 latest",
                "@kb-labs/sample@2.120.1 journey-2.120.1",
                "@kb-labs/sample@2.120.3-canary.1 canary",
            ],
        )

    # case: S-195.1
    def test_matching_registry_digest_conflict_is_refused(self):
        result = self.publish(self.local_integrity)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("KB_RELEASE_VERSION_CONFLICT", result.stdout)
        self.assertIn("bash e2e/journey/prepare-candidate.sh", result.stdout)

    # case: S-195.1
    def test_matching_registry_shasum_conflict_is_refused(self):
        result = self.publish(registry_shasum=self.local_shasum)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("KB_RELEASE_VERSION_CONFLICT", result.stdout)

    # case: S-195.4
    def test_pr_tarball_supersedes_same_version_base_tarball(self):
        packages_dir = self.root / "two-phase-packages"
        pr_tarball = packages_dir / "pr" / "sample-pr.tgz"
        base_tarball = packages_dir / "base" / "sample-base.tgz"
        self.write_tarball(pr_tarball, "1.2.3", "pr-build")
        self.write_tarball(base_tarball, "1.2.3", "base-build")

        result = self.publish(conflict=False, packages_dir=packages_dir)

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("@kb-labs/sample@1.2.3 (superseded by PR tarball)", result.stdout)
        published_digest = "sha512-" + hashlib.sha512(pr_tarball.read_bytes()).hexdigest()
        self.assertEqual(self.publish_log.read_text().splitlines(), [published_digest])

    # case: S-195.2
    def test_different_registry_digest_fails_with_both_digests_and_recovery_hint(self):
        registry_integrity = "sha512-YmFkLWJ5dGVz"
        result = self.publish(registry_integrity)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("@kb-labs/sample@1.2.3", result.stdout)
        self.assertIn(registry_integrity, result.stdout)
        self.assertIn(self.local_integrity, result.stdout)
        self.assertIn("KB_RELEASE_VERSION_CONFLICT", result.stdout)
        self.assertIn("bash e2e/journey/prepare-candidate.sh", result.stdout)

    # case: S-262.2
    def test_auth_preflight_stops_before_package_publish_with_registry_diagnostic(self):
        result = self.publish(conflict=False, auth_failure=True)

        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("Verdaccio publisher authentication failed for http://registry.invalid; check registry credentials and writable storage.", result.stdout)
        self.assertIn("Next: " + self.publisher_diagnostic_next, result.stdout)
        self.assertFalse(self.publish_log.exists(), "publisher attempted a package PUT before auth preflight")


if __name__ == "__main__":
    unittest.main()
