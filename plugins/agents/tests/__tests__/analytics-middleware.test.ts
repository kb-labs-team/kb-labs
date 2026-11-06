import { describe, it, expect, vi } from 'vitest';
import { AnalyticsMiddleware } from '../../src/core/middleware/builtin/analytics-middleware.js';
import type { RunContext, ToolExecCtx, ToolOutput } from '@kb-labs/agents/sdk';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMeta() {
  return {
    get: vi.fn(),
    set: vi.fn(),
    getNamespace: vi.fn().mockReturnValue({}),
  };
}

function makeRunCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    task: 'test',
    tier: 'medium',
    messages: [],
    tools: [],
    iteration: 0,
    maxIterations: 20,
    aborted: false,
    abortSignal: new AbortController().signal,
    requestId: 'req-1',
    meta: makeMeta(),
    ...overrides,
  } as RunContext;
}

function makeToolCtx(runCtx?: RunContext, toolName = 'fs_read'): ToolExecCtx {
  const run = runCtx ?? makeRunCtx();
  return {
    run,
    toolName,
    input: {},
    iteration: run.iteration,
    abortSignal: run.abortSignal,
    requestId: run.requestId,
  };
}

function makeToolOutput(success = true, output = 'result'): ToolOutput {
  return { toolCallId: 'tc-1', output, success };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('AnalyticsMiddleware', () => {
  it('tracks tool outcomes', () => {
    const onToolOutcome = vi.fn();
    const mw = new AnalyticsMiddleware({ onToolOutcome });
    mw.onStart(makeRunCtx());

    mw.afterToolExec(makeToolCtx(undefined, 'fs_read'), makeToolOutput(true));
    mw.afterToolExec(makeToolCtx(undefined, 'shell_exec'), makeToolOutput(false));

    expect(mw.toolSuccessCount).toBe(1);
    expect(mw.toolErrorCount).toBe(1);
    expect(mw.toolOutcomes).toHaveLength(2);
    expect(onToolOutcome).toHaveBeenCalledTimes(2);
  });

  it('emits run metrics on stop', () => {
    const onRunComplete = vi.fn();
    const mw = new AnalyticsMiddleware({ onRunComplete });
    mw.onStart(makeRunCtx());

    mw.afterToolExec(makeToolCtx(undefined, 'fs_read'), makeToolOutput(true));
    mw.onStop(makeRunCtx(), 'report_complete');

    expect(onRunComplete).toHaveBeenCalledOnce();
    const metrics = onRunComplete.mock.calls[0]![0];
    expect(metrics.toolSuccessCount).toBe(1);
    expect(metrics.stopReason).toBe('report_complete');
    expect(metrics.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('resets state', () => {
    const mw = new AnalyticsMiddleware();
    mw.onStart(makeRunCtx());
    mw.afterToolExec(makeToolCtx(undefined, 'fs_read'), makeToolOutput(true));
    mw.reset();
    expect(mw.toolSuccessCount).toBe(0);
    expect(mw.toolOutcomes).toHaveLength(0);
  });
});
