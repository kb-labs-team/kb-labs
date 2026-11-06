import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: null as null | { gatewayUrl: string; accessToken: string; refreshToken: string; expiresAt: number },
  machine: null as null | { gatewayUrl: string; accessToken: string; refreshToken: string; expiresAt: number },
  loadError: null as unknown,
}));
vi.mock('../../gateway/session.js', () => ({
  SessionManager: class {
    async load() { if (mocks.loadError) throw mocks.loadError; return mocks.session; }
    async save() {}
    async clear() {}
    getFilePath() { return '/tmp/session.json'; }
  },
}));
vi.mock('../../gateway/credentials.js', () => ({
  CredentialsManager: class {
    async load() { return mocks.machine; }
    async save() {}
    async clear() {}
  },
}));


import { gatewayApiFetch } from '../../gateway/api-client.js';
import { AuthSessionOwner } from '../../gateway/auth-session.js';
import { decodeGatewayFailure, readGatewaySuccessData } from '../../gateway/result.js';
import { SavedAuthFileError } from '../../gateway/saved-auth-file.js';
import { createErrorEnvelope, ErrorEnvelopeError } from '@kb-labs/core-platform';

describe('gatewayApiFetch auth mapping', () => {
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    mocks.session = null; mocks.machine = null; mocks.loadError = null;
  });

  it('delegates REST credential selection to the auth-session owner', async () => {
    const load = vi.spyOn(AuthSessionOwner.prototype, 'load').mockResolvedValue(null);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));

    await gatewayApiFetch('https://gateway.test/api');

    expect(load).toHaveBeenCalledWith('either', undefined);
  });

  it('maps a non-envelope 403 body to an honest Gateway protocol error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret internal response', { status: 403 })));

    await expect(gatewayApiFetch('https://gateway.test/api')).rejects.toMatchObject({
      envelope: {
        code: 'KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE',
        message: 'The Gateway returned an invalid UX result.',
        hint: 'Run "kb-create doctor" to check the Gateway, then retry the command.',
        details: { gatewayUrl: 'https://gateway.test', httpStatus: '403', requestStage: 'Gateway request' },
        correlationId: expect.any(String),
      },
    });
  });

  // case: S-203.2
  it('decodes canonical Gateway failures and never includes a non-canonical body', async () => {
    const canonical = createErrorEnvelope('KB_AUTH_FORBIDDEN', { details: { permission: 'users:read' }, correlationId: 'gateway-correlation' });
    await expect(decodeGatewayFailure(new Response(JSON.stringify({ ok: false, error: canonical }), { status: 403 }), {
      operation: 'Gateway request', gatewayUrl: 'https://gateway.test',
    })).resolves.toMatchObject({
      code: 'KB_AUTH_FORBIDDEN', details: { permission: 'users:read' },
      correlationId: 'gateway-correlation',
    });

    const malformed = await decodeGatewayFailure(new Response(JSON.stringify({ permission: 'users:read', private: 'raw body' }), { status: 403 }), {
      operation: 'Gateway request', gatewayUrl: 'https://gateway.test',
    });
    expect(malformed).toMatchObject({
      code: 'KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE',
      message: 'The Gateway returned an invalid UX result.',
      details: { gatewayUrl: 'https://gateway.test', httpStatus: '403', requestStage: 'Gateway request' },
      correlationId: expect.any(String),
    });
    expect(JSON.stringify(malformed)).not.toContain('raw body');
    expect(JSON.stringify(malformed)).not.toContain('permission');
  });

  it('keeps Gateway transport context out of code-specific diagnostic details', async () => {
    const canonical = createErrorEnvelope('KB_RUNTIME_WORKFLOW_RUN_NOT_FOUND', { details: { runId: 'missing-run' } });
    const decoded = await decodeGatewayFailure(new Response(JSON.stringify({ ok: false, error: canonical }), { status: 404 }), {
      operation: 'Workflow request', gatewayUrl: 'https://gateway.test',
    });

    expect(decoded).toMatchObject({
      code: 'KB_RUNTIME_WORKFLOW_RUN_NOT_FOUND',
      details: { runId: 'missing-run' },
    });
    expect(decoded.details).not.toHaveProperty('gatewayUrl');
  });

  // case: S-203.2
  it('reconstructs catalog failures from details and rejects missing template values', async () => {
    const remoteText = {
      code: 'KB_AUTH_FORBIDDEN', area: 'auth', stage: 'run', severity: 'error', retryable: false,
      message: 'remote attacker message', hint: 'remote attacker hint',
    };
    const context = { operation: 'Gateway request', gatewayUrl: 'https://gateway.test' };
    const reconstructed = await decodeGatewayFailure(new Response(JSON.stringify({
      ok: false,
      error: { ...remoteText, details: { permission: 'users:read' } },
    }), { status: 403 }), context);
    expect(reconstructed).toMatchObject({
      code: 'KB_AUTH_FORBIDDEN',
      message: 'Permission denied: users:read',
      hint: 'Ask your administrator for the permission needed to perform this operation.',
      details: { permission: 'users:read' },
    });
    expect(JSON.stringify(reconstructed)).not.toContain('remote attacker');

    const missing = await decodeGatewayFailure(new Response(JSON.stringify({
      ok: false,
      error: remoteText,
    }), { status: 403 }), context);
    expect(missing).toMatchObject({
      code: 'KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE',
      details: {
        remoteCode: 'KB_AUTH_FORBIDDEN', gatewayUrl: 'https://gateway.test', httpStatus: '403', requestStage: 'Gateway request',
      },
    });
    expect(JSON.stringify(missing)).not.toContain('remote attacker');
  });

  // case: S-203.2
  it('decodes a parsed failure result without cloning or reading the body again', async () => {
    const envelope = createErrorEnvelope('KB_AUTH_SESSION_REVOKED', { correlationId: 'already-parsed', details: { gatewayUrl: 'https://gateway.test' } });
    const response = new Response(JSON.stringify({ ok: false, error: envelope }), { status: 200 });
    const clone = vi.spyOn(response, 'clone');
    const json = vi.spyOn(response, 'json');

    await expect(readGatewaySuccessData(response, {
      operation: 'Gateway verification', gatewayUrl: 'https://gateway.test',
    })).rejects.toMatchObject({ envelope: { code: 'KB_AUTH_SESSION_REVOKED' } });

    expect(json).toHaveBeenCalledTimes(1);
    expect(clone).not.toHaveBeenCalled();
  });

  // case: S-041.18
  it('preserves a corrupt saved session as a catalogued config error', async () => {
    mocks.loadError = new SavedAuthFileError('.kb/session.json', 'invalid');
    await expect(gatewayApiFetch('http://127.0.0.1:4000/api')).rejects.toMatchObject({
      envelope: {
        code: 'KB_CONFIG_INVALID',
        details: { path: '.kb/session.json' },
        hint: 'Run "kb auth login" to replace the saved authentication data, then retry the command.',
      },
    });
  });

  // case: S-041.7
  it('maps a 401 to the catalog required-auth envelope', async () => {
    const envelope = createErrorEnvelope('KB_AUTH_REQUIRED', { details: { gatewayUrl: 'http://127.0.0.1:4000' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: envelope }), {
      status: 401,
    })));
    await expect(gatewayApiFetch('http://127.0.0.1:4000/api')).rejects.toMatchObject({
      envelope: {
        code: 'KB_AUTH_REQUIRED',
        hint: 'Run "kb auth login --gateway-url http://127.0.0.1:4000 --email <email>" and enter your password at the prompt, or provide it with --password-stdin.',
        details: { gatewayUrl: 'http://127.0.0.1:4000' },
      },
    });
  });

  it('refreshes a session only at its issuing Gateway origin', async () => {
    const session = { gatewayUrl: 'https://gateway-a.test', accessToken: 'stale', refreshToken: 'refresh', expiresAt: 0 };
    mocks.session = session;
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { accessToken: 'fresh', refreshToken: 'rotated', expiresIn: 900 } })))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    await gatewayApiFetch('https://gateway-a.test/api', {}, { gatewayUrl: 'https://gateway-a.test' });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0]).toEqual(new URL('https://gateway-a.test/api'));
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe('Bearer fresh');
  });

  it('uses an issuing-origin machine credential when no user session is saved', async () => {
    mocks.machine = { gatewayUrl: 'https://gateway-a.test', accessToken: 'machine', refreshToken: 'refresh', expiresAt: Date.now() + 600_000 };
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    await gatewayApiFetch('https://gateway-a.test/api', {}, { gatewayUrl: 'https://gateway-a.test' });

    expect(fetch.mock.calls[0]?.[0]).toEqual(new URL('https://gateway-a.test/api'));
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer machine');
  });

  it('retargets the full request origin to the resolved Gateway when supplied', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    await gatewayApiFetch('https://old-gateway.test:4444/api', {}, { gatewayUrl: 'https://active-gateway.test:8443' });

    expect(fetch.mock.calls[0]?.[0]).toEqual(new URL('https://active-gateway.test:8443/api'));
  });

  // case: S-041.9
  it('maps the permission reported by a 403 response without inventing a role', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error: createErrorEnvelope('KB_AUTH_FORBIDDEN', { details: { permission: 'users:write' } }),
    }), { status: 403, headers: { 'Content-Type': 'application/json' } })));
    await expect(gatewayApiFetch('http://127.0.0.1:4000/api')).rejects.toMatchObject({
      envelope: {
        code: 'KB_AUTH_FORBIDDEN',
        details: { permission: 'users:write' },
        message: 'Permission denied: users:write',
      },
    });
  });

  // case: S-203.14
  it('maps a refused host connection to the catalogued host-unreachable envelope', async () => {
    const cause = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause })));
    await expect(gatewayApiFetch('http://127.0.0.1:43123/api', {}, {
      gatewayUrl: 'http://127.0.0.1:43123', platformRoot: '/platform',
    })).rejects.toMatchObject({
      envelope: {
        code: 'KB_HOST_UNREACHABLE',
        message: 'The KB Labs host is not running: cannot connect to http://127.0.0.1:43123.',
        hint: 'Run "kb-create start", or "kb-create doctor" if the host should already be running.',
        details: { address: 'http://127.0.0.1:43123', platformRoot: '/platform' },
        correlationId: expect.any(String),
      },
    });
  });

  // case: S-203.23
  it('does not send or refresh saved credentials at a different Gateway origin', async () => {
    for (const credentialKind of ['user session', 'machine credential'] as const) {
      mocks.session = null;
      mocks.machine = null;
      const credential = {
        gatewayUrl: 'https://gateway-root-a.test',
        accessToken: 'root-a-access',
        refreshToken: 'root-a-refresh',
        expiresAt: 0,
      };
      if (credentialKind === 'user session') { mocks.session = credential; }
      else { mocks.machine = credential; }
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);

      await expect(gatewayApiFetch(
        'https://gateway-root-b.test/auth/tokens',
        {},
        { gatewayUrl: 'https://gateway-root-b.test' },
      )).rejects.toMatchObject({
        envelope: {
          code: 'KB_AUTH_REQUIRED',
          details: { gatewayUrl: 'https://gateway-root-b.test' },
          hint: expect.stringContaining('kb auth login --gateway-url https://gateway-root-b.test --email <email>'),
        },
      });

      expect(fetch).not.toHaveBeenCalled();
    }
  });
});

describe('readGatewaySuccessData', () => {
  // case: S-203.20
  it('propagates catalog envelopes and fills the saved Gateway URL generically', async () => {
    for (const [reason, code] of [
      ['expired', 'KB_AUTH_TOKEN_EXPIRED'],
      ['revoked', 'KB_AUTH_SESSION_REVOKED'],
      ['inactive', 'KB_AUTH_USER_INACTIVE'],
      ['unknown-issuer', 'KB_AUTH_REQUIRED'],
    ] as const) {
      const gatewayUrl = 'https://gateway.test:444';
      const envelope = createErrorEnvelope(code, {
        details: { gatewayUrl, reason },
        correlationId: 'corr-auth',
      });
      const response = new Response(JSON.stringify({ ok: false, error: envelope }), {
        headers: { 'Content-Type': 'application/json' },
      });
      await expect(readGatewaySuccessData(response, { operation: 'Gateway request', gatewayUrl })).rejects.toMatchObject({
        envelope: { ...envelope, details: { gatewayUrl, reason } },
      });
      await expect(readGatewaySuccessData(new Response(JSON.stringify({ ok: false, error: envelope })), {
        operation: 'Gateway request', gatewayUrl,
      }))
        .rejects.toBeInstanceOf(ErrorEnvelopeError);
      expect(envelope.hint).toContain(gatewayUrl);
    }
  });

  // case: S-203.1
  it('unwraps the shared success result returned by Gateway JSON routes', async () => {
    const response = new Response(JSON.stringify({ ok: true, data: { accessToken: 'token' } }), {
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(readGatewaySuccessData<{ accessToken: string }>(response, {
      operation: 'Gateway login', gatewayUrl: 'https://gateway.test',
    })).resolves.toEqual({ accessToken: 'token' });
  });

  // case: S-203.2
  it('rejects invalid or failed result envelopes with a safe error', async () => {
    const invalid = new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    await expect(readGatewaySuccessData(invalid, {
      operation: 'Gateway request', gatewayUrl: 'https://gateway.test',
    })).rejects.toMatchObject({
      envelope: {
        code: 'KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE',
        message: 'The Gateway returned an invalid UX result.',
        details: { requestStage: 'Gateway request', gatewayUrl: 'https://gateway.test', httpStatus: '200' },
      },
    });
    const failure = new Response(JSON.stringify({
      ok: false,
      error: {
        code: 'KB_RUNTIME_UNEXPECTED', area: 'runtime', stage: 'run', severity: 'error', retryable: false,
        message: 'The operation failed unexpectedly.', hint: 'Copy diagnostics and contact support.', correlationId: 'corr-1',
      },
    }), { headers: { 'Content-Type': 'application/json' } });
    await expect(readGatewaySuccessData(failure, {
      operation: 'Gateway request', gatewayUrl: 'https://gateway.test',
    })).rejects.toMatchObject({
      envelope: { code: 'KB_RUNTIME_UNEXPECTED' },
    });
  });

  // case: S-203.2
  it('maps malformed successful Gateway JSON to the protocol failure envelope', async () => {
    const malformed = new Response('<html>proxy error</html>', { status: 200 });
    await expect(readGatewaySuccessData(malformed, {
      operation: 'Gateway login', gatewayUrl: 'https://gateway.test',
    })).rejects.toMatchObject({
      envelope: {
        code: 'KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE',
        details: { httpStatus: '200', requestStage: 'Gateway login', gatewayUrl: 'https://gateway.test' },
        hint: 'Run "kb-create doctor" to check the Gateway, then retry the command.',
      },
    });
  });
});
