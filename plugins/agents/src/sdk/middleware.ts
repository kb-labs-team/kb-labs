/**
 * Middleware interface for the Agent SDK.
 *
 * Middleware hooks into the execution pipeline at well-defined points.
 * Implement only the hooks you need — all are optional.
 *
 * Ordering:
 *   before-hooks (onStart, beforeIteration, beforeLLMCall, beforeToolExec) — ascending order
 *   after-hooks (afterToolExec, afterLLMCall, afterIteration, onStop, onComplete) — descending order
 *
 * Fail policies:
 *   'fail-open'  — if middleware throws, log and continue (default, for observers)
 *   'fail-closed' — if middleware throws, stop the run (for critical guards)
 */

import type { LLMMessage } from '@kb-labs/sdk';
import type { RunContext, LLMCtx, LLMCallPatch, LLMCallResult, ToolExecCtx, ToolOutput } from './contexts.js';

// ─────────────────────────────────────────────────────────────────────────────
// ControlAction — returned by beforeIteration to control the loop
// ─────────────────────────────────────────────────────────────────────────────

export type ControlAction = 'continue' | 'stop' | 'escalate';

// ─────────────────────────────────────────────────────────────────────────────
// AgentMiddleware interface
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentMiddleware {
  /** Unique name for logging and deduplication */
  name: string;

  /**
   * Execution order. Lower = runs first in before-hooks, last in after-hooks.
   * Core middlewares: 0–99. Custom: 100+.
   */
  order: number;

  config?: {
    /** On error: continue silently ('fail-open') or stop run ('fail-closed'). Default: 'fail-open' */
    failPolicy: 'fail-open' | 'fail-closed';
    /** Hook timeout in ms (0 = no timeout). Default: 5000 */
    timeoutMs?: number;
  };

  /** Called once at pipeline construction — if returns false, middleware is skipped entirely */
  enabled?(): boolean;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Called once when the run starts, before the first iteration */
  onStart?(ctx: RunContext): Promise<void> | void;

  /** Called when the run ends for any reason (complete, abort, error) */
  onStop?(ctx: RunContext, reason: string): Promise<void> | void;

  /** Called only on successful completion, after onStop */
  onComplete?(ctx: RunContext): Promise<void> | void;

  // ── Per-iteration ──────────────────────────────────────────────────────────

  /**
   * Called before each iteration.
   * Return 'stop' to end the run early.
   * Return 'escalate' to trigger tier escalation.
   * Return 'continue' (or undefined) to proceed normally.
   */
  beforeIteration?(ctx: RunContext): Promise<ControlAction> | ControlAction;

  /** Called after each iteration — useful for metrics, logging, snapshots */
  afterIteration?(ctx: RunContext): Promise<void> | void;

  // ── LLM call ──────────────────────────────────────────────────────────────

  /**
   * Called before the LLM API call.
   * Returns a patch of what to change in the request (messages, tools, temperature).
   * Returning undefined (or empty object) = no change.
   * Patches from all middlewares are merged in order.
   */
  beforeLLMCall?(ctx: LLMCtx): Promise<LLMCallPatch | undefined> | LLMCallPatch | undefined;

  /** Called after the LLM responded. Read-only — cannot modify the response. */
  afterLLMCall?(ctx: LLMCtx, result: LLMCallResult): Promise<void> | void;

  // ── Tool execution ────────────────────────────────────────────────────────

  /**
   * Called before each tool execution.
   * Return 'skip' to prevent the tool from running (output will be empty).
   * Return 'execute' (or undefined) to proceed.
   */
  beforeToolExec?(ctx: ToolExecCtx): Promise<'execute' | 'skip'> | 'execute' | 'skip';

  /** Called after each tool execution (even if skipped or errored) */
  afterToolExec?(ctx: ToolExecCtx, result: ToolOutput): Promise<void> | void;
}

// ─────────────────────────────────────────────────────────────────────────────
// BaseMiddleware — zero-boilerplate base class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extend this to implement only the hooks you need.
 *
 * @example
 * class RateLimitMiddleware extends BaseMiddleware {
 *   name = 'rate-limit';
 *   order = 50;
 *
 *   async beforeIteration(ctx: RunContext): Promise<ControlAction> {
 *     if (this.isOverLimit()) return 'stop';
 *     return 'continue';
 *   }
 * }
 */
export abstract class BaseMiddleware implements AgentMiddleware {
  abstract name: string;
  abstract order: number;
  config = { failPolicy: 'fail-open' as const };
}

// Suppress unused import warning — LLMMessage is used in beforeLLMCall signature
// via LLMCallPatch which references LLMMessage[] through contexts.ts
void (null as unknown as LLMMessage);
