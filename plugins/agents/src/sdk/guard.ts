/**
 * ToolGuard — security layer around tool execution.
 *
 * Guards run inside ToolManager, forming a GuardPipeline:
 *   LLM → validateInput() → [reject = error result] → ToolManager.execute()
 *       → validateOutput() → [sanitize or reject] → OutputProcessors → context
 *
 * Guards are the single enforcement point for permissions.
 * Tool implementations do NOT check permissions themselves.
 *
 * Built-in guards in agent-core:
 *   PromptInjectionGuard  — detects injection attempts in tool input
 *   SecretRedactionGuard  — scrubs api keys / tokens from output
 *   PathSandboxGuard      — enforces allowed filesystem paths
 *   NetworkGuard          — controls outbound requests (MCP tools)
 */

import type { ToolExecCtx } from './contexts.js';

// ─────────────────────────────────────────────────────────────────────────────
// ValidationResult — what a guard returns
// ─────────────────────────────────────────────────────────────────────────────

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; action: 'reject' }
  | { ok: false; reason: string; action: 'sanitize'; sanitized: string };

// ─────────────────────────────────────────────────────────────────────────────
// ToolGuard interface
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolGuard {
  name: string;

  /**
   * Called BEFORE tool execution.
   * Return { ok: false, action: 'reject' } to block the call entirely —
   * the tool output will be an error message.
   */
  validateInput?(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ToolExecCtx
  ): ValidationResult | Promise<ValidationResult>;

  /**
   * Called AFTER tool execution.
   * Return { ok: false, action: 'sanitize', sanitized } to replace the output.
   * Return { ok: false, action: 'reject' } to replace output with an error message.
   */
  validateOutput?(
    toolName: string,
    output: string,
    ctx: ToolExecCtx
  ): ValidationResult | Promise<ValidationResult>;
}
