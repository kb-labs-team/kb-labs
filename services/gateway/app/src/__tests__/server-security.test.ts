/**
 * Security tests for gateway server (H11 + H12).
 * H11: JWT tokens in ?access_token= query param must be redacted from access logs.
 * H12: CORS must not reflect arbitrary origins (origin: false).
 *
 * redactQueryToken is private — tested via integration by checking that
 * Fastify logger messages do not contain raw tokens when access_token is in URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request as httpRequest, createServer as createHttpServer } from 'node:http';
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

  it('forwards the real Registry query unchanged through the configured Gateway route', async () => {
    const fakeToken = 'share-token-through-gateway-test-only';
    const receivedUrls: string[] = [];
    const registry = createHttpServer((request, response) => {
      receivedUrls.push(request.url ?? '');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => {
      registry.listen(0, '127.0.0.1', resolve);
    });
    const registryAddress = registry.address();
    if (!registryAddress || typeof registryAddress === 'string') { throw new Error('Expected TCP listener'); }

    const gateway = await createServer(
      GatewayConfigSchema.parse({
        access: { mode: 'local' },
        upstreams: {
          registry: {
            serviceId: 'marketplace-registry',
            prefix: '/api/v1/registry',
            rewritePrefix: '/api/v1',
          },
        },
      }),
      makeCache(),
      makeLogger(),
      jwtConfig,
      undefined,
      {
        ...stubTransport,
        connectionInfo: () => ({ baseUrl: `http://127.0.0.1:${registryAddress.port}` }),
      },
    );

    try {
      await gateway.listen({ port: 0, host: '127.0.0.1' });
      const gatewayAddress = gateway.server.address();
      if (!gatewayAddress || typeof gatewayAddress === 'string') { throw new Error('Expected TCP listener'); }
      const requestGateway = (path: string) => new Promise<{ statusCode?: number; body: string }>((resolve, reject) => {
        const request = httpRequest({
          hostname: '127.0.0.1',
          port: gatewayAddress.port,
          method: 'GET',
          path,
        }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => { body += chunk; });
          response.on('end', () => resolve({ statusCode: response.statusCode, body }));
        });
        request.on('error', reject);
        request.end();
      });
      const result = await requestGateway(`/api/v1/registry/packages/owner/plugin?token=${fakeToken}&version=1.2.3`);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ ok: true });
      expect(receivedUrls).toEqual([`/api/v1/packages/owner/plugin?token=${fakeToken}&version=1.2.3`]);

      // A raw '#' in an HTTP request target is treated as a URL fragment by
      // the proxy and is not forwarded as a query string. Only '?' carries the
      // share token through the real Gateway route.
      const fragmentResult = await requestGateway(`/api/v1/registry/packages/owner/plugin#token=${fakeToken}&version=1.2.3`);
      expect(fragmentResult.statusCode).toBe(200);
      expect(receivedUrls).toEqual([
        `/api/v1/packages/owner/plugin?token=${fakeToken}&version=1.2.3`,
        '/api/v1/packages/owner/plugin',
      ]);
      const serializedLogs = JSON.stringify(logMessages);
      expect(serializedLogs).not.toContain(fakeToken);
      expect(serializedLogs).toContain('[REDACTED]');
      expect(serializedLogs).toContain('version=1.2.3');
    } finally {
      await gateway.close();
      await new Promise<void>((resolve, reject) => {
        registry.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});

describe('S-323.1 — static REST proxy keeps internal adapter-call private', () => {
  // case: S-323.1
  it('removes Gateway internal identity secret only for the rewritten adapter-call route', async () => {
    const previousSecret = process.env.GATEWAY_INTERNAL_SECRET;
    process.env.GATEWAY_INTERNAL_SECRET = 'gateway-static-proxy-secret';
    const received: Array<{ url: string; secret?: string }> = [];
    const rest = createHttpServer((request, response) => {
      const secret = request.headers['x-internal-secret'];
      received.push({ url: request.url ?? '', secret: typeof secret === 'string' ? secret : undefined });
      const allowed = secret === 'gateway-static-proxy-secret';
      response.writeHead(allowed ? 200 : 403, { 'content-type': 'application/json' });
      response.end(JSON.stringify(allowed ? { ok: true } : { ok: false, error: { code: 'KB_AUTH_FORBIDDEN' } }));
    });
    await new Promise<void>((resolve) => { rest.listen(0, '127.0.0.1', resolve); });
    const address = rest.address();
    if (!address || typeof address === 'string') { throw new Error('Expected REST TCP listener'); }

    const gateway = await createServer(
      GatewayConfigSchema.parse({
        access: { mode: 'local' },
        upstreams: { rest: { serviceId: 'rest-api', prefix: '/api/v1/rest', rewritePrefix: '/api/v1' } },
      }),
      makeCache(),
      makeLogger(),
      jwtConfig,
      undefined,
      {
        ...stubTransport,
        connectionInfo: () => ({ baseUrl: `http://127.0.0.1:${address.port}` }),
      },
    );

    try {
      await gateway.listen({ port: 0, host: '127.0.0.1' });
      const gatewayAddress = gateway.server.address();
      if (!gatewayAddress || typeof gatewayAddress === 'string') { throw new Error('Expected Gateway TCP listener'); }
      const requestGateway = (path: string, internalSecret?: string) => new Promise<number>((resolve, reject) => {
        const request = httpRequest({
          hostname: '127.0.0.1',
          port: gatewayAddress.port,
          method: 'POST',
          path,
          headers: { ...(internalSecret ? { 'x-internal-secret': internalSecret } : {}) },
        }, (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode ?? 0));
        });
        request.on('error', reject);
        request.end('{}');
      });

      expect(await requestGateway('/api/v1/rest/internal/adapter-call')).toBe(403);
      expect(await requestGateway('/api/v1/rest/internal/adapter-call', 'client-invalid-secret')).toBe(403);
      expect(received.slice(0, 2)).toEqual([
        { url: '/api/v1/internal/adapter-call', secret: undefined },
        { url: '/api/v1/internal/adapter-call', secret: undefined },
      ]);

      expect(await requestGateway('/api/v1/rest/health')).toBe(200);
      expect(received.at(-1)).toEqual({ url: '/api/v1/health', secret: 'gateway-static-proxy-secret' });
    } finally {
      await gateway.close();
      await new Promise<void>((resolve, reject) => rest.close(error => error ? reject(error) : resolve()));
      if (previousSecret === undefined) { delete process.env.GATEWAY_INTERNAL_SECRET; }
      else { process.env.GATEWAY_INTERNAL_SECRET = previousSecret; }
    }
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
