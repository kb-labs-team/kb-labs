# Plugin Command Template Guide

This guide explains how to create standardized command handlers for KB Labs CLI plugins using the unified output pattern and helper utilities.

## Overview

All plugin commands should follow a consistent pattern that includes:
- **TimingTracker** for performance measurement
- **Box formatting** for structured output
- **Artifact discovery** for showing created files
- **Consistent error handling** and diagnostics

## Approach: Flexible and Optional

The KB Labs CLI plugin system provides **flexible helper functions** that you can use or ignore:

- **Simple plugins**: Use `createCommandRunner` and `discoverArtifacts` helpers to reduce boilerplate code and get started quickly
- **Complex plugins**: Write everything yourself for full control over the execution flow, timing, and output formatting

Both approaches are valid and produce consistent output. Choose based on your needs:
- Need quick setup? Use helpers
- Need custom logic? Write it yourself
- Mix and match? Use helpers where they fit, write custom code where needed

## Quick Start

### Basic Command Pattern

```typescript
import type { CommandModule } from '@kb-labs/cli-commands';
import { box, keyValue, formatTiming, TimingTracker, safeColors } from '@kb-labs/shared-cli-ui';
import { runScope, type AnalyticsEventV1, type EmitResult } from '@kb-labs/analytics-sdk-node';

export const run: CommandModule['run'] = async (ctx, argv, flags) => {
  const tracker = new TimingTracker();
  const jsonMode = !!flags.json;
  const quiet = !!flags.quiet;
  
  return await runScope(
    {
      actor: 'your-plugin',
      ctx: { workspace: ctx.cwd },
    },
    async (emit) => {
      try {
        tracker.checkpoint('start');
        await emit({ type: 'COMMAND_STARTED', payload: {} });
        
        // Your command logic here
        const result = await doSomething();
        
        tracker.checkpoint('complete');
        const duration = tracker.total();
        
        if (jsonMode) {
          ctx.presenter.json({ ok: true, ...result, timing: duration });
        } else {
          if (!quiet) {
            const summary = keyValue({
              'Status': safeColors.success('✓ Success'),
              'Items': result.count,
            });
            summary.push('', `Time: ${formatTiming(duration)}`);
            ctx.presenter.write(box('Your Command', summary));
          }
        }
        
        await emit({ 
          type: 'COMMAND_FINISHED', 
          payload: { durationMs: duration, result: 'success' } 
        });
        return 0;
      } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        if (jsonMode) {
          ctx.presenter.json({ ok: false, error: errorMessage, timing: tracker.total() });
        } else {
          ctx.presenter.error(errorMessage);
        }
        await emit({ 
          type: 'COMMAND_FINISHED', 
          payload: { durationMs: tracker.total(), result: 'error', error: errorMessage } 
        });
        return 1;
      }
    }
  );
};
```

## Using Helper Functions

### Using `createCommandRunner` (Recommended)

For simpler commands, you can use the `createCommandRunner` helper function:

```typescript
import { createCommandRunner, discoverArtifacts } from '@kb-labs/shared-cli-ui';

export const run = createCommandRunner({
  title: 'My Command',
  async execute(ctx, flags, tracker) {
    tracker.checkpoint('start');
    
    // Your command logic here
    const result = await doSomething();
    
    tracker.checkpoint('complete');
    
    return {
      summary: { 
        Status: safeColors.success('✓ Success'),
        Items: result.count 
      },
      artifacts: await discoverArtifacts(result.dir, [
        { name: 'Output', pattern: 'output.json', description: 'Output file' },
      ]),
    };
  },
});
```

## Examples

### Example 1: Command with Artifacts

```typescript
import type { CommandModule } from '@kb-labs/cli-commands';
import { 
  box, 
  keyValue, 
  formatTiming, 
  TimingTracker, 
  safeColors,
  displayArtifactsCompact,
  discoverArtifacts,
  type ArtifactInfo
} from '@kb-labs/shared-cli-ui';
import { runScope } from '@kb-labs/analytics-sdk-node';

export const run: CommandModule['run'] = async (ctx, argv, flags) => {
  const tracker = new TimingTracker();
  const jsonMode = !!flags.json;
  const quiet = !!flags.quiet;
  
  return await runScope(
    {
      actor: 'my-plugin',
      ctx: { workspace: ctx.cwd },
    },
    async (emit) => {
      try {
        tracker.checkpoint('start');
        await emit({ type: 'INIT_STARTED', payload: {} });
        
        // Create files
        const outputDir = await createFiles();
        
        // Discover created artifacts
        const artifacts = await discoverArtifacts(outputDir, [
          { name: 'Index', pattern: 'index.json', description: 'Main index' },
          { name: 'Config', pattern: 'config.json', description: 'Configuration' },
        ]);
        
        tracker.checkpoint('complete');
        const duration = tracker.total();
        
        if (jsonMode) {
          ctx.presenter.json({
            ok: true,
            outputDir,
            timing: duration,
            artifacts: artifacts.map(a => ({
              name: a.name,
              path: a.path,
              size: a.size
            }))
          });
        } else {
          if (!quiet) {
            const summary = keyValue({
              'Output Directory': outputDir,
              'Status': safeColors.success('✓ Initialized'),
            });
            
            // Add artifacts
            const artifactsInfo = displayArtifactsCompact(artifacts, { maxItems: 10 });
            if (artifactsInfo.length > 0) {
              summary.push(...artifactsInfo);
            }
            
            summary.push('', `Time: ${formatTiming(duration)}`);
            ctx.presenter.write(box('My Command', summary));
          }
        }
        
        await emit({ 
          type: 'INIT_FINISHED', 
          payload: { durationMs: duration, result: 'success' } 
        });
        return 0;
      } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        if (jsonMode) {
          ctx.presenter.json({ ok: false, error: errorMessage, timing: tracker.total() });
        } else {
          ctx.presenter.error(errorMessage);
        }
        await emit({ 
          type: 'INIT_FINISHED', 
          payload: { durationMs: tracker.total(), result: 'error', error: errorMessage } 
        });
        return 1;
      }
    }
  );
};
```

### Example 2: Command with Loader/Spinner

```typescript
import type { CommandModule } from '@kb-labs/cli-commands';
import { 
  box, 
  keyValue, 
  formatTiming, 
  TimingTracker, 
  safeColors,
  createSpinner
} from '@kb-labs/shared-cli-ui';
import { runScope } from '@kb-labs/analytics-sdk-node';

export const run: CommandModule['run'] = async (ctx, argv, flags) => {
  const tracker = new TimingTracker();
  const jsonMode = !!flags.json;
  const quiet = !!flags.quiet;
  const loader = createSpinner('Processing...', jsonMode);
  
  return await runScope(
    {
      actor: 'my-plugin',
      ctx: { workspace: ctx.cwd },
    },
    async (emit) => {
      try {
        tracker.checkpoint('start');
        await emit({ type: 'PROCESS_STARTED', payload: {} });
        
        if (!jsonMode && !quiet) {
          loader.start();
        }
        
        // Long-running operation
        const result = await processData();
        
        if (!jsonMode && !quiet) {
          loader.stop();
        }
        
        tracker.checkpoint('complete');
        const duration = tracker.total();
        
        if (jsonMode) {
          ctx.presenter.json({ ok: true, ...result, timing: duration });
        } else {
          if (!quiet) {
            const summary = keyValue({
              'Status': safeColors.success('✓ Complete'),
              'Processed': result.count,
            });
            summary.push('', `Time: ${formatTiming(duration)}`);
            ctx.presenter.write(box('Process', summary));
          }
        }
        
        await emit({ 
          type: 'PROCESS_FINISHED', 
          payload: { durationMs: duration, result: 'success' } 
        });
        return 0;
      } catch (e: unknown) {
        if (!jsonMode && !quiet) {
          loader.fail('Processing failed');
        }
        const errorMessage = e instanceof Error ? e.message : String(e);
        if (jsonMode) {
          ctx.presenter.json({ ok: false, error: errorMessage, timing: tracker.total() });
        } else {
          ctx.presenter.error(errorMessage);
        }
        await emit({ 
          type: 'PROCESS_FINISHED', 
          payload: { durationMs: tracker.total(), result: 'error', error: errorMessage } 
        });
        return 1;
      }
    }
  );
};
```

### Example 3: Command with Error Handling

```typescript
import type { CommandModule } from '@kb-labs/cli-commands';
import { 
  box, 
  keyValue, 
  formatTiming, 
  TimingTracker, 
  safeColors
} from '@kb-labs/shared-cli-ui';
import { runScope } from '@kb-labs/analytics-sdk-node';

export const run: CommandModule['run'] = async (ctx, argv, flags) => {
  const tracker = new TimingTracker();
  const jsonMode = !!flags.json;
  const quiet = !!flags.quiet;
  
  return await runScope(
    {
      actor: 'my-plugin',
      ctx: { workspace: ctx.cwd },
    },
    async (emit) => {
      try {
        tracker.checkpoint('start');
        await emit({ type: 'VALIDATE_STARTED', payload: {} });
        
        // Validate input
        if (!flags.input) {
          throw new Error('Input is required');
        }
        
        // Process
        const result = await validate(flags.input);
        
        tracker.checkpoint('complete');
        const duration = tracker.total();
        
        if (jsonMode) {
          ctx.presenter.json({ 
            ok: true, 
            valid: result.valid,
            errors: result.errors,
            timing: duration 
          });
        } else {
          if (!quiet) {
            const summary = keyValue({
              'Status': result.valid 
                ? safeColors.success('✓ Valid') 
                : safeColors.error('✗ Invalid'),
              'Errors': result.errors.length,
            });
            
            if (result.errors.length > 0) {
              summary.push('');
              summary.push(safeColors.error('Errors:'));
              result.errors.forEach(err => 
                summary.push(`  ${safeColors.dim('•')} ${err}`)
              );
            }
            
            summary.push('', `Time: ${formatTiming(duration)}`);
            ctx.presenter.write(box('Validate', summary));
          }
        }
        
        await emit({ 
          type: 'VALIDATE_FINISHED', 
          payload: { 
            durationMs: duration, 
            result: result.valid ? 'success' : 'failed',
            errors: result.errors.length
          } 
        });
        return result.valid ? 0 : 1;
      } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        const errorCode = e instanceof Error && 'code' in e ? (e as any).code : 'VALIDATION_ERROR';
        
        if (jsonMode) {
          ctx.presenter.json({ 
            ok: false, 
            error: errorMessage,
            code: errorCode,
            timing: tracker.total() 
          });
        } else {
          ctx.presenter.error(errorMessage);
          if (!quiet) {
            ctx.presenter.info(`Code: ${errorCode}`);
          }
        }
        await emit({ 
          type: 'VALIDATE_FINISHED', 
          payload: { 
            durationMs: tracker.total(), 
            result: 'error', 
            error: errorMessage 
          } 
        });
        return 1;
      }
    }
  );
};
```

## Helper Functions

### `discoverArtifacts`

Discover artifacts in a directory based on patterns:

```typescript
import { discoverArtifacts } from '@kb-labs/shared-cli-ui';

const artifacts = await discoverArtifacts('.kb/mind', [
  { name: 'Index', pattern: 'index.json', description: 'Main index' },
  { name: 'API Index', pattern: 'api-index.json', description: 'API index' },
]);
```

### `createCommandRunner`

Create a standardized command runner with timing and output formatting:

```typescript
import { createCommandRunner } from '@kb-labs/shared-cli-ui';

export const run = createCommandRunner({
  title: 'My Command',
  async execute(ctx, flags, tracker) {
    // Command logic
    return {
      summary: { Status: 'Success' },
    };
  },
});
```

## When to Use Helpers vs. Custom Implementation

### Use `createCommandRunner` when:
- ✅ Your command follows the standard pattern (timing and box output)
- ✅ You want to reduce boilerplate code
- ✅ You need quick setup and consistent output
- ✅ Your command logic is straightforward

### Write custom implementation when:
- ✅ You need complex control flow (multiple phases, conditional logic)
- ✅ You need custom timing breakdowns or checkpoints
- ✅ You need custom error handling or recovery logic
- ✅ You need to integrate with external systems in specific ways
- ✅ You prefer full control over the execution flow

### Mix and match:
- ✅ Use `discoverArtifacts` helper even in custom implementations
- ✅ Use individual components (`box`, `keyValue`, `TimingTracker`) as needed
- ✅ Use helpers for simple commands, custom code for complex ones

## Best Practices

### Do's

✅ **Always include timing information**
✅ **Use consistent box formatting for operations**
✅ **Include relevant summary metrics**
✅ **Support both text and JSON output**
✅ **Handle errors gracefully with proper exit codes**
✅ **Use TimingTracker for multi-phase operations**
✅ **Include diagnostics and warnings when relevant**
✅ **Discover and display artifacts when creating files**
✅ **Choose the right approach for your command complexity**

### Don'ts

❌ **Don't use box formatting for simple informational commands**
❌ **Don't show timing in JSON as formatted strings (use milliseconds)**
❌ **Don't mix different output styles in the same command**
❌ **Don't forget to handle the `--json` flag**
❌ **Don't show sensitive information in output**
❌ **Don't forget to emit analytics events**
❌ **Don't force helpers when you need custom logic**

## Testing

Test commands with:
```bash
# Text output
kb your-plugin command

# JSON output  
kb your-plugin command --json

# Quiet mode
kb your-plugin command --quiet

# Verify timing is reasonable
time kb your-plugin command
```

This ensures consistent, professional output across all KB Labs CLI plugin commands.

