# REST API Handlers

This folder contains REST API handler implementations for the plugin.

## Structure

```
rest/
├── handlers/          # Route handler implementations
│   ├── hello-handler.ts
│   └── context.ts    # Shared handler types
├── schemas/          # Request/response schemas (Zod)
│   └── hello-schema.ts
└── index.ts          # REST surface export
```

## Adding a New Handler

### 1. Define Schemas

Create `schemas/your-schema.ts`:

```typescript
import { z } from 'zod';

// Request schema
export const YourRequestSchema = z.object({
  input: z.string().min(1),
  options: z.object({
    verbose: z.boolean().optional()
  }).optional()
});

// Response schema
export const YourResponseSchema = z.object({
  result: z.string(),
  processedAt: z.string()
});

// TypeScript types
export type YourRequest = z.infer<typeof YourRequestSchema>;
export type YourResponse = z.infer<typeof YourResponseSchema>;
```

### 2. Create Handler

Create `handlers/your-handler.ts`:

```typescript
import { definePluginHandler } from '@kb-labs/plugin-runtime';
import { YourRequestSchema, YourResponseSchema } from '../schemas/your-schema.js';
import type { YourRequest, YourResponse } from '../schemas/your-schema.js';

export const handleYourEndpoint = definePluginHandler<YourRequest, YourResponse>({
  schema: {
    input: YourRequestSchema,
    output: YourResponseSchema
  },

  async handle(input, ctx) {
    // 1. Log request
    ctx.logger.info('Processing request', {
      requestId: ctx.requestId,
      input: input.input
    });

    // 2. Delegate business logic to core/
    const result = await yourBusinessLogic(input.input);

    // 3. Return typed response (auto-validated against schema)
    return {
      result,
      processedAt: new Date().toISOString()
    };
  }
});
```

### 3. Register in Manifest

Update `src/manifest.v2.ts`:

```typescript
rest: {
  basePath: '/v1/plugins/template',
  routes: [
    {
      method: 'POST',
      path: '/your-endpoint',
      input: {
        zod: './rest/schemas/your-schema.js#YourRequestSchema'
      },
      output: {
        zod: './rest/schemas/your-schema.js#YourResponseSchema'
      },
      handler: './rest/handlers/your-handler.js#handleYourEndpoint',
      permissions: {
        fs: { mode: 'none' },
        net: 'none',
        quotas: {
          timeoutMs: 5000,
          memoryMb: 64
        }
      }
    }
  ]
}
```

## Best Practices

### ✅ DO

- **Use `ctx.logger`** for logging (not `console.log`, see [Migration Guide](../../../docs/MIGRATION-ui-output.md))
  - REST uses `ctx.logger.info()` for structured logging
- **Define Zod schemas** - automatic validation + TypeScript types
- **Delegate to `core/`** - keep handlers thin
- **Return typed responses** - schemas ensure correctness
- **Set proper permissions** - minimal permissions (fs: none, net: none)

### ❌ DON'T

- Don't access filesystem without permissions
- Don't make network requests without `net: 'allow'`
- Don't put business logic in handlers
- Don't skip schema definitions
- Don't use `console.log` - use `ctx.logger`

## Handler Patterns

### Simple GET Handler

```typescript
export const handleGet = definePluginHandler<void, { message: string }>({
  schema: {
    output: z.object({ message: z.string() })
  },

  async handle(input, ctx) {
    return { message: 'Hello from GET' };
  }
});
```

### POST Handler with Validation

```typescript
const InputSchema = z.object({
  name: z.string().min(1).max(100),
  age: z.number().int().positive().optional()
});

export const handlePost = definePluginHandler({
  schema: {
    input: InputSchema,
    output: z.object({ created: z.boolean() })
  },

  async handle(input, ctx) {
    // Input is automatically validated
    ctx.logger.info('Creating resource', { name: input.name });

    const result = await createResource(input);

    return { created: true };
  }
});
```

### Handler with Error Handling

```typescript
import { createError } from '../../utils/errors.js';

export const handleWithErrors = definePluginHandler({
  schema: {
    input: RequestSchema,
    output: ResponseSchema
  },

  async handle(input, ctx) {
    // Validate business rules
    if (!isValid(input)) {
      throw createError('VALIDATION_FAILED', 'Invalid input', { input });
    }

    try {
      const result = await riskyOperation(input);
      return { result };
    } catch (error) {
      ctx.logger.error('Operation failed', { error });
      throw createError('OPERATION_FAILED', 'Failed to process', { cause: error });
    }
  }
});
```

### Handler with Permissions

```typescript
// In manifest.v2.ts
{
  method: 'POST',
  path: '/upload',
  handler: './rest/handlers/upload.js#handleUpload',
  permissions: {
    fs: {
      mode: 'write',
      allow: ['.kb/template/uploads/**'],
      deny: ['.kb/config/**']
    },
    net: 'none',
    quotas: {
      timeoutMs: 30000,  // 30s for uploads
      memoryMb: 256      // More memory for file processing
    }
  }
}
```

## Context API

REST handlers receive `ctx` with these properties:

### Output (Logging)

```typescript
ctx.logger.info('Message', { meta });   // Info log
ctx.logger.warn('Warning', { meta });   // Warning log
ctx.logger.error('Error', { meta });    // Error log
ctx.logger.debug('Debug', { meta });    // Debug log
```

### Request Metadata

```typescript
ctx.requestId     // Unique request ID
ctx.tenantId      // Tenant ID (if multi-tenant)
ctx.runtime       // Runtime utilities (fs, state, config)
```

### Runtime Utilities

```typescript
// Filesystem (if permitted)
await ctx.runtime.fs.readFile('.kb/config.json');
await ctx.runtime.fs.writeFile('.kb/data.json', data);

// State broker (caching)
await ctx.runtime.state.set('key', value, ttl);
const cached = await ctx.runtime.state.get('key');

// Config
await ctx.runtime.config.get('plugins.template.setting');
```

## Testing

Test REST handlers by mocking context:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { handleYourEndpoint } from './your-handler.js';

describe('handleYourEndpoint', () => {
  it('should process request successfully', async () => {
    const ctx = {
      requestId: 'test-123',
      output: {
        info: vi.fn(),
        error: vi.fn()
      },
      runtime: {
        state: {
          get: vi.fn(),
          set: vi.fn()
        }
      }
    };

    const input = { input: 'test value' };
    const result = await handleYourEndpoint.handle(input, ctx);

    expect(result.result).toBeDefined();
    expect(ctx.logger.info).toHaveBeenCalled();
  });

  it('should handle validation errors', async () => {
    const ctx = { ... };
    const invalidInput = { input: '' }; // Too short

    await expect(
      handleYourEndpoint.handle(invalidInput, ctx)
    ).rejects.toThrow();
  });
});
```

## Schema Best Practices

### Use Zod Refinements

```typescript
const EmailSchema = z.string().email();
const UrlSchema = z.string().url();
const DateSchema = z.string().datetime();

const UserSchema = z.object({
  email: EmailSchema,
  age: z.number().int().min(18).max(120),
  website: UrlSchema.optional(),
  createdAt: DateSchema
});
```

### Reuse Common Schemas

```typescript
// schemas/common.ts
export const PaginationSchema = z.object({
  page: z.number().int().positive().default(1),
  limit: z.number().int().positive().max(100).default(20)
});

// Use in handlers
const ListRequestSchema = z.object({
  filters: z.object({...}),
  pagination: PaginationSchema
});
```

### Transform Data

```typescript
const InputSchema = z.object({
  name: z.string().transform(s => s.trim().toLowerCase()),
  tags: z.string().transform(s => s.split(',').map(t => t.trim()))
});

// Input: { name: "  HELLO  ", tags: "foo, bar" }
// Parsed: { name: "hello", tags: ["foo", "bar"] }
```

## Examples

See [hello-handler.ts](./handlers/hello-handler.ts) for a complete example with:
- Zod schema validation
- Typed request/response
- Logging with `ctx.logger`
- Business logic delegation to `core/`
- Artifact tracking

## Related Documentation

- [rest-guide.md](../../../docs/rest-guide.md) - REST API guide
- [Architecture Guide](../../../docs/architecture.md) - Overall architecture
- [Zod Documentation](https://zod.dev) - Schema validation
