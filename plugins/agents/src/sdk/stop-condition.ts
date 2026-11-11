/**
 * StopCondition — defines when the execution loop should stop.
 *
 * All registered conditions are evaluated after each LLM response.
 * When multiple conditions fire simultaneously, the one with the
 * lowest priority number wins (priority = 0 is highest).
 *
 * Built-in conditions in agent-core (priorities 0–9 reserved):
 *   AbortCondition      0  — abortSignal.aborted
 *   ReportCondition     1  — agent called the report tool
 *   HardBudgetCondition 2  — token hard limit reached
 *   MaxIterations       3  — iteration limit reached
 *   LoopDetected        4  — same tools called 3x in a row
 *   NoToolCalls         5  — agent returned no tool calls
 *
 * Custom conditions: use priority >= 10.
 */

import type { RunContext, LLMCallResult } from './contexts.js';

// ─────────────────────────────────────────────────────────────────────────────
// StopConditionResult
// ─────────────────────────────────────────────────────────────────────────────

export interface StopConditionResult {
  /** Human-readable reason label */
  reason: string;
  /** Machine-readable code (e.g. 'report_complete', 'max_iterations') */
  reasonCode: string;
  /** Priority of this condition (lower = more important) */
  priority: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// StopCondition interface
// ─────────────────────────────────────────────────────────────────────────────

export interface StopCondition {
  name: string;

  /**
   * Evaluated after each LLM response.
   * Return a StopConditionResult if this condition fires, null otherwise.
   */
  evaluate(ctx: RunContext, response: LLMCallResult): StopConditionResult | null;
}
