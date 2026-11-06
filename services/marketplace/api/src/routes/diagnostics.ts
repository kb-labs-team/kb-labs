/**
 * @module @kb-labs/marketplace-api/routes/diagnostics
 * Service-level diagnostic endpoints.
 *
 * GET /diagnostics — marketplace health report. Accepts scope + projectRoot
 * in query so callers can probe either scope's lock health.
 */

import '../types.js';
import type { FastifyInstance } from 'fastify';
import { parseMutatingScope, scopeBodySchemaFragment } from '../scope-parser.js';

export function registerDiagnosticsRoutes(app: FastifyInstance): void {
  app.get('/diagnostics', {
    schema: {
      tags: ['Marketplace'],
      summary: 'Marketplace health and diagnostics report',
      querystring: {
        type: 'object',
        properties: scopeBodySchemaFragment,
      },
    },
  }, async (request, reply) => {
    const ctx = parseMutatingScope(request.query as Record<string, unknown>);
    const report = await app.observability.observeOperation(
      'marketplace.doctor',
      () => app.marketplace.doctor(ctx),
    );
    return reply.send(report);
  });
}
