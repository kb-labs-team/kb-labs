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
const mockSessionLoad = vi.fn();
const mockSessionIsExpired = vi.fn();
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
  mockInspect.mockImplementation(async () => {
    const [machine, session] = await Promise.all([mockCredLoad(), mockSessionLoad()]);
    return { machine, session, sessionPath: mockSessionPath(),
      machineExpired: machine ? mockCredIsExpired(machine) : false,
      sessionExpired: session ? mockSessionIsExpired(session) : false };
  });
});

// case: S-041.5, S-041.6, S-041.8, S-100.1
describe('kb auth status', () => {
  it('ST-01: neither store — authenticated false, session.authenticated false', async () => {
    mockCredLoad.mockResolvedValueOnce(null);
    mockSessionLoad.mockResolvedValueOnce(null);

    const captured = { errors: [], output: [], json: [] };
    const exitCode = await authStatus.run(makeCtx(captured), [], { json: true });

    expect(exitCode).toBe(0);
    expect(mockInspect).toHaveBeenCalledOnce();
    expectSuccessEnvelope(captured, { authenticated: false, session: { authenticated: false, path: '/tmp/test-home/.kb/session.json' } });
  });

  it('ST-02: machine only — top-level authenticated true, session.authenticated false', async () => {
    mockCredLoad.mockResolvedValueOnce({ gatewayUrl: 'http://localhost:4000', accessToken: 'a', expiresAt: Date.now() + 60_000 });
    mockCredIsExpired.mockReturnValueOnce(false);
    mockSessionLoad.mockResolvedValueOnce(null);

    const captured = { errors: [], output: [], json: [] };
    const exitCode = await authStatus.run(makeCtx(captured), [], { json: true });

    expect(exitCode).toBe(0);
    expectSuccessEnvelope(captured, {
      authenticated: true,
      gatewayUrl: 'http://localhost:4000',
      session: { authenticated: false, path: '/tmp/test-home/.kb/session.json' },
    });
  });

  it('ST-03: session only — top-level authenticated false, session reports its own status', async () => {
    mockCredLoad.mockResolvedValueOnce(null);
    mockSessionLoad.mockResolvedValueOnce({ gatewayUrl: 'http://localhost:4000', accessToken: 'b', expiresAt: Date.now() + 60_000, email: 'admin@bootstrap.local' });
    mockSessionIsExpired.mockReturnValueOnce(false);

    const captured = { errors: [], output: [], json: [] };
    const exitCode = await authStatus.run(makeCtx(captured), [], { json: true });

    expect(exitCode).toBe(0);
    expectSuccessEnvelope(captured, {
      authenticated: false,
      session: { authenticated: true, path: '/tmp/test-home/.kb/session.json', email: 'admin@bootstrap.local', tokenExpired: false },
    });
  });

  it('ST-04: both stores present — both reported', async () => {
    mockCredLoad.mockResolvedValueOnce({ gatewayUrl: 'http://localhost:4000', accessToken: 'a', expiresAt: Date.now() + 60_000 });
    mockCredIsExpired.mockReturnValueOnce(false);
    mockSessionLoad.mockResolvedValueOnce({ gatewayUrl: 'http://localhost:4000', accessToken: 'b', expiresAt: Date.now() - 1, email: 'admin@bootstrap.local' });
    mockSessionIsExpired.mockReturnValueOnce(true);

    const captured = { errors: [], output: [], json: [] };
    const exitCode = await authStatus.run(makeCtx(captured), [], { json: true });

    expect(exitCode).toBe(0);
    expectSuccessEnvelope(captured, {
      authenticated: true,
      gatewayUrl: 'http://localhost:4000',
      tokenExpired: false,
      expiresAt: expect.any(String),
      session: { authenticated: true, path: '/tmp/test-home/.kb/session.json', tokenExpired: true },
    });
  });
});
