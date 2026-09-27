import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { RunContext } from '@kb-labs/agent-sdk';
import { ObservabilityMiddleware } from '../observability-middleware.js';

describe('ObservabilityMiddleware', () => {
  it('includes runner setup time in the reported run duration', () => {
    const events: Array<Record<string, unknown>> = [];
    const middleware = new ObservabilityMiddleware('agent-1', undefined, 'session-1', (event) => {
      events.push(event as unknown as Record<string, unknown>);
    });
    middleware.startMeta = { startedAt: Date.now() - 100 };
    const context = {
      task: 'ping',
      tier: 'medium',
      tools: [],
      maxIterations: 10,
      meta: { get: vi.fn().mockReturnValue([]) },
      eventBus: new EventEmitter(),
    } as unknown as RunContext;

    middleware.onStart(context);
    middleware.onStop(context, 'report_complete');

    const endEvent = events.find((event) => event.type === 'agent:end');
    expect(endEvent?.data).toMatchObject({ success: true });
    expect((endEvent?.data as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(100);
  });
});
