import { describe, expect, it, vi } from 'vitest';
import type { LoopContext, LLMCallResult, RunContext, ToolOutput } from '@kb-labs/agents/sdk';
import { BudgetMiddleware } from '../../../src/core/middleware/builtin/budget-middleware.js';
import { LinearExecutionLoop } from '../../../src/core/execution/linear-execution-loop.js';

describe('agent hard token budget at the provider boundary', () => {
  // case: S-299.5
  it('allows one response to overshoot, then stops before another provider request', async () => {
    let tokensUsed = 0;
    const provider = {
      chatWithTools: vi.fn(async () => ({
        content: 'Continue with one read-only step.',
        toolCalls: [{ id: 'call-1', name: 'fs_read', input: { path: 'README.md' } }],
        usage: { promptTokens: 120, completionTokens: 0 },
      })),
    };
    const run = {
      task: 'inspect only',
      tier: 'small',
      messages: [],
      tools: [],
      iteration: 0,
      maxIterations: 3,
      aborted: false,
      abortSignal: new AbortController().signal,
      requestId: 'budget-test',
      meta: {
        get: vi.fn((namespace: string, key: string) => values.get(namespace)?.get(key)),
        set: vi.fn((namespace: string, key: string, value: unknown) => {
          if (!values.has(namespace)) { values.set(namespace, new Map()); }
          values.get(namespace)!.set(key, value);
        }),
      },
      eventBus: { emit: vi.fn() },
    } as unknown as RunContext;
    const values = new Map<string, Map<string, unknown>>();
    const budget = new BudgetMiddleware({
      active: true,
      maxTokens: 100,
      softLimitRatio: 0.8,
      hardLimitRatio: 1,
      hardStop: false,
      forceSynthesisOnHardLimit: true,
    }, () => tokensUsed);

    const context: LoopContext = {
      run,
      beforeIteration: vi.fn(async () => budget.beforeIteration(run)),
      afterIteration: vi.fn(async () => {}),
      appendMessage: vi.fn(),
      callLLM: vi.fn(async (): Promise<LLMCallResult> => {
        const response = await provider.chatWithTools();
        tokensUsed += response.usage.promptTokens + response.usage.completionTokens;
        return response;
      }),
      executeTools: vi.fn(async (): Promise<ToolOutput[]> => []),
      evaluateRun: vi.fn(async () => null),
    };

    const result = await new LinearExecutionLoop().run(context);
    if (result.outcome !== 'complete') { throw new Error(`Expected complete result, got ${result.outcome}`); }

    expect(provider.chatWithTools).toHaveBeenCalledTimes(1);
    expect(context.executeTools).toHaveBeenCalledTimes(1);
    expect(tokensUsed).toBe(120);
    expect(result.result.reasonCode).toBe('hard_budget');
    expect(run.meta.get('budget', 'exhausted')).toBe(true);
  });
});
