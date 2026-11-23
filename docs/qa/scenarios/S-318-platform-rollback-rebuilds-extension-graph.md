---
id: S-318
title: Platform — rollback rebuilds the Marketplace extension graph
persona: solo-developer
area: platform-core
priority: P1
status: planned
release: true
modes: [local, secured]
surfaces: [cli]
---

## Goal

Restore a stopped platform version from a saved snapshot without leaving its
Marketplace-installed extensions unusable.

## Prerequisites

- A V2 install with a saved snapshot and at least one Marketplace-installed plugin.
- The platform host is stopped.

## Steps

| # | Action | Expected |
|---|---|---|
| S-318.1 | Remove a transitive dependency link while keeping its exact package versions and manifests, run `kb-create rollback --platform-root ROOT --snapshot SNAPSHOT --yes --json`, then invoke an installed Marketplace plugin command that uses that dependency | Rollback rebuilds the package-manager modules tree from the snapshot's exact package specs and lockfile, and the plugin command runs. Extra registered plugins, user package specs, unrelated workspace settings, and shared cache/data are preserved. |
| S-318.2 | Terminate the installer process during a rollback modules rebuild, then retry rollback and invoke the Marketplace plugin command | The retry completes recovery safely. On failure, the previous modules tree is restored. Rollback neither reports success while a transitive dependency link is missing nor requires an interactive pnpm confirmation. |

## Pass criteria

Rollback restores the exact package-manager graph from the snapshot, preserves
unrelated user state, and leaves the installed extension executable. An
interrupted rebuild is recoverable on retry. These steps remain planned until
the installed-platform journey verifies the user-visible commands and outcomes;
Go unit tests alone do not establish this coverage.
