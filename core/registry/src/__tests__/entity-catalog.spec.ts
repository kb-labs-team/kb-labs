import { describe, it, expect } from 'vitest';
import { EntityCatalog } from '../catalog/entity-catalog.js';
import type { ManifestV3 } from '@kb-labs/plugin-contracts';
import type { DiscoveredPlugin } from '@kb-labs/core-discovery';

function makePlugin(id: string, version = '1.0.0'): DiscoveredPlugin {
  return {
    id,
    version,
    packageRoot: `/tmp/${id}`,
    packageName: id,
    scope: 'platform',
    origin: 'node_modules',
    manifestPath: `/tmp/${id}/dist/manifest.json`,
    manifestKind: 'static',
    source: { kind: 'marketplace', path: `./node_modules/${id}` },
    display: { name: id },
    provides: ['plugin'],
  };
}

function makeManifest(id: string, opts?: {
  commands?: number;
  routes?: number;
  workflows?: number;
  widgets?: number;
}): ManifestV3 {
  return {
    schema: 'kb.plugin/3',
    id,
    version: '1.0.0',
    cli: opts?.commands ? {
      commands: Array.from({ length: opts.commands }, (_, i) => ({
        path: `cmd-${i}`, describe: `Command ${i}`, handler: `./dist/cmd-${i}.js`,
      })),
    } : undefined,
    rest: opts?.routes ? {
      routes: Array.from({ length: opts.routes }, (_, i) => ({
        method: 'GET' as const, path: `/route-${i}`, handler: `./dist/route-${i}.js`,
      })),
    } : undefined,
    workflows: opts?.workflows ? {
      handlers: Array.from({ length: opts.workflows }, (_, i) => ({
        id: `wf-${i}`, handler: `./dist/wf-${i}.js`,
      })),
    } : undefined,
    studio: opts?.widgets ? {
      widgets: Array.from({ length: opts.widgets }, (_, i) => ({
        id: `widget-${i}`, component: `./dist/widget-${i}.js`,
      })),
    } as any : undefined,
  };
}

describe('EntityCatalog', () => {
  it('starts empty', () => {
    const catalog = new EntityCatalog();
    expect(catalog.size).toBe(0);
    expect(catalog.getKinds()).toEqual([]);
  });

  it('extracts plugin entity for every discovered plugin', () => {
    const catalog = new EntityCatalog();
    const plugins = [makePlugin('@kb-labs/a'), makePlugin('@kb-labs/b')];
    const manifests = new Map<string, ManifestV3>([
      ['@kb-labs/a', makeManifest('@kb-labs/a')],
      ['@kb-labs/b', makeManifest('@kb-labs/b')],
    ]);

    catalog.rebuild(plugins, manifests);

    const all = catalog.query({ kind: 'plugin' });
    expect(all).toHaveLength(2);
    expect(all.map(e => e.ref.pluginId).sort()).toEqual(['@kb-labs/a', '@kb-labs/b']);
  });

  it('extracts cli-command entities', () => {
    const catalog = new EntityCatalog();
    const plugin = makePlugin('@kb-labs/cli-test');
    const manifest = makeManifest('@kb-labs/cli-test', { commands: 3 });
    catalog.rebuild([plugin], new Map([['@kb-labs/cli-test', manifest]]));

    const commands = catalog.query({ kind: 'cli-command' });
    expect(commands).toHaveLength(3);
    expect(commands[0]!.ref.entityId).toBe('cmd-0');
    expect(commands[0]!.ref.pluginId).toBe('@kb-labs/cli-test');
  });

  it('extracts rest-route entities', () => {
    const catalog = new EntityCatalog();
    const plugin = makePlugin('@kb-labs/rest-test');
    const manifest = makeManifest('@kb-labs/rest-test', { routes: 2 });
    catalog.rebuild([plugin], new Map([['@kb-labs/rest-test', manifest]]));

    const routes = catalog.query({ kind: 'rest-route' });
    expect(routes).toHaveLength(2);
    expect(routes[0]!.ref.entityId).toBe('GET /route-0');
  });

  it('extracts workflow entities', () => {
    const catalog = new EntityCatalog();
    const plugin = makePlugin('@kb-labs/wf-test');
    const manifest = makeManifest('@kb-labs/wf-test', { workflows: 2 });
    catalog.rebuild([plugin], new Map([['@kb-labs/wf-test', manifest]]));

    const workflows = catalog.query({ kind: 'workflow' });
    expect(workflows).toHaveLength(2);
    expect(workflows[0]!.ref.entityId).toBe('wf-0');
  });

  it('filters by pluginId', () => {
    const catalog = new EntityCatalog();
    const plugins = [makePlugin('@kb-labs/a'), makePlugin('@kb-labs/b')];
    const manifests = new Map<string, ManifestV3>([
      ['@kb-labs/a', makeManifest('@kb-labs/a', { commands: 2 })],
      ['@kb-labs/b', makeManifest('@kb-labs/b', { commands: 3 })],
    ]);
    catalog.rebuild(plugins, manifests);

    const aEntities = catalog.query({ pluginId: '@kb-labs/a' });
    // 1 plugin + 2 commands
    expect(aEntities).toHaveLength(3);
    expect(aEntities.every(e => e.ref.pluginId === '@kb-labs/a')).toBe(true);
  });

  it('filters by multiple kinds', () => {
    const catalog = new EntityCatalog();
    const plugin = makePlugin('@kb-labs/multi');
    const manifest = makeManifest('@kb-labs/multi', { commands: 1, routes: 1, workflows: 1 });
    catalog.rebuild([plugin], new Map([['@kb-labs/multi', manifest]]));

    const result = catalog.query({ kind: ['cli-command', 'workflow'] });
    expect(result).toHaveLength(2);
    const kinds = result.map(e => e.ref.kind);
    expect(kinds).toContain('cli-command');
    expect(kinds).toContain('workflow');
  });

  it('filters by search term', () => {
    const catalog = new EntityCatalog();
    const plugin = makePlugin('@kb-labs/searchable');
    const manifest = makeManifest('@kb-labs/searchable', { commands: 3 });
    catalog.rebuild([plugin], new Map([['@kb-labs/searchable', manifest]]));

    const result = catalog.query({ search: 'cmd-1' });
    expect(result).toHaveLength(1);
    expect(result[0]!.ref.entityId).toBe('cmd-1');
  });

  it('getEntity returns exact match by ref', () => {
    const catalog = new EntityCatalog();
    const plugin = makePlugin('@kb-labs/exact');
    const manifest = makeManifest('@kb-labs/exact', { commands: 2 });
    catalog.rebuild([plugin], new Map([['@kb-labs/exact', manifest]]));

    const entity = catalog.get({
      pluginId: '@kb-labs/exact',
      kind: 'cli-command',
      entityId: 'cmd-1',
    });
    expect(entity).not.toBeNull();
    expect(entity!.ref.entityId).toBe('cmd-1');
  });

  it('getEntity returns null for missing ref', () => {
    const catalog = new EntityCatalog();
    catalog.rebuild([], new Map());

    expect(catalog.get({
      pluginId: '@kb-labs/none', kind: 'plugin', entityId: 'none',
    })).toBeNull();
  });

  it('getKinds lists only kinds with entries', () => {
    const catalog = new EntityCatalog();
    const plugin = makePlugin('@kb-labs/kinds');
    const manifest = makeManifest('@kb-labs/kinds', { commands: 1, workflows: 1 });
    catalog.rebuild([plugin], new Map([['@kb-labs/kinds', manifest]]));

    const kinds = catalog.getKinds();
    expect(kinds).toContain('plugin');
    expect(kinds).toContain('cli-command');
    expect(kinds).toContain('workflow');
    expect(kinds).not.toContain('rest-route');
  });

  it('rebuild clears previous data', () => {
    const catalog = new EntityCatalog();

    // First build
    const plugin1 = makePlugin('@kb-labs/old');
    catalog.rebuild([plugin1], new Map([['@kb-labs/old', makeManifest('@kb-labs/old', { commands: 5 })]]));
    expect(catalog.size).toBe(6); // 1 plugin + 5 commands

    // Rebuild with different data
    const plugin2 = makePlugin('@kb-labs/new');
    catalog.rebuild([plugin2], new Map([['@kb-labs/new', makeManifest('@kb-labs/new', { routes: 1 })]]));
    expect(catalog.size).toBe(2); // 1 plugin + 1 route
    expect(catalog.query({ pluginId: '@kb-labs/old' })).toHaveLength(0);
  });

  it('verified filter returns only signed entities', () => {
    const catalog = new EntityCatalog();
    const signed = makePlugin('@kb-labs/signed');
    signed.signature = {
      algorithm: 'ed25519', value: 'sig', signer: 'platform',
      signedAt: '2026-01-01T00:00:00Z', verifiedChecks: ['integrity'],
    };
    const unsigned = makePlugin('@kb-labs/unsigned');

    catalog.rebuild(
      [signed, unsigned],
      new Map([
        ['@kb-labs/signed', makeManifest('@kb-labs/signed')],
        ['@kb-labs/unsigned', makeManifest('@kb-labs/unsigned')],
      ]),
    );

    const verified = catalog.query({ verified: true });
    expect(verified).toHaveLength(1);
    expect(verified[0]!.ref.pluginId).toBe('@kb-labs/signed');
  });
});
