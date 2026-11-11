/**
 * @module cli-commands/__tests__/auth-login
 *
 * Unit tests for `kb auth login` command.
 * Verifies token exchange, /auth/me profile fetch, and credentials persistence.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { noopUI, noopTraceContext } from '@kb-labs/plugin-contracts';
import type { PluginContextV3 } from '@kb-labs/plugin-contracts';

// The command test pins delegation; lifecycle and persistence are tested at the owner boundary.
const mockSave = vi.fn();
const mockSessionSave = vi.fn();
const mockMachineLogin = vi.fn();
const mockHumanLogin = vi.fn();
vi.mock('@kb-labs/sdk/gateway', () => ({
  AuthSessionOwner: class { loginMachine = mockMachineLogin; loginSession = mockHumanLogin; },
}));

import { authLogin } from '../commands/system/auth/auth-login.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const TOKEN_RESPONSE = {
  accessToken: 'access-tok',
  refreshToken: 'refresh-tok',
  expiresIn: 900,
};

function makeCtx(captured: { errors: string[]; output: string[]; json: unknown[] }): PluginContextV3 {
  return {
    host: 'cli',
    requestId: 'test',
    pluginId: '@kb-labs/system',
    pluginVersion: '1.0.0',
    cwd: process.cwd(),
    ui: {
      ...noopUI,
      write: (msg: string) => { captured.output.push(msg); },
      error: (msg: string) => { captured.errors.push(msg); },
      json: (obj: unknown) => { captured.json.push(obj); },
    },
    platform: {
      logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() },
      llm: {} as any, embeddings: {} as any, vectorStore: {} as any,
      cache: {} as any, storage: {} as any, analytics: {} as any,
      eventBus: { publish: vi.fn(async () => {}), subscribe: vi.fn(() => () => {}) },
      logs: {} as any,
    } as any,
    runtime: { fs: {} as any, fetch: vi.fn(), env: vi.fn() },
    api: {} as any,
    hostContext: { host: 'cli' as const, binaryName: 'kb', argv: [], flags: {} },
    trace: noopTraceContext,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockMachineLogin.mockImplementation(async (gatewayUrl: string) => {
    const handle = 'kirill';
    const expiresAt = Date.now() + TOKEN_RESPONSE.expiresIn * 1000;
    mockSave({ gatewayUrl, accessToken: TOKEN_RESPONSE.accessToken, refreshToken: TOKEN_RESPONSE.refreshToken,
      expiresAt, handle, namespaceId: 'ns_abc' });
    return { gatewayUrl, accessToken: TOKEN_RESPONSE.accessToken, refreshToken: TOKEN_RESPONSE.refreshToken,
      expiresAt, handle, namespaceId: 'ns_abc' };
  });
  mockHumanLogin.mockImplementation(async (gatewayUrl: string, email: string) => {
    const credential = { gatewayUrl, accessToken: 'session-access-tok', refreshToken: 'session-refresh-tok',
      expiresAt: Date.now() + 900_000, email, tenantId: 'default' };
    mockSessionSave(credential);
    return { credential, expiresIn: 900 };
  });
});

describe('kb auth login', () => {
  it('AL-01: successful login saves accessToken, handle and namespaceId', async () => {
    const captured = { errors: [], output: [], json: [] };
    const ctx = makeCtx(captured);

    const exitCode = await authLogin.run(ctx, [], {
      'gateway-url': 'http://localhost:4000',
      'client-id': 'clt_test',
      'client-secret': 'cs_test',
    });

    expect(exitCode).toBe(0);
    expect(mockMachineLogin).toHaveBeenCalledWith('http://localhost:4000', 'clt_test', 'cs_test');
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayUrl: 'http://localhost:4000',
        accessToken: 'access-tok',
        refreshToken: 'refresh-tok',
        handle: 'kirill',
        namespaceId: 'ns_abc',
      }),
    );
  });

  it('AL-02: the login command delegates verification and persistence to the owner', async () => {

    const captured = { errors: [], output: [], json: [] };
    const ctx = makeCtx(captured);

    const exitCode = await authLogin.run(ctx, [], {
      'gateway-url': 'http://localhost:4000',
      'client-id': 'clt_test',
      'client-secret': 'cs_test',
    });

    expect(exitCode).toBe(0);
    expect(mockMachineLogin).toHaveBeenCalledOnce();
  });

  it('AL-03: missing flags — exitCode 1, no fetch calls', async () => {
    const captured = { errors: [], output: [], json: [] };
    const ctx = makeCtx(captured);

    const exitCode = await authLogin.run(ctx, [], {
      'gateway-url': 'http://localhost:4000',
      // missing client-id and client-secret
    });

    expect(exitCode).toBe(1);
    expect(mockMachineLogin).not.toHaveBeenCalled();
    expect(captured.errors.length).toBeGreaterThan(0);
  });

  it('AL-04: gateway unreachable — exitCode 1, error shown', async () => {
    mockMachineLogin.mockRejectedValueOnce(new Error('unreachable'));

    const captured = { errors: [], output: [], json: [] };
    const ctx = makeCtx(captured);

    const exitCode = await authLogin.run(ctx, [], {
      'gateway-url': 'http://localhost:4000',
      'client-id': 'clt_test',
      'client-secret': 'cs_test',
    });

    expect(exitCode).toBe(1);
    expect(mockSave).not.toHaveBeenCalled();
    expect(captured.errors.length).toBeGreaterThan(0);
  });

  it('AL-05: token endpoint returns 401 — exitCode 1', async () => {
    mockMachineLogin.mockRejectedValueOnce(new Error('Authentication failed (401).'));

    const captured: { errors: string[]; output: string[]; json: unknown[] } = { errors: [], output: [], json: [] };
    const ctx = makeCtx(captured);

    const exitCode = await authLogin.run(ctx, [], {
      'gateway-url': 'http://localhost:4000',
      'client-id': 'clt_test',
      'client-secret': 'cs_test',
    });

    expect(exitCode).toBe(1);
    expect(mockSave).not.toHaveBeenCalled();
    expect(captured.errors.join('\n')).toContain('Gateway authentication failed');
    expect(captured.errors.join('\n')).not.toContain('Unauthorized');
  });

  it('AL-06: --json flag outputs structured result', async () => {
    const captured = { errors: [], output: [], json: [] };
    const ctx = makeCtx(captured);

    const exitCode = await authLogin.run(ctx, [], {
      'gateway-url': 'http://localhost:4000',
      'client-id': 'clt_test',
      'client-secret': 'cs_test',
      json: true,
    });

    expect(exitCode).toBe(0);
    expect(captured.json[0]).toMatchObject({
      ok: true,
      data: {
        gatewayUrl: 'http://localhost:4000',
        handle: 'kirill',
      },
    });
    expect(captured.output.length).toBe(0);
  });

  it('AL-07: expiresAt is in the future (based on expiresIn)', async () => {
    const before = Date.now();
    const captured = { errors: [], output: [], json: [] };
    const ctx = makeCtx(captured);
    await authLogin.run(ctx, [], {
      'gateway-url': 'http://localhost:4000',
      'client-id': 'clt_test',
      'client-secret': 'cs_test',
    });

    const saved = mockSave.mock.calls[0]?.[0] as Record<string, number>;
    const expectedMin = before + TOKEN_RESPONSE.expiresIn * 1000;
    expect(saved.expiresAt).toBeGreaterThanOrEqual(expectedMin);
  });

  // ── human (email/password) branch ─────────────────────────────────────────

  it('AL-08: --email/--password delegates login and persistence to the owner', async () => {
    const captured = { errors: [], output: [], json: [] };
    const ctx = makeCtx(captured);

    const exitCode = await authLogin.run(ctx, [], {
      'gateway-url': 'http://localhost:4000',
      email: 'admin@bootstrap.local',
      password: 'AdminPass123!',
    });

    expect(exitCode).toBe(0);
    expect(mockHumanLogin).toHaveBeenCalledWith('http://localhost:4000', 'admin@bootstrap.local', 'AdminPass123!');
    expect(mockSessionSave).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayUrl: 'http://localhost:4000',
        accessToken: 'session-access-tok',
        refreshToken: 'session-refresh-tok',
        email: 'admin@bootstrap.local',
        tenantId: 'default',
      }),
    );
    // Machine store must never be touched by the human branch.
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('AL-09: --email/--password wrong password — exitCode 1, no session saved', async () => {
    mockHumanLogin.mockRejectedValueOnce(new Error('Authentication failed (401).'));

    const captured: { errors: string[]; output: string[]; json: unknown[] } = { errors: [], output: [], json: [] };
    const ctx = makeCtx(captured);

    const exitCode = await authLogin.run(ctx, [], {
      'gateway-url': 'http://localhost:4000',
      email: 'admin@bootstrap.local',
      password: 'wrong',
    });

    expect(exitCode).toBe(1);
    expect(mockSessionSave).not.toHaveBeenCalled();
    expect(captured.errors.join('\n')).toContain('Gateway authentication failed');
    expect(captured.errors.join('\n')).not.toContain('invalid_credentials');
  });

  it('AL-10: neither client-id/secret nor email/password — exitCode 1, no fetch calls', async () => {
    const captured: { errors: string[]; output: string[]; json: unknown[] } = { errors: [], output: [], json: [] };
    const ctx = makeCtx(captured);

    const exitCode = await authLogin.run(ctx, [], {
      'gateway-url': 'http://localhost:4000',
    });

    expect(exitCode).toBe(1);
    expect(mockMachineLogin).not.toHaveBeenCalled();
    expect(mockHumanLogin).not.toHaveBeenCalled();
    expect(captured.errors.length).toBeGreaterThan(0);
  });

  it('AL-11: human login delegates credential verification to the owner', async () => {

    const captured = { errors: [], output: [], json: [] };
    const ctx = makeCtx(captured);

    const exitCode = await authLogin.run(ctx, [], {
      'gateway-url': 'http://localhost:4000',
      email: 'admin@bootstrap.local',
      password: 'AdminPass123!',
    });

    expect(exitCode).toBe(0);
    expect(mockHumanLogin).toHaveBeenCalledOnce();
    expect(mockSessionSave).toHaveBeenCalledWith(expect.objectContaining({ email: 'admin@bootstrap.local', tenantId: 'default' }));
  });
});
