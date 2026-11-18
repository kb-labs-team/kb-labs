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

The workspace and installed platform use the same exact pnpm 12 release. A
supported pnpm 12 installation can resolve the pinned package manager from the
user's Corepack cache, and unsupported pnpm majors receive a clear diagnostic.

## Steps

| # | Action | Expected |
|---|---|---|
| S-308.1 | Run `pnpm install --frozen-lockfile` with the workspace's pinned pnpm. | Installation succeeds without changing `pnpm-lock.yaml`. |
| S-308.2 | Run installer preflight with Node.js 24 and pnpm 12. | Preflight accepts both tools and uses the workspace-pinned pnpm executable. |
| S-308.3 | Run installer preflight with pnpm 11. | Preflight reports the supported pnpm 12 requirement and its exact remediation. |
| S-308.4 | Build the gateway app and run `pnpm deploy --filter @kb-labs/gateway-app --prod <temporary-directory>`. | The build succeeds and deploy creates an isolated production package containing its runtime dependencies. |

## Pass criteria

The repository pin, workspace package manifests, generated platform toolchain
policy, and clean-machine CI agree on pnpm 12. A deploy using the pinned pnpm
produces the same runnable application contract expected by the deployment
workflow.
