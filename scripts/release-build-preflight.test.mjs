import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const scriptPath = fileURLToPath(new URL('./release-build-preflight.sh', import.meta.url));

test('preflight reports a final CLI command failure with its exact command and status', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kb-release-preflight-'));
  try {
    const binDir = path.join(root, 'bin');
    const devkitDir = path.join(root, 'tools', 'kb-devkit');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(devkitDir, { recursive: true });
    mkdirSync(path.join(root, '.kb'), { recursive: true });
    writeFileSync(path.join(root, '.kb', 'marketplace.lock'), JSON.stringify({ adapters: {} }));
    writeFileSync(path.join(root, 'scripts-release-build-preflight.sh'), readFileSync(scriptPath));

    const node = path.join(binDir, 'node');
    writeFileSync(node, `#!/usr/bin/env bash
if [[ "$*" == *"release build run"* ]]; then
  printf 'forced release stdout tail\\n'
  printf 'forced release stderr tail\\n' >&2
  exit 1
fi
if [[ "$*" == *"release plan"* ]]; then printf '{"ok":true}\\n'; fi
exit 0
`);
    chmodSync(node, 0o755);

    const devkit = path.join(devkitDir, 'kb-devkit');
    writeFileSync(devkit, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(devkit, 0o755);

    const diagnosticsDir = path.join(root, 'diagnostics');
    const result = spawnSync('bash', [path.join(root, 'scripts-release-build-preflight.sh'), 'platform', 'canary', '0123456789abcdef0123456789abcdef01234567', 'preflight'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, HOME: root, CI: 'true', KBLABS_RELEASE_DIAGNOSTICS_DIR: diagnosticsDir },
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /Release preflight command failed \(exit 1\): node \.\/cli\/bin\/dist\/bin\.js release build run --flow platform --json/);
    assert.match(result.stderr, /forced release stdout tail/);
    assert.match(result.stderr, /forced release stderr tail/);
    assert.equal(readFileSync(path.join(diagnosticsDir, 'step-005-stdout.log'), 'utf8'), 'forced release stdout tail\n');
    assert.equal(readFileSync(path.join(diagnosticsDir, 'step-005-stderr.log'), 'utf8'), 'forced release stderr tail\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preflight stages npm artifacts after the release build', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kb-release-preflight-'));
  try {
    const binDir = path.join(root, 'bin');
    const devkitDir = path.join(root, 'tools', 'kb-devkit');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(devkitDir, { recursive: true });
    mkdirSync(path.join(root, '.kb'), { recursive: true });
    writeFileSync(path.join(root, '.kb', 'marketplace.lock'), JSON.stringify({ adapters: {} }));
    writeFileSync(path.join(root, 'scripts-release-build-preflight.sh'), readFileSync(scriptPath));

    const node = path.join(binDir, 'node');
    writeFileSync(node, `#!/usr/bin/env bash
if [[ "$*" == *"release plan"* ]]; then printf '{"ok":true}\\n'; fi
exit 0
`);
    chmodSync(node, 0o755);

    const devkit = path.join(devkitDir, 'kb-devkit');
    writeFileSync(devkit, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(devkit, 0o755);

    const pnpm = path.join(binDir, 'pnpm');
    const pnpmArgsPath = path.join(root, 'pnpm-args.txt');
    writeFileSync(pnpm, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > '${pnpmArgsPath}'\n`);
    chmodSync(pnpm, 0o755);

    const result = spawnSync('bash', [path.join(root, 'scripts-release-build-preflight.sh'), 'platform', 'canary', '0123456789abcdef0123456789abcdef01234567', 'preflight'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, HOME: root, CI: 'true' },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(pnpmArgsPath, 'utf8').trim(), 'kb release artifact create --flow platform --out-dir .kb/release/artifacts --json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
