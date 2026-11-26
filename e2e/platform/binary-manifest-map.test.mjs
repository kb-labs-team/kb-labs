import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  binaryManifestForVersion,
  binaryPathsForChecksums,
  ensureBinaryManifestDirectory,
  isNativeBinaryTarget,
  verifyManifestBinaryFiles,
  verifyNativeBinaryVersion,
} from './binary-manifest-map.mjs';

test('provisional release indexes have a checksum manifest directory before sealing', () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-provisional-index-'));
  try {
    const output = join(root, 'target', 'release-index.json');
    const directory = ensureBinaryManifestDirectory(output);
    assert.equal(directory, join(root, 'target', 'binary-manifests'));
    assert.equal(existsSync(directory), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('candidate index argument builder is safe with Bash nounset and no manifest map', () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-candidate-index-args-'));
  try {
    const target = join(root, 'target');
    const capture = join(root, 'args.txt');
    const helper = fileURLToPath(new URL('../journey/prepare-candidate-indexes.sh', import.meta.url));
    const invoke = () => spawnSync('bash', ['-uc',
      'source "$1"; node(){ printf "%s\\n" "$@" > "$CAPTURE"; }; journey_prepare_candidate_indexes "$2" "$3" "$4" "$5" 2.120.1 fixture',
      'candidate-index-test', helper, root, join(root, 'packages'), join(root, 'out'), target,
    ], { env: { ...process.env, CAPTURE: capture }, encoding: 'utf8' });
    mkdirSync(target);
    let result = invoke();
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(readFileSync(capture, 'utf8'), /--binary-manifest-map/);
    writeFileSync(join(target, 'binary-manifest-map.json'), '{}\n');
    result = invoke();
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(capture, 'utf8'), /--binary-manifest-map/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('version checks execute only a native Darwin or Linux binary', () => {
  assert.equal(isNativeBinaryTarget('darwin', 'arm64', 'darwin', 'arm64'), true);
  assert.equal(isNativeBinaryTarget('linux', 'amd64', 'linux', 'x64'), true);
  assert.equal(isNativeBinaryTarget('linux', 'amd64', 'darwin', 'arm64'), false);
  assert.equal(isNativeBinaryTarget('linux', 'arm64', 'linux', 'x64'), false);
});

test('bootstrap GoReleaser binaries and versioned update binaries both get checksums', () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-binary-checksums-'));
  try {
    const base = join(root, 'base.json');
    const target = join(root, 'target.json');
    const map = join(root, 'map.json');
    writeFileSync(base, JSON.stringify({ binaries: [{ filename: 'kb-create-linux-amd64' }] }));
    writeFileSync(target, JSON.stringify({ binaries: [{ filename: 'kb-create-linux-amd64' }] }));
    writeFileSync(map, JSON.stringify({ '2.120.2-cand.fixture': target }));
    assert.deepEqual(binaryPathsForChecksums(base, map), [
      'kb-create-linux-amd64', 'binaries/2.120.2-cand.fixture/kb-create-linux-amd64',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap manifest version must match the native GoReleaser binary identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-base-binary-identity-'));
  try {
    const binaryPath = join(root, 'kb-create-linux-amd64');
    const manifestPath = join(root, 'manifest.json');
    writeFileSync(binaryPath, '#!/bin/sh\nprintf "kb-create 2.120.1\\n"\n');
    writeFileSync(manifestPath, JSON.stringify({ binaries: [{
      id: 'kb-create', version: '2.120.1', os: 'linux', arch: 'amd64', filename: 'kb-create-linux-amd64',
      sha256: createHash('sha256').update('#!/bin/sh\nprintf "kb-create 2.120.1\\n"\n').digest('hex'),
      sizeBytes: Buffer.byteLength('#!/bin/sh\nprintf "kb-create 2.120.1\\n"\n'),
    }] }));
    chmodSync(binaryPath, 0o755);
    assert.equal(verifyManifestBinaryFiles(manifestPath), true);
    assert.equal(verifyNativeBinaryVersion(manifestPath, 'linux', 'x64'), true);
    assert.equal(verifyNativeBinaryVersion(manifestPath, 'darwin', 'arm64'), false);
    writeFileSync(binaryPath, '#!/bin/sh\nprintf "kb-create 2.120.1-binaries-SNAPSHOT-old\\n"\n');
    chmodSync(binaryPath, 0o755);
    assert.throws(() => verifyManifestBinaryFiles(manifestPath), /does not match its manifest/);
    assert.throws(() => verifyNativeBinaryVersion(manifestPath, 'linux', 'x64'), /identity mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

    assert.equal(binaryManifestForVersion(targetVersion, base, map, baseVersion), target);
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).binaries[0].version, targetVersion);
    assert.equal(binaryManifestForVersion(baseVersion, base, map, baseVersion), base);
    assert.throws(() => binaryManifestForVersion('2.120.3', base, map, baseVersion), /no entry/);
    writeFileSync(map, JSON.stringify({ [targetVersion]: base }));
    assert.throws(() => binaryManifestForVersion(targetVersion, base, map, baseVersion), /different binary version/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
