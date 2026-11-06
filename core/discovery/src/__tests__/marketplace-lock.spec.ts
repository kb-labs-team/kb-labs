import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readMarketplaceLock, writeMarketplaceLock, createEmptyLock, addToMarketplaceLock, removeFromMarketplaceLock, validateMarketplaceLock } from '../marketplace-lock.js';
import { DiagnosticCollector } from '../diagnostics.js';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');

async function readWorkspacePackage(relativePath: string): Promise<{ kb?: { manifest?: unknown; adapter?: { manifest?: unknown } } }> {
  const workspaceRealPath = await fs.realpath(workspaceRoot);
  const packageRealPath = await fs.realpath(path.resolve(workspaceRoot, relativePath));
  const relativePackagePath = path.relative(workspaceRealPath, packageRealPath);
  expect(relativePackagePath.length, `${relativePath} must resolve to a workspace package`).toBeGreaterThan(0);
  expect(relativePackagePath === '..' || relativePackagePath.startsWith(`..${path.sep}`), `${relativePath} must stay inside the workspace`).toBe(false);
  return JSON.parse(await fs.readFile(path.join(packageRealPath, 'package.json'), 'utf8'));
}

describe('marketplace-lock v3', () => {
  it('identifies the first invalid entry and runtime validation reason', () => {
    const result = validateMarketplaceLock({
      schema: 'kb.marketplace/3',
      plugins: {
        '@kb-labs/broken': { version: '1.0.0', integrity: 'sha999-bad', package: '@kb-labs/broken', enabled: true, source: 'marketplace', marketplaceSource: 'registry', signatureStatus: 'verified' },
      },
    }, 'platform');

    expect(result).toMatchObject({ valid: false, entry: '@kb-labs/broken' });
    if (!result.valid) {expect(result.reason).toMatch(/integrity/i);}
  });

  it('rejects marketplace entries that do not record source, integrity, and signature status', () => {
    const result = validateMarketplaceLock({
      schema: 'kb.marketplace/3',
      plugins: {
        '@kb-labs/commit': { version: '1.0.0', integrity: 'sha512-YQ==', package: '@kb-labs/commit', enabled: true, source: 'marketplace' },
      },
    }, 'platform');

    expect(result).toMatchObject({ valid: false, entry: '@kb-labs/commit' });
    if (!result.valid) { expect(result.reason).toMatch(/marketplaceSource|signatureStatus/i); }
  });

  it('rejects machine adapter entries in project scope and accepts them in platform scope', () => {
    const lock = {
      schema: 'kb.marketplace/3',
      plugins: {},
      adapters: {
        '@kb-labs/adapters-sqlite': { version: '1.0.0', integrity: 'sha512-YQ==', resolvedPath: 'node_modules/@kb-labs/adapters-sqlite', enabled: true, source: 'platform' },
      },
    };

    expect(validateMarketplaceLock(lock, 'project')).toMatchObject({
      valid: false,
      reason: 'project lock must not contain adapters',
    });
    expect(validateMarketplaceLock(lock, 'platform').valid).toBe(true);
  });

  it('rejects platform plugin entries in project scope with the offending ID and reason', () => {
    const lock = {
      schema: 'kb.marketplace/3',
      plugins: {
        '@kb-labs/example': { version: '1.0.0', integrity: 'sha512-YQ==', package: '@kb-labs/example', resolvedPath: 'node_modules/@kb-labs/example', enabled: true, source: 'platform' },
      },
    };

    expect(validateMarketplaceLock(lock, 'project')).toMatchObject({
      valid: false,
      entry: '@kb-labs/example',
      reason: 'source must be marketplace or local in project locks',
    });
    expect(validateMarketplaceLock(lock, 'platform').valid).toBe(true);
  });

  it('runtime project-scope reads reject platform plugin entries', async () => {
    await fs.mkdir(path.join(tmpDir, '.kb'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.kb', 'marketplace.lock'), JSON.stringify({
      schema: 'kb.marketplace/3',
      plugins: {
        '@kb-labs/example': { version: '1.0.0', integrity: 'sha512-YQ==', package: '@kb-labs/example', resolvedPath: 'node_modules/@kb-labs/example', enabled: true, source: 'platform' },
      },
    }));
    const diag = new DiagnosticCollector();

    expect(await readMarketplaceLock(tmpDir, diag, 'project')).toBeNull();
    expect(diag.getEvents()).toContainEqual(expect.objectContaining({
      code: 'LOCK_SCHEMA_INVALID',
      message: expect.stringContaining('@kb-labs/example'),
    }));
  });

  it('runtime project-scope reads reject a present adapters section', async () => {
    await fs.mkdir(path.join(tmpDir, '.kb'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.kb', 'marketplace.lock'), JSON.stringify({
      schema: 'kb.marketplace/3',
      plugins: {},
      adapters: {},
    }));
    const diag = new DiagnosticCollector();

    expect(await readMarketplaceLock(tmpDir, diag, 'project')).toBeNull();
    expect(diag.getEvents()).toContainEqual(expect.objectContaining({
      code: 'LOCK_SCHEMA_INVALID',
      message: expect.stringContaining('project lock must not contain adapters'),
    }));
  });

  let tmpDir: string;
  beforeEach(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-lock-test-')); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  // case: S-179.1
  it('loads the committed developer workspace lock with the v3 validator', async () => {
    const diag = new DiagnosticCollector();
    const lock = await readMarketplaceLock(workspaceRoot, diag);

    expect(lock?.schema).toBe('kb.marketplace/3');
    expect(Object.keys(lock?.plugins ?? {}).length).toBeGreaterThan(0);
    expect(diag.getEvents().filter(event => event.severity === 'error')).toEqual([]);
  });

  // case: S-179.4
  it('keeps workspace plugins and adapters in their v3 lock sections', async () => {
    const lock = await readMarketplaceLock(workspaceRoot, new DiagnosticCollector());
    expect(lock).not.toBeNull();

    for (const [id, entry] of Object.entries(lock?.plugins ?? {})) {
      expect(entry.source, `${id} must be a workspace plugin link`).toBe('local');
      if (entry.source !== 'local') continue;
      const packageJson = await readWorkspacePackage(entry.link);
      expect(packageJson.kb?.manifest, `${id} must resolve to a package declaring a plugin manifest`).toBeTypeOf('string');
    }

    for (const [id, entry] of Object.entries(lock?.adapters ?? {})) {
      const packageJson = await readWorkspacePackage(entry.resolvedPath);
      expect(packageJson.kb?.adapter?.manifest, `${id} must resolve to a package declaring an adapter manifest`).toBeTypeOf('string');
    }
  });

  it('writes sorted, machine independent project pins', async () => {
    const lock = createEmptyLock();
    lock.plugins['z-plugin'] = { version: '1.2.3', integrity: 'sha512-abc', package: 'z-plugin', source: 'marketplace', marketplaceSource: 'npm', signatureStatus: 'unsigned', enabled: true };
    lock.plugins['@scope/a-plugin'] = { version: '4.5.6', integrity: 'sha512-def', package: '@scope/a-plugin', source: 'marketplace', marketplaceSource: 'registry', signatureStatus: 'verified', enabled: false };
    await writeMarketplaceLock(tmpDir, lock);
    const raw = await fs.readFile(path.join(tmpDir, '.kb', 'marketplace.lock'), 'utf8');
    expect(raw).toContain('"schema": "kb.marketplace/3"');
    expect(Object.keys(JSON.parse(raw).plugins)).toEqual(['@scope/a-plugin', 'z-plugin']);
    expect(raw).not.toMatch(/resolvedPath|installedAt|\/Users\/|[A-Z]:\\/);
    expect(await readMarketplaceLock(tmpDir, new DiagnosticCollector())).toEqual(lock);
  });

  it('rejects v2 with a coded diagnostic and exact regeneration command', async () => {
    await fs.mkdir(path.join(tmpDir, '.kb'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.kb', 'marketplace.lock'), JSON.stringify({ schema: 'kb.marketplace/2', installed: {} }));
    const diag = new DiagnosticCollector();
    expect(await readMarketplaceLock(tmpDir, diag)).toBeNull();
    expect(diag.getEvents()[0]?.code).toBe('LOCK_SCHEMA_INVALID');
    expect(diag.getEvents()[0]?.remediation).toContain('kb marketplace sync');
  });

  it('rejects machine-specific paths in project pins', async () => {
    await fs.mkdir(path.join(tmpDir, '.kb'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.kb', 'marketplace.lock'), JSON.stringify({
      schema: 'kb.marketplace/3', plugins: { demo: { version: '1.0.0', integrity: 'sha512-x', package: 'demo-entry', enabled: true, source: 'marketplace', marketplaceSource: 'npm', signatureStatus: 'unsigned', resolvedPath: '/machine/store/demo' } },
    }));
    const diag = new DiagnosticCollector();
    expect(await readMarketplaceLock(tmpDir, diag)).toBeNull();
    expect(diag.getEvents()[0]?.code).toBe('LOCK_SCHEMA_INVALID');
  });

  it('rejects absolute adapter paths and reports provenance failures with a structured reason code', () => {
    const absoluteAdapter = validateMarketplaceLock({
      schema: 'kb.marketplace/3',
      plugins: {},
      adapters: { database: { version: '1.0.0', integrity: 'sha512-x', resolvedPath: '/machine/adapters/database', enabled: true, source: 'platform' } },
    }, 'platform');
    expect(absoluteAdapter).toMatchObject({ valid: false, reasonCode: 'invalid-lock', entry: 'database' });

    const missingProvenance = validateMarketplaceLock({
      schema: 'kb.marketplace/3',
      plugins: { demo: { version: '1.0.0', integrity: 'sha512-x', package: 'demo', enabled: true, source: 'marketplace' } },
    }, 'platform');
    expect(missingProvenance).toMatchObject({ valid: false, reasonCode: 'marketplace-provenance-required', entry: 'demo' });
  });

  // case: S-268.10
  it('rejects escaping installed paths while preserving user-owned link pointers', () => {
    const paths = ['../../outside/plugin', 'a/../../x', '..\\..\\outside\\plugin', 'a\\..\\..\\x'];
    for (const resolvedPath of paths) {
      const marketplacePlugin = validateMarketplaceLock({
        schema: 'kb.marketplace/3',
        plugins: { demo: { version: '1.0.0', integrity: 'sha512-x', package: 'demo', resolvedPath, enabled: true, source: 'marketplace', marketplaceSource: 'npm', signatureStatus: 'unsigned' } },
      }, 'platform');
      const platformPlugin = validateMarketplaceLock({
        schema: 'kb.marketplace/3',
        plugins: { demo: { version: '1.0.0', integrity: 'sha512-x', package: 'demo', resolvedPath, enabled: true, source: 'platform' } },
      }, 'platform');
      const linkedPlugin = validateMarketplaceLock({
        schema: 'kb.marketplace/3',
        plugins: { demo: { link: resolvedPath, enabled: true, source: 'local' } },
      }, 'platform');
      const platformAdapter = validateMarketplaceLock({
        schema: 'kb.marketplace/3', plugins: {},
        adapters: { database: { version: '1.0.0', integrity: 'sha512-x', resolvedPath, enabled: true, source: 'platform' } },
      }, 'platform');
      const marketplaceAdapter = validateMarketplaceLock({
        schema: 'kb.marketplace/3', plugins: {},
        adapters: { database: { version: '1.0.0', integrity: 'sha512-x', resolvedPath, enabled: true, source: 'marketplace', marketplaceSource: 'npm', signatureStatus: 'unsigned' } },
      }, 'platform');

      for (const result of [marketplacePlugin, platformPlugin, platformAdapter, marketplaceAdapter]) {
        expect(result).toMatchObject({ valid: false, reasonCode: 'invalid-lock' });
      }
      expect(linkedPlugin.valid, `user-owned link ${resolvedPath} must be retained`).toBe(true);
    }

    const absoluteLink = validateMarketplaceLock({
      schema: 'kb.marketplace/3',
      plugins: { demo: { link: path.join(tmpDir, 'developer-plugin'), enabled: true, source: 'local' } },
    }, 'platform');
    expect(absoluteLink.valid).toBe(true);
  });

  it('maps the structured provenance reason to the public doctor code', async () => {
    await fs.mkdir(path.join(tmpDir, '.kb'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.kb', 'marketplace.lock'), JSON.stringify({
      schema: 'kb.marketplace/3',
      plugins: { demo: { version: '1.0.0', integrity: 'sha512-x', package: 'demo', enabled: true, source: 'marketplace' } },
    }));
    const diag = new DiagnosticCollector();
    expect(await readMarketplaceLock(tmpDir, diag)).toBeNull();
    expect(diag.getEvents()[0]).toMatchObject({
      code: 'MARKETPLACE_PROVENANCE_REQUIRED',
      remediation: 'Run "kb marketplace install demo --scope platform" to record Marketplace provenance.',
    });
  });

  it('rejects a marketplace pin without its package name through the lock schema diagnostic', async () => {
    await fs.mkdir(path.join(tmpDir, '.kb'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.kb', 'marketplace.lock'), JSON.stringify({
      schema: 'kb.marketplace/3',
      plugins: { '@kb-labs/commit': { version: '1.0.0', integrity: 'sha512-x', enabled: true, source: 'marketplace', marketplaceSource: 'registry', signatureStatus: 'verified' } },
    }));
    const diag = new DiagnosticCollector();
    expect(await readMarketplaceLock(tmpDir, diag)).toBeNull();
    expect(diag.getEvents()[0]).toMatchObject({
      code: 'LOCK_SCHEMA_INVALID',
      remediation: 'Run "kb marketplace sync" to regenerate .kb/marketplace.lock in schema v3.',
    });
  });

  it('rejects a platform plugin pin without its package name through the lock schema diagnostic', async () => {
    await fs.mkdir(path.join(tmpDir, '.kb'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.kb', 'marketplace.lock'), JSON.stringify({
      schema: 'kb.marketplace/3',
      plugins: { '@kb-labs/commit': { version: '1.0.0', integrity: 'sha512-x', enabled: true, source: 'platform', resolvedPath: 'node_modules/@kb-labs/commit' } },
    }));
    const diag = new DiagnosticCollector();
    expect(await readMarketplaceLock(tmpDir, diag)).toBeNull();
    expect(diag.getEvents()[0]).toMatchObject({
      code: 'LOCK_SCHEMA_INVALID',
      remediation: 'Run "kb marketplace sync" to regenerate .kb/marketplace.lock in schema v3.',
    });
  });

  // case: S-179.15
  it('rejects an invalid lock before writing and identifies the plugin missing its package', async () => {
    const invalidLock = JSON.parse(JSON.stringify({
      schema: 'kb.marketplace/3',
      plugins: { '@kb-labs/commit': { version: '1.0.0', integrity: 'sha512-x', enabled: true, source: 'marketplace', marketplaceSource: 'registry', signatureStatus: 'verified' } },
    }));

    await expect(writeMarketplaceLock(tmpDir, invalidLock)).rejects.toMatchObject({
      name: 'MarketplaceLockValidationError',
      code: 'LOCK_SCHEMA_INVALID',
      pluginId: '@kb-labs/commit',
      remediation: 'Run "kb marketplace sync" to regenerate .kb/marketplace.lock in schema v3.',
      message: expect.stringContaining('@kb-labs/commit'),
    });
    await expect(fs.access(path.join(tmpDir, '.kb'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('mutates pins without changing a disabled entry and removes pins', async () => {
    await addToMarketplaceLock(tmpDir, 'demo', { version: '1.0.0', integrity: 'sha512-x', package: 'demo', source: 'marketplace', marketplaceSource: 'registry', signatureStatus: 'verified', enabled: false });
    await addToMarketplaceLock(tmpDir, 'demo', { version: '1.0.0', integrity: 'sha512-x', package: 'demo', source: 'marketplace', marketplaceSource: 'registry', signatureStatus: 'verified', enabled: true });
    const lock = await readMarketplaceLock(tmpDir, new DiagnosticCollector());
    expect(lock?.plugins.demo?.enabled).toBe(false);
    expect(await removeFromMarketplaceLock(tmpDir, 'demo')).toBe(true);
  });
});
