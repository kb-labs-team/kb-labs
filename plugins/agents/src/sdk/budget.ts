/**
 * IBudgetManager — token and iteration budget tracking.
 *
 * BudgetSnapshot is the read-only view of current state.
 * BudgetDecision is what the manager recommends doing next.
 *
 * The BudgetMiddleware in agent-core calls snapshot() + decide() in
 * beforeIteration() and returns the appropriate ControlAction.
 */

import type { LLMTier } from '../contracts/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// BudgetSnapshot — current state (read-only)
// ─────────────────────────────────────────────────────────────────────────────

export interface BudgetSnapshot {
  totalTokens: number;
  iterationsUsed: number;
  /** 0 = unlimited */
  tokenBudget: number;
  iterationBudget: number;
  /** ~80% of token budget consumed */
  softLimitReached: boolean;
  /** ~95% of token budget consumed */
  hardLimitReached: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// BudgetDecision — what to do next
// ─────────────────────────────────────────────────────────────────────────────

export interface BudgetDecision {
  action: 'continue' | 'escalate' | 'stop';
  reason?: string;
  /** If true: stop iterating and synthesize a partial answer from history */
  forceSynthesis?: boolean;
  /** Target tier for escalation */
  escalateTo?: LLMTier;
}

// ─────────────────────────────────────────────────────────────────────────────
// IBudgetManager interface
// ─────────────────────────────────────────────────────────────────────────────

export interface IBudgetManager {
  /** Current budget state */
  snapshot(): BudgetSnapshot;

  /** Recommend an action based on current state */
  decide(snapshot: BudgetSnapshot): BudgetDecision;

  /** Record tokens consumed in one LLM call */
  record(promptTokens: number, completionTokens: number): void;

  /** Total tokens consumed so far */
  readonly totalTokens: number;
}
