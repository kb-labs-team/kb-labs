import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./prepare-candidate-binaries.sh', import.meta.url));

test('candidate preparation fails when GoReleaser changes Go module files', () => {
  const bin = mkdtempSync(join(tmpdir(), 'kb-candidate-tools-'));
  try {
    for (const [name, code] of [['goreleaser', 0], ['git', 1], ['node', 0]]) {
      const file = join(bin, name);
      writeFileSync(file, `#!/bin/sh\nexit ${code}\n`);
      chmodSync(file, 0o755);
    }
    const result = spawnSync('bash', [script, 'build', '1.0.0'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /GoReleaser before hooks changed Go module files/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
