import type { CommandFailure } from '@kb-labs/sdk';
import { InboxError, type InboxErrorCode } from '../core/index.js';

// HTTP status codes for REST layer
const REST_STATUS: Record<InboxErrorCode, number> = {
  ENV_MISSING:            400,
  ACCOUNT_NOT_FOUND:      400,
  IMAP_AUTH_FAILED:       401,
  IMAP_CONNECT_FAILED:    503,
  IMAP_TIMEOUT:           504,
  IMAP_MAILBOX_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND:      404,
  SMTP_AUTH_FAILED:       401,
  SMTP_CONNECT_FAILED:    503,
  SMTP_INVALID_RECIPIENT: 400,
  VALIDATION_ERROR:       400,
  INTERNAL_ERROR:         500,
};

// Human-readable hints per error code
function getHint(code: InboxErrorCode, message: string): string | undefined {
  switch (code) {
    case 'ENV_MISSING':
      return 'Set INBOX_ACCOUNTS=work,personal and account vars (INBOX_ACCOUNT_WORK_USER, _PASS, _IMAP_HOST, _SMTP_HOST)';
    case 'ACCOUNT_NOT_FOUND':
      return `Use kb inbox account list to see configured accounts, then pass the name with --account`;
    case 'IMAP_AUTH_FAILED':
      return 'Create an app-password in Yandex ID settings (yandex.ru/id) and set it as INBOX_ACCOUNT_<NAME>_PASS';
    case 'IMAP_CONNECT_FAILED':
      return `Check INBOX_ACCOUNT_<NAME>_IMAP_HOST and _IMAP_PORT, and that the server is reachable`;
    case 'IMAP_TIMEOUT':
      return 'Server did not respond in time — try again in a moment';
    case 'IMAP_MAILBOX_NOT_FOUND':
      return 'Run kb inbox folder list --account <name> to see available folders';
    case 'MESSAGE_NOT_FOUND':
      return 'The uid may be stale — refresh with: kb inbox list';
    case 'SMTP_AUTH_FAILED':
      return 'Create an app-password in Yandex ID settings and set it as INBOX_ACCOUNT_<NAME>_PASS';
    case 'SMTP_CONNECT_FAILED':
      return 'Check INBOX_ACCOUNT_<NAME>_SMTP_HOST and _SMTP_PORT';
    case 'SMTP_INVALID_RECIPIENT':
      return 'Verify the --to address is a valid email';
    case 'VALIDATION_ERROR':
      return undefined; // message itself is descriptive enough
    case 'INTERNAL_ERROR':
      return undefined;
    default: {
      const _: never = code;
      void _;
      return undefined;
    }
  }
}

/**
 * Build a structured failure for the shared CLI result renderer.
 */
export function handleError(err: unknown): CommandFailure {
  if (err instanceof InboxError) {
    const hint = getHint(err.code, err.message);
    if (err.code === 'ENV_MISSING' || err.code === 'ACCOUNT_NOT_FOUND' || err.code === 'VALIDATION_ERROR') {
      return {
        ok: false,
        error: {
          code: 'KB_RUNTIME_INPUT_INVALID',
          message: err.message,
          hint: hint ?? 'Run `kb inbox --help` to review command inputs and retry.',
          details: { field: err.code, inboxCode: err.code },
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'KB_RUNTIME_COMMAND_FAILED',
        message: err.message,
        hint: hint ?? 'Run `kb inbox --help` to review command inputs and retry.',
        details: { inboxCode: err.code },
      },
    };
  }

  // Unknown error
  const message = err instanceof Error ? err.message : String(err);

  return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message, hint: 'Run `kb inbox --help` to review command inputs and retry.' } };
}

/**
 * Re-throws err as an HTTP-aware error for REST handlers.
 * InboxError → preserves HTTP status; others → 500.
 */
export function rethrowForRest(err: unknown): never {
  if (err instanceof InboxError) {
    const hint = getHint(err.code, err.message);
    throw Object.assign(new Error(err.message), {
      statusCode: REST_STATUS[err.code] ?? 500,
      code: err.code,
      details: hint ? { hint } : undefined,
    });
  }

  const message = err instanceof Error ? err.message : String(err);
  throw Object.assign(new Error(message), {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
  });
}
