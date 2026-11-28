/**
 * Registers @fastify/swagger + @fastify/swagger-ui on a Fastify instance.
 *
 * Routes without `tags:` are excluded from the spec (hideUntagged: true).
 * Use this as the visibility toggle — internal/undocumented routes simply
 * omit `tags:` and they won't appear in /docs or /openapi.json.
 *
 * Plain JSON Schema can be mixed with Zod schemas; the Zod type provider
 * converts only Zod fields for @fastify/swagger.
 *
 * @example
 * ```ts
 * import { registerOpenAPI } from '@kb-labs/shared-http';
 *
 * await registerOpenAPI(server, {
 *   title: 'My Service',
 *   version: '1.0.0',
 *   servers: [{ url: 'http://localhost:3000', description: 'Local dev' }],
 *   ui: process.env.NODE_ENV !== 'production',
 * });
 * ```
 */

import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import type { FastifyContextConfig } from 'fastify';
import { z } from 'zod';

/** Minimal structural interface to accept any Fastify instance regardless of version. */
interface FastifyLike {
  register(plugin: unknown, opts?: unknown): unknown;
  get(path: string, opts: unknown, handler: (req: unknown, reply: unknown) => unknown): void;
  addHook(name: 'onRoute', hook: (route: { url: string; config?: Record<string, unknown> }) => void): void;
  swagger?(): unknown;
}

function isZodSchema(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

/** Convert only Zod portions of a route schema; keep plain JSON Schema intact. */
function transformRouteSchema(input: Parameters<typeof jsonSchemaTransform>[0]) {
  const { schema } = input;
  const zodSchema = { ...schema };

  for (const key of ['body', 'querystring', 'params', 'headers'] as const) {
    if (!isZodSchema(zodSchema[key])) {
      delete zodSchema[key];
    }
  }

  const response = schema.response;
  const zodResponses = response && typeof response === 'object'
    ? Object.fromEntries(Object.entries(response).filter(([, responseSchema]) =>
      isZodSchema(responseSchema) || (
        responseSchema !== null && typeof responseSchema === 'object' &&
        'properties' in responseSchema && isZodSchema(responseSchema.properties)
      ),
    ))
    : {};
  if (Object.keys(zodResponses).length > 0) {
    zodSchema.response = zodResponses;
  } else {
    delete zodSchema.response;
  }

  const transformed = jsonSchemaTransform({ ...input, schema: zodSchema });
  const convertedResponses = transformed.schema.response;
  return {
    ...transformed,
    schema: {
      ...schema,
      ...transformed.schema,
      ...(response && convertedResponses && typeof convertedResponses === 'object'
        ? { response: { ...response, ...convertedResponses } }
        : {}),
    },
  };
}

export interface OpenAPIOptions {
  title: string;
  description?: string;
  version?: string;
  /** Route prefix for Swagger UI. Default: '/docs' */
  docsPath?: string;
  /** Route for the raw OpenAPI JSON spec. Default: '/openapi.json' */
  specPath?: string;
  /** Metadata applied to the standard OpenAPI routes. */
  routeConfig?: FastifyContextConfig;
  servers?: Array<{ url: string; description?: string }>;
  /**
   * Set to false to skip Swagger UI registration (e.g. in production).
   * The spec endpoint (/openapi.json) is still registered.
   * Default: true
   */
  ui?: boolean;
}

export async function registerOpenAPI(server: FastifyLike, options: OpenAPIOptions): Promise<void> {
  const swagger = await import('@fastify/swagger');

  // @fastify/swagger uses fastify-plugin — decorates the root instance with swagger().
  // The provider transform converts Zod v4 schemas across request and response
  // positions while preserving plain JSON Schema. Routes can freely mix both.
  await server.register(swagger.default ?? swagger, {
    openapi: {
      info: {
        title: options.title,
        description: options.description ?? '',
        version: options.version ?? '1.0.0',
      },
      servers: options.servers ?? [],
    },
    hideUntagged: true,
    transform: transformRouteSchema,
  });

  const specPath = options.specPath ?? '/openapi.json';
  const docsPath = options.docsPath ?? '/docs';

  // The Swagger UI and its static specification assets are documents/files,
  // not UX result routes. Declare that protocol shape on each live route.
  const docsRoot = docsPath.replace(/\/$/, '');
  server.addHook('onRoute', (route) => {
    if (route.url === docsRoot || route.url.startsWith(`${docsRoot}/`)) {
      route.config = { ...options.routeConfig, ...route.config, ux: 'raw' };
    }
  });

  if (options.ui !== false) {
    const swaggerUi = await import('@fastify/swagger-ui');

    await server.register(swaggerUi.default ?? swaggerUi, {
      routePrefix: docsPath,
      uiConfig: {
        docExpansion: 'list',
        deepLinking: true,
      },
    });
  }

  // /openapi.json — canonical spec endpoint.
  // x-openapi-spec: true header signals to response middlewares (e.g. envelope wrappers)
  // that this is a raw spec response and must not be wrapped.
  server.get(specPath, { config: { ...options.routeConfig, ux: 'raw' }, schema: { hide: true } }, (_req: unknown, reply: unknown) => {
    const s = server as { swagger?: () => Record<string, unknown> | undefined };
    const spec = s.swagger?.();
    const r = reply as {
      code(n: number): { send(v: unknown): unknown };
      header(k: string, v: string): unknown;
      send(v: unknown): unknown;
    };
    if (!spec) {
      r.code(503).send({ error: 'OpenAPI spec not ready' });
      return;
    }
    r.header('x-openapi-spec', '1');
    r.send(spec);
  });
}
