import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiscoveryManager } from '@kb-labs/core-discovery';
import { resolveCatalogAdapters } from '../adapters.js';

// case: S-286.2
it('discovers defaults declared by an unbound workspace adapter', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kb-workspace-default-'));
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const adapter = path.join(root, 'adapters', 'sqlite');
  try {
    await mkdir(adapter, { recursive: true });
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "adapters/*"\n');
    await writeFile(path.join(adapter, 'package.json'), await readFile(path.join(repo, 'adapters/sqlite/package.json')));
    await symlink(path.join(repo, 'adapters/sqlite/dist'), path.join(adapter, 'dist'));
    const discovery = new DiscoveryManager({ root });
    const result = await resolveCatalogAdapters(discovery, root, {
      workspaceAdapters: { development: true, workspaceRoot: root, configuredPackages: [] },
    });
    const entry = result.get('@kb-labs/adapters-sqlite');
    expect(entry?.manifest.kind).toBe('adapter');
    if (entry?.manifest.kind !== 'adapter') throw new Error('SQLite manifest was not discovered');
    expect(entry.manifest.manifest.defaultFor?.vectorStore).toEqual(['vector-store']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
