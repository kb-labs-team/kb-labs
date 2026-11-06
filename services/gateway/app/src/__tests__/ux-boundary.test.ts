import Fastify from 'fastify';
import { Readable } from 'node:stream';
import { createErrorEnvelope, type ICache, type ILogger } from '@kb-labs/core-platform';
import { createUxFailureResult, isUxResult } from '@kb-labs/core-platform/ux-result';
import successFixture from '@kb-labs/core-platform/contracts/ux-result/fixtures/valid/success.json';
import failureFixture from '@kb-labs/core-platform/contracts/ux-result/fixtures/valid/failure.json';
import gatewayAuthHealthFixture from '@kb-labs/core-platform/contracts/ux-result/fixtures/valid/gateway-auth-health.json';
import { GatewayAuthHealthResponseSchema } from '@kb-labs/gateway-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerGatewayUxBoundary } from '../ux-boundary.js';
import { registerAuthHealthRoute } from '../auth/health-route.js';
import { registerTelemetryRoutes } from '../telemetry/routes.js';
import { createAuthMiddleware } from '../auth/middleware.js';

describe('Gateway UX boundary', () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()));
  });

  // case: S-203.1, S-203.2, S-203.3
  it('leaves a route raw only when its route definition declares ux: raw', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as ILogger;
    registerGatewayUxBoundary(app, logger);
    app.get('/raw-response', { config: { ux: 'raw' } }, async () => 'studio shell');
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/raw-response' });
    expect(response.body).toBe('studio shell');
    expect(response.headers['content-type']).toContain('text/plain');
  });

  // case: S-190.2
  it('preserves the invalid field in the catalogued telemetry limit error', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as ILogger;
    registerGatewayUxBoundary(app, logger);
    registerTelemetryRoutes(app, logger);
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/telemetry/v1/ingest',
      payload: { events: Array.from({ length: 501 }, (_, index) => ({ source: 'case', type: `event.${index}` })) },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: 'KB_RUNTIME_INPUT_INVALID',
        details: { field: 'events' },
      },
    });
  });

  // case: S-203.2
  it('returns a resource-not-found envelope for an unknown Gateway route', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as ILogger;
    registerGatewayUxBoundary(app, logger);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/not-a-gateway-route' });

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: 'KB_RUNTIME_RESOURCE_NOT_FOUND',
        correlationId: expect.any(String),
      },
    });
  });

  // case: S-041.15, S-203.2
  it('hides denied auth readiness with the exact unknown-route response contract', async () => {
    const app = Fastify({ logger: false, trustProxy: true });
    apps.push(app);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as ILogger;
    registerGatewayUxBoundary(app, logger);
    const cache = { get: async () => null, set: async () => undefined, delete: async () => undefined, clear: async () => undefined } as unknown as ICache;
    app.addHook('onRequest', createAuthMiddleware(cache, { secret: 'test-secret' }, { authEnabled: true }));
    const getReadiness = vi.fn(async () => { throw new Error('readiness must not be computed'); });
    registerAuthHealthRoute(app, getReadiness);
    await app.ready();

    const denied = await app.inject({
      method: 'GET', url: '/health/auth', headers: { 'x-forwarded-for': '127.0.0.1' },
    });
    const unknown = await app.inject({ method: 'GET', url: '/not-a-gateway-route' });
    const deniedBody = denied.json();
    const unknownBody = unknown.json();

    expect(denied.statusCode).toBe(404);
    expect(deniedBody.ok).toBe(false);
    expect(deniedBody.error.code).toBe('KB_RUNTIME_RESOURCE_NOT_FOUND');
    expect(deniedBody.error.correlationId).toEqual(expect.any(String));
    expect(deniedBody.error).not.toHaveProperty('details');
    expect(deniedBody.error).not.toHaveProperty('readinessSecret');
    expect(getReadiness).not.toHaveBeenCalled();
    expect(deniedBody.error.correlationId).not.toBe(unknownBody.error.correlationId);
    expect({ ...deniedBody, error: { ...deniedBody.error, correlationId: '<correlation>' } })
      .toEqual({ ...unknownBody, error: { ...unknownBody.error, correlationId: '<correlation>' } });
  });

  it('normalizes a plain text HTTP failure without exposing its body', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as ILogger;
    registerGatewayUxBoundary(app, logger);
    app.get('/plain-text-failure', async (_request, reply) => reply.code(502).type('text/plain').send('private upstream detail'));
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/plain-text-failure' });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ ok: false, error: {
      code: 'KB_RUNTIME_UNEXPECTED', correlationId: expect.any(String),
    } });
    expect(response.body).not.toContain('private upstream detail');
  });

  it('canonicalizes failure-shaped success responses through the platform error validator', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as ILogger;
    registerGatewayUxBoundary(app, logger);
    app.get('/forged-failure', async () => ({
      ok: false,
      error: {
        code: 'KB_FAKE', area: 'product', stage: 'run', severity: 'error', retryable: false,
        message: 'forged', hint: 'forged', details: { nested: JSON.stringify({ value: 1 }) },
      },
    }));
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/forged-failure' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'KB_PLUGIN_CONTRACT_VIOLATION' } });
    expect(response.body).not.toContain('KB_FAKE');
  });

  // case: S-203.1, S-203.2, S-203.3
  it('covers each route discovered from the live Fastify registry', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    const errorLog = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: errorLog, debug: vi.fn(), child: vi.fn() } as unknown as ILogger;
    const routes: Array<{ method: string | string[]; url: string; config?: { ux?: string } }> = [];
    app.addHook('onRoute', route => { routes.push({ method: route.method, url: route.url, config: route.config }); });
    registerGatewayUxBoundary(app, logger);
    app.get('/contract-probe', { schema: { querystring: {
      type: 'object', properties: { mode: { type: 'string', enum: ['success', 'typed', 'plain', 'unexpected'] } },
      additionalProperties: false,
    } } }, async (request, reply) => {
      const mode = (request.query as { mode?: string }).mode;
      if (mode === 'typed') return reply.code(422).send(createUxFailureResult(createErrorEnvelope('KB_PROJECT_DECLARATION_INVALID', {
        details: { expected: 'a declared field', field: 'projectId' }, message: 'Project declaration failed.', hint: 'Repair the project declaration.',
      })));
      if (mode === 'plain') {
        const error = new Error('fixture plain failure') as Error & { statusCode: number; code: string; details: { path: string } };
        error.statusCode = 409;
        error.code = 'KB_PROJECT_ALREADY_REGISTERED';
        error.details = { path: '/registered/project' };
        throw error;
      }
      if (mode === 'unexpected') throw new Error('private stack detail');
      return { accepted: true };
    });
    app.get('/stream-probe', { config: { ux: 'raw' } }, async (_request, reply) => {
      reply.type('text/plain');
      return Readable.from(['stream', ' response']);
    });
    await app.ready();

    expect(isUxResult(successFixture)).toBe(true);
    expect(isUxResult(failureFixture)).toBe(true);
    expect(isUxResult(gatewayAuthHealthFixture)).toBe(true);
    expect(GatewayAuthHealthResponseSchema.parse(gatewayAuthHealthFixture.data)).toMatchObject({ bootstrap: 'exists-non-active' });
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      if (route.config?.ux === 'raw') continue;
      const registeredMethod = Array.isArray(route.method) ? route.method[0] : route.method;
      expect(['GET', 'HEAD']).toContain(registeredMethod);
      const success = await app.inject({ method: 'GET', url: `${route.url}?mode=success` });
      expect(success.statusCode).toBe(200);
      expect(isUxResult(success.json())).toBe(true);
      expect(success.json()).toMatchObject({ ok: true, data: { accepted: true } });

      const typed = await app.inject({ method: 'GET', url: `${route.url}?mode=typed` });
      expect(typed.statusCode, typed.body).toBe(422);
      expect(isUxResult(typed.json())).toBe(true);
      expect(typed.json().error).toMatchObject({
        code: 'KB_PROJECT_DECLARATION_INVALID',
        message: 'Project declaration failed.',
        hint: 'Repair the project declaration.',
        details: { expected: 'a declared field', field: 'projectId' },
        correlationId: expect.any(String),
      });

      const plain = await app.inject({ method: 'GET', url: `${route.url}?mode=plain` });
      expect(plain.statusCode, plain.body).toBe(409);
      expect(plain.json()).toMatchObject({ ok: false, error: { code: 'KB_PROJECT_ALREADY_REGISTERED' } });

      const validation = await app.inject({ method: 'GET', url: `${route.url}?mode=not-valid` });
      expect(validation.statusCode).toBe(400);
      expect(validation.json()).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID' } });

      const unexpected = await app.inject({ method: 'GET', url: `${route.url}?mode=unexpected` });
      expect(unexpected.statusCode).toBe(500);
      expect(isUxResult(unexpected.json())).toBe(true);
      expect(unexpected.json().error).toMatchObject({ code: 'KB_RUNTIME_UNEXPECTED', correlationId: expect.any(String) });
      expect(unexpected.body).not.toContain('private stack detail');
      expect(errorLog).toHaveBeenCalledWith('HTTP route failed', expect.any(Error), expect.objectContaining({ correlationId: unexpected.json().error.correlationId }));
    }
    const stream = await app.inject({ method: 'GET', url: '/stream-probe' });
    expect(stream.statusCode).toBe(200);
    expect(stream.body).toBe('stream response');
    expect(stream.headers['content-type']).toContain('text/plain');
  });

  it('logs an aborted client request as a warning', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as ILogger;
    registerGatewayUxBoundary(app, logger);
    app.get('/aborted-request', async () => { throw new DOMException('Request aborted', 'AbortError'); });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/aborted-request' });

    expect(response.statusCode).toBe(499);
    expect(response.json().error).toMatchObject({ code: 'KB_RUNTIME_REQUEST_CANCELLED', severity: 'warning' });
    expect(logger.warn).toHaveBeenCalledWith('HTTP route failed', expect.any(DOMException), expect.objectContaining({
      statusCode: 499,
      errorCode: 'KB_RUNTIME_REQUEST_CANCELLED',
    }));
    expect(logger.error).not.toHaveBeenCalled();
  });
});
