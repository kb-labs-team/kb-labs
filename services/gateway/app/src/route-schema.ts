import { UxFailureResultJsonSchema } from '@kb-labs/core-platform/error-envelope';
import type { FastifyInstance, RouteOptions } from 'fastify';

const uxErrorStatuses = [400, 401, 403, 404, 409, 422, 429, 500, 501, 502, 503] as const;
type UxErrorStatus = (typeof uxErrorStatuses)[number];
const uxErrorResponseSchema = UxFailureResultJsonSchema;

/** Declare the shared UX failure schema for the statuses a route can emit. */
export function uxErrorResponses<const Statuses extends readonly UxErrorStatus[]>(statuses: Statuses): Record<Statuses[number], typeof uxErrorResponseSchema> {
  return Object.fromEntries(statuses.map((status) => [status, uxErrorResponseSchema])) as Record<Statuses[number], typeof uxErrorResponseSchema>;
}

/** Add the shared UX failure schema to each declared error status. */
export function withUxErrorResponses<const Responses extends Record<number, unknown>>(
  responses: Responses,
): Omit<Responses, UxErrorStatus> & Record<UxErrorStatus, typeof UxFailureResultJsonSchema> {
  const result: Record<number, unknown> = {};
  for (const [statusText, schema] of Object.entries(responses)) {
    const status = Number(statusText);
    result[status] = status >= 400 ? uxErrorResponseSchema : schema;
  }
  for (const status of uxErrorStatuses) {result[status] = uxErrorResponseSchema;}
  return result as Omit<Responses, UxErrorStatus> & Record<UxErrorStatus, typeof UxFailureResultJsonSchema>;
}

/** Declare shared error responses for every JSON route as it is registered. */
export function registerGatewayRouteSchemas(app: FastifyInstance): void {
  app.addHook('onRoute', (route: RouteOptions) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (methods.includes('OPTIONS') || route.url.startsWith('/docs')) {
      route.config = { ...route.config, ux: 'raw' };
    }
    if (route.config?.ux === 'raw' || !route.schema || typeof route.schema !== 'object') {return;}
    const schema = route.schema as { response?: Record<number, unknown> };
    route.schema = { ...route.schema, response: withUxErrorResponses(schema.response ?? {}) };
  });
}

const noBodySchema = {
  anyOf: [
    { type: 'object', maxProperties: 0, additionalProperties: false },
    { type: 'null' },
  ],
} as const;

/** A route body that may be omitted on requests handled through a cookie. */
export function optionalRequestBodySchema<const Body extends Record<string, unknown>>(body: Body) {
  return { anyOf: [body, noBodySchema] } as const;
}
