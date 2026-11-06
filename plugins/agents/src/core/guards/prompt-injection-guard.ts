/**
 * PromptInjectionGuard — blocks common prompt injection patterns in tool inputs.
 *
 * Checks string values in tool input for patterns that suggest an attacker
 * is trying to hijack the agent via tool output (indirect injection).
 *
 * Not a silver bullet — heuristic-based. Complemented by output guards.
 */

import type { ToolGuard, ValidationResult, ToolExecCtx } from '../../sdk/index.js';

// Patterns that signal injection attempts
const INJECTION_PATTERNS: RegExp[] = [
  // Classic DAN / jailbreak openers
  /\bignore\s+(all\s+)?previous\s+instructions?\b/i,
  /\bforget\s+(everything|all)\s+(above|before|prior)\b/i,
  /\byou\s+are\s+now\s+(a\s+)?(?:DAN|evil|unrestricted|jailbroken)\b/i,

  // Role override
  /\bact\s+as\s+(if\s+you\s+are\s+)?(?:a\s+)?(?:different\s+)?ai\b/i,
  /\bpretend\s+(you\s+are|to\s+be)\s+(?:a\s+)?(?:different\s+)?ai\b/i,

  // System prompt leakage / override
  /\bprint\s+your\s+(system\s+)?prompt\b/i,
  /\breveal\s+(your\s+)?(system\s+)?prompt\b/i,
  /\brepeat\s+everything\s+(above|before)\b/i,

  // Direct instruction smuggling via data
  /<<<\s*SYSTEM\s*>>>/i,
  /\[INST\].*\[\/INST\]/i,
];

export class PromptInjectionGuard implements ToolGuard {
  readonly name = 'prompt-injection';

  validateInput(
    toolName: string,
    input: Record<string, unknown>,
    _ctx: ToolExecCtx,
  ): ValidationResult {
    const strings = extractStrings(input);
    for (const value of strings) {
      for (const pattern of INJECTION_PATTERNS) {
        if (pattern.test(value)) {
          return {
            ok: false,
            reason: `Prompt injection pattern detected in input to "${toolName}"`,
            action: 'reject',
          };
        }
      }
    }
    return { ok: true };
  }
}

function extractStrings(obj: unknown, depth = 0): string[] {
  if (depth > 5) {return [];}
  if (typeof obj === 'string') {return [obj];}
  if (Array.isArray(obj)) {return obj.flatMap((v) => extractStrings(v, depth + 1));}
  if (obj !== null && typeof obj === 'object') {
    return Object.values(obj).flatMap((v) => extractStrings(v, depth + 1));
  }
  return [];
}
