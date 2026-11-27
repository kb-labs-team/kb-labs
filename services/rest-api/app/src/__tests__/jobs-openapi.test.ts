import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  registerOpenAPI,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from '@kb-labs/shared-http';
import {
  JobsListResponseSchema,
  ListJobsQuerySchema,
} from '@kb-labs/rest-api-contracts';
import { withUxErrorResponses } from '../routes/route-schema.js';

describe('scheduled jobs OpenAPI and validation', () => {
  // case: S-257.4
  it('documents the Zod request and response schemas with JSON error responses', async () => {
    const server = Fastify();
    await registerOpenAPI(server, { title: 'REST API', version: '1.0.0', ui: false });

    await server.register(async (scope) => {
      scope.setValidatorCompiler(validatorCompiler);
      scope.setSerializerCompiler(serializerCompiler);
      const routes = scope.withTypeProvider<ZodTypeProvider>();
      routes.get('/api/v1/jobs', {
        schema: {
          tags: ['Jobs'],
          summary: 'List scheduled jobs',
          querystring: ListJobsQuerySchema,
          response: withUxErrorResponses({ 200: JobsListResponseSchema }),
        },
      }, async (request) => ({
        jobs: [{ id: 'daily', name: 'Daily cleanup', status: request.query.status ?? 'active', schedule: '0 9 * * *' }],
      }));
    });

    await server.ready();
    const specResponse = await server.inject('/openapi.json');
    expect(specResponse.statusCode).toBe(200);
    const spec = specResponse.json() as {
      paths: Record<string, {
        get: {
          parameters?: Array<{ name: string; schema?: { enum?: string[] } }>;
          responses: Record<string, { content?: Record<string, { schema: unknown }> }>;
        };
      }>;
    };
    const operation = spec.paths['/api/v1/jobs']?.get;

    expect(operation).toBeDefined();
    expect(operation?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'status', schema: expect.objectContaining({ enum: ['active', 'paused'] }) }),
    ]));
    expect(operation?.responses['200']?.content?.['application/json']?.schema).toMatchObject({
      type: 'object',
      properties: { jobs: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, status: { enum: ['active', 'paused'] } } } } },
    });
    expect(operation?.responses['503']?.content?.['application/json']?.schema).toMatchObject({
      type: 'object',
      properties: { ok: { const: false }, error: { type: 'object' } },
    });

    const validResponse = await server.inject('/api/v1/jobs?status=active');
    expect(validResponse.statusCode).toBe(200);
    expect(validResponse.json()).toEqual({ jobs: [{ id: 'daily', name: 'Daily cleanup', status: 'active', schedule: '0 9 * * *' }] });

    const invalidResponse = await server.inject('/api/v1/jobs?status=unsupported');
    expect(invalidResponse.statusCode).toBe(400);
    await server.close();
  });
});
