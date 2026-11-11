/**
 * @kb-labs/agents/sdk/testing
 *
 * Ready-made mock helpers for testing agent-core, plugins, and any code
 * that works with SDK types. Import from this sub-path — never from main index.
 *
 * @example
 *   import { makeRunCtx, makeLoopCtx, makeLLMResponse } from '@kb-labs/agents/sdk/testing';
 *
 * All helpers use vitest's `vi.fn()` — vitest must be available in the test env.
 */

import { vi } from 'vitest';
import type { RunContext, ContextMeta, LLMCtx, LLMCallResult, ToolExecCtx, ToolOutput, ToolCallInput } from './contexts.js';
import type { LoopContext } from './loop.js';
import type { AgentMiddleware, ControlAction } from './middleware.js';

// ─── ContextMeta mock ─────────────────────────────────────────────────────────

export function makeMeta(): ContextMeta & { _store: Map<string, Map<string, unknown>> } {
  const store = new Map<string, Map<string, unknown>>();
  return {
    _store: store,
    get: vi.fn((ns: string, key: string) =>
      store.get(ns)?.get(key),
    ) as ContextMeta['get'],
    set: vi.fn((ns: string, key: string, value: unknown) => {
      if (!store.has(ns)) {
        store.set(ns, new Map());
      }
      store.get(ns)!.set(key, value);
    }),
    getNamespace: vi.fn((ns: string) =>
      Object.fromEntries(store.get(ns) ?? new Map()),
    ),
  };
}

// ─── RunContext mock ──────────────────────────────────────────────────────────

export function makeRunCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    task: 'test task',
    tier: 'medium',
    messages: [],
    tools: [],
    iteration: 0,
    maxIterations: 20,
    aborted: false,
    abortSignal: new AbortController().signal,
    requestId: 'req-test',
    meta: makeMeta(),
    ...overrides,
  } as RunContext;
}

// ─── LLMCtx mock ─────────────────────────────────────────────────────────────

export function makeLLMCtx(runCtx?: RunContext, overrides: Partial<LLMCtx> = {}): LLMCtx {
  return {
    run: runCtx ?? makeRunCtx(),
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    ...overrides,
  };
}

// ─── ToolExecCtx mock ─────────────────────────────────────────────────────────

export function makeToolExecCtx(
  runCtx?: RunContext,
  overrides: Partial<ToolExecCtx> = {},
): ToolExecCtx {
  const run = runCtx ?? makeRunCtx();
  return {
    run,
    toolName: 'fs_read',
    input: {},
    iteration: run.iteration,
    abortSignal: run.abortSignal,
    requestId: run.requestId,
    ...overrides,
  };
}

// ─── LLMCallResult mock ───────────────────────────────────────────────────────

export function makeLLMResponse(overrides: Partial<LLMCallResult> = {}): LLMCallResult {
  return {
    content: '',
    toolCalls: [],
    ...overrides,
  };
}

/** Shorthand: LLM response that calls the report tool */
export function makeReportResponse(answer: string): LLMCallResult {
  return makeLLMResponse({
    toolCalls: [{ id: 'tc-report', name: 'report', input: { answer } }],
  });
}

// ─── ToolOutput mock ──────────────────────────────────────────────────────────

export function makeToolOutput(overrides: Partial<ToolOutput> = {}): ToolOutput {
  return {
    toolCallId: 'tc-1',
    output: 'result',
    success: true,
    ...overrides,
  };
}

// ─── LoopContext mock ─────────────────────────────────────────────────────────

export interface LoopCtxOptions {
  run?: RunContext;
  /** Sequential LLM responses — each call pops the next one */
  llmResponses?: LLMCallResult[];
  /** Tool outputs returned by executeTools */
  toolOutputs?: ToolOutput[];
}

export function makeLoopCtx(opts: LoopCtxOptions = {}): LoopContext {
  const run = opts.run ?? makeRunCtx();
  const responses = [...(opts.llmResponses ?? [makeLLMResponse()])];
  let callIndex = 0;

  return {
    run,
    appendMessage: vi.fn(),
    callLLM: vi.fn(async (): Promise<LLMCallResult> => {
      const r = responses[callIndex] ?? makeLLMResponse();
      callIndex++;
      return r;
    }),
    executeTools: vi.fn(async (_calls: ToolCallInput[]): Promise<ToolOutput[]> =>
      opts.toolOutputs ?? [],
    ),
    evaluateRun: vi.fn(async () => null),
    beforeIteration: vi.fn(async () => 'continue' as const),
    afterIteration: vi.fn(async () => {}),
  };
}

// ─── AgentMiddleware mock ─────────────────────────────────────────────────────

export function makeMiddleware(
  overrides: Partial<AgentMiddleware> & { name: string; order: number },
): AgentMiddleware {
  return {
    config: { failPolicy: 'fail-open' },
    ...overrides,
  };
}

/** Middleware that always returns a fixed ControlAction from beforeIteration */
export function makeControlMiddleware(
  name: string,
  order: number,
  action: ControlAction,
): AgentMiddleware {
  return makeMiddleware({
    name,
    order,
    beforeIteration: async () => action,
  });
}
