/**
 * @module cli-commands/__tests__/auth-status
 *
 * `kb auth status` reports both identity stores — machine credentials and
 * human session — so a caller with only one doesn't get a half-true picture.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { noopUI, noopTraceContext } from '@kb-labs/plugin-contracts';
import type { PluginContextV3 } from '@kb-labs/plugin-contracts';

const mockCredLoad = vi.fn();
const mockCredIsExpired = vi.fn();
const mockSessionPath = vi.fn(() => '/tmp/test-home/.kb/session.json');
const mockInspect = vi.fn();
vi.mock('@kb-labs/sdk/gateway', () => ({
  AuthSessionOwner: class { inspect = mockInspect; },
}));

import { authStatus } from '../commands/system/auth/auth-status.js';

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

function expectSuccessEnvelope(captured: { json: unknown[] }, data: object): void {
  expect(captured.json[0]).toMatchObject({ ok: true, data });
  expect(Object.keys(captured.json[0] as object).sort()).toEqual(['data', 'ok']);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInspect.mockImplementation(async () => ({ machine: await mockCredLoad(), sessions: [], sessionPath: mockSessionPath(),
    machineExpired: false, sessionExpired: false }));
});

// case: S-041.5, S-041.6, S-041.8, S-100.1
describe('kb auth status', () => {
  // case: S-216.2
  it('lists every Gateway session without exposing tokens', async () => {
    mockInspect.mockResolvedValueOnce({ machine: null, sessions: [
      { gatewayUrl: 'http://localhost:4000', accessToken: 'secret-local', expiresAt: Date.now() + 60_000, email: 'user@example.test' },
      { gatewayUrl: 'https://hub.example.test', accessToken: 'secret-hub', expiresAt: Date.now() + 120_000, email: 'user@example.test' },
    ], sessionPath: mockSessionPath(), machineExpired: false, sessionExpired: false });
    const captured = { errors: [], output: [], json: [] };

    await authStatus.run(makeCtx(captured), [], { json: true });

    expect(captured.json[0]).toMatchObject({ ok: true, data: { sessions: [
      { gatewayUrl: 'http://localhost:4000', email: 'user@example.test' },
      { gatewayUrl: 'https://hub.example.test', email: 'user@example.test' },
    ] } });
    expect(JSON.stringify(captured.json)).not.toContain('secret-');
  });

  it('ST-01: neither store — authenticated false, session.authenticated false', async () => {
    mockCredLoad.mockResolvedValueOnce(null);

    const captured = { errors: [], output: [], json: [] };
    const exitCode = await authStatus.run(makeCtx(captured), [], { json: true });

    expect(exitCode).toBe(0);
    expect(mockInspect).toHaveBeenCalledOnce();
    expectSuccessEnvelope(captured, { authenticated: false, sessions: [{ authenticated: false, path: '/tmp/test-home/.kb/session.json' }] });
  });

  it('ST-02: machine only — top-level authenticated true, session.authenticated false', async () => {
    mockCredLoad.mockResolvedValueOnce({ gatewayUrl: 'http://localhost:4000', accessToken: 'a', expiresAt: Date.now() + 60_000 });
    mockCredIsExpired.mockReturnValueOnce(false);

    const captured = { errors: [], output: [], json: [] };
    const exitCode = await authStatus.run(makeCtx(captured), [], { json: true });

    expect(exitCode).toBe(0);
    expectSuccessEnvelope(captured, {
      authenticated: true,
      gatewayUrl: 'http://localhost:4000',
      sessions: [{ authenticated: false, path: '/tmp/test-home/.kb/session.json' }],
    });
  });

  it('ST-03: session only — top-level authenticated false, session reports its own status', async () => {
    mockCredLoad.mockResolvedValueOnce(null);
    mockInspect.mockResolvedValueOnce({ machine: null, sessions: [{ gatewayUrl: 'http://localhost:4000', accessToken: 'b', expiresAt: Date.now() + 60_000, email: 'admin@bootstrap.local' }], sessionPath: mockSessionPath(), machineExpired: false, sessionExpired: false });

    const captured = { errors: [], output: [], json: [] };
    const exitCode = await authStatus.run(makeCtx(captured), [], { json: true });

    expect(exitCode).toBe(0);
    expectSuccessEnvelope(captured, {
      authenticated: false,
      sessions: [{ authenticated: true, path: '/tmp/test-home/.kb/session.json', gatewayUrl: 'http://localhost:4000', email: 'admin@bootstrap.local', tokenExpired: false, expiresAt: expect.any(String) }],
    });
  });

  it('ST-04: both stores present — both reported', async () => {
    mockCredLoad.mockResolvedValueOnce({ gatewayUrl: 'http://localhost:4000', accessToken: 'a', expiresAt: Date.now() + 60_000 });
    mockCredIsExpired.mockReturnValueOnce(false);
    mockInspect.mockResolvedValueOnce({ machine: { gatewayUrl: 'http://localhost:4000', accessToken: 'a', expiresAt: Date.now() + 60_000 }, sessions: [{ gatewayUrl: 'http://localhost:4000', accessToken: 'b', expiresAt: Date.now() - 1, email: 'admin@bootstrap.local' }], sessionPath: mockSessionPath(), machineExpired: false, sessionExpired: true });

    const captured = { errors: [], output: [], json: [] };
    const exitCode = await authStatus.run(makeCtx(captured), [], { json: true });

    expect(exitCode).toBe(0);
    expectSuccessEnvelope(captured, {
      authenticated: true,
      gatewayUrl: 'http://localhost:4000',
      tokenExpired: false,
      expiresAt: expect.any(String),
      sessions: [{ authenticated: true, path: '/tmp/test-home/.kb/session.json', gatewayUrl: 'http://localhost:4000', tokenExpired: true, expiresAt: expect.any(String), email: 'admin@bootstrap.local' }],
    });
  });
});
