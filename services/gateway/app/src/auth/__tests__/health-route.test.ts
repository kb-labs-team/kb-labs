/**
 * Tests for GET /health/auth.
 *
 * The route reports "no admin exists" / "dev JWT secret in use", so it must
 * answer only requests that originate on this machine and were not proxied.
 * Each of the three guards is exercised on its own — a test that only proves
 * "loopback works, remote fails" would pass even if two of the three guards
 * were deleted.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ICache } from '@kb-labs/core-platform';
import type { AuthReadiness } from '@kb-labs/gateway-auth';
import { createAuthMiddleware } from '../middleware.js';
import { registerAuthHealthRoute, isLocalOperatorRequest } from '../health-route.js';
import { logAuthReadiness } from '../../bootstrap.js';

const READINESS: AuthReadiness = {
  ok: false,
  authEnabled: true,
  tenantId: 'kblabs-cloud',
  activeAdmins: 0,
  bootstrap: 'not-configured',
  issues: [{ code: 'no_active_admin', severity: 'error', message: 'no admin', hint: 'kb auth reset-admin' }],
};

const fakeCache = { get: async () => null, set: async () => {}, delete: async () => {}, clear: async () => {} } as unknown as ICache;

let app: FastifyInstance;
let calls: number;

beforeEach(async () => {
  calls = 0;
  app = Fastify({ logger: false, trustProxy: true });
  // Real machine-auth middleware in front: proves the route is reachable
  // without a token (PUBLIC_ROUTES) yet still self-gates.
  app.addHook('onRequest', createAuthMiddleware(fakeCache, { secret: 'x'.repeat(40) }, { authEnabled: true }));
  registerAuthHealthRoute(app, async () => { calls += 1; return READINESS; });
  await app.ready();
});

const get = (opts: { remoteAddress?: string; headers?: Record<string, string> } = {}) =>
  app.inject({
    method: 'GET',
    url: '/health/auth',
    remoteAddress: opts.remoteAddress ?? '127.0.0.1',
    headers: { host: 'localhost:4000', ...opts.headers },
  });

describe('GET /health/auth — served', () => {
  it('returns the readiness to a local operator without a token', async () => {
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(READINESS);
  });

  it.each(['127.0.0.1', '127.5.5.5', '::1', '::ffff:127.0.0.1'])('accepts loopback peer %s', async (addr) => {
    expect((await get({ remoteAddress: addr })).statusCode).toBe(200);
  });

  it.each(['localhost', 'localhost:4000', '127.0.0.1:4000', '[::1]:4000'])('accepts loopback Host %s', async (host) => {
    expect((await get({ headers: { host } })).statusCode).toBe(200);
  });
});

describe('GET /health/auth — denied with a plain 404 (never 401/403, never the body)', () => {
  const expectHidden = (r: { statusCode: number; body: string }) => {
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain('no_active_admin');
    expect(calls).toBe(0); // the readiness is not even computed
  };

  it('guard 1: non-loopback TCP peer', async () => {
    expectHidden(await get({ remoteAddress: '203.0.113.9' }));
  });

  it('guard 1: a spoofed X-Forwarded-For claiming loopback does not help a remote peer', async () => {
    expectHidden(await get({ remoteAddress: '203.0.113.9', headers: { 'x-forwarded-for': '127.0.0.1' } }));
  });

  it.each(['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto'])(
    'guard 2: any forwarding header (%s) — a same-host reverse proxy is not an operator',
    async (header) => {
      expectHidden(await get({ headers: { [header]: 'x' } }));
    },
  );

  it('guard 3: loopback peer but the public Host that a proxy forwards', async () => {
    expectHidden(await get({ headers: { host: 'kb-cloud.kblabs.ru' } }));
  });

  it('guard 3: a host that merely starts like a loopback name is not loopback', async () => {
    expectHidden(await get({ headers: { host: '127.0.0.1.evil.example' } }));
    expectHidden(await get({ headers: { host: 'localhost.evil.example' } }));
  });
});

describe('isLocalOperatorRequest', () => {
  const req = (over: { remote?: string; headers?: Record<string, string> }) =>
    ({ socket: { remoteAddress: over.remote }, headers: over.headers ?? {} }) as never;

  it('is false without a socket address', () => {
    expect(isLocalOperatorRequest(req({ headers: { host: 'localhost' } }))).toBe(false);
  });
  it('is false without a Host header', () => {
    expect(isLocalOperatorRequest(req({ remote: '127.0.0.1' }))).toBe(false);
  });
  it('is true for a local, unproxied, loopback-Host request', () => {
    expect(isLocalOperatorRequest(req({ remote: '::1', headers: { host: '[::1]:4000' } }))).toBe(true);
  });
});

describe('logAuthReadiness (startup)', () => {
  const makeLogger = () => {
    const lines: Array<{ level: string; msg: string; err?: unknown; meta?: Record<string, unknown> }> = [];
    const logger = {
      error: (msg: string, err?: unknown, meta?: Record<string, unknown>) => lines.push({ level: 'error', msg, err, meta }),
      warn: (msg: string, meta?: Record<string, unknown>) => lines.push({ level: 'warn', msg, meta }),
      info: (msg: string, meta?: Record<string, unknown>) => lines.push({ level: 'info', msg, meta }),
    };
    return { logger: logger as never, lines };
  };

  it('logs an error with code and hint for a locked-out install', async () => {
    const { logger, lines } = makeLogger();
    await logAuthReadiness(async () => READINESS, logger);
    expect(lines).toEqual([
      { level: 'error', msg: 'auth-readiness: no admin', err: undefined, meta: { code: 'no_active_admin', hint: 'kb auth reset-admin' } },
    ]);
  });

  it('logs warnings at warn level and does not say "ok" while issues remain', async () => {
    const { logger, lines } = makeLogger();
    await logAuthReadiness(async () => ({
      ...READINESS, ok: true, activeAdmins: 1,
      issues: [{ code: 'jwt_secret_default', severity: 'warning', message: 'dev secret', hint: 'set it' }],
    }), logger);
    expect(lines.map((l) => l.level)).toEqual(['warn']);
  });

  it('logs a single info line when everything is fine', async () => {
    const { logger, lines } = makeLogger();
    await logAuthReadiness(async () => ({ ...READINESS, ok: true, activeAdmins: 2, issues: [] }), logger);
    expect(lines).toEqual([{ level: 'info', msg: 'auth-readiness: ok', meta: { authEnabled: true, activeAdmins: 2 } }]);
  });

  it('never throws: a failing check degrades to a warning', async () => {
    const { logger, lines } = makeLogger();
    await expect(logAuthReadiness(async () => { throw new Error('db down'); }, logger)).resolves.toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn', msg: 'auth-readiness: check failed', meta: { error: 'db down' } });
  });
});
