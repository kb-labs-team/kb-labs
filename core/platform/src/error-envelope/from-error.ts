/**
 * @module @kb-labs/core-platform/error-envelope/from-error
 *
 * Adapter from platform-level error classes to the unified envelope.
 * Errors defined in higher layers (command-kit's `PluginError`,
 * `ValidationError`, `ServiceNotConfiguredError`) are adapted by
 * `@kb-labs/shared-command-kit`, and plugin-contracts errors by
 * `@kb-labs/plugin-contracts`; both delegate here for the rest.
 */

import { AdapterUnavailableError } from '../errors.js';
import { createErrorEnvelope, type CreateEnvelopeOptions } from './catalog.js';
import type { ErrorEnvelope } from './types.js';

export type ToEnvelopeOptions = Pick<CreateEnvelopeOptions, 'correlationId' | 'actions' | 'docs'>;

/** Convert any thrown value to an envelope. Unknown values become `KB_RUNTIME_UNEXPECTED`. */
export function toErrorEnvelope(error: unknown, options: ToEnvelopeOptions = {}): ErrorEnvelope {
  if (error instanceof AdapterUnavailableError) {
    if (error.reason === 'load-failed') {
      return createErrorEnvelope('KB_HOST_ADAPTER_UNAVAILABLE', {
        ...options,
        cause: error.message,
        details: { slot: error.slot, reason: error.reason },
      });
    }
    return createErrorEnvelope('KB_ADAPTER_NOT_CONFIGURED', {
      ...options,
      cause: error.message,
      details: { service: error.slot, adapter: `adapters.${error.slot}` },
    });
  }
  return createErrorEnvelope('KB_RUNTIME_UNEXPECTED', {
    ...options,
    cause: error instanceof Error ? error.message : String(error),
  });
}

/** Statuses (HTTP-style) that a caller can reasonably retry. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export const PRODUCT_FALLBACK_HINT =
  'Run the command again with --debug for details; if it persists, include the correlationId in a report.';

export function isRetryableStatus(statusCode: number): boolean {
  return RETRYABLE_STATUS.has(statusCode);
}

/** Coerce a plugin-supplied code into the stable `<PLUGIN>_<CONDITION>` shape. */
export function normalizeProductCode(code: string): string {
  const upper = code
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const candidate = /^[A-Z]/.test(upper) ? upper : `PLUGIN_${upper}`;
  return candidate.includes('_') ? candidate : `PLUGIN_${candidate}`;
}

/** Stringify arbitrary plugin details into the envelope's string-only `details`. */
export function stringifyDetails(details: Record<string, unknown> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(details ?? {})) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === 'string') {
      result[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = String(value);
    } else {
      try {
        result[key] = JSON.stringify(value) ?? String(value);
      } catch {
        result[key] = String(value);
      }
    }
  }
  return result;
}

export interface ProductErrorInput extends ToEnvelopeOptions {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, string>;
  /** Defaults to a generic hint; product plugins should supply their own. */
  hint?: string;
}

/** Envelope for a product-plugin code that is not in the platform catalog. */
export function createProductErrorEnvelope(input: ProductErrorInput): ErrorEnvelope {
  const envelope: ErrorEnvelope = {
    code: normalizeProductCode(input.code),
    area: 'product',
    stage: 'run',
    severity: 'error',
    retryable: input.retryable,
    message: input.message,
    hint: input.hint ?? PRODUCT_FALLBACK_HINT,
  };
  if (input.details && Object.keys(input.details).length > 0) {
    envelope.details = input.details;
  }
  if (input.correlationId) {
    envelope.correlationId = input.correlationId;
  }
  if (input.actions && input.actions.length > 0) {
    envelope.actions = input.actions;
  }
  if (input.docs) {
    envelope.docs = input.docs;
  }
  return envelope;
}
