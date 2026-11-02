import { describe, expect, it } from 'vitest';
import { toDiscoveryResults } from '../discover.js';
import { registerManifests } from '../register.js';
import { createRegistry } from '../service.js';
import { discoverManifestsDetailed } from '../discover.js';
import { createEmptyLock, createMarketplaceEntry, writeMarketplaceLock } from '@kb-labs/core-discovery';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { openCatalog } from '@kb-labs/core-registry';
import type { ManifestV3 } from '@kb-labs/plugin-contracts';
import type { DiscoveredPlugin } from '@kb-labs/plugin-contracts';

describe('failed enabled plugins', () => {
  // case: S-203.21
  it('discovers the installed analytics-emitter fixture command from its enabled marketplace entry', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-analytics-discovery-'));
    try {
      const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../e2e/journey/fixtures/analytics-emitter');
      const pluginDir = path.join(tmpDir, 'analytics-emitter');
      await copyAnalyticsFixture(fixture, pluginDir);
      const lock = createEmptyLock();
      lock.plugins['@kb-labs/e2e-analytics-emitter'] = createMarketplaceEntry({
        version: '1.0.0', integrity: 'sha256-test', source: 'local', resolvedPath: './analytics-emitter',
        primaryKind: 'plugin', provides: ['plugin', 'cli-command'],
      });
      await writeMarketplaceLock(tmpDir, lock);

      const discovery = await discoverManifestsDetailed(await openCatalog({ platformRoot: tmpDir, projectRoot: tmpDir }));
      const registry = createRegistry();
      await registerManifests(discovery.results, registry);

      expect(discovery.diagnostics.filter(event => event.severity === 'error')).toEqual([]);
      expect(registry.resolve(['journey', 'analytics', 'emit']).type).toBe('command');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // case: S-203.21
  it('retains an actionable diagnostic when an enabled plugin command handler is missing', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-missing-handler-'));
    try {
      const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../e2e/journey/fixtures/analytics-emitter');
      const pluginDir = path.join(tmpDir, 'analytics-emitter');
      await copyAnalyticsFixture(fixture, pluginDir);
      await fs.rm(path.join(pluginDir, 'dist', 'commands', 'emit.js'));
      const lock = createEmptyLock();
      lock.plugins['@kb-labs/e2e-analytics-emitter'] = createMarketplaceEntry({
        version: '1.0.0', integrity: 'sha256-test', source: 'local', resolvedPath: './analytics-emitter',
        primaryKind: 'plugin', provides: ['plugin', 'cli-command'],
      });
      await writeMarketplaceLock(tmpDir, lock);

      const discovery = await discoverManifestsDetailed(await openCatalog({ platformRoot: tmpDir, projectRoot: tmpDir }));
      expect(discovery.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'COMMAND_HANDLER_MISSING', context: expect.objectContaining({ pluginId: '@kb-labs/e2e-analytics-emitter' }) }),
      ]));
      const registry = createRegistry();
      await registerManifests(discovery.results, registry);
      const route = registry.resolve(['e2e-analytics-emitter']);
      expect(route.type).toBe('command');
      if (route.type === 'command') {
        expect(route.command.available).toBe(false);
        expect(route.command.hint).toContain('marketplace plugins doctor');
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // case: S-203.21
  it('retains a typed diagnostic when an enabled plugin has an invalid command schema', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-invalid-command-schema-'));
    try {
      const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../e2e/journey/fixtures/analytics-emitter');
      const pluginDir = path.join(tmpDir, 'analytics-emitter');
      await copyAnalyticsFixture(fixture, pluginDir);
      const manifestPath = path.join(pluginDir, 'manifest.js');
      const source = await fs.readFile(manifestPath, 'utf8');
      await fs.writeFile(manifestPath, source.replace(
        "flags: [{ name: 'marker', type: 'string', description: 'Unique event marker', required: true }]",
        "flags: { marker: { type: 'string', description: 'Unique event marker', required: true } }",
      ));
      const lock = createEmptyLock();
      lock.plugins['@kb-labs/e2e-analytics-emitter'] = createMarketplaceEntry({
        version: '1.0.0', integrity: 'sha256-test', source: 'local', resolvedPath: './analytics-emitter',
        primaryKind: 'plugin', provides: ['plugin', 'cli-command'],
      });
      await writeMarketplaceLock(tmpDir, lock);

      const discovery = await discoverManifestsDetailed(await openCatalog({ platformRoot: tmpDir, projectRoot: tmpDir }));
      expect(discovery.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'COMMAND_SCHEMA_INVALID', context: expect.objectContaining({ pluginId: '@kb-labs/e2e-analytics-emitter' }) }),
      ]));
      const registry = createRegistry();
      await registerManifests(discovery.results, registry);
      const route = registry.resolve(['e2e-analytics-emitter']);
      expect(route.type).toBe('command');
      if (route.type === 'command') {
        expect(route.command.available).toBe(false);
        expect(route.command.manifest.unavailableDiagnostic?.code).toBe('COMMAND_SCHEMA_INVALID');
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps an unavailable namespace registered with the original diagnostic and remediation', async () => {
    const results = toDiscoveryResults({
      plugins: [],
      manifests: new Map(),
      diagnostics: [],
      inputs: [],
      candidateMemberships: [],
      fingerprint: '',
      failures: [{
        id: '@kb-labs/release',
        packageName: '@kb-labs/release',
        packageRoot: '/workspace/plugins/release/src/cli',
        scope: 'platform',
        origin: 'linked',
        manifestPath: '/workspace/plugins/release/src/cli/dist/manifest.js',
        reason: 'manifest',
        message: 'No manifest found; run `pnpm build`.',
        diagnosticCode: 'PLUGIN_ID_MISMATCH',
        remediation: 'Correct the manifest id or reinstall the package with its canonical plugin ID.',
      }],
    });
    const registry = createRegistry();
    await registerManifests(results, registry);

    const route = registry.resolve(['release', 'plan']);
    expect(route.type).toBe('command');
    if (route.type === 'command') {
      expect(route.command.available).toBe(false);
      expect(route.command.hint).toContain('canonical plugin ID');
      expect(route.command.manifest.unavailableDiagnostic).toEqual({
        code: 'PLUGIN_ID_MISMATCH',
        remediation: 'Correct the manifest id or reinstall the package with its canonical plugin ID.',
      });
      expect(route.command.manifest.v3Manifest?.cli?.groupMeta?.[0]?.path).toBe('release');
      expect(route.command.manifest.describe).toContain('pnpm build');
    }
  });

  // case: S-203.21
  it('keeps a plugin unavailable when discovery cannot access its command handler', async () => {
    const plugin: DiscoveredPlugin = {
      id: '@kb-labs/unreadable-handler',
      version: '1.0.0',
      packageRoot: '/workspace/plugins/unreadable-handler',
      packageName: '@kb-labs/unreadable-handler',
      scope: 'platform',
      origin: 'linked',
      manifestPath: '/workspace/plugins/unreadable-handler/kb.plugin.json',
      manifestKind: 'static',
      source: { kind: 'local', path: '/workspace/plugins/unreadable-handler' },
      provides: ['plugin', 'cli-command'],
    };
    const manifest: ManifestV3 = {
      schema: 'kb.plugin/3',
      id: plugin.id,
      version: plugin.version,
      cli: { commands: [{ path: 'unreadable run', describe: 'Cannot access handler', handler: './commands/run.js#default' }] },
    };
    const diagnostic = {
      severity: 'error' as const,
      code: 'COMMAND_HANDLER_UNREADABLE',
      message: 'Command handler could not be accessed: permission denied.',
      context: { pluginId: plugin.id, entityKind: 'cli-command' as const, entityId: 'unreadable run' },
      ts: Date.now(),
      remediation: 'Check handler permissions, then run pnpm --filter @kb-labs/unreadable-handler... build.',
    };
    const [discoveryResult] = toDiscoveryResults({
      plugins: [plugin],
      manifests: new Map([[plugin.id, manifest]]),
      failures: [],
      diagnostics: [diagnostic],
      inputs: [],
      candidateMemberships: [],
      fingerprint: '',
    });
    const registry = createRegistry();
    await registerManifests([discoveryResult!], registry);

    const route = registry.resolve(['unreadable-handler']);
    expect(route.type).toBe('command');
    if (route.type === 'command') {
      expect(route.command.available).toBe(false);
      expect(route.command.manifest.unavailableDiagnostic?.code).toBe('COMMAND_HANDLER_UNREADABLE');
      expect(route.command.hint).toContain('pnpm --filter @kb-labs/unreadable-handler... build');
    }
  });
});

async function copyAnalyticsFixture(fixture: string, pluginDir: string): Promise<void> {
  execFileSync(process.execPath, [path.join(fixture, 'build.mjs')], { cwd: fixture });
  await fs.cp(fixture, pluginDir, { recursive: true });
}
