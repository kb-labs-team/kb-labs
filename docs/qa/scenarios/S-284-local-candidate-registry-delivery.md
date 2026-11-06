---
id: S-284
title: Deliver and install immutable candidates from a local registry
persona: platform-team
area: platform-core
priority: P0
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## Goal

A platform maintainer can deliver a hosted immutable candidate to the private
local registry, install it into an isolated root, and recover from a later
candidate if the update degrades.

## Prerequisites

- [ ] A hosted candidate bundle contains `npm/`, `release-index.json`, and
  `provenance.json`.
- [ ] The hosted build exposes the bundle digest and candidate identity outside
  the bundle; delivery receives those expected values from the build run.
- [ ] The selected release flow declares named delivery targets, including a test target for Verdaccio and a public target for npm, and declares its channel-to-gate policy.
- [ ] The operator's Verdaccio is reachable at the configured test target;
  package credentials are provided through protected npm configuration or the
  process environment.
- [ ] The disposable install uses a clean `HOME` and an isolated platform root.

## Steps

| # | Action | Expected |
|---|---|---|
| S-284.1 | Run `kb release artifact publish --flow "$FLOW" --bundle-dir "$BUNDLE" --expected-digest "$EXPECTED_DIGEST" --candidate-id "$CANDIDATE_ID" --commit "$COMMIT" --version "$VERSION" --target local --json` with the downloaded candidate bundle and expected values from its hosted build run | The command verifies the trusted digest, candidate identity, exact bundle file set, and npm tarball filename grammar before publishing the existing tarballs. It reports the configured registry and every delivered package, then verifies each published package against that registry. Registry credentials and their values do not appear in output. A bundle with a metacharacter tarball filename is refused without running a command. |
| S-284.2 | Repeat S-284.1 with the same candidate and registry | The command exits non-zero with catalogued `KB_RELEASE_VERSION_CONFLICT`, identifies the existing package/version, and leaves the registry's bytes unchanged. It does not treat an existing version as success or overwrite it. |
| S-284.3 | With a clean `HOME`, run `kb-create plan --index "$BUNDLE/release-index.json" --platform-version "$VERSION" --service-profile default --registry "$REGISTRY" --platform-root "$PLATFORM_ROOT" --gateway-url http://127.0.0.1:4800 --json`, verify every planned port, then run `kb-create install --index "$BUNDLE/release-index.json" --platform-version "$VERSION" --service-profile default --registry "$REGISTRY" --platform-root "$PLATFORM_ROOT" --gateway-url http://127.0.0.1:4800 --json` | The plan resolves artifacts from the configured registry without writing installation state. Install succeeds inside the selected root, and `kb --version` reports the platform version sealed in the index. |
| S-284.4 | Deliver a second candidate with a higher platform version; run `kb-create update --index "$BUNDLE_2/release-index.json" --platform-version "$VERSION_2" --service-profile default --registry "$REGISTRY" --platform-root "$PLATFORM_ROOT" --gateway-url http://127.0.0.1:4800 --json`, restart and verify it, then run `kb-create rollback --platform-root "$PLATFORM_ROOT" --snapshot "$SNAPSHOT" --yes --registry "$REGISTRY" --json` | Update installs the newer sealed artifacts from the configured registry. Rollback restores the prior platform version from the install-root snapshot and `kb --version` reports that restored version. |
| S-284.5 | Build canary and stable candidates, then run `kb release artifact publish` for each using `--target local` and `--target npm` | Candidate provenance states the gate policy and result. The test target accepts a verified canary or ungated candidate. The public target accepts only a stable candidate whose release-case gate passed; it refuses canary, ungated, or missing-gate provenance with the catalogued release policy error. Promotion to stable applies the same rule. The target is required, and an undeclared target is refused with the catalogued target error and a declaration hint. |
| S-284.6 | In a clean workspace checkout with package `dist/` outputs absent, run `kb release build run --flow platform --json` | Workspace packages used by a selected flow are built before their consumers according to every declared workspace dependency section, including `devDependencies`; the release build succeeds without relying on pre-existing dependency outputs. The platform flow excludes journey fixture packages, and release membership remains governed by the selected flow. |
| S-284.7 | Run `kb release build run --flow platform --json` when a package build exceeds the release plugin's declared governed-process memory quota | The command fails with catalogued `KB_RUNTIME_PROCESS_LIMIT_EXCEEDED`. Its message names the resource, observed and allowed values, and the failed process and working directory; its catalogued hint explains the next action. The output identifies which package build exceeded the quota, and does not report a plugin contract violation. |
| S-284.8 | Run a CLI command in `--json` mode that completes work, then its child terminates before returning a result | The command writes one catalogued `KB_CLI_RESULT_UNAVAILABLE` envelope to stdout with the child exit cause and hint, exits non-zero, and emits no human loader text. In human mode, it shows the same catalogued error and hint on stderr. |
| S-284.9 | Run the shared release build preflight with a final build command that exits non-zero without output | The preflight exits with that command's status and prints the exact command and status to stderr, so the failing operation is visible even when the child emits no diagnostic. |
| S-284.10 | Run the candidate Go release build, then invoke `tools/kb-create/install.sh --version v2.0.0-binaries` from a Windows shell | GoReleaser builds only Linux and macOS binaries from its shared target configuration, and the PR preflight builds a snapshot for its supported runner target. The installer exits with catalogued `KB_INSTALL_UNSUPPORTED_PLATFORM` before attempting to download an artifact. |
| S-284.11 | Run the supported GoReleaser snapshot release, then generate the binary manifest from its `dist/artifacts.json` and `dist/checksums.txt` | The manifest lists every produced `kb-create` OS/architecture asset using the artifact name, actual file path, OS, architecture, checksum, and size supplied by GoReleaser; it contains no target missing from the producer output. The shared PR preflight runs this same manifest generation and validation after the snapshot. |
| S-284.12 | Run the candidate build through release-index sealing and bundle assembly using the shared release preflight | Provenance, the release index, and the immutable bundle are produced by the same commands in local preflight and the candidate workflow. The preflight also rejects an uncovered candidate-job step unless the step is explicitly marked as requiring hosted Actions output. |
| S-284.13 | Seal provenance for a staged package whose `package.json` exports only static files and declares no `dist` output | The release index records whether package provenance covers `dist` or the complete static package tree. The installer verifies the same declared scope, and a changed shipped file fails provenance verification. |
| S-284.14 | Prepare the release index and assemble the candidate from the same staged npm directory | Release-index preparation keeps its extracted package inspection tree and normalized index input outside the staged npm artifact set. Candidate bundle verification accepts exactly the manifest and declared tarballs, with no generated inspection files included. |
| S-284.15 | Run a candidate job through the shared release-build action and inspect its post-build outputs | The action builds the selected flow, creates binary assets and their manifest, seals provenance and the release index, and assembles the candidate bundle exactly once. The bundle carries the dispatched candidate ID, commit, version, gate metadata, and run ID. Workflow steps after the shared action upload the bundle and publish its hosted artifact digest; an explicitly requested canary delivery may then publish that same bundle. |
| S-284.16 | Download a hosted candidate bundle, then run `kb release artifact publish --flow platform --bundle-dir "$BUNDLE" --expected-digest "$EXPECTED_DIGEST" --candidate-id "$CANDIDATE_ID" --commit "$COMMIT" --version "$VERSION" --target local --json --dry-run` | The digest in `provenance.json` remains valid after the hosted artifact download. The shared release preflight runs this same delivery verification after sealing; the command exits successfully and reports a dry run without publishing or contacting the target registry, including when the target is unreachable. A consistently sealed bundle containing an unreadable or unpublishable tarball or a tarball whose package identity differs from the bundle is refused. The hosted build also prints the trusted bundle digest in its log and summary. |

| S-284.17 | Run `kb release artifact publish --version --json`, `kb release artifact publish --version "" --json`, and `kb release artifact publish --version` | Each invocation exits non-zero with a catalogued missing input error; none reports the platform version as a successful delivery. A bare `kb --version` continues to report the platform version. |

| S-284.18 | Dispatch a canary candidate with delivery enabled, then run `install.sh --channel canary` with `KB_CREATE_DOWNLOAD_BASE_URL` set to the public binaries host and run `kb-create install` with the public registry | CI publishes the sealed npm tarballs to the declared canary registry, uploads the versioned binary assets and integrity-checked release index, and updates the channel pointer. The bootstrap resolves that pointer from the configured host and installs the exact candidate; the platform installer resolves its packages from the public registry. The host retains the three most recent canary versions. Failures identify the delivery stage without exposing credentials. |

## Pass criteria

The candidate bundle is checked against provenance and target policy before any publish; the
selected target receives exactly the sealed tarballs, and published versions cannot
be replaced. Fresh installation and recovery resolve exact artifacts from the
same configured registry without exposing credentials or writing outside the
selected install root. The bundle's colocated indexes are integrity detail;
the expected digest and identity come from outside the bundle.
