---
name: dev-monorepo
description: Monorepo workspace conventions, dependency management, and build system
autoActivate: true
---

# KB Labs Monorepo Development

## Workspace Layout

This is a **single git repo** with ~140 packages managed by pnpm workspaces.
All internal dependencies use `workspace:*` — resolved locally, replaced with `^version` on publish.

## Adding a New Package

1. Create directory in the appropriate group (`core/`, `plugins/`, `adapters/`, etc.)
2. Add `package.json` with `"name": "@kb-labs/your-package"` and `workspace:*` deps
3. pnpm-workspace.yaml globs auto-include it (e.g. `plugins/*`)
4. Run `pnpm install` to link it

## Adding a New Plugin

1. Create `plugins/your-plugin/` with sub-packages: `core/`, `contracts/`, `cli/`
2. Each sub-package needs: `package.json`, `src/index.ts`, `tsconfig.json`, `tsup.config.ts`
3. CLI package registers commands via SDK
4. If it needs HTTP: add `daemon/` sub-package, declare `"requires": ["gateway"]` in manifest

## Build System

- `kb-devkit run build` — topological build via Go binary
- `kb-devkit run build --affected` — only changed + downstream
- `kb-devkit run test` / `lint` / `type-check` — same pattern
- Build configs defined in `devkit.yaml` (categories → presets → tasks)

## Dependency Layers (enforce strictly)

```
Layer 0: core/* (foundation, no deps on other layers)
Layer 1: sdk/*, shared/*, core/plugin-*
Layer 2: cli/*, adapters/*
Layer 3: plugins/* (consume the SDK; plugin runtime dependencies use its public API)
Layer 4: studio/* (consumes sdk, plugins expose pages)
```

## Running Services

```bash
kb-dev start --config .kb/devservices.yaml --net-offset 0        # all services
kb-dev start rest --config .kb/devservices.yaml --net-offset 0   # specific service
kb-dev status          # health check
kb-dev logs workflow   # service logs
```

`start`/`restart`/`ensure` require `--config` and `--net-offset` — enforced by a `PreToolUse` hook in `.claude/settings.json`.

## Publishing

```bash
npx changeset          # declare what changed
npx changeset version  # bump versions + changelogs
npx changeset publish  # publish to npm (workspace:* → ^version automatically)
```
