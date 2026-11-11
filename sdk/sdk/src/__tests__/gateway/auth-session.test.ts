import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createErrorEnvelope } from '@kb-labs/core-platform';

const stores = vi.hoisted(() => ({
  session: null as null | { gatewayUrl: string; accessToken: string; refreshToken: string; expiresAt: number; email?: string },
  machine: null as null | { gatewayUrl: string; accessToken: string; refreshToken: string; expiresAt: number },
  sessionError: null as unknown,
  machineError: null as unknown,
  saveSession: vi.fn(), saveMachine: vi.fn(),
}));

vi.mock('../../gateway/session.js', () => ({ SessionManager: class {
  async load() { if (stores.sessionError) { throw stores.sessionError; } return stores.session; }
  async save(value: typeof stores.session) { stores.saveSession(value); stores.session = value; }
  async clear() { stores.session = null; }
  getFilePath() { return '/tmp/home/.kb/session.json'; }
} }));
vi.mock('../../gateway/credentials.js', () => ({ CredentialsManager: class {
  async load() { if (stores.machineError) { throw stores.machineError; } return stores.machine; }
  async save(value: typeof stores.machine) { stores.saveMachine(value); stores.machine = value; }
  async clear() { stores.machine = null; }
} }));

import { AuthSessionOwner } from '../../gateway/auth-session.js';
import { SavedAuthFileError } from '../../gateway/saved-auth-file.js';

describe('AuthSessionOwner', () => {
  beforeEach(() => {
    stores.session = null; stores.machine = null; stores.sessionError = null; stores.machineError = null;
    stores.saveSession.mockReset(); stores.saveMachine.mockReset();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  // case: S-203.23
  it('isolates both credential kinds to their issuing Gateway origin', async () => {
    const owner = new AuthSessionOwner();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const kind of ['session', 'machine'] as const) {
      stores.session = null; stores.machine = null;
      const credential = { gatewayUrl: 'https://gateway-a.test', accessToken: 'access', refreshToken: 'refresh', expiresAt: 0 };
      if (kind === 'session') { stores.session = credential; } else { stores.machine = credential; }
      await expect(owner.load(kind, { gatewayUrl: 'https://gateway-b.test' })).rejects.toMatchObject({
        envelope: { code: 'KB_AUTH_REQUIRED', details: { gatewayUrl: 'https://gateway-b.test' } },
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('prefers a human session when both credential kinds exist', async () => {
    stores.session = { gatewayUrl: 'https://gateway.test', accessToken: 'user', refreshToken: 'u-refresh', expiresAt: Date.now() + 600_000 };
    stores.machine = { gatewayUrl: 'https://gateway.test', accessToken: 'machine', refreshToken: 'm-refresh', expiresAt: Date.now() + 600_000 };
    const auth = await new AuthSessionOwner().load('either');
    expect(auth?.kind).toBe('session');
    expect(auth?.accessToken).toBe('user');
  });

  it('refreshes and saves expired sessions at the CLI session endpoint', async () => {
    stores.session = { gatewayUrl: 'https://gateway.test', accessToken: 'old', refreshToken: 'refresh', expiresAt: 0, email: 'member@test' };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: {
      accessToken: 'fresh', refreshToken: 'rotated', expiresIn: 900,
    } }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const auth = await new AuthSessionOwner().load('session');
    expect(fetch).toHaveBeenCalledWith('https://gateway.test/auth/refresh/cli', expect.objectContaining({ method: 'POST' }));
    expect(auth?.accessToken).toBe('fresh');
    expect(stores.saveSession).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'fresh', email: 'member@test' }));
  });

  it('refreshes machine credentials at their machine endpoint', async () => {
    stores.machine = { gatewayUrl: 'https://gateway.test', accessToken: 'old', refreshToken: 'refresh', expiresAt: 0 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: {
      accessToken: 'fresh', refreshToken: 'rotated', expiresIn: 900,
    } }), { headers: { 'Content-Type': 'application/json' } })));
    const auth = await new AuthSessionOwner().load('machine');
    expect(auth?.kind).toBe('machine');
    expect(auth?.accessToken).toBe('fresh');
    expect(stores.saveMachine).toHaveBeenCalledOnce();
  });

  it('preserves invalid saved-file diagnostics and safely decodes invalid refresh responses', async () => {
    stores.sessionError = new SavedAuthFileError('.kb/session.json', 'invalid');
    await expect(new AuthSessionOwner().load()).rejects.toBeInstanceOf(SavedAuthFileError);
    stores.sessionError = null;
    stores.machineError = new SavedAuthFileError('.kb/credentials.json', 'unreadable');
    await expect(new AuthSessionOwner().load('machine')).rejects.toMatchObject({
      envelope: { code: 'KB_CONFIG_INVALID', details: { path: '.kb/credentials.json' } },
    });
    stores.machineError = null;
    stores.session = { gatewayUrl: 'https://gateway.test', accessToken: 'old', refreshToken: 'refresh', expiresAt: 0 };
    const failure = createErrorEnvelope('KB_AUTH_SESSION_REVOKED', { details: { gatewayUrl: 'https://gateway.test' } });
    const required = createErrorEnvelope('KB_AUTH_REQUIRED', { details: { gatewayUrl: 'https://gateway.test' } });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: failure }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: required }), { status: 401 })));
    await expect(new AuthSessionOwner().load('session')).rejects.toMatchObject({ envelope: { code: 'KB_AUTH_SESSION_REVOKED' } });
    stores.session = null;
    stores.machine = { gatewayUrl: 'https://gateway.test', accessToken: 'old', refreshToken: 'refresh', expiresAt: 0 };
    await expect(new AuthSessionOwner().load('machine')).rejects.toMatchObject({
      envelope: { code: 'KB_AUTH_REQUIRED', details: { gatewayUrl: 'https://gateway.test' } },
    });
  });

  it('uses the protocol envelope for a non-canonical login response', async () => {
    const envelope = createErrorEnvelope('KB_AUTH_INVALID_CREDENTIALS', {
      message: 'The credentials are invalid.',
    });
    const rawBody = JSON.stringify({ ok: false, error: envelope, debugPassword: 'never-render-this' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(rawBody, { status: 401 })));

    await expect(new AuthSessionOwner().loginSession('https://gateway.test', 'member@test', 'password'))
      .rejects.toMatchObject({
        envelope: {
          code: 'KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE',
          details: { httpStatus: '401', requestStage: 'Authentication', gatewayUrl: 'https://gateway.test' },
        },
      });
  });
});
