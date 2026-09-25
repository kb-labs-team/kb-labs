/**
 * @module @kb-labs/core-platform/error-envelope/catalog
 *
 * Typed access to `errors.catalog.json` (the data source for platform error
 * codes) and the helper that builds an envelope from a catalog code.
 */

import catalogData from './errors.catalog.json';
import type {
  ErrorAction,
  ErrorCatalog,
  ErrorCatalogEntry,
  ErrorEnvelope,
} from './types.js';

// The JSON is validated structurally by the catalog lint test; the cast keeps
// the literal union types (area, severity) that JSON inference widens to string.
export const errorCatalog = catalogData as unknown as ErrorCatalog;

const byCode = new Map<string, ErrorCatalogEntry>(
  errorCatalog.codes.map((entry) => [entry.code, entry]),
);

export function getCatalogEntry(code: string): ErrorCatalogEntry | undefined {
  return byCode.get(code);
}

/** Fills `{name}` placeholders from `values`; a missing value renders as "unknown". */
export function renderTemplate(template: string, values: Readonly<Record<string, string>> = {}): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key: string) => values[key] ?? 'unknown');
}

export interface CreateEnvelopeOptions {
  /** Template values and structured details (must be secret-free). */
  details?: Record<string, string>;
  cause?: string;
  correlationId?: string;
  actions?: ErrorAction[];
  docs?: string;
}

/** Builds an envelope from a catalog code. Throws for a code that is not in the catalog. */
export function createErrorEnvelope(code: string, options: CreateEnvelopeOptions = {}): ErrorEnvelope {
  const entry = byCode.get(code);
  if (!entry) {
    throw new Error(`Unknown error code "${code}": add it to errors.catalog.json`);
  }
  const details = options.details ?? {};
  const envelope: ErrorEnvelope = {
    code: entry.code,
    area: entry.area,
    stage: entry.stage,
    severity: entry.severity,
    retryable: entry.retryable,
    message: renderTemplate(entry.message, details),
    hint: renderTemplate(entry.hint, details),
  };
  if (options.cause) {
    envelope.cause = options.cause;
  }
  if (options.actions && options.actions.length > 0) {
    envelope.actions = options.actions;
  }
  if (options.docs) {
    envelope.docs = options.docs;
  }
  if (options.correlationId) {
    envelope.correlationId = options.correlationId;
  }
  if (Object.keys(details).length > 0) {
    envelope.details = details;
  }
  return envelope;
}
