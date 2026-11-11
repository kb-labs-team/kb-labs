# Contracts Examples

This document shows how to use typed contracts for command IDs, artifact IDs, and other plugin identifiers.

## Overview

Contracts provide **type-safe identifiers** across your plugin, preventing typos and enabling refactoring.

**Benefits:**
- ✅ Type safety - typos caught at compile time
- ✅ Autocomplete - IDE suggestions for valid IDs
- ✅ Refactoring - rename in one place, update everywhere
- ✅ Documentation - contracts serve as registry of all IDs

## Setup

### 1. Install contracts package

```json
// package.json
{
  "dependencies": {
    "@kb-labs/plugin-template-contracts": "workspace:*"
  }
}
```

### 2. Define contracts

```typescript
// packages/contracts/src/index.ts

/**
 * Command IDs for CLI commands
 */
export const CommandIds = {
  HELLO: 'template:hello',
  CREATE_PROJECT: 'template:create-project',
  LIST_ITEMS: 'template:list',
  DELETE_ITEM: 'template:delete'
} as const;

export type CommandId = typeof CommandIds[keyof typeof CommandIds];

/**
 * REST route IDs
 */
export const RouteIds = {
  HELLO: '/hello',
  LIST_USERS: '/users',
  GET_USER: '/users/:id',
  CREATE_USER: '/users',
  UPDATE_USER: '/users/:id',
  DELETE_USER: '/users/:id'
} as const;

export type RouteId = typeof RouteIds[keyof typeof RouteIds];

/**
 * Studio widget IDs
 */
export const WidgetIds = {
  HELLO: 'template.hello-widget',
  METRICS: 'template.metrics-widget',
  USER_LIST: 'template.user-list-widget'
} as const;

export type WidgetId = typeof WidgetIds[keyof typeof WidgetIds];

/**
 * Artifact IDs (for workflows)
 */
export const ArtifactIds = {
  USER_DATA: 'template:user-data',
  REPORT: 'template:report',
  CONFIG: 'template:config'
} as const;

export type ArtifactId = typeof ArtifactIds[keyof typeof ArtifactIds];

/**
 * Event IDs
 */
export const EventIds = {
  USER_CREATED: 'template:user-created',
  USER_UPDATED: 'template:user-updated',
  USER_DELETED: 'template:user-deleted',
  PLUGIN_INITIALIZED: 'template:initialized'
} as const;

export type EventId = typeof EventIds[keyof typeof EventIds];
```

## Using contracts in CLI commands

### Command definition with contracts

```typescript
// src/cli/commands/list-users.ts
import { defineCommand } from '@kb-labs/cli-command-kit';
import { CommandIds } from '@kb-labs/plugin-template-contracts';

export const run = defineCommand({
  name: CommandIds.LIST_USERS, // Type-safe!
  flags: {
    limit: { type: 'number', default: 10 }
  },
  async handler(ctx, argv, flags) {
    ctx.logger?.info('Listing users', { limit: flags.limit });

    const users = await listUsers(flags.limit);

    ctx.output?.write(`Found ${users.length} users\n`);

    return { ok: true, users };
  }
});
```

### Manifest registration with contracts

```typescript
// src/manifest.v2.ts
import { CommandIds, RouteIds, WidgetIds } from '@kb-labs/plugin-template-contracts';

export default {
  id: 'template',
  version: '0.1.0',

  cli: {
    commands: [
      {
        id: CommandIds.HELLO,  // Type-safe!
        handler: './cli/commands/run.js#run',
        describe: 'Greet someone'
      },
      {
        id: CommandIds.CREATE_PROJECT,
        handler: './cli/commands/create-project.js#run',
        describe: 'Create a new project'
      }
    ]
  },

  rest: {
    routes: [
      {
        id: RouteIds.HELLO,  // Type-safe!
        method: 'POST',
        path: '/v1/plugins/template/hello',
        handler: './rest/handlers/hello-handler.js#handleHello'
      },
      {
        id: RouteIds.LIST_USERS,
        method: 'GET',
        path: '/v1/plugins/template/users',
        handler: './rest/handlers/user-handler.js#handleListUsers'
      }
    ]
  },

  studio: {
    widgets: [
      {
        id: WidgetIds.HELLO,  // Type-safe!
        kind: 'card',
        title: 'Hello Widget',
        data: {
          source: {
            type: 'rest',
            routeId: RouteIds.HELLO,  // Type-safe reference!
            method: 'POST'
          },
          schema: {
            zod: './rest/schemas/hello-schema.js#HelloResponseSchema'
          }
        }
      }
    ]
  }
};
```

## Using contracts in REST handlers

### REST handler with contracts

```typescript
// src/rest/handlers/user-handler.ts
import { RouteIds, EventIds } from '@kb-labs/plugin-template-contracts';

export const handleCreateUser = defineHandler({
  async execute(ctx, input) {
    ctx.output?.info('Creating user', {
      route: RouteIds.CREATE_USER
    });

    const user = await createUser(input);

    // Emit event with contract
    await ctx.runtime?.events?.emit(EventIds.USER_CREATED, {
      userId: user.id,
      timestamp: new Date().toISOString()
    });

    return {
      userId: user.id,
      createdAt: user.createdAt.toISOString()
    };
  }
});
```

## Using contracts in workflows

### Workflow with artifact contracts

```typescript
// src/workflows/generate-report.ts
import { ArtifactIds } from '@kb-labs/plugin-template-contracts';

export async function generateUserReport(ctx: WorkflowContext) {
  // Read artifact with contract
  const userData = await ctx.runtime.artifacts.read<UserData>(
    ArtifactIds.USER_DATA
  );

  if (!userData) {
    throw new NotFoundError('Artifact', ArtifactIds.USER_DATA);
  }

  // Generate report
  const report = await buildReport(userData);

  // Write artifact with contract
  await ctx.runtime.artifacts.write(
    ArtifactIds.REPORT,
    report,
    { contentType: 'application/pdf' }
  );

  ctx.logger?.info('Report generated', {
    artifactId: ArtifactIds.REPORT
  });

  return { reportId: ArtifactIds.REPORT };
}
```

## Advanced patterns

### Hierarchical contracts

```typescript
// packages/contracts/src/commands.ts
export const CommandIds = {
  // User commands
  USER: {
    LIST: 'template:user:list',
    CREATE: 'template:user:create',
    UPDATE: 'template:user:update',
    DELETE: 'template:user:delete'
  },

  // Project commands
  PROJECT: {
    INIT: 'template:project:init',
    BUILD: 'template:project:build',
    DEPLOY: 'template:project:deploy'
  },

  // Config commands
  CONFIG: {
    GET: 'template:config:get',
    SET: 'template:config:set',
    RESET: 'template:config:reset'
  }
} as const;

// Extract all command IDs as flat union type
type ExtractIds<T> = T extends string
  ? T
  : T extends object
  ? ExtractIds<T[keyof T]>
  : never;

export type CommandId = ExtractIds<typeof CommandIds>;

// Usage
const cmd: CommandId = CommandIds.USER.LIST; // ✅ Type-safe!
```

### Contract with metadata

```typescript
// packages/contracts/src/routes.ts
export const Routes = {
  HELLO: {
    id: '/hello',
    path: '/v1/plugins/template/hello',
    method: 'POST' as const,
    description: 'Greet someone'
  },
  LIST_USERS: {
    id: '/users',
    path: '/v1/plugins/template/users',
    method: 'GET' as const,
    description: 'List all users'
  },
  GET_USER: {
    id: '/users/:id',
    path: '/v1/plugins/template/users/:id',
    method: 'GET' as const,
    description: 'Get user by ID'
  }
} as const;

export type RouteId = typeof Routes[keyof typeof Routes]['id'];
export type RouteMeta = typeof Routes[keyof typeof Routes];

// Usage in manifest
{
  id: Routes.HELLO.id,
  path: Routes.HELLO.path,
  method: Routes.HELLO.method,
  describe: Routes.HELLO.description
}
```

### Validation helpers

```typescript
// packages/contracts/src/validation.ts
export function isValidCommandId(id: string): id is CommandId {
  const allIds = Object.values(CommandIds).flat();
  return allIds.includes(id as CommandId);
}

export function assertCommandId(id: string): asserts id is CommandId {
  if (!isValidCommandId(id)) {
    throw new ValidationError(
      `Invalid command ID: ${id}`,
      'commandId',
      'INVALID_COMMAND_ID'
    );
  }
}

// Usage
function runCommand(id: string) {
  assertCommandId(id); // Throws if invalid
  // TypeScript now knows id is CommandId
  executeCommand(id);
}
```

## Testing with contracts

### Type-safe testing

```typescript
import { describe, it, expect } from 'vitest';
import { CommandIds, RouteIds } from '@kb-labs/plugin-template-contracts';

describe('Manifest contracts', () => {
  it('should have all CLI commands registered', () => {
    const manifest = loadManifest();

    const registeredIds = manifest.cli.commands.map(c => c.id);

    // Type-safe check
    expect(registeredIds).toContain(CommandIds.HELLO);
    expect(registeredIds).toContain(CommandIds.CREATE_PROJECT);
    expect(registeredIds).toContain(CommandIds.LIST_ITEMS);
  });

  it('should have all REST routes registered', () => {
    const manifest = loadManifest();

    const registeredIds = manifest.rest.routes.map(r => r.id);

    expect(registeredIds).toContain(RouteIds.HELLO);
    expect(registeredIds).toContain(RouteIds.LIST_USERS);
  });
});
```

### Contract validation tests

```typescript
describe('Contract validation', () => {
  it('should validate command IDs', () => {
    expect(isValidCommandId('template:hello')).toBe(true);
    expect(isValidCommandId('invalid:id')).toBe(false);
  });

  it('should throw on invalid command ID', () => {
    expect(() => {
      assertCommandId('invalid:id');
    }).toThrow(ValidationError);
  });
});
```

## Migration from strings to contracts

### Before (unsafe)

```typescript
// ❌ BAD: String literals everywhere, prone to typos
export const run = defineCommand({
  name: 'template:hello',  // Could typo as 'templte:hello'
  //...
});

// In manifest
{
  id: 'template:hello',  // Different typo here = runtime error!
  handler: './cli/commands/run.js#run'
}

// In tests
expect(commandId).toBe('template:helo'); // Typo not caught!
```

### After (safe)

```typescript
// ✅ GOOD: Contracts everywhere, compile-time safety
import { CommandIds } from '@kb-labs/plugin-template-contracts';

export const run = defineCommand({
  name: CommandIds.HELLO,  // Autocomplete + type safety!
  //...
});

// In manifest
{
  id: CommandIds.HELLO,  // Same constant, impossible to typo!
  handler: './cli/commands/run.js#run'
}

// In tests
expect(commandId).toBe(CommandIds.HELLO); // Type error if wrong!
```

## Best practices

### ✅ DO

- **Define all IDs in contracts package** - single source of truth
- **Use `as const`** - enables literal type inference
- **Export types** - `CommandId`, `RouteId`, etc.
- **Group related IDs** - hierarchical structure for large plugins
- **Add validation helpers** - `isValidX()`, `assertX()`
- **Test contract coverage** - ensure all IDs are registered
- **Document contracts** - JSDoc comments for each ID

### ❌ DON'T

- Don't use string literals outside contracts
- Don't duplicate IDs across contracts and code
- Don't forget to export types from contracts
- Don't create circular dependencies (contracts should be standalone)
- Don't change contract values without migration plan

## Contract versioning

### Backward compatible changes

```typescript
// v1
export const CommandIds = {
  HELLO: 'template:hello'
} as const;

// v2 - ADD new command (backward compatible ✅)
export const CommandIds = {
  HELLO: 'template:hello',
  GOODBYE: 'template:goodbye'  // New!
} as const;
```

### Breaking changes

```typescript
// v1
export const CommandIds = {
  HELLO: 'template:hello'
} as const;

// v2 - RENAME command (breaking change ❌)
export const CommandIds = {
  GREET: 'template:greet'  // Breaks existing code!
} as const;

// Better: Deprecate old, add new
export const CommandIds = {
  /** @deprecated Use GREET instead */
  HELLO: 'template:hello',
  GREET: 'template:greet'
} as const;
```

## Related documentation

- [Manifest Guide](../../docs/manifest-guide.md) - Manifest structure
- [CLI Guide](../../docs/cli-guide.md) - CLI commands
- [REST Guide](../../docs/rest-guide.md) - REST handlers
- [TypeScript Documentation](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#literal-types) - Literal types
