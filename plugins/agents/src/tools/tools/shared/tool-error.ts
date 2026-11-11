import type { ToolResult } from '../../../contracts/index.js';

export function toolError(input: {
  code: string;
  message: string;
  retryable?: boolean;
  hint?: string;
  details?: Record<string, unknown>;
}): ToolResult {
  // Build error string that the LLM actually sees in tool results.
  // Include the hint directly — it tells the LLM what to do next,
  // preventing retry loops where the model doesn't know how to recover.
  const parts = [`${input.code}: ${input.message}`];
  if (input.hint) {
    parts.push(`\nNext step: ${input.hint}`);
  }
  if (input.retryable === false) {
    parts.push('(This error cannot be resolved by retrying the same call.)');
  }
  const error = parts.join('\n');

  return {
    success: false,
    error,
    errorDetails: {
      code: input.code,
      message: input.message,
      retryable: input.retryable,
      hint: input.hint,
      details: input.details,
    },
    metadata: {
      errorCode: input.code,
      retryable: input.retryable ?? false,
      ...(input.details || {}),
    },
  };
}

