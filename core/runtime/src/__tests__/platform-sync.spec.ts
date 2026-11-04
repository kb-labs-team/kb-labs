import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { platformSync } from '../platform-sync.js';
import { openCatalog } from '@kb-labs/core-registry';
import type { PackageInstaller } from '../platform-sync-installer.js';

/**
 * These tests exercise the reconciler against a scratch directory. The
 * installer is always mocked — Phase 2's pnpm-shelling `createPnpmInstaller`
 * is covered by a separate integration test later.
 */

interface TestLockEntry {
  version: string;
  integrity: string;
  resolvedPath: string;
  source: 'local' | 'marketplace' | 'platform';
  primaryKind: 'adapter' | 'plugin';
  provides: string[];
  enabled?: boolean;
}

async function openTestCatalog(root: string) {
  return openCatalog({ platformRoot: root, projectRoot: root }, { resolvePlatformVersion: async () => 'test' });
}

async function writeLock(root: string, entries: Record<string, TestLockEntry>): Promise<void> {
  const kbDir = path.join(root, '.kb');
  await fs.mkdir(kbDir, { recursive: true });

  const plugins: Record<string, unknown> = {};
  const adapters: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(entries)) {
    const serialized = entry.source === 'local'
      ? { link: entry.resolvedPath, enabled: entry.enabled ?? true, source: 'local' }
      : {
        version: entry.version,
        integrity: entry.integrity,
        ...(entry.primaryKind === 'plugin' ? { package: id } : {}),
        resolvedPath: entry.resolvedPath,
        source: 'platform',
        enabled: entry.enabled ?? true,
      };
    (entry.primaryKind === 'adapter' ? adapters : plugins)[id] = serialized;
  }

  await fs.writeFile(
    path.join(kbDir, 'marketplace.lock'),
    JSON.stringify({ schema: 'kb.marketplace/3', plugins, ...(Object.keys(adapters).length ? { adapters } : {}) }, null, 2),
  );
}

async function writePackage(
  root: string,
  relPath: string,
  pkg: { name: string; version: string },
): Promise<string> {
  const absPath = path.join(root, relPath);
  await fs.mkdir(absPath, { recursive: true });
  await fs.writeFile(path.join(absPath, 'package.json'), JSON.stringify(pkg, null, 2));
  return absPath;
}

function computeSriHash(json: object): string {
  const hash = crypto.createHash('sha256').update(JSON.stringify(json, null, 2)).digest('base64');
  return `sha256-${hash}`;
}

function createMockInstaller(): PackageInstaller & { calls: Array<{ name: string; version: string }> } {
  const calls: Array<{ name: string; version: string }> = [];
  return {
    calls,
    async install({ root, name, version }) {
      calls.push({ name, version });
      const pkgRoot = path.join(root, 'node_modules', name);
      await fs.mkdir(pkgRoot, { recursive: true });
      await fs.writeFile(
        path.join(pkgRoot, 'package.json'),
        JSON.stringify({ name, version }, null, 2),
      );
      return { resolvedPath: pkgRoot };
    },
  };
}

describe('platformSync', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-sync-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns ok with lockMissing when there is no lock file', async () => {
    const result = await platformSync({ root: tmpDir, catalog: await openTestCatalog(tmpDir), mode: 'validate' });
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(0);
    expect(result.lockMissing).toBe(true);
  });

  it('validate mode: passes when every local entry exists', async () => {
    const pkg = { name: '@kb-labs/fake-adapter', version: '1.0.0' };
    await writePackage(tmpDir, 'packages/fake-adapter', pkg);

    await writeLock(tmpDir, {
      '@kb-labs/fake-adapter': {
        version: '1.0.0',
        // Local hash drift is intentionally ignored — dev packages change all the time.
        integrity: 'sha256-stale',
        resolvedPath: './packages/fake-adapter',
        source: 'local',
        primaryKind: 'plugin',
        provides: ['plugin'],
      },
    });

    const result = await platformSync({ root: tmpDir, catalog: await openTestCatalog(tmpDir), mode: 'validate' });
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(1);
    expect(result.missing).toEqual([]);
    expect(result.mismatched).toEqual([]);
  });

  it('validate mode: reports missing local entry without installing', async () => {
    const installer = createMockInstaller();
    await writeLock(tmpDir, {
      '@kb-labs/missing-local': {
        version: '1.0.0',
        integrity: 'sha256-abc',
        resolvedPath: './packages/missing',
        source: 'local',
        primaryKind: 'plugin',
        provides: ['plugin'],
      },
    });

    const result = await platformSync({
      root: tmpDir,
      catalog: await openTestCatalog(tmpDir),
      mode: 'validate',
      installer,
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['@kb-labs/missing-local']);
    expect(result.installed).toEqual([]);
    expect(installer.calls).toEqual([]);
  });

  it('validate mode: reports integrity mismatch for marketplace entries', async () => {
    const pkg = { name: '@kb-labs/marketplace-pkg', version: '1.0.0' };
    await writePackage(tmpDir, 'node_modules/@kb-labs/marketplace-pkg', pkg);

    await writeLock(tmpDir, {
      '@kb-labs/marketplace-pkg': {
        version: '1.0.0',
        integrity: 'sha256-wrong',
        resolvedPath: './node_modules/@kb-labs/marketplace-pkg',
        source: 'marketplace',
        primaryKind: 'adapter',
        provides: ['adapter'],
      },
    });

    const result = await platformSync({ root: tmpDir, catalog: await openTestCatalog(tmpDir), mode: 'validate' });
    expect(result.ok).toBe(false);
    expect(result.mismatched).toEqual(['@kb-labs/marketplace-pkg']);
  });

  it('validate mode: accepts matching integrity', async () => {
    const pkg = { name: '@kb-labs/good-pkg', version: '1.0.0' };
    await writePackage(tmpDir, 'node_modules/@kb-labs/good-pkg', pkg);
    const integrity = computeSriHash(pkg);

    await writeLock(tmpDir, {
      '@kb-labs/good-pkg': {
        version: '1.0.0',
        integrity,
        resolvedPath: './node_modules/@kb-labs/good-pkg',
        source: 'marketplace',
        primaryKind: 'adapter',
        provides: ['adapter'],
      },
    });

    const result = await platformSync({ root: tmpDir, catalog: await openTestCatalog(tmpDir), mode: 'validate' });
    expect(result.ok).toBe(true);
    expect(result.mismatched).toEqual([]);
  });

  it('validate mode: rejects an entry with empty integrity', async () => {
    const pkg = { name: '@kb-labs/no-integrity', version: '1.0.0' };
    await writePackage(tmpDir, 'node_modules/@kb-labs/no-integrity', pkg);

    await writeLock(tmpDir, {
      '@kb-labs/no-integrity': {
        version: '1.0.0',
        integrity: '',
        resolvedPath: './node_modules/@kb-labs/no-integrity',
        source: 'marketplace',
        primaryKind: 'adapter',
        provides: ['adapter'],
      },
    });

    const result = await platformSync({ root: tmpDir, catalog: await openTestCatalog(tmpDir), mode: 'validate' });
    expect(result.lockMissing).toBe(true);
  });

  it('validate mode: skips disabled entries', async () => {
    const installer = createMockInstaller();
    await writeLock(tmpDir, {
      '@kb-labs/disabled': {
        version: '1.0.0',
        integrity: 'sha256-abc',
        resolvedPath: './packages/never-existed',
        source: 'local',
        primaryKind: 'plugin',
        provides: ['adapter'],
        enabled: false,
      },
    });

    const result = await platformSync({ root: tmpDir, catalog: await openTestCatalog(tmpDir), mode: 'validate', installer });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(installer.calls).toEqual([]);
  });

  it('reconcile mode: installs missing marketplace entry via injected installer', async () => {
    const installer = createMockInstaller();
    await writeLock(tmpDir, {
      '@kb-labs/missing-mp': {
        version: '2.1.0',
        integrity: 'sha256-abc',
        resolvedPath: './node_modules/@kb-labs/missing-mp',
        source: 'marketplace',
        primaryKind: 'adapter',
        provides: ['adapter'],
      },
    });

    const result = await platformSync({
      root: tmpDir,
      catalog: await openTestCatalog(tmpDir),
      mode: 'reconcile',
      installer,
    });

    expect(result.ok).toBe(true);
    expect(result.installed).toEqual(['@kb-labs/missing-mp']);
    expect(installer.calls).toEqual([{ name: '@kb-labs/missing-mp', version: '2.1.0' }]);
  });

  it('reconcile mode: surfaces installer errors and marks result not-ok', async () => {
    const installer: PackageInstaller = {
      async install() {
        throw new Error('boom');
      },
    };

    await writeLock(tmpDir, {
      '@kb-labs/broken': {
        version: '1.0.0',
        integrity: 'sha256-abc',
        resolvedPath: './node_modules/@kb-labs/broken',
        source: 'marketplace',
        primaryKind: 'adapter',
        provides: ['adapter'],
      },
    });

    const result = await platformSync({
      root: tmpDir,
      catalog: await openTestCatalog(tmpDir),
      mode: 'reconcile',
      installer,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.packageId).toBe('@kb-labs/broken');
    expect(result.errors[0]?.message).toContain('boom');
    expect(result.installed).toEqual([]);
    expect(result.missing).toEqual(['@kb-labs/broken']);
  });

  it('reconcile mode: refuses to auto-install missing local entries', async () => {
    const installer = createMockInstaller();

    await writeLock(tmpDir, {
      '@kb-labs/local-gone': {
        version: '1.0.0',
        integrity: 'sha256-abc',
        resolvedPath: './infra/gone',
        source: 'local',
        primaryKind: 'plugin',
        provides: ['adapter'],
      },
    });

    const result = await platformSync({
      root: tmpDir,
      catalog: await openTestCatalog(tmpDir),
      mode: 'reconcile',
      installer,
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['@kb-labs/local-gone']);
    expect(installer.calls).toEqual([]);
    expect(result.errors[0]?.message).toContain('local entry');
  });

  it('dry-run: never installs even when reconcile is requested', async () => {
    const installer = createMockInstaller();
    await writeLock(tmpDir, {
      '@kb-labs/dry': {
        version: '1.0.0',
        integrity: 'sha256-abc',
        resolvedPath: './node_modules/@kb-labs/dry',
        source: 'marketplace',
        primaryKind: 'adapter',
        provides: ['adapter'],
      },
    });

    const result = await platformSync({
      root: tmpDir,
      catalog: await openTestCatalog(tmpDir),
      mode: 'reconcile',
      dryRun: true,
      installer,
    });

    expect(result.mode).toBe('validate');
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['@kb-labs/dry']);
    expect(installer.calls).toEqual([]);
  });

  it('auto mode: picks validate when pnpm-workspace.yaml exists', async () => {
    await fs.writeFile(path.join(tmpDir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    await writeLock(tmpDir, {});

    const result = await platformSync({ root: tmpDir, catalog: await openTestCatalog(tmpDir), mode: 'auto' });
    expect(result.mode).toBe('validate');
  });

  it('auto mode: picks reconcile when there is no monorepo marker', async () => {
    await writeLock(tmpDir, {});

    const result = await platformSync({ root: tmpDir, catalog: await openTestCatalog(tmpDir), mode: 'auto' });
    expect(result.mode).toBe('reconcile');
  });
});
