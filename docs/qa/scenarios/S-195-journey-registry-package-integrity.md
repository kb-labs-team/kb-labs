---
id: S-195
title: Journey publisher — Detect stale registry tarballs
persona: developer
area: developer-tooling
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## Goal

A journey maintainer can tell whether a persistent local registry already has the exact package bytes required by the current build, so the journey cannot silently install stale packages.

Package `dist` identity is the Go artifacts owner's `kb-dist-digest/v1`: entries are ordered by slash-separated relative path bytes, then encoded with a type tag, length-prefixed path, executable bit, and length-prefixed file bytes or symlink target. This makes path boundaries, file type, executable mode, and content part of the immutable package identity.

## Prerequisites

- [ ] The journey publisher has a packed package tarball and can reach its Verdaccio registry.
- [ ] The Verdaccio storage volume may contain a package version from an earlier run.

## Steps

| # | Action | Expected |
|---|---|---|
| S-195.1 | Run the journey publisher when a package version already exists in Verdaccio with the same tarball digest | The publisher exits non-zero with catalogued `KB_RELEASE_VERSION_CONFLICT`, names the package and version, and tells the release owner to produce a new package version. |
| S-195.2 | Run the journey publisher when a package version already exists in Verdaccio with a different tarball digest | The publisher exits non-zero with catalogued `KB_RELEASE_VERSION_CONFLICT`, names the package and version, reports the registry and local digests, and tells the release owner to produce a new package version. |
| S-195.3 | Start the journey again with third-party packages cached and candidate package metadata from an earlier publish | Before Verdaccio starts, prior `@kb-labs/*` metadata is cleared while third-party cache entries remain; the shared registry serves the current candidate content without a stale-candidate reuse warning. |
| S-195.4 | Run the publisher with `/packages/pr` and `/packages/base` tarballs that have the same package name and version but different bytes | The publisher publishes the PR tarball once, reports `~ <name>@<version> (superseded by PR tarball)` for the base tarball, and exits successfully. |
| S-195.5 | Run the publisher with stable versions 2.120.1 and 2.120.2 and prerelease 2.120.3-canary.1 for one package, with 2.120.2 accepted before 2.120.1 | Publishing succeeds; 2.120.2 receives the `latest` tag, 2.120.1 receives `journey-2.120.1`, and 2.120.3-canary.1 receives `canary`. |
| S-195.6 | Run journey host preparation, including the workspace dependency install and `e2e/journey/prepare-candidate.sh` | Both host installs are directed through the Verdaccio URL returned by Compose; the candidate runtime install receives that URL as its required registry, and preparation output names it. |
| S-195.7 | After warming the persistent Verdaccio volume, repeat `e2e/journey/run.sh --prepare-only` and run the journey with the external uplink unavailable | Host candidate preparation and container package installation succeed from the retained cache with zero third-party tarballs fetched; current candidate artifacts still replace prior candidate metadata. |
