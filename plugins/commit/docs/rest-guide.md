# REST Guide

Use this guide to add or modify REST endpoints in the plugin template.

## Directory layout

```
packages/plugin-template-core/src/rest/
├── handlers/
│   └── hello-handler.ts    # Handler implementation
├── schemas/
│   └── hello-schema.ts     # Zod request/response schemas
└── index.ts                # REST surface export
```

- **schemas/** – Request/response contracts defined with Zod
- **handlers/** – Executable functions invoked by the plugin runtime

## Adding a route

### 1. Define schemas

Create `src/rest/schemas/your-schema.ts`:

```typescript
import { z } from 'zod';

export const YourRequestSchema = z.object({
  input: z.string().min(1, 'Input is required'),
  options: z.object({
    verbose: z.boolean().optional()
  }).optional()
});

export type YourRequest = z.infer<typeof YourRequestSchema>;

export const YourResponseSchema = z.object({
  result: z.string(),
  processedAt: z.string()
});

export type YourResponse = z.infer<typeof YourResponseSchema>;
```

### 2. Implement handler

Create `src/rest/handlers/your-handler.ts`:

```typescript
import { defineHandler } from '@kb-labs/sdk';
import { YourRequestSchema, YourResponseSchema } from '../schemas/your-schema.js';
import type { YourRequest, YourResponse } from '../schemas/your-schema.js';
import { yourBusinessLogic } from '../../core/your-logic.js';

export const handleYourEndpoint = defineHandler<unknown, YourRequest, YourResponse>({
  async execute(ctx, input) {
    // 1. Log request
    ctx.output?.info('Processing request', {
      requestId: ctx.requestId,
      input: input.input
    });

    // 2. Call business logic
    const result = await yourBusinessLogic(input.input);

    // 3. Return validated response
    return {
      result,
      processedAt: new Date().toISOString()
    };
  }
});
```

### 3. Export handler

Add to `src/rest/handlers/index.ts`:

```typescript
export * from './your-handler.js';
```

### 4. Update manifest

Update `src/manifest.v2.ts`:

```typescript
rest: {
  routes: [
    // ... existing routes
    {
      id: '/your-endpoint',
      method: 'POST',
      path: '/v1/plugins/template/your-endpoint',
      handler: './rest/handlers/your-handler.js#handleYourEndpoint',
      describe: 'Your endpoint description',
      schema: {
        input: './rest/schemas/your-schema.js#YourRequestSchema',
        output: './rest/schemas/your-schema.js#YourResponseSchema'
      },
      permissions: {
        fs: {
          mode: 'readOnly',
          allow: ['.kb/template/**']
        }
      }
    }
  ]
}
```

### 5. Write tests

Create `tests/rest/your-handler.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { handleYourEndpoint } from '../../src/rest/handlers/your-handler.js';

describe('handleYourEndpoint', () => {
  it('should process valid request', async () => {
    const input = {
      input: 'test data'
    };

    const ctx = {
      output: { info: vi.fn() },
      requestId: 'req-123'
    };

    const result = await handleYourEndpoint.execute(ctx, input);

    expect(result.result).toBeDefined();
    expect(result.processedAt).toBeDefined();
    expect(ctx.output.info).toHaveBeenCalled();
  });

  it('should validate input schema', async () => {
    const invalidInput = {
      input: '' // Fails min length validation
    };

    const ctx = {};

    await expect(
      handleYourEndpoint.execute(ctx, invalidInput)
    ).rejects.toThrow();
  });
});
```

## Handler context

Handlers receive a rich context object:

```typescript
interface HandlerContext {
  // Logging/output
  output?: {
    debug(msg: string, meta?: Record<string, unknown>): void;
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };

  // Runtime utilities
  runtime?: {
    fs?: FileSystem;
    config?: ConfigManager;
    state?: StateBroker;
  };

  // Request metadata
  requestId?: string;
  tenantId?: string;
}
```

## Validation patterns

### Required fields

```typescript
const Schema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email format')
});
```

### Optional fields with defaults

```typescript
const Schema = z.object({
  name: z.string(),
  verbose: z.boolean().default(false),
  limit: z.number().optional().default(10)
});
```

### Nested objects

```typescript
const Schema = z.object({
  user: z.object({
    name: z.string(),
    email: z.string().email()
  }),
  preferences: z.object({
    theme: z.enum(['light', 'dark']).default('light')
  }).optional()
});
```

### Arrays

```typescript
const Schema = z.object({
  tags: z.array(z.string()).min(1, 'At least one tag required'),
  items: z.array(z.object({
    id: z.string(),
    value: z.number()
  }))
});
```

### Custom validation

```typescript
const Schema = z.object({
  age: z.number().refine(
    (val) => val >= 18,
    { message: 'Must be 18 or older' }
  ),
  password: z.string().refine(
    (val) => /^(?=.*[A-Z])(?=.*[0-9])/.test(val),
    { message: 'Password must contain uppercase and number' }
  )
});
```

## Error handling

### Validation errors

The route validates input with its declared Zod schema before invoking the handler:

```typescript
export const handler = defineHandler({
  async execute(ctx, input) {
    // The route schema validates input before handler execution
    // Invalid input is rejected at the route boundary

    const result = await processInput(input);
    return { result };
  }
});
```

### Business logic errors

```typescript
import { BusinessRuleError, NotFoundError } from '../../utils/errors.js';

export const handler = defineHandler({
  async execute(ctx, input) {
    const item = await findItem(input.id);

    if (!item) {
      throw new NotFoundError('Item', input.id);
    }

    if (item.status !== 'active') {
      throw new BusinessRuleError(
        'Cannot process inactive item',
        'ITEM_NOT_ACTIVE'
      );
    }

    return { result: item };
  }
});
```

### Graceful error handling

```typescript
import { formatErrorForLogging, formatErrorForUser } from '../../utils/errors.js';

export const handler = defineHandler({
  async execute(ctx, input) {
    try {
      const result = await riskyOperation(input);
      return { result };
    } catch (error) {
      // Log full error with stack trace
      ctx.output?.error('Operation failed', formatErrorForLogging(error));

      // Rethrow for runtime to handle
      throw error;
    }
  }
});
```

## Best practices

### ✅ DO

- **Use Zod schemas** for all request/response validation
- **Export TypeScript types** from schemas with `z.infer`
- **Keep handlers thin** - delegate to `core/` business logic
- **Use ctx.output** for logging (not console.log)
- **Validate permissions** - declare minimal fs/net/env access
- **Write tests** - test both success and error cases
- **Return structured data** - consistent response formats

### ❌ DON'T

- Don't skip schema validation
- Don't put business logic in handlers (use `core/`)
- Don't use `console.log` (use `ctx.output`)
- Don't access filesystem without permissions
- Don't expose internal errors to users (format them)
- Don't use `any` types (use Zod inference)

## Permissions checklist

Declare only what your handler needs:

```typescript
{
  permissions: {
    // Filesystem access
    fs: {
      mode: 'readWrite', // or 'readOnly'
      allow: ['.kb/template/**', 'output.json'],
      deny: ['.kb/plugins.json'] // Prevent accidental writes
    },

    // Environment variables
    env: {
      allow: ['KB_TEMPLATE_API_KEY']
    },

    // Resource quotas
    quotas: {
      timeoutMs: 5000,
      memoryMb: 128,
      cpuMs: 1000
    }
  }
}
```

## Example patterns

### Simple GET endpoint

```typescript
// No input validation needed for query params
export const handleList = defineHandler({
  async execute(ctx, input) {
    const items = await listItems();
    return { items };
  }
});
```

### POST endpoint with complex validation

```typescript
const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(100),
  role: z.enum(['admin', 'user']).default('user'),
  metadata: z.record(z.string()).optional()
});

export const handleCreateUser = defineHandler({
  async execute(ctx, input) {
    const user = await createUser(input);
    return {
      userId: user.id,
      createdAt: user.createdAt.toISOString()
    };
  }
});
```

### Endpoint with state caching

```typescript
export const handleSearch = defineHandler({
  async execute(ctx, input) {
    // Check cache
    const cacheKey = `search:${input.query}`;
    const cached = await ctx.runtime?.state?.get(cacheKey);

    if (cached) {
      ctx.output?.debug('Cache hit', { query: input.query });
      return cached;
    }

    // Perform search
    const results = await performSearch(input.query);

    // Cache results (TTL: 5 minutes)
    await ctx.runtime?.state?.set(cacheKey, results, 300000);

    return results;
  }
});
```

## Related documentation

- [rest/README.md](../packages/plugin-template-core/src/rest/README.md) - Detailed REST patterns
- [utils/errors.ts](../packages/plugin-template-core/src/utils/errors.ts) - Error handling
- [Zod Documentation](https://zod.dev) - Schema validation

## Examples

See the hello handler implementation:

- [rest/handlers/hello-handler.ts](../packages/plugin-template-core/src/rest/handlers/hello-handler.ts) - Full handler example
- [rest/schemas/hello-schema.ts](../packages/plugin-template-core/src/rest/schemas/hello-schema.ts) - Schema definition
