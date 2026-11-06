/**
 * GuardPipeline — runs all registered ToolGuards in order.
 *
 * Called inside ToolManager.execute():
 *   validateInput() → [reject = error result] → tool.execute()
 *   → validateOutput() → [sanitize/reject] → OutputProcessors
 *
 * Guards have no side effects — they only inspect and optionally transform.
 */

import type { ToolGuard, ValidationResult, ToolExecCtx } from '../../sdk/index.js';

export class GuardPipeline {
  private readonly guards: ToolGuard[];

  constructor(guards: ToolGuard[] = []) {
    this.guards = guards;
  }

  /**
   * Run all validateInput guards in order.
   * Returns the first rejection, or { ok: true } if all pass.
   */
  async validateInput(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ToolExecCtx,
  ): Promise<ValidationResult> {
    for (const guard of this.guards) {
      if (!guard.validateInput) {continue;}
      const result = await Promise.resolve(guard.validateInput(toolName, input, ctx));
      if (!result.ok) {return result;}
    }
    return { ok: true };
  }

  /**
   * Run all validateOutput guards in order.
   * Sanitize actions are chained (each guard sees the previous sanitized output).
   * First rejection wins.
   */
  async validateOutput(
    toolName: string,
    output: string,
    ctx: ToolExecCtx,
  ): Promise<ValidationResult> {
    let current = output;
    for (const guard of this.guards) {
      if (!guard.validateOutput) {continue;}
      const result = await Promise.resolve(guard.validateOutput(toolName, current, ctx));
      if (!result.ok) {
        if (result.action === 'sanitize') {
          current = result.sanitized;
          // continue — allow other guards to inspect the sanitized output
        } else {
          return result; // reject
        }
      }
    }
    // If any sanitization happened, return sanitize result with final output
    if (current !== output) {
      return { ok: false, reason: 'sanitized', action: 'sanitize', sanitized: current };
    }
    return { ok: true };
  }
}
