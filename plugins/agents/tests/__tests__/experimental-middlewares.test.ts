import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_FEATURE_FLAGS } from '@kb-labs/agents/contracts';
import { SearchSignalMiddleware } from '../../src/core/middleware/builtin/search-signal-middleware.js';
import { TodoSyncMiddleware } from '../../src/core/middleware/builtin/todo-sync-middleware.js';
import { ReflectionMiddleware } from '../../src/core/middleware/builtin/reflection-middleware.js';
import { TaskClassifierMiddleware } from '../../src/core/middleware/builtin/task-classifier-middleware.js';
import type { RunContext, LLMCtx, ToolExecCtx, ToolOutput } from '@kb-labs/agents/sdk';

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

function makeLLMCtx(runCtx?: RunContext): LLMCtx {
  return {
    run: runCtx ?? makeRunCtx(),
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
  };
}

function makeToolCtx(runCtx?: RunContext, toolName = 'grep_search', input: Record<string, unknown> = {}): ToolExecCtx {
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

function makeToolOutput(success = true, output = ''): ToolOutput {
  return { toolCallId: 'tc-1', output, success };
}

// ─── SearchSignalMiddleware ───────────────────────────────────────────────────

describe('SearchSignalMiddleware', () => {
  it('is gated by feature flag', () => {
    const mw = new SearchSignalMiddleware();
    mw.withFeatureFlags({ ...DEFAULT_FEATURE_FLAGS, searchSignal: false });
    expect(mw.enabled()).toBe(false);

    mw.withFeatureFlags({ ...DEFAULT_FEATURE_FLAGS, searchSignal: true });
    expect(mw.enabled()).toBe(true);
  });

  it('tracks search signal hits', () => {
    const onSignalHit = vi.fn();
    const mw = new SearchSignalMiddleware({ onSignalHit });

    const run = makeRunCtx({ iteration: 3 });
    const ctx = makeToolCtx(run, 'grep_search');
    mw.afterToolExec(ctx, makeToolOutput(true, 'Found match in file.ts:10\n' + 'x'.repeat(60)));

    expect(mw.state.searchSignalHits).toBe(1);
    expect(mw.state.lastSignalIteration).toBe(3);
    expect(onSignalHit).toHaveBeenCalledWith('grep_search', 3);
  });

  it('tracks no-result streak', () => {
    const onNoResultStreak = vi.fn();
    const mw = new SearchSignalMiddleware({ onNoResultStreak });

    mw.afterToolExec(makeToolCtx(undefined, 'grep_search'), makeToolOutput(true, ''));
    mw.afterToolExec(makeToolCtx(undefined, 'glob_search'), makeToolOutput(true, 'short'));

    expect(mw.state.noResultStreak).toBe(2);
    expect(onNoResultStreak).toHaveBeenCalledTimes(2);
  });

  it('ignores non-search tools', () => {
    const mw = new SearchSignalMiddleware();
    mw.afterToolExec(makeToolCtx(undefined, 'fs_write'), makeToolOutput(true, 'written successfully' + 'x'.repeat(60)));
    expect(mw.state.searchSignalHits).toBe(0);
  });

  it('resets on stop', () => {
    const mw = new SearchSignalMiddleware();
    mw.afterToolExec(makeToolCtx(undefined, 'grep_search'), makeToolOutput(true, 'x'.repeat(100)));
    expect(mw.state.searchSignalHits).toBe(1);
    mw.onStop();
    expect(mw.state.searchSignalHits).toBe(0);
  });
});

// ─── TodoSyncMiddleware ───────────────────────────────────────────────────────

describe('TodoSyncMiddleware', () => {
  it('is gated by feature flag', () => {
    const mw = new TodoSyncMiddleware();
    mw.withFeatureFlags({ ...DEFAULT_FEATURE_FLAGS, todoSync: false });
    expect(mw.enabled()).toBe(false);

    mw.withFeatureFlags({ ...DEFAULT_FEATURE_FLAGS, todoSync: true });
    expect(mw.enabled()).toBe(true);
  });

  it('injects todo nudge at iteration 2+', () => {
    const onNudge = vi.fn();
    const mw = new TodoSyncMiddleware({ onNudge });

    const patch1 = mw.beforeLLMCall(makeLLMCtx(makeRunCtx({ iteration: 0 })));
    expect(patch1).toBeUndefined();

    const patch2 = mw.beforeLLMCall(makeLLMCtx(makeRunCtx({ iteration: 2 })));
    expect(patch2).toBeDefined();
    expect(patch2?.messages).toHaveLength(2);
    expect(patch2?.messages?.[1]?.content).toContain('todo');
    expect(onNudge).toHaveBeenCalledWith(2);
    expect(mw.nudgeSent).toBe(true);
  });

  it('does not nudge twice', () => {
    const mw = new TodoSyncMiddleware();
    mw.beforeLLMCall(makeLLMCtx(makeRunCtx({ iteration: 2 })));
    const second = mw.beforeLLMCall(makeLLMCtx(makeRunCtx({ iteration: 3 })));
    expect(second).toBeUndefined();
  });

  it('calls onFinalize on stop', () => {
    const onFinalize = vi.fn();
    const mw = new TodoSyncMiddleware({ onFinalize });
    mw.onStop(makeRunCtx(), 'report_complete');
    expect(onFinalize).toHaveBeenCalledWith(true);

    mw.onStop(makeRunCtx(), 'max_iterations');
    expect(onFinalize).toHaveBeenCalledWith(false);
  });
});

// ─── ReflectionMiddleware ─────────────────────────────────────────────────────

describe('ReflectionMiddleware', () => {
  it('is gated by feature flag', () => {
    const mw = new ReflectionMiddleware();
    mw.withFeatureFlags({ ...DEFAULT_FEATURE_FLAGS, reflection: false });
    expect(mw.enabled()).toBe(false);

    mw.withFeatureFlags({ ...DEFAULT_FEATURE_FLAGS, reflection: true });
    expect(mw.enabled()).toBe(true);
  });

  it('triggers reflection after N tool calls', () => {
    const onReflectionNeeded = vi.fn();
    const mw = new ReflectionMiddleware({ onReflectionNeeded }, 3);

    const run = makeRunCtx();
    for (let i = 0; i < 3; i++) {
      mw.afterToolExec(makeToolCtx(run, 'tool'), makeToolOutput(true, 'ok'));
    }

    expect(run.meta.set).toHaveBeenCalledWith('reflection', 'needed', true);
    expect(run.meta.set).toHaveBeenCalledWith('reflection', 'trigger', 'periodic');
    expect(onReflectionNeeded).toHaveBeenCalledWith('periodic', 0);
  });

  it('triggers reflection on high failure rate', () => {
    const onReflectionNeeded = vi.fn();
    const mw = new ReflectionMiddleware({ onReflectionNeeded }, 10); // High interval

    const run = makeRunCtx();
    for (let i = 0; i < 3; i++) {
      mw.afterToolExec(makeToolCtx(run, 'tool'), makeToolOutput(false, ''));
    }

    expect(run.meta.set).toHaveBeenCalledWith('reflection', 'needed', true);
    expect(run.meta.set).toHaveBeenCalledWith('reflection', 'trigger', 'high_failure_rate');
  });
});

// ─── TaskClassifierMiddleware ─────────────────────────────────────────────────

describe('TaskClassifierMiddleware', () => {
  it('is gated by feature flag', () => {
    const mw = new TaskClassifierMiddleware();
    mw.withFeatureFlags({ ...DEFAULT_FEATURE_FLAGS, taskClassifier: false });
    expect(mw.enabled()).toBe(false);

    mw.withFeatureFlags({ ...DEFAULT_FEATURE_FLAGS, taskClassifier: true });
    expect(mw.enabled()).toBe(true);
  });

  // onStart is async; LLM is not available in unit test environment,
  // so it falls back to heuristic regex classification.

  it('classifies action tasks', async () => {
    const onClassified = vi.fn();
    const mw = new TaskClassifierMiddleware({ onClassified });
    await mw.onStart(makeRunCtx({ task: 'fix the authentication bug' }));
    expect(mw.classification?.intent).toBe('action');
    expect(mw.classification?.confidence).toBeGreaterThanOrEqual(0.5);
    expect(onClassified).toHaveBeenCalledOnce();
  });

  it('classifies discovery tasks', async () => {
    const mw = new TaskClassifierMiddleware();
    await mw.onStart(makeRunCtx({ task: 'where is the login page implemented?' }));
    expect(mw.classification?.intent).toBe('discovery');
  });

  it('classifies analysis tasks', async () => {
    const mw = new TaskClassifierMiddleware();
    await mw.onStart(makeRunCtx({ task: 'analyze the performance of the search module' }));
    expect(mw.classification?.intent).toBe('analysis');
  });

  it('defaults to action for ambiguous tasks', async () => {
    const mw = new TaskClassifierMiddleware();
    await mw.onStart(makeRunCtx({ task: 'hello world' }));
    expect(mw.classification?.intent).toBe('action');
    expect(mw.classification?.confidence).toBeLessThanOrEqual(0.3);
  });

  it('stores classification in context meta', async () => {
    const mw = new TaskClassifierMiddleware();
    const ctx = makeRunCtx({ task: 'find all TODO comments' });
    await mw.onStart(ctx);
    expect(ctx.meta.set).toHaveBeenCalledWith('classifier', 'intent', 'discovery');
  });
});
