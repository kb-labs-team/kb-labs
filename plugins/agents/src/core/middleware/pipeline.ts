/**
 * MiddlewarePipeline — orchestrates middleware execution with error handling.
 *
 * Features:
 * - Runs before-hooks ascending (lower order = first), after-hooks descending
 * - Per-middleware failure policy: fail-open (log + skip) or fail-closed (stop)
 * - Per-hook timeout enforcement (0 = no timeout)
 */

import type { FeatureFlags } from '../../contracts/index.js';
import type {
  AgentMiddleware,
  ControlAction,
  RunContext,
  LLMCtx,
  LLMCallPatch,
  LLMCallResult,
  ToolExecCtx,
  ToolOutput,
} from '../../sdk/index.js';

const DEFAULT_TIMEOUT_MS = 5000;

export interface PipelineOptions {
  featureFlags: FeatureFlags;
  onError?: (middlewareName: string, hookName: string, error: unknown) => void;
}

export class MiddlewarePipeline {
  private readonly asc: AgentMiddleware[];
  private readonly desc: AgentMiddleware[];
  private readonly options: PipelineOptions;

  constructor(middlewares: AgentMiddleware[], options: PipelineOptions) {
    const sorted = [...middlewares].sort((a, b) => a.order - b.order);
    this.asc  = sorted;
    this.desc = [...sorted].reverse();
    this.options = options;
  }

  private getActive(list: AgentMiddleware[]): AgentMiddleware[] {
    return list.filter((m) => !m.enabled || m.enabled());
  }

  private async runHook<T>(
    middleware: AgentMiddleware,
    hookName: string,
    fn: () => Promise<T> | T,
    fallback: T,
  ): Promise<{ value: T; failed: boolean }> {
    const timeoutMs = middleware.config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      const result = timeoutMs > 0
        ? await Promise.race([
            Promise.resolve(fn()),
            new Promise<never>((_, reject) => {
              setTimeout(
                () => reject(new Error(`Middleware "${middleware.name}.${hookName}" timed out after ${timeoutMs}ms`)),
                timeoutMs,
              );
            }),
          ])
        : await Promise.resolve(fn());

      return { value: result, failed: false };
    } catch (error) {
      this.options.onError?.(middleware.name, hookName, error);
      if (middleware.config?.failPolicy === 'fail-closed') {throw error;}
      return { value: fallback, failed: true };
    }
  }

  async onStart(ctx: RunContext): Promise<void> {
    for (const m of this.getActive(this.asc)) {
      if (!m.onStart) {continue;}
      await this.runHook(m, 'onStart', () => m.onStart!(ctx), undefined);
    }
  }

  async onStop(ctx: RunContext, reason: string): Promise<void> {
    for (const m of this.getActive(this.desc)) {
      if (!m.onStop) {continue;}
      await this.runHook(m, 'onStop', () => m.onStop!(ctx, reason), undefined);
    }
  }

  async onComplete(ctx: RunContext): Promise<void> {
    for (const m of this.getActive(this.desc)) {
      if (!m.onComplete) {continue;}
      await this.runHook(m, 'onComplete', () => m.onComplete!(ctx), undefined);
    }
  }

  async beforeIteration(ctx: RunContext): Promise<ControlAction> {
    for (const m of this.getActive(this.asc)) {
      if (!m.beforeIteration) {continue;}
      const { value } = await this.runHook(m, 'beforeIteration', () => m.beforeIteration!(ctx), 'continue' as ControlAction);
      if (value !== 'continue') {return value;}
    }
    return 'continue';
  }

  async afterIteration(ctx: RunContext): Promise<void> {
    for (const m of this.getActive(this.desc)) {
      if (!m.afterIteration) {continue;}
      await this.runHook(m, 'afterIteration', () => m.afterIteration!(ctx), undefined);
    }
  }

  /** Merges patches from all middlewares in order (last wins per field) */
  async beforeLLMCall(ctx: LLMCtx): Promise<LLMCallPatch> {
    let patch: LLMCallPatch = {};
    for (const m of this.getActive(this.asc)) {
      if (!m.beforeLLMCall) {continue;}
      const { value } = await this.runHook(m, 'beforeLLMCall', () => m.beforeLLMCall!(ctx), undefined);
      if (value) {patch = { ...patch, ...value };}
    }
    return patch;
  }

  async afterLLMCall(ctx: LLMCtx, result: LLMCallResult): Promise<void> {
    for (const m of this.getActive(this.desc)) {
      if (!m.afterLLMCall) {continue;}
      await this.runHook(m, 'afterLLMCall', () => m.afterLLMCall!(ctx, result), undefined);
    }
  }

  /** Returns 'skip' if ANY middleware votes skip */
  async beforeToolExec(ctx: ToolExecCtx): Promise<'execute' | 'skip'> {
    for (const m of this.getActive(this.asc)) {
      if (!m.beforeToolExec) {continue;}
      const { value } = await this.runHook(m, 'beforeToolExec', () => m.beforeToolExec!(ctx), 'execute' as const);
      if (value === 'skip') {return 'skip';}
    }
    return 'execute';
  }

  async afterToolExec(ctx: ToolExecCtx, result: ToolOutput): Promise<void> {
    for (const m of this.getActive(this.desc)) {
      if (!m.afterToolExec) {continue;}
      await this.runHook(m, 'afterToolExec', () => m.afterToolExec!(ctx, result), undefined);
    }
  }
}
