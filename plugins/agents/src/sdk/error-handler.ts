/**
 * AgentErrorHandler — defines what to do when a tool or LLM call fails.
 *
 * Registered via sdk.withErrorHandler(handler).
 *
 * Default behaviour in agent-core:
 *   tool error  → retry once → skip (return empty output, continue)
 *   LLM error   → retry with exponential backoff (3x) → stop
 *
 * The `attempt` parameter is 1-based — first failure = attempt 1.
 */

import type { LLMCtx, ToolExecCtx } from './contexts.js';

// ─────────────────────────────────────────────────────────────────────────────
// ToolErrorAction
// ─────────────────────────────────────────────────────────────────────────────

export type ToolErrorAction =
  | { action: 'retry'; delayMs?: number }
  | { action: 'skip' }              // return empty output, continue iteration
  | { action: 'stop'; reason: string };

// ─────────────────────────────────────────────────────────────────────────────
// LLMErrorAction
// ─────────────────────────────────────────────────────────────────────────────

export type LLMErrorAction =
  | { action: 'retry'; delayMs?: number }
  | { action: 'stop'; reason: string };

// ─────────────────────────────────────────────────────────────────────────────
// AgentErrorHandler interface
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentErrorHandler {
  /**
   * Called when a tool execution throws.
   * @param attempt 1-based attempt count
   */
  onToolError(
    error: unknown,
    ctx: ToolExecCtx,
    attempt: number
  ): ToolErrorAction;

  /**
   * Called when an LLM API call throws (rate limit, timeout, network error, etc.).
   * @param attempt 1-based attempt count
   */
  onLLMError(
    error: unknown,
    ctx: LLMCtx,
    attempt: number
  ): LLMErrorAction;
}
