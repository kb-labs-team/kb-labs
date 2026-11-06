import { createErrorEnvelope, getCatalogEntry, isErrorCode, toErrorEnvelope, type ErrorCode, type ErrorEnvelope } from '../error-envelope/index.js';
import type { CatalogDetailsFor } from '../error-envelope/error-codes.generated.js';
import { createUxFailureResult, type UxFailureResult } from '../ux-result/index.js';

export interface HttpFailureOptions {
  correlationId: string;
  statusCode: number;
  /** Byte limit enforced by the boundary that produced this HTTP failure. */
  limitBytes?: number;
}

export function statusForHttpFailure(payload: unknown, transportStatusCode: number): number {
  const parts = failureParts(payload, transportStatusCode);
  if (!parts.cataloguedPayload || !isErrorCode(parts.code)) return transportStatusCode;

  const entry = getCatalogEntry(parts.code);
  return entry.httpStatus;
}

interface HttpFailureParts {
  code: ErrorCode;
  cataloguedPayload: boolean;
  error: ErrorEnvelope;
}

function failureParts(payload: unknown, statusCode: number, limitBytes?: number): HttpFailureParts {
  if (payload instanceof Error && payload.name === 'AbortError') {
    const error = createErrorEnvelope('KB_RUNTIME_REQUEST_CANCELLED');
    return { code: error.code, cataloguedPayload: true, error };
  }
  const nested = payload && typeof payload === 'object' && 'error' in payload ? payload.error : undefined;
  const candidate = hasCode(nested) ? nested : hasCode(payload) ? payload : undefined;
  if (candidate !== undefined) {
    if (statusCode === 413 && isErrorCode(candidate.code)) {
      const code = fallbackCodeForStatus(statusCode);
      return { code, cataloguedPayload: false, error: createFallbackError(code, limitBytes) };
    }
    const error = toErrorEnvelope(candidate);
    if (statusCode !== 413 || error.area === 'product') {
      const details = statusCode === 400 && !isErrorCode(candidate.code) ? validationDetails(payload) : undefined;
      const normalizedError = details && error.code === 'KB_RUNTIME_INPUT_INVALID'
        ? createErrorEnvelope('KB_RUNTIME_INPUT_INVALID', {
          message: error.message,
          hint: error.hint,
          correlationId: error.correlationId,
          details,
        })
        : error;
      return { code: normalizedError.code, cataloguedPayload: isErrorCode(candidate.code), error: normalizedError };
    }
    const code = fallbackCodeForStatus(statusCode);
    return { code, cataloguedPayload: false, error: createFallbackError(code, limitBytes) };
  }
  const code = fallbackCodeForStatus(statusCode);
  return { code, cataloguedPayload: false, error: createFallbackError(code, limitBytes, validationDetails(payload)) };
}

function validationDetails(payload: unknown): Record<string, string> | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const source = payload as Record<string, unknown>;
  const candidates = Array.isArray(source.validation) ? source.validation
    : Array.isArray(source.issues) ? source.issues
      : [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const issue = candidate as Record<string, unknown>;
    const path = Array.isArray(issue.path) ? issue.path.filter((part): part is string | number =>
      typeof part === 'string' || typeof part === 'number')
      : typeof issue.instancePath === 'string' ? issue.instancePath.split('/').filter(Boolean)
        : typeof issue.dataPath === 'string' ? issue.dataPath.split('.').filter(Boolean)
          : [];
    if (path.length) return { field: path.map(String).join('.') };
  }
  return undefined;
}

type FallbackErrorCode = ReturnType<typeof fallbackCodeForStatus>;
type FallbackErrorDetails = CatalogDetailsFor[FallbackErrorCode];

function createFallbackError(
  code: FallbackErrorCode,
  limitBytes?: number,
  details?: FallbackErrorDetails,
): ErrorEnvelope {
  if (code === 'KB_RUNTIME_INPUT_INVALID') {
    return createErrorEnvelope(code, details ? { details } : {});
  }
  if (code === 'KB_AUTH_REQUIRED') {
    return createErrorEnvelope(code, {
      message: 'Authentication is required.',
      hint: 'Run `kb auth login --help` to configure Gateway authentication, then retry.',
      details: { gatewayUrl: 'the configured Gateway URL' },
    });
  }
  if (code === 'KB_AUTH_FORBIDDEN') {
    return createErrorEnvelope(code, {
      message: 'Permission denied.',
      hint: 'Ask your administrator for permission to perform the requested operation.',
      details: { permission: 'the requested operation' },
    });
  }
  if (code !== 'KB_RUNTIME_PAYLOAD_TOO_LARGE') return createErrorEnvelope(code);
  if (limitBytes === undefined) {
    return createErrorEnvelope(code, { details: { limit: 'the configured receiving-service limit' } });
  }
  return createErrorEnvelope(code, { details: { limit: formatByteLimit(limitBytes), limitBytes: String(limitBytes) } });
}

function formatByteLimit(limitBytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = limitBytes;
  let unitIndex = 0;
  while (size >= 1024 && size % 1024 === 0 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size} ${units[unitIndex]}`;
}

function fallbackCodeForStatus(statusCode: number) {
  return statusCode === 401 ? 'KB_AUTH_REQUIRED'
    : statusCode === 403 ? 'KB_AUTH_FORBIDDEN'
      : statusCode === 400 ? 'KB_RUNTIME_INPUT_INVALID'
        : statusCode === 413 ? 'KB_RUNTIME_PAYLOAD_TOO_LARGE'
          : 'KB_RUNTIME_UNEXPECTED';
}

function hasCode(value: unknown): value is Record<string, unknown> & { code: string } {
  return typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string';
}

/** Select the catalog code for an HTTP failure without constructing its result envelope. */
export function codeForHttpFailure(payload: unknown, statusCode: number): ErrorCode {
  return failureParts(payload, statusCode).code;
}

/** Convert every HTTP failure shape to the ADR-0049 error result once. */
export function normalizeHttpFailure(payload: unknown, options: HttpFailureOptions): UxFailureResult {
  const parts = failureParts(payload, options.statusCode, options.limitBytes);
  const error = { ...parts.error, correlationId: parts.error.correlationId || options.correlationId };
  return createUxFailureResult(error);
}
