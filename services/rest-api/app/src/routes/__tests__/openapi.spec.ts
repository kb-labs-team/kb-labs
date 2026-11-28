import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { IEntityRegistry, OpenAPISpec } from '@kb-labs/plugin-contracts';
import { registerOpenAPIRoutes } from '../openapi.js';

describe('REST plugin OpenAPI route', () => {
  let app: ReturnType<typeof Fastify> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns merged plugin OpenAPI with paths', async () => {
    app = Fastify({ logger: false });
    const spec: OpenAPISpec = {
      openapi: '3.1.0',
      info: { title: 'Example plugin', version: '1.0.0' },
      paths: { '/example': { get: { summary: 'Example endpoint' } } },
    };
    const registry = {
      listPlugins: vi.fn(async () => [{ id: 'example' }]),
      getOpenAPISpec: vi.fn(async () => spec),
      snapshot: vi.fn(() => ({ rev: 'test-revision' })),
    } as unknown as IEntityRegistry;

    await registerOpenAPIRoutes(app, registry);
    const response = await app.inject({ method: 'GET', url: '/openapi-plugins.json' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(typeof body).toBe('object');
    expect(body.paths).toHaveProperty('/example');
    expect(response.headers['cache-control']).toContain('max-age=3600');
    expect(response.headers.etag).toBe('"test-revision"');
  });
});
