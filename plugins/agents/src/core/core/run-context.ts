/**
 * RunContext factory + ContextMeta implementation.
 *
 * RunContext is the top-level context shared across an entire agent run.
 * It is created once per tier attempt by SDKAgentRunner.
 *
 * Key invariant: messages is a readonly view of a mutable backing array.
 * The only legal mutation path is LoopContextImpl.appendMessage().
 */

import { randomUUID } from 'node:crypto';
import type { LLMMessage, LLMTool } from '@kb-labs/sdk';
import type { AgentConfig, LLMTier } from '../../contracts/index.js';
import type { AgentEventBus, ContextMeta, RunContext } from '../../sdk/index.js';
import { createEventBus } from '../execution/event-bus-impl.js';

// ─────────────────────────────────────────────────────────────────────────────
// ContextMetaImpl
// ─────────────────────────────────────────────────────────────────────────────

export class ContextMetaImpl implements ContextMeta {
  private readonly store = new Map<string, Map<string, unknown>>();

  get<T>(namespace: string, key: string): T | undefined {
    return this.store.get(namespace)?.get(key) as T | undefined;
  }

  set<T>(namespace: string, key: string, value: T): void {
    let ns = this.store.get(namespace);
    if (!ns) {
      ns = new Map();
      this.store.set(namespace, ns);
    }
    ns.set(key, value);
  }

  getNamespace(namespace: string): Record<string, unknown> {
    const ns = this.store.get(namespace);
    if (!ns) {return {};}
    return Object.fromEntries(ns.entries());
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RunContextImpl — mutable backing, readonly external view
// ─────────────────────────────────────────────────────────────────────────────

class RunContextImpl implements RunContext {
  task: string;
  tier: LLMTier;
  tools: LLMTool[];
  iteration: number = 0;
  maxIterations: number;
  aborted: boolean = false;
  abortSignal: AbortSignal;
  requestId: string;
  deadlineMs?: number;
  sessionId?: string;
  meta: ContextMeta;
  eventBus: AgentEventBus;
  debug: boolean;

  /** Mutable backing array — only LoopContextImpl may push to this. */
  readonly _messages: LLMMessage[] = [];

  get messages(): ReadonlyArray<LLMMessage> {
    return this._messages;
  }

  constructor(
    task: string,
    tier: LLMTier,
    tools: LLMTool[],
    maxIterations: number,
    abortSignal: AbortSignal,
    requestId: string,
    sessionId: string | undefined,
    meta: ContextMeta,
    eventBus: AgentEventBus,
    debug: boolean,
  ) {
    this.task = task;
    this.tier = tier;
    this.tools = tools;
    this.maxIterations = maxIterations;
    this.abortSignal = abortSignal;
    this.requestId = requestId;
    this.sessionId = sessionId;
    this.meta = meta;
    this.eventBus = eventBus;
    this.debug = debug;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateRunContextOptions {
  config: AgentConfig;
  tier: LLMTier;
  tools: LLMTool[];
  abortController: AbortController;
  requestId?: string;
}

/**
 * Creates a fresh RunContext for one tier attempt.
 * Returns the context AND the mutable backing array for LoopContextImpl.
 */
export function createRunContext(options: CreateRunContextOptions): {
  run: RunContext;
  messages: LLMMessage[];
} {
  const { config, tier, tools, abortController, requestId } = options;

  const meta = new ContextMetaImpl();
  const requestId_ = requestId ?? randomUUID();
  const eventBus = createEventBus();

  const impl = new RunContextImpl(
    /* task         */ '',   // set by SDKAgentRunner before loop starts
    /* tier         */ tier,
    /* tools        */ tools,
    /* maxIter      */ config.maxIterations,
    /* abortSignal  */ abortController.signal,
    /* requestId    */ requestId_,
    /* sessionId    */ config.sessionId,
    /* meta         */ meta,
    /* eventBus     */ eventBus,
    /* debug        */ (config as { debug?: boolean }).debug ?? false,
  );

  // Wire abort so impl.aborted is kept in sync
  abortController.signal.addEventListener('abort', () => {
    impl.aborted = true;
  });

  return {
    run: impl,
    messages: impl._messages,
  };
}
