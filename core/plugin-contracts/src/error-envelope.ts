/**
 * Adapter from the V3 plugin errors (`PluginError` and subclasses) to the
 * unified error envelope (`@kb-labs/core-platform` `ErrorEnvelope`, 08-errors.md).
 * Codes that have a catalog entry use it; everything else becomes a product
 * envelope. Non-plugin errors are delegated to core-platform.
 */

import {
  createErrorEnvelope,
  createProductErrorEnvelope,
  stringifyDetails,
  toErrorEnvelope as platformToErrorEnvelope,
  type ErrorEnvelope,
  type ToEnvelopeOptions,
} from '@kb-labs/core-platform';
import { ErrorCode, PluginError, RateLimitError } from './errors.js';

export function pluginErrorToEnvelope(error: PluginError, options: ToEnvelopeOptions = {}): ErrorEnvelope {
  const details = stringifyDetails(error.details);
  const base = { ...options, cause: error.message };
  switch (error.code) {
    case ErrorCode.VALIDATION_ERROR:
      return createErrorEnvelope('KB_RUNTIME_INPUT_INVALID', { ...base, details });
    case ErrorCode.CONFIG_ERROR:
      return createErrorEnvelope('KB_CONFIG_INVALID', { ...base, details: { path: 'configuration', ...details } });
    case ErrorCode.TIMEOUT:
      return createErrorEnvelope('KB_RUNTIME_TIMEOUT', { ...base, details });
    case ErrorCode.PERMISSION_DENIED:
      return createErrorEnvelope('KB_PLUGIN_PERMISSION_DENIED', {
        ...base,
        details: { plugin: 'the plugin', permission: 'requested', ...details },
      });
    case ErrorCode.RATE_LIMIT: {
      const retryAfterMs = error instanceof RateLimitError ? error.retryAfterMs : undefined;
      return createErrorEnvelope('KB_RUNTIME_RATE_LIMITED', {
        ...base,
        details: {
          ...details,
          retryAfter: retryAfterMs === undefined ? 'a moment' : `${Math.ceil(retryAfterMs / 1000)}s`,
        },
      });
    }
    case ErrorCode.PLATFORM_ERROR:
      return createErrorEnvelope('KB_HOST_ADAPTER_UNAVAILABLE', {
        ...base,
        details: { slot: details.service ?? 'unknown', reason: error.message },
      });
    default:
      return createProductErrorEnvelope({
        ...options,
        code: error.code,
        message: error.message,
        retryable: false,
        details,
      });
  }
}

/** Convert any thrown value: plugin errors are mapped here, the rest by core-platform. */
export function toPluginErrorEnvelope(error: unknown, options: ToEnvelopeOptions = {}): ErrorEnvelope {
  return error instanceof PluginError
    ? pluginErrorToEnvelope(error, options)
    : platformToErrorEnvelope(error, options);
}
