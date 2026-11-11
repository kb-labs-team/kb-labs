import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createExtensionStore } from '../store.js';
import { PnpmInstaller } from '../pnpm-installer.js';
import { IntegrityMismatchError } from '../errors.js';
import type { PackageInstaller } from '../types.js';
import { createFixturePackage, sampleManifest } from './fixtures.js';

const INSTALL_TIMEOUT = 60_000;

describe('createExtensionStore (real pnpm, temp-dir store, no real HOME)', () => {
  let kbHome: string;

  beforeEach(async () => {
    // A fresh temp directory stands in for $KB_HOME — never the real one.
    kbHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-extension-store-home-'));
  });

  afterEach(async () => {
    await fs.rm(kbHome, { recursive: true, force: true });
  });

  it(
    'installs a version into the store and resolves its on-disk path',
    async () => {
      const manifest = sampleManifest('sample-plugin', '1.0.0');
      const fixture = await createFixturePackage({ name: 'sample-plugin', version: '1.0.0', manifest });
      const store = createExtensionStore({ root: kbHome, installer: new PnpmInstaller() });

      const resolved = await store.resolve({
        name: 'sample-plugin',
        version: '1.0.0',
        kind: 'plugin',
        spec: `file:${fixture}`,
      });

      expect(resolved.entry.name).toBe('sample-plugin');
      expect(resolved.entry.version).toBe('1.0.0');
      expect(resolved.entry.integrity).toMatch(/^sha256-/); // file: spec has no registry integrity — fallback hash
      expect(resolved.entry.manifest).toEqual(manifest);
      expect(resolved.entryDir).toBe(path.join(kbHome, 'store', 'entries', 'sample-plugin@1.0.0'));

      const pkgJson = JSON.parse(await fs.readFile(path.join(resolved.packageRoot, 'package.json'), 'utf-8'));
      expect(pkgJson.name).toBe('sample-plugin');

      // entry.json is on disk and matches what resolve() returned.
      const entryJson = JSON.parse(await fs.readFile(path.join(resolved.entryDir, 'entry.json'), 'utf-8'));
      expect(entryJson.integrity).toBe(resolved.entry.integrity);

      // The dedicated CAS lives under the store, never the user's default pnpm store.
      await expect(fs.stat(path.join(kbHome, 'store', 'cas'))).resolves.toBeDefined();
    },
    INSTALL_TIMEOUT,
  );

  // case: S-010.1
  it('resolves local platform package artifacts while installing into the store', async () => {
    const platformRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-extension-platform-'));
    const artifactRoot = path.join(platformRoot, '.kb/v2/cache/packages/shared-tool-kit');
    await fs.mkdir(artifactRoot, { recursive: true });
    await fs.writeFile(path.join(artifactRoot, 'package.json'), JSON.stringify({
      name: 'shared-tool-kit',
      version: '2.0.0',
    }));
    const platformArchiveRoot = path.join(platformRoot, '.kb/v2/cache/package-archive');
    await fs.mkdir(path.join(platformArchiveRoot, 'package'), { recursive: true });
    await fs.copyFile(path.join(artifactRoot, 'package.json'), path.join(platformArchiveRoot, 'package/package.json'));
    const platformTarball = path.join(platformRoot, '.kb/v2/cache/packages/shared-tool-kit.tgz');
    await fs.mkdir(path.dirname(platformTarball), { recursive: true });
    execFileSync('tar', ['-czf', platformTarball, '-C', platformArchiveRoot, 'package']);

    const fixture = await createFixturePackage({ name: 'sample-plugin', version: '1.0.0' });
    const sharedCommandRoot = path.join(fixture, 'shared-command-kit');
    await fs.mkdir(sharedCommandRoot, { recursive: true });
    await fs.writeFile(path.join(sharedCommandRoot, 'package.json'), JSON.stringify({
      name: 'shared-command-kit',
      version: '2.0.0',
      dependencies: {
        'shared-tool-kit': 'file:.kb/v2/cache/packages/shared-tool-kit.tgz',
      },
    }));
    const sharedCommandArchiveRoot = path.join(fixture, 'shared-command-archive');
    await fs.mkdir(path.join(sharedCommandArchiveRoot, 'package'), { recursive: true });
    await fs.copyFile(path.join(sharedCommandRoot, 'package.json'), path.join(sharedCommandArchiveRoot, 'package/package.json'));
    const sharedCommandTarball = path.join(fixture, 'shared-command-kit.tgz');
    execFileSync('tar', ['-czf', sharedCommandTarball, '-C', sharedCommandArchiveRoot, 'package']);

    const pluginPackage = JSON.parse(await fs.readFile(path.join(fixture, 'package.json'), 'utf-8'));
    pluginPackage.dependencies = { 'shared-command-kit': `file:${sharedCommandTarball}` };
    await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify(pluginPackage));
    const pluginArchiveRoot = path.join(fixture, 'archive');
    await fs.mkdir(path.join(pluginArchiveRoot, 'package'), { recursive: true });
    await fs.copyFile(path.join(fixture, 'package.json'), path.join(pluginArchiveRoot, 'package/package.json'));
    const pluginTarball = path.join(fixture, 'sample-plugin.tgz');
    execFileSync('tar', ['-czf', pluginTarball, '-C', pluginArchiveRoot, 'package']);

    try {
      const store = createExtensionStore({
        root: kbHome,
        installer: new PnpmInstaller({ platformRoot }),
      });
      const resolved = await store.resolve({
        name: 'sample-plugin',
        version: '1.0.0',
        kind: 'plugin',
        spec: `file:${pluginTarball}`,
      });

      const storeLock = await fs.readFile(path.join(resolved.entryDir, 'pnpm-lock.yaml'), 'utf-8');
      expect(storeLock).toContain('shared-command-kit');
      expect(storeLock).toContain('shared-tool-kit');
      expect(storeLock).toContain('file:.kb/v2/cache/packages/shared-tool-kit.tgz');
      const virtualPackages = await fs.readdir(path.join(resolved.entryDir, 'node_modules/.pnpm'));
      expect(virtualPackages.some((name) => name.includes('shared-command-kit'))).toBe(true);
      expect(virtualPackages.some((name) => name.includes('shared-tool-kit'))).toBe(true);
      await expect(fs.lstat(path.join(resolved.entryDir, '.kb'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(platformRoot, { recursive: true, force: true });
      await fs.rm(fixture, { recursive: true, force: true });
    }
  }, INSTALL_TIMEOUT);

  it(
    'passes a resolved registry integrity pin to the package installer',
    async () => {
      const fixture = await createFixturePackage({ name: 'sample-plugin', version: '1.0.0' });
      const expectedIntegrity = 'sha512-cmVnaXN0cnkgdGFyYmFsbCBieXRlcw==';
      let observedIntegrity: string | undefined;
      const installer: PackageInstaller = {
        install: async (options) => {
          observedIntegrity = options.expectedIntegrity;
          await fs.mkdir(options.projectDir, { recursive: true });
          return { integrity: expectedIntegrity, packageRoot: fixture };
        },
      };
      const store = createExtensionStore({ root: kbHome, installer });

      const resolved = await store.resolve({
        name: 'sample-plugin',
        version: '1.0.0',
        kind: 'plugin',
        spec: 'https://registry.example.test/sample-plugin-1.0.0.tgz',
        expectedIntegrity,
      });

      expect(observedIntegrity).toBe(expectedIntegrity);
      expect(resolved.entry.integrity).toBe(expectedIntegrity);
    },
    INSTALL_TIMEOUT,
  );

  it(
    'does not reinstall a version already in the store',
    async () => {
      const fixture = await createFixturePackage({ name: 'sample-plugin', version: '1.0.0' });
      let installCount = 0;
      const counting: PackageInstaller = {
        install: async (opts) => {
          installCount += 1;
          return new PnpmInstaller().install(opts);
        },
      };
      const store = createExtensionStore({ root: kbHome, installer: counting });
      const request = { name: 'sample-plugin', version: '1.0.0', kind: 'plugin' as const, spec: `file:${fixture}` };

      await store.resolve(request);
      await store.resolve(request);

      expect(installCount).toBe(1);
    },
    INSTALL_TIMEOUT,
  );

  it(
    'serializes two concurrent installs of the same version into a single install',
    async () => {
      const fixture = await createFixturePackage({ name: 'sample-plugin', version: '1.0.0' });
      let installCount = 0;
      const counting: PackageInstaller = {
        install: async (opts) => {
          installCount += 1;
          return new PnpmInstaller().install(opts);
        },
      };
      const store = createExtensionStore({ root: kbHome, installer: counting });
      const request = { name: 'sample-plugin', version: '1.0.0', kind: 'plugin' as const, spec: `file:${fixture}` };

      const [a, b] = await Promise.all([store.resolve(request), store.resolve(request)]);

      expect(installCount).toBe(1);
      expect(a.packageRoot).toBe(b.packageRoot);
    },
    INSTALL_TIMEOUT,
  );

  it(
    'lookup never installs and returns undefined for a version not yet in the store',
    async () => {
      const store = createExtensionStore({ root: kbHome, installer: new PnpmInstaller() });
      await expect(store.lookup({ name: 'sample-plugin', version: '9.9.9' })).resolves.toBeUndefined();
      await expect(fs.stat(path.join(kbHome, 'store'))).rejects.toThrow();
    },
    INSTALL_TIMEOUT,
  );

  it(
    'lookup finds a version resolve() already installed, without installing again',
    async () => {
      const fixture = await createFixturePackage({ name: 'sample-plugin', version: '1.0.0' });
      let installCount = 0;
      const counting: PackageInstaller = {
        install: async (opts) => {
          installCount += 1;
          return new PnpmInstaller().install(opts);
        },
      };
      const store = createExtensionStore({ root: kbHome, installer: counting });
      const request = { name: 'sample-plugin', version: '1.0.0', kind: 'plugin' as const, spec: `file:${fixture}` };

      await store.resolve(request);
      const found = await store.lookup({ name: 'sample-plugin', version: '1.0.0' });

      expect(found).toBeDefined();
      expect(installCount).toBe(1);
    },
    INSTALL_TIMEOUT,
  );

  it(
    'rejects resolution against a mismatched expected integrity (a stale project pin)',
    async () => {
      const fixture = await createFixturePackage({ name: 'sample-plugin', version: '1.0.0' });
      const store = createExtensionStore({ root: kbHome, installer: new PnpmInstaller() });
      const request = { name: 'sample-plugin', version: '1.0.0', kind: 'plugin' as const, spec: `file:${fixture}` };

      await store.resolve(request);

      await expect(
        store.resolve({ ...request, expectedIntegrity: 'sha256-does-not-match' }),
      ).rejects.toBeInstanceOf(IntegrityMismatchError);
    },
    INSTALL_TIMEOUT,
  );

  it(
    'two different versions of one package coexist as separate entries',
    async () => {
      const v1 = await createFixturePackage({ name: 'sample-plugin', version: '1.0.0' });
      const v2 = await createFixturePackage({ name: 'sample-plugin', version: '2.0.0' });
      const store = createExtensionStore({ root: kbHome, installer: new PnpmInstaller() });

      const resolvedV1 = await store.resolve({
        name: 'sample-plugin',
        version: '1.0.0',
        kind: 'plugin',
        spec: `file:${v1}`,
      });
      const resolvedV2 = await store.resolve({
        name: 'sample-plugin',
        version: '2.0.0',
        kind: 'plugin',
        spec: `file:${v2}`,
      });

      expect(resolvedV1.packageRoot).not.toBe(resolvedV2.packageRoot);

      const entries = await store.listEntries();
      const versions = entries.filter((e) => e.name === 'sample-plugin').map((e) => e.version).sort();
      expect(versions).toEqual(['1.0.0', '2.0.0']);
    },
    INSTALL_TIMEOUT,
  );

  it(
    'a failed install leaves no partial entry behind',
    async () => {
      const store = createExtensionStore({ root: kbHome, installer: new PnpmInstaller() });

      await expect(
        store.resolve({
          name: 'sample-plugin',
          version: '1.0.0',
          kind: 'plugin',
          spec: `file:${path.join(os.tmpdir(), 'kb-extension-store-does-not-exist')}`,
        }),
      ).rejects.toThrow();

      // The staging directory pnpm wrote into is cleaned up; nothing is published to entries/.
      await expect(fs.readdir(path.join(kbHome, 'store', 'tmp'))).resolves.toEqual([]);
      await expect(fs.stat(path.join(kbHome, 'store', 'entries', 'sample-plugin@1.0.0'))).rejects.toThrow();
    },
    INSTALL_TIMEOUT,
  );
});
