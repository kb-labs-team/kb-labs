# Getting Started

Follow these steps to explore and extend the KB Labs Plugin Template.

## 1. Install dependencies

```bash
pnpm install
```

This runs `devkit:sync` automatically to align local configs with the latest presets.

## 2. Build the sample plugin

```bash
pnpm --filter @kb-labs/plugin-template-core run build
```

You will find compiled assets in `packages/plugin-template-core/dist/`.

## 3. Run the Hello command

The template includes a sample CLI command. You can run it via the KB CLI:

```bash
kb template:hello --name Developer
```

Expected output:

```
Hello, Developer!
```

Add `--json` to see the structured payload emitted by the command.

## 4. Hit the REST endpoint locally

Use the REST sandbox to test the hello endpoint:

```bash
pnpm sandbox:rest Developer
```

Expected console log:

```
REST response: { message: 'Hello, Developer!', target: 'Developer' }
```

It also prints the structured log emitted by the handler.

## 5. Explore the codebase

The plugin template follows KB Labs standard folder structure:

```
packages/plugin-template-core/src/
├── cli/              # CLI commands
├── rest/             # REST API handlers
├── studio/           # Studio React components
├── lifecycle/        # Plugin lifecycle (setup, destroy, upgrade)
├── core/             # Pure business logic
└── utils/            # Shared utilities
```

Each folder has a README.md with detailed documentation:

- [cli/README.md](../packages/plugin-template-core/src/cli/README.md) - Adding CLI commands
- [rest/README.md](../packages/plugin-template-core/src/rest/README.md) - Adding REST handlers
- [studio/README.md](../packages/plugin-template-core/src/studio/README.md) - Adding Studio widgets
- [lifecycle/README.md](../packages/plugin-template-core/src/lifecycle/README.md) - Lifecycle hooks
- [core/README.md](../packages/plugin-template-core/src/core/README.md) - Business logic
- [utils/README.md](../packages/plugin-template-core/src/utils/README.md) - Utilities

## 6. Next steps

### Add a new CLI command

See [cli/README.md](../packages/plugin-template-core/src/cli/README.md) for detailed guide.

Quick example:

```typescript
// src/cli/commands/your-command.ts
import { defineCommand } from '@kb-labs/cli-command-kit';
import { getCommandId } from '../utils.js';

export const run = defineCommand({
  name: getCommandId('template:your-command'),
  flags: {
    input: { type: 'string', required: true }
  },
  async handler(ctx, argv, flags) {
    ctx.logger?.info('Command started', { input: flags.input });
    ctx.output?.write(`Processing: ${flags.input}\n`);
    return { ok: true };
  }
});
```

Then register in `src/manifest.v2.ts`.

### Add a new REST endpoint

See [rest/README.md](../packages/plugin-template-core/src/rest/README.md) for detailed guide.

Quick example:

```typescript
// src/rest/schemas/your-schema.ts
import { z } from 'zod';

export const YourRequestSchema = z.object({
  input: z.string()
});

export const YourResponseSchema = z.object({
  result: z.string(),
  processedAt: z.string()
});

// src/rest/handlers/your-handler.ts
import { defineHandler } from '@kb-labs/sdk';

export const handleYourEndpoint = defineHandler({
  async execute(ctx, input) {
    const result = await yourBusinessLogic(input.input);
    return {
      result,
      processedAt: new Date().toISOString()
    };
  }
});
```

Then register in `src/manifest.v2.ts`.

### Add a Studio widget

See [studio/README.md](../packages/plugin-template-core/src/studio/README.md) for detailed guide.

Quick example:

```tsx
// src/studio/widgets/your-widget.tsx
import React from 'react';

export interface YourWidgetProps {
  data?: { message: string };
  loading?: boolean;
  error?: Error;
}

export function YourWidget({ data, loading, error }: YourWidgetProps) {
  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;
  if (!data) return <div>No data</div>;

  return <div>{data.message}</div>;
}
```

Then register in `src/manifest.v2.ts` with data source.

## 7. Understanding the architecture

Read these documents to understand the template design:

- [docs/architecture.md](./architecture.md) - Overall architecture and patterns
- [docs/REFACTORING.md](./REFACTORING.md) - Migration from old DDD structure
- [docs/adr/0009-flatten-plugin-structure.md](./adr/0009-flatten-plugin-structure.md) - ADR explaining design decisions

## 8. Testing

Run tests with:

```bash
pnpm --filter @kb-labs/plugin-template-core run test
```

See testing examples in the folder READMEs.

## 9. Common patterns

### Error handling

The template includes comprehensive error handling utilities:

```typescript
import {
  ValidationError,
  NotFoundError,
  BusinessRuleError,
  assertNotNull,
  formatErrorForLogging
} from './utils/errors.js';

// Validation
if (!isValidEmail(email)) {
  throw new ValidationError('Invalid email', 'email');
}

// Not found
const user = await getUser(id);
if (!user) {
  throw new NotFoundError('User', id);
}

// Assertions
assertNotNull(value, 'fieldName', 'Custom message');

// Logging errors
try {
  await operation();
} catch (error) {
  ctx.logger?.error('Operation failed', formatErrorForLogging(error));
}
```

See [utils/errors.ts](../packages/plugin-template-core/src/utils/errors.ts) for all error classes.

### Using ctx.logger

**Modern approach (✅ RECOMMENDED):**

```typescript
export const run = defineCommand({
  async handler(ctx, argv, flags) {
    ctx.logger?.info('Command started', { flag: flags.input });
    ctx.logger?.debug('Debug details', { meta: { ... } });
    ctx.logger?.warn('Warning message');
    ctx.logger?.error('Error occurred', { error: err });
  }
});
```

**Deprecated approach (❌ DON'T USE):**

```typescript
// DON'T: createConsoleLogger is deprecated
import { createConsoleLogger } from './utils/logger.js';
const logger = createConsoleLogger('my-module');
```

## 10. Resources

- [CLI Guide](./cli-guide.md) - CLI patterns and best practices
- [REST Guide](./rest-guide.md) - REST handlers and Zod validation
- [Studio Guide](./studio-guide.md) - React widgets and layouts
- [FAQ](./faq.md) - Common questions

## Need help?

Check the [FAQ](./faq.md) or explore the comprehensive folder READMEs in `src/`.
