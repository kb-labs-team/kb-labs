import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IEntityRegistry, RegistrySnapshot } from '@kb-labs/plugin-contracts';
import { restApiConfigSchema } from '@kb-labs/rest-api-core';
import { platform, resetPlatform } from '@kb-labs/core-runtime';
import { createServer } from '../server';
import type { RouteOptions } from 'fastify';
import { createErrorEnvelope } from '@kb-labs/core-platform';
import { PERMISSIONS } from '@kb-labs/core-contracts';
import { forwardedIdentityHeaders } from '@kb-labs/gateway-contracts';
import { assertNoStackTraceLeak } from './helpers/safe-error-envelope';

const snapshot: RegistrySnapshot = {
  schema: 'kb.registry/1',
  rev: 1,
  version: 'test',
  generatedAt: new Date(0).toISOString(),
  partial: false,
  stale: false,
  source: { cwd: process.cwd(), platformVersion: 'test' },
  plugins: [],
  manifests: [],
  inputs: [],
  candidateMemberships: [],
  inputFingerprint: '',
  ts: 0,
};

const registry = {
  initialize: async () => undefined,
  listPlugins: () => [],
  getManifest: () => null,
  getOpenAPISpec: () => null,
  getStudioRegistry: () => ({ version: 'test', generated: new Date(0).toISOString(), plugins: [] }),
  queryEntities: () => [],
  getEntity: () => null,
  getEntityKinds: () => [],
  snapshot: () => snapshot,
  refresh: async () => undefined,
  onChange: () => () => undefined,
  getSystemHealth: async () => ({ status: 'healthy', ts: new Date(0).toISOString() }),
  getDiagnostics: () => ({ events: [], summary: { errors: 0, warnings: 0, totalPlugins: 0, loadedPlugins: 0, failedPlugins: 0 }, byPlugin: {} }),
  enablePlugin: async () => undefined,
  disablePlugin: async () => undefined,
  dispose: async () => undefined,
} as unknown as IEntityRegistry;

function schemaExample(input: unknown): unknown {
  if (!input || typeof input !== 'object') return {};
  const schema = input as Record<string, unknown>;
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  for (const key of ['anyOf', 'oneOf']) {
    const alternatives = schema[key];
    if (Array.isArray(alternatives) && alternatives.length > 0) {
      const firstNonNull = alternatives.find((item) => (item as Record<string, unknown>)?.type !== 'null');
      return schemaExample(firstNonNull ?? alternatives[0]);
    }
  }
  if (schema.type === 'object' || schema.properties) {
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    return Object.fromEntries(required.map((key) => [key, schemaExample(properties[key])])) as Record<string, unknown>;
  }
  if (schema.type === 'array') {
    const count = typeof schema.minItems === 'number' ? Math.max(1, schema.minItems) : 1;
    return Array.from({ length: count }, () => schemaExample(schema.items));
  }
  if (schema.type === 'string') {
    if (schema.format === 'date-time') return '2030-01-02T03:04:05.000Z';
    if (schema.format === 'date') return '2030-01-02';
    if (schema.format === 'email') return 'fixture@example.test';
    if (typeof schema.pattern === 'string' && schema.pattern.includes('a-z0-9')) return 'fixture-01';
    return 'fixture';
  }
  if (schema.type === 'integer' || schema.type === 'number') return typeof schema.minimum === 'number' ? schema.minimum : 1;
  if (schema.type === 'boolean') return true;
  return {};
}

function pathForRoute(url: string, paramsSchema: unknown): string {
  const params = (paramsSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  return url.replace(/:([^/]+)/g, (_match, name: string) => encodeURIComponent(String(schemaExample(params[name])))).replace(/\*/g, 'fixture');
}

type FixtureMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function requestForRoute(route: RouteOptions, method: FixtureMethod): { method: FixtureMethod; url: string; payload?: string; headers?: Record<string, string> } {
  const schema = (route.schema ?? {}) as { params?: unknown; querystring?: unknown; body?: unknown };
  const query = schemaExample(schema.querystring) as Record<string, unknown>;
  const search = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)] as [string, string]));
  const request: { method: FixtureMethod; url: string; payload?: string; headers?: Record<string, string> } = {
    method,
    url: `${pathForRoute(route.url, schema.params)}${search.size ? `?${search}` : ''}`,
  };
  if (['POST', 'PUT', 'PATCH'].includes(method) && schema.body) {
    request.payload = JSON.stringify(schemaExample(schema.body));
    request.headers = { 'content-type': 'application/json' };
  }
  Object.assign(request.headers ??= {}, forwardedIdentityHeaders({
    type: 'user', userId: 'ux-route-registry', namespaceId: 'test', tier: 'enterprise',
    permissions: [PERMISSIONS.USERS_READ],
  }, process.env.GATEWAY_INTERNAL_SECRET));
  return request;
}

function invalidRequestForRoute(route: RouteOptions, method: FixtureMethod): { method: FixtureMethod; url: string; payload?: string; headers?: Record<string, string> } {
  const request = requestForRoute(route, method);
  const schema = (route.schema ?? {}) as { body?: unknown; querystring?: unknown };
  if (['POST', 'PUT', 'PATCH'].includes(method) && schema.body) {
    const bodySchema = schema.body as { anyOf?: Array<{ maxProperties?: number }>; properties?: Record<string, unknown>; required?: string[] };
    const isNoBody = bodySchema.anyOf?.some((branch) => branch.maxProperties === 0) ?? false;
    const hasRequired = (bodySchema.required?.length ?? 0) > 0;
    request.payload = isNoBody || !hasRequired && Object.keys(bodySchema.properties ?? {}).length === 0 ? '{"__ux_fixture_invalid__":true}' : '{}';
    request.headers = { 'content-type': 'application/json' };
  }
  const entries = new URL(request.url, 'http://fixture.test');
  entries.searchParams.set('__ux_fixture_invalid__', 'true');
  request.url = `${entries.pathname}${entries.search}`;
  return request;
}

function assertUxResult(response: { statusCode: number; body: string }, expectFailure: boolean): void {
  const body = JSON.parse(response.body) as { ok?: boolean; data?: unknown; error?: { code?: string; message?: string; hint?: string; correlationId?: string; stack?: string } };
  expect(typeof body.ok).toBe('boolean');
  if (expectFailure) {
    expect(response.statusCode).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toMatch(/^KB_/);
    expect(body.error?.message).toEqual(expect.any(String));
    expect(body.error?.hint).toEqual(expect.any(String));
    expect(body.error?.correlationId).toEqual(expect.any(String));
  } else if (body.ok === true) {
    expect(body).toHaveProperty('data');
  } else {
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(body.error?.code).toEqual(expect.any(String));
    expect(body.error?.code).not.toBe('');
    expect(body.error?.message).toEqual(expect.any(String));
    expect(body.error?.hint).toEqual(expect.any(String));
    expect(body.error?.correlationId).toEqual(expect.any(String));
  }
}

describe('REST production route declarations', () => {
  const apps: Array<Awaited<ReturnType<typeof createServer>>> = [];
  const originalTenantTier = process.env.KB_TENANT_DEFAULT_TIER;
  const originalInternalSecret = process.env.GATEWAY_INTERNAL_SECRET;

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    resetPlatform();
    vi.unstubAllGlobals();
    if (originalTenantTier === undefined) delete process.env.KB_TENANT_DEFAULT_TIER;
    else process.env.KB_TENANT_DEFAULT_TIER = originalTenantTier;
    if (originalInternalSecret === undefined) delete process.env.GATEWAY_INTERNAL_SECRET;
    else process.env.GATEWAY_INTERNAL_SECRET = originalInternalSecret;
  });

  it('adapts root Fastify log objects into platform logger message and fields', async () => {
    const info = vi.fn();
    const logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info,
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      flush: async () => {},
      child() { return logger; },
    };
    platform.setAdapter('logger', logger);

    const app = await createServer(restApiConfigSchema.parse({ port: 5050 }), process.cwd(), registry);
    apps.push(app);

    const fields = { requestId: 'root-log-request', route: '/health' };
    app.log.info(fields);

    expect(info).toHaveBeenCalledWith(JSON.stringify(fields), fields);
  });

  // case: S-203.1, S-203.2, S-203.3
  it('discovers production registrations and requires closed request and response schemas or an explicit raw declaration', async () => {
    process.env.KB_TENANT_DEFAULT_TIER = 'enterprise';
    process.env.GATEWAY_INTERNAL_SECRET = 'ux-route-registry-internal-secret';
    const routes: RouteOptions[] = [];
    const cache = new Map<string, unknown>();
    platform.setAdapter('cache', {
      get: async <T>(key: string) => (cache.get(key) as T | undefined) ?? null,
      set: async (key: string, value: unknown) => { cache.set(key, value); },
      delete: async (key: string) => { cache.delete(key); },
      clear: async () => { cache.clear(); },
    });
    platform.setAdapter('logger', { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ uptime: 0, totalEntries: 0, totalSize: 0, hitRate: 0, missRate: 0, evictions: 0, namespaces: {}, byTenant: {} }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const app = await createServer(restApiConfigSchema.parse({ port: 5050 }), process.cwd(), registry, (route) => {
      const original = route.handler;
      route.handler = async function (...args) {
        const [request, reply] = args as [
          { headers: Record<string, string | string[] | undefined> },
          { code: (status: number) => { send: (payload: unknown) => unknown } },
        ];
        const failure = request.headers['x-ux-fixture-failure'];
        if (failure === 'typed') {
          throw createErrorEnvelope('KB_PROJECT_DECLARATION_INVALID', {
            details: { field: 'project', expected: 'a valid .kb declaration' }, message: 'Project declaration failed.', hint: 'Repair the project declaration.',
          });
        }
        if (failure === 'plain') {
          const error = new Error('fixture plain failure') as Error & { statusCode: number; code: string; details: { path: string } };
          error.statusCode = 409;
          error.code = 'KB_PROJECT_ALREADY_REGISTERED';
          error.details = { path: '/fixture/project' };
          throw error;
        }
        if (failure === 'raw-reply') return reply.code(400).send({ error: { code: 'KB_RUNTIME_INPUT_INVALID' } });
        if (failure === 'unexpected') throw new Error('fixture unexpected failure');
        return original.apply(this, args);
      };
      routes.push(route);
    });
    apps.push(app);
    await app.ready();

    expect(routes.length).toBeGreaterThan(0);
    const missing = routes.filter((route) => {
      const config = route.config as { ux?: string } | undefined;
      if (config?.ux === 'raw') return false;
      if (!route.schema || typeof route.schema !== 'object') return true;
      const schema = route.schema as { params?: unknown; querystring?: unknown; body?: unknown; response?: Record<number, unknown> };
      if (route.url.includes(':') && !schema.params) return true;
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      const hasJsonMethod = methods.some((method) => method !== 'HEAD');
      if (hasJsonMethod && !schema.querystring) return true;
      if (methods.some((method) => ['POST', 'PUT', 'PATCH'].includes(method)) && !schema.body) return true;
      return hasJsonMethod && !schema.response?.[200];
    });
    expect(missing.map(({ method, url }) => `${Array.isArray(method) ? method.join(',') : method} ${url}`)).toEqual([]);

    const jsonRoutes: Array<{ route: RouteOptions; method: FixtureMethod }> = [];
    for (const route of routes) {
      const config = route.config as { ux?: string } | undefined;
      if (config?.ux === 'raw') {
        expect(route.config).toMatchObject({ ux: 'raw' });
        continue;
      }
      const methods = (Array.isArray(route.method) ? route.method : [route.method]).filter((method) => method !== 'HEAD');
      for (const method of methods) {
        if (method === 'GET' || method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') jsonRoutes.push({ route, method: method as FixtureMethod });
      }
    }

    const missingValidFixtureMetadata: string[] = [];
    for (const { route, method } of jsonRoutes) {
      const valid = await app.inject(requestForRoute(route, method));
      assertUxResult(valid, false);
      expect((route.schema as { response?: Record<number, unknown> }).response?.[valid.statusCode], `${method} ${route.url} missing response schema for ${valid.statusCode}`).toBeDefined();
      const routeConfig = route.config as { uxFixture?: { validResult?: 'error-envelope' } } | undefined;
      expect(valid.statusCode).toBeGreaterThanOrEqual(200);
      expect(valid.statusCode).toBeLessThan(600);
      if (valid.json().ok === false && routeConfig?.uxFixture?.validResult !== 'error-envelope') {
        const validBody = valid.json() as { error?: { code?: string } };
        missingValidFixtureMetadata.push(`${method} ${route.url}: ${valid.statusCode} ${validBody.error?.code}`);
      }

      const invalid = await app.inject(invalidRequestForRoute(route, method));
      expect(invalid.statusCode, `${method} ${route.url} invalid input status: ${invalid.body}`).toBe(400);
      expect((route.schema as { response?: Record<number, unknown> }).response?.[invalid.statusCode], `${method} ${route.url} missing response schema for 400`).toBeDefined();
      assertUxResult(invalid, true);

      const withFailure = (failure: 'typed' | 'plain' | 'raw-reply' | 'unexpected') => {
        const request = requestForRoute(route, method);
        return app.inject({ ...request, headers: { ...request.headers, 'x-ux-fixture-failure': failure } });
      };
      const typed = await withFailure('typed');
      expect(typed.statusCode, `${method} ${route.url} typed failure status`).toBe(422);
      expect(typed.json()).toMatchObject({ ok: false, error: {
        code: 'KB_PROJECT_DECLARATION_INVALID', message: 'Project declaration failed.',
        hint: 'Repair the project declaration.', details: { field: 'project', expected: 'a valid .kb declaration' },
        correlationId: expect.any(String),
      } });

      const plain = await withFailure('plain');
      expect(plain.statusCode).toBe(409);
      expect(plain.json()).toMatchObject({ ok: false, error: { code: 'KB_PROJECT_ALREADY_REGISTERED' } });

      const rawReply = await withFailure('raw-reply');
      expect(rawReply.statusCode).toBe(400);
      assertUxResult(rawReply, true);

      const failed = await withFailure('unexpected');
      expect(failed.statusCode, `${method} ${route.url} failure injection did not reach the handler`).toBe(500);
      expect((route.schema as { response?: Record<number, unknown> }).response?.[failed.statusCode], `${method} ${route.url} missing response schema for 500`).toBeDefined();
      const failureBody = failed.json() as { ok: boolean; error: { code: string; correlationId?: string; hint?: string } };
      expect(failureBody).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_UNEXPECTED' } });
      expect(failureBody.error.correlationId).toEqual(expect.any(String));
      expect(failureBody.error.hint).toEqual(expect.any(String));
      expect(failed.body).not.toContain('fixture unexpected failure');
      assertNoStackTraceLeak(failureBody);
    }
    expect(missingValidFixtureMetadata, 'routes without state fixtures must declare their valid unavailable result beside the route').toEqual([]);
  });
});
