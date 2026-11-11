import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ILogger, IContextLogger } from '@kb-labs/core-platform';
import { createContextLogger } from '@kb-labs/core-platform';
import type { PackageSource, MarketplaceSource, ResolvedPackage, InstalledPackage } from '@kb-labs/marketplace-contracts';
import { MarketplaceService, MarketplaceVersionError } from '@kb-labs/marketplace-core';
import { NpmPackageSource, PackageInstallError, RegistryPackageSource } from '@kb-labs/marketplace-npm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../server.js';

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
  return new MarketplaceService({ platformRoot: options.platformRoot, logger: options.logger, sources: [source] });
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
  const servers: Array<Awaited<ReturnType<typeof createServer>>> = [];
  const httpServers: Array<ReturnType<typeof createHttpServer>> = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.close()));
    await Promise.all(httpServers.splice(0).map(server => new Promise<void>(resolve => {
      server.close(() => resolve());
    })));
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
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
    const server = await createServer({ service, logger });
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
    const server = await createServer({ service, logger });
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
    });
    const server = await createServer({ service, logger });
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
    const server = await createServer({ service, logger });
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
    const server = await createServer({ service, logger });
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
    const server = await createServer({ service, logger });
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
    const server = await createServer({ service, logger });
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
    const server = await createServer({ service, logger });
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
    const server = await createServer({ service, logger });
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
    const server = await createServer({ service, logger });
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
    const server = await createServer({ service, logger });
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
