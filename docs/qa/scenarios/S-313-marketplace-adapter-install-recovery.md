---
id: S-313
title: Marketplace adapter install failure preserves a usable platform
persona: solo-developer
area: marketplace
priority: P0
status: planned
release: false
modes: [local, secured]
surfaces: [cli]
---

## Goal

As a platform owner, I can recover from a failed or interrupted platform adapter install without losing the adapters and commands that were already working.

## Prerequisites

- [ ] A disposable KB Labs platform installation with at least one working adapter and a registered project.
- [ ] A local package registry fixture that can fail or pause an adapter installation at a controlled point.
- [ ] The platform installation and its package-manager state are isolated from the developer's normal home and active platform.

## Steps

| # | Action | Expected |
|---|---|---|
| S-313.1 | With a working disposable platform and a local registry fixture, run `kb marketplace install @kb-labs/test-adapter@1.0.0 --scope platform --json`; make the package-manager operation fail after it starts changing the installation | The command exits nonzero with `KB_MARKETPLACE_INSTALL_FAILED` and a recovery hint. The active generation remains the same: the previously installed adapter is pinned and resolvable, the host remains healthy, and `kb-create doctor` reports no missing package-manager metadata or executable projections. After correcting the fixture, retrying the command succeeds without manually rebuilding the installation. |
| S-313.2 | Start the same platform-scope adapter install and terminate the installer process while it is preparing the candidate generation, before the active pointer changes; then retry the install | The active generation remains unchanged after interruption; the previously installed adapter and host commands remain available, with no partial package links or pins. The retry safely discards the incomplete candidate and completes without manual package-manager repair. |
| S-313.3 | With the host running, install the adapter successfully from the local registry fixture | The active pointer selects the complete verified generation. The running host continues to use its previous physical tree root, remains healthy, and `kb-create status --json` reports `pendingRestart` with the installed generation and an explicit `kb-create restart` command. After restart, status reports a healthy host using the active generation and no pending restart. |
