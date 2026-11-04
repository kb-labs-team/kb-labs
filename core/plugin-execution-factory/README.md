# @kb-labs/plugin-execution-factory

Execution backend implementations and types. Backend construction is owned by `@kb-labs/core-runtime` through the `./construct` subpath.

## Purpose

This package was extracted from `@kb-labs/plugin-execution` to break a circular dependency chain:

**Before (circular):**
```
core-runtime → plugin-execution → plugin-runtime → core-runtime ❌
```

**After (no cycles):**
```
plugin-runtime → plugin-execution-factory → core-runtime ✅
```

## What's Inside

### Execution Backends

- **InProcessBackend** - Executes plugins in the same process (fast, no isolation)
- **SubprocessBackend** - Executes plugins in subprocess via IPC (isolated, secure)
- **WorkerPoolBackend** - Pool of worker processes for parallel execution

In-process execution trusts plugin code with the host process and its open descriptors; isolated modes provide the process boundary.

### Backend construction

Only `@kb-labs/core-runtime` constructs the execution backend. Service planes receive the initialized instance from `platform.executionBackend`; they do not import a constructor.

### Workspace Management

- **LocalWorkspaceManager** - Manages isolated workspace directories for plugins
- **WorkspaceLease** - RAII pattern for automatic workspace cleanup

## Architecture

### Worker Pool Refactoring

The original `pool.ts` (580 lines) was refactored into focused modules:

- `pool.ts` (256 lines) - Main orchestrator
- `pool-stats.ts` (106 lines) - Statistics tracking
- `pool-lifecycle.ts` (202 lines) - Worker lifecycle management
- `pool-queue.ts` (194 lines) - Request queue management
- `pool-executor.ts` (120 lines) - Execution logic

**Benefits:**
- 56% reduction in main file size
- Clear separation of concerns
- Easier to test and maintain

## Dependencies

**Core:**
- `@kb-labs/plugin-runtime` - Plugin context and execution
- `@kb-labs/plugin-contracts` - Type definitions
- `@kb-labs/core-platform` - Platform adapters
- `@kb-labs/core-ipc` - IPC transport layer

**Note:** Does NOT depend on `@kb-labs/core-runtime` to avoid circular dependencies.

## Usage in Core Runtime

Core Runtime imports the dedicated construction subpath:

```typescript
// core-runtime/src/loader.ts
import { createExecutionBackend } from '@kb-labs/plugin-execution-factory/construct';

const backend = await createExecutionBackend(config);
platform.initExecutionBackend(backend);
```

## Public surface

The package root exposes backend types and implementation support. The dedicated `./construct` subpath exposes construction to core runtime; package dependency checks prevent other workspace packages from importing it.

## Build

```bash
pnpm build  # Builds ESM, CJS, and TypeScript definitions
```

## Tests

Tests are located in `@kb-labs/plugin-execution` (175 tests).

## License

MIT
