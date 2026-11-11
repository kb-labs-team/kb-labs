import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const generator = path.join(root, 'tools/kb-create/scripts/generate-unsupported-platform.mjs');
const installers = [
  'tools/kb-create/install.sh',
  'tools/kb-dev/install.sh',
  'tools/kb-deploy/install.sh',
  'tools/kb-devkit/install.sh',
  'tools/kb-monitor/install.sh',
];

// case: S-284.10
test('standalone installers refuse Windows with the catalogued error before network access', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'unsupported-platform-'));
  const bin = path.join(temporary, 'bin');
  const home = path.join(temporary, 'home');
  const curlMarker = path.join(temporary, 'curl-called');
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(path.join(bin, 'uname'), `#!/bin/sh\ncase "$1" in -s) printf '%s\\n' MINGW_NT-10.0 ;; -m) printf '%s\\n' x86_64 ;; esac\n`);
  writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\nprintf called > '${curlMarker}'\nexit 99\n`);
  chmodSync(path.join(bin, 'uname'), 0o755);
  chmodSync(path.join(bin, 'curl'), 0o755);
  try {
    for (const installer of installers) {
      const result = spawnSync('/bin/sh', [path.join(root, installer), '--version', 'v2.0.0-binaries'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
      });
      assert.equal(result.status, 1, `${installer}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /KB_INSTALL_UNSUPPORTED_PLATFORM/,
        `${installer}: ${result.stdout}${result.stderr}`);
      assert.equal(existsSync(curlMarker), false, `${installer} accessed the network before refusing Windows`);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

// case: S-284.10
test('unsupported-platform installer output is generated from the shared error catalog', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'unsupported-platform-drift-'));
  try {
    const catalog = path.join(temporary, 'core/platform/src/error-envelope/errors.catalog.json');
    mkdirSync(path.dirname(catalog), { recursive: true });
    cpSync(path.join(root, 'core/platform/src/error-envelope/errors.catalog.json'), catalog);
    for (const installer of installers) {
      const target = path.join(temporary, installer);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(path.join(root, installer), target);
    }
    const edited = path.join(temporary, installers[0]);
    const source = readFileSync(edited, 'utf8');
    writeFileSync(edited, source.replace('KB_INSTALL_UNSUPPORTED_PLATFORM: %s/%s is not a supported platform.', 'hand-edited message'));
    const result = spawnSync(process.execPath, [generator, '--check', '--root', temporary], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /tools\/kb-create\/install\.sh is stale/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
