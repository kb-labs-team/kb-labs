import axios from 'axios';
import { afterEach, describe, expect, it } from 'vitest';
import validSuccess from '@kb-labs/core-platform/contracts/ux-result/fixtures/valid/success.json';
import validFailure from '@kb-labs/core-platform/contracts/ux-result/fixtures/valid/failure.json';
import invalidFailure from '@kb-labs/core-platform/contracts/ux-result/fixtures/invalid/failure-missing-hint.json';
import invalidMixedEnvelope from '@kb-labs/core-platform/contracts/ux-result/fixtures/invalid/mixed-success-and-error.json';
import invalidSuccess from '@kb-labs/core-platform/contracts/ux-result/fixtures/invalid/success-missing-data.json';
import { gatewayBaseFromApiBase, HttpClient } from '../http-client.js';
import { createEnvelopeInterceptor } from '../envelope-interceptor.js';

const originalAdapter = axios.defaults.adapter;

afterEach(() => {
  axios.defaults.adapter = originalAdapter;
});

function respondWith(data: unknown, status = 200): void {
  axios.defaults.adapter = async (config) => ({
    data,
    status,
    statusText: status === 200 ? 'OK' : 'Service Unavailable',
    headers: {},
    config,
  });
}

describe('Studio API client UX result envelope', () => {
  it('derives a gateway base from the versioned API base for streaming routes', () => {
    expect(gatewayBaseFromApiBase('/api/v1')).toBe('');
    expect(gatewayBaseFromApiBase('https://gateway.test/api/v1')).toBe('https://gateway.test');
    expect(gatewayBaseFromApiBase('https://gateway.test/kb/api/v1')).toBe('https://gateway.test/kb');
  });
  // case: S-203.5
  it('unwraps the shared valid success fixture', async () => {
    respondWith(validSuccess);

    await expect(new HttpClient().fetch('/fixture')).resolves.toEqual(validSuccess.data);
  });

  it('decodes a success envelope for routes that require the UX result contract', async () => {
    respondWith(validSuccess);

    await expect(new HttpClient().fetchUx('/fixture')).resolves.toEqual(validSuccess.data);
  });

  // case: S-203.1
  it('rejects a raw success body for a route that requires the UX envelope', async () => {
    respondWith({ status: 'healthy' });

    await expect(new HttpClient().fetchUx('/health')).rejects.toMatchObject({
      code: 'KB_RUNTIME_UNEXPECTED',
      correlationId: expect.any(String),
    });
  });

  // case: S-203.1
  it('rejects a raw not-ready error body for a route that requires the UX envelope', async () => {
    respondWith({ ready: false, reason: 'upstream unavailable' }, 503);

    await expect(new HttpClient().fetchUx('/ready')).rejects.toMatchObject({
      code: 'KB_RUNTIME_UNEXPECTED',
      status: 503,
      correlationId: expect.any(String),
    });
  });

  // case: S-203.5
  it('preserves the typed shared error fields from a valid failure fixture', async () => {
    respondWith(validFailure);

    await expect(new HttpClient().fetch('/fixture')).rejects.toMatchObject({
      code: validFailure.error.code,
      message: validFailure.error.message,
      hint: validFailure.error.hint,
      correlationId: validFailure.error.correlationId,
    });
  });

  it('validates failure codes and preserves ADR-0049 product errors', async () => {
    respondWith({ ok: false, error: {
      code: 'KB_FAKE', area: 'product', stage: 'run', severity: 'error', retryable: false,
      message: 'Forged platform error.', hint: 'Retry the request.',
    } });
    await expect(new HttpClient().fetch('/fixture')).rejects.toMatchObject({
      code: 'KB_PLUGIN_CONTRACT_VIOLATION',
    });

    respondWith({ ok: false, error: {
      code: 'COMMIT_PUSH_REJECTED', area: 'product', stage: 'run', severity: 'error', retryable: false,
      message: 'The remote rejected the push.', hint: 'Fetch the latest changes, resolve conflicts, then retry.',
      details: { remote: 'origin' }, correlationId: 'corr-product',
    } });
    await expect(new HttpClient().fetch('/fixture')).rejects.toMatchObject({
      code: 'COMMIT_PUSH_REJECTED',
      message: 'The remote rejected the push.',
      hint: 'Fetch the latest changes, resolve conflicts, then retry.',
      correlationId: 'corr-product',
    });
  });

  // case: S-005.5
  it('maps an authorization denial from the shared envelope without legacy permission fields', async () => {
    respondWith({ ok: false, error: {
      code: 'KB_AUTH_FORBIDDEN', area: 'auth', stage: 'run', severity: 'error', retryable: false,
      message: 'Permission denied: users:read', hint: 'Ask your administrator for the permission needed to perform this operation.',
      details: { permission: 'users:read' },
    } });

    await expect(new HttpClient().fetch('/api/v1/auth/users')).rejects.toMatchObject({
      code: 'KB_AUTH_FORBIDDEN', message: 'Permission denied: users:read',
      hint: 'Ask your administrator for the permission needed to perform this operation.',
    });
  });

  // case: S-203.5
  it('maps each invalid shared fixture to a safe typed error', async () => {
    for (const fixture of [invalidFailure, invalidMixedEnvelope, invalidSuccess]) {
      respondWith(fixture);
      await expect(new HttpClient().fetch('/fixture')).rejects.toMatchObject({
        code: 'KB_RUNTIME_UNEXPECTED',
        message: 'The operation failed unexpectedly.',
        hint: 'Copy diagnostics and contact support.',
        correlationId: expect.any(String),
      });
    }
    expect(invalidFailure.error.correlationId).toBe('corr-203-3');
  });
});

describe('Studio response-envelope interceptor', () => {
  it('canonicalizes an unknown platform code before returning a failure response', async () => {
    const interceptor = createEnvelopeInterceptor();
    const response = new Response(JSON.stringify({
      ok: false,
      error: {
        code: 'KB_FAKE', area: 'product', stage: 'run', severity: 'error', retryable: false,
        message: 'forged', hint: 'forged',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const canonical = await interceptor(response);
    expect(await canonical.json()).toMatchObject({ ok: false, error: { code: 'KB_PLUGIN_CONTRACT_VIOLATION' } });
  });
});
