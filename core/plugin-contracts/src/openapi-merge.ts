import type { OpenAPISpec } from './catalog.js';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function collectPaths(specs: OpenAPISpec[]): Array<[string, Record<string, unknown>]> {
  const allPaths: Array<[string, Record<string, unknown>]> = [];
  for (const spec of specs) {
    const pluginId = spec['x-kb-plugin-id'] || 'unknown';
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      const enhanced = { ...(pathItem as Record<string, unknown>) };
      for (const method of HTTP_METHODS) {
        if (enhanced[method]) {
          enhanced[method] = { ...(enhanced[method] as Record<string, unknown>), 'x-kb-plugin-id': pluginId };
        }
      }
      allPaths.push([path, enhanced]);
    }
  }
  return allPaths;
}

export function mergeOpenAPISpecs(specs: OpenAPISpec[]): OpenAPISpec {
  if (specs.length === 0) {
    return { openapi: '3.1.0', info: { title: 'KB Labs API', version: '1.0.0' }, paths: {} };
  }
  if (specs.length === 1) {return specs[0]!;}

  const merged: OpenAPISpec = {
    openapi: '3.1.0',
    info: { title: 'KB Labs API', version: '1.0.0', description: 'Aggregated API from all plugins' },
    paths: {},
    components: { schemas: {} },
  };

  const sorted = [...specs].sort((a, b) =>
    (a['x-kb-plugin-id'] || '').localeCompare(b['x-kb-plugin-id'] || ''),
  );

  const allPaths = collectPaths(sorted);
  allPaths.sort((a, b) => a[0].localeCompare(b[0]));
  for (const [path, pathItem] of allPaths) {
    merged.paths[path] = pathItem;
  }

  for (const spec of sorted) {
    const pluginId = spec['x-kb-plugin-id'] || 'unknown';
    if (spec.components?.schemas) {
      const entries = Object.entries(spec.components.schemas).sort((a, b) => a[0].localeCompare(b[0]));
      for (const [name, schema] of entries) {
        (merged.components!.schemas as Record<string, unknown>)[`${pluginId}__${name}`] = schema;
      }
    }
  }

  return merged;
}
