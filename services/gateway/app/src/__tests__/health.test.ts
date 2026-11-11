/**
 * Integration tests for Gateway /health endpoint.
 *
 * Covers:
 *   GET /health
 *     - healthy when all adapters available
 *     - degraded when non-critical adapter missing
 *     - unhealthy when LLM unavailable
 *     - includes uptime and timestamp
 *     - adapter latency reported
 *     - upstream health probing
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ICache, ILogger, IServiceTransport, ServiceTransportResponse } from '@kb-labs/core-platform';
import { UxFailureResultJsonSchema } from '@kb-labs/core-platform/error-envelope';
import type { JwtConfig } from '@kb-labs/gateway-auth';
import type { GatewayConfig } from '@kb-labs/gateway-contracts';
import type { RouteOptions } from 'fastify';

// ── Mocks ─────────────────────────────────────────────────────────────────

let mockAdapters: Record<string, unknown> = {};
let mockAdapterStatuses: unknown[] = [];

vi.mock('@kb-labs/core-runtime', () => ({
  platform: {
    getAdapter: (name: string) => mockAdapters[name],
  },
  getAdapterStatus: () => mockAdapterStatuses,
}));

function makeCache(): ICache {
  const store = new Map<string, unknown>();
  return {
    async get<T>(k: string) { return (store.get(k) as T) ?? null; },
    async set(k: string, v: unknown) { store.set(k, v); },
    async delete(k: string) { store.delete(k); },
    async clear() { store.clear(); },
  } as unknown as ICache;
}

const noopLogger: ILogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => noopLogger),
} as unknown as ILogger;

const stubJwtConfig: JwtConfig = { secret: 'test-secret' };

type FixtureMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function schemaExample(input: unknown): unknown {
  if (!input || typeof input !== 'object') {return {};}
  const schema = input as Record<string, unknown>;
  if ('const' in schema) {return schema.const;}
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {return schema.enum[0];}
  for (const key of ['anyOf', 'oneOf']) {
    const variants = schema[key];
    if (Array.isArray(variants) && variants.length > 0) {return schemaExample(variants[0]);}
  }
  if (schema.type === 'object' || schema.properties) {
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    return Object.fromEntries(required.map((key) => [key, schemaExample(properties[key])]));
  }
  if (schema.type === 'array') {return [schemaExample(schema.items)];}
  if (schema.type === 'string') {
    if (schema.format === 'date-time') {return '2030-01-02T03:04:05.000Z';}
    if (schema.format === 'date') {return '2030-01-02';}
    if (typeof schema.pattern === 'string' && schema.pattern.includes('a-z0-9')) {return 'fixture-01';}
    return 'fixture';
  }
  if (schema.type === 'integer' || schema.type === 'number') {return typeof schema.minimum === 'number' ? schema.minimum : 1;}
  if (schema.type === 'boolean') {return true;}
  return {};
}

function routeRequest(route: RouteOptions, method: FixtureMethod, invalid = false): { method: FixtureMethod; url: string; payload?: string; headers?: { 'content-type': string } } {
  const schema = (route.schema ?? {}) as { params?: unknown; querystring?: unknown; body?: unknown };
  const params = (schema.params as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  let url = route.url.replace(/:([^/]+)/g, (_match, name: string) => encodeURIComponent(String(schemaExample(params[name])))).replace(/\*/g, 'fixture');
  const query = invalid ? { __ux_fixture_invalid__: 'true' } : schemaExample(schema.querystring) as Record<string, unknown>;
  const search = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)] as [string, string]));
  if (search.size) {url += `?${search}`;}
  const request: { method: FixtureMethod; url: string; payload?: string; headers?: { 'content-type': string } } = { method, url };
  if (invalid && ['POST', 'PUT', 'PATCH'].includes(method) && schema.body) {
    const bodySchema = schema.body as { anyOf?: Array<{ maxProperties?: number }>; required?: string[]; properties?: Record<string, unknown> };
    const noBody = bodySchema.anyOf?.some((branch) => branch.maxProperties === 0) ?? false;
    const firstProperty = Object.entries(bodySchema.properties ?? {})[0];
    request.payload = noBody || !firstProperty
      ? '{"__ux_fixture_invalid__":true}'
      : JSON.stringify({ [firstProperty[0]]: invalidSchemaExample(firstProperty[1]) });
  }
  else if (!invalid && ['POST', 'PUT', 'PATCH'].includes(method) && schema.body) {request.payload = JSON.stringify(schemaExample(schema.body));}
  if (request.payload !== undefined) {request.headers = { 'content-type': 'application/json' };}
  return request;
}

function invalidSchemaExample(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null || !('type' in schema)) {return { __ux_fixture_invalid__: true };}
  switch (schema.type) {
    case 'string': return 1;
    case 'number':
    case 'integer': return 'invalid';
    case 'boolean': return 'invalid';
    case 'array': return {};
    case 'object': return 'invalid';
    default: return { __ux_fixture_invalid__: true };
  }
}

function makeTransport(callResult?: ServiceTransportResponse): IServiceTransport {
  const mockCall = vi.fn().mockResolvedValue(
    callResult ?? { ok: true, statusCode: 200, payload: { ok: true } },
  );
  return {
    connectionInfo: vi.fn().mockReturnValue({ baseUrl: 'http://localhost' }),
    call: mockCall,
    stream: vi.fn(),
    health: vi.fn(),
  } as unknown as IServiceTransport;
}

const absolutePathInResponse = /(?:^|["',\s])\/(?:[^"',\s]+\/)*[^"',\s]*/;
const windowsAbsolutePathInResponse = /(?:^|["',\s])[A-Za-z]:\\(?:[^"',\s]+\\)*[^"',\s]*/;

const mockTransport: IServiceTransport = makeTransport();

// ── App builder ───────────────────────────────────────────────────────────

async function buildHealthApp(
  config: Partial<GatewayConfig> = {},
  transport?: IServiceTransport,
  routeObserver?: Parameters<typeof import('../server.js').createServer>[10],
  projectRouting?: Parameters<typeof import('../server.js').createServer>[8],
  installationIdentity?: Parameters<typeof import('../server.js').createServer>[11],
) {
  // Dynamically import createServer — it uses the mocked platform
  const { createServer } = await import('../server.js');

  const fullConfig: GatewayConfig = {
    port: 0,
    upstreams: {},
    staticTokens: {},
    ...config,
  };

  const cache = makeCache();
  return createServer(fullConfig, cache, noopLogger, stubJwtConfig, undefined, transport ?? mockTransport, undefined, undefined, projectRouting, undefined, routeObserver, installationIdentity);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Gateway /health endpoint', () => {
  let app: Awaited<ReturnType<typeof buildHealthApp>>;

  afterEach(async () => {
    if (app) {await app.close();}
    vi.clearAllMocks();
  });

  // case: S-203.1
  it('returns healthy when all adapters available', async () => {
    mockAdapters = {
      llm: { complete: vi.fn() },
      cache: { get: vi.fn() },
      analytics: { track: vi.fn() },
      vectorStore: { search: vi.fn() },
      embeddings: { embed: vi.fn() },
    };
    app = await buildHealthApp();

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);

    const body = res.json().data;
    expect(body.status).toBe('healthy');
    expect(body.version).toBe('1.0');
    expect(body.adapters.llm.available).toBe(true);
    expect(body.adapters.cache.available).toBe(true);
    expect(body.adapters.analytics.available).toBe(true);
    expect(body.adapters.vectorStore.available).toBe(true);
    expect(body.adapters.embeddings.available).toBe(true);
  });

  // case: S-203.22
  it('keeps public health payloads free of absolute filesystem paths', async () => {
    mockAdapters = { llm: { complete: vi.fn() } };
    mockAdapterStatuses = [
      { slot: 'storage', mode: 'real', implementation: '@kb-labs/adapters-fs', configuredPackage: '@kb-labs/adapters-fs', recordedAt: new Date().toISOString() },
    ];
    const projectRuntimes = {
      acquire: async () => ({ host: '127.0.0.1', port: 1234, headers: {}, release: () => undefined }),
      status: () => ({ limit: 1, active: 0, runtimes: [] }),
    };
    app = await buildHealthApp({}, undefined, undefined, projectRuntimes);

    for (const url of ['/health', '/health/adapters']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.headers['www-authenticate']).toBeUndefined();
      expect(response.body).not.toMatch(absolutePathInResponse);
      expect(response.body).not.toMatch(windowsAbsolutePathInResponse);
    }
  });

  it('returns degraded when non-critical adapter missing', async () => {
    mockAdapters = {
      llm: { complete: vi.fn() },
      cache: { get: vi.fn() },
      analytics: undefined,       // missing
      vectorStore: undefined,     // missing
      embeddings: undefined,      // missing
    };
    app = await buildHealthApp();

    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json().data;
    expect(body.status).toBe('degraded');
    expect(body.adapters.llm.available).toBe(true);
    expect(body.adapters.analytics.available).toBe(false);
  });

  it('returns unhealthy when LLM unavailable', async () => {
    mockAdapters = {
      llm: undefined,             // critical missing
      cache: { get: vi.fn() },
      analytics: { track: vi.fn() },
      vectorStore: undefined,
      embeddings: undefined,
    };
    app = await buildHealthApp();

    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json().data;
    expect(body.status).toBe('unhealthy');
  });

  it('includes uptime and timestamp', async () => {
    mockAdapters = { llm: { complete: vi.fn() } };
    app = await buildHealthApp();

    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json().data;
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(typeof body.timestamp).toBe('string');
    expect(new Date(body.timestamp).getTime()).toBeGreaterThan(0);
  });

  // case: S-203.1
  it('preserves the public project runtime status in the UX health payload', async () => {
    mockAdapters = { llm: { complete: vi.fn() } };
    const projectRuntimes = {
      limit: 4,
      active: 1,
      runtimes: [{
        projectId: 'prj_project1',
        state: 'ready',
        lastUsedAt: '2026-10-03T12:00:00.000Z',
        inflight: 2,
        restarts: 0,
        keptRunningSchedules: 1,
      }],
    };
    app = await buildHealthApp({}, undefined, undefined, {
      acquire: async () => ({ host: '127.0.0.1', port: 1234, headers: {}, release: () => undefined }),
      status: () => projectRuntimes,
    });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.projectRuntimes).toEqual(projectRuntimes);
  });

  it('reports adapter latency', async () => {
    mockAdapters = {
      llm: { complete: vi.fn() },
      cache: { get: vi.fn() },
    };
    app = await buildHealthApp();

    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json().data;
    expect(typeof body.adapters.llm.latencyMs).toBe('number');
    expect(body.adapters.llm.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('probes upstream health', async () => {
    mockAdapters = { llm: { complete: vi.fn() } };
    const transport = makeTransport({ ok: true, statusCode: 200, payload: { ok: true } });

    app = await buildHealthApp({
      upstreams: {
        'rest-api': {
          serviceId: 'rest-api',
          prefix: '/api/v1',
        },
      },
    }, transport);

    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json().data;
    expect(body.upstreams['rest-api']).toBeDefined();
    expect(body.upstreams['rest-api'].status).toBe('up');
    expect(typeof body.upstreams['rest-api'].latencyMs).toBe('number');
  });

  it('reports readiness only for the configured upstream graph when project routing is enabled', async () => {
    mockAdapters = { llm: { complete: vi.fn() } };
    const transport = makeTransport({ ok: true, statusCode: 200, payload: { ok: true } });
    const projectRouting = {
      acquire: async () => ({ host: '127.0.0.1', port: 1234, headers: {}, release: () => undefined }),
      status: () => ({ limit: 4, active: 0, runtimes: [] }),
    };
    app = await buildHealthApp({
      upstreams: { marketplace: { serviceId: 'marketplace', prefix: '/api/v1/marketplace' } },
    }, transport, undefined, projectRouting);

    const response = await app.inject({ method: 'GET', url: '/ready' });
    const body = response.json().data;

    expect(response.statusCode).toBe(200);
    expect(body.ready).toBe(true);
    expect(body.components['upstream:marketplace']).toEqual({ ready: true, status: 'up' });
    expect(body.components).not.toHaveProperty('restUpstream');
    expect(body.components).not.toHaveProperty('workflowUpstream');
    expect(body.components.projectRuntimes).toEqual({ ready: true, status: '0/4 active' });
  });

  it('logs structured diagnostics when upstream health probe fails', async () => {
    mockAdapters = { llm: { complete: vi.fn() } };
    const transport: IServiceTransport = {
      connectionInfo: vi.fn().mockReturnValue({ baseUrl: 'http://localhost' }),
      call: vi.fn().mockRejectedValue(new Error('connect ETIMEDOUT')),
      stream: vi.fn(),
    } as unknown as IServiceTransport;

    app = await buildHealthApp({
      upstreams: {
        workflow: {
          serviceId: 'workflow',
          prefix: '/api/v1/workflow',
        },
      },
    }, transport);

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(noopLogger.warn).toHaveBeenCalledWith(
      'Gateway upstream health probe failed',
      expect.objectContaining({
        diagnosticEvent: 'gateway.upstream.health',
        reasonCode: 'upstream_unavailable',
        serviceId: 'gateway',
        route: '/api/v1/workflow/health',
        evidence: expect.objectContaining({
          upstreamId: 'workflow',
          serviceId: 'workflow',
        }),
      }),
    );
  });
});

describe('Gateway production route declarations', () => {
  it('discovers production routes and requires request and response schemas or an explicit raw declaration', async () => {
    let injectFailure = false;
    const routes: RouteOptions[] = [];
    const app = await buildHealthApp({ access: { mode: 'local' } }, undefined, (route) => {
      const original = route.handler;
      route.handler = async function (...args) {
        if (injectFailure) {throw new Error('fixture unexpected failure');}
        return original.apply(this, args);
      };
      routes.push(route);
    });
    try {
      expect(routes.length).toBeGreaterThan(0);
      const missing = routes.filter((route) => {
        const config = route.config as { ux?: string } | undefined;
        if (config?.ux === 'raw') {return false;}
        if (!route.schema || typeof route.schema !== 'object') {return true;}
        const schema = route.schema as { params?: unknown; querystring?: unknown; body?: unknown; response?: Record<number, unknown> };
        if (route.url.includes(':') && !schema.params) {return true;}
        const methods = Array.isArray(route.method) ? route.method : [route.method];
        const hasJsonMethod = methods.some((method) => method !== 'HEAD');
        if (hasJsonMethod && !schema.querystring) {return true;}
        if (methods.some((method) => ['POST', 'PUT', 'PATCH'].includes(method)) && !schema.body) {return true;}
        return hasJsonMethod && !Object.entries(schema.response ?? {}).some(([status]) => Number(status) >= 200 && Number(status) < 300);
      });
      expect(missing.map(({ method, url }) => `${Array.isArray(method) ? method.join(',') : method} ${url}`)).toEqual([]);

      const missingFixtureMetadata: string[] = [];
      for (const route of routes) {
        const config = route.config as { ux?: string } | undefined;
        if (config?.ux === 'raw') {
          expect(route.config).toMatchObject({ ux: 'raw' });
          continue;
        }
        const methods = (Array.isArray(route.method) ? route.method : [route.method]).filter((method) => method !== 'HEAD');
        for (const method of methods) {
          if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE') {continue;}
          const fixtureMethod = method as FixtureMethod;
          const valid = await app.inject(routeRequest(route, fixtureMethod));
          const responseSchemas = (route.schema as { response?: Record<number, unknown> } | undefined)?.response ?? {};
          for (const [status, responseSchema] of Object.entries(responseSchemas)) {
            if (Number(status) >= 400) {
              expect(responseSchema, `${method} ${route.url} error ${status} must use the shared UX failure schema`).toEqual(UxFailureResultJsonSchema);
            }
          }
          expect(responseSchemas[valid.statusCode], `${method} ${route.url} missing response schema for ${valid.statusCode}`).toBeDefined();
          const validBody = valid.json() as { ok?: boolean; data?: unknown; error?: { code?: string; message?: string; hint?: string; correlationId?: string } };
          expect(typeof validBody.ok, `${method} ${route.url} valid request did not return UX envelope`).toBe('boolean');
          if (validBody.ok === false) {
            expect(valid.statusCode).toBeGreaterThanOrEqual(400);
            expect(validBody.error?.code).toMatch(/^KB_/);
            expect(validBody.error?.message).toEqual(expect.any(String));
            expect(validBody.error?.hint).toEqual(expect.any(String));
            expect(validBody.error?.correlationId).toEqual(expect.any(String));
            const fixture = (route.config as { uxFixture?: { validResult?: 'error-envelope' } } | undefined)?.uxFixture;
            if (fixture?.validResult !== 'error-envelope') {missingFixtureMetadata.push(`${method} ${route.url}: ${valid.statusCode}`);}
          } else {expect(validBody).toHaveProperty('data');}

          const invalid = await app.inject(routeRequest(route, fixtureMethod, true));
          const invalidBody = invalid.json() as { ok?: boolean; error?: { code?: string; message?: string; hint?: string; correlationId?: string } };
          expect(invalid.statusCode, `${method} ${route.url} invalid request status`).toBe(400);
          expect(responseSchemas[invalid.statusCode], `${method} ${route.url} missing response schema for 400`).toBeDefined();
          expect(invalidBody).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String), correlationId: expect.any(String) } });

          injectFailure = true;
          const failed = await app.inject(routeRequest(route, fixtureMethod));
          injectFailure = false;
          const failureBody = failed.json() as { ok?: boolean; error?: { code?: string; correlationId?: string; hint?: string } };
          expect(failed.statusCode, `${method} ${route.url} unexpected failure injection did not reach handler`).toBe(500);
          expect(responseSchemas[failed.statusCode], `${method} ${route.url} missing response schema for 500`).toBeDefined();
          expect(failureBody).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_UNEXPECTED', correlationId: expect.any(String), hint: expect.any(String) } });
          expect(failed.body).not.toContain('fixture unexpected failure');
          expect(failureBody.error).not.toHaveProperty('stack');
        }
      }
      expect(missingFixtureMetadata, 'routes without live fixtures must declare their unavailable result beside the route').toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe('Gateway /health/adapters endpoint', () => {
  let app: Awaited<ReturnType<typeof buildHealthApp>>;

  afterEach(async () => {
    if (app) { await app.close(); }
    vi.clearAllMocks();
  });

  it('returns 200 with adapter status array', async () => {
    mockAdapters = {};
    mockAdapterStatuses = [
      { slot: 'cache', mode: 'inmemory', implementation: 'InMemoryCache', reason: 'not-configured', recordedAt: new Date().toISOString() },
      { slot: 'llm', mode: 'noop', implementation: 'NoOpLLM', reason: 'not-configured', recordedAt: new Date().toISOString() },
    ];
    app = await buildHealthApp();

    const res = await app.inject({ method: 'GET', url: '/health/adapters' });
    expect(res.statusCode).toBe(200);

    const body = res.json().data;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({ slot: 'cache', mode: 'inmemory' });
    expect(body[1]).toMatchObject({ slot: 'llm', mode: 'noop' });
  });

  it('serializes real adapter records without an optional degradation reason', async () => {
    mockAdapters = {};
    mockAdapterStatuses = [
      { slot: 'storage', mode: 'real', implementation: '@kb-labs/adapters-fs', recordedAt: new Date().toISOString() },
    ];
    app = await buildHealthApp();

    const res = await app.inject({ method: 'GET', url: '/health/adapters' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      data: [{ slot: 'storage', mode: 'real', implementation: '@kb-labs/adapters-fs' }],
    });
    expect(res.json().data[0]).not.toHaveProperty('reason');
  });

  it('returns empty array when no statuses recorded', async () => {
    mockAdapters = {};
    mockAdapterStatuses = [];
    app = await buildHealthApp();

    const res = await app.inject({ method: 'GET', url: '/health/adapters' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, data: [] });
  });

  it('is public (no auth required)', async () => {
    // /health/adapters should be accessible without Authorization header.
    mockAdapters = {};
    mockAdapterStatuses = [];
    app = await buildHealthApp();

    // No Authorization header — should NOT get 401.
    const res = await app.inject({ method: 'GET', url: '/health/adapters' });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(200);
  });
});

describe('Gateway /health/identity endpoint', () => {
  let app: Awaited<ReturnType<typeof buildHealthApp>>;

  afterEach(async () => {
    if (app) {await app.close();}
  });

  // case: S-203.22
  it('returns only the installation id without disclosing a filesystem path', async () => {
    app = await buildHealthApp({}, undefined, undefined, undefined, { installationId: 'receipt-b' });

    const response = await app.inject({ method: 'GET', url: '/health/identity' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ installationId: 'receipt-b' });
    expect(response.body).not.toMatch(absolutePathInResponse);
    expect(response.body).not.toMatch(windowsAbsolutePathInResponse);
  });
});
