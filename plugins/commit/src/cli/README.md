# CLI Commands

This folder contains CLI command implementations for the plugin.

## Structure

```
cli/
├── commands/          # Individual command implementations
│   ├── run.ts        # Example: hello command
│   ├── flags.ts      # Command flags definitions
│   └── index.ts      # Barrel export
└── index.ts          # CLI surface export
```

## Adding a New Command

### 1. Create Command File

Create `commands/your-command.ts`:

```typescript
import { defineCommand } from '@kb-labs/cli-command-kit';
import { getCommandId } from '@kb-labs/plugin-template-contracts';

export const run = defineCommand({
  name: getCommandId('template:your-command'),
  flags: {
    input: {
      type: 'string',
      description: 'Input parameter',
      required: true
    }
  },
  async handler(ctx, argv, flags) {
    // 1. Log command start
    ctx.logger?.info('Command started', { input: flags.input });

    // 2. Delegate business logic to core/
    const result = await yourBusinessLogic(flags.input);

    // 3. Output result
    ctx.output?.write(`Result: ${result}\n`);

    // 4. Return structured result
    return { ok: true, result };
  }
});
```

### 2. Export from Barrel

Add to `commands/index.ts`:

```typescript
export * from './your-command.js';
```

### 3. Register in Manifest

Update `src/manifest.v2.ts`:

```typescript
cli: {
  commands: [
    {
      id: 'template:your-command',
      group: 'template',
      describe: 'Does something useful',
      handler: './cli/commands/your-command.js#run',
      flags: defineCommandFlags(yourCommandFlags)
    }
  ]
}
```

## Best Practices

### ✅ DO

- **Use `ctx.logger`** for logging (not `console.log`)
- **Use `ctx.output`** for output (not `process.stdout`)
- **Delegate to `core/`** - keep CLI layer thin
- **Type your flags** - use typed flag definitions
- **Return structured results** - `{ ok: true, result: ... }`

### ❌ DON'T

- Don't put business logic in CLI handlers
- Don't create loggers manually (`createConsoleLogger` is deprecated)
- Don't use `console.log` or `process.stdout` directly
- Don't access filesystem/network directly - use core/

## Command Patterns

### Simple Command (no flags)

```typescript
export const run = defineCommand({
  name: getCommandId('template:simple'),
  async handler(ctx) {
    ctx.logger?.info('Running simple command');
    return { ok: true };
  }
});
```

### Command with Typed Flags

```typescript
import type { InferFlags } from '@kb-labs/cli-command-kit';

const myFlags = {
  name: { type: 'string' as const, required: true },
  verbose: { type: 'boolean' as const, default: false }
} as const;

type MyFlags = InferFlags<typeof myFlags>;

export const run = defineCommand<MyFlags>({
  name: getCommandId('template:typed'),
  flags: myFlags,
  async handler(ctx, argv, flags) {
    // flags.name is string (typed!)
    // flags.verbose is boolean (typed!)
  }
});
```

### Command with JSON Output

```typescript
export const run = defineCommand({
  name: getCommandId('template:json'),
  flags: {
    json: { type: 'boolean', default: false }
  },
  async handler(ctx, argv, flags) {
    const result = { message: 'Hello', count: 42 };

    if (flags.json) {
      ctx.output?.json(result);
    } else {
      ctx.output?.write(`Message: ${result.message}\n`);
    }

    return { ok: true, result };
  }
});
```

## Testing

Test CLI commands by mocking `CliContext`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { run } from './your-command.js';

describe('yourCommand', () => {
  it('should execute successfully', async () => {
    const ctx = {
      logger: { info: vi.fn() },
      output: { write: vi.fn() },
      tracker: { checkpoint: vi.fn(), total: vi.fn() }
    };

    const result = await run(ctx, [], { input: 'test' });

    expect(result.ok).toBe(true);
    expect(ctx.logger.info).toHaveBeenCalled();
  });
});
```

## Examples

See [run.ts](./commands/run.ts) for a complete example with:
- Typed flags
- Business logic delegation to `core/`
- JSON output support
- Analytics tracking
- Proper logging

## Related Documentation

- [COMMAND_IMPLEMENTATION_GUIDE.md](../../COMMAND_IMPLEMENTATION_GUIDE.md) - Three implementation approaches
- [TYPING_GUIDE.md](../../docs/TYPING_GUIDE.md) - TypeScript typing levels
- [Architecture Guide](../../../docs/architecture.md) - Overall architecture
