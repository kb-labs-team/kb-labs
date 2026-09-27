# @kb-labs/sdk

> Core SDK — helpers for command, route, action, webhook definitions and testing.

## Installation

```bash
pnpm add @kb-labs/sdk
```

## Entry Points

| Entry Point | Description |
|-------------|-------------|
| `@kb-labs/sdk` | Main entry — all plugin building APIs |
| `@kb-labs/sdk/command` | Command/route/action/webhook/websocket/message definitions |
| `@kb-labs/sdk/manifest` | Manifest helpers and examples generator |
| `@kb-labs/sdk/hooks` | Platform runtime hooks (`use*`) |
| `@kb-labs/sdk/contracts` | Stable contracts and manifest/runtime contract helpers |
| `@kb-labs/sdk/types` | Type-only entry point for contracts and SDK integration types |
| `@kb-labs/sdk/testing` | Mock builders for unit testing |

## Quick Start

```typescript
import { defineCommand, defineManifest, useLogger, type CommandResult } from '@kb-labs/sdk';

export const hello = defineCommand({
  name: 'hello',
  flags: {
    name: { type: 'string', description: 'Name to greet' },
  },
  async handler(ctx, _argv, flags): Promise<CommandResult> {
    const logger = useLogger();
    logger.info('Running hello command');
    ctx.output?.write(`Hello, ${flags.name ?? 'world'}!`);
    return { ok: true };
  },
});
```

## API Reference

### Command Definitions

```typescript
import {
  defineCommand,   // CLI command
  defineRoute,     // REST route handler
  defineAction,    // Workflow action
  defineWebhook,   // Webhook handler
  defineWebSocket, // WebSocket handler
  defineMessage,   // Message handler
} from '@kb-labs/sdk';
```

### Manifest

```typescript
import { defineManifest, defineCommandFlags } from '@kb-labs/sdk';

export default defineManifest({
  schema: 'kb.plugin/3',
  id: 'my-plugin',
  version: '1.0.0',
  commands: [{ name: 'hello', handler: './hello.js' }],
});
```

### Platform Helpers

```typescript
import {
  usePlatform,           // Global platform singleton
  useLogger,             // Structured logger
  useLoggerWithContext,  // Logger with persistent context
  useLLM,               // LLM adapter
  LLM_CAPABILITIES,     // platform-owned capability catalog for model routing
  isLLMAvailable,
  getLLMTier,
  useEmbeddings,
  useVectorStore,
  useAnalytics,
  trackAnalyticsEvent,
  useStorage,
  useCache,             // Cache adapter (Redis / InMemory)
  isCacheAvailable,
  useConfig,            // Platform config
  isPlatformConfigured,
} from '@kb-labs/sdk';
```

### Flags & Environment

```typescript
import { defineFlags, defineEnv } from '@kb-labs/sdk';

// Type-safe CLI flags
export const myFlags = defineFlags({
  scope: { type: 'string', description: 'Limit to scope' },
  'dry-run': { type: 'boolean', default: false },
});

// Type-safe env variables
export const myEnv = defineEnv({
  MY_API_KEY: { type: 'string', description: 'API key' },
});
```

See [DECLARATIVE-FLAGS-ENV.md](./DECLARATIVE-FLAGS-ENV.md) for full reference.

### UI Utilities

```typescript
import {
  useLoader,
  displayArtifacts,
  displayArtifactsCompact,
  displaySingleArtifact,
  TimingTracker,
} from '@kb-labs/sdk';
```

### Permission Presets

```typescript
import {
  minimalPreset,
  gitWorkflowPreset,
  llmAccessPreset,
  combinePermissions,
} from '@kb-labs/sdk';
```

### Platform Types

```typescript
import type {
  ILLM, ICache, ILogger, IStorage,
  IEmbeddings, IVectorStore, IAnalytics,
  ManifestV3, CommandResult, PluginContextV3,
  HostType, PermissionSpec,
} from '@kb-labs/sdk';
```

### Testing

```typescript
import { createTestContext } from '@kb-labs/sdk';
// or full mock builders:
import { ... } from '@kb-labs/sdk/testing';
```

## API Stability

- Treat all documented entry points as public API.
- Prefer subpath imports for long-term stability:
  - `@kb-labs/sdk/command`
  - `@kb-labs/sdk/manifest`
  - `@kb-labs/sdk/hooks`
  - `@kb-labs/sdk/contracts`
  - `@kb-labs/sdk/types`
  - `@kb-labs/sdk/testing`
- Avoid deep imports from `dist/` or internal files.
- Export contracts are guarded by tests in `src/__tests__/entrypoint-contracts.test.ts`.
- Export glossary is auto-generated in `EXPORTS-GLOSSARY.md` (`pnpm --filter @kb-labs/sdk docs:exports`).
- Export removals require explicit acknowledgement in `BREAKING_CHANGE.md` (CI-enforced on PRs).

## License

MIT
