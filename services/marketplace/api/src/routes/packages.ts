/**
 * @module @kb-labs/marketplace-api/routes/packages
 * REST routes for marketplace packages (plugins, adapters, etc.).
 *
 * The URL surface is intentionally action-oriented ("POST /packages/link")
 * rather than resource-style ("POST /packages/:id/link"). Plugin IDs carry
 * `@` and `/` (`@kb-labs/demo`), which round-trip badly through proxies
 * and API gateways as URL-encoded path segments. Every action takes its
 * target id from the request body instead, eliminating an entire class of
 * routing failures.
 *
 * GET  /packages          — list installed packages (query: scope, projectRoot, kind)
 * POST /packages/install  — install package(s)
 * POST /packages/uninstall— uninstall package(s)
 * POST /packages/link     — link a local path
 * POST /packages/unlink   — unlink a package
 * POST /packages/enable   — mark a package enabled
 * POST /packages/disable  — mark a package disabled
 * POST /packages/update   — update package(s) to latest
 */

import '../types.js';
import type { FastifyInstance } from 'fastify';
import type { EntityKind } from '@kb-labs/plugin-contracts';
import {
  parseMutatingScope,
  parseQueryScope,
  queryScopeBodySchemaFragment,
  scopeBodySchemaFragment,
} from '../scope-parser.js';

export function registerPackagesRoutes(app: FastifyInstance): void {
  // GET /packages — list installed packages
  app.get('/packages', {
    schema: {
      tags: ['Marketplace'],
      summary: 'List installed packages',
      querystring: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: 'Filter by entity kind (plugin, adapter, …)' },
          ...queryScopeBodySchemaFragment,
        },
      },
    },
  }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const ctx = parseQueryScope(query);
    const kind = typeof query.kind === 'string' ? (query.kind as EntityKind) : undefined;
    const entries = await app.observability.observeOperation(
      'marketplace.list',
      () => app.marketplace.list(ctx, kind ? { kind } : undefined),
    );
    return reply.send({ entries, total: entries.length });
  });

  // POST /packages/install — install one or more packages
  app.post('/packages/install', {
    schema: {
      tags: ['Marketplace'],
      summary: 'Install package(s)',
      body: {
        type: 'object',
        required: ['specs'],
        properties: {
          specs: { type: 'array', items: { type: 'string' }, description: 'Package specs (name, name@version, etc.)' },
          dev: { type: 'boolean', description: 'Install as dev dependency' },
          token: { type: 'string', description: 'Share token for private kb: packages (kbrt_...)' },
          ...scopeBodySchemaFragment,
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { specs: string[]; dev?: boolean; token?: string } & Record<string, unknown>;
    const ctx = parseMutatingScope(body);
    const result = await app.observability.observeOperation(
      'marketplace.install',
      () => app.marketplace.install(ctx, body.specs, { dev: body.dev, shareToken: body.token }),
    );
    return reply.code(201).send(result);
  });

  // POST /packages/uninstall — uninstall one or more packages
  app.post('/packages/uninstall', {
    schema: {
      tags: ['Marketplace'],
      summary: 'Uninstall package(s)',
      body: {
        type: 'object',
        required: ['packageIds'],
        properties: {
          packageIds: { type: 'array', items: { type: 'string' } },
          ...scopeBodySchemaFragment,
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { packageIds: string[] } & Record<string, unknown>;
    const ctx = parseMutatingScope(body);
    await app.observability.observeOperation(
      'marketplace.uninstall',
      () => app.marketplace.uninstall(ctx, body.packageIds),
    );
    return reply.code(204).send();
  });

  // POST /packages/enable — enable a package
  app.post('/packages/enable', {
    schema: {
      tags: ['Marketplace'],
      summary: 'Enable a package',
      body: {
        type: 'object',
        required: ['packageId'],
        properties: {
          packageId: { type: 'string' },
          ...scopeBodySchemaFragment,
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { packageId: string } & Record<string, unknown>;
    const ctx = parseMutatingScope(body);
    await app.observability.observeOperation(
      'marketplace.enable',
      () => app.marketplace.enable(ctx, body.packageId),
    );
    return reply.send({ id: body.packageId, enabled: true, scope: ctx.scope });
  });

  // POST /packages/disable — disable a package
  app.post('/packages/disable', {
    schema: {
      tags: ['Marketplace'],
      summary: 'Disable a package',
      body: {
        type: 'object',
        required: ['packageId'],
        properties: {
          packageId: { type: 'string' },
          ...scopeBodySchemaFragment,
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { packageId: string } & Record<string, unknown>;
    const ctx = parseMutatingScope(body);
    await app.observability.observeOperation(
      'marketplace.disable',
      () => app.marketplace.disable(ctx, body.packageId),
    );
    return reply.send({ id: body.packageId, enabled: false, scope: ctx.scope });
  });

  // POST /packages/update — update package(s) to latest version
  app.post('/packages/update', {
    schema: {
      tags: ['Marketplace'],
      summary: 'Update package(s) to latest version',
      body: {
        type: 'object',
        properties: {
          packageIds: { type: 'array', items: { type: 'string' }, description: 'Specific ids to update; omit for "all installed"' },
          ...scopeBodySchemaFragment,
        },
      },
    },
  }, async (request, reply) => {
    const body = (request.body ?? {}) as { packageIds?: string[] } & Record<string, unknown>;
    const ctx = parseMutatingScope(body);
    const result = await app.observability.observeOperation(
      'marketplace.update',
      () => app.marketplace.update(ctx, body.packageIds),
    );
    return reply.send(result);
  });

  // POST /packages/link — link a local path for development
  app.post('/packages/link', {
    schema: {
      tags: ['Marketplace'],
      summary: 'Link a local package path for development',
      body: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Absolute path to local package' },
          manifest: { type: 'object', description: 'Validated source manifest for packages generated before build' },
          ...scopeBodySchemaFragment,
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { path: string; manifest?: unknown } & Record<string, unknown>;
    const ctx = parseMutatingScope(body);
    const result = await app.observability.observeOperation(
      'marketplace.link',
      () => app.marketplace.link(ctx, body.path, body.manifest),
    );
    return reply.send(result);
  });

  // POST /packages/unlink — unlink a local package
  app.post('/packages/unlink', {
    schema: {
      tags: ['Marketplace'],
      summary: 'Unlink a local package',
      body: {
        type: 'object',
        required: ['packageId'],
        properties: {
          packageId: { type: 'string' },
          ...scopeBodySchemaFragment,
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { packageId: string } & Record<string, unknown>;
    const ctx = parseMutatingScope(body);
    await app.observability.observeOperation(
      'marketplace.unlink',
      () => app.marketplace.unlink(ctx, body.packageId),
    );
    return reply.code(204).send();
  });
}
