/**
 * @module @kb-labs/marketplace-api/routes/workspace
 * Workspace-level operations (not tied to a specific package).
 *
 * POST /workspace/sync — scan workspace and populate lock. Scope-bound:
 * globs resolve against the selected scope root and results land in that
 * scope's lock. Adapter entries are rejected in project scope by the core.
 */

import '../types.js';
import type { FastifyInstance } from 'fastify';
import { parseMutatingScope, scopeBodySchemaFragment } from '../scope-parser.js';

export function registerWorkspaceRoutes(app: FastifyInstance): void {
  // POST /workspace/sync — scan for plugins/adapters and populate lock
  app.post('/workspace/sync', {
    schema: {
      tags: ['Marketplace'],
      summary: 'Sync workspace — scan for plugins/adapters and populate lock',
      body: {
        type: 'object',
        required: ['include'],
        properties: {
          include: {
            type: 'array',
            items: { type: 'string' },
            description: 'Glob patterns to scan (relative to the scope root)',
          },
          exclude: {
            type: 'array',
            items: { type: 'string' },
            description: 'Patterns to skip',
          },
          autoEnable: {
            type: 'boolean',
            description: 'Auto-enable newly discovered entries (default: false)',
          },
          ...scopeBodySchemaFragment,
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      include: string[];
      exclude?: string[];
      autoEnable?: boolean;
    } & Record<string, unknown>;
    const ctx = parseMutatingScope(body);
    const result = await app.observability.observeOperation(
      'marketplace.sync',
      () => app.marketplace.sync(ctx, {
        include: body.include,
        exclude: body.exclude,
        autoEnable: body.autoEnable,
      }),
    );
    return reply.send(result);
  });
}
