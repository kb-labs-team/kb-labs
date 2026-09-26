/**
 * @module @kb-labs/shared-command-kit/errors/envelope
 *
 * Adapter that turns the error classes used by command-kit into the unified
 * error envelope (see `@kb-labs/core-platform` `ErrorEnvelope`, 08-errors.md).
 * Platform-level errors (`AdapterUnavailableError`, unknown values) are
 * delegated to `toErrorEnvelope` from core-platform.
 */

import {
  createErrorEnvelope,
  createProductErrorEnvelope,
  getCatalogEntry,
  isRetryableStatus,
  stringifyDetails,
  toErrorEnvelope as platformToErrorEnvelope,
  type ErrorEnvelope,
  type ToEnvelopeOptions,
} from '@kb-labs/core-platform';
import { ServiceNotConfiguredError } from '../helpers/platform';
import { ValidationError } from '../helpers/validation';
import { PluginError } from './factory';

function pluginErrorToEnvelope(error: PluginError, options: ToEnvelopeOptions): ErrorEnvelope {
  const details = { ...stringifyDetails(error.details), statusCode: String(error.statusCode) };
  const entry = getCatalogEntry(error.errorCode);
  if (entry) {
    return createErrorEnvelope(entry.code, { ...options, cause: error.message, details });
  }
  return createProductErrorEnvelope({
    ...options,
    code: error.errorCode,
    message: error.message,
    retryable: isRetryableStatus(error.statusCode),
    details,
  });
}

/**
 * Convert any error used in the TS platform to the unified envelope:
 * `PluginError`, `ValidationError`, `ServiceNotConfiguredError`,
 * `AdapterUnavailableError`; anything else becomes `KB_RUNTIME_UNEXPECTED`.
 */
export function toErrorEnvelope(error: unknown, options: ToEnvelopeOptions = {}): ErrorEnvelope {
  if (error instanceof PluginError) {
    return pluginErrorToEnvelope(error, options);
  }
  if (error instanceof ServiceNotConfiguredError) {
    return createErrorEnvelope('KB_ADAPTER_NOT_CONFIGURED', {
      ...options,
      cause: error.message,
      details: {
        service: error.service,
        adapter: error.requiredAdapter ?? `adapters.${error.service}`,
      },
    });
  }
  if (error instanceof ValidationError) {
    const details: Record<string, string> = {};
    for (const issue of error.issues ?? []) {
      details[issue.path === '' ? 'value' : issue.path] = issue.message;
    }
    return createErrorEnvelope('KB_RUNTIME_INPUT_INVALID', {
      ...options,
      cause: error.message,
      details,
    });
  }
  return platformToErrorEnvelope(error, options);
}
