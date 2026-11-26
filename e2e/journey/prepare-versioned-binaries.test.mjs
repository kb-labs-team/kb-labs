import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./prepare-versioned-binaries.mjs', import.meta.url));

test('versioned journey binaries are stamped, staged and sealed for the target platform version', () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-journey-binaries-'));
  try {
    const bin = join(root, 'bin');
    const output = join(root, 'output');
    const versions = join(root, 'versions.json');
    const version = '2.120.2-cand.fixture';
    const go = join(bin, 'go');
    mkdirSync(bin, { recursive: true });
    const program = `#!/bin/sh\n` +
      `out=\nversion=\n` +
      `while [ $# -gt 0 ]; do\n` +
      `  case "$1" in\n` +
      `    -o) out=$2; shift 2 ;;\n` +
      `    -ldflags) version=$(printf '%s' "$2" | sed -n 's/.*-X main.version=\\([^ ]*\\).*/\\1/p'); shift 2 ;;\n` +
      `    *) shift ;;\n` +
      `  esac\n` +
      `done\n` +
      `printf '#!/bin/sh\\nprintf "kb-create %s\\\\n"\\n' "$version" > "$out"\n` +
      `chmod +x "$out"\n`;
    writeFileSync(go, program);
    chmodSync(go, 0o755);
    writeFileSync(versions, JSON.stringify([version]));

    const result = spawnSync(process.execPath, [script, '--versions', versions, '--output', output,
      '--asset-base-url', 'http://origin:8080/journey-candidate', '--commit', 'fixture'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const map = JSON.parse(readFileSync(join(output, 'binary-manifest-map.json'), 'utf8'));
    const manifestPath = map[version];
    assert.ok(manifestPath, 'target version has a binary manifest');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.binaries.length, 4);
    const binary = manifest.binaries.find(entry => entry.os === 'linux' && entry.arch === 'amd64');
    assert.ok(binary, 'target includes the Linux runner binary');
    for (const entry of manifest.binaries) {
      assert.equal(entry.version, version);
      const stagedPath = join(output, 'binaries', version, entry.filename);
      assert.equal(entry.sha256, createHash('sha256').update(readFileSync(stagedPath)).digest('hex'));
      assert.equal(entry.url, `http://origin:8080/journey-candidate/binaries/${version}/${entry.filename}`);
    }
    const stagedBinary = join(output, 'binaries', version, binary.filename);
    const versionCheck = spawnSync(stagedBinary, ['--version'], { encoding: 'utf8' });
    assert.equal(versionCheck.status, 0, versionCheck.stderr);
    assert.equal(versionCheck.stdout.trim(), `kb-create ${version}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
