/**
 * Sub-agent spawn types — shared between agent-core and agent-tools.
 *
 * These types flow as plain data across the package boundary:
 * - agent-tools resolves preset → allowedTools (knows tool names)
 * - agent-core uses allowedTools to configure child runner (knows budget/lifecycle)
 */

// ── Sub-agent presets ────────────────────────────────────────────────────────

/**
 * Built-in sub-agent capability presets.
 * - 'research' — read-only: search, read files, memory. No writes.
 * - 'execute'  — full tool set: read + write + shell. For implementation tasks.
 * - 'review'   — read + shell: for code review, running linters/tests.
 */
export type SubAgentPreset = 'research' | 'execute' | 'review';

// ── Spawn request ────────────────────────────────────────────────────────────

/**
 * Request to spawn a sub-agent.
 * Flows: tool layer (resolves preset) → core layer (enforces budget, creates child).
 *
 * All fields except `task` are optional for backward compatibility:
 * `{ task: "..." }` works as before (preset='research', budgetFraction=0.5).
 */
export interface SpawnAgentRequest {
  /** Clear task description — the sub-agent has no context about parent's work. */
  task: string;
  /** Preset determines which tools the child gets. Default: 'research'. */
  preset?: SubAgentPreset;
  /**
   * Explicit tool allowlist — resolved from preset by the tool layer.
   * Core layer passes this to child's ToolContext.allowedTools.
   */
  allowedTools?: string[];
  /** Max iterations for the child. Default: from preset. */
  maxIterations?: number;
  /** Working directory relative to project root. */
  workingDir?: string;
  /**
   * Budget cap: fraction (0.0–1.0) of parent's REMAINING token budget.
   * Default: 0.5 (50%). 0 = unlimited (legacy behavior).
   */
  budgetFraction?: number;
}

// ── Spawn result ─────────────────────────────────────────────────────────────

/**
 * Structured result returned from sub-agent to parent.
 * Preserves all useful data from TaskResult — no stripping.
 */
export interface SpawnAgentResult {
  success: boolean;
  /** 1-3 sentence summary for parent context and Status Block. */
  summary: string;
  /** Files the sub-agent read. */
  filesRead: string[];
  /** Files the sub-agent modified. */
  filesModified: string[];
  /** Files the sub-agent created. */
  filesCreated: string[];
  iterations: number;
  tokensUsed: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Error message if success=false. */
  error?: string;
  /** Preset that was used. */
  preset: SubAgentPreset;
}
