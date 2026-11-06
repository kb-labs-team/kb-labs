import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const generator = path.join(root, 'tools/kb-create/scripts/prepare-binary-manifest.mjs');

// case: S-284.11
test('binary manifest follows GoReleaser artifact paths and targets', () => {
  const dist = path.resolve(process.env.KBLABS_RELEASE_DIST ?? path.join(root, 'dist'));
  const artifactsPath = path.join(dist, 'artifacts.json');
  const checksumsPath = path.join(dist, 'checksums.txt');
  const artifacts = JSON.parse(readFileSync(artifactsPath, 'utf8'));
  const checksumByName = new Map(readFileSync(checksumsPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    assert.ok(match, `unexpected checksum line: ${line}`);
    return [match[2], match[1].toLowerCase()];
  }));
  const expectedArtifacts = artifacts.filter(artifact =>
    artifact.type === 'Binary' && artifact.extra?.Checksum && artifact.extra.Binary === 'kb-create');
  assert.ok(expectedArtifacts.length > 0, 'GoReleaser emitted no distributable kb-create binaries');

  const temporary = mkdtempSync(path.join(os.tmpdir(), 'kb-binary-manifest-preflight-'));
  try {
    const output = path.join(temporary, 'binary-manifest.json');
    const manifest = generateManifest(output, []);
    assert.equal(manifest.binaries.length, expectedArtifacts.length);
    const manifestByTarget = new Map(manifest.binaries.map(binary => [`${binary.id}:${binary.os}/${binary.arch}`, binary]));
    for (const artifact of expectedArtifacts) {
      const target = `${artifact.extra.Binary}:${artifact.goos}/${artifact.goarch}`;
      const binary = manifestByTarget.get(target);
      assert.ok(binary, `manifest omitted GoReleaser target ${target}`);
      assert.equal(binary.filename, artifact.name);
      assert.equal(binary.sha256, checksumByName.get(artifact.name));
      assert.equal(binary.sizeBytes, statSync(path.resolve(path.dirname(dist), artifact.path)).size);
      assert.equal(binary.url, `https://github.com/example/kb-labs/releases/download/snapshot-binaries/${artifact.name}`);
      assert.equal(binary.version, '2.0.0-preflight');
    }

    const baseURLManifest = generateManifest(path.join(temporary, 'base-url-manifest.json'), [
      '--asset-base-url', 'https://registry.example.test/candidates/',
    ]);
    assert.ok(baseURLManifest.binaries.every(binary =>
      binary.url === `https://registry.example.test/candidates/${binary.filename}`));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }

  function generateManifest(output, extraArgs) {
    const result = spawnSync(process.execPath, [generator,
      '--artifacts', artifactsPath,
      '--checksums', checksumsPath,
      '--repository', 'example/kb-labs',
      '--release-tag', 'snapshot-binaries',
      '--version', '2.0.0-preflight',
      ...extraArgs,
      '--output', output,
    ], { cwd: path.dirname(dist), encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return JSON.parse(readFileSync(output, 'utf8'));
  }
});
