/**
 * SecretRedactionGuard — scrubs secrets from tool output before it enters context.
 *
 * Runs on validateOutput only (secrets are typically in responses, not inputs).
 * Sanitizes rather than rejects — the tool call still succeeds, but with
 * the sensitive value replaced so it never reaches the LLM context window.
 */

import type { ToolGuard, ValidationResult, ToolExecCtx } from '../../sdk/index.js';

interface SecretPattern {
  name: string;
  pattern: RegExp;
  replacement: string | ((match: string, ...args: string[]) => string);
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: 'openai-key',
    pattern: /sk-[A-Za-z0-9_-]{20,}/g,
    replacement: '[REDACTED:openai-key]',
  },
  {
    name: 'anthropic-key',
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    replacement: '[REDACTED:anthropic-key]',
  },
  {
    name: 'aws-access-key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED:aws-access-key]',
  },
  {
    name: 'aws-secret-key',
    // 40-char base64-ish after common assignment patterns
    pattern: /(?:aws[_-]?secret[_-]?(?:access[_-]?)?key|AWS_SECRET)[^\n"']*["'\s=:]+([A-Za-z0-9/+]{40})/gi,
    replacement: '[REDACTED:aws-secret]',
  },
  {
    name: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36}\b/g,
    replacement: '[REDACTED:github-token]',
  },
  {
    name: 'generic-token',
    // Covers "token: <value>", "api_key: <value>", etc. in YAML/JSON/env output
    pattern: /(?:(?:api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|secret[_-]?key)[^\n"']{0,20}["'\s=:]+)([A-Za-z0-9_\-./+]{32,})/gi,
    replacement: (match: string, capture: string) => match.replace(capture, '[REDACTED]'),
  },
];

export class SecretRedactionGuard implements ToolGuard {
  readonly name = 'secret-redaction';

  validateOutput(
    _toolName: string,
    output: string,
    _ctx: ToolExecCtx,
  ): ValidationResult {
    let result = output;
    let redacted = false;

    for (const { pattern, replacement } of SECRET_PATTERNS) {
      const before = result;
      if (typeof replacement === 'string') {
        result = result.replace(pattern, replacement);
      } else {
        result = result.replace(pattern, replacement as (match: string, ...args: string[]) => string);
      }
      if (result !== before) {redacted = true;}
    }

    if (redacted) {
      return { ok: false, reason: 'secrets redacted from output', action: 'sanitize', sanitized: result };
    }
    return { ok: true };
  }
}
