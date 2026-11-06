import { toErrorEnvelope } from '@kb-labs/plugin-contracts';
import type { CommandFailure } from '@kb-labs/plugin-contracts';
import type { CommandError } from '@kb-labs/plugin-contracts';
import type { PlatformDiagnostic } from '@kb-labs/core-platform';

/** Render diagnostics using the exact row format shared by error envelopes. */
export function renderErrorDiagnostics(diagnostics: readonly PlatformDiagnostic[]): string[] {
  return diagnostics.map((item) =>
    `  - ${item.code} (${item.severity})${item.path ? ` ${item.path}${item.line ? `:${item.line}` : ''}` : ''}: ${item.message}${item.hint ? ` — ${item.hint}` : ''}`,
  );
}

/** Render a platform failure consistently for system and plugin CLI commands. */
export function renderErrorEnvelope(envelope: CommandError): string {
  return [
    `${envelope.message} [${envelope.code}]`,
    ...(envelope.cause ? [`  Cause: ${envelope.cause}`] : []),
    ...renderErrorDiagnostics(envelope.diagnostics ?? []),
    ...Object.entries(envelope.details ?? {}).map(([key, value]) => `  ${key}: ${value}`),
    `  Hint:  ${envelope.hint}`,
    ...(envelope.correlationId ? [`  Correlation ID: ${envelope.correlationId}`] : []),
  ].join('\n');
}

/**
 * Return a typed validation failure for the shared command renderer.
 * Call before try/catch, right before returning the command result.
 */
export function validationError(
  message: string,
  hint?: string,
): CommandFailure {
  return {
    ok: false,
    error: {
      code: 'KB_RUNTIME_INPUT_INVALID',
      message,
      hint: hint ?? 'Run the command with --help to check its required arguments.',
    },
  };
}

/**
 * Return a typed runtime/API failure for the shared command renderer.
 * Call in catch blocks, right before returning the command result.
 */
export function handleError(err: unknown, correlationId?: string): CommandFailure {
  const source = err !== null && typeof err === 'object' && 'envelope' in err ? err.envelope : err;
  const typedEnvelope = toErrorEnvelope(source, correlationId ? { correlationId } : {});
  return {
    ok: false,
    error: typedEnvelope,
  };
}

/**
 * Re-throws `err` as an HTTP-aware error for REST handlers.
 * Envelope middleware reads `err.statusCode` to set HTTP status.
 * If err already has statusCode — preserves it. Otherwise → 500.
 */
export function rethrowForRest(err: unknown): never {
  if (err !== null && typeof err === 'object' && 'statusCode' in err) {
    throw err;
  }
  const message = err instanceof Error ? err.message : String(err);
  throw Object.assign(new Error(message), {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
  });
}
