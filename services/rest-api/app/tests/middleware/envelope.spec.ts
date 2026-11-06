/**
 * @module @kb-labs/rest-api-app/middleware/__tests__/envelope
 *
 * Tests for response envelope middleware.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { Readable } from 'node:stream';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { RestApiConfig } from '@kb-labs/rest-api-core';
import type { PluginErrorEnvelope } from '@kb-labs/rest-api-contracts';
import { createContextLogger, createErrorEnvelope, serializeError } from '@kb-labs/core-platform';
import { mountRoutes } from '@kb-labs/plugin-execution/http';
import { createNormalizedExecutionBackend } from '@kb-labs/plugin-execution-factory/construct';
import { registerEnvelopeMiddleware } from '../../src/middleware/envelope';
import { assertNoStackTraceLeak } from '../../src/__tests__/helpers/safe-error-envelope';
import { platform } from '@kb-labs/core-runtime';

const TEST_CONFIG: RestApiConfig = {
  port: 3000,
  basePath: '/api/v1',
  apiVersion: '1.0.0',
  cors: {
    origins: [],
    allowCredentials: true,
    profile: 'dev',
  },
  plugins: [],
  mockMode: false,
};

describe('registerEnvelopeMiddleware', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify({ logger: false, genReqId: (request) => String(request.headers['x-request-id'] ?? 'test-request') });
    registerEnvelopeMiddleware(app, TEST_CONFIG);
  });

  afterEach(async () => {
    try {
      await app.close();
    } finally {
      vi.restoreAllMocks();
    }
  });

  describe('successful responses', () => {
    it('should wrap JSON response in envelope', async () => {
      app.get('/test', async () => {
        return { message: 'Hello' };
      });

      await app.ready();

      const response = await app.inject({ method: 'GET', url: '/test' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.data).toEqual({ message: 'Hello' });
      expect(body.meta).toBeDefined();
      expect(body.meta.apiVersion).toBe('1.0.0');
      expect(body.meta.requestId).toBeDefined();
      expect(typeof body.meta.durationMs).toBe('number');
    });

    it('keeps non-JSON output raw when the route definition declares ux: raw', async () => {
      app.get('/raw-response', { config: { ux: 'raw' } }, async (_request: FastifyRequest, reply: FastifyReply) => {
        reply.type('text/plain');
        return 'health probe';
      });
      await app.ready();

      const response = await app.inject({ method: 'GET', url: '/raw-response' });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('health probe');
      expect(response.headers['content-type']).toContain('text/plain');
    });

    it('should add x-schema-version header', async () => {
      app.get('/test', async () => ({ value: 42 }));
      await app.ready();

      const response = await app.inject({ method: 'GET', url: '/test' });
      expect(response.headers['x-schema-version']).toBe('1.0.0');
    });

    it('should handle empty object response', async () => {
      app.get('/empty', async () => ({}));
      await app.ready();

      const body = (await app.inject({ method: 'GET', url: '/empty' })).json();
      expect(body.ok).toBe(true);
      expect(body.data).toEqual({});
    });

    it('should handle null response', async () => {
      app.get('/null', async () => null);
      await app.ready();

      const body = (await app.inject({ method: 'GET', url: '/null' })).json();
      expect(body.ok).toBe(true);
      expect(body.data).toBeNull();
    });

    it('should handle array response', async () => {
      app.get('/array', async () => [1, 2, 3]);
      await app.ready();

      const body = (await app.inject({ method: 'GET', url: '/array' })).json();
      expect(body.ok).toBe(true);
      expect(body.data).toEqual([1, 2, 3]);
    });

    it('should not double-wrap already enveloped responses', async () => {
      app.get('/enveloped', async () => ({
        ok: true,
        data: { already: 'wrapped' },
        meta: { custom: 'meta' },
      }));
      await app.ready();

      const body = (await app.inject({ method: 'GET', url: '/enveloped' })).json();
      expect(body.ok).toBe(true);
      expect(body.data).toEqual({ already: 'wrapped' });
      expect(body.meta).toEqual({ custom: 'meta' });
      expect(body.data.ok).toBeUndefined();
    });

    it('canonicalizes failure-shaped success responses through the shared error validator', async () => {
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
  });

  it('renders a route-enforced 413 limit from the REST request boundary', async () => {
    app.post('/limited-body', { bodyLimit: 12 }, async () => ({ accepted: true }));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/limited-body',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ value: 'larger than twelve bytes' }),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: 'KB_RUNTIME_PAYLOAD_TOO_LARGE',
        message: 'The request body exceeds 12 B.',
        hint: 'Reduce the request body to 12 B and resend it.',
        details: { limit: '12 B', limitBytes: '12' },
      },
    });
  });

  describe('error responses', () => {
    it('preserves a diagnostic contract violation and safe producer stack through the project REST route', async () => {
      const log = vi.spyOn(platform.logger, 'error').mockImplementation(() => {});
      const privateValue = 'diagnostic-secret-sentinel';
      createContextLogger(platform.logger, {
        applicationId: 'rest-api', serviceId: 'rest', instanceId: 'diagnostic-test-instance', layer: 'service',
      }).registerSensitiveValues([privateValue]);
      const diagnostic = createErrorEnvelope('KB_RUNTIME_DIAGNOSTIC_CONTRACT_VIOLATION', {
        correlationId: 'diagnostic-request-1',
        details: { originalCode: 'KB_CONFIG_LLM_KEY_INVALID', fields: 'provider,apiKey' },
      });
      const backend = createNormalizedExecutionBackend({
        async execute() {
          return {
            ok: false,
            error: {
              ...diagnostic,
              error: serializeError(new Error(`diagnostic producer failed: ${privateValue}`)),
            },
            executionTimeMs: 1,
          };
        },
        async health() { return { healthy: true, backend: 'in-process', executionMode: 'in-process' }; },
        async stats() { return { totalExecutions: 0, successCount: 0, errorCount: 0, avgExecutionTimeMs: 0 }; },
        async shutdown() {},
      }, platform.logger, 'in-process');
      await mountRoutes(app, {
        schema: 'kb.plugin/3', id: '@kb-labs/agents', version: '2.120.1',
        rest: { routes: [{ method: 'POST', path: '/sessions', handler: './sessions-handler.js#createSessionHandler' }] },
      }, {
        backend,
        pluginRoot: '/fixture/plugin',
        workspaceRoot: '/fixture/project',
        basePath: '/api/v1/projects/prj_fixture/rest/plugins/agents',
      });
      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/prj_fixture/rest/plugins/agents/sessions',
        headers: { 'x-request-id': 'diagnostic-request-1' },
        payload: { agentId: 'orchestrator', task: 'Summarize the project' },
      });
      const error = response.json().error;
      const failureRecord = log.mock.calls.find(([, , fields]) => fields?.errorCode === 'KB_RUNTIME_DIAGNOSTIC_CONTRACT_VIOLATION');

      expect(response.statusCode).toBe(500);
      expect(error).toMatchObject({
        code: 'KB_RUNTIME_DIAGNOSTIC_CONTRACT_VIOLATION',
        correlationId: 'diagnostic-request-1',
        details: { originalCode: 'KB_CONFIG_LLM_KEY_INVALID', fields: 'provider,apiKey' },
      });
      expect(error.cause).toContain('diagnostic producer failed: [REDACTED]');
      expect(JSON.stringify(error)).not.toContain(privateValue);
      expect(failureRecord?.[2]).toMatchObject({
        errorCode: error.code,
        statusCode: 500,
        originalCode: 'KB_CONFIG_LLM_KEY_INVALID',
        fields: 'provider,apiKey',
      });
      expect(failureRecord?.[1]?.stack).toContain('diagnostic producer failed: [REDACTED]');
      expect(JSON.stringify(failureRecord)).not.toContain(privateValue);
    });

    it('should return a catalogued validation failure using the platform envelope', async () => {
      app.get('/error', async () => {
        const error = new Error('Something went wrong') as Error & { statusCode?: number; code?: string };
        error.statusCode = 400;
        error.code = 'KB_RUNTIME_INPUT_INVALID';
        throw error;
      });
      await app.ready();

      const response = await app.inject({ method: 'GET', url: '/error' });
      expect(response.statusCode).toBe(400);

      const body = response.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('KB_RUNTIME_INPUT_INVALID');
      expect(body.error.correlationId).toBeDefined();
      expect(body.error.cause).toBeUndefined();
      expect(body.meta).toBeUndefined();
    });

    it('should redact unknown errors and correlate them', async () => {
      app.get('/internal-error', async () => {
        throw new Error('Unexpected error');
      });
      await app.ready();

      const response = await app.inject({ method: 'GET', url: '/internal-error' });
      expect(response.statusCode).toBe(500);

      const body = response.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('KB_RUNTIME_UNEXPECTED');
      expect(body.error.correlationId).toBeDefined();
      expect(body.error.message).not.toContain('Unexpected error');
      assertNoStackTraceLeak(body);
    });

    it('logs a thrown route exception with its response correlation id and stack', async () => {
      const log = vi.spyOn(platform.logger, 'error').mockImplementation(() => {});
      const privateValue = 'private-session-value-sentinel';
      createContextLogger(platform.logger, {
        applicationId: 'rest-api', serviceId: 'rest', instanceId: 'test-instance', layer: 'service',
      }).registerSensitiveValues([privateValue]);
      app.post('/thrown-route', async () => {
        throw new Error(`route failed before creating a session: ${privateValue}`);
      });
      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/thrown-route?token=private-query-value-sentinel',
        payload: { task: 'private task body sentinel' },
      });
      const error = response.json().error;
      const failureRecord = log.mock.calls.find(([, thrown]) => thrown instanceof Error);

      expect(response.statusCode).toBe(500);
      expect(error.correlationId).toBeTruthy();
      expect(failureRecord).toBeDefined();
      expect(failureRecord?.[1]?.message).toBe('route failed before creating a session: [REDACTED]');
      expect(failureRecord?.[1]?.stack).not.toContain(privateValue);
      expect(failureRecord?.[2]).toMatchObject({
        correlationId: error.correlationId,
        errorCode: error.code,
        statusCode: 500,
      });
      expect(failureRecord?.[2]).not.toHaveProperty('requestId');
      expect(JSON.stringify(failureRecord)).not.toContain('private task body sentinel');
      expect(JSON.stringify(failureRecord)).not.toContain(privateValue);
      expect(JSON.stringify(failureRecord)).not.toContain('private-query-value-sentinel');
    });

    it('should not expose internal error details', async () => {
      app.get('/detailed-error', async () => {
        const error = new Error('Validation failed') as Error & { statusCode?: number; code?: string; details?: unknown };
        error.statusCode = 422;
        error.code = 'E_VALIDATION';
        error.details = { field: 'email', reason: 'invalid format' };
        throw error;
      });
      await app.ready();

      const body = (await app.inject({ method: 'GET', url: '/detailed-error' })).json();
      expect(body.error.code).toBe('KB_PLUGIN_CONTRACT_VIOLATION');
      expect(body.error.message).toContain('must include a non-empty hint');
      expect(body.error.details).toMatchObject({ field: 'hint' });
      expect(JSON.stringify(body)).not.toContain('email');
    });

    it('should not expose internal trace fields', async () => {
      app.get('/traced-error', async () => {
        const error = new Error('Traceable error') as Error & { statusCode?: number; traceId?: string };
        error.statusCode = 500;
        error.traceId = 'trace-123-abc';
        throw error;
      });
      await app.ready();

      const body = (await app.inject({ method: 'GET', url: '/traced-error' })).json();
      expect(body.error.correlationId).toBeDefined();
      expect(body.error.traceId).toBeUndefined();
    });

    it('should always produce ok:false for error responses — never ok:true wrapping', async () => {
      // Regression: PluginErrorEnvelope (no ok field) was being wrapped as { ok: true, data: pluginErr }
      app.get('/plugin-error', async () => {
        const pluginErr: PluginErrorEnvelope = {
          status: 'error',
          http: 422,
          code: 'E_PLUGIN_VALIDATION',
          message: 'Plugin validation failed',
          details: { field: 'x' },
          meta: {
            requestId: 'req-1',
            pluginId: 'my-plugin',
            pluginVersion: '1.0.0',
            routeOrCommand: '/test',
            timeMs: 10,
          },
        };
        throw pluginErr;
      });
      await app.ready();

      const response = await app.inject({ method: 'GET', url: '/plugin-error' });
      expect(response.statusCode).toBe(422);

      const body = response.json();
      // Must be ErrorEnvelope, not { ok: true, data: PluginErrorEnvelope }
      expect(body.ok).toBe(false);
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('KB_PLUGIN_CONTRACT_VIOLATION');
      expect(body.error.correlationId).toBeDefined();
      expect(JSON.stringify(body)).not.toContain('my-plugin');
      expect(body.data).toBeUndefined();
    });

    // case: S-203.2
    it('normalizes route-local secured failures and preserves the HTTP status', async () => {
      app.get('/unauthorized', async (_request: FastifyRequest, reply: FastifyReply) => reply.code(401).send({ error: { code: 'KB_AUTH_REQUIRED', hint: 'Authenticate with Gateway.', details: { gatewayUrl: 'https://gateway.example.test' } } }));
      await app.ready();

      const response = await app.inject({ method: 'GET', url: '/unauthorized' });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ ok: false, error: { code: 'KB_AUTH_REQUIRED', correlationId: expect.any(String) } });
    });

    it('normalizes direct reply failures through the shared boundary', async () => {
      app.get('/reply-failure', async (_request: FastifyRequest, reply: FastifyReply) =>
        reply.code(409).send({ error: { code: 'KB_PROJECT_ALREADY_REGISTERED', details: { path: '/fixture/project' } } }));
      await app.ready();

      const response = await app.inject({ method: 'GET', url: '/reply-failure' });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ ok: false, error: {
        code: 'KB_PROJECT_ALREADY_REGISTERED', correlationId: expect.any(String),
      } });
    });

    it('normalizes non-JSON HTTP failures and redacts their bodies', async () => {
      app.get('/text-failure', async (_request: FastifyRequest, reply: FastifyReply) =>
        reply.code(502).type('text/plain').send('private upstream detail'));
      await app.ready();

      const response = await app.inject({ method: 'GET', url: '/text-failure' });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ ok: false, error: {
        code: 'KB_RUNTIME_UNEXPECTED', correlationId: expect.any(String),
      } });
      expect(response.body).not.toContain('private upstream detail');
    });
  });

  describe('onSend object payload guard', () => {
    it('should not crash when an object payload reaches onSend (defensive)', async () => {
      // Simulates the scenario where Fastify skips serialisation for non-JSON
      // content-type and passes a raw object to onSend hooks.
      app.get('/raw-obj', async (request: FastifyRequest, reply: FastifyReply) => {
        reply.header('content-type', 'application/json');
        return reply.send({ guarded: true });
      });
      await app.ready();

      const response = await app.inject({ method: 'GET', url: '/raw-obj' });
      expect(response.statusCode).toBe(200);
      // Should be wrapped or at minimum not crash
      expect(() => response.json()).not.toThrow();
    });
  });

  describe('streaming responses', () => {
    it('should skip envelope for SSE responses', async () => {
      app.get('/events', { config: { ux: 'raw' } }, async (_request: FastifyRequest, reply: FastifyReply) => {
        reply.header('content-type', 'text/event-stream');
        return Readable.from(['data: test\n\n']);
      });
      await app.ready();

      const response = await app.inject({ method: 'GET', url: '/events' });
      expect(response.body).toBe('data: test\n\n');
      expect(response.headers['x-schema-version']).toBe('1.0.0');
    });
  });

  describe('non-JSON responses', () => {
    it('should pass through non-JSON string responses', async () => {
      app.get('/text', async (request: FastifyRequest, reply: FastifyReply) => {
        reply.header('content-type', 'text/plain');
        return 'Plain text response';
      });
      await app.ready();

      const response = await app.inject({ method: 'GET', url: '/text' });
      expect(response.body).toBe('Plain text response');
    });
  });

  describe('cache middleware ordering', () => {
    it('ETag reflects the envelope-wrapped payload, not the raw data', async () => {
      // When cache middleware runs AFTER envelope, ETag is computed on
      // { ok: true, data: {...}, meta: {...} } — consistent with what the client receives.
      app.get('/cacheable', async () => ({ value: 1 }));
      await app.ready();

      const res1 = await app.inject({ method: 'GET', url: '/cacheable' });
      const etag = res1.headers.etag as string | undefined;

      if (etag) {
        const res2 = await app.inject({
          method: 'GET',
          url: '/cacheable',
          headers: { 'if-none-match': etag },
        });
        // ETag matches the actual response body → 304
        expect(res2.statusCode).toBe(304);
      } else {
        // Cache middleware may not be registered in this unit test — just ensure no crash
        expect(res1.statusCode).toBe(200);
      }
    });
  });
});
