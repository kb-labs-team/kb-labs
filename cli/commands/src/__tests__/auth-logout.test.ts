/**
 * @module cli-commands/__tests__/auth-logout
 *
 * `kb auth logout` clears both identity stores — machine credentials
 * (~/.kb/credentials.json) and human session (~/.kb/session.json).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { noopUI, noopTraceContext } from '@kb-labs/plugin-contracts';
import type { PluginContextV3 } from '@kb-labs/plugin-contracts';

const mockCredLoad = vi.fn();
const mockCredClear = vi.fn();
const mockSessionLoad = vi.fn();
const mockSessionClear = vi.fn();
const mockLogout = vi.fn();
vi.mock('@kb-labs/sdk/gateway', () => ({
  AuthSessionOwner: class { logout = mockLogout; },
}));

import { authLogout } from '../commands/system/auth/auth-logout.js';

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

beforeEach(() => {
  vi.clearAllMocks();
  mockLogout.mockImplementation(async () => {
    const [machine, session] = await Promise.all([mockCredLoad(), mockSessionLoad()]);
    if (!machine && !session) { return false; }
    await Promise.all([mockCredClear(), mockSessionClear()]);
    return true;
  });
});

describe('kb auth logout', () => {
  it('LO-01: clears both stores when both exist', async () => {
    mockCredLoad.mockResolvedValueOnce({ accessToken: 'a' });
    mockSessionLoad.mockResolvedValueOnce({ gatewayUrl: 'https://gateway.test', refreshToken: 'refresh-b', accessToken: 'b' });

    const captured = { errors: [], output: [], json: [] };
    const exitCode = await authLogout.run(makeCtx(captured), [], {});

    expect(exitCode).toBe(0);
    expect(mockLogout).toHaveBeenCalledOnce();
    expect(mockCredClear).toHaveBeenCalled();
    expect(mockSessionClear).toHaveBeenCalled();
  });

  it('LO-02: clears only the store that exists (session-only)', async () => {
    mockCredLoad.mockResolvedValueOnce(null);
    mockSessionLoad.mockResolvedValueOnce({ gatewayUrl: 'https://gateway.test', refreshToken: 'refresh-b', accessToken: 'b' });

    const captured = { errors: [], output: [], json: [] };
    const exitCode = await authLogout.run(makeCtx(captured), [], {});

    expect(exitCode).toBe(0);
    expect(mockCredClear).toHaveBeenCalled();
    expect(mockSessionClear).toHaveBeenCalled();
  });

  it('LO-03: neither store exists — reports already logged out, still safe to call clear', async () => {
    mockCredLoad.mockResolvedValueOnce(null);
    mockSessionLoad.mockResolvedValueOnce(null);

    const captured: { errors: string[]; output: string[]; json: unknown[] } = { errors: [], output: [], json: [] };
    const exitCode = await authLogout.run(makeCtx(captured), [], {});

    expect(exitCode).toBe(0);
    expect(captured.output.some(o => o.includes('already logged out'))).toBe(true);
    expect(mockCredClear).not.toHaveBeenCalled();
    expect(mockSessionClear).not.toHaveBeenCalled();
  });
});
