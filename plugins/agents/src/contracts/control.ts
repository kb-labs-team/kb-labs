/**
 * Control flow types for Agent v2 middleware pipeline and execution loop.
 *
 * ControlAction is the unified return type for middleware hooks and execution decisions.
 * StopPriority defines deterministic ordering when multiple stop conditions fire simultaneously.
 */

// ═══════════════════════════════════════════════════════════════════════
// Control Actions
// ═══════════════════════════════════════════════════════════════════════

/**
 * Unified control action for middleware pipeline and execution loop.
 *
 * - 'continue' — proceed with current iteration
 * - 'stop'     — stop the execution loop gracefully
 * - 'escalate' — request tier escalation (small → medium → large)
 * - 'handoff'  — hand off to a different agent (sub-agent orchestration)
 */
export type ControlAction = 'continue' | 'stop' | 'escalate' | 'handoff';

// ═══════════════════════════════════════════════════════════════════════
// Stop Conditions
// ═══════════════════════════════════════════════════════════════════════

/**
 * Stop condition priorities (lower number = higher priority).
 *
 * When multiple conditions fire in the same iteration, the evaluator checks ALL
 * and returns the one with the highest priority (lowest numeric value).
 * Tie-break is impossible because enum values are unique.
 *
 * Example collision: report + hard_budget → REPORT_COMPLETE (1 < 2).
 */
export enum StopPriority {
  /** User cancelled via AbortController */
  ABORT_SIGNAL = 0,
  /** Agent called the `report` tool — task is done */
  REPORT_COMPLETE = 1,
  /** Token hard limit reached */
  HARD_BUDGET = 2,
  /** Maximum iterations reached */
  MAX_ITERATIONS = 3,
  /** Same tool calls repeated 3+ times in a row */
  LOOP_DETECTED = 4,
  /** Agent produced no tool calls — implicit completion */
  NO_TOOL_CALLS = 5,
}

/**
 * A fired stop condition with its priority and metadata.
 */
export interface StopConditionResult {
  /** Which condition fired */
  priority: StopPriority;
  /** Human-readable reason */
  reason: string;
  /** Machine-readable code for analytics */
  reasonCode: string;
  /** Additional metadata (e.g., report answer, loop count) */
  metadata?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════
// Middleware Configuration
// ═══════════════════════════════════════════════════════════════════════

/**
 * Failure policy for a middleware.
 *
 * - 'fail-open'   — if the middleware throws, log and continue the pipeline
 * - 'fail-closed' — if the middleware throws, stop the entire execution
 */
export type MiddlewareFailPolicy = 'fail-open' | 'fail-closed';

/**
 * Per-middleware configuration for pipeline behavior.
 */
export interface MiddlewareConfig {
  /** What happens when this middleware throws (default: 'fail-open') */
  failPolicy: MiddlewareFailPolicy;
  /** Maximum time for any single hook invocation in ms (default: 5000) */
  timeoutMs?: number;
  /** Whether the middleware is safe to retry on failure */
  idempotent?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// Feature Flags
// ═══════════════════════════════════════════════════════════════════════

/**
 * Feature flags controlling which experimental middlewares are active.
 * All default to false unless explicitly enabled.
 */
export interface FeatureFlags {
  /** Two-tier memory: FactSheet (hot) + ArchiveMemory (cold) */
  twoTierMemory: boolean;
  /** TODO sync coordinator — nudges agent toward todo discipline */
  todoSync: boolean;
  /** Search signal tracker — discovery vs action classification */
  searchSignal: boolean;
  /** Reflection engine — adaptive LLM-driven behavior */
  reflection: boolean;
  /** Task classifier — intent inference (action/discovery/analysis) */
  taskClassifier: boolean;
  /** Smart summarizer — progressive conversation compression */
  smartSummarizer: boolean;
  /** Tier escalation — auto-escalate small → medium → large */
  tierEscalation: boolean;
}

/**
 * Default feature flags — conservative, all experimental features off.
 */
export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  twoTierMemory: false,
  todoSync: false,
  searchSignal: false,
  reflection: false,
  taskClassifier: false,
  smartSummarizer: false,
  tierEscalation: false,
};

// ═══════════════════════════════════════════════════════════════════════
// Execution Loop Result
// ═══════════════════════════════════════════════════════════════════════

/**
 * Result of a single ExecutionLoop run.
 * Uses discriminated union on `outcome` instead of thrown exceptions.
 */
export type LoopResult<T = unknown> =
  | { outcome: 'complete'; result: T }
  | { outcome: 'escalate'; reason: string }
  | { outcome: 'handoff'; targetAgentId: string; context: Record<string, unknown> };
