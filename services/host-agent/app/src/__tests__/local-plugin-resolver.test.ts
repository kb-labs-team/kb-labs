import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalPluginResolver } from '../handlers/local-plugin-resolver.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

function createTestDir(): string {
  const dir = join(tmpdir(), `kb-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeManifest(dir: string, id: string, version: string = '1.0.0'): void {
  const distDir = join(dir, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'manifest.json'), JSON.stringify({ id, version, schema: 'kb.plugin/3' }));
  writeFileSync(join(distDir, 'handler.js'), 'export default { execute: async () => ({}) };');
}

describe('LocalPluginResolver', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('resolves plugin by id from manifest', async () => {
    const pluginDir = join(testDir, 'my-plugin');
    writeManifest(pluginDir, '@kb-labs/my-plugin');

    const resolver = new LocalPluginResolver([testDir]);
    const result = await resolver.resolve('@kb-labs/my-plugin', 'dist/handler.js');

    expect(result.pluginRoot).toBe(pluginDir);
    expect(result.handlerPath).toBe(join(pluginDir, 'dist', 'handler.js'));
  });

  it('lists discovered plugins', async () => {
    writeManifest(join(testDir, 'plugin-a'), '@kb-labs/plugin-a', '1.0.0');
    writeManifest(join(testDir, 'plugin-b'), '@kb-labs/plugin-b', '2.0.0');

    const resolver = new LocalPluginResolver([testDir]);
    const plugins = await resolver.listPlugins();

    expect(plugins.length).toBe(2);
    expect(plugins.map(p => p.id).sort()).toEqual(['@kb-labs/plugin-a', '@kb-labs/plugin-b']);
  });

  it('throws when plugin not found', async () => {
    const resolver = new LocalPluginResolver([testDir]);
    await expect(resolver.resolve('@kb-labs/nonexistent', 'dist/handler.js'))
      .rejects.toThrow(/not found/i);
  });

  it('rejects path traversal in handlerRef', async () => {
    writeManifest(join(testDir, 'plugin'), '@kb-labs/plugin');

    const resolver = new LocalPluginResolver([testDir]);
    await expect(resolver.resolve('@kb-labs/plugin', '../../../etc/passwd'))
      .rejects.toThrow(/traversal/i);
  });

  it('rejects handlerRef with .. segments', async () => {
    writeManifest(join(testDir, 'plugin'), '@kb-labs/plugin');

    const resolver = new LocalPluginResolver([testDir]);
    await expect(resolver.resolve('@kb-labs/plugin', 'dist/../../secret.js'))
      .rejects.toThrow(/traversal/i);
  });

  it('throws when handler file does not exist', async () => {
    writeManifest(join(testDir, 'plugin'), '@kb-labs/plugin');

    const resolver = new LocalPluginResolver([testDir]);
    await expect(resolver.resolve('@kb-labs/plugin', 'dist/nonexistent.js'))
      .rejects.toThrow(/not found/i);
  });

  it('scans packages/ subdirectory (monorepo layout)', async () => {
    const monoDir = join(testDir, 'my-monorepo');
    writeManifest(join(monoDir, 'packages', 'cli'), '@kb-labs/my-cli');

    const resolver = new LocalPluginResolver([testDir]);
    const plugins = await resolver.listPlugins();

    expect(plugins.length).toBe(1);
    expect(plugins[0]!.id).toBe('@kb-labs/my-cli');
  });

  it('rescan clears cache and rediscovers', async () => {
    const resolver = new LocalPluginResolver([testDir]);

    let plugins = await resolver.listPlugins();
    expect(plugins.length).toBe(0);

    writeManifest(join(testDir, 'new-plugin'), '@kb-labs/new');

    await resolver.rescan();
    plugins = await resolver.listPlugins();
    expect(plugins.length).toBe(1);
  });
});
