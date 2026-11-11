# Command Implementation Guide

This guide explains three different approaches to implementing CLI commands using `@kb-labs/cli-command-kit`. Each approach has its own use cases, advantages, and trade-offs.

## Table of Contents

1. [Approach 1: High-level Wrapper (`defineCommand`)](#approach-1-high-level-wrapper-definecommand)
2. [Approach 2: Low-level Atomic Tools](#approach-2-low-level-atomic-tools)
3. [Approach 3: Hybrid Approach](#approach-3-hybrid-approach)
4. [Choosing the Right Approach](#choosing-the-right-approach)
5. [Migration Guide](#migration-guide)

---

## Approach 1: High-level Wrapper (`defineCommand`)

**Recommended for: Most commands (90% of cases)**

### Overview

The `defineCommand` wrapper provides a zero-boilerplate experience by automatically handling:
- Flag validation and type inference
- Analytics integration
- Logging setup
- Error handling
- Timing tracking
- JSON output mode
- Output formatting

### Example

```typescript
import { defineCommand } from '@kb-labs/cli-command-kit';

export const run = defineCommand({
  name: 'template:hello',
  flags: {
    name: {
      type: 'string',
      description: 'Name to greet.',
      alias: 'n',
    },
    json: {
      type: 'boolean',
      description: 'Emit JSON payload.',
      default: false,
    },
  },
  async handler(ctx, argv, flags) {
    // ctx contains: logger, analytics, output, ui, tracker
    // flags are already validated and typed
    
    ctx.logger?.info('Command started');
    
    ctx.tracker.checkpoint('step1');
    
    // Your business logic here
    const result = doSomething(flags.name);
    
    ctx.tracker.checkpoint('complete');
    
    if (flags.json) {
      ctx.ui?.json(result);
    } else {
      ctx.ui?.write(`${result}\n`);
    }
    
    return { ok: true, result };
  },
});
```

### What You Get Automatically

✅ **Flag Validation**: Flags are validated against the schema with helpful error messages  
✅ **Type Safety**: TypeScript types are inferred from the flag schema  
✅ **Analytics**: Events are automatically emitted with command name and flags  
✅ **Logging**: Structured logging is set up and ready to use  
✅ **Timing**: `ctx.tracker` is available for performance tracking  
✅ **Error Handling**: Errors are caught and formatted consistently  
✅ **JSON Mode**: `--json` flag handling is built-in  

### When to Use

- ✅ Standard commands with flag validation needs
- ✅ Commands that benefit from analytics
- ✅ Commands that need consistent error handling
- ✅ Most new commands you're writing

### When NOT to Use

- ❌ Commands with extremely complex execution flows
- ❌ Commands that need to bypass standard error handling
- ❌ Commands that need custom analytics implementation

---

## Approach 2: Low-level Atomic Tools

**Recommended for: Complex commands requiring fine-grained control**

### Overview

Use individual atomic tools from `@kb-labs/cli-command-kit` to build your command exactly as needed. This gives you full control over every aspect of execution.

### Available Tools

- **`defineFlags`** + **`validateFlags`**: Flag schema definition and validation
- **`runWithOptionalAnalytics`**: Analytics wrapper (optional)
- **`TimingTracker`**: Performance tracking (from `@kb-labs/shared-cli-ui`)
- **`FlagValidationError`**: Custom error types

### Example

```typescript
import { defineFlags, validateFlags, type InferFlags } from '@kb-labs/cli-command-kit/flags';
import { runWithOptionalAnalytics } from '@kb-labs/cli-command-kit/analytics';
import { TimingTracker } from '@kb-labs/shared-cli-ui';
import type { CliContext } from '@kb-labs/cli-core';

// Define flag schema
const flagSchema = defineFlags({
  name: {
    type: 'string',
    description: 'Name to greet.',
    alias: 'n',
  },
  json: {
    type: 'boolean',
    description: 'Emit JSON payload.',
    default: false,
  },
});

type HelloFlags = InferFlags<typeof flagSchema>;

export async function runHelloCommand(
  ctx: CliContext,
  argv: string[],
  rawFlags: Record<string, unknown>
): Promise<HelloCommandResult> {
  // 1. Validate flags manually
  const flags = await validateFlags(rawFlags, flagSchema);
  
  // 2. Setup timing tracker
  const tracker = new TimingTracker();
  
  // 3. Wrap with analytics (optional)
  return runWithOptionalAnalytics(
    ctx.analytics,
    'template:hello',
    async (emit) => {
      ctx.logger?.info('Command started', { name: flags.name });
      
      // Emit custom analytics event
      emit({ 
        name: flags.name, 
        json: flags.json,
        customMetric: calculateMetric()
      });
      
      tracker.checkpoint('step1');
      
      // Your business logic
      const result = doSomething(flags.name);
      
      tracker.checkpoint('complete');
      
      // Handle output
      if (flags.json) {
        ctx.ui?.json(result);
      } else {
        ctx.ui?.write(`${result}\n`);
      }
      
      ctx.logger?.info('Command completed', {
        durationMs: tracker.total(),
        customMetric: calculateMetric()
      });
      
      return result;
    }
  );
}
```

### What You Control

✅ **Flag Validation**: You decide when and how to validate  
✅ **Analytics**: Full control over what events are emitted and when  
✅ **Error Handling**: Custom error handling logic  
✅ **Timing**: Multiple trackers for different concerns  
✅ **Execution Flow**: Complete control over execution order  

### When to Use

- ✅ Commands with complex multi-step workflows
- ✅ Commands that need custom analytics implementation
- ✅ Commands that need to bypass standard error handling
- ✅ Commands that need multiple timing trackers

### When NOT to Use

- ❌ Simple commands that don't need special handling
- ❌ When you want zero boilerplate

---

## Approach 3: Hybrid Approach

**Recommended for: Commands that need `defineCommand` but also custom logic**

### Overview

Use `defineCommand` for the standard benefits, but add custom tools where needed for specific requirements.

### Example

```typescript
import { defineCommand } from '@kb-labs/cli-command-kit';
import { TimingTracker } from '@kb-labs/shared-cli-ui';

export const run = defineCommand({
  name: 'template:hello',
  flags: {
    name: {
      type: 'string',
      description: 'Name to greet.',
      alias: 'n',
    },
    json: {
      type: 'boolean',
      description: 'Emit JSON payload.',
      default: false,
    },
  },
  async handler(ctx, argv, flags) {
    // Use defineCommand's built-in tracker
    ctx.tracker.checkpoint('start');
    
    // But also add custom tracking for specific operations
    const customTracker = new TimingTracker();
    
    ctx.logger?.info('Command started', { name: flags.name });

    customTracker.checkpoint('custom-operation-start');
    
    // Expensive custom operation
    const expensiveResult = await performExpensiveOperation();
    
    customTracker.checkpoint('custom-operation-complete');
    
    // Use both trackers
    ctx.logger?.info('Timing', {
      totalDuration: ctx.tracker.total(),
      customOperationDuration: customTracker.total()
    });
    
    const result = doSomething(flags.name, expensiveResult);
    
    if (flags.json) {
      ctx.ui?.json(result);
    } else {
      ctx.ui?.write(`${result}\n`);
    }
    
    return { ok: true, result };
  },
});
```

### What You Get

✅ **All benefits of `defineCommand`**  
✅ **Plus custom tools** where needed  
✅ **Best of both worlds**  

### When to Use

- ✅ Commands that mostly fit `defineCommand` but need some custom logic
- ✅ Commands that need additional timing tracking
- ✅ Commands that need custom analytics on top of standard analytics

---

## Choosing the Right Approach

### Decision Tree

```
Start
  │
  ├─ Does your command need standard flag validation, analytics, and error handling?
  │  │
  │  ├─ YES → Use Approach 1 (defineCommand) ✅
  │  │
  │  └─ NO → Does it need fine-grained control over execution?
  │     │
  │     ├─ YES → Use Approach 2 (Atomic Tools)
  │     │
  │     └─ NO → Use Approach 1 (defineCommand) + add custom tools where needed (Approach 3)
```

### Quick Reference

| Requirement | Approach 1 | Approach 2 | Approach 3 |
|------------|-----------|-----------|-----------|
| Standard flag validation | ✅ Built-in | ✅ Manual | ✅ Built-in |
| Analytics | ✅ Automatic | ✅ Manual | ✅ Automatic + Custom |
| Error handling | ✅ Automatic | ✅ Manual | ✅ Automatic |
| Custom timing | ✅ `ctx.tracker` | ✅ Full control | ✅ Both |
| Boilerplate | ✅ Zero | ❌ More | ✅ Minimal |
| Control | ⚠️ Standard | ✅ Full | ✅ Flexible |

---

## Migration Guide

### From Legacy Commands

If you have existing commands using the old format:

```typescript
// Old format
export async function runCommand(
  args: CommandArgs = {},
  context?: CommandContext
): Promise<CommandResult> {
  // Manual validation, logging, etc.
}
```

**Migrate to Approach 1:**

```typescript
import { defineCommand } from '@kb-labs/cli-command-kit';

export const run = defineCommand({
  name: 'your:command',
  flags: {
    // Define flags schema
  },
  async handler(ctx, argv, flags) {
    // Move your logic here
    // ctx replaces context
    // flags replaces args (already validated)
  },
});
```

### Step-by-Step Migration

1. **Add dependency**: `@kb-labs/cli-command-kit` to `package.json`
2. **Define flag schema**: Convert your flag definitions to the schema format
3. **Move logic**: Move your command logic into the `handler` function
4. **Update context usage**: Replace `context.logger` with `ctx.logger`, etc.
5. **Test**: Verify the command works with the new implementation

---

## Best Practices

### Flag Definitions

```typescript
flags: {
  // Use descriptive names
  'output-path': {
    type: 'string',
    description: 'Path to output file.',
    required: true, // Mark required flags
  },
  
  // Provide defaults
  format: {
    type: 'string',
    description: 'Output format.',
    choices: ['json', 'yaml', 'toml'] as const,
    default: 'json',
  },
  
  // Use aliases for common flags
  verbose: {
    type: 'boolean',
    description: 'Enable verbose output.',
    alias: 'v',
    default: false,
  },
}
```

### Error Handling

```typescript
async handler(ctx, argv, flags) {
  try {
    // Your logic
    return { ok: true, result };
  } catch (error) {
    // defineCommand handles errors automatically,
    // but you can add custom handling if needed
    ctx.logger?.error('Custom error handling', { error });
    return { ok: false, exitCode: 1, error: error.message };
  }
}
```

### Analytics

```typescript
async handler(ctx, argv, flags) {
  // Analytics are automatic, but you can emit custom events
  ctx.analytics?.emit('custom-event', {
    customField: 'value',
    flags: flags
  });
  
  // Your logic
}
```

### Timing

```typescript
async handler(ctx, argv, flags) {
  ctx.tracker.checkpoint('start');
  
  // Step 1
  await step1();
  ctx.tracker.checkpoint('step1-complete');
  
  // Step 2
  await step2();
  ctx.tracker.checkpoint('step2-complete');
  
  ctx.logger?.info('Timing breakdown', {
    step1: ctx.tracker.duration('start', 'step1-complete'),
    step2: ctx.tracker.duration('step1-complete', 'step2-complete'),
    total: ctx.tracker.total()
  });
}
```

---

## Examples

See `src/cli/commands/hello/run.ts` for all three implementation approaches with working code examples.

---

## Further Reading

- [@kb-labs/cli-command-kit Documentation](../../../kb-labs-cli/packages/command-kit/README.md)
- [Flag Validation Guide](../../../kb-labs-cli/packages/command-kit/src/flags/README.md)
- [Analytics Integration](../../../kb-labs-cli/packages/command-kit/src/analytics/README.md)

