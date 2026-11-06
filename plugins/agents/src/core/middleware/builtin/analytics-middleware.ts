/**
 * AnalyticsMiddleware — pure observer for metrics and tool outcome tracking.
 *
 * Hook points:
 * - onStart: record start time
 * - afterLLMCall: record token usage
 * - afterToolExec: track tool outcomes
 * - onStop: emit run metrics
 *
 * fail-open: analytics should NEVER break execution.
 */

import type { RunContext, LLMCtx, LLMCallResult, ToolExecCtx, ToolOutput } from '../../../sdk/index.js';

export interface ToolOutcome {
  toolName: string;
  success: boolean;
  durationMs?: number;
  errorCode?: string;
}

export interface RunMetrics {
  startedAt: number;
  endedAt: number;
  durationMs: number;
  totalIterations: number;
  toolOutcomes: ToolOutcome[];
  toolSuccessCount: number;
  toolErrorCount: number;
  stopReason?: string;
}

export interface AnalyticsCallbacks {
  onRunComplete?: (metrics: RunMetrics) => void;
  onToolOutcome?: (outcome: ToolOutcome) => void;
}

export class AnalyticsMiddleware {
  readonly name = 'analytics';
  readonly order = 90;
  readonly config = { failPolicy: 'fail-open' as const, timeoutMs: 3000 };

  private readonly callbacks: AnalyticsCallbacks;
  private _startedAt = 0;
  private _toolOutcomes: ToolOutcome[] = [];
  private _toolSuccessCount = 0;
  private _toolErrorCount = 0;
  private _lastIteration = 0;

  constructor(callbacks: AnalyticsCallbacks = {}) {
    this.callbacks = callbacks;
  }

  get toolSuccessCount(): number { return this._toolSuccessCount; }
  get toolErrorCount(): number   { return this._toolErrorCount; }
  get toolOutcomes(): ReadonlyArray<ToolOutcome> { return this._toolOutcomes; }

  onStart(_ctx: RunContext): void {
    this._startedAt = Date.now();
    this._toolOutcomes = [];
    this._toolSuccessCount = 0;
    this._toolErrorCount = 0;
  }

  afterLLMCall(ctx: LLMCtx, result: LLMCallResult): void {
    this._lastIteration = ctx.run.iteration;
    if (result.usage) {
      ctx.run.meta.set('analytics', 'lastLLMTokens', result.usage.promptTokens + result.usage.completionTokens);
    }
  }

  afterToolExec(_ctx: ToolExecCtx, result: ToolOutput): void {
    const outcome: ToolOutcome = {
      toolName: _ctx.toolName,
      success: result.success,
      errorCode: result.success ? undefined : 'TOOL_ERROR',
    };

    this._toolOutcomes.push(outcome);
    if (!result.success) {
      this._toolErrorCount++;
    } else {
      this._toolSuccessCount++;
    }

    this.callbacks.onToolOutcome?.(outcome);
  }

  onStop(_ctx: RunContext, reason: string): void {
    const metrics: RunMetrics = {
      startedAt: this._startedAt,
      endedAt: Date.now(),
      durationMs: Date.now() - this._startedAt,
      totalIterations: this._lastIteration + 1,
      toolOutcomes: this._toolOutcomes,
      toolSuccessCount: this._toolSuccessCount,
      toolErrorCount: this._toolErrorCount,
      stopReason: reason,
    };

    this.callbacks.onRunComplete?.(metrics);
  }

  reset(): void {
    this._startedAt = 0;
    this._toolOutcomes = [];
    this._toolSuccessCount = 0;
    this._toolErrorCount = 0;
    this._lastIteration = 0;
  }
}
