/**
 * ReflectionMiddleware — adaptive LLM-driven operational reflection.
 *
 * Feature-flagged: enabled when FeatureFlags.reflection is true.
 */

import type { FeatureFlags } from '../../../contracts/index.js';
import type { ToolExecCtx, ToolOutput } from '../../../sdk/index.js';

export interface ReflectionCallbacks {
  onReflectionNeeded?: (trigger: string, iteration: number) => void;
}

export class ReflectionMiddleware {
  readonly name = 'reflection';
  readonly order = 70;
  readonly config = { failPolicy: 'fail-open' as const, timeoutMs: 5000 };

  private readonly callbacks: ReflectionCallbacks;
  private _toolCallsSinceReflection = 0;
  private _failedToolsSinceReflection = 0;
  private readonly reflectionInterval: number;
  private _featureFlags?: FeatureFlags;

  constructor(callbacks: ReflectionCallbacks = {}, reflectionInterval = 5) {
    this.callbacks = callbacks;
    this.reflectionInterval = reflectionInterval;
  }

  enabled(): boolean {
    return this._featureFlags?.reflection ?? false;
  }

  withFeatureFlags(flags: FeatureFlags): this {
    this._featureFlags = flags;
    return this;
  }

  afterToolExec(ctx: ToolExecCtx, result: ToolOutput): void {
    this._toolCallsSinceReflection++;
    if (!result.success) {
      this._failedToolsSinceReflection++;
    }

    const shouldReflect =
      this._toolCallsSinceReflection >= this.reflectionInterval ||
      (this._failedToolsSinceReflection >= 3 && this._toolCallsSinceReflection >= 3);

    if (shouldReflect) {
      const trigger = this._failedToolsSinceReflection >= 3 ? 'high_failure_rate' : 'periodic';
      ctx.run.meta.set('reflection', 'needed', true);
      ctx.run.meta.set('reflection', 'trigger', trigger);
      this.callbacks.onReflectionNeeded?.(trigger, ctx.iteration);
      this._toolCallsSinceReflection = 0;
      this._failedToolsSinceReflection = 0;
    }
  }

  onStop(): void {
    this.reset();
  }

  reset(): void {
    this._toolCallsSinceReflection = 0;
    this._failedToolsSinceReflection = 0;
  }
}
