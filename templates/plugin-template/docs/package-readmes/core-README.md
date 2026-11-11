# @kb-labs/plugin-template-cli

Reference plugin package for KB Labs Plugin Template, with public surfaces under one package root.

## Vision & Purpose

**@kb-labs/plugin-template-cli** is the canonical example plugin package used by `@kb-labs/plugin-template`.  
It shows how to implement a plugin that exposes:

- a **CLI command** (Hello),
- a **REST handler**, and
- a **Studio widget**,

all driven by a single manifest and contracts package.

## Package Status

- **Version**: 0.1.0  
- **Stage**: Stable (template)  
- **Status**: Reference Implementation ✅

## Architecture

### High-Level Overview

```
plugin-cli
    │
    ├──► contracts     (internal src/contracts)
    ├──► shared        (constants/helpers)
    ├──► domain        (Greeting entity and invariants)
    ├──► application   (use-cases: create greeting, etc.)
    ├──► cli           (Hello command wiring)
    ├──► rest          (Hello REST handler + schema)
    └──► studio        (Hello Studio widget)
```

### Key Components

- `src/domain/`: `Greeting` entity and domain rules
- `src/application/`: use-cases that orchestrate domain logic
- `src/cli/commands/hello/*`: CLI command implementation
- `src/rest/handlers/hello-handler.ts`: REST handler bound to manifest
- `src/studio/widgets/hello-widget.tsx`: Studio widget implementation
- `src/manifest.v2.ts`: Plugin manifest v2 (CLI/REST/Studio wiring)

## Features

- **Single-source manifest** for CLI/REST/Studio surfaces
- **Layered architecture** (shared → domain → application → interface)
- **Type-safe contracts** via `@kb-labs/plugin-template/contracts`
- **Hello-world flow** demonstrating end-to-end plugin wiring

## Exports

From `src/index.ts`:

- `manifest`: Plugin Manifest V2
- All public surfaces:
  - CLI command exports
  - domain/application/shared re-exports

## Dependencies

### Runtime

- `@kb-labs/sdk`: the plugin platform API
- `zod`: schema validation

### Development

- `@kb-labs/devkit`: shared TS/ESLint/Vitest/TSUP presets
- `typescript`, `tsup`, `vitest`, `rimraf`

## Scripts

From `kb-labs-plugin-template` repo root:

```bash
pnpm install
pnpm --filter @kb-labs/plugin-template-cli build
pnpm --filter @kb-labs/plugin-template-cli test
```

To run sandboxes, see the root `README.md` (`pnpm sandbox:cli`, `sandbox:rest`, `sandbox:studio`).

## Command Implementation

This template demonstrates **three different approaches** to implementing CLI commands:

1. **High-level wrapper (`defineCommand`)** - Recommended for most cases
2. **Low-level atomic tools** - For maximum control
3. **Hybrid approach** - Combining both

See [`COMMAND_IMPLEMENTATION_GUIDE.md`](./COMMAND_IMPLEMENTATION_GUIDE.md) for detailed explanations and examples.

### Quick Start

The `template:hello` command in `src/cli/commands/hello/run.ts` shows all three approaches with working code examples. The default implementation uses Approach 1 (`defineCommand`), which provides:

- ✅ Zero-boilerplate flag validation
- ✅ Automatic analytics integration
- ✅ Structured logging
- ✅ Error handling
- ✅ Timing tracking
- ✅ JSON output mode

## Customising for Your Plugin

When using this as a starting point:

- Set the root package name and manifest ID to the plugin ID
- Update manifest IDs and keep contracts in the root package
- Replace the Hello flow with your own domain, use-cases, and surfaces
- Choose the command implementation approach that fits your needs (see `COMMAND_IMPLEMENTATION_GUIDE.md`)


