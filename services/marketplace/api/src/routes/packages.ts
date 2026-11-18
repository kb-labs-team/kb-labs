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
import { createErrorEnvelope } from '@kb-labs/core-platform/error-envelope';
import type { ScenarioPackageExpectation } from '@kb-labs/marketplace-contracts';
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

  // The supervised host invokes this read through the composed Marketplace module.
  app.post<{ Body: { scope: 'platform'; expected: ScenarioPackageExpectation[] } }>('/packages/reconcile', {
    schema: {
      body: {
        type: 'object', required: ['scope', 'expected'], additionalProperties: false,
        properties: {
          scope: { const: 'platform' },
          expected: {
            type: 'array', minItems: 1, maxItems: 256,
            items: {
              type: 'object', additionalProperties: false,
              required: ['spec', 'id', 'version', 'source', 'primaryKind', 'signatureStatus'],
              properties: {
                spec: { type: 'string', minLength: 1, maxLength: 512 },
                id: { type: 'string', pattern: '^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$', maxLength: 214 },
                version: { type: 'string', minLength: 1, maxLength: 256 },
                source: { enum: ['npm', 'registry'] },
                primaryKind: { const: 'plugin' },
                signatureStatus: { enum: ['verified', 'unsigned'] },
                integrity: { type: 'string', minLength: 1, maxLength: 512 },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const result = await app.marketplace.reconcilePackages(request.body.expected);
    if (result.ok) {return reply.send(result);}
    const details = { package: result.package, scope: 'platform' };
    const drift = result.code === 'KB_MARKETPLACE_STATE_DRIFT';
    const error = createErrorEnvelope(result.code, {
      correlationId: request.id, details,
      hint: drift
        ? 'Sign in to the installed Gateway and reinstall the requested scenario package in platform scope.'
        : 'Check that the installed host is running and its Marketplace service is available, then retry.',
    });
    return reply.code(drift ? 409 : 503).send({ ok: false, error });
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
