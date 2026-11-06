import { withUxErrorResponses } from './route-schema.js';
/**
 * @module @kb-labs/rest-api-app/routes/openapi
 * OpenAPI specification endpoints
 */

import type { FastifyInstance } from 'fastify';
import type { RestApiConfig } from '@kb-labs/rest-api-core';
import type { IEntityRegistry } from '@kb-labs/plugin-contracts';
import { mergeOpenAPISpecs, type OpenAPISpec } from '@kb-labs/plugin-contracts';
import { restDomainOperationMetrics } from '../middleware/metrics.js';

/**
 * Register OpenAPI routes
 */
export async function registerOpenAPIRoutes(
  fastify: FastifyInstance,
  config: RestApiConfig,
  repoRoot: string,
  registry: IEntityRegistry
) {
  // Plugin-manifest-merged OpenAPI spec (renamed from /openapi.json).
  // /openapi.json is now owned by @fastify/swagger (Fastify-native routes).
  // This endpoint aggregates specs from plugin manifests only.
  fastify.get('/openapi-plugins.json', {
    schema: {
      hide: true,
      querystring: { type: 'object', additionalProperties: false },
      response: withUxErrorResponses({ 200: { type: 'object', properties: { openapi: { type: 'string' }, info: { type: 'object', properties: { title: { type: 'string' }, version: { type: 'string' }, description: { type: 'string' } }, required: ['title', 'version'], additionalProperties: false }, paths: { type: 'object', additionalProperties: { type: 'object' } }, components: { type: 'object', properties: { schemas: { type: 'object', additionalProperties: { type: 'object' } } }, additionalProperties: false }, 'x-kb-plugin-id': { type: 'string' } }, required: ['openapi', 'info', 'paths'], additionalProperties: false } }),
    },
    config: {
      ux: 'raw',
      rateLimit: {
        max: 10, // 10 requests
        timeWindow: '1 minute',
      },
    },
  }, async (_, reply) => {
    try {
      const plugins = await restDomainOperationMetrics.observeOperation('plugin.registry.list', async () =>
        registry.listPlugins(),
      );
      const specs: OpenAPISpec[] = [];
      
      for (const plugin of plugins) {
        const spec = await restDomainOperationMetrics.observeOperation('openapi.plugin.get', async () =>
          registry.getOpenAPISpec(plugin.id),
        );
        if (spec) {
          specs.push(spec);
        }
      }
      
      const merged = await restDomainOperationMetrics.observeOperation('openapi.plugins.aggregate', async () =>
        mergeOpenAPISpecs(specs),
      );
      
      // Add caching headers (1 hour)
      const snapshot = registry.snapshot();
      reply.header('Cache-Control', 'public, max-age=3600');
      reply.header('ETag', `"${snapshot.rev}"`);
      
      reply.send(merged);
    } catch (error) {
      reply.code(500).send({
        ok: false,
        error: {
          code: 'OPENAPI_GENERATION_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  // Per-plugin OpenAPI spec
  fastify.get('/openapi/:pluginId', { config: { uxFixture: { validResult: 'error-envelope' } }, schema: {
    params: { type: 'object', properties: { pluginId: { type: 'string', minLength: 1 } }, required: ['pluginId'], additionalProperties: false },
    querystring: { type: 'object', additionalProperties: false },
    response: withUxErrorResponses({ 200: { type: 'object', properties: { openapi: { type: 'string' }, info: { type: 'object', properties: { title: { type: 'string' }, version: { type: 'string' }, description: { type: 'string' } }, required: ['title', 'version'], additionalProperties: false }, paths: { type: 'object', additionalProperties: { type: 'object' } }, components: { type: 'object', properties: { schemas: { type: 'object', additionalProperties: { type: 'object' } } }, additionalProperties: false }, 'x-kb-plugin-id': { type: 'string' } }, required: ['openapi', 'info', 'paths'], additionalProperties: false } }),
  } }, async (req, reply) => {
    try {
      const { pluginId } = req.params as { pluginId: string };
      const spec = await restDomainOperationMetrics.observeOperation('openapi.plugin.get', async () =>
        registry.getOpenAPISpec(pluginId),
      );
      
      if (!spec) {
        reply.code(404).send({
          ok: false,
          error: {
            code: 'PLUGIN_NOT_FOUND',
            message: `Plugin ${pluginId} not found`,
          },
        });
        return;
      }

      reply.send(spec);
    } catch (error) {
      reply.code(500).send({
        ok: false,
        error: {
          code: 'OPENAPI_GENERATION_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });
}
