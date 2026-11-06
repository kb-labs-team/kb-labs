import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { PluginStrategy } from './plugin-strategy.js';

describe('PluginStrategy', () => {
  let tmpDir: string;
  const strategy = new PluginStrategy();

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-strategy-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('kind is plugin', () => {
    expect(strategy.kind).toBe('plugin');
  });

  describe('detectKind', () => {
    it('returns null for empty directory', async () => {
      await fs.writeFile(path.join(tmpDir, 'package.json'), '{"name":"test"}');
      const result = await strategy.detectKind(tmpDir);
      expect(result).toBeNull();
    });

    it('returns plugin when ManifestV3 exists via kb.plugin.json', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: '@test/plugin', kbLabs: { manifest: './kb.plugin.json' } }),
      );
      await fs.writeFile(
        path.join(tmpDir, 'kb.plugin.json'),
        JSON.stringify({
          schema: 'kb.plugin/3',
          id: '@test/plugin',
          version: '1.0.0',
          cli: { commands: [{ id: 'hello', describe: 'test', handler: './dist/hello.js' }] },
        }),
      );
      const result = await strategy.detectKind(tmpDir);
      expect(result).toBe('plugin');
    });
  });

  describe('extractProvides', () => {
    // case: S-203.25
    it('returns no kinds when no plugin manifest is declared', async () => {
      await fs.writeFile(path.join(tmpDir, 'package.json'), '{"name":"test"}');
      const result = await strategy.extractProvides(tmpDir);
      expect(result).toEqual([]);
    });
  });
});
