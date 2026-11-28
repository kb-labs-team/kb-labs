import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const directory = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(directory, 'installed-scenario.sh');
const overlay = path.resolve(directory, '../scenarios/pressure/overlay.jsonc');

async function setup(t, exists = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'kb-pressure-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const config = path.join(root, 'config.json');
  if (exists) await writeFile(config, '{"gateway":{"existing":true}}\n');
  await writeFile(path.join(bin, 'kb'), `#!/bin/sh\nif [ "$1 $2" = 'config get' ]; then printf '{"ok":true,"data":{"source":"%s"}}\\n' "$TEST_CONFIG"; else printf '%s\\n' "$6" > "$TEST_CONFIG"; [ "\${TEST_FAIL_SET:-0}" != 1 ]; fi\n`, { mode: 0o755 });
  await writeFile(path.join(bin, 'kb-create'), `#!/bin/sh\nprintf 'restart\\n' >> "$TEST_RESTARTS"\n`, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TEST_CONFIG: config,
    TEST_RESTARTS: path.join(root, 'restarts'),
    KB_E2E_PRESSURE_STATE: path.join(root, 'state'),
    KB_E2E_PLATFORM_ROOT: root,
    KB_E2E_PRESSURE_OVERLAY: overlay,
  };
  const run = (arg) => spawnSync('sh', [script, arg], { env, encoding: 'utf8' });
  return { config, env, run };
}

test('applies configured pressure, restarts and restores the exact user config', async (t) => {
  const { config, env, run } = await setup(t);
  const before = await readFile(config, 'utf8');
  const applied = run('pressure');
  assert.equal(applied.status, 0, applied.stderr);
  const pressure = JSON.parse(await readFile(config, 'utf8'));
  assert.equal(pressure.perService.marketplace.requestsPerSecond, 5);
  assert.equal(pressure.perRoute[0].limits.requestsPerSecond, 3);
  assert.equal(pressure.perTenant.limits.requestsPerMinute, 30);
  const reset = run('default');
  assert.equal(reset.status, 0, reset.stderr);
  assert.equal(await readFile(config, 'utf8'), before);
  assert.equal(await readFile(env.TEST_RESTARTS, 'utf8'), 'restart\nrestart\n');
});

test('removes only the fixture-created user config on reset', async (t) => {
  const { config, run } = await setup(t, false);
  const applied = run('pressure');
  assert.equal(applied.status, 0, applied.stderr);
  const reset = run('default');
  assert.equal(reset.status, 0, reset.stderr);
  await assert.rejects(access(config));
});

test('a failed config write restores the snapshot and restarts', async (t) => {
  const { config, env, run } = await setup(t);
  const before = await readFile(config, 'utf8');
  env.TEST_FAIL_SET = '1';
  const applied = run('pressure');
  assert.notEqual(applied.status, 0);
  assert.equal(await readFile(config, 'utf8'), before);
  assert.equal(await readFile(env.TEST_RESTARTS, 'utf8'), 'restart\n');
});
