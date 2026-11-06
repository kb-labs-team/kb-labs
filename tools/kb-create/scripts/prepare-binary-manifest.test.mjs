import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// case: S-214.13 (producer boundary; not an installed journey claim)
test('declared targets survive even when all artifacts for a target are missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-targets-'));
  try {
    const config = join(dir, 'goreleaser.yaml');
    const artifact = join(dir, 'kb-create-linux-amd64');
    const artifacts = join(dir, 'artifacts.json');
    const checksums = join(dir, 'checksums.txt');
    const output = join(dir, 'manifest.json');
    writeFileSync(config, 'version: 2\nbuilds:\n  - id: kb-create\n    goos: [linux]\n    goarch: [amd64, arm64]\n');
    writeFileSync(artifact, 'binary');
    writeFileSync(artifacts, JSON.stringify([{type:'Binary', name:'kb-create-linux-amd64', path:artifact, goos:'linux', goarch:'amd64', extra:{Checksum:true, Binary:'kb-create'}}]));
    writeFileSync(checksums, `${'a'.repeat(64)}  kb-create-linux-amd64\n`);
    const result = spawnSync(process.execPath, [new URL('./prepare-binary-manifest.mjs', import.meta.url).pathname, '--config', config, '--artifacts', artifacts, '--checksums', checksums, '--repository', 'example/repo', '--release-tag', 'candidate', '--version', '1.0.0', '--output', output], {encoding:'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output)).supportedTargets, [{os:'linux',arch:'amd64'}, {os:'linux',arch:'arm64'}]);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
