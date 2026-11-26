import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { binaryManifestForVersion } from './binary-manifest-map.mjs';

test('a versioned manifest is selected instead of the base binary manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-binary-manifest-map-'));
  try {
    const baseVersion = '2.120.1';
    const targetVersion = '2.120.2-cand.fixture';
    const base = join(root, 'base.json');
    const target = join(root, 'target.json');
    const map = join(root, 'map.json');
    writeFileSync(base, JSON.stringify({ binaries: [{ version: baseVersion }] }));
    writeFileSync(target, JSON.stringify({ binaries: [{ version: targetVersion }] }));
    writeFileSync(map, JSON.stringify({ [targetVersion]: target }));

    assert.equal(binaryManifestForVersion(targetVersion, base, map), target);
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).binaries[0].version, targetVersion);
    assert.throws(() => binaryManifestForVersion('2.120.3', base, map), /no entry/);
    writeFileSync(map, JSON.stringify({ [targetVersion]: base }));
    assert.throws(() => binaryManifestForVersion(targetVersion, base, map), /different binary version/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
