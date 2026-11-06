# Analytics Integration

## Overview

KB Labs provides automatic analytics integration for all plugins via `@kb-labs/analytics-sdk-node`. Plugins can track custom events and metrics, which can be rendered in Studio widgets.

## Automatic Integration

Analytics SDK is automatically injected into the execution context for all plugins. No setup required!

### Standard Events

The following events are automatically tracked:

- `plugin.exec.started` - Plugin execution started
- `plugin.exec.finished` - Plugin execution completed successfully
- `plugin.exec.failed` - Plugin execution failed
- `plugin.permission.denied` - Permission denied
- `plugin.artifact.failed` - Artifact write failed

### Standard Metrics

Each event includes:
- `pluginId` - Plugin identifier
- `pluginVersion` - Plugin version
- `routeOrCommand` - Route or command name
- `requestId` - Unique request identifier
- `timeMs` - Execution time in milliseconds
- `cpuMs` - CPU time in milliseconds (if available)
- `memMb` - Memory usage in MB (if available)

## Custom Tracking

### Using Analytics in Handlers

Analytics client is available in the runtime context:

```typescript
export async function run(
  input: { query: string },
  ctx: {
    requestId: string;
    pluginId: string;
    runtime: {
      // ... other runtime APIs
      analytics?: (event: Partial<AnalyticsEventV1>) => Promise<EmitResult>;
    };
  }
): Promise<unknown> {
  // Track custom event
  if (ctx.runtime.analytics) {
    await ctx.runtime.analytics({
      type: 'mind.query.executed',
      payload: {
        queryLength: input.query.length,
        resultsCount: 10,
      },
    });
  }

  return { results: [] };
}
```

### Event Structure

Custom events should follow this structure:

```typescript
{
  type: string;              // Event type (e.g., 'mind.query.executed')
  payload?: unknown;         // Event payload (any data)
  ctx?: {                    // Additional context (optional)
    [key: string]: unknown;
  };
}
```

The following fields are automatically added:
- `runId` - Execution request ID
- `actor` - Plugin actor (type: 'agent', id: pluginId)
- `ctx.workspace` - Working directory
- `ctx.command` - Command name

### Example: Tracking Query Execution

```typescript
export async function run(
  input: { query: string; limit?: number },
  ctx: {
    requestId: string;
    pluginId: string;
    runtime: {
      analytics?: (event: Partial<AnalyticsEventV1>) => Promise<EmitResult>;
    };
  }
): Promise<{ results: unknown[] }> {
  const startTime = Date.now();

  // Execute query
  const results = await executeQuery(input.query, input.limit);

  // Track execution
  if (ctx.runtime.analytics) {
    await ctx.runtime.analytics({
      type: 'mind.query.executed',
      payload: {
        queryLength: input.query.length,
        resultsCount: results.length,
        durationMs: Date.now() - startTime,
        limit: input.limit,
      },
    });
  }

  return { results };
}
```

### Example: Tracking Errors

```typescript
export async function run(
  input: { query: string },
  ctx: {
    requestId: string;
    pluginId: string;
    runtime: {
      analytics?: (event: Partial<AnalyticsEventV1>) => Promise<EmitResult>;
      log: (level: 'error', msg: string, meta?: Record<string, unknown>) => void;
    };
  }
): Promise<unknown> {
  try {
    // ... handler logic
  } catch (error) {
    // Track error
    if (ctx.runtime.analytics) {
      await ctx.runtime.analytics({
        type: 'mind.query.error',
        payload: {
          error: error instanceof Error ? error.message : String(error),
          queryLength: input.query.length,
        },
      });
    }

    throw error;
  }
}
```

## Best Practices

### 1. Track Important Operations

Track operations that:
- Take significant time (> 100ms)
- May fail (errors)
- Are important for understanding usage
- Are used for optimization

### 2. Include Relevant Context

Include context that helps understand:
- What operation was performed
- Why it might have failed
- What parameters were used
- What the result was

### 3. Don't Track Everything

Avoid tracking:
- Very frequent operations (every millisecond)
- Trivial operations (< 10ms)
- Internal implementation details
- Sensitive data (passwords, tokens, etc.)

### 4. Use Consistent Event Types

Use consistent naming:
- `{plugin}.{operation}.{status}` format
- Examples:
  - `mind.query.executed`
  - `mind.query.error`
  - `mind.pack.created`
  - `mind.pack.failed`

## Rendering Metrics in Studio

Metrics collected via analytics can be rendered in Studio widgets.

### Example Widget

```typescript
// src/studio/widgets/query-stats.tsx
import { useAnalytics } from '@kb-labs/studio-core';

export function QueryStatsWidget() {
  const { data } = useAnalytics('mind.query.executed', {
    timeRange: '24h',
  });

  return (
    <div>
      <h3>Query Statistics</h3>
      <p>Total queries: {data?.total || 0}</p>
      <p>Average duration: {data?.avgDurationMs || 0}ms</p>
      <p>Success rate: {data?.successRate || 0}%</p>
    </div>
  );
}
```

### Widget Manifest

```typescript
export const manifest: ManifestV2 = {
  // ... other config
  studio: {
    widgets: [
      {
        id: 'query-stats',
        kind: 'custom',
        component: './studio/widgets/query-stats.tsx',
        data: {
          source: 'analytics',
          event: 'mind.query.executed',
          timeRange: '24h',
        },
      },
    ],
  },
};
```

## Testing Analytics

### Dry-Run Mode

Analytics events are still tracked in dry-run mode, but marked as such:

```bash
kb mind:query --query "test" --dry-run
```

### Mocking Analytics

In tests, you can mock the analytics client:

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('Query Handler', () => {
  it('should track query execution', async () => {
    const trackEvent = vi.fn();
    
    const result = await run(
      { query: 'test' },
      {
        requestId: 'test-id',
        pluginId: '@kb-labs/mind/cli',
        runtime: {
          // ... other runtime APIs
          analytics: trackEvent,
        },
      }
    );

    expect(trackEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'mind.query.executed',
      })
    );
  });
});
```

## Troubleshooting

### Issue: Analytics not working

**Solutions**:
- Check that analytics SDK is available in context
- Verify `ctx.runtime.analytics` is defined
- Check analytics SDK logs for errors

### Issue: Events not appearing

**Solutions**:
- Verify event type is correctly formatted
- Check payload is serializable (no circular references)
- Check analytics SDK configuration

### Issue: Performance impact

**Solutions**:
- Analytics is fire-and-forget (never throws)
- Should not impact performance significantly
- If needed, reduce frequency of tracking

## Additional Resources

- [Analytics SDK Documentation](../../../kb-labs-analytics/docs/README.md)
- [Studio Widgets Guide](./studio-widgets.md)
- [Debugging Guide](./debugging.md)






