import { createServer as createHttpServer } from 'node:http';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ILogger, IContextLogger } from '@kb-labs/core-platform';
import { createContextLogger } from '@kb-labs/core-platform';
import { PERMISSIONS } from '@kb-labs/core-contracts';
import type { PackageSource, MarketplaceSource, ResolvedPackage, InstalledPackage } from '@kb-labs/marketplace-contracts';
import { MarketplaceService, MarketplaceVersionError } from '@kb-labs/marketplace-core';
import { NpmPackageSource, PackageInstallError, RegistryPackageSource } from '@kb-labs/marketplace-npm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type CreateServerOptions } from '../server.js';

function makeMarketplaceService(options: { platformRoot: string; logger: ILogger; source: PackageSource; notFound?: boolean }): MarketplaceService {
  const { withShareToken: _withShareToken, ...base } = options.source;
  const source: MarketplaceSource = {
    ...base,
    kind: 'npm',
    resolve: spec => options.source.resolve(spec),
    install: (pkg, root, installOptions) => options.source.install(pkg, root, installOptions),
    commitInstall: (packageId, root) => options.source.commitInstall(packageId, root),
    rollbackInstall: (packageId, root) => options.source.rollbackInstall(packageId, root),
    remove: (packageId, root) => options.source.remove(packageId, root),
    async resolveIdentity(identity) {
      if (options.notFound) { return { status: 'not-found-unowned' }; }
      return { status: 'found', package: await options.source.resolve(identity) };
    },
  };
  return new MarketplaceService({ platformRoot: options.platformRoot, logger: options.logger, sources: [source], resolveSelectedAdapterSlot: async () => null });
}

interface CapturedLog {
  message: string;
  error?: Error;
  fields?: Record<string, unknown>;
}

function makeContextLogger(): { logger: IContextLogger; errors: CapturedLog[] } {
  const errors: CapturedLog[] = [];
  const base: ILogger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (message, error, fields) => { errors.push({ message, error, fields }); },
    fatal: () => undefined,
    flush: async () => {},
    child: () => base,
  };
  return {
    logger: createContextLogger(base, {
      applicationId: 'marketplace-api-test',
      serviceId: 'marketplace',
      instanceId: 'test',
      layer: 'service',
    }),
    errors,
  };
}

const LOCAL_INTERNAL_SECRET = 'local-gateway-internal-secret';
const LOCAL_GATEWAY_HEADERS = {
  'x-internal-secret': LOCAL_INTERNAL_SECRET,
  'x-kb-auth-type': 'machine',
  'x-kb-auth-user-id': 'local-admin',
  'x-kb-auth-namespace-id': 'local',
  'x-kb-auth-tier': 'enterprise',
  'x-kb-auth-permissions': JSON.stringify(Object.values(PERMISSIONS)),
};

type LocalGatewayServer = {
  inject: (options: InjectOptions) => Promise<LightMyRequestResponse>;
  close: () => Promise<void>;
};

async function createLocalServer(options: Omit<CreateServerOptions, 'auth'>): Promise<LocalGatewayServer> {
  const server = await createServer({ ...options, auth: { internalSecret: LOCAL_INTERNAL_SECRET, projectScopeAllowed: true } });
  return {
    inject: (opts) => server.inject({ ...opts, headers: { ...LOCAL_GATEWAY_HEADERS, ...opts.headers } }),
    close: () => server.close(),
  };
}

function createFailingSource(failure: Error, throwsDuringResolve: boolean): PackageSource {
  return {
    async resolve(): Promise<ResolvedPackage> {
      if (throwsDuringResolve) { throw failure; }
      return {
        id: '@kb-labs/test-adapter',
        version: '1.0.0',
        integrity: '',
        source: 'marketplace',
        primaryKind: 'adapter',
      };
    },
    async install(pkg): Promise<InstalledPackage> {
      if (!throwsDuringResolve) { throw failure; }
      return { id: pkg.id, version: pkg.version, packageRoot: '/unused', integrity: '' };
    },
    async remove(): Promise<void> {},
    async commitInstall() {},
    async rollbackInstall() {},
  };
}

describe('Marketplace API error boundary', () => {
  const servers: Array<{ close: () => Promise<void> }> = [];
  const httpServers: Array<ReturnType<typeof createHttpServer>> = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.close()));
    await Promise.all(httpServers.splice(0).map(server => new Promise<void>(resolve => {
      server.close(() => resolve());
    })));
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  // case: S-269.11
  it('requires Gateway identity in every mode and applies scope-specific permissions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'marketplace-mutation-auth-'));
    roots.push(root);
    const { logger } = makeContextLogger();
    const install = vi.fn().mockResolvedValue({ installed: [], warnings: [], scope: 'platform' });
    const list = vi.fn().mockResolvedValue([]);
    const doctor = vi.fn().mockResolvedValue({ ok: true, issues: [] });
    const service = { install, list, doctor } as unknown as MarketplaceService;
    const internalSecret = 'test-gateway-internal-secret';
    const secured = await createServer({ service, logger, auth: { internalSecret, projectScopeAllowed: true } });
    servers.push(secured);

    const direct = await secured.inject({
      method: 'POST',
      url: '/api/v1/marketplace/packages/install',
      payload: { specs: ['@kb-labs/test-adapter@1.0.0'], scope: 'project', projectRoot: root },
    });
    expect(direct.statusCode).toBe(401);
    expect(direct.json()).toMatchObject({ ok: false, error: { code: 'KB_AUTH_REQUIRED' } });
    expect(install).not.toHaveBeenCalled();

    const directRead = await secured.inject({
      method: 'GET',
      url: '/api/v1/marketplace/packages?scope=project&projectRoot=' + encodeURIComponent(root),
    });
    expect(directRead.statusCode).toBe(401);
    expect(directRead.json()).toMatchObject({ ok: false, error: { code: 'KB_AUTH_REQUIRED' } });
    expect(list).not.toHaveBeenCalled();

    const directDiagnostics = await secured.inject({
      method: 'GET',
      url: '/api/v1/marketplace/diagnostics?scope=platform',
    });
    expect(directDiagnostics.statusCode).toBe(401);
    expect(directDiagnostics.json()).toMatchObject({ ok: false, error: { code: 'KB_AUTH_REQUIRED' } });
    expect(doctor).not.toHaveBeenCalled();

    const forgedHeaders = await secured.inject({
      method: 'POST',
      url: '/api/v1/marketplace/packages/install',
      headers: {
        'x-kb-auth-type': 'machine',
        'x-kb-auth-user-id': 'forged-writer',
        'x-kb-auth-namespace-id': 'tenant-a',
        'x-kb-auth-tier': 'pro',
        'x-kb-auth-permissions': JSON.stringify([PERMISSIONS.PLUGINS_WRITE]),
      },
      payload: { specs: ['@kb-labs/test-adapter@1.0.0'], scope: 'project', projectRoot: root },
    });
    expect(forgedHeaders.statusCode).toBe(401);
    expect(install).not.toHaveBeenCalled();

    const projectReader = await secured.inject({
      method: 'GET',
      url: '/api/v1/marketplace/packages?scope=project&projectRoot=' + encodeURIComponent(root),
      headers: {
        'x-internal-secret': internalSecret,
        'x-kb-auth-type': 'user',
        'x-kb-auth-user-id': 'tenant-member',
        'x-kb-auth-namespace-id': 'tenant-a',
        'x-kb-auth-tier': 'pro',
        'x-kb-auth-permissions': JSON.stringify([PERMISSIONS.PLUGINS_READ]),
      },
    });
    expect(projectReader.statusCode).toBe(200);
    expect(list).toHaveBeenCalledTimes(1);

    const platformReadDenied = await secured.inject({
      method: 'GET',
      url: '/api/v1/marketplace/packages?scope=platform',
      headers: {
        'x-internal-secret': internalSecret,
        'x-kb-auth-type': 'user',
        'x-kb-auth-user-id': 'tenant-member',
        'x-kb-auth-namespace-id': 'tenant-a',
        'x-kb-auth-tier': 'pro',
        'x-kb-auth-permissions': JSON.stringify([PERMISSIONS.PLUGINS_READ]),
      },
    });
    expect(platformReadDenied.statusCode).toBe(403);
    expect(platformReadDenied.json()).toMatchObject({ ok: false, error: { code: 'KB_AUTH_FORBIDDEN', details: { permission: PERMISSIONS.PLATFORM_SETTINGS_READ } } });
    expect(list).toHaveBeenCalledTimes(1);

    const readOnly = await secured.inject({
      method: 'POST',
      url: '/api/v1/marketplace/packages/install',
      headers: {
        'x-internal-secret': internalSecret,
        'x-kb-auth-type': 'machine',
        'x-kb-auth-user-id': 'read-only',
        'x-kb-auth-namespace-id': 'tenant-a',
        'x-kb-auth-tier': 'pro',
        'x-kb-auth-permissions': '[]',
      },
      payload: { specs: ['@kb-labs/test-adapter@1.0.0'], scope: 'project', projectRoot: root },
    });
    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json()).toMatchObject({ ok: false, error: { code: 'KB_AUTH_FORBIDDEN' } });
    expect(install).not.toHaveBeenCalled();

    const writer = await secured.inject({
      method: 'POST',
      url: '/api/v1/marketplace/packages/install',
      headers: {
        'x-internal-secret': internalSecret,
        'x-kb-auth-type': 'machine',
        'x-kb-auth-user-id': 'writer',
        'x-kb-auth-namespace-id': 'tenant-a',
        'x-kb-auth-tier': 'pro',
        'x-kb-auth-permissions': JSON.stringify([PERMISSIONS.PLUGINS_WRITE]),
      },
      payload: { specs: ['@kb-labs/test-adapter@1.0.0'], scope: 'project', projectRoot: root },
    });
    expect(writer.statusCode).toBe(201);
    expect(install).toHaveBeenCalledTimes(1);

    const localInstall = vi.fn().mockResolvedValue({ installed: [], warnings: [], scope: 'platform' });
    const local = await createServer({ service: { install: localInstall } as unknown as MarketplaceService, logger, auth: { internalSecret, projectScopeAllowed: true } });
    servers.push(local);
    const localResponse = await local.inject({
      method: 'POST',
      url: '/api/v1/marketplace/packages/install',
      headers: {
        ...LOCAL_GATEWAY_HEADERS,
        'x-internal-secret': internalSecret,
      },
      payload: { specs: ['@kb-labs/test-adapter@1.0.0'], scope: 'platform' },
    });
    expect(localResponse.statusCode).toBe(201);
    expect(localInstall).toHaveBeenCalledTimes(1);

    const platformDenied = await secured.inject({
      method: 'POST',
      url: '/api/v1/marketplace/packages/install',
      headers: {
        'x-internal-secret': internalSecret,
        'x-kb-auth-type': 'user',
        'x-kb-auth-user-id': 'tenant-member',
        'x-kb-auth-namespace-id': 'tenant-a',
        'x-kb-auth-tier': 'pro',
        'x-kb-auth-permissions': JSON.stringify([PERMISSIONS.PLUGINS_WRITE]),
      },
      payload: { specs: ['@kb-labs/test-adapter@1.0.0'], scope: 'platform' },
    });
    expect(platformDenied.statusCode).toBe(403);
    expect(platformDenied.json()).toMatchObject({ ok: false, error: { code: 'KB_AUTH_FORBIDDEN', details: { permission: PERMISSIONS.PLATFORM_SETTINGS_WRITE } } });
    expect(install).toHaveBeenCalledTimes(1);

    const platformAdmin = await secured.inject({
      method: 'POST',
      url: '/api/v1/marketplace/packages/install',
      headers: {
        'x-internal-secret': internalSecret,
        'x-kb-auth-type': 'user',
        'x-kb-auth-user-id': 'tenant-admin',
        'x-kb-auth-namespace-id': 'tenant-a',
        'x-kb-auth-tier': 'pro',
        'x-kb-auth-permissions': JSON.stringify([PERMISSIONS.PLUGINS_WRITE, PERMISSIONS.PLATFORM_SETTINGS_WRITE]),
      },
      payload: { specs: ['@kb-labs/test-adapter@1.0.0'], scope: 'platform' },
    });
    expect(platformAdmin.statusCode).toBe(201);
    expect(install).toHaveBeenCalledTimes(2);

    const localDirect = await local.inject({
      method: 'POST',
      url: '/api/v1/marketplace/packages/install',
      payload: { specs: ['@kb-labs/test-adapter@1.0.0'], scope: 'platform' },
    });
    expect(localDirect.statusCode).toBe(401);
    expect(localInstall).toHaveBeenCalledTimes(1);
  });

  // case: S-269.11
  it('fails project scope closed without principal ownership and authorizes sync by its effective scope', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'marketplace-project-owner-'));
    roots.push(root);
    const { logger } = makeContextLogger();
    const internalSecret = 'project-owner-test-secret';
    const memberHeaders = {
      'x-internal-secret': internalSecret,
      'x-kb-auth-type': 'user',
      'x-kb-auth-user-id': 'tenant-member',
      'x-kb-auth-namespace-id': 'tenant-a',
      'x-kb-auth-tier': 'pro',
      'x-kb-auth-permissions': JSON.stringify([PERMISSIONS.PLUGINS_READ, PERMISSIONS.PLUGINS_WRITE]),
    };
    const install = vi.fn();
    const list = vi.fn();
    const ownedScopeDenied = await createServer({
      service: { install, list } as unknown as MarketplaceService,
      logger,
      auth: { internalSecret, projectScopeAllowed: false },
    });
    servers.push(ownedScopeDenied);

    const projectRead = await ownedScopeDenied.inject({
      method: 'GET',
      url: '/api/v1/marketplace/packages?scope=project&projectRoot=' + encodeURIComponent(root),
      headers: memberHeaders,
    });
    expect(projectRead.statusCode).toBe(403);
    expect(projectRead.json()).toMatchObject({ ok: false, error: { code: 'KB_AUTH_FORBIDDEN', details: { permission: PERMISSIONS.PLUGINS_READ } } });
    expect(list).not.toHaveBeenCalled();

    const projectInstall = await ownedScopeDenied.inject({
      method: 'POST',
      url: '/api/v1/marketplace/packages/install',
      headers: memberHeaders,
      payload: { specs: ['@kb-labs/example'], scope: 'project', projectRoot: root },
    });
    expect(projectInstall.statusCode).toBe(403);
    expect(projectInstall.json()).toMatchObject({ ok: false, error: { code: 'KB_AUTH_FORBIDDEN', details: { permission: PERMISSIONS.PLUGINS_WRITE } } });
    expect(install).not.toHaveBeenCalled();

    const sync = vi.fn().mockResolvedValue({ scanned: 0, added: [], updated: [], total: 0 });
    const resolveSyncScope = vi.fn(async () => ({ scope: 'platform' as const, projectRoot: root }));
    const syncPlatform = await createServer({
      service: { sync, resolveSyncScope } as unknown as MarketplaceService,
      logger,
      auth: { internalSecret, projectScopeAllowed: false },
    });
    servers.push(syncPlatform);
    const syncResponse = await syncPlatform.inject({
      method: 'POST',
      url: '/api/v1/marketplace/workspace/sync',
      headers: memberHeaders,
      payload: { include: ['plugins/*'], scope: 'project', projectRoot: root },
    });
    expect(syncResponse.statusCode).toBe(403);
    expect(syncResponse.json()).toMatchObject({ ok: false, error: { code: 'KB_AUTH_FORBIDDEN', details: { permission: PERMISSIONS.PLATFORM_SETTINGS_WRITE } } });
    expect(resolveSyncScope).toHaveBeenCalledWith({ scope: 'project', projectRoot: root });
    expect(sync).not.toHaveBeenCalled();
  });

  // case: S-269.12
  // case: S-269.12
  it('dispatches managed platform installs and updates to the owner and fails other graph writers closed', async () => {
    const { logger } = makeContextLogger();
    const internalSecret = 'managed-owner-test-secret';
    const headers = {
      'x-internal-secret': internalSecret,
      'x-kb-auth-type': 'user',
      'x-kb-auth-user-id': 'platform-admin',
      'x-kb-auth-namespace-id': 'tenant-a',
      'x-kb-auth-tier': 'pro',
      'x-kb-auth-permissions': JSON.stringify([PERMISSIONS.PLATFORM_SETTINGS_WRITE]),
    };
    const directWrites = {
      install: vi.fn(), uninstall: vi.fn(), enable: vi.fn(), disable: vi.fn(), update: vi.fn(), link: vi.fn(), unlink: vi.fn(), sync: vi.fn(),
    };
    const expectedInstallResult = {
      installed: [{
        spec: '@kb-labs/sample-adapter@1.2.3', id: '@kb-labs/sample-adapter', version: '1.2.3',
        primaryKind: 'adapter', provides: ['adapter'], packageRoot: '/platform/node_modules/@kb-labs/sample-adapter',
        scope: 'platform', source: 'npm', signatureStatus: 'unsigned',
      }],
      warnings: [],
      scope: 'platform',
    };
    const pluginInstallResult = {
      installed: [{
        spec: '@kb-labs/sample-plugin@2.0.0', id: '@kb-labs/sample-plugin', version: '2.0.0',
        primaryKind: 'plugin', provides: ['plugin', 'cli-command'], packageRoot: '/platform/node_modules/@kb-labs/sample-plugin',
        scope: 'platform', source: 'registry', signatureStatus: 'verified',
      }],
      warnings: [],
      scope: 'platform',
    };
    const expectedUpdateResult = {
      installed: [{
        spec: '@kb-labs/sample-adapter', id: '@kb-labs/sample-adapter', version: '1.3.0',
        primaryKind: 'adapter', provides: ['adapter'], packageRoot: '/platform/node_modules/@kb-labs/sample-adapter',
        scope: 'platform', source: 'npm', signatureStatus: 'unsigned',
      }],
      warnings: [],
      scope: 'platform',
    };
    const dispatchManagedPlatformMutation = vi.fn()
      .mockResolvedValueOnce(expectedInstallResult)
      .mockResolvedValueOnce(pluginInstallResult)
      .mockResolvedValueOnce(expectedUpdateResult);
    const server = await createServer({
      service: { ...directWrites, resolveSyncScope: vi.fn(async (ctx: unknown) => ctx) } as unknown as MarketplaceService,
      logger,
      auth: { internalSecret, projectScopeAllowed: false, managedPlatform: true, dispatchManagedPlatformMutation },
    });
    servers.push(server);

    const install = await server.inject({
      method: 'POST', url: '/api/v1/marketplace/packages/install', headers,
      payload: { specs: ['@kb-labs/sample-adapter@1.2.3'], scope: 'platform' },
    });
    expect(install.statusCode).toBe(201);
    expect(install.json()).toEqual(expectedInstallResult);
    expect(dispatchManagedPlatformMutation).toHaveBeenCalledWith({ operation: 'install', specs: ['@kb-labs/sample-adapter@1.2.3'], dev: undefined, shareToken: undefined });
    expect(directWrites.install).not.toHaveBeenCalled();

    const pluginInstall = await server.inject({
      method: 'POST', url: '/api/v1/marketplace/packages/install', headers,
      payload: { specs: ['@kb-labs/sample-plugin@2.0.0'], scope: 'platform' },
    });
    expect(pluginInstall.statusCode).toBe(201);
    expect(pluginInstall.json()).toEqual(pluginInstallResult);

    const update = await server.inject({
      method: 'POST', url: '/api/v1/marketplace/packages/update', headers,
      payload: { packageIds: ['@kb-labs/sample-adapter'], scope: 'platform' },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toEqual(expectedUpdateResult);
    expect(dispatchManagedPlatformMutation).toHaveBeenLastCalledWith({ operation: 'update', packageIds: ['@kb-labs/sample-adapter'] });
    expect(directWrites.update).not.toHaveBeenCalled();
    const emptyUpdate = await server.inject({
      method: 'POST', url: '/api/v1/marketplace/packages/update', headers,
      payload: { packageIds: [], scope: 'platform' },
    });
    expect(emptyUpdate.statusCode).toBe(400);
    expect(dispatchManagedPlatformMutation).toHaveBeenCalledTimes(3);

    const deniedRequests: InjectOptions[] = [
      { method: 'POST', url: '/api/v1/marketplace/packages/uninstall', headers, payload: { packageIds: ['@kb-labs/sample-adapter'], scope: 'platform' } },
      { method: 'POST', url: '/api/v1/marketplace/packages/enable', headers, payload: { packageId: '@kb-labs/sample-adapter', scope: 'platform' } },
      { method: 'POST', url: '/api/v1/marketplace/packages/disable', headers, payload: { packageId: '@kb-labs/sample-adapter', scope: 'platform' } },
      { method: 'POST', url: '/api/v1/marketplace/packages/link', headers, payload: { packageId: '@kb-labs/sample-adapter', path: '/tmp/adapter', scope: 'platform' } },
      { method: 'POST', url: '/api/v1/marketplace/packages/unlink', headers, payload: { packageId: '@kb-labs/sample-adapter', scope: 'platform' } },
      { method: 'POST', url: '/api/v1/marketplace/workspace/sync', headers, payload: { include: ['adapters/*'], scope: 'platform' } },
    ];
    for (const request of deniedRequests) {
      const response = await server.inject(request);
      expect(response.statusCode, `${request.method} ${request.url}: ${JSON.stringify(response.json())}`).toBe(503);
      expect(response.json()).toMatchObject({ ok: false, error: { code: 'KB_INSTALL_RECEIPT_UNAVAILABLE' } });
    }
    for (const writer of Object.values(directWrites)) expect(writer).not.toHaveBeenCalled();
    expect(dispatchManagedPlatformMutation).toHaveBeenCalledTimes(3);

    const unavailableInstall = vi.fn();
    const noOwner = await createServer({
      service: { install: unavailableInstall } as unknown as MarketplaceService,
      logger,
      auth: { internalSecret, projectScopeAllowed: false, managedPlatform: true },
    });
    servers.push(noOwner);
    const unavailable = await noOwner.inject({
      method: 'POST', url: '/api/v1/marketplace/packages/install', headers,
      payload: { specs: ['@kb-labs/sample-adapter@1.2.3'], scope: 'platform' },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailableInstall).not.toHaveBeenCalled();

    const ownerFailure = Object.assign(new Error('redacted owner failure'), { code: 'KB_MARKETPLACE_INSTALL_FAILED' });
    const failedOwner = await createServer({
      service: { install: unavailableInstall } as unknown as MarketplaceService,
      logger,
      auth: {
        internalSecret,
        projectScopeAllowed: false,
        managedPlatform: true,
        dispatchManagedPlatformMutation: vi.fn().mockRejectedValue(ownerFailure),
      },
    });
    servers.push(failedOwner);
    const failed = await failedOwner.inject({
      method: 'POST', url: '/api/v1/marketplace/packages/install', headers,
      payload: { specs: ['@kb-labs/sample-adapter@1.2.3'], scope: 'platform' },
    });
    expect(failed.statusCode).toBe(422);
    expect(failed.json()).toMatchObject({
      ok: false,
      error: { code: 'KB_MARKETPLACE_INSTALL_FAILED', message: 'The managed platform package graph could not be confirmed as activated.' },
    });
    expect(failed.json().error.message).not.toContain('redacted owner failure');
    expect(unavailableInstall).not.toHaveBeenCalled();
  });

  it('refuses secured startup without the Gateway internal secret', async () => {
    const { logger } = makeContextLogger();
    await expect(createServer({
      service: {} as unknown as MarketplaceService,
      logger,
      auth: { internalSecret: '', projectScopeAllowed: false },
    })).rejects.toThrow('Marketplace API requires GATEWAY_INTERNAL_SECRET in every mode');
  });

  // case: S-051.2
  it('keeps Marketplace plugin-not-found and logs source outcomes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'marketplace-not-found-'));
    roots.push(root);
    const { logger, errors } = makeContextLogger();
    const service = makeMarketplaceService({
      platformRoot: root,
      logger,
      source: createFailingSource(new Error('source must not install'), true),
      notFound: true,
    });
    const server = await createLocalServer({ service, logger });
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/marketplace/packages/install',
      payload: { specs: ['journey-not-published'], scope: 'platform' },
    });
    const result = response.json();
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_PLUGIN_NOT_FOUND',
        cause: 'npm: not-found-unowned',
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fields).toMatchObject({
      errorCode: 'KB_PLUGIN_NOT_FOUND',
      cause: 'npm: not-found-unowned',
    });
  });

  // case: S-054.14
  it('returns a catalogued pin refusal through the shared UX envelope', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'marketplace-pins-'));
    roots.push(root);
    const registry = createHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { kb: { adapter: {} } } },
      }));
    });
    httpServers.push(registry);
    await new Promise<void>(resolve => {
      registry.listen(0, '127.0.0.1', () => resolve());
    });
    const address = registry.address();
    if (!address || typeof address === 'string') { throw new Error('local registry did not bind'); }

    await mkdir(path.join(root, '.kb', 'v2'), { recursive: true });
    await writeFile(path.join(root, '.kb', 'v2', 'receipt.json'), JSON.stringify({ plan: { artifacts: [{
      package: '@kb-labs/core-platform',
      sha256: 'a'.repeat(64),
      tarball: 'core-platform.tgz',
      kind: 'package',
    }] } }));
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'overrides:\n  unrelated: 1.0.0\n');

    const { logger, errors } = makeContextLogger();
    const service = makeMarketplaceService({
      platformRoot: root,
      logger,
      source: new NpmPackageSource({ registryUrl: `http://127.0.0.1:${address.port}` }),
    });
    const server = await createLocalServer({ service, logger });
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/marketplace/packages/install',
      payload: { specs: ['@kb-labs/test-adapter'], scope: 'platform' },
    });
    const result = response.json();
    const correlationId = result.error?.correlationId;

    expect(response.statusCode, `${JSON.stringify(result)}; error=${errors[0]?.error?.stack}`).toBe(409);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_MARKETPLACE_PLATFORM_ARTIFACT_PINS_MISSING',
        message: "The installed platform is missing kb-create's sealed artifact overrides. No package was installed.",
        correlationId: expect.any(String),
        hint: expect.stringContaining('kb-create update --platform-root'),
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fields).toMatchObject({ requestId: correlationId, errorCode: 'KB_MARKETPLACE_PLATFORM_ARTIFACT_PINS_MISSING' });
  });

  it('renders Registry authentication failure through the error catalogue', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'marketplace-registry-auth-'));
    roots.push(root);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    const { logger } = makeContextLogger();
    const registry = new RegistryPackageSource({ registryUrl: 'https://registry.test', signingPublicKey: 'configured-key' });
    const service = new MarketplaceService({
      platformRoot: root,
      logger,
      sources: [{
        kind: 'registry',
        resolveIdentity: registry.resolveIdentity.bind(registry),
        resolve: registry.resolve.bind(registry),
        install: registry.install.bind(registry),
        commitInstall: registry.commitInstall.bind(registry),
        rollbackInstall: registry.rollbackInstall.bind(registry),
        remove: registry.remove.bind(registry),
      }],
      resolveSelectedAdapterSlot: async () => null,
    });
    const server = await createLocalServer({ service, logger });
    servers.push(server);

    const response = await server.inject({
      method: 'POST', url: '/api/v1/marketplace/packages/install',
      payload: { specs: ['@kb-labs/private'], scope: 'platform' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: 'KB_MARKETPLACE_AUTH_FAILED',
        details: { package: '@kb-labs/private', scope: 'platform' },
        hint: expect.stringContaining('kb marketplace install @kb-labs/private --scope platform'),
      },
    });
  });

  // case: S-220.1
    it('returns a catalogued install failure with the secret-free package-manager cause and logs it', async () => {
    const { logger, errors } = makeContextLogger();
    const packageManagerError = new PackageInstallError(
      'INSTALL_FAILED',
      '@kb-labs/test-adapter@1.0.0',
      'ERR_PNPM_NO_MATURE_MATCHING_VERSION: package is inside minimumReleaseAge',
    );
    const service = makeMarketplaceService({
      platformRoot: tmpdir(),
      logger,
      source: createFailingSource(packageManagerError, false),
    });
    const server = await createLocalServer({ service, logger });
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/marketplace/packages/install',
      payload: { specs: ['@kb-labs/test-adapter'], scope: 'platform' },
    });
    const result = response.json();
    const correlationId = result.error?.correlationId;

    expect(response.statusCode).toBe(422);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_MARKETPLACE_INSTALL_FAILED',
        correlationId: expect.any(String),
        details: { package: '@kb-labs/test-adapter@1.0.0', scope: 'platform' },
        hint: expect.stringContaining('kb marketplace install @kb-labs/test-adapter@1.0.0 --scope platform'),
      },
    });
    expect(result.error?.cause).toContain('ERR_PNPM_NO_MATURE_MATCHING_VERSION');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error?.message).toContain('ERR_PNPM_NO_MATURE_MATCHING_VERSION');
    expect(errors[0]?.fields).toMatchObject({
      requestId: correlationId,
      errorCode: 'KB_MARKETPLACE_INSTALL_FAILED',
      cause: expect.stringContaining('ERR_PNPM_NO_MATURE_MATCHING_VERSION'),
    });
  });

  // case: S-220.1
  it('returns a typed freshness refusal without exposing pnpm output', async () => {
    const { logger, errors } = makeContextLogger();
    const packageManagerError = new PackageInstallError(
      'RELEASE_TOO_FRESH',
      '@kb-labs/test-adapter@1.0.0',
      'ERR_PNPM_NO_MATURE_MATCHING_VERSION: package is inside minimumReleaseAge',
    );
    const service = makeMarketplaceService({
      platformRoot: tmpdir(),
      logger,
      source: createFailingSource(packageManagerError, false),
    });
    const server = await createLocalServer({ service, logger });
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/marketplace/packages/install',
      payload: { specs: ['@kb-labs/test-adapter@1.0.0'], scope: 'platform' },
    });
    const result = response.json();
    const correlationId = result.error?.correlationId;

    expect(response.statusCode).toBe(422);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_MARKETPLACE_PACKAGE_TOO_FRESH',
        correlationId: expect.any(String),
        hint: expect.stringContaining('kb marketplace install @kb-labs/test-adapter@1.0.0 --scope platform'),
      },
    });
    expect(response.body).not.toContain('ERR_PNPM_NO_MATURE_MATCHING_VERSION');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error?.message).toContain('ERR_PNPM_NO_MATURE_MATCHING_VERSION');
    expect(errors[0]?.fields).toMatchObject({ requestId: correlationId, errorCode: 'KB_MARKETPLACE_PACKAGE_TOO_FRESH' });
  });

  // case: S-220.4
  it('returns a catalogued integrity mismatch and retains the cause in logs', async () => {
    const { logger, errors } = makeContextLogger();
    const packageManagerError = new PackageInstallError(
      'INTEGRITY_MISMATCH',
      '@kb-labs/test-adapter@1.0.0',
      'registry tarball integrity differs from the Marketplace pin',
    );
    const service = makeMarketplaceService({
      platformRoot: tmpdir(),
      logger,
      source: createFailingSource(packageManagerError, false),
    });
    const server = await createLocalServer({ service, logger });
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/marketplace/packages/install',
      payload: { specs: ['@kb-labs/test-adapter@1.0.0'], scope: 'platform' },
    });
    const result = response.json();
    const correlationId = result.error?.correlationId;

    expect(response.statusCode).toBe(502);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'KB_MARKETPLACE_INTEGRITY_MISMATCH', correlationId: expect.any(String) },
    });
    expect(response.body).not.toContain('registry tarball integrity differs');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error?.message).toContain('registry tarball integrity differs');
    expect(errors[0]?.fields).toMatchObject({ requestId: correlationId, errorCode: 'KB_MARKETPLACE_INTEGRITY_MISMATCH' });
  });

  // case: S-220.6
  it('returns an exact reinstall command for a republished installed pin', async () => {
    const { logger, errors } = makeContextLogger();
    const versionError = new MarketplaceVersionError(
      'INTEGRITY_MISMATCH',
      '@kb-labs/test-adapter',
      '1.0.0',
      '1.0.0',
    );
    const service = makeMarketplaceService({
      platformRoot: tmpdir(),
      logger,
      source: createFailingSource(versionError, true),
    });
    const server = await createLocalServer({ service, logger });
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/marketplace/packages/install',
      payload: { specs: ['@kb-labs/test-adapter@1.0.0'], scope: 'platform' },
    });
    const result = response.json();
    const correlationId = result.error?.correlationId;

    expect(response.statusCode).toBe(409);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_MARKETPLACE_VERSION_IMMUTABLE',
        message: expect.stringContaining('immutable integrity pin'),
        hint: expect.stringContaining('kb marketplace install @kb-labs/test-adapter@latest --scope platform'),
        correlationId: expect.any(String),
        details: { installedVersion: '1.0.0', requestedVersion: '1.0.0' },
      },
    });
    expect(response.body).not.toContain('MarketplaceVersionError');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error?.message).toContain('immutable integrity pin');
    expect(errors[0]?.fields).toMatchObject({ requestId: correlationId, errorCode: 'KB_MARKETPLACE_VERSION_IMMUTABLE' });
  });

  // case: S-220.7
  it('returns the installed version and forward-only next step for a non-increasing update', async () => {
    const { logger, errors } = makeContextLogger();
    const versionError = new MarketplaceVersionError(
      'VERSION_NOT_HIGHER',
      '@kb-labs/test-plugin',
      '1.4.0',
      '1.4.0',
    );
    const service = makeMarketplaceService({
      platformRoot: tmpdir(),
      logger,
      source: createFailingSource(versionError, true),
    });
    const server = await createLocalServer({ service, logger });
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/marketplace/packages/install',
      payload: { specs: ['@kb-labs/test-plugin@1.4.0'], scope: 'platform' },
    });
    const result = response.json();
    const correlationId = result.error?.correlationId;

    expect(response.statusCode, response.body).toBe(409);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_MARKETPLACE_VERSION_NOT_HIGHER',
        message: expect.stringContaining('installed version 1.4.0'),
        hint: expect.stringContaining('Only a version higher than 1.4.0'),
        correlationId: expect.any(String),
        details: { installedVersion: '1.4.0', requestedVersion: '1.4.0' },
      },
    });
    expect(response.body).not.toContain('MarketplaceVersionError');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error?.message).toContain('resolved 1.4.0');
    expect(errors[0]?.fields).toMatchObject({ requestId: correlationId, errorCode: 'KB_MARKETPLACE_VERSION_NOT_HIGHER' });
  });

  // case: S-220.3
  it('maps Fastify request validation through the same logged UX boundary', async () => {
    const { logger, errors } = makeContextLogger();
    const service = makeMarketplaceService({
      platformRoot: tmpdir(),
      logger,
      source: createFailingSource(new Error('unused'), true),
    });
    const server = await createLocalServer({ service, logger });
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/marketplace/packages/install',
      payload: { scope: 'platform' },
    });
    const result = response.json();
    const correlationId = result.error?.correlationId;

    expect(response.statusCode).toBe(400);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'KB_RUNTIME_INPUT_INVALID', correlationId: expect.any(String) },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fields).toMatchObject({ requestId: correlationId, errorCode: 'KB_RUNTIME_INPUT_INVALID' });
  });

  // case: S-220.2
  it('turns unexpected service failures into correlated internal-error envelopes', async () => {
    const { logger, errors } = makeContextLogger();
    const service = makeMarketplaceService({
      platformRoot: tmpdir(),
      logger,
      source: createFailingSource(new Error('private adapter loader detail'), true),
    });
    const server = await createLocalServer({ service, logger });
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/marketplace/packages/install',
      payload: { specs: ['@kb-labs/test-adapter'], scope: 'platform' },
    });
    const result = response.json();
    const correlationId = result.error?.correlationId;

    expect(response.statusCode).toBe(500);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'KB_RUNTIME_UNEXPECTED', correlationId: expect.any(String) },
    });
    expect(response.body).not.toContain('private adapter loader detail');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error?.message).toContain('private adapter loader detail');
    expect(errors[0]?.error?.stack).toContain('private adapter loader detail');
    expect(errors[0]?.fields).toMatchObject({ correlationId, requestId: correlationId, errorCode: 'KB_RUNTIME_UNEXPECTED' });
  });

  // case: S-220.11
  it('catalogues a broken installed adapter manifest and rolls back the platform install', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'marketplace-adapter-rollback-'));
    roots.push(root);
    const packageRoot = path.join(root, 'package');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: '@kb-labs/test-adapter', version: '1.0.0', type: 'module', kb: { adapter: { manifest: './manifest.mjs' } },
    }));
    await writeFile(path.join(packageRoot, 'manifest.mjs'), 'export const manifest = { schema: "kb.adapter/1", implements: "ICache" };');
    let packageInstalled = false;
    let packageCommitted = false;
    const source: PackageSource = {
      async resolve() {
        return { id: '@kb-labs/test-adapter', version: '1.0.0', integrity: 'sha256-test', source: 'marketplace', primaryKind: 'adapter' };
      },
      async install(pkg) {
        packageInstalled = true;
        return { id: pkg.id, version: pkg.version, packageRoot, integrity: pkg.integrity };
      },
      async remove() {},
      async commitInstall() { packageCommitted = true; },
      async rollbackInstall() { packageInstalled = false; },
    };
    const { logger, errors } = makeContextLogger();
    const service = makeMarketplaceService({ platformRoot: root, logger, source });
    const server = await createLocalServer({ service, logger });
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/marketplace/packages/install',
      payload: { specs: ['@kb-labs/test-adapter'], scope: 'platform' },
    });
    const result = response.json();
    const correlationId = result.error?.correlationId;

    expect(response.statusCode).toBe(422);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_ADAPTER_MANIFEST_LOAD',
        correlationId: expect.any(String),
        hint: expect.stringContaining('kb marketplace plugins doctor --scope platform'),
      },
    });
    expect(packageInstalled).toBe(false);
    expect(packageCommitted).toBe(false);
    expect(errors[0]?.fields).toMatchObject({ correlationId, errorCode: 'KB_ADAPTER_MANIFEST_LOAD' });
    expect(errors[0]?.error?.stack).toContain('AdapterManifestLoadError');
  });
});
