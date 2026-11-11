# @kb-labs/plugin-runtime-v3

V3 Plugin System Runtime - Context factory, sandboxed execution, and runtime APIs.

## Features

- **Context Factory**: Creates `PluginContextV3` with all services wired
- **Sandbox Execution**: In-process and subprocess execution modes
- **Runtime Shims**: Sandboxed fs, fetch, env with permission checks
- **API Stability**: Integration tests prevent accidental API drift

## Installation

```bash
pnpm add @kb-labs/plugin-runtime-v3
```

## Usage

### In-Process Execution (Dev Mode)

```typescript
import { runInProcess } from '@kb-labs/plugin-runtime-v3/sandbox';
import type { PluginContextDescriptor } from '@kb-labs/plugin-contracts-v3';

const descriptor: PluginContextDescriptor = {
  host: 'cli',
  pluginId: '@kb-labs/my-plugin',
  pluginVersion: '1.0.0',
  cwd: process.cwd(),
  permissions: { fs: { read: ['./'] } },
  hostContext: { host: 'cli', argv: [], flags: {} },
  parentRequestId: undefined,
};

const result = await runInProcess({
  descriptor,
  platform: platformServices,
  ui: uiFacade,
  handlerPath: '/path/to/handler.js',
  input: { data: 'test' },
});

console.log(result.exitCode); // 0
console.log(result.meta);     // Auto-injected metadata
```

### Handler Return Values (V3)

Handlers should return a `CommandResult<T>` with optional custom metadata:

```typescript
export default {
  async execute(ctx, input) {
    // Your handler logic
    const data = { message: 'Hello, World!' };

    // Return result with optional custom metadata
    return {
      exitCode: 0,
      result: data,
      meta: {
        customField: 'value',
        timing: [{ checkpoint: 'start', elapsed: 0 }],
      },
    };
  }
};
```

**Automatic Metadata Injection**: The runtime automatically adds standard metadata fields:

- `executedAt` - ISO timestamp when execution started
- `duration` - Execution duration in milliseconds
- `pluginId` - Plugin identifier
- `pluginVersion` - Plugin version
- `commandId` - Command identifier (if available)
- `host` - Execution host ('cli' | 'rest' | 'workflow')
- `tenantId` - Tenant identifier (if available)
- `requestId` - Request tracking ID

These fields are merged with your custom metadata automatically. If your custom metadata has the same key, your value will be overwritten by the standard field.

### Subprocess Execution (Production)

```typescript
import { runInSubprocess } from '@kb-labs/plugin-runtime-v3/sandbox';

const result = await runInSubprocess({
  descriptor,
  platform,
  handlerPath: '/path/to/handler.js',
  input: { data: 'test' },
  cwd: '/path/to/workspace',
  timeoutMs: 30000,
});
```

The host and child exchange execution control, platform adapter calls, and plugin logs over one length-prefixed stdio stream. The host serves platform calls through that stream; subprocess and container execution use the same protocol.

## Context Structure

The `PluginContextV3` provided to handlers contains:

```typescript
{
  // Metadata
  host: 'cli' | 'rest' | 'workflow',
  requestId: string,
  pluginId: string,
  pluginVersion: string,
  cwd: string,

  // Signal
  signal?: AbortSignal,

  // Services
  ui: UIFacade,           // 13 methods
  platform: PlatformServices,  // 7 services
  runtime: RuntimeAPI,    // fs, fetch, env
  api: PluginAPI,         // lifecycle, state, etc.

  // Tracing
  trace: TraceContext,
}
```

### UI Facade (13 methods)

CLI command handlers receive the narrower `PluginCommandContextV3` facade. Its
`ui` type is `PluginHandlerUIFacade`, which omits `json()` and `error()` because
the CLI host returns command data and emits the result once. A JavaScript CLI
handler that calls either method receives the catalogued
`KB_PLUGIN_CONTRACT_VIOLATION` error. The examples below describe the broader
UI facade used by other plugin execution contexts.

```typescript
ctx.ui.info('message');
ctx.ui.success('message');
ctx.ui.warn('message');
ctx.ui.error('message');
ctx.ui.debug('message');
ctx.ui.spinner('loading...');
ctx.ui.table(data);
ctx.ui.json(data);
ctx.ui.newline();
ctx.ui.divider();
ctx.ui.box('content');
await ctx.ui.confirm('Are you sure?');
await ctx.ui.prompt('Enter value:');
```

### Runtime API

```typescript
// Filesystem (17 methods)
await ctx.runtime.fs.readFile('/path');
await ctx.runtime.fs.writeFile('/path', 'content');
await ctx.runtime.fs.exists('/path');
await ctx.runtime.fs.readdir('/path');
await ctx.runtime.fs.mkdir('/path');
await ctx.runtime.fs.rm('/path');
await ctx.runtime.fs.copy('/src', '/dest');
await ctx.runtime.fs.move('/src', '/dest');

// Network
await ctx.runtime.fetch('https://api.example.com');

// Environment
const value = ctx.runtime.env('NODE_ENV');
```

### Plugin API

```typescript
// Lifecycle
ctx.api.lifecycle.onCleanup(async () => {
  // Cleanup logic
});

// State (in-memory cache)
await ctx.api.state.set('key', value, ttlMs);
const cached = await ctx.api.state.get('key');
```

### Platform Services

```typescript
ctx.platform.logger.info('message');
ctx.platform.llm.generate({ prompt: 'Hello' });
ctx.platform.embeddings.embed('text');
ctx.platform.vectorStore.search('query');
ctx.platform.cache.get('key');
ctx.platform.storage.read('key');
ctx.platform.analytics.track('event');
```

## Testing

### Run Tests

```bash
# All tests
pnpm test

# Watch mode
pnpm test:watch
```

### Context Structure Tests

Integration tests verify the **actual runtime structure** of `PluginContextV3`:

```bash
pnpm test src/__tests__/context-structure.test.ts
```

These tests:
- ✅ Prevent accidental API removals
- ✅ Ensure type definitions match runtime
- ✅ Document the exact API surface
- ✅ Protect against regressions

See [src/__tests__/README.md](./src/__tests__/README.md) for details.

## Exports

```typescript
// Main export
import { createPluginContextV3 } from '@kb-labs/plugin-runtime-v3';

// Sandbox runners
import { runInProcess, runInSubprocess } from '@kb-labs/plugin-runtime-v3/sandbox';

// Bootstrap (for subprocess execution)
import '@kb-labs/plugin-runtime-v3/sandbox/bootstrap';
```

## Platform Adapter Pipeline

Every platform adapter passes through a named slot pipeline before reaching a plugin. The pipeline has two phases.

### Pipeline stages

```
raw → router → post-router → resource-broker → post-resource-broker → governance
```

| Slot | Reserved | Purpose |
|------|----------|---------|
| `raw` | no | Hook before any system processing |
| `router` | yes | System: LLMRouter, NotifierRouter |
| `post-router` | no | After routing, before rate limiting |
| `resource-broker` | yes | System: QueuedLLM, rate limiting |
| `post-resource-broker` | no | Circuit breaker, cost tracking |
| `governance` | yes | System: permission enforcement — always last |

Reserved slots are system-only. Adapter middlewares declared in `AdapterManifest.middlewares` land in open slots.

### Phase 1 — `assemblePlatform()` (once at startup)

Applies system-level transforms: router factories (e.g. `LLMRouter`) and resource broker wrappers (e.g. `QueuedLLM`).

```typescript
import { assemblePlatform } from '@kb-labs/plugin-runtime/platform';

const platform = assemblePlatform(rawPlatform, routerConfig, resourceBroker);
```

### Phase 2 — `applyPluginGovernance()` (per plugin)

Applies adapter-declared middlewares in slot order, then system governance (permission enforcement).

```typescript
import { applyPluginGovernance } from '@kb-labs/plugin-runtime/platform';

const governed = applyPluginGovernance(platform, permissions, pluginId, adapterMiddlewares);
```

### ADAPTER_REGISTRY — single source of truth

Every adapter has exactly one entry. TypeScript enforces exhaustiveness at compile time:

```typescript
// Adding a field to PlatformServices without a registry entry → compile error
export const ADAPTER_REGISTRY = {
  llm: {
    routerFactory: (raw, config) => new LLMRouter(raw, config),
    resourceBrokerFactory: (raw, broker) => createQueuedLLM(broker, raw),
    governance: { strategy: 'wrap', fn: wrapLlm },
    ipc: { strategy: 'proxy', create: (t) => new LLMProxy(t) },
  },
  // ... 15 more entries
} satisfies { [K in keyof Required<PlatformServices>]: AdapterDescriptor<any> };
```

### Writing adapter middleware

```typescript
// In your adapter package: ./middlewares/cost-tracker.ts
import type { AdapterMiddlewareFn } from '@kb-labs/plugin-runtime/platform';

export const middleware: AdapterMiddlewareFn<ILLM> = (adapter, ctx) => ({
  ...adapter,
  complete: async (prompt, options) => {
    const start = Date.now();
    const result = await adapter.complete(prompt, options);
    trackCost(Date.now() - start, ctx.pluginId);
    return result;
  },
});
```

Declare it in your `AdapterManifest`:

```typescript
middlewares: [
  {
    id: 'cost-tracker',
    handler: './middlewares/cost-tracker.js',
    slot: 'post-resource-broker',
    target: 'llm',
    priority: 10,
  }
]
```

### Adding a new adapter

1. Add the field to `PlatformServices` in `@kb-labs/plugin-contracts` → compile error fires
2. Add one entry to `ADAPTER_REGISTRY` with `governance` + `ipc` strategies
3. Add a governance wrap function (or use `pass-through`)

### Adding a new system pipeline stage

1. Add an entry to `PIPELINE_SLOTS` in [`pipeline-slots.ts`](src/platform/pipeline-slots.ts) with `reserved: true`
2. Insert the name at the right position in `SLOT_ORDER`
3. Add the corresponding factory field to `AdapterDescriptor` if needed

Existing adapter middleware priorities are not affected — they are local to their slot.

See [ADR-0001](docs/adr/ADR-0001-adapter-pipeline.md) for the full design rationale.

---

## Architecture

```
┌─────────────────────────────────────────┐
│ CLI / REST / Workflow Host              │
└───────────────┬─────────────────────────┘
                │
                ├─ Dev Mode: runInProcess()
                │    ├─ createPluginContextV3()
                │    ├─ Import handler dynamically
                │    └─ Execute in same process
                │
                └─ Production: runInSubprocess()
                     ├─ spawn(bootstrap.js, stdin/stdout pipes)
                     ├─ IPC communication
                     ├─ Sandboxed execution
                     └─ Return result via IPC
```

### Bootstrap.js

The `bootstrap.js` file is a **standalone** entry point for forked subprocesses:

- **Bundled dependencies**: All `@kb-labs/plugin-contracts-v3` code is inlined
- **No external imports**: Works without node_modules access
- **Multi-location fallback**: Tries production, development, and fallback paths

See [ADR-0016: Standalone Bootstrap](../../docs/adr/0016-standalone-bootstrap-for-subprocess-execution.md) for details.

## Development

```bash
# Build
pnpm build

# Watch mode
pnpm dev

# Type check
pnpm type-check

# Run tests
pnpm test
```

## License

MIT
