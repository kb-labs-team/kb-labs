import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RegistryService } from '@kb-labs/marketplace-registry-core';
import type { PublishRequest } from '@kb-labs/marketplace-registry-contracts';
import { requireRegistryAuth } from '../auth-middleware.js';
import { parseMultipart } from '../multipart.js';

export function registerPackageRoutes(app: FastifyInstance, registry: RegistryService): void {
  app.get<{ Querystring: { identity: string } }>(
    '/api/v1/resolve',
    { config: { registryAccess: 'public' } },
    async (req, reply) => {
      const identity = req.query.identity;
      const result = await registry.resolveIdentity(identity);
      if (result.status !== 'found') { return reply.send(result); }
      const [handle, ...nameParts] = result.package.signatureSubject?.split('/') ?? [];
      const entry = handle && nameParts.length ? await registry.getEntry(handle, nameParts.join('/')) : null;
      if (!entry) { return reply.code(404).send({ status: 'not-found-owned' }); }
      const token = extractShareToken(req);
      const resolvedToken = token ? await registry.resolveShareToken(token) : null;
      const callerNs = req.authContext?.namespaceId ?? '';
      if (!registry.canAccess(entry, callerNs, resolvedToken)) {
        return reply.code(403).send({ error: 'Access denied' });
      }
      return reply.send(result);
    },
  );

  // ── Public: list or search public packages ───────────────────────────────
  app.get<{ Querystring: { q?: string } }>('/api/v1/packages', { config: { registryAccess: 'public' } }, async (req, reply) => {
    const q = (req.query as any)?.q as string | undefined;
    const packages = q?.trim()
      ? await registry.searchPackages(q)
      : await registry.listPublicPackages();
    return reply.send(packages);
  });

  // ── Public: get package metadata ─────────────────────────────────────────
  app.get<{ Params: { handle: string; name: string } }>(
    '/api/v1/packages/:handle/:name',
    { config: { registryAccess: 'public' } },
    async (req, reply) => {
      const { handle, name } = req.params;
      const entry = await registry.getEntry(handle, name);
      if (!entry) { return reply.code(404).send({ error: 'Package not found' }); }

      const token = extractShareToken(req);
      const resolvedToken = token ? await registry.resolveShareToken(token) : null;
      const callerNs = req.authContext?.namespaceId ?? '';

      if (!registry.canAccess(entry, callerNs, resolvedToken)) {
        return reply.code(403).send({ error: 'Access denied' });
      }

      return reply.send(entry);
    },
  );

  // ── Public: package stats ─────────────────────────────────────────────────
  app.get<{ Params: { handle: string; name: string } }>(
    '/api/v1/packages/:handle/:name/stats',
    { config: { registryAccess: 'public' } },
    async (req, reply) => {
      const { handle, name } = req.params;
      return reply.send(await registry.getStats(handle, name));
    },
  );

  // ── Auth: list my packages ────────────────────────────────────────────────
  app.get('/api/v1/my/packages', { config: { registryAccess: 'user' } }, async (req, reply) => {
    const { namespaceId } = requireRegistryAuth(req).authContext;
    const packages = await registry.listByAuthor(namespaceId);
    return reply.send(packages);
  });

  // ── Auth: publish (multipart: tarball + meta JSON) ───────────────────────
  app.post('/api/v1/packages/publish', { config: { registryAccess: 'user' } }, async (req, reply) => {
    const { namespaceId } = requireRegistryAuth(req).authContext;
    const handle = req.headers['x-author-handle'] as string | undefined;
    if (!handle) {
      return reply.code(400).send({ error: 'Missing X-Author-Handle header' });
    }

    const { tarball, fields } = await parseMultipart(req);
    if (!tarball) { return reply.code(400).send({ error: 'Missing tarball file' }); }
    if (!fields.meta) { return reply.code(400).send({ error: 'Missing meta field' }); }

    let publishReq: PublishRequest;
    try {
      publishReq = JSON.parse(fields.meta) as PublishRequest;
    } catch {
      return reply.code(400).send({ error: 'Invalid meta JSON' });
    }

    const result = await registry.publish(tarball, publishReq, handle, namespaceId);
    return reply.code(201).send(result);
  });

  // ── Auth: publish metadata only ───────────────────────────────────────────
  app.patch<{ Params: { handle: string; name: string } }>(
    '/api/v1/packages/:handle/:name/meta',
    { config: { registryAccess: 'user' } },
    async (req, reply) => {
      const { handle, name } = req.params;
      await assertOwner(req, registry, handle, name);
      await registry.updateMeta(handle, name, (req.body as any) ?? {});
      return reply.code(204).send();
    },
  );

  // ── Auth: yank version ────────────────────────────────────────────────────
  app.post<{ Params: { handle: string; name: string; version: string } }>(
    '/api/v1/packages/:handle/:name/:version/yank',
    { config: { registryAccess: 'user' } },
    async (req, reply) => {
      const { handle, name, version } = req.params;
      await assertOwner(req, registry, handle, name);
      const { reason } = (req.body as any) ?? {};
      await registry.yank(handle, name, version, reason);
      return reply.code(204).send();
    },
  );

  // ── Auth: deprecate package ───────────────────────────────────────────────
  app.post<{ Params: { handle: string; name: string } }>(
    '/api/v1/packages/:handle/:name/deprecate',
    { config: { registryAccess: 'user' } },
    async (req, reply) => {
      const { handle, name } = req.params;
      await assertOwner(req, registry, handle, name);
      const { message } = (req.body as any) ?? {};
      await registry.deprecate(handle, name, message);
      return reply.code(204).send();
    },
  );

  // ── Auth: share — add to allowlist ────────────────────────────────────────
  app.post<{ Params: { handle: string; name: string } }>(
    '/api/v1/packages/:handle/:name/share/allowlist',
    { config: { registryAccess: 'user' } },
    async (req, reply) => {
      const { handle, name } = req.params;
      await assertOwner(req, registry, handle, name);
      const { namespaceId } = (req.body as any) ?? {};
      if (!namespaceId) { return reply.code(400).send({ error: 'Missing namespaceId' }); }
      await registry.addToAllowlist(handle, name, namespaceId);
      return reply.code(204).send();
    },
  );

  // ── Auth: share — create link token ──────────────────────────────────────
  app.post<{ Params: { handle: string; name: string } }>(
    '/api/v1/packages/:handle/:name/share/token',
    { config: { registryAccess: 'user' } },
    async (req, reply) => {
      const { handle, name } = req.params;
      await assertOwner(req, registry, handle, name);
      const { ttlDays } = (req.body as any) ?? {};
      const ttlMs = ttlDays ? ttlDays * 24 * 60 * 60 * 1000 : undefined;
      const shareToken = await registry.createShareToken(handle, name, ttlMs);
      return reply.code(201).send(shareToken);
    },
  );

  // ── Auth: download tarball ────────────────────────────────────────────────
  app.get<{ Params: { handle: string; name: string; version: string } }>(
    '/api/v1/packages/:handle/:name/:version/tarball',
    { config: { registryAccess: 'user' } },
    async (req, reply) => {
      const { handle, name, version } = req.params;
      const entry = await registry.getEntry(handle, name);
      if (!entry) { return reply.code(404).send({ error: 'Package not found' }); }

      const token = extractShareToken(req);
      const resolvedToken = token ? await registry.resolveShareToken(token) : null;
      const callerNs = requireRegistryAuth(req).authContext.namespaceId;

      if (!registry.canAccess(entry, callerNs, resolvedToken)) {
        return reply.code(403).send({ error: 'Access denied' });
      }

      const { tarball, signature } = await registry.getTarball(handle, name, version);
      await registry.incrementInstalls(handle, name);

      return reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Disposition', `attachment; filename="${name}-${version}.tgz"`)
        .header('X-Registry-Signature', signature ? JSON.stringify(signature) : '')
        .send(tarball);
    },
  );

  // ── Admin: feature/unfeature ──────────────────────────────────────────────
  app.post<{ Params: { handle: string; name: string } }>(
    '/api/v1/admin/packages/:handle/:name/feature',
    { config: { registryAccess: 'admin' } },
    async (req, reply) => {
      requireRegistryAuth(req);
      const { handle, name } = req.params;
      const { featured = true } = (req.body as any) ?? {};
      await registry.setFeatured(handle, name, featured);
      return reply.code(204).send();
    },
  );
}

async function assertOwner(req: FastifyRequest, registry: RegistryService, handle: string, name: string): Promise<void> {
  const { namespaceId } = requireRegistryAuth(req).authContext;
  const entry = await registry.getEntry(handle, name);
  if (!entry) { throw Object.assign(new Error('Package not found'), { statusCode: 404 }); }
  if (entry.authorNamespaceId !== namespaceId) {
    throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
  }
}

function extractShareToken(req: FastifyRequest): string | undefined {
  return (req.query as any)?.token ?? req.headers['x-share-token'];
}
