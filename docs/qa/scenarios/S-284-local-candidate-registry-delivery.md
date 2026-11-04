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
- [ ] The operator's Verdaccio is reachable at the configured registry URL;
  package credentials are provided through protected npm configuration or the
  process environment.
- [ ] The disposable install uses a clean `HOME` and an isolated platform root.

## Steps

| # | Action | Expected |
|---|---|---|
| S-284.1 | Run `kb release artifact publish --flow "$FLOW" --bundle-dir "$BUNDLE" --expected-digest "$EXPECTED_DIGEST" --candidate-id "$CANDIDATE_ID" --commit "$COMMIT" --version "$VERSION" --registry "$REGISTRY" --json` with the downloaded candidate bundle and expected values from its hosted build run | The command verifies the trusted digest, candidate identity, exact bundle file set, and npm tarball filename grammar before publishing the existing tarballs. It reports the configured registry and every delivered package, then verifies each published package against that registry. Registry credentials and their values do not appear in output. A bundle with a metacharacter tarball filename is refused without running a command. |
| S-284.2 | Repeat S-284.1 with the same candidate and registry | The command exits non-zero with catalogued `KB_RELEASE_VERSION_CONFLICT`, identifies the existing package/version, and leaves the registry's bytes unchanged. It does not treat an existing version as success or overwrite it. |
| S-284.3 | With a clean `HOME`, run `kb-create plan --index "$BUNDLE/release-index.json" --platform-version "$VERSION" --service-profile default --registry "$REGISTRY" --platform-root "$PLATFORM_ROOT" --gateway-url http://127.0.0.1:4800 --json`, verify every planned port, then run `kb-create install --index "$BUNDLE/release-index.json" --platform-version "$VERSION" --service-profile default --registry "$REGISTRY" --platform-root "$PLATFORM_ROOT" --gateway-url http://127.0.0.1:4800 --json` | The plan resolves artifacts from the configured registry without writing installation state. Install succeeds inside the selected root, and `kb --version` reports the platform version sealed in the index. |
| S-284.4 | Deliver a second candidate with a higher platform version; run `kb-create update --index "$BUNDLE_2/release-index.json" --platform-version "$VERSION_2" --service-profile default --registry "$REGISTRY" --platform-root "$PLATFORM_ROOT" --gateway-url http://127.0.0.1:4800 --json`, restart and verify it, then run `kb-create rollback --platform-root "$PLATFORM_ROOT" --snapshot "$SNAPSHOT" --yes --registry "$REGISTRY" --json` | Update installs the newer sealed artifacts from the configured registry. Rollback restores the prior platform version from the install-root snapshot and `kb --version` reports that restored version. |

## Pass criteria

The candidate bundle is checked against provenance before any publish; the
registry receives exactly the sealed tarballs, and published versions cannot
be replaced. Fresh installation and recovery resolve exact artifacts from the
same configured registry without exposing credentials or writing outside the
selected install root. The bundle's colocated indexes are integrity detail;
the expected digest and identity come from outside the bundle.
