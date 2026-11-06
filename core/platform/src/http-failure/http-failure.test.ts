import { describe, expect, it } from 'vitest';
import { createErrorEnvelope, createProductErrorEnvelope, toErrorEnvelope } from '../error-envelope/index.js';
import { createUxFailureResult } from '../ux-result/index.js';
import { codeForHttpFailure, normalizeHttpFailure, statusForHttpFailure } from './index.js';

describe('shared HTTP failure boundary', () => {
  it('preserves catalogued error details and derives its status from the error catalog', () => {
    const error = createErrorEnvelope('KB_PROJECT_UNKNOWN', {
      message: 'Project missing',
      hint: 'Register the project first.',
      details: { path: 'project-1' },
    });

    expect(statusForHttpFailure({ error }, 500)).toBe(404);
    expect(codeForHttpFailure({ error }, 500)).toBe('KB_PROJECT_UNKNOWN');
    expect(normalizeHttpFailure({ error }, { correlationId: 'request-1', statusCode: 500 })).toEqual({
      ok: false,
      error: { ...error, correlationId: 'request-1' },
    });
  });

  it('retains the failing field for structured HTTP validation errors', () => {
    const result = normalizeHttpFailure({
      code: 'FST_ERR_VALIDATION',
      statusCode: 400,
      validation: [{
        instancePath: '/events',
        schemaPath: '#/properties/events/maxItems',
        keyword: 'maxItems',
        params: { limit: 500 },
        message: 'must NOT have more than 500 items',
      }],
    }, { correlationId: 'request-validation', statusCode: 400 });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_RUNTIME_INPUT_INVALID',
        correlationId: 'request-validation',
        details: { field: 'events' },
      },
    });
  });

  it('normalizes a plain known code and rejects a catalog code without an HTTP status', () => {
    expect(normalizeHttpFailure({ error: { code: 'KB_RUNTIME_INPUT_INVALID' } }, { correlationId: 'request-2', statusCode: 500 })).toMatchObject({
      ok: false,
      error: { code: 'KB_RUNTIME_INPUT_INVALID', correlationId: 'request-2' },
    });
    expect(normalizeHttpFailure(new Error('private'), { correlationId: 'request-3', statusCode: 500 }).error).toMatchObject({
      code: 'KB_RUNTIME_UNEXPECTED', correlationId: 'request-3',
    });

    expect(statusForHttpFailure(new Error('upstream'), 502)).toBe(502);
    expect(statusForHttpFailure({ code: 'KB_AUTH_CLOCK_SKEW' }, 401)).toBe(500);
  });

  it('classifies an aborted HTTP request as a warning-level client cancellation', () => {
    const abort = new DOMException('Request aborted', 'AbortError');
    const failure = normalizeHttpFailure(abort, { correlationId: 'request-aborted', statusCode: 500 });

    expect(codeForHttpFailure(abort, 500)).toBe('KB_RUNTIME_REQUEST_CANCELLED');
    expect(statusForHttpFailure(abort, 500)).toBe(499);
    expect(failure.error).toMatchObject({
      code: 'KB_RUNTIME_REQUEST_CANCELLED',
      severity: 'warning',
      correlationId: 'request-aborted',
    });
  });

  it('preserves a validated product failure and keeps the transport HTTP status', () => {
    const failure = createUxFailureResult(createProductErrorEnvelope({
      code: 'COMMIT_PUSH_REJECTED',
      message: 'The remote rejected the push.',
      hint: 'Fetch the latest changes, resolve conflicts, then retry.',
      retryable: false,
    }));

    expect(statusForHttpFailure(failure, 409)).toBe(409);
    expect(normalizeHttpFailure(failure, { correlationId: 'request-product', statusCode: 409 })).toMatchObject({
      ok: false,
      error: {
        code: 'COMMIT_PUSH_REJECTED',
        area: 'product',
        message: 'The remote rejected the push.',
        hint: 'Fetch the latest changes, resolve conflicts, then retry.',
        correlationId: 'request-product',
      },
    });
  });

  it.each([
    {
      code: 'KB_FAKE',
      area: 'product',
      stage: 'run',
      severity: 'error',
      retryable: false,
      message: 'Forged platform error.',
      hint: 'Retry the request.',
    },
    {
      code: 'COMMIT_INVALID_DETAILS',
      area: 'product',
      stage: 'run',
      severity: 'error',
      retryable: false,
      message: 'Product error with serialized details.',
      hint: 'Keep details flat.',
      details: { report: '{"invalid":"nested"}' },
    },
  ])('validates a failure-shaped HTTP payload before preserving it', (error) => {
    const result = normalizeHttpFailure(
      { ok: false, error },
      { correlationId: 'request-untrusted', statusCode: 422 },
    );

    expect(result.error.code).toBe('KB_PLUGIN_CONTRACT_VIOLATION');
    expect(result.error.message).not.toBe(error.message);
    expect(statusForHttpFailure({ ok: false, error }, 422)).toBe(422);
  });

  it.each([
    [401, 'KB_AUTH_REQUIRED'],
    [403, 'KB_AUTH_FORBIDDEN'],
    [400, 'KB_RUNTIME_INPUT_INVALID'],
    [413, 'KB_RUNTIME_PAYLOAD_TOO_LARGE'],
    [404, 'KB_RUNTIME_UNEXPECTED'],
    [502, 'KB_RUNTIME_UNEXPECTED'],
  ])('derives a catalog fallback code for an uncatalogued HTTP %i failure', (statusCode, code) => {
    expect(codeForHttpFailure(new Error('upstream'), statusCode)).toBe(code);
  });

  it('renders a known boundary limit and a size-free hint when the limit is unknown', () => {
    const gateway = normalizeHttpFailure(new Error('too large'), {
      correlationId: 'gateway-limit', statusCode: 413, limitBytes: 1024 * 1024,
    });
    expect(gateway.error).toMatchObject({
      code: 'KB_RUNTIME_PAYLOAD_TOO_LARGE',
      message: 'The request body exceeds 1 MiB.',
      hint: 'Reduce the request body to 1 MiB and resend it.',
      details: { limitBytes: '1048576' },
    });

    const nonUnitLimit = normalizeHttpFailure(new Error('too large'), {
      correlationId: 'non-unit-limit', statusCode: 413, limitBytes: 1025,
    });
    expect(nonUnitLimit.error.message).toBe('The request body exceeds 1025 B.');

    const upstream = normalizeHttpFailure(new Error('upstream limit'), {
      correlationId: 'unknown-limit', statusCode: 413,
    });
    expect(upstream.error).toMatchObject({
      code: 'KB_RUNTIME_PAYLOAD_TOO_LARGE',
      message: 'The request body exceeds the configured receiving-service limit.',
      hint: 'Reduce the request body to the configured receiving-service limit and resend it.',
    });
    expect(`${upstream.error.message} ${upstream.error.hint}`).not.toMatch(/\b\d+(?:\.\d+)?\s*(?:B|KiB|MiB|GiB)\b/);

    const typedWithoutLimit = normalizeHttpFailure({ error: { code: 'KB_RUNTIME_PAYLOAD_TOO_LARGE' } }, {
      correlationId: 'typed-unknown-limit', statusCode: 413,
    });
    expect(typedWithoutLimit.error).toMatchObject({
      message: 'The request body exceeds the configured receiving-service limit.',
      hint: 'Reduce the request body to the configured receiving-service limit and resend it.',
    });
  });

  it('maps framework validation and operating-system errors without treating their codes as product codes', () => {
    expect(toErrorEnvelope(Object.assign(new Error('invalid request'), {
      code: 'FST_ERR_VALIDATION',
      statusCode: 400,
      validation: [{ keyword: 'required' }],
    })).code).toBe('KB_RUNTIME_INPUT_INVALID');
    expect(toErrorEnvelope(Object.assign(new Error('connect failed'), {
      code: 'ECONNREFUSED',
      errno: -61,
      syscall: 'connect',
    })).code).toBe('KB_RUNTIME_UNEXPECTED');
  });
});
