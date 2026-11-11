/**
 * @module @kb-labs/core-registry/generators/openapi-spec
 * Generate OpenAPI specs from ManifestV3.
 * Moved from @kb-labs/cli-core/generators/openapi.
 */

import type { ManifestV3 } from '@kb-labs/plugin-contracts';
import type { OpenAPISpec } from '@kb-labs/plugin-contracts';

export function generateOpenAPISpec(manifest: ManifestV3): OpenAPISpec {
  const spec: OpenAPISpec = {
    openapi: '3.1.0',
    info: {
      title: manifest.display?.name || manifest.id,
      version: manifest.version,
      description: manifest.display?.description,
    },
    paths: {},
    components: { schemas: {} },
    'x-kb-plugin-id': manifest.id,
  };

  if (manifest.rest?.routes) {
    for (const route of manifest.rest.routes) {
      const p = route.path;
      const method = route.method.toLowerCase();
      if (!spec.paths[p]) {spec.paths[p] = {};}

      const operation: Record<string, unknown> = {
        summary: route.description || `${route.method} ${route.path}`,
        operationId: `${manifest.id}:${method}:${p}`,
        responses: { '200': { description: 'Success' } },
      };

      if (route.input) {
        operation.requestBody = {
          required: true,
          content: { 'application/json': { schema: route.input } },
        };
      }
      if (route.output) {
        operation.responses = {
          '200': {
            description: 'Success',
            content: { 'application/json': { schema: route.output } },
          },
        };
      }

      (spec.paths[p] as Record<string, unknown>)[method] = operation;
    }
  }

  return spec;
}
