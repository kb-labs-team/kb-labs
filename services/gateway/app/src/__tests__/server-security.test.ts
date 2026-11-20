/**
 * Security tests for gateway server (H11 + H12).
 * H11: JWT tokens in ?access_token= query param must be redacted from access logs.
 * H12: CORS must not reflect arbitrary origins (origin: false).
 *
 * redactQueryToken is private — tested via integration by checking that
 * Fastify logger messages do not contain raw tokens when access_token is in URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ICache, ILogger, IServiceTransport } from '@kb-labs/core-platform';
import { platform } from '@kb-labs/core-runtime';
import { InMemoryRateLimitBackend, ResourceBroker } from '@kb-labs/core-resource-broker';
import { GatewayConfigSchema } from '@kb-labs/gateway-contracts';
import { createServer } from '../server.js';

// ── Minimal stubs ──────────────────────────────────────────────────────────────

function makeCache(): ICache {
  const store = new Map<string, unknown>();
  return {
    async get<T>(k: string) { return (store.get(k) as T) ?? null; },
    async set(k: string, v: unknown) { store.set(k, v); },
    async delete(k: string) { store.delete(k); },
    async clear() { store.clear(); },
  } as unknown as ICache;
}

const logMessages: Array<{ msg: string; meta: unknown }> = [];
function stringifyLogEntry(entry: { msg: string; meta: unknown }): string {
  return JSON.stringify(entry);
}

function makeLogger(): ILogger {
  const log = (msg: string, meta?: unknown) => logMessages.push({ msg, meta });
  const child = () => ({
    info: log, warn: log, error: log, debug: log, trace: log, fatal: log, child: () => makeLogger(),
  });
  return { info: log, warn: log, error: log, debug: log, trace: log, fatal: log, child } as unknown as ILogger;
}

const minimalConfig = {
  port: 4099,
  upstreams: {},
  staticTokens: {},
};

const stubTransport: IServiceTransport = {
  connectionInfo: () => undefined,
  call: async () => ({ ok: true, statusCode: 200, payload: null }),
  stream: async () => { throw new Error('not used'); },
} as unknown as IServiceTransport;

const jwtConfig = { secret: 'test-secret-at-least-32-chars-long!' };

// ── Test setup ─────────────────────────────────────────────────────────────────

let app: FastifyInstance;

beforeAll(async () => {
  const logger = makeLogger();
  const cache = makeCache();
  app = await createServer(GatewayConfigSchema.parse(minimalConfig), cache, logger, jwtConfig, undefined, stubTransport);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

// ── H11: JWT not logged ────────────────────────────────────────────────────────

describe('H11 — access_token query param redacted from logs', () => {
  it('does not log a raw JWT token present in ?access_token= query string', async () => {
    logMessages.length = 0;
    const fakeToken = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.fakeSig';

    await app.inject({
      method: 'GET',
      url: `/health?access_token=${fakeToken}`,
    });

    // No log message should contain the raw token
    const rawTokenInLogs = logMessages.some((entry) => {
      const msgStr = stringifyLogEntry(entry);
      return msgStr.includes(fakeToken);
    });
    expect(rawTokenInLogs).toBe(false);
  });

  it('logs [REDACTED] in place of the token value', async () => {
    logMessages.length = 0;
    const fakeToken = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.fakeSig';

    await app.inject({
      method: 'GET',
      url: `/health?access_token=${fakeToken}`,
    });

    const hasRedacted = logMessages.some((entry) => {
      const msgStr = stringifyLogEntry(entry);
      return msgStr.includes('[REDACTED]');
    });
    expect(hasRedacted).toBe(true);
  });

  it('logs other query params normally (only access_token is redacted)', async () => {
    logMessages.length = 0;

    await app.inject({
      method: 'GET',
      url: '/health?foo=bar&baz=qux',
    });

    const hasOtherParams = logMessages.some((entry) => {
      const msgStr = stringifyLogEntry(entry);
      return msgStr.includes('foo=bar');
    });
    expect(hasOtherParams).toBe(true);
  });
});

describe('S-252.2 — Marketplace share token redacted from Gateway request logs', () => {
  // case: S-252.2
  it('redacts token while retaining ordinary query parameters', async () => {
    logMessages.length = 0;
    const fakeToken = 'share-token-test-only-456';
    await app.inject({ method: 'GET', url: `/health?token=${fakeToken}&version=1.2.3` });

    const serializedLogs = JSON.stringify(logMessages);
    expect(serializedLogs).not.toContain(fakeToken);
    expect(serializedLogs).toContain('[REDACTED]');
    expect(serializedLogs).toContain('version=1.2.3');
  });
});

// ── H12: CORS not wildcard ─────────────────────────────────────────────────────

describe('H12 — CORS does not reflect arbitrary origin', () => {
  it('does not echo back a random attacker origin in CORS header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { Origin: 'https://attacker.evil.com' },
    });

    const corsHeader = res.headers['access-control-allow-origin'];
    expect(corsHeader).not.toBe('https://attacker.evil.com');
  });
});

describe('S-255.5 — Gateway request body limit', () => {
  it('rejects request bodies larger than 1 MiB before route dispatch with the error envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/token',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ payload: 'x'.repeat(1024 * 1024) }),
    });

    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ ok: false, error: {
      code: 'KB_RUNTIME_PAYLOAD_TOO_LARGE',
      message: 'The request body exceeds 1 MiB.',
      hint: 'Reduce the request body to 1 MiB and resend it.',
      details: { limitBytes: '1048576' },
    } });
  });
});

describe('S-255.2 — secured default tenant pressure through createServer', () => {
  it('exhausts tenant A default budget while admitting tenant B independently', async () => {
    platform.reset();
    platform.initResourceBroker(new ResourceBroker(new InMemoryRateLimitBackend()));
    const cache = makeCache();
    await cache.set('host:token:tenant-a-token', { hostId: 'agent-a', namespaceId: 'tenant-a' });
    await cache.set('host:token:tenant-b-token', { hostId: 'agent-b', namespaceId: 'tenant-b' });
    const securedConfig = GatewayConfigSchema.parse({ access: { mode: 'secured' } });
    const server = await createServer(securedConfig, cache, makeLogger(), jwtConfig, undefined, stubTransport);
    try {
      await server.ready();
      for (let request = 0; request < 600; request++) {
        const response = await server.inject({
          method: 'POST', url: '/platform/v1/unknown/method', payload: { args: [] },
          headers: { authorization: 'Bearer tenant-a-token' },
        });
        expect(response.statusCode, `tenant A request ${request + 1}`).toBe(404);
      }
      const tenantADenied = await server.inject({
        method: 'POST', url: '/platform/v1/unknown/method', payload: { args: [] },
        headers: { authorization: 'Bearer tenant-a-token' },
      });
      const tenantBAdmitted = await server.inject({
        method: 'POST', url: '/platform/v1/unknown/method', payload: { args: [] },
        headers: { authorization: 'Bearer tenant-b-token' },
      });

      expect(tenantADenied.statusCode).toBe(429);
      expect(tenantBAdmitted.statusCode).toBe(404);
    } finally {
      await server.close();
      platform.reset();
    }
  });
});
