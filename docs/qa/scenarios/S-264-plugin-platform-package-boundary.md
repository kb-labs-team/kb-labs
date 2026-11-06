---
id: S-264
title: Platform and plugin packages stay on their public boundary
persona: solo-developer
area: platform-core
priority: P0
status: planned
release: false
modes: [local, secured]
surfaces: [cli]
---

## User value

A developer can install the platform and add or remove the Commit plugin through
the marketplace without pulling plugin implementation packages into the
platform. This keeps platform upgrades independent from plugin packages and
makes plugin removal complete.

## Preconditions

- An isolated installed platform with the marketplace available.
- The Commit plugin is available from the configured marketplace registry.
- The installed platform root and package manifests are readable by the journey.

## Steps

| # | Action | Expected |
|---|---|---|
| S-264.1 | Install the platform and inspect the installed root package graph before installing any marketplace plugin. | No package under the workspace `plugins/` source tree is present as an installed platform package. The platform can start and the marketplace can list/install plugins without bundling a plugin family. |
| S-264.2 | Install the Commit plugin through the marketplace, then inspect its installed package manifests and files. | Exactly one Commit npm package (`@kb-labs/commit`) is installed from the manifest/release artifact, and the plugin lock records one package entry. Its only `@kb-labs/*` runtime dependency is `@kb-labs/sdk`. |
| S-264.3 | Uninstall the Commit plugin through the marketplace, then inspect the installed root and plugin store. | The single `@kb-labs/commit` package and its code are removed; the platform packages remain installed and usable. |
| S-264.4 | Run the workspace package-boundary check over package manifests and source imports. | No package outside `plugins/**` declares or imports a package under `plugins/**`. No plugin package declares or imports a platform package except through `@kb-labs/sdk`. Each plugin root is one workspace package whose package name equals its manifest ID. The check derives package identities from the live workspace graph and reports manifest-only and import-only edges. |

## Pass criteria

The platform can be installed and used before plugin installation. The Commit
plugin is attached by its marketplace manifest and can be removed without
leaving plugin code behind. Package membership, dependency declarations, and
source imports all obey the platform/plugin boundary.
