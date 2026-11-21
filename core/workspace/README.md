# @kb-labs/core-workspace

> **Core workspace utilities for KB Labs, including platform/project root resolution.** Provides utilities for locating the KB Labs platform installation and the user's project directory for internal tooling consumption (CLI, services, dev tools).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18.18.0+-green.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9.0.0+-orange.svg)](https://pnpm.io/)

## 🎯 Vision & Purpose

**@kb-labs/core-workspace** provides root-directory resolution utilities shared by CLI, services, and `kb-dev`.

KB Labs distinguishes **two** logical roots, which may coincide (dev mode) or differ (installed mode):

| Root            | What it is                                                                                       | Where it lives                                      |
| --------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| **platformRoot** | Directory that contains the installed KB Labs platform code (parent of `node_modules/@kb-labs/*`) | `/opt/kb-labs` (installed), workspace root (dev)    |
| **projectRoot**  | Registered directory containing the user's current working directory                              | `~/work/my-app` (installed), workspace root (dev)   |

**Why two roots?** Plugin discovery needs to scan the platform's `node_modules`, while project-specific data is keyed by the registered project in platform state. This package keeps the platform location separate from the project directory selected by the registry.

## 🏗️ Architecture

### Core Functions

#### `resolveRoots(options)` — main entry point

Resolves both `platformRoot` and `projectRoot` in a single call. This is what the CLI bootstrap, service bootstrap, and `kb-dev` should use.

```typescript
const { platformRoot, projectRoot, sameLocation, sources } = await resolveRoots({
  moduleUrl: import.meta.url, // from the caller's binary/entry
  startDir: process.cwd(),
})
```

- `sameLocation: true` ⇒ dev mode (both roots are the same directory).
- `sources.platform` / `sources.project` describe how each root was discovered. Project source is always `'registry'`.

#### `resolvePlatformRoot(options)`

Finds the directory that contains the installed KB Labs platform (parent of `node_modules/@kb-labs/*`).

Priority chain:

1. Explicit `cwd` option.
2. `KB_PLATFORM_ROOT` propagated by a parent that already resolved its platform.
3. The launcher module URL: the checkout launcher declaration identifies dev binaries; an installed module resolves its owning platform.

The caller's working directory and project configuration do not select the platform. If no launcher supplies a root and its module cannot be resolved, resolution fails.

#### `resolveProjectRoot(options)`

Finds the deepest registered project containing the current working directory.
The resolver reads `<KB_HOME>/projects.json` (`~/.kb/projects.json` by
default). A Git worktree with a standard main checkout `<main>/.git` common
directory maps its current path back into the main checkout, then resolves the
deepest registered project containing that mapped path. This also supports a
project registered at a subdirectory of the main checkout; paths elsewhere in
the worktree do not resolve to that subdirectory. Bare repositories and
worktrees with nonstandard common-directory layouts do not resolve through
this mapping. A Git boundary, repository `.kb` directory, package marker, or
project-root environment override alone does not establish membership. An
unregistered repository or worktree throws `KB_PROJECT_UNKNOWN`; register its
project directory with `kb project add <path>`. Resolution results include
both the registered project root and the directory used for lookup, which may
be the worktree path.

Platform-scoped processes can resolve the platform root without requiring a
registered project. When the current directory belongs to a registered
project, `projectRoot` still identifies that project; otherwise it is absent.
Platform configuration and adapters continue to use `platformRoot`:

```typescript
const roots = await resolveRoots({ moduleUrl: import.meta.url, startDir: process.cwd(), projectScope: 'platform' })
```

This mode does not require project registration. It looks up project identity
when available, but never substitutes `platformRoot` for `projectRoot`.

#### `resolveWorkspaceRoot(options)` — deprecated alias

Resolves through the same project registry as `resolveProjectRoot`.

## 🚀 Quick Start

### Installation

```bash
pnpm add @kb-labs/core-workspace
```

### Basic Usage

```typescript
import { resolveRoots } from '@kb-labs/core-workspace'

// In a CLI entrypoint (bin.ts):
const { platformRoot, projectRoot, sameLocation } = await resolveRoots({
  moduleUrl: import.meta.url,
  startDir: process.cwd(),
})

console.log({ platformRoot, projectRoot, sameLocation })
```

### In dev mode (monorepo workspace)

```text
platformRoot === projectRoot === <registered-workspace-root>
sameLocation:   true
sources:        { platform: 'module', project: 'registry' }
```

### In installed mode

```text
platformRoot:  /opt/kb-labs                    (from KB_PLATFORM_ROOT or moduleUrl walk-up)
projectRoot:   /home/user/work/my-project      (from the platform project registry)
sameLocation:  false
```

## ✨ Features

- **Two-root resolution**: clearly distinguishes platform code location from project state location.
- **Multiple discovery signals**: explicit options, env vars, `import.meta.url` walk-up, marker walk-up, repo root.
- **Dev/installed parity**: same API works in workspace dev mode and in deployed/installed mode; callers don't need to branch.
- **Nested-workspace aware**: handles the KB Labs "workspace of workspaces" layout where sub-repos each have their own `pnpm-workspace.yaml`.
- **Registry ownership**: project identity does not depend on files in the consumer repository.

## 🔧 Configuration

### Environment Variables

| Variable                  | Purpose                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `KB_PLATFORM_ROOT`        | Override platform root (installer wrapper, CI).                                |

## 🤝 Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for development guidelines.

## 📄 License

KB Public License v1.1 © KB Labs
