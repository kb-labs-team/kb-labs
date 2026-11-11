import { describe, it, expect, vi } from 'vitest';
import { ProgressMiddleware } from '../../src/core/middleware/builtin/progress-middleware.js';
import type { RunContext, ToolExecCtx, ToolOutput } from '@kb-labs/agents/sdk';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMeta() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: vi.fn((ns: string, key: string) => store.get(ns)?.get(key)),
    set: vi.fn((ns: string, key: string, value: unknown) => {
      if (!store.has(ns)) {store.set(ns, new Map());}
      store.get(ns)!.set(key, value);
    }),
    getNamespace: vi.fn((ns: string) => Object.fromEntries(store.get(ns) ?? new Map())),
  };
}

function makeEventBus() {
  return { emit: vi.fn() };
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
    eventBus: makeEventBus(),
    ...overrides,
  } as RunContext;
}

function makeToolCtx(runCtx?: RunContext, toolName = 'fs_read', input: Record<string, unknown> = {}): ToolExecCtx {
  const run = runCtx ?? makeRunCtx();
  return {
    run,
    toolName,
    input,
    iteration: run.iteration,
    abortSignal: run.abortSignal,
    requestId: run.requestId,
  };
}

function makeToolOutput(success = true, output = 'result'): ToolOutput {
  return { toolCallId: 'tc-1', output, success };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ProgressMiddleware', () => {
  describe('stuck detection', () => {
    it('increments iterationsSinceProgress each iteration', () => {
      const mw = new ProgressMiddleware(4);
      mw.beforeIteration(makeRunCtx({ iteration: 0 }));
      mw.beforeIteration(makeRunCtx({ iteration: 1 }));
      mw.beforeIteration(makeRunCtx({ iteration: 2 }));
      expect(mw.iterationsSinceProgress).toBe(3);
    });

    it('detects stuck state', () => {
      const onStuck = vi.fn();
      const mw = new ProgressMiddleware(4, { onStuck });
      for (let i = 0; i < 5; i++) {
        mw.beforeIteration(makeRunCtx({ iteration: i }));
      }
      expect(mw.isStuck).toBe(true);
      expect(onStuck).toHaveBeenCalled();
    });

    it('resets counter on successful tool output', () => {
      const mw = new ProgressMiddleware(4);
      mw.beforeIteration(makeRunCtx({ iteration: 0 }));
      mw.beforeIteration(makeRunCtx({ iteration: 1 }));
      expect(mw.iterationsSinceProgress).toBe(2);

      mw.afterToolExec(
        makeToolCtx(makeRunCtx({ iteration: 1 }), 'fs_read'),
        makeToolOutput(true, 'file content here with enough text'),
      );
      expect(mw.iterationsSinceProgress).toBe(0);
    });
  });

  describe('loop detection', () => {
    it('detects repeating tool call pattern', () => {
      const onLoop = vi.fn();
      const mw = new ProgressMiddleware(4, { onLoop });

      const run = makeRunCtx();
      // Same 3 calls repeated twice
      for (let i = 0; i < 6; i++) {
        const toolIdx = i % 3;
        mw.afterToolExec(
          makeToolCtx(run, `tool_${toolIdx}`, { key: 'val' }),
          makeToolOutput(true, 'output'),
        );
      }

      expect(run.meta.set).toHaveBeenCalledWith('progress', 'loopDetected', true);
      expect(onLoop).toHaveBeenCalled();
    });

    it('does not false-positive on different calls', () => {
      const mw = new ProgressMiddleware(4);
      const run = makeRunCtx();

      for (let i = 0; i < 6; i++) {
        mw.afterToolExec(makeToolCtx(run, `tool_${i}`), makeToolOutput(true, 'output'));
      }

      expect(run.meta.set).not.toHaveBeenCalledWith('progress', 'loopDetected', true);
    });
  });

  describe('reset', () => {
    it('resets all state', () => {
      const mw = new ProgressMiddleware(4);
      mw.beforeIteration(makeRunCtx());
      mw.beforeIteration(makeRunCtx());
      expect(mw.iterationsSinceProgress).toBe(2);
      mw.reset();
      expect(mw.iterationsSinceProgress).toBe(0);
    });
  });
});
