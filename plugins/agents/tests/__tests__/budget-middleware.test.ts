import { describe, it, expect, vi } from 'vitest';
import { BudgetMiddleware, type BudgetPolicy } from '../../src/core/middleware/builtin/budget-middleware.js';
import type { RunContext, LLMCtx } from '@kb-labs/agents/sdk';

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
    eventBus: { emit: vi.fn() },
    ...overrides,
  } as RunContext;
}

function makeLLMCtx(runCtx?: RunContext): LLMCtx {
  return {
    run: runCtx ?? makeRunCtx(),
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
  };
}

const defaultPolicy: BudgetPolicy = {
  active: true,
  maxTokens: 100000,
  softLimitRatio: 0.7,
  hardLimitRatio: 0.95,
  hardStop: true,
  forceSynthesisOnHardLimit: true,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('BudgetMiddleware', () => {
  describe('beforeIteration', () => {
    it('returns continue when under budget', () => {
      const mw = new BudgetMiddleware(defaultPolicy, () => 50000);
      const result = mw.beforeIteration(makeRunCtx());
      expect(result).toBe('continue');
    });

    it('returns stop when hard limit exceeded', () => {
      const mw = new BudgetMiddleware(defaultPolicy, () => 96000);
      const ctx = makeRunCtx();
      const result = mw.beforeIteration(ctx);
      expect(result).toBe('stop');
      expect(ctx.meta.set).toHaveBeenCalledWith('budget', 'exhausted', true);
    });

    it('returns continue when policy inactive', () => {
      const mw = new BudgetMiddleware({ ...defaultPolicy, active: false }, () => 999999);
      const result = mw.beforeIteration(makeRunCtx());
      expect(result).toBe('continue');
    });

    it('sets forceSynthesis meta when forceSynthesisOnHardLimit is true and hardStop is false', () => {
      const policy = { ...defaultPolicy, hardStop: false, forceSynthesisOnHardLimit: true };
      const mw = new BudgetMiddleware(policy, () => 96000);
      const ctx = makeRunCtx();
      const result = mw.beforeIteration(ctx);
      expect(result).toBe('stop');
      expect(ctx.meta.set).toHaveBeenCalledWith('budget', 'forceSynthesis', true);
    });
  });

  describe('beforeLLMCall — convergence nudge', () => {
    it('injects nudge at soft limit', () => {
      const mw = new BudgetMiddleware(defaultPolicy, () => 75000);
      const llmCtx = makeLLMCtx();
      const patch = mw.beforeLLMCall(llmCtx);
      expect(patch).toBeDefined();
      expect(patch?.messages).toHaveLength(2);
      expect(patch?.messages?.[1]?.content).toContain('TOKEN BUDGET');
      expect(mw.convergenceNudgeSent).toBe(true);
    });

    it('does NOT nudge twice', () => {
      const mw = new BudgetMiddleware(defaultPolicy, () => 75000);
      mw.beforeLLMCall(makeLLMCtx());
      const second = mw.beforeLLMCall(makeLLMCtx());
      expect(second).toBeUndefined();
    });

    it('does NOT nudge when under soft limit', () => {
      const mw = new BudgetMiddleware(defaultPolicy, () => 30000);
      const patch = mw.beforeLLMCall(makeLLMCtx());
      expect(patch).toBeUndefined();
    });
  });

  describe('reset', () => {
    it('resets convergence nudge flag', () => {
      const mw = new BudgetMiddleware(defaultPolicy, () => 75000);
      mw.beforeLLMCall(makeLLMCtx());
      expect(mw.convergenceNudgeSent).toBe(true);
      mw.reset();
      expect(mw.convergenceNudgeSent).toBe(false);
    });
  });
});
