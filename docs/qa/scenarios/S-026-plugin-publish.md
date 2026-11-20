---
id: S-026
title: Marketplace registry — Publish a plugin package
persona: plugin-author
area: marketplace
priority: P1
status: active
release: false
modes: [local, secured]
surfaces: [cli]
---

## Goal

A plugin author publishes a built plugin package to a configured KB Labs registry and verifies that the published version can be installed.

## Prerequisites

- [ ] A valid plugin package with `package.json` fields `name`, `version`, and `kb.manifest`.
- [ ] The author is authenticated to a disposable test registry.

## Steps

| # | Action | Expected |
|---|---|---|
| S-026.1 | From the plugin root, run `kb hub publish` | The registry response identifies the package name, version, visibility, and install command. |
| S-026.2 | Inspect the test registry entry | Registry metadata identifies the same package name and version as `package.json`. |
| S-026.3 | In a disposable project, run `kb marketplace install <package-name>@<version>` | The exact published version is installed and recorded in the project lock. |
| S-026.4 | From a directory without a KB Labs plugin `package.json`, run `kb hub publish` | CLI reports that it cannot read the package manifest and instructs the author to run from the plugin root. |
| S-026.5 | Change the tarball contents without changing the package version, then run `kb hub publish` again | The registry returns HTTP 409 with `VERSION_ALREADY_EXISTS` and says that published versions are immutable and require a version bump. The original version integrity and tarball remain unchanged. |
| S-026.6 | Set `KB_REGISTRY_URL` to a secured test Gateway B while the CLI has a saved session only for Gateway A, then run `kb hub publish`; repeat with no saved session for B | The request never sends Gateway A credentials to B and does not publish a version. The CLI reports `KB_AUTH_REQUIRED` with B's URL. After signing in to B, Hub publish uses that Gateway's author identity and the Registry records that identity as the package owner. |

Publishing to the registry is plugin-author and registry-maintainer tooling, not a platform-core release requirement.
