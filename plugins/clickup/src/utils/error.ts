import type { CommandFailure } from '@kb-labs/sdk';
import { ClickUpApiError } from '../core/index.js';

export { validationError } from '@kb-labs/sdk';

function apiHint(err: ClickUpApiError): string {
  switch (err.status) {
    case 401: return 'CLICKUP_API_KEY is invalid or expired — check the token in your environment';
    case 403: return 'You don\'t have permission for this action in ClickUp — check workspace access';
    case 404: return 'Resource not found — verify the ID is correct (use `kb clickup workspace show` to browse IDs)';
    case 429: return 'ClickUp rate limit reached — wait a moment and retry';
    default:  return 'Unexpected ClickUp API error';
  }
}

/**
 * Build a typed command failure for the shared CLI result renderer.
 */
export function handleError(err: unknown): CommandFailure {
  if (err instanceof ClickUpApiError) {
    const hint = apiHint(err);
    return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: err.message, hint, details: { clickUpStatus: String(err.status), clickUpCode: err.code } } };
  }

  const message = err instanceof Error ? err.message : String(err);
  const isEnvMissing = /CLICKUP_API_KEY|CLICKUP_TEAM_ID/.test(message);
  if (isEnvMissing) {
    return {
      ok: false,
      error: {
        code: 'KB_RUNTIME_INPUT_INVALID',
        message,
        details: { field: 'CLICKUP_API_KEY or CLICKUP_TEAM_ID' },
        hint: 'Set CLICKUP_API_KEY and CLICKUP_TEAM_ID as environment variables, then retry.',
      },
    };
  }
  return {
    ok: false,
    error: {
      code: 'KB_RUNTIME_COMMAND_FAILED',
      message,
      hint: 'Run `kb clickup --help` to review command inputs and retry.',
    },
  };
}

/**
 * Re-throws `err` as an HTTP-aware error for REST handlers.
 * `ClickUpApiError` → preserves HTTP status code; env errors → 400; others → 500.
 * The envelope middleware in rest-api reads `err.statusCode` to set the response status.
 */
export function rethrowForRest(err: unknown): never {
  if (err instanceof ClickUpApiError) {
    const hint = apiHint(err);
    const restErr = Object.assign(new Error(err.message), {
      statusCode: err.status,
      code: err.code,
      details: { hint },
    });
    throw restErr;
  }
  const message = err instanceof Error ? err.message : String(err);
  const isEnvMissing = /CLICKUP_API_KEY|CLICKUP_TEAM_ID/.test(message);
  if (isEnvMissing) {
    throw Object.assign(new Error(message), {
      statusCode: 400,
      code: 'ENV_MISSING',
      details: { hint: 'Set CLICKUP_API_KEY (and CLICKUP_TEAM_ID for workspace commands) as environment variables' },
    });
  }
  throw err;
}
