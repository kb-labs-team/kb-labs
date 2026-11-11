import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { invokePackageProvenanceOwner } from 'kb-create/scripts/package-provenance.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const digestToolDirectory = mkdtempSync(join(tmpdir(), 'kb-provenance-digest-tool-'));
const digestTool = join(digestToolDirectory, 'kb-create-release-index');
execFileSync('go', ['build', '-trimpath', '-o', digestTool, './v2/cmd/kb-create-release-index'], {
  cwd: join(repositoryRoot, 'tools/kb-create'),
});
after(() => rmSync(digestToolDirectory, { recursive: true, force: true }));

const goldenPath = join(repositoryRoot, 'tools/kb-create/v2/artifacts/testdata/dist-digest-v1.json');
const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));

function materializeDist(root, entries) {
  for (const entry of entries) {
    const path = join(root, entry.path);
    mkdirSync(dirname(path), { recursive: true });
    if (entry.type === 'symlink') {
      symlinkSync(entry.target, path);
    } else {
      writeFileSync(path, entry.content, { mode: Number.parseInt(entry.mode, 8) });
    }
  }
}

test('JS owner API returns the Go-produced v1 nested-prefix golden result', () => {
  const vector = golden.vectors.find(item => item.name === 'nested-prefix-order');
  assert.ok(vector, 'nested-prefix golden vector exists');
  const dist = mkdtempSync(join(tmpdir(), 'kb-js-dist-digest-golden-'));
  try {
    materializeDist(dist, vector.entries);
    assert.deepEqual(invokePackageProvenanceOwner(digestTool, ['digest', dist]), {
      schema: 'kb-dist-digest/v1', digest: vector.digest,
    });
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('Go provenance sealing binds package identity, revision, archive integrity, and dist digest', t => {
  const root = mkdtempSync(join(tmpdir(), 'kb-package-provenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'package');
  const dist = join(packageRoot, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@kb-labs/sample', version: '1.2.3' }));
  writeFileSync(join(dist, 'index.js'), 'first content');
  const tarball = join(root, 'sample.tgz');
  const pack = () => execFileSync('tar', ['-czf', tarball, '-C', root, 'package']);
  const records = [{ name: '@kb-labs/sample', version: '1.2.3', tarball: 'sample.tgz' }];
  pack();
  const first = invokePackageProvenanceOwner(digestTool, ['provenance', root, 'revision-1'], JSON.stringify(records))[0];
  assert.equal(first.package, '@kb-labs/sample');
  assert.equal(first.version, '1.2.3');
  assert.equal(first.sourceRevision, 'revision-1');
  assert.match(first.integrity, /^sha512-/);
  assert.match(first.distSha256, /^[a-f0-9]{64}$/);
  writeFileSync(join(dist, 'index.js'), 'changed content');
  pack();
  const changed = invokePackageProvenanceOwner(digestTool, ['provenance', root, 'revision-1'], JSON.stringify(records))[0];
  assert.notEqual(changed.integrity, first.integrity);
  assert.notEqual(changed.distSha256, first.distSha256);
});

test('Go provenance owner rejects package dist symlinks', t => {
  const root = mkdtempSync(join(tmpdir(), 'kb-package-provenance-symlink-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'package');
  const dist = join(packageRoot, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@kb-labs/sample', version: '1.2.3' }));
  writeFileSync(join(dist, 'target.js'), 'same symlink fixture bytes');
  symlinkSync('target.js', join(dist, 'index.js'));
  const tarball = join(root, 'sample.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', root, 'package']);
  assert.throws(() => invokePackageProvenanceOwner(digestTool, ['provenance', root, 'revision-1'],
    JSON.stringify([{ name: '@kb-labs/sample', version: '1.2.3', tarball: 'sample.tgz' }])), /Command failed/);
});
