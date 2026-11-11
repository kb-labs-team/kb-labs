import { describe, it, expect, vi } from 'vitest';
import { ExecutionLoop } from '../../src/core/execution/loop.js';
import type { LoopContext, IterationContext, LoopLLMResponse } from '../../src/core/execution/loop.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

type SimpleResult = { summary: string; code: string; iteration: number };

function makeResult(answer: string, ctx: IterationContext, code: string): SimpleResult {
  return { summary: answer, code, iteration: ctx.iteration };
}

/** Returns a LoopContext stub with sensible defaults that can be overridden. */
function makeCtx(overrides: Partial<LoopContext<SimpleResult>> = {}): LoopContext<SimpleResult> {
  return {
    maxIterations: 5,
    callLLM: vi.fn(async (): Promise<LoopLLMResponse> => ({ content: '', toolCalls: [] })),
    executeTools: vi.fn(async () => []),
    buildResult: vi.fn(async (answer, ctx, code) => makeResult(answer, ctx, code)),
    isAborted: vi.fn(() => false),
    extractReportAnswer: vi.fn(() => undefined),
    detectLoop: vi.fn(() => undefined),
    evaluateEscalation: vi.fn(() => null),
    checkHardTokenLimit: vi.fn(() => undefined),
    extendBudget: vi.fn((ctx) => ctx.maxIterations),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ExecutionLoop', () => {
  describe('natural stop (no tool calls)', () => {
    it('returns complete when LLM responds with no tool calls', async () => {
      const ctx = makeCtx({
        callLLM: vi.fn(async () => ({ content: 'The answer is 42', toolCalls: [] })),
      });
      const loop = new ExecutionLoop(ctx);
      const result = await loop.run();

      expect(result.outcome).toBe('complete');
      if (result.outcome === 'complete') {
        expect(result.result.code).toBe('no_tool_calls');
        expect(result.result.summary).toBe('The answer is 42');
        expect(result.result.iteration).toBe(1);
      }
    });

    it('runs multiple iterations before natural stop', async () => {
      let callCount = 0;
      const ctx = makeCtx({
        callLLM: vi.fn(async (): Promise<LoopLLMResponse> => {
          callCount++;
          if (callCount < 3) {
            return { content: '', toolCalls: [{ id: 'tc1', name: 'search', input: {} }] };
          }
          return { content: 'Done after 3 iterations' };
        }),
        executeTools: vi.fn(async () => [{ toolCallId: 'tc1', output: 'result' }]),
      });
      const loop = new ExecutionLoop(ctx);
      const result = await loop.run();

      expect(result.outcome).toBe('complete');
      if (result.outcome === 'complete') {
        expect(result.result.code).toBe('no_tool_calls');
        expect(result.result.iteration).toBe(3);
      }
    });
  });

  describe('report tool', () => {
    it('stops immediately when report tool is present (even at iteration 1)', async () => {
      const ctx = makeCtx({
        callLLM: vi.fn(async (): Promise<LoopLLMResponse> => ({
          content: '',
          toolCalls: [{ id: 'r1', name: 'report', input: { answer: 'task complete' } }],
        })),
        extractReportAnswer: vi.fn(() => 'task complete'),
      });
      const loop = new ExecutionLoop(ctx);
      const result = await loop.run();

      expect(result.outcome).toBe('complete');
      if (result.outcome === 'complete') {
        expect(result.result.code).toBe('report_complete');
        expect(result.result.summary).toBe('task complete');
        expect(result.result.iteration).toBe(1);
      }
    });

    it('report takes priority over max iterations on last iteration', async () => {
      // Last iteration with both report and maxIterations firing — report wins
      const ctx = makeCtx({
        maxIterations: 1,
        callLLM: vi.fn(async (): Promise<LoopLLMResponse> => ({
          content: '',
          toolCalls: [{ id: 'r1', name: 'report', input: { answer: 'found it' } }],
        })),
        extractReportAnswer: vi.fn(() => 'found it'),
      });
      const loop = new ExecutionLoop(ctx);
      const result = await loop.run();

      expect(result.outcome).toBe('complete');
      if (result.outcome === 'complete') {
        // REPORT_COMPLETE (priority 1) beats MAX_ITERATIONS (priority 3)
        expect(result.result.code).toBe('report_complete');
        expect(result.result.summary).toBe('found it');
      }
    });
  });

  describe('abort signal', () => {
    it('stops immediately on abort', async () => {
      const ctx = makeCtx({
        isAborted: vi.fn(() => true),
      });
      const loop = new ExecutionLoop(ctx);
      const result = await loop.run();

      expect(result.outcome).toBe('complete');
      if (result.outcome === 'complete') {
        expect(result.result.code).toBe('abort_signal');
      }
      // LLM should not be called at all
      expect(ctx.callLLM).not.toHaveBeenCalled();
    });

    it('respects abort signal mid-loop (on next iteration)', async () => {
      let iteration = 0;
      const ctx = makeCtx({
        callLLM: vi.fn(async (): Promise<LoopLLMResponse> => ({
          content: '',
          toolCalls: [{ id: 'tc', name: 'tool', input: {} }],
        })),
        executeTools: vi.fn(async () => [{ toolCallId: 'tc', output: 'ok' }]),
        isAborted: vi.fn(() => {
          iteration++;
          return iteration >= 2; // aborted from iteration 2 onward
        }),
        extendBudget: vi.fn((ctx) => ctx.maxIterations),
      });
      const loop = new ExecutionLoop(ctx);
      const result = await loop.run();

      expect(result.outcome).toBe('complete');
      if (result.outcome === 'complete') {
        expect(result.result.code).toBe('abort_signal');
      }
    });
  });

  describe('hard token limit', () => {
    it('stops before LLM call when limit is exceeded', async () => {
      const ctx = makeCtx({
        checkHardTokenLimit: vi.fn(() => 'Token hard limit exceeded: 50000/50000'),
      });
      const loop = new ExecutionLoop(ctx);
      const result = await loop.run();

      expect(result.outcome).toBe('complete');
      if (result.outcome === 'complete') {
        expect(result.result.code).toBe('hard_token_limit');
      }
      expect(ctx.callLLM).not.toHaveBeenCalled();
    });
  });

  describe('max iterations', () => {
    it('returns complete with max_iterations after exhausting budget', async () => {
      const ctx = makeCtx({
        maxIterations: 3,
        callLLM: vi.fn(async (): Promise<LoopLLMResponse> => ({
          content: '',
          toolCalls: [{ id: 'tc', name: 'search', input: {} }],
        })),
        executeTools: vi.fn(async () => [{ toolCallId: 'tc', output: 'result' }]),
      });
      const loop = new ExecutionLoop(ctx);
      const result = await loop.run();

      expect(result.outcome).toBe('complete');
      if (result.outcome === 'complete') {
        expect(result.result.code).toBe('max_iterations');
      }
      expect(ctx.callLLM).toHaveBeenCalledTimes(3);
    });
  });

  describe('loop detection', () => {
    it('stops with loop_detected when detectLoop returns a reason', async () => {
      let callCount = 0;
      const ctx = makeCtx({
        callLLM: vi.fn(async (): Promise<LoopLLMResponse> => ({
          content: '',
          toolCalls: [{ id: 'tc', name: 'search', input: { q: 'same' } }],
        })),
        executeTools: vi.fn(async () => [{ toolCallId: 'tc', output: 'no results' }]),
        detectLoop: vi.fn(() => {
          callCount++;
          return callCount >= 3 ? 'Same tool repeated 3x' : undefined;
        }),
      });
      const loop = new ExecutionLoop(ctx);
      const result = await loop.run();

      expect(result.outcome).toBe('complete');
      if (result.outcome === 'complete') {
        expect(result.result.code).toBe('loop_detected');
      }
    });
  });

  describe('tier escalation', () => {
    it('returns escalate when evaluateEscalation says shouldEscalate', async () => {
      const ctx = makeCtx({
        callLLM: vi.fn(async (): Promise<LoopLLMResponse> => ({
          content: '',
          toolCalls: [{ id: 'tc', name: 'search', input: {} }],
        })),
        executeTools: vi.fn(async () => [{ toolCallId: 'tc', output: 'result' }]),
        evaluateEscalation: vi.fn(() => ({
          shouldEscalate: true,
          reason: 'complexity_detected',
        })),
      });
      const loop = new ExecutionLoop(ctx);
      const result = await loop.run();

      expect(result.outcome).toBe('escalate');
      if (result.outcome === 'escalate') {
        expect(result.reason).toBe('complexity_detected');
      }
    });

    it('does not escalate when evaluateEscalation returns null', async () => {
      const ctx = makeCtx({
        callLLM: vi.fn(async (): Promise<LoopLLMResponse> => ({ content: 'done' })),
        evaluateEscalation: vi.fn(() => null),
      });
      const loop = new ExecutionLoop(ctx);
      const result = await loop.run();

      expect(result.outcome).toBe('complete');
    });
  });

  describe('budget extension', () => {
    it('extends budget when extendBudget returns higher value', async () => {
      let extended = false;
      const callLog: number[] = [];

      const ctx = makeCtx({
        maxIterations: 2,
        callLLM: vi.fn(async (iterCtx): Promise<LoopLLMResponse> => {
          callLog.push(iterCtx.iteration);
          // Stop naturally after iteration 4
          if (iterCtx.iteration >= 4) {return { content: 'done' };}
          return { content: '', toolCalls: [{ id: 'tc', name: 'search', input: {} }] };
        }),
        executeTools: vi.fn(async () => [{ toolCallId: 'tc', output: 'progress!' }]),
        extendBudget: vi.fn((ctx) => {
          if (!extended && ctx.iteration === 2) {
            extended = true;
            return 4; // Extend from 2 to 4
          }
          return ctx.maxIterations;
        }),
      });

      const loop = new ExecutionLoop(ctx);
      const result = await loop.run();

      expect(result.outcome).toBe('complete');
      expect(callLog).toEqual([1, 2, 3, 4]); // Loop ran 4 iterations
    });
  });

  describe('error handling', () => {
    it('catches LLM errors and returns complete with error code', async () => {
      const ctx = makeCtx({
        callLLM: vi.fn(async () => {
          throw new Error('Network timeout');
        }),
      });
      const loop = new ExecutionLoop(ctx);
      const result = await loop.run();

      expect(result.outcome).toBe('complete');
      if (result.outcome === 'complete') {
        expect(result.result.code).toBe('iteration_error');
        expect(result.result.summary).toContain('Network timeout');
      }
    });

    it('catches tool execution errors without crashing the loop', async () => {
      const ctx = makeCtx({
        callLLM: vi.fn(async (): Promise<LoopLLMResponse> => ({
          content: '',
          toolCalls: [{ id: 'tc', name: 'fs_read', input: { path: '/boom' } }],
        })),
        executeTools: vi.fn(async () => {
          throw new Error('Disk full');
        }),
      });
      const loop = new ExecutionLoop(ctx);
      const result = await loop.run();

      expect(result.outcome).toBe('complete');
      if (result.outcome === 'complete') {
        expect(result.result.code).toBe('iteration_error');
      }
    });
  });

  describe('hooks (onIterationStart, onIterationEnd, onStop)', () => {
    it('calls onIterationStart and onIterationEnd for each iteration', async () => {
      const starts: number[] = [];
      const ends: number[] = [];
      const ctx = makeCtx({
        maxIterations: 3,
        callLLM: vi.fn(async (c): Promise<LoopLLMResponse> => {
          if (c.iteration < 3) {return { content: '', toolCalls: [{ id: 'tc', name: 's', input: {} }] };}
          return { content: 'done' };
        }),
        executeTools: vi.fn(async () => [{ toolCallId: 'tc', output: 'ok' }]),
        onIterationStart: (ctx) => starts.push(ctx.iteration),
        onIterationEnd: (ctx) => ends.push(ctx.iteration),
      });
      const loop = new ExecutionLoop(ctx);
      await loop.run();

      expect(starts).toEqual([1, 2, 3]);
      expect(ends).toEqual([1, 2, 3]);
    });

    it('calls onStop with the stop condition when stopping', async () => {
      const stopped: string[] = [];
      const ctx = makeCtx({
        callLLM: vi.fn(async (): Promise<LoopLLMResponse> => ({
          content: '',
          toolCalls: [{ id: 'r', name: 'report', input: {} }],
        })),
        extractReportAnswer: vi.fn(() => 'done!'),
        onStop: (cond) => stopped.push(cond.reasonCode),
      });
      const loop = new ExecutionLoop(ctx);
      await loop.run();

      expect(stopped).toEqual(['report_complete']);
    });
  });

  describe('token tracking', () => {
    it('passes accumulated token count to callLLM via totalTokens', async () => {
      const seenTokens: number[] = [];
      let call = 0;
      const ctx = makeCtx({
        callLLM: vi.fn(async (iterCtx): Promise<LoopLLMResponse> => {
          seenTokens.push(iterCtx.totalTokens);
          call++;
          if (call < 3) {
            return {
              content: '',
              toolCalls: [{ id: 'tc', name: 's', input: {} }],
              usage: { promptTokens: 100, completionTokens: 50 },
            };
          }
          return { content: 'done', usage: { promptTokens: 100, completionTokens: 50 } };
        }),
        executeTools: vi.fn(async () => [{ toolCallId: 'tc', output: 'ok' }]),
      });
      const loop = new ExecutionLoop(ctx);
      await loop.run();

      // First call: 0 tokens (none consumed yet)
      expect(seenTokens[0]).toBe(0);
      // Second call: 150 tokens from first response
      expect(seenTokens[1]).toBe(150);
      // Third call: 300 tokens
      expect(seenTokens[2]).toBe(300);
    });
  });
});
