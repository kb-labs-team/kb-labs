/**
 * OutputProcessor — transforms tool output before it enters the message context.
 *
 * Processors run in registration order after tool execution, before
 * the output is appended to the conversation history.
 *
 * Built-in processors in agent-core:
 *   TruncationProcessor    — truncates output > N chars (fixes 55k token problem)
 *   DeduplicationProcessor — removes repeated content across iterations
 *   CompressionProcessor   — compresses large structured outputs (JSON, logs)
 */

import type { ToolExecCtx } from './contexts.js';

// ─────────────────────────────────────────────────────────────────────────────
// OutputProcessor interface
// ─────────────────────────────────────────────────────────────────────────────

export interface OutputProcessor {
  name: string;

  /**
   * Transforms the raw tool output string.
   * Return the transformed string — or the original if no change needed.
   */
  process(output: string, ctx: ToolExecCtx): string | Promise<string>;
}
