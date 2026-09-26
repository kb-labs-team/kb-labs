import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SnapshotManager } from '../snapshot/snapshot-manager.js';
import type { RegistrySnapshot } from '../types.js';

/**
 * Regression for #23: a rebuilt (already-installed) plugin must invalidate the
 * cached registry snapshot even though marketplace.lock is untouched. Staleness
 * is driven by the on-disk manifest artifact's mtime vs the snapshot timestamp.
 */
describe('SnapshotManager — manifest staleness (#23)', () => {
  let root: string;
  let pluginRoot: string;
  let kbHome: string;

  const T = Date.now(); // snapshot timestamp (must be "now" so TTL is not already expired)

  function makeSnapshot(): RegistrySnapshot {
    return {
      schema: 'kb.registry/1',
      rev: 1,
      version: '1',
      generatedAt: new Date(T).toISOString(),
      expiresAt: new Date(T + 3_600_000).toISOString(), // far future → not TTL-expired
      ttlMs: 60_000,
      partial: false,
      stale: false,
      source: { cwd: root, platformVersion: 'test' },
      plugins: [],
      manifests: [
        {
          pluginId: '@kb-labs/foo',
          manifest: { schema: 'kb.plugin/3', id: '@kb-labs/foo', version: '1.0.0' } as RegistrySnapshot['manifests'][number]['manifest'],
          pluginRoot,
          source: { kind: 'local', path: './node_modules/@kb-labs/foo' },
        },
      ],
      ts: T,
    };
  }

  function setManifestMtime(ms: number): void {
    const when = new Date(ms);
    utimesSync(join(pluginRoot, 'dist', 'index.js'), when, when);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kb-snap-'));
    kbHome = mkdtempSync(join(tmpdir(), 'kb-snap-home-'));
    pluginRoot = join(root, 'node_modules', '@kb-labs', 'foo');
    mkdirSync(join(pluginRoot, 'dist'), { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ name: '@kb-labs/foo', version: '1.0.0' }));
    writeFileSync(join(pluginRoot, 'dist', 'index.js'), 'export const manifest = {};');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(kbHome, { recursive: true, force: true });
  });

  it('keeps a snapshot fresh when the manifest artifact predates it', async () => {
    const mgr = new SnapshotManager({ root, kbHome, platformVersion: 'test' });
    await mgr.persist(makeSnapshot());

    setManifestMtime(T - 10_000); // built before the snapshot
    const loaded = await mgr.load();

    expect(loaded).not.toBeNull();
    expect(loaded!.stale).toBe(false);
  });

  it('marks the snapshot stale when the manifest artifact was rebuilt after it', async () => {
    const mgr = new SnapshotManager({ root, kbHome, platformVersion: 'test' });
    await mgr.persist(makeSnapshot());

    setManifestMtime(T + 10_000); // rebuilt after the snapshot — the #23 case
    const loaded = await mgr.load();

    expect(loaded).not.toBeNull();
    expect(loaded!.stale).toBe(true);
  });

  it('honours the package.json kbLabs.manifest pointer for staleness', async () => {
    // Point the manifest at dist/manifest.js (the exact artifact named in #23)
    writeFileSync(
      join(pluginRoot, 'package.json'),
      JSON.stringify({ name: '@kb-labs/foo', version: '1.0.0', kbLabs: { manifest: './dist/manifest.js' } }),
    );
    const manifestArtifact = join(pluginRoot, 'dist', 'manifest.js');
    writeFileSync(manifestArtifact, 'export const manifest = {};');

    const mgr = new SnapshotManager({ root, kbHome, platformVersion: 'test' });
    await mgr.persist(makeSnapshot());

    const future = new Date(T + 10_000);
    utimesSync(manifestArtifact, future, future);
    const loaded = await mgr.load();

    expect(loaded!.stale).toBe(true);
  });

  it('does not flag staleness when there is no locatable manifest artifact', async () => {
    rmSync(join(pluginRoot, 'dist'), { recursive: true, force: true });

    const mgr = new SnapshotManager({ root, kbHome, platformVersion: 'test' });
    await mgr.persist(makeSnapshot());

    const loaded = await mgr.load();
    expect(loaded!.stale).toBe(false);
  });
});

/**
 * ADR-0044: the registry snapshot is per-project runtime state — it must be
 * written under `<KB_HOME>/state/<projectId>/`, never into `<project>/.kb/`.
 */
describe('SnapshotManager — runtime state location', () => {
  let root: string;
  let kbHome: string;

  const T = Date.now();
  const snapshot = (): RegistrySnapshot => ({
    schema: 'kb.registry/1',
    rev: 1,
    version: '1',
    generatedAt: new Date(T).toISOString(),
    expiresAt: new Date(T + 3_600_000).toISOString(),
    ttlMs: 60_000,
    partial: false,
    stale: false,
    source: { cwd: root, platformVersion: 'test' },
    plugins: [],
    manifests: [],
    ts: T,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kb-snap-loc-'));
    kbHome = mkdtempSync(join(tmpdir(), 'kb-snap-loc-home-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(kbHome, { recursive: true, force: true });
  });

  it('writes the snapshot under the KB home state directory and leaves the repo clean', async () => {
    const mgr = new SnapshotManager({ root, kbHome, platformVersion: 'test' });
    await mgr.persist(snapshot());

    expect(existsSync(join(root, '.kb'))).toBe(false);
    const [projectDir] = readdirSync(join(kbHome, 'state'));
    expect(projectDir).toMatch(/^prj_[0-9a-f]{16}$/);
    expect(existsSync(join(kbHome, 'state', projectDir!, 'cache', 'registry.json'))).toBe(true);
  });

  it('ignores a snapshot an older version left in the repository', async () => {
    mkdirSync(join(root, '.kb', 'cache'), { recursive: true });
    const legacy = new SnapshotManager({ root, kbHome, platformVersion: 'test' }).createEmpty();
    writeFileSync(join(root, '.kb', 'cache', 'registry.json'), JSON.stringify(legacy));

    const loaded = await new SnapshotManager({ root, kbHome, platformVersion: 'test' }).load();
    expect(loaded).toBeNull();
  });
});
