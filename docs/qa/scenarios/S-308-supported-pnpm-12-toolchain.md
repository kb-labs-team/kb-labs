---
id: S-308
title: Platform tooling supports the pinned pnpm 12 release
persona: solo-developer
area: platform-core
priority: P1
status: active
release: false
modes: [local, secured]
surfaces: [cli]
---

## Goal

The workspace and installed platform use the same exact pnpm 12 release. The
installer uses the workspace-pinned Corepack package manager independently of
the user's global pnpm, and it detects when the Corepack wrapper has not yet
downloaded pnpm's native executable.

## Steps

| # | Action | Expected |
|---|---|---|
| S-308.1 | Run `pnpm install --frozen-lockfile` with the workspace's pinned pnpm. | Installation succeeds without changing `pnpm-lock.yaml`. |
| S-308.2 | Run installer preflight with Node.js 24 and no global pnpm, or with global pnpm 11. | Node preflight succeeds; package operations use the exact workspace-pinned pnpm 12 through Corepack. |
| S-308.3 | Leave the pinned Corepack wrapper in cache without its native executable and run the installer's public install or restore operation offline. | The operation fails before installer preparation changes the workspace and gives a command using the installer's own `COREPACK_HOME` and exact pnpm pin to warm the native executable online. |
| S-308.4 | Build the gateway app and run `pnpm deploy --filter @kb-labs/gateway-app --prod <temporary-directory>`. | The build succeeds and deploy creates an isolated production package containing its runtime dependencies. |

## Pass criteria

The repository pin, workspace package manifests, generated platform toolchain
policy, and clean-machine CI agree on pnpm 12. The Corepack wrapper and native
executable are both ready before offline package work starts. A deploy using
the pinned pnpm produces the runnable application contract expected by the
deployment workflow.
