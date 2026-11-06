/**
 * Integration test: marketplace install → discovery → plugin available
 *
 * Full lifecycle:
 *   1. MarketplaceService.install() writes lock + cache
 *   2. DiscoveryManager.discover() reads lock + loads manifests
 *   3. Plugin is available with correct entity kinds
 *
 * No mocking of discovery or marketplace internals — real filesystem.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { DiscoveryManager } from '@kb-labs/core-discovery';
import type { MarketplaceIdentityResolution } from '@kb-labs/plugin-contracts';
import { createExtensionStore } from '@kb-labs/core-extension-store';
import { NoOpLogger } from '@kb-labs/core-platform/noop';
import type { PackageSource, MarketplaceSource, InstalledPackage, ResolvedPackage } from '@kb-labs/marketplace-contracts';
import { MarketplaceService, type MarketplaceServiceOptions } from '../marketplace-service.js';

const integrationRegistryKeys = crypto.generateKeyPairSync('ed25519');
const integrationRegistryPublicKey = integrationRegistryKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function makeMarketplaceService(options: Omit<MarketplaceServiceOptions, 'logger' | 'sources'> & { source: PackageSource }): MarketplaceService {
  const { withShareToken: _withShareToken, ...base } = options.source;
  const source: MarketplaceSource = {
    ...base,
    kind: 'registry',
    verificationKey: integrationRegistryPublicKey,
    async resolveIdentity(identity) {
      const resolved = await options.source.resolve(identity);
      const signatureSubject = `integration/${resolved.id}`;
      const payload = Buffer.from(JSON.stringify({ integrity: resolved.integrity, pkg: `${signatureSubject}@${resolved.version}` }));
      const signature = crypto.sign(null, payload, integrationRegistryKeys.privateKey).toString('base64');
      return {
        status: 'found',
        package: {
          ...resolved,
          signature: { algorithm: 'ed25519', value: signature, signer: 'integration', signedAt: '2026-10-22T00:00:00.000Z', verifiedChecks: [] },
          signatureSubject,
        },
      };
    },
  };
  return new MarketplaceService({ platformRoot: options.platformRoot, projectRoot: options.projectRoot, extensionStore: options.extensionStore, strategies: options.strategies, sources: [source], logger: new NoOpLogger() });
}

describe('Marketplace → Discovery Integration', () => {
  let tmpDir: string;
  let registryServer: Server | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-mkt-disc-'));
  });

  afterEach(async () => {
    if (registryServer?.listening) {
      await new Promise<void>((resolve, reject) => registryServer!.close(error => error ? reject(error) : resolve()));
      registryServer = undefined;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function computeIntegrity(content: string): string {
    return `sha256-${crypto.createHash('sha256').update(Buffer.from(content)).digest('base64')}`;
  }

  async function createPluginOnDisk(name: string, id: string, version: string) {
    const dir = path.join(tmpDir, 'packages', name);
    await fs.mkdir(dir, { recursive: true });

    const pkgJson = JSON.stringify({ name: id, version });
    await fs.writeFile(path.join(dir, 'package.json'), pkgJson);
    await fs.writeFile(
      path.join(dir, 'kb.plugin.json'),
      JSON.stringify({
        schema: 'kb.plugin/3',
        id,
        version,
        display: { name, description: `${name} plugin` },
        cli: { commands: [{ path: `${name} run`, describe: `Run ${name}`, handler: './dist/h.js' }] },
      }),
    );

    return { dir, integrity: computeIntegrity(pkgJson) };
  }

  it('install → discover: plugin is available after marketplace install', async () => {
    const { dir, integrity } = await createPluginOnDisk('commit', '@kb-labs/commit', '2.0.0');
    await fs.writeFile(
      path.join(dir, 'kb.plugin.json'),
      JSON.stringify({
        schema: 'kb.plugin/3',
        id: '@kb-labs/commit',
        version: '2.0.0',
        display: { name: 'commit', description: 'commit plugin' },
        cli: { commands: [{ path: 'commit run', describe: 'Run commit', handler: './dist/h.js' }] },
      }),
    );

    // Step 1: Install via MarketplaceService
    const removedPackages: string[] = [];
    const source: PackageSource = {
      async resolve(spec: string): Promise<ResolvedPackage> {
        return { id: spec, version: '2.0.0', integrity, source: 'marketplace', primaryKind: 'plugin' };
      },
      async install(pkg: ResolvedPackage): Promise<InstalledPackage> {
        return { id: pkg.id, version: pkg.version, packageRoot: dir, integrity: pkg.integrity };
      },
      async remove(packageName: string) {
        removedPackages.push(packageName);
        await fs.rm(dir, { recursive: true, force: true });
      },
      async commitInstall() {},
      async rollbackInstall() {},
    };

    const marketplace = makeMarketplaceService({ platformRoot: tmpDir, source });
    const installResult = await marketplace.install({ scope: "platform" }, ['@kb-labs/commit']);

    expect(installResult.installed).toHaveLength(1);
    expect(installResult.installed[0]!.id).toBe('@kb-labs/commit');
    expect(installResult.installed[0]!.provides).toContain('cli-command');

    // Step 2: Discover via DiscoveryManager
    const dm = new DiscoveryManager({ root: tmpDir, verifyIntegrity: false });
    const discoverResult = await dm.discover();

    expect(discoverResult.plugins).toHaveLength(1);
    expect(discoverResult.plugins[0]!.id).toBe('@kb-labs/commit');
    expect(discoverResult.plugins[0]!.version).toBe('2.0.0');
    expect(discoverResult.plugins[0]!.provides).toContain('cli-command');
    const lock = JSON.parse(await fs.readFile(path.join(tmpDir, '.kb', 'marketplace.lock'), 'utf8')) as { plugins: Record<string, unknown> };
    expect(lock.plugins).toHaveProperty('@kb-labs/commit');
    expect(lock.plugins['@kb-labs/commit']).toMatchObject({ package: '@kb-labs/commit' });
    const listed = await marketplace.list({ scope: 'platform' }, { kind: 'plugin' });
    expect(listed.map(entry => entry.id)).toEqual(['@kb-labs/commit']);

    // Manifest should be fully loaded
    const manifest = discoverResult.manifests.get('@kb-labs/commit');
    expect(manifest).toBeDefined();
    expect(manifest!.cli?.commands).toHaveLength(1);
    expect(manifest!.cli?.commands?.[0]?.path).toBe('commit run');

    await marketplace.uninstall({ scope: 'platform' }, ['@kb-labs/commit']);
    expect(removedPackages).toEqual(['@kb-labs/commit']);
    expect(await marketplace.list({ scope: 'platform' })).toEqual([]);
    expect((await new DiscoveryManager({ root: tmpDir, verifyIntegrity: false }).discover()).plugins).toEqual([]);
  });

  it('refuses invalid Registry signatures and tampered tarballs before publishing store entries or locks', async () => {
    const packageId = '@kb-labs/signed-fixture';
    const identity = 'fixture/signed-fixture';
    const subject = identity;
    const version = '1.0.0';
    const tarball = Buffer.from('tampered artifact bytes');
    const expectedIntegrity = computeIntegrity('expected artifact bytes');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const payload = Buffer.from(JSON.stringify({ integrity: expectedIntegrity, pkg: `${subject}@${version}` }));
    const validSignature = crypto.sign(null, payload, privateKey).toString('base64');
    let invalidSignature = crypto.randomBytes(64).toString('base64');
    while (invalidSignature === validSignature) { invalidSignature = crypto.randomBytes(64).toString('base64'); }
    let downloadCount = 0;
    registryServer = createServer((request, response) => {
      if (request.url?.startsWith('/api/v1/resolve?')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          status: 'found',
          package: {
            id: packageId,
            version,
            integrity: expectedIntegrity,
            signature: { algorithm: 'ed25519', value: invalidSignature, signer: 'fixture', signedAt: '2026-10-22T00:00:00.000Z', verifiedChecks: [] },
            signatureSubject: subject,
            primaryKind: 'plugin',
            downloadUrl: `http://127.0.0.1:${(registryServer!.address() as import('node:net').AddressInfo).port}/artifact`,
          },
        }));
        return;
      }
      downloadCount += 1;
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(tarball);
    });
    await new Promise<void>(resolve => registryServer!.listen(0, '127.0.0.1', resolve));
    const serverAddress = registryServer.address() as import('node:net').AddressInfo;
    const store = createExtensionStore({ root: path.join(tmpDir, 'machine-store') });
    const source = Object.assign({
      kind: 'registry' as const,
      async resolveIdentity() {
        const response = await fetch(`http://127.0.0.1:${serverAddress.port}/api/v1/resolve?identity=${encodeURIComponent(identity)}`);
        return await response.json() as MarketplaceIdentityResolution;
      },
      async resolve(): Promise<ResolvedPackage> { throw new Error('identity API is used'); },
      async install(): Promise<InstalledPackage> { throw new Error('extension store is used'); },
      async remove() {},
      async commitInstall() {},
      async rollbackInstall() {},
    }, { verificationKey: publicKeyPem });
    const projectRoot = path.join(tmpDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    const marketplace = new MarketplaceService({
      platformRoot: tmpDir,
      projectRoot,
      extensionStore: store,
      sources: [source],
      logger: new NoOpLogger(),
    });

    await expect(marketplace.install({ scope: 'project', projectRoot }, [identity]))
      .rejects.toMatchObject({ envelope: { code: 'KB_MARKETPLACE_SIGNATURE_INVALID' } });
    expect(downloadCount).toBe(0);
    expect(await store.listEntries()).toEqual([]);
    await expect(fs.access(path.join(projectRoot, '.kb', 'marketplace.lock'))).rejects.toMatchObject({ code: 'ENOENT' });

    const validSource = Object.assign({
      ...source,
      async resolveIdentity() {
        return {
          status: 'found' as const,
          package: {
            id: packageId,
            version,
            integrity: expectedIntegrity,
            signature: { algorithm: 'ed25519', value: validSignature, signer: 'fixture', signedAt: '2026-10-22T00:00:00.000Z', verifiedChecks: [] },
            signatureSubject: subject,
            primaryKind: 'plugin',
            downloadUrl: `http://127.0.0.1:${serverAddress.port}/artifact`,
          },
        };
      },
    }, { verificationKey: publicKeyPem });
    const tamperedMarketplace = new MarketplaceService({
      platformRoot: tmpDir,
      projectRoot,
      extensionStore: store,
      sources: [validSource],
      logger: new NoOpLogger(),
    });

    await expect(tamperedMarketplace.install({ scope: 'project', projectRoot }, [identity]))
      .rejects.toMatchObject({ code: 'KB_PLUGIN_INTEGRITY_MISMATCH' });
    expect(downloadCount).toBe(1);
    expect(await store.listEntries()).toEqual([]);
    await expect(fs.access(path.join(projectRoot, '.kb', 'marketplace.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('link → discover: a linked plugin package uses its manifest identity', async () => {
    const projectRoot = path.join(tmpDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    const dir = path.join(projectRoot, 'plugins', 'demo');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
      name: '@kb-labs/demo',
      version: '0.1.0',
      kb: { manifest: './kb.plugin.json' },
    }));
    await fs.writeFile(path.join(dir, 'kb.plugin.json'), JSON.stringify({
      schema: 'kb.plugin/3',
      id: '@kb-labs/demo',
      version: '0.1.0',
      display: { name: 'demo', description: 'Demo plugin' },
      cli: { commands: [{ path: 'demo hello', describe: 'Say hello', handler: './dist/hello.js' }] },
    }));

    const source: PackageSource = {
      async resolve(): Promise<ResolvedPackage> { throw new Error('link does not resolve packages'); },
      async install(): Promise<InstalledPackage> { throw new Error('link does not install packages'); },
      async remove() {},
      async commitInstall() {},
      async rollbackInstall() {},
    };
    const service = makeMarketplaceService({ platformRoot: tmpDir, source });
    const result = await service.link({ scope: 'project', projectRoot }, 'plugins/demo');
    const lock = JSON.parse(await fs.readFile(path.join(projectRoot, '.kb', 'marketplace.lock'), 'utf8')) as {
      plugins: Record<string, { resolvedPath?: string }>;
    };

    expect(result.id).toBe('@kb-labs/demo');
    expect(lock.plugins).toHaveProperty('@kb-labs/demo');
    const discovered = await new DiscoveryManager({ root: projectRoot, verifyIntegrity: false }).discover();
    expect(discovered.plugins.map(plugin => plugin.id)).toContain('@kb-labs/demo');
  });

  it('writes a portable v3 pin and resolves it from two independent machine stores', async () => {
    const projectRoot = path.join(tmpDir, 'project');
    const storeOneRoot = path.join(tmpDir, 'machine-one');
    const storeTwoRoot = path.join(tmpDir, 'machine-two');
    await fs.mkdir(path.join(projectRoot, '.kb'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.kb', 'kb.config.json'), '{}');
    const { dir } = await createPluginOnDisk('portable', '@kb-labs/portable', '1.0.0');
    const integrity = 'sha512-cG9ydGFibGU=';
    const installer = {
      async install(options: { name: string; version: string; projectDir: string }): Promise<{ packageRoot: string; integrity: string }> {
        const packageRoot = path.join(options.projectDir, 'node_modules', ...options.name.split('/'));
        await fs.mkdir(path.dirname(packageRoot), { recursive: true });
        await fs.cp(dir, packageRoot, { recursive: true });
        return { packageRoot, integrity };
      },
    };
    const source: PackageSource = {
      async resolve(spec: string): Promise<ResolvedPackage> {
        return { id: spec, version: '1.0.0', integrity, source: 'marketplace', primaryKind: 'plugin', downloadUrl: `file:${dir}` };
      },
      async install(): Promise<InstalledPackage> { throw new Error('store install should be used'); },
      async remove() {},
      async commitInstall() {},
      async rollbackInstall() {},
    };
    const storeOne = createExtensionStore({ root: storeOneRoot, installer });
    const marketplace = makeMarketplaceService({ platformRoot: tmpDir, projectRoot, source, extensionStore: storeOne });
    await marketplace.install({ scope: 'project' }, ['@kb-labs/portable']);

    const lockFile = path.join(projectRoot, '.kb', 'marketplace.lock');
    const lockText = await fs.readFile(lockFile, 'utf8');
    const lock = JSON.parse(lockText);
    expect(lock.schema).toBe('kb.marketplace/3');
    expect(lock.plugins['@kb-labs/portable']).toMatchObject({ source: 'marketplace', version: '1.0.0', enabled: true });
    expect(lock.plugins['@kb-labs/portable'].integrity).toMatch(/^sha(256|512)-/);
    expect(lockText).not.toMatch(/resolvedPath|installedAt|machine-one|\/Users\/|[A-Z]:\\/);

    const pin = lock.plugins['@kb-labs/portable'];
    const storeTwo = createExtensionStore({ root: storeTwoRoot, installer });
    await storeTwo.resolve({ name: '@kb-labs/portable', version: pin.version, kind: 'plugin', spec: `file:${dir}`, expectedIntegrity: pin.integrity });
    const first = await new DiscoveryManager({ root: projectRoot, platformRoot: tmpDir, extensionStore: storeOne, workspace: false }).discover();
    const second = await new DiscoveryManager({ root: projectRoot, platformRoot: tmpDir, extensionStore: storeTwo, workspace: false }).discover();
    expect(first.plugins.map((plugin) => plugin.id)).toEqual(['@kb-labs/portable']);
    expect(second.plugins.map((plugin) => plugin.id)).toEqual(['@kb-labs/portable']);
    expect(first.plugins[0]?.packageRoot).not.toBe(second.plugins[0]?.packageRoot);
  }, 60_000);

  it('installs platform plugin entries into the shared store and discovers them without a platform graph install', async () => {
    const { dir, integrity } = await createPluginOnDisk('platform-entry', '@kb-labs/platform', '1.0.0');
    const installer = {
      async install(options: { name: string; projectDir: string }): Promise<{ packageRoot: string; integrity: string }> {
        const packageRoot = path.join(options.projectDir, 'node_modules', ...options.name.split('/'));
        await fs.mkdir(path.dirname(packageRoot), { recursive: true });
        await fs.cp(dir, packageRoot, { recursive: true });
        return { packageRoot, integrity };
      },
    };
    const source: PackageSource = {
      async resolve(spec: string): Promise<ResolvedPackage> {
        return { id: spec, version: '1.0.0', integrity, source: 'marketplace', primaryKind: 'plugin' };
      },
      async install(): Promise<InstalledPackage> { throw new Error('platform plugin must use the extension store'); },
      async remove() {},
      async commitInstall() {},
      async rollbackInstall() {},
    };
    const store = createExtensionStore({ root: path.join(tmpDir, 'machine-store'), installer });
    const marketplace = makeMarketplaceService({ platformRoot: tmpDir, source, extensionStore: store });

    await marketplace.install({ scope: 'platform' }, ['@kb-labs/platform']);

    const lock = JSON.parse(await fs.readFile(path.join(tmpDir, '.kb', 'marketplace.lock'), 'utf8'));
    expect(lock.plugins['@kb-labs/platform']).toMatchObject({
      source: 'marketplace',
      version: '1.0.0',
      enabled: true,
    });
    await expect(fs.access(path.join(tmpDir, 'node_modules', '@kb-labs', 'platform-entry'))).rejects.toThrow();
    const discovered = await new DiscoveryManager({
      root: tmpDir,
      extensionStore: store,
      workspace: false,
      verifyIntegrity: false,
    }).discover();
    expect(discovered.plugins.map((plugin) => plugin.id)).toEqual(['@kb-labs/platform']);
  });

  it('install → uninstall → discover: plugin is gone after uninstall', async () => {
    const { dir, integrity } = await createPluginOnDisk('temp', '@kb-labs/temp', '1.0.0');

    const source: PackageSource = {
      async resolve(spec: string): Promise<ResolvedPackage> {
        return { id: spec, version: '1.0.0', integrity, source: 'marketplace', primaryKind: 'plugin' };
      },
      async install(pkg: ResolvedPackage): Promise<InstalledPackage> {
        return { id: pkg.id, version: pkg.version, packageRoot: dir, integrity: pkg.integrity };
      },
      async remove() {},
      async commitInstall() {},
      async rollbackInstall() {},
    };

    const marketplace = makeMarketplaceService({ platformRoot: tmpDir, source });
    await marketplace.install({ scope: "platform" }, ['@kb-labs/temp']);

    // Verify installed
    let dm = new DiscoveryManager({ root: tmpDir, verifyIntegrity: false });
    let result = await dm.discover();
    expect(result.plugins).toHaveLength(1);

    // Uninstall
    await marketplace.uninstall({ scope: "platform" }, ['@kb-labs/temp']);

    // Verify gone
    dm = new DiscoveryManager({ root: tmpDir, verifyIntegrity: false });
    result = await dm.discover();
    expect(result.plugins).toHaveLength(0);
  });

  it('install → disable → discover: disabled plugin not found', async () => {
    const { dir, integrity } = await createPluginOnDisk('optional', '@kb-labs/optional', '1.0.0');

    const source: PackageSource = {
      async resolve(spec: string): Promise<ResolvedPackage> {
        return { id: spec, version: '1.0.0', integrity, source: 'marketplace', primaryKind: 'plugin' };
      },
      async install(pkg: ResolvedPackage): Promise<InstalledPackage> {
        return { id: pkg.id, version: pkg.version, packageRoot: dir, integrity: pkg.integrity };
      },
      async remove() {},
      async commitInstall() {},
      async rollbackInstall() {},
    };

    const marketplace = makeMarketplaceService({ platformRoot: tmpDir, source });
    await marketplace.install({ scope: "platform" }, ['@kb-labs/optional']);

    // Disable
    await marketplace.disable({ scope: "platform" }, '@kb-labs/optional');

    // Discovery should skip
    const dm = new DiscoveryManager({ root: tmpDir, verifyIntegrity: false });
    const result = await dm.discover();
    expect(result.plugins).toHaveLength(0);

    const disabled = result.diagnostics.find(d => d.code === 'PLUGIN_DISABLED');
    expect(disabled).toBeDefined();

    // Re-enable
    await marketplace.enable({ scope: "platform" }, '@kb-labs/optional');

    const result2 = await dm.discover();
    expect(result2.plugins).toHaveLength(1);
  });

  it('link → discover: local linked plugin is available', async () => {
    await createPluginOnDisk('local-dev', '@kb-labs/local-dev', '0.0.1');

    const source: PackageSource = {
      async resolve(): Promise<ResolvedPackage> { throw new Error('unused'); },
      async install(): Promise<InstalledPackage> { throw new Error('unused'); },
      async remove() {},
      async commitInstall() {},
      async rollbackInstall() {},
    };

    const marketplace = makeMarketplaceService({ platformRoot: tmpDir, source });
    const linkResult = await marketplace.link({ scope: "platform" }, 'packages/local-dev');

    expect(linkResult.id).toBe('@kb-labs/local-dev');
    expect(linkResult.primaryKind).toBe('plugin');

    // Discovery should find linked plugin
    const dm = new DiscoveryManager({ root: tmpDir, verifyIntegrity: true });
    const result = await dm.discover();

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]!.id).toBe('@kb-labs/local-dev');
    expect(result.plugins[0]!.source.kind).toBe('local');
  });
});
