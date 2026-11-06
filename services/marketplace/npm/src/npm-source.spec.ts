import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertSealedPlatformOverrides, mergeMinimumReleaseAgeExclude, NpmPackageSource } from './npm-source.js';
import type { PackageMetadataError, PlatformArtifactPinsError } from './npm-source.js';

interface RegistryPackage {
  version: string;
  tarball: Buffer;
  integrity: string;
  dependencies: Record<string, string>;
  includeIntegrity: boolean;
}

async function createLocalRegistry(root: string): Promise<{
  url: string;
  publish: (name: string, options?: { dependencies?: Record<string, string>; includeIntegrity?: boolean; integrity?: string }) => Promise<void>;
  close: () => Promise<void>;
}> {
  const packages = new Map<string, RegistryPackage>();
  const server = createHttpServer((request, response) => {
    const requestPath = decodeURIComponent(new URL(request.url ?? '/', `http://${request.headers.host}`).pathname.slice(1));
    const tarballRequest = /^(.*)\/-\/[^/]+$/.exec(requestPath);
    const packageName = tarballRequest?.[1] ?? requestPath;
    const fixture = packages.get(packageName);
    if (!fixture) {
      response.writeHead(404).end('not found');
      return;
    }
    if (tarballRequest) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(fixture.tarball);
      return;
    }
    const versionData: Record<string, unknown> = {
      name: packageName,
      version: fixture.version,
      kb: { adapter: {} },
      dependencies: fixture.dependencies,
      dist: {
        tarball: `${registryUrl}/${encodeURIComponent(packageName)}/-/${packageName.split('/').at(-1)}-${fixture.version}.tgz`,
        ...(fixture.includeIntegrity ? { integrity: fixture.integrity } : {}),
      },
    };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      name: packageName,
      'dist-tags': { latest: fixture.version },
      time: { [fixture.version]: new Date().toISOString() },
      versions: { [fixture.version]: versionData },
    }));
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') { throw new Error('local npm registry did not bind'); }
  const registryUrl = `http://127.0.0.1:${address.port}`;

  return {
    url: registryUrl,
    async publish(name, options = {}) {
      const packageRoot = path.join(root, 'publish', name.replaceAll('/', '__'), 'package');
      await fs.mkdir(packageRoot, { recursive: true });
      await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
        name,
        version: '1.0.0',
        type: 'module',
        dependencies: options.dependencies ?? {},
        kb: { adapter: { manifest: './manifest.mjs' } },
      }));
      await fs.writeFile(path.join(packageRoot, 'manifest.mjs'), `export const manifest = ${JSON.stringify({
        schema: 'kb.adapter/1', manifestVersion: '1.0.0', id: name, name, version: '1.0.0',
        type: 'extension', implements: 'IAdapterFixture', networkRequired: false,
      })};`);
      const archivePath = path.join(root, 'publish', `${name.replaceAll('/', '__')}.tgz`);
      execFileSync('tar', ['-czf', archivePath, '-C', path.dirname(packageRoot), 'package']);
      const tarball = await fs.readFile(archivePath);
      const integrity = `sha512-${crypto.createHash('sha512').update(tarball).digest('base64')}`;
      packages.set(name, {
        version: '1.0.0',
        tarball,
        integrity: options.integrity ?? integrity,
        dependencies: options.dependencies ?? {},
        includeIntegrity: options.includeIntegrity ?? true,
      });
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) { reject(error); }
        else { resolve(); }
      });
    }),
  };
}

describe('NpmPackageSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function createInstallRoot(): Promise<{ root: string; home: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-marketplace-pnpm-install-'));
    const home = path.join(root, 'home');
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'marketplace-fixture',
      version: '1.0.0',
      packageManager: 'pnpm@11.4.0',
    }));
    await fs.writeFile(path.join(root, 'pnpm-workspace.yaml'), [
      'minimumReleaseAge: 10080',
      'minimumReleaseAgeExclude: []',
      'overrides:',
      '  unrelated-package: 1.0.0',
      '',
    ].join('\n'));
    return { root, home };
  }

  async function isolatePnpmEnvironment(home: string, registryUrl: string, store: string): Promise<void> {
    const binDirectory = path.join(path.dirname(home), 'bin');
    const pnpmManager = path.join(os.homedir(), '.cache', 'node', 'corepack', 'v1', 'pnpm', '11.4.0', 'bin', 'pnpm.cjs');
    await fs.mkdir(binDirectory, { recursive: true });
    await fs.access(pnpmManager);
    const pnpmShim = path.join(binDirectory, 'pnpm');
    await fs.writeFile(pnpmShim, `#!/bin/sh\nexec "${process.execPath}" "${pnpmManager}" "$@"\n`, { mode: 0o700 });
    vi.stubEnv('HOME', home);
    vi.stubEnv('PATH', `${binDirectory}:${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`);
    vi.stubEnv('npm_config_registry', registryUrl);
    vi.stubEnv('NPM_CONFIG_REGISTRY', registryUrl);
    vi.stubEnv('npm_config_store_dir', store);
  }

  function packument(packageId: string, kb: { manifest?: string; adapter?: unknown }, version = '1.0.0') {
    return new Response(JSON.stringify({
      name: packageId,
      'dist-tags': { latest: version },
      versions: { [version]: { name: packageId, version, kb, dist: {
        integrity: `sha512-${crypto.createHash('sha512').update('fixture').digest('base64')}`,
        tarball: `https://registry.test/${packageId}/-/${packageId}-${version}.tgz`,
      } } },
    }), { status: 200 });
  }

  it('resolves plugin kind from exact-version package manifest metadata', async () => {
    const fetch = vi.fn(async () => packument('@kb-labs/custom', { manifest: './dist/manifest.js' }));
    vi.stubGlobal('fetch', fetch);
    const source = new NpmPackageSource({ registryUrl: 'https://registry.test' });

    const result = await source.resolve('@kb-labs/custom@1.0.0');

    expect(result).toMatchObject({
      id: '@kb-labs/custom', version: '1.0.0', primaryKind: 'plugin',
      integrity: expect.stringMatching(/^sha512-/),
    });
    expect(fetch).toHaveBeenCalledWith('https://registry.test/@kb-labs%2Fcustom');
  });

  it('classifies the shipped analytics-file package using its published KB metadata', async () => {
    const packagePath = path.resolve(fileURLToPath(new URL('../../../../adapters/analytics-file/package.json', import.meta.url)));
    const packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8')) as {
      name: string; kb: { manifest?: string; adapter?: unknown };
    };
    vi.stubGlobal('fetch', vi.fn(async () => packument(packageJson.name, packageJson.kb)));
    const result = await new NpmPackageSource({ registryUrl: 'https://registry.test' })
      .resolve(packageJson.name);

    expect(result.primaryKind).toBe('adapter');
  });

  it('resolves adapter kind from exact-version package manifest metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => packument('@kb-labs/adapters-file', { adapter: { manifest: './dist/manifest.js' } })));
    const result = await new NpmPackageSource({ registryUrl: 'https://registry.test' })
      .resolve('@kb-labs/adapters-file');
    expect(result).toMatchObject({ id: '@kb-labs/adapters-file', version: '1.0.0', primaryKind: 'adapter' });
  });

  it('resolves an unversioned registry request to an exact integrity pin from catalog metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => packument('@kb-labs/catalog-pinned', { adapter: {} })));
    const result = await new NpmPackageSource({ registryUrl: 'https://registry.test' }).resolve('@kb-labs/catalog-pinned');

    expect(result).toMatchObject({
      id: '@kb-labs/catalog-pinned',
      version: '1.0.0',
      integrity: expect.stringMatching(/^sha512-/),
    });
  });

  it('fails with a typed error when exact-version metadata cannot classify the package', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => packument('@kb-labs/unknown', {})));
    await expect(new NpmPackageSource({ registryUrl: 'https://registry.test' }).resolve('@kb-labs/unknown@1.0.0'))
      .rejects.toMatchObject({ name: 'PackageMetadataError', code: 'UNKNOWN_ENTITY_KIND' });
  });

  // case: S-054.11
  it('writes the exact catalog pin to minimumReleaseAgeExclude without changing unrelated selectors', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-marketplace-age-exclusions-'));
    try {
      const workspaceFile = path.join(root, 'pnpm-workspace.yaml');
      const original = [
        'minimumReleaseAge: 10080',
        'minimumReleaseAgeExclude:',
        '  - "@kb-labs/other@1.0.0"',
        '  - "@kb-labs/pinned@0.9.0"',
        '  - "@kb-labs/pinned@1.0.0"',
        'catalog:',
        '  typescript: 5.0.0',
        '',
      ].join('\n');
      await fs.writeFile(workspaceFile, original);

      await mergeMinimumReleaseAgeExclude(root, '@kb-labs/pinned', '2.0.0');
      const updated = await fs.readFile(workspaceFile, 'utf8');
      expect(updated).toContain('"@kb-labs/other@1.0.0"');
      expect(updated).toContain('"@kb-labs/pinned@0.9.0 || 1.0.0 || 2.0.0"');
      expect(updated).not.toContain('"@kb-labs/pinned@1.0.0"');
      expect(updated).toContain('catalog:\n  typescript: 5.0.0');

      await mergeMinimumReleaseAgeExclude(root, '@kb-labs/pinned', '2.0.0');
      expect(await fs.readFile(workspaceFile, 'utf8')).toBe(updated);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not write a freshness exclusion without an integrity pin', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-marketplace-unpinned-age-'));
    try {
      await fs.writeFile(path.join(root, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 10080\n');
      const original = await fs.readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
      const fetch = vi.fn(async () => new Response(JSON.stringify({
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { kb: { adapter: {} } } },
      }), { status: 200 }));
      vi.stubGlobal('fetch', fetch);
      const resolved = await new NpmPackageSource({ registryUrl: 'https://registry.test' }).resolve('@kb-labs/unpinned');

      expect(resolved.integrity).toBe('');
      expect(await fs.readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8')).toBe(original);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // case: S-054.11
  it('resolves and installs a fresh exact catalog pin through pnpm', async () => {
    const { root, home } = await createInstallRoot();
    const registry = await createLocalRegistry(root);
    try {
      const packageId = '@kb-labs/fresh-adapter';
      await registry.publish(packageId);
      await isolatePnpmEnvironment(home, registry.url, path.join(root, 'pnpm-store'));

      const source = new NpmPackageSource({ registryUrl: registry.url });
      const resolved = await source.resolve(packageId);
      const installed = await source.install(resolved, root);
      const lock = await fs.readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8');
      const workspace = await fs.readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8');

      expect(resolved.integrity).toMatch(/^sha512-/);
      expect(installed).toMatchObject({ id: packageId, version: '1.0.0', integrity: resolved.integrity });
      expect(await fs.stat(installed.packageRoot)).toBeTruthy();
      expect(lock).toContain(`'${packageId}@1.0.0':`);
      expect(lock).toContain(resolved.integrity);
      expect(workspace).toContain(`"${packageId}@1.0.0"`);
      expect(workspace).toContain('unrelated-package: 1.0.0');
      await source.commitInstall(packageId, root);
    } finally {
      await registry.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // case: S-220.11
  it('restores the exact package-manager files and installed graph after marketplace validation fails', async () => {
    const { root, home } = await createInstallRoot();
    const registry = await createLocalRegistry(root);
    try {
      const packageId = '@kb-labs/rollback-adapter';
      await registry.publish(packageId);
      await isolatePnpmEnvironment(home, registry.url, path.join(root, 'pnpm-store'));
      const sealedPackage = '@kb-labs/sealed-runtime';
      const sealedDigest = 'sealed-runtime-digest';
      const receiptPath = path.join(root, '.kb', 'v2', 'receipt.json');
      await fs.mkdir(path.dirname(receiptPath), { recursive: true });
      const cacheRoot = path.join(root, 'pnpm-store', 'sealed-cache');
      await fs.mkdir(cacheRoot, { recursive: true });
      await fs.symlink(cacheRoot, path.join(root, '.kb', 'v2', 'cache'), 'dir');
      const receipt = JSON.stringify({ plan: { artifacts: [
        { package: sealedPackage, sha256: sealedDigest, tarball: 'registry/sealed-runtime.tgz', kind: 'sdk' },
      ] } }) + '\n';
      await fs.writeFile(receiptPath, receipt);
      const workspacePath = path.join(root, 'pnpm-workspace.yaml');
      const workspace = (await fs.readFile(workspacePath, 'utf8')).replace(
        'overrides:\n  unrelated-package: 1.0.0',
        `overrides:\n  "${sealedPackage}": "file:${path.join(cacheRoot, 'packages', `${sealedDigest}.tgz`).replaceAll('\\', '/')}"\n  unrelated-package: 1.0.0`,
      );
      await fs.writeFile(workspacePath, workspace);
      const sealedInstalledPackage = path.join(root, 'node_modules', ...sealedPackage.split('/'), 'package.json');
      await fs.mkdir(path.dirname(sealedInstalledPackage), { recursive: true });
      await fs.writeFile(sealedInstalledPackage, JSON.stringify({ name: sealedPackage, version: '2.120.1' }) + '\n');
      const packageJsonBefore = await fs.readFile(path.join(root, 'package.json'));
      const workspaceBefore = await fs.readFile(workspacePath);
      const sealedPackageBefore = await fs.readFile(sealedInstalledPackage);
      const source = new NpmPackageSource({ registryUrl: registry.url });
      const resolved = await source.resolve(packageId);
      const installed = await source.install(resolved, root);

      await source.rollbackInstall(packageId, root);

      expect(await fs.readFile(path.join(root, 'package.json'))).toEqual(packageJsonBefore);
      expect(await fs.readFile(workspacePath)).toEqual(workspaceBefore);
      expect(await fs.readFile(receiptPath, 'utf8')).toBe(receipt);
      expect(await fs.readFile(sealedInstalledPackage)).toEqual(sealedPackageBefore);
      await expect(fs.access(path.join(root, 'pnpm-lock.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(installed.packageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await registry.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // case: S-220.1
  it('leaves a fresh package without an integrity pin under minimumReleaseAge', async () => {
    const { root, home } = await createInstallRoot();
    const registry = await createLocalRegistry(root);
    try {
      const packageId = '@kb-labs/unpinned-adapter';
      await registry.publish(packageId, { includeIntegrity: false });
      await isolatePnpmEnvironment(home, registry.url, path.join(root, 'pnpm-store'));

      const source = new NpmPackageSource({ registryUrl: registry.url });
      const resolved = await source.resolve(packageId);
      await expect(source.install(resolved, root)).rejects.toMatchObject({ code: 'RELEASE_TOO_FRESH' });

      expect(resolved.integrity).toBe('');
      expect(await fs.readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8')).not.toContain(packageId);
      await expect(fs.stat(path.join(root, 'node_modules', packageId))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await registry.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // case: S-220.5
  it('keeps a fresh transitive dependency age-gated when the exact direct package is pinned', async () => {
    const { root, home } = await createInstallRoot();
    const registry = await createLocalRegistry(root);
    try {
      const packageId = '@kb-labs/pinned-adapter';
      const dependencyId = '@kb-labs/fresh-dependency';
      await registry.publish(dependencyId);
      await registry.publish(packageId, { dependencies: { [dependencyId]: '1.0.0' } });
      await isolatePnpmEnvironment(home, registry.url, path.join(root, 'pnpm-store'));

      const source = new NpmPackageSource({ registryUrl: registry.url });
      const resolved = await source.resolve(`${packageId}@1.0.0`);
      const packageBefore = await fs.readFile(path.join(root, 'package.json'));
      const workspaceBefore = await fs.readFile(path.join(root, 'pnpm-workspace.yaml'));
      await expect(source.install(resolved, root)).rejects.toMatchObject({ code: 'RELEASE_TOO_FRESH' });

      expect(await fs.readFile(path.join(root, 'package.json'))).toEqual(packageBefore);
      expect(await fs.readFile(path.join(root, 'pnpm-workspace.yaml'))).toEqual(workspaceBefore);
      await expect(fs.access(path.join(root, 'pnpm-lock.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(path.join(root, 'node_modules', packageId))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(path.join(root, 'node_modules', dependencyId))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await registry.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // case: S-220.4
  it('refuses a local registry tarball whose integrity differs from its exact catalog pin', async () => {
    const { root, home } = await createInstallRoot();
    const registry = await createLocalRegistry(root);
    try {
      const packageId = '@kb-labs/mismatched-adapter';
      await registry.publish(packageId, { integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` });
      await isolatePnpmEnvironment(home, registry.url, path.join(root, 'pnpm-store'));
      const source = new NpmPackageSource({ registryUrl: registry.url });
      const resolved = await source.resolve(`${packageId}@1.0.0`);
      const lockPath = path.join(root, 'pnpm-lock.yaml');

      await expect(source.install(resolved, root)).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' });
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(path.join(root, 'node_modules', packageId))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await registry.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // case: S-220.10
  it('restores exact package-manager state after a real pnpm install fails post-install integrity verification', async () => {
    const { root, home } = await createInstallRoot();
    const registry = await createLocalRegistry(root);
    try {
      const unrelatedId = '@kb-labs/preexisting-adapter';
      const packageId = '@kb-labs/postinstall-mismatch';
      await registry.publish(unrelatedId);
      await registry.publish(packageId);
      const pnpmManager = path.join(os.homedir(), '.cache', 'node', 'corepack', 'v1', 'pnpm', '11.4.0', 'bin', 'pnpm.cjs');
      await isolatePnpmEnvironment(home, registry.url, path.join(root, 'pnpm-store'));
      const source = new NpmPackageSource({ registryUrl: registry.url });
      const unrelated = await source.resolve(unrelatedId);
      await source.install(unrelated, root);

      const statePaths = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
        .map(file => path.join(root, file));
      const before = await Promise.all(statePaths.map(file => fs.readFile(file)));
      const corruptLockPath = path.join(root, 'corrupt-lock.mjs');
      await fs.writeFile(corruptLockPath, [
        "import * as fs from 'node:fs';",
        "const [root, packageId] = process.argv.slice(2);",
        "const lockPath = `${root}/pnpm-lock.yaml`;",
        "const source = fs.readFileSync(lockPath, 'utf8');",
        "const packages = source.indexOf('\\npackages:');",
        "const start = source.indexOf(`${packageId}@1.0.0`, packages);",
        "const integrity = source.indexOf('integrity: ', start);",
        "const tokenStart = integrity + 'integrity: '.length;",
        "const tokenEnd = source.indexOf(',', tokenStart);",
        "if (packages < 0 || start < 0 || integrity < 0 || tokenEnd < 0) process.exit(3);",
        "fs.writeFileSync(lockPath, source.slice(0, tokenStart) + 'sha512-' + Buffer.alloc(64, 2).toString('base64') + source.slice(tokenEnd));",
      ].join('\n'));
      const pnpmShim = path.join(path.dirname(home), 'bin', 'pnpm');
      await fs.writeFile(pnpmShim, [
        '#!/bin/sh',
        `"${process.execPath}" "${pnpmManager}" "$@"`,
        'status=$?',
        `if [ "$1" = "add" ] && [ "$status" -eq 0 ]; then "${process.execPath}" "${corruptLockPath}" "${root}" "${packageId}" || exit $?; fi`,
        'exit "$status"',
        '',
      ].join('\n'), { mode: 0o700 });
      const resolved = await source.resolve(packageId);
      await expect(source.install(resolved, root)).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' });
      await expect(fs.stat(path.join(root, 'node_modules', packageId))).rejects.toMatchObject({ code: 'ENOENT' });
      const after = await Promise.all(statePaths.map(file => fs.readFile(file)));
      for (let index = 0; index < before.length; index += 1) {
        expect(after[index]).toEqual(before[index]);
      }
      const restoredUnrelated = await import(pathToFileURL(path.join(root, 'node_modules', unrelatedId, 'manifest.mjs')).href);
      expect(restoredUnrelated.manifest.id).toBe(unrelatedId);
    } finally {
      await registry.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('validates every sealed artifact from the receipt when root dependencies contain no file specs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-marketplace-pnpm-overrides-'));
    let cacheRoot = '';
    try {
      await fs.mkdir(path.join(root, '.kb', 'v2'), { recursive: true });
      cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-marketplace-shared-cache-'));
      await fs.symlink(cacheRoot, path.join(root, '.kb', 'v2', 'cache'), 'dir');
      await fs.writeFile(path.join(root, '.kb', 'v2', 'receipt.json'), JSON.stringify({
        id: 'sealed-platform',
        plan: { artifacts: [
          { id: 'workflow', package: '@kb-labs/workflow-daemon', sha256: 'abc123', tarball: 'registry/workflow.tgz' },
          { id: 'gateway', package: '@kb-labs/gateway-app', sha256: 'def456', tarball: 'registry/gateway.tgz' },
          { id: 'binary-tool', kind: 'binary', package: 'tool', sha256: 'xyz', tarball: 'registry/tool.tgz' },
        ] },
      }));
      const packageFile = path.join(root, 'package.json');
      await fs.writeFile(packageFile, JSON.stringify({
        name: 'kb-platform',
        dependencies: {},
      }));
      const workspaceFile = path.join(root, 'pnpm-workspace.yaml');
      const original = 'allowBuilds:\n  esbuild: true\noverrides:\n  lodash: 4.17.21\n';
      await fs.writeFile(workspaceFile, original);

      const error = await assertSealedPlatformOverrides(root, '@kb-labs/adapters-analytics-file', '2.120.1')
        .catch(value => value as PlatformArtifactPinsError);

      expect(error).toMatchObject({
        name: 'PlatformArtifactPinsError',
        code: 'KB_MARKETPLACE_PLATFORM_ARTIFACT_PINS_MISSING',
        message: "The installed platform is missing kb-create's sealed artifact overrides. No package was installed.",
        hint: `Run "kb-create update --platform-root ${JSON.stringify(root)}" and retry "kb marketplace install @kb-labs/adapters-analytics-file@2.120.1 --scope platform".`,
      });
      expect(await fs.readFile(workspaceFile, 'utf8')).toBe(original);
      expect(JSON.parse(await fs.readFile(packageFile, 'utf8')).dependencies).toEqual({});
      await fs.writeFile(workspaceFile, [
        'overrides:',
        `  "@kb-labs/workflow-daemon": file:${path.join(cacheRoot, 'packages', 'abc123.tgz').replaceAll('\\', '/')}`,
        `  "@kb-labs/gateway-app": file:${path.join(cacheRoot, 'packages', 'def456.tgz').replaceAll('\\', '/')}`,
        '',
      ].join('\n'));
      await expect(assertSealedPlatformOverrides(root, '@kb-labs/adapters-analytics-file', '2.120.1'))
        .resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      if (cacheRoot) { await fs.rm(cacheRoot, { recursive: true, force: true }); }
    }
  });

  it('does not pass pin validation when the installed receipt has no sealed artifact set', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-marketplace-empty-receipt-'));
    try {
      await fs.mkdir(path.join(root, '.kb', 'v2'), { recursive: true });
      await fs.writeFile(path.join(root, '.kb', 'v2', 'receipt.json'), JSON.stringify({ plan: { artifacts: [] } }));
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'kb-platform', dependencies: {} }));
      await fs.writeFile(path.join(root, 'pnpm-workspace.yaml'), 'overrides:\n  lodash: 4.17.21\n');

      await expect(assertSealedPlatformOverrides(root, '@kb-labs/adapters-analytics-file', '2.120.1'))
        .rejects.toMatchObject({ code: 'KB_MARKETPLACE_PLATFORM_ARTIFACT_PINS_MISSING' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('uses a typed missing-package error for registry 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    const error = await new NpmPackageSource({ registryUrl: 'https://registry.test' })
      .resolve('@kb-labs/missing@1.0.0').catch(value => value as PackageMetadataError);
    expect(error).toMatchObject({ code: 'PACKAGE_NOT_FOUND', packageId: '@kb-labs/missing' });
  });
});
