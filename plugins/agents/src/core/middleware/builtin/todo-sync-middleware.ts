/**
 * TodoSyncMiddleware — todo list coordination and phase syncing.
 *
 * Feature-flagged: enabled when FeatureFlags.todoSync is true.
 */

import type { FeatureFlags } from '../../../contracts/index.js';
import type { RunContext, LLMCtx, LLMCallPatch, ControlAction } from '../../../sdk/index.js';

export interface TodoSyncCallbacks {
  onNudge?: (iteration: number) => void;
  onFinalize?: (success: boolean) => void;
}

export class TodoSyncMiddleware {
  readonly name = 'todo-sync';
  readonly order = 40;
  readonly config = { failPolicy: 'fail-open' as const, timeoutMs: 3000 };

  private readonly callbacks: TodoSyncCallbacks;
  private _nudgeSent = false;
  private _featureFlags?: FeatureFlags;

  constructor(callbacks: TodoSyncCallbacks = {}) {
    this.callbacks = callbacks;
  }

  enabled(): boolean {
    return this._featureFlags?.todoSync ?? false;
  }

  withFeatureFlags(flags: FeatureFlags): this {
    this._featureFlags = flags;
    return this;
  }

  get nudgeSent(): boolean {
    return this._nudgeSent;
  }

  beforeIteration(_ctx: RunContext): ControlAction {
    return 'continue';
  }

  beforeLLMCall(ctx: LLMCtx): LLMCallPatch | undefined {
    if (!this._nudgeSent && ctx.run.iteration >= 2) {
      this._nudgeSent = true;
      this.callbacks.onNudge?.(ctx.run.iteration);

      return {
        messages: [
          ...ctx.messages,
          {
            role: 'system' as const,
            content:
              'This appears to be a multi-step task. Consider creating a short todo checklist ' +
              'to track your progress and ensure all steps are completed.',
          },
        ],
      };
    }

    return undefined;
  }

  onStop(_ctx: RunContext, reason: string): void {
    const success = reason === 'report_complete';
    this.callbacks.onFinalize?.(success);
  }

  reset(): void {
    this._nudgeSent = false;
  }
}
