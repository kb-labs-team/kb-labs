import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_FEATURE_FLAGS } from '@kb-labs/agents/contracts';
import { MiddlewarePipeline } from '../../src/core/middleware/pipeline.js';
import type { AgentMiddleware, RunContext, LLMCtx, ToolExecCtx, ToolOutput, ControlAction } from '@kb-labs/agents/sdk';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
  const meta = {
    get: vi.fn(),
    set: vi.fn(),
    getNamespace: vi.fn().mockReturnValue({}),
  };
  return {
    task: 'test task',
    tier: 'medium',
    messages: [],
    tools: [],
    iteration: 0,
    maxIterations: 20,
    aborted: false,
    abortSignal: new AbortController().signal,
    requestId: 'test-run-1',
    meta,
    ...overrides,
  } as RunContext;
}

function makeLLMCtx(runCtx?: RunContext): LLMCtx {
  return {
    run: runCtx ?? makeCtx(),
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
  };
}

function makeToolCtx(runCtx?: RunContext): ToolExecCtx {
  const run = runCtx ?? makeCtx();
  return {
    run,
    toolName: 'fs_read',
    input: { path: '/tmp/test' },
    iteration: run.iteration,
    abortSignal: run.abortSignal,
    requestId: run.requestId,
  };
}

function makeToolOutput(success = true): ToolOutput {
  return { toolCallId: 'tc-1', output: 'result', success };
}

function makeMiddleware(overrides: Partial<AgentMiddleware> & { name: string; order: number }): AgentMiddleware {
  return {
    config: { failPolicy: 'fail-open' },
    ...overrides,
  };
}

const defaultFlags = { ...DEFAULT_FEATURE_FLAGS };

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MiddlewarePipeline', () => {
  describe('ordering', () => {
    it('runs before-hooks in ascending order', async () => {
      const order: string[] = [];

      const pipeline = new MiddlewarePipeline(
        [
          makeMiddleware({ name: 'second', order: 20, beforeIteration: async (): Promise<ControlAction> => { order.push('second'); return 'continue'; } }),
          makeMiddleware({ name: 'first',  order: 10, beforeIteration: async (): Promise<ControlAction> => { order.push('first');  return 'continue'; } }),
          makeMiddleware({ name: 'third',  order: 30, beforeIteration: async (): Promise<ControlAction> => { order.push('third');  return 'continue'; } }),
        ],
        { featureFlags: defaultFlags },
      );

      await pipeline.beforeIteration(makeCtx());
      expect(order).toEqual(['first', 'second', 'third']);
    });

    it('runs after-hooks in descending order', async () => {
      const order: string[] = [];

      const pipeline = new MiddlewarePipeline(
        [
          makeMiddleware({ name: 'first',  order: 10, afterIteration: async () => { order.push('first'); } }),
          makeMiddleware({ name: 'second', order: 20, afterIteration: async () => { order.push('second'); } }),
          makeMiddleware({ name: 'third',  order: 30, afterIteration: async () => { order.push('third'); } }),
        ],
        { featureFlags: defaultFlags },
      );

      await pipeline.afterIteration(makeCtx());
      expect(order).toEqual(['third', 'second', 'first']);
    });
  });

  describe('enabled() gating', () => {
    it('skips middleware when enabled() returns false', async () => {
      const called = vi.fn();

      const pipeline = new MiddlewarePipeline(
        [makeMiddleware({ name: 'gated', order: 10, enabled: () => false, onStart: async () => { called(); } })],
        { featureFlags: defaultFlags },
      );

      await pipeline.onStart(makeCtx());
      expect(called).not.toHaveBeenCalled();
    });

    it('runs middleware when enabled() returns true', async () => {
      const called = vi.fn();

      const pipeline = new MiddlewarePipeline(
        [makeMiddleware({ name: 'gated', order: 10, enabled: () => true, onStart: async () => { called(); } })],
        { featureFlags: defaultFlags },
      );

      await pipeline.onStart(makeCtx());
      expect(called).toHaveBeenCalledOnce();
    });
  });

  describe('fail-open policy', () => {
    it('continues pipeline when middleware throws with fail-open', async () => {
      const secondCalled = vi.fn();
      const onError = vi.fn();

      const pipeline = new MiddlewarePipeline(
        [
          makeMiddleware({ name: 'crasher',  order: 10, config: { failPolicy: 'fail-open' }, beforeIteration: async () => { throw new Error('boom'); } }),
          makeMiddleware({ name: 'survivor', order: 20, beforeIteration: async (): Promise<ControlAction> => { secondCalled(); return 'continue'; } }),
        ],
        { featureFlags: defaultFlags, onError },
      );

      const result = await pipeline.beforeIteration(makeCtx());
      expect(result).toBe('continue');
      expect(secondCalled).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith('crasher', 'beforeIteration', expect.any(Error));
    });
  });

  describe('fail-closed policy', () => {
    it('stops pipeline when middleware throws with fail-closed', async () => {
      const secondCalled = vi.fn();

      const pipeline = new MiddlewarePipeline(
        [
          makeMiddleware({ name: 'critical',     order: 10, config: { failPolicy: 'fail-closed' }, beforeIteration: async () => { throw new Error('critical failure'); } }),
          makeMiddleware({ name: 'never-reached', order: 20, beforeIteration: async (): Promise<ControlAction> => { secondCalled(); return 'continue'; } }),
        ],
        { featureFlags: defaultFlags },
      );

      await expect(pipeline.beforeIteration(makeCtx())).rejects.toThrow('critical failure');
      expect(secondCalled).not.toHaveBeenCalled();
    });
  });

  describe('timeout enforcement', () => {
    it('times out slow middleware with fail-open', async () => {
      const onError = vi.fn();

      const pipeline = new MiddlewarePipeline(
        [makeMiddleware({ name: 'slow', order: 10, config: { failPolicy: 'fail-open', timeoutMs: 50 }, beforeIteration: async (): Promise<ControlAction> => { await new Promise((r) => { setTimeout(r, 200); }); return 'stop'; } })],
        { featureFlags: defaultFlags, onError },
      );

      const result = await pipeline.beforeIteration(makeCtx());
      expect(result).toBe('continue');
      expect(onError).toHaveBeenCalledWith('slow', 'beforeIteration', expect.any(Error));
    });

    it('times out slow middleware with fail-closed', async () => {
      const pipeline = new MiddlewarePipeline(
        [makeMiddleware({ name: 'slow-critical', order: 10, config: { failPolicy: 'fail-closed', timeoutMs: 50 }, beforeIteration: async (): Promise<ControlAction> => { await new Promise((r) => { setTimeout(r, 200); }); return 'continue'; } })],
        { featureFlags: defaultFlags },
      );

      await expect(pipeline.beforeIteration(makeCtx())).rejects.toThrow(/timed out/);
    });
  });

  describe('beforeIteration — ControlAction', () => {
    it('returns first non-continue action', async () => {
      const pipeline = new MiddlewarePipeline(
        [
          makeMiddleware({ name: 'ok',           order: 10, beforeIteration: async (): Promise<ControlAction> => 'continue' }),
          makeMiddleware({ name: 'stopper',       order: 20, beforeIteration: async (): Promise<ControlAction> => 'stop' }),
          makeMiddleware({ name: 'never-reached', order: 30, beforeIteration: async (): Promise<ControlAction> => 'escalate' }),
        ],
        { featureFlags: defaultFlags },
      );

      expect(await pipeline.beforeIteration(makeCtx())).toBe('stop');
    });

    it('returns escalate action', async () => {
      const pipeline = new MiddlewarePipeline(
        [makeMiddleware({ name: 'escalator', order: 10, beforeIteration: async (): Promise<ControlAction> => 'escalate' })],
        { featureFlags: defaultFlags },
      );

      expect(await pipeline.beforeIteration(makeCtx())).toBe('escalate');
    });
  });

  describe('beforeLLMCall — LLMCallPatch merging', () => {
    it('merges patches from multiple middlewares', async () => {
      const pipeline = new MiddlewarePipeline(
        [
          makeMiddleware({ name: 'temp-setter', order: 10, beforeLLMCall: async () => ({ temperature: 0.2 }) }),
          makeMiddleware({ name: 'msg-adder',   order: 20, beforeLLMCall: async (ctx) => ({ messages: [...ctx.messages, { role: 'system' as const, content: 'injected' }] }) }),
        ],
        { featureFlags: defaultFlags },
      );

      const patch = await pipeline.beforeLLMCall(makeLLMCtx());
      expect(patch.temperature).toBe(0.2);
      expect(patch.messages).toHaveLength(2);
      expect(patch.messages?.[1]?.content).toBe('injected');
    });

    it('returns empty patch when no middleware modifies', async () => {
      const pipeline = new MiddlewarePipeline(
        [makeMiddleware({ name: 'noop', order: 10 })],
        { featureFlags: defaultFlags },
      );

      const patch = await pipeline.beforeLLMCall(makeLLMCtx());
      expect(patch).toEqual({});
    });
  });

  describe('beforeToolExec — skip gate', () => {
    it('returns skip if any middleware says skip', async () => {
      const pipeline = new MiddlewarePipeline(
        [
          makeMiddleware({ name: 'allow', order: 10, beforeToolExec: async (): Promise<'execute' | 'skip'> => 'execute' }),
          makeMiddleware({ name: 'deny',  order: 20, beforeToolExec: async (): Promise<'execute' | 'skip'> => 'skip' }),
        ],
        { featureFlags: defaultFlags },
      );

      expect(await pipeline.beforeToolExec(makeToolCtx())).toBe('skip');
    });

    it('returns execute if all allow', async () => {
      const pipeline = new MiddlewarePipeline(
        [
          makeMiddleware({ name: 'allow-1', order: 10, beforeToolExec: async (): Promise<'execute' | 'skip'> => 'execute' }),
          makeMiddleware({ name: 'allow-2', order: 20, beforeToolExec: async (): Promise<'execute' | 'skip'> => 'execute' }),
        ],
        { featureFlags: defaultFlags },
      );

      expect(await pipeline.beforeToolExec(makeToolCtx())).toBe('execute');
    });
  });

  describe('afterToolExec', () => {
    it('calls all middlewares afterToolExec in descending order', async () => {
      const order: string[] = [];

      const pipeline = new MiddlewarePipeline(
        [
          makeMiddleware({ name: 'first',  order: 10, afterToolExec: async () => { order.push('first'); } }),
          makeMiddleware({ name: 'second', order: 20, afterToolExec: async () => { order.push('second'); } }),
        ],
        { featureFlags: defaultFlags },
      );

      await pipeline.afterToolExec(makeToolCtx(), makeToolOutput());
      expect(order).toEqual(['second', 'first']);
    });
  });

  describe('onStop', () => {
    it('calls all middlewares onStop in descending order', async () => {
      const stopped: string[] = [];

      const pipeline = new MiddlewarePipeline(
        [
          makeMiddleware({ name: 'a', order: 10, onStop: async (_ctx, r) => { stopped.push(`a:${r}`); } }),
          makeMiddleware({ name: 'b', order: 20, onStop: async (_ctx, r) => { stopped.push(`b:${r}`); } }),
        ],
        { featureFlags: defaultFlags },
      );

      await pipeline.onStop(makeCtx(), 'report_complete');
      // descending: b first, then a
      expect(stopped).toEqual(['b:report_complete', 'a:report_complete']);
    });
  });
});
