/**
 * InputNormalizer — transforms tool inputs before guards and execution.
 *
 * Normalizers run inside ToolExecutor in registration order, BEFORE guards:
 *   LLM → InputNormalizer.normalize() → ToolGuard.validateInput() → execute() → OutputProcessor
 *
 * Use cases:
 *   - Path resolution (.bak → source, .js → .ts)
 *   - Glob pattern expansion (bare filename → `**\/*name*`)
 *   - Adaptive read limits per tier
 *   - Directory field normalization
 *   - Shell cwd defaulting
 *
 * Contract:
 *   - Return a new (or same) input object — never throw.
 *   - If normalization doesn't apply to this tool, return input unchanged.
 *   - Normalizers are composable — each receives the output of the previous one.
 */

import type { ToolExecCtx } from './contexts.js';

// ─────────────────────────────────────────────────────────────────────────────
// InputNormalizer interface
// ─────────────────────────────────────────────────────────────────────────────

export interface InputNormalizer {
  name: string;

  /**
   * Transforms tool input before guards and execution.
   * Return the (possibly modified) input object.
   *
   * @param toolName - Name of the tool being called
   * @param input    - Current input (may have been modified by a prior normalizer)
   * @param ctx      - Execution context (run, iteration, tier, etc.)
   * @returns Normalized input — same reference or a new object
   */
  normalize(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ToolExecCtx,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
}
