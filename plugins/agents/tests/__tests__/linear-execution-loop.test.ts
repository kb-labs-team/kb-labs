import { describe, it, expect, vi } from 'vitest';
import { LinearExecutionLoop } from '../../src/core/execution/linear-execution-loop.js';
import type { LoopContext, LLMCallResult, ToolOutput, LoopResult, ToolCallInput } from '@kb-labs/agents/sdk';
import type { RunContext, ControlAction } from '@kb-labs/agents/sdk';
import type { RunEvaluation } from '@kb-labs/agents/contracts';

/** Narrow LoopResult to the 'complete' variant for easy field access in tests. */
function asComplete(r: LoopResult) {
  if (r.outcome !== 'complete') { throw new Error(`Expected outcome 'complete', got '${r.outcome}'`); }
  return r;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMeta() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: vi.fn(<T>(ns: string, key: string): T | undefined => store.get(ns)?.get(key) as T | undefined),
    set: vi.fn((ns: string, key: string, value: unknown) => {
      if (!store.has(ns)) {store.set(ns, new Map());}
      store.get(ns)!.set(key, value);
    }),
    getNamespace: vi.fn((ns: string) => Object.fromEntries(store.get(ns) ?? new Map())),
    _store: store,
  };
}

function makeRunCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    task: 'test task',
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

function makeLLMResponse(overrides: Partial<LLMCallResult> = {}): LLMCallResult {
  return {
    content: '',
    toolCalls: [],
    ...overrides,
  };
}

function makeCtx(runCtx: RunContext, llmResponses: LLMCallResult[]): LoopContext {
  let callIndex = 0;
  return {
    run: runCtx,
    beforeIteration: vi.fn(async (): Promise<ControlAction> => 'continue'),
    afterIteration: vi.fn(async (): Promise<void> => {}),
    appendMessage: vi.fn(),
    callLLM: vi.fn(async () => {
      const r = llmResponses[callIndex];
      callIndex++;
      return r ?? makeLLMResponse();
    }),
    executeTools: vi.fn(async (): Promise<ToolOutput[]> => []),
    evaluateRun: vi.fn(async () => null),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LinearExecutionLoop', () => {
  const loop = new LinearExecutionLoop();

  describe('report tool', () => {
    it('stops on report tool call', async () => {
      const run = makeRunCtx();
      const ctx = makeCtx(run, [
        makeLLMResponse({
          toolCalls: [{ id: 'tc-1', name: 'report', input: { answer: 'Task complete!' } }],
        }),
      ]);

      const result = await loop.run(ctx);

      expect(result.outcome).toBe('complete');
      expect(asComplete(result).result.answer).toBe('Task complete!');
      expect(asComplete(result).result.reasonCode).toBe('report_complete');
      expect(asComplete(result).result.success).toBe(true);
    });

    it('report wins over other tool calls in same response', async () => {
      const run = makeRunCtx();
      const ctx = makeCtx(run, [
        makeLLMResponse({
          content: 'fallback',
          toolCalls: [
            { id: 'tc-1', name: 'fs_read', input: { path: '/tmp/a' } },
            { id: 'tc-2', name: 'report', input: { answer: 'Done' } },
          ],
        }),
      ]);

      const result = await loop.run(ctx);
      expect(asComplete(result).result.reasonCode).toBe('report_complete');
      expect(asComplete(result).result.answer).toBe('Done');
    });
  });

  describe('no tool calls', () => {
    it('stops naturally when LLM returns no tool calls', async () => {
      const run = makeRunCtx();
      const ctx = makeCtx(run, [
        makeLLMResponse({ content: 'Here is the answer', toolCalls: [] }),
      ]);

      const result = await loop.run(ctx);

      expect(result.outcome).toBe('complete');
      expect(asComplete(result).result.reasonCode).toBe('no_tool_calls');
      expect(asComplete(result).result.answer).toBe('Here is the answer');
      expect(asComplete(result).result.success).toBe(true);
    });

    it('does not complete when forced report after nudge is blocked', async () => {
      const run = makeRunCtx({ maxIterations: 3 });
      const executeTools = vi.fn(async (calls: ToolCallInput[]): Promise<ToolOutput[]> => {
        const reportCall = calls.find((call) => call.name === 'report');
        if (reportCall) {
          return [{
            toolCallId: reportCall.id,
            output: 'BLOCKED: persist correction first',
            success: false,
            error: 'PENDING_MEMORY_COMMIT',
          }];
        }
        return [];
      });
      const ctx: LoopContext = {
        run,
        beforeIteration: vi.fn(async (): Promise<ControlAction> => 'continue'),
        afterIteration: vi.fn(async (): Promise<void> => {}),
        appendMessage: vi.fn(),
        callLLM: vi.fn(async () => {
          const callCount = (ctx.callLLM as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
          if (callCount === 1) {
            return makeLLMResponse({ content: 'Plain text answer', toolCalls: [] });
          }
          if (callCount === 2) {
            return makeLLMResponse({
              toolCalls: [{ id: 'tc-report-blocked', name: 'report', input: { answer: 'Plain text answer' } }],
            });
          }
          return makeLLMResponse({
            toolCalls: [{ id: 'tc-report-final', name: 'report', input: { answer: 'Committed and done' } }],
          });
        }),
        executeTools,
        evaluateRun: vi.fn(async () => null),
      };

      executeTools.mockImplementationOnce(async (): Promise<ToolOutput[]> => [{
        toolCallId: 'tc-report-blocked',
        output: 'BLOCKED: persist correction first',
        success: false,
        error: 'PENDING_MEMORY_COMMIT',
      }]);
      executeTools.mockImplementationOnce(async (): Promise<ToolOutput[]> => [{
        toolCallId: 'tc-report-final',
        output: '',
        success: true,
      }]);

      const result = await loop.run(ctx);

      expect(result.outcome).toBe('complete');
      expect(asComplete(result).result.reasonCode).toBe('report_complete');
      expect(asComplete(result).result.answer).toBe('Committed and done');
      expect(ctx.callLLM).toHaveBeenCalledTimes(3);
      expect(ctx.appendMessage).toHaveBeenCalledTimes(1);
      expect(executeTools).toHaveBeenCalledTimes(2);
    });
  });

  describe('abort', () => {
    it('stops immediately when abort signal is fired', async () => {
      const controller = new AbortController();
      const run = makeRunCtx({ abortSignal: controller.signal });
      controller.abort();

      const ctx = makeCtx(run, [makeLLMResponse()]);
      const result = await loop.run(ctx);

      expect(asComplete(result).result.reasonCode).toBe('abort_signal');
      expect(ctx.callLLM).not.toHaveBeenCalled();
    });

    it('stops when run.aborted is set', async () => {
      const run = makeRunCtx({ aborted: true });
      const ctx = makeCtx(run, [makeLLMResponse()]);
      const result = await loop.run(ctx);

      expect(asComplete(result).result.reasonCode).toBe('abort_signal');
    });
  });

  describe('hard budget', () => {
    it('stops when BudgetMiddleware sets budget.exhausted in meta', async () => {
      const run = makeRunCtx();
      // Simulate BudgetMiddleware setting meta before first iteration
      run.meta.set('budget', 'exhausted', true);
      run.meta.set('budget', 'exhaustedReason', 'Token hard limit: 95000/95000');

      const ctx = makeCtx(run, [makeLLMResponse()]);
      const result = await loop.run(ctx);

      expect(asComplete(result).result.reasonCode).toBe('hard_budget');
      expect(asComplete(result).result.answer).toContain('Token hard limit');
      expect(ctx.callLLM).not.toHaveBeenCalled();
    });
  });

  describe('max iterations', () => {
    it('stops at maxIterations', async () => {
      const run = makeRunCtx({ maxIterations: 3 });
      // Always return a tool call — never completes naturally
      const ctx = makeCtx(run, [
        makeLLMResponse({ content: 'still working', toolCalls: [{ id: 'tc-1', name: 'fs_read', input: {} }] }),
        makeLLMResponse({ content: 'still working', toolCalls: [{ id: 'tc-2', name: 'fs_read', input: {} }] }),
        makeLLMResponse({ content: 'last attempt', toolCalls: [{ id: 'tc-3', name: 'fs_write', input: {} }] }),
      ]);

      const result = await loop.run(ctx);

      expect(result.outcome).toBe('complete');
      expect(asComplete(result).result.reasonCode).toBe('max_iterations');
      expect(asComplete(result).result.answer).toContain('Maximum iterations reached');
      expect(ctx.callLLM).toHaveBeenCalledTimes(3);
    });
  });

  describe('loop detection', () => {
    it('stops early when same intent repeats without new evidence', async () => {
      const run = makeRunCtx({ maxIterations: 10 });
      const same = makeLLMResponse({
        toolCalls: [{ id: 'tc-1', name: 'grep_search', input: { pattern: 'foo' } }],
      });
      const ctx = makeCtx(run, [same, same, same, same]);

      const result = await loop.run(ctx);

      expect(result.outcome).toBe('complete');
      expect(asComplete(result).result.reasonCode).toBe('repeated_without_progress');
      expect(asComplete(result).result.answer).toContain('without collecting new evidence');
    });

    it('detects repeated tool call pattern', async () => {
      const run = makeRunCtx({ maxIterations: 20 });
      // Same 3 tool calls repeated twice = 6 iterations
      const repeatingCall = (idx: number) =>
        makeLLMResponse({ toolCalls: [{ id: `tc-${idx}`, name: `tool_${idx % 3}`, input: { key: 'val' } }] });

      const responses = Array.from({ length: 8 }, (_, i) => repeatingCall(i));
      const ctx = makeCtx(run, responses);

      const result = await loop.run(ctx);

      expect(result.outcome).toBe('complete');
      expect(asComplete(result).result.reasonCode).toBe('loop_detected');
      expect(asComplete(result).result.answer).toContain('loop');
    });
  });

  describe('LLM error', () => {
    it('returns failure on LLM call error', async () => {
      const run = makeRunCtx();
      const ctx: LoopContext = {
        run,
        beforeIteration: vi.fn(async (): Promise<ControlAction> => 'continue'),
        afterIteration: vi.fn(async (): Promise<void> => {}),
        appendMessage: vi.fn(),
        callLLM: vi.fn(async () => { throw new Error('Rate limit exceeded'); }),
        executeTools: vi.fn(async () => []),
        evaluateRun: vi.fn(async () => null),
      };

      const result = await loop.run(ctx);

      expect(result.outcome).toBe('complete');
      expect(asComplete(result).result.reasonCode).toBe('error');
      expect(asComplete(result).result.success).toBe(false);
      expect(asComplete(result).result.answer).toContain('Rate limit exceeded');
    });
  });

  describe('token tracking', () => {
    it('accumulates tokens and stores in meta', async () => {
      const run = makeRunCtx();
      const ctx = makeCtx(run, [
        makeLLMResponse({
          content: 'done',
          toolCalls: [],
          usage: { promptTokens: 100, completionTokens: 50 },
        }),
      ]);

      await loop.run(ctx);

      expect(run.meta.set).toHaveBeenCalledWith('loop', 'totalTokens', 150);
    });
  });

  describe('iteration counter', () => {
    it('increments run.iteration each iteration', async () => {
      const run = makeRunCtx({ maxIterations: 3 });
      const iterations: number[] = [];

      const ctx: LoopContext = {
        run,
        beforeIteration: vi.fn(async (): Promise<ControlAction> => 'continue'),
        afterIteration: vi.fn(async (): Promise<void> => {}),
        appendMessage: vi.fn(),
        callLLM: vi.fn(async () => {
          iterations.push(run.iteration);
          // Stop after 2 iterations via report
          if (run.iteration >= 2) {
            return makeLLMResponse({ toolCalls: [{ id: 'tc', name: 'report', input: { answer: 'done' } }] });
          }
          return makeLLMResponse({ toolCalls: [{ id: 'tc', name: 'fs_read', input: {} }] });
        }),
        executeTools: vi.fn(async () => []),
        evaluateRun: vi.fn(async () => null),
      };

      await loop.run(ctx);

      expect(iterations).toEqual([1, 2]);
    });
  });

  describe('run evaluation', () => {
    it('stores evaluation output in run meta', async () => {
      const run = makeRunCtx({ maxIterations: 2 });
      const ctx = makeCtx(run, [
        makeLLMResponse({ toolCalls: [{ id: 'tc-1', name: 'fs_read', input: { path: '/tmp/a.ts' } }] }),
        makeLLMResponse({ toolCalls: [{ id: 'tc-2', name: 'report', input: { answer: 'done' } }] }),
      ]);

      run.meta.set('files', 'read', ['/tmp/a.ts']);
      ctx.evaluateRun = vi.fn(async () => ({
        evidenceGain: 0.45,
        readinessScore: 0.6,
        repeatedStrategy: false,
        recommendation: 'continue' as const,
        rationale: 'Still gaining useful evidence.',
      } satisfies RunEvaluation));

      await loop.run(ctx);

      expect(run.meta.set).toHaveBeenCalledWith('evaluation', 'lastRecommendation', 'continue');
      expect(run.meta.set).toHaveBeenCalledWith('evaluation', 'lastReadinessScore', 0.6);
      expect(run.meta.set).toHaveBeenCalledWith('evaluation', 'lastEvidenceGain', 0.45);
    });

    it('nudges synthesis when evaluator says evidence gain has flattened', async () => {
      const run = makeRunCtx({ maxIterations: 3 });
      const ctx: LoopContext = {
        run,
        beforeIteration: vi.fn(async (): Promise<ControlAction> => 'continue'),
        afterIteration: vi.fn(async (): Promise<void> => {}),
        appendMessage: vi.fn(),
        callLLM: vi.fn(async () => {
          const callCount = (ctx.callLLM as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
          if (callCount === 1) {
            return makeLLMResponse({ toolCalls: [{ id: 'tc-1', name: 'fs_read', input: { path: '/tmp/a.ts' } }] });
          }
          return makeLLMResponse({ toolCalls: [{ id: 'tc-report', name: 'report', input: { answer: 'bounded answer' } }] });
        }),
        executeTools: vi.fn(async (calls: ToolCallInput[]): Promise<ToolOutput[]> => calls.map((call) => ({
          toolCallId: call.id,
          output: '',
          success: true,
        }))),
        evaluateRun: vi.fn(async () => ({
          evidenceGain: 0.1,
          readinessScore: 0.82,
          repeatedStrategy: true,
          recommendation: 'synthesize' as const,
          rationale: 'Enough evidence collected.',
        } satisfies RunEvaluation)),
      };

      run.meta.set('files', 'read', ['/tmp/a.ts']);
      const result = await loop.run(ctx);

      expect(asComplete(result).result.reasonCode).toBe('report_complete');
      expect(asComplete(result).result.answer).toBe('bounded answer');
      expect(ctx.appendMessage).toHaveBeenCalledWith(expect.objectContaining({
        role: 'system',
      }));
    });
  });
});
