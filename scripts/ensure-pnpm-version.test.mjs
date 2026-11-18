import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const script = fileURLToPath(new URL('./ensure-pnpm-version.sh', import.meta.url));
const deployScript = fileURLToPath(new URL('./pnpm-deploy-compatible.sh', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'kb-ensure-pnpm-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const versionFile = join(root, 'pnpm-version');
  const logFile = join(root, 'commands.log');
  const callsFile = join(root, 'pnpm-calls.log');
  const write = (name, content) => {
    const path = join(bin, name);
    writeFileSync(path, content);
    chmodSync(path, 0o755);
    return path;
  };
  write('pnpm', '#!/bin/sh\nif [ "$1" = --version ]; then cat "$FAKE_PNPM_VERSION_FILE"; else echo "$*" >> "$FAKE_PNPM_CALLS"; fi\n');
  write('sudo', '#!/bin/sh\nexec "$@"\n');
  return { root, bin, versionFile, logFile, callsFile, write };
}

function run(scriptArgs, env) {
  return execFileSync('bash', [script, ...scriptArgs], { env, encoding: 'utf8' });
}

test('upgrades an existing pnpm 11 host to the workspace pin through Corepack', (t) => {
  const f = fixture(t);
  writeFileSync(f.versionFile, '11.4.0');
  f.write('corepack', `#!/bin/sh\necho "corepack $*" >> "$FAKE_COMMANDS"\nif [ "$1" = prepare ]; then printf '%s' "${'${2#pnpm@}'}" > "$FAKE_PNPM_VERSION_FILE"; fi\n`);
  const env = {
    ...process.env,
    PATH: `${f.bin}:/usr/bin:/bin`,
    FAKE_PNPM_VERSION_FILE: f.versionFile,
    FAKE_COMMANDS: f.logFile,
  };

  const output = run(['12.21.0'], env);

  assert.match(output, /pnpm: 12\.21\.0/);
  const commands = readFileSync(f.logFile, 'utf8');
  assert.match(commands, /corepack enable pnpm/);
  assert.match(commands, /corepack prepare pnpm@12\.21\.0 --activate/);
  assert.doesNotMatch(commands, /npm install/);
});

test('falls back to npm when Corepack cannot activate the workspace pin', (t) => {
  const f = fixture(t);
  writeFileSync(f.versionFile, '11.4.0');
  f.write('corepack', '#!/bin/sh\necho "corepack $*" >> "$FAKE_COMMANDS"\nexit 1\n');
  f.write('npm', `#!/bin/sh\necho "npm $*" >> "$FAKE_COMMANDS"\nif [ "$1" = install ] && [ "$2" = -g ]; then printf '%s' "${'${3#pnpm@}'}" > "$FAKE_PNPM_VERSION_FILE"; fi\n`);
  const env = {
    ...process.env,
    PATH: `${f.bin}:/usr/bin:/bin`,
    FAKE_PNPM_VERSION_FILE: f.versionFile,
    FAKE_COMMANDS: f.logFile,
  };

  const output = run(['12.21.0'], env);

  assert.match(output, /pnpm: 12\.21\.0/);
  assert.match(readFileSync(f.logFile, 'utf8'), /npm install -g pnpm@12\.21\.0/);
});

test('uses the legacy deploy algorithm for pnpm 11 rollback checkouts', (t) => {
  const f = fixture(t);
  writeFileSync(f.versionFile, '11.4.0');
  const env = { ...process.env, PATH: `${f.bin}:/usr/bin:/bin`, FAKE_PNPM_VERSION_FILE: f.versionFile, FAKE_PNPM_CALLS: f.callsFile };

  runDeploy(env);

  assert.match(readFileSync(f.callsFile, 'utf8'), /deploy --filter @kb-labs\/gateway-app --prod --legacy \/tmp\/app/);
});

test('uses current pnpm 12 deploy algorithm without the legacy flag', (t) => {
  const f = fixture(t);
  writeFileSync(f.versionFile, '12.21.0');
  const env = { ...process.env, PATH: `${f.bin}:/usr/bin:/bin`, FAKE_PNPM_VERSION_FILE: f.versionFile, FAKE_PNPM_CALLS: f.callsFile };

  runDeploy(env);

  assert.match(readFileSync(f.callsFile, 'utf8'), /deploy --filter @kb-labs\/gateway-app --prod \/tmp\/app\n/);
  assert.doesNotMatch(readFileSync(f.callsFile, 'utf8'), /--legacy/);
});

function runDeploy(env) {
  return execFileSync('bash', [deployScript, '--filter', '@kb-labs/gateway-app', '--prod', '/tmp/app'], { env, encoding: 'utf8' });
}
