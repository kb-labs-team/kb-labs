import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const deliveryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(deliveryDirectory, '../..');
const composeFile = path.join(deliveryDirectory, 'docker-compose.yml');
const invoker = path.join(deliveryDirectory, 'scripts/run.sh');
const composeOwner = path.join(repositoryRoot, 'e2e/compose-owner.sh');
const policyCli = path.join(repositoryRoot, 'core/plugin-runtime/src/platform-resolve/node-engine.mjs');
const rootManifest = path.join(repositoryRoot, 'package.json');

function composeEnvironment(context, mode) {
  const tempDirectory = mkdtempSync(path.join(os.tmpdir(), `kb-delivery-${mode}-`));
  context.after(() => rmSync(tempDirectory, { recursive: true, force: true }));
  const binDirectory = path.join(tempDirectory, 'bin');
  mkdirSync(binDirectory);
  for (const tool of ['node', 'bash', 'dirname']) {
    const located = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
    assert.equal(located.status, 0, `${tool} is required to invoke delivery scripts`);
    symlinkSync(located.stdout.trim(), path.join(binDirectory, tool));
  }

  const stub = path.join(tempDirectory, 'compose-stub.mjs');
  writeFileSync(stub, `
const mode = process.argv[2];
const args = process.argv.slice(3);
if (mode === 'v2' && args[0] === 'compose') args.shift();
if (mode === 'v2' && args.length === 1 && args[0] === 'version') process.exit(0);
if (args.length < 3 || args[0] !== '-f' || args[2] !== 'config') {
  process.stderr.write('unexpected Compose stub arguments: ' + JSON.stringify(args) + '\\n');
  process.exit(2);
}
const nodeMajor = process.env.KB_NODE_MAJOR;
if (!nodeMajor) {
  process.stderr.write('KB_NODE_MAJOR is required from root package.json engines.node\\n');
  process.exit(1);
}
const config = {
  services: {
    'target-1': { build: { args: { NODE_MAJOR: nodeMajor } } },
    'target-2': { build: { args: { NODE_MAJOR: nodeMajor } } },
  },
};
process.stdout.write(JSON.stringify(config));
`);
  const executable = path.join(binDirectory, mode === 'v2' ? 'docker' : 'docker-compose');
  writeFileSync(executable, `#!/bin/sh\nexec node "${stub}" ${mode} "$@"\n`);
  chmodSync(executable, 0o755);
  return { ...process.env, PATH: binDirectory };
}

for (const mode of ['v2', 'standalone']) {
// case: S-260.5
test(`delivery compose config rejects an unset Node policy argument through ${mode} Compose`, (context) => {
  const environment = composeEnvironment(context, mode);
  delete environment.KB_DELIVERY_COMPOSE_COMMAND;
  delete environment.KB_NODE_MAJOR;
  const resolution = spawnSync('/bin/bash', [composeOwner, 'resolve'], { cwd: repositoryRoot, env: environment, encoding: 'utf8' });
  assert.equal(resolution.status, 0, resolution.stderr);
  const compose = JSON.parse(resolution.stdout);
  const result = spawnSync(compose[0], [...compose.slice(1), '-f', composeFile, 'config', '--format', 'json'], {
    cwd: deliveryDirectory, env: environment, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, /KB_NODE_MAJOR/);
  assert.match(`${result.stdout}\n${result.stderr}`, /root package\.json engines\.node/);
});

// case: S-260.5
test(`delivery invoker renders the root Node major to both targets through ${mode} Compose`, (context) => {
  const policy = spawnSync(process.execPath, [policyCli, '--required-major', rootManifest], { encoding: 'utf8' });
  assert.equal(policy.status, 0, policy.stderr);
  const requiredMajor = Number(policy.stdout.trim());

  const environment = composeEnvironment(context, mode);
  delete environment.KB_NODE_MAJOR;
  const result = spawnSync(invoker, ['config', '--format', 'json'], {
    cwd: deliveryDirectory,
    env: environment,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.error);

  const config = JSON.parse(result.stdout);
  assert.equal(config.services['target-1'].build.args.NODE_MAJOR, String(requiredMajor));
  assert.equal(config.services['target-2'].build.args.NODE_MAJOR, String(requiredMajor));
});
}

// case: S-260.5
test('delivery invoker reports the shared missing Compose message on PATH', (context) => {
  const tempDirectory = mkdtempSync(path.join(os.tmpdir(), 'kb-delivery-no-compose-'));
  context.after(() => rmSync(tempDirectory, { recursive: true, force: true }));
  const binDirectory = path.join(tempDirectory, 'bin');
  mkdirSync(binDirectory);
  symlinkSync(process.execPath, path.join(binDirectory, 'node'));
  symlinkSync('/bin/bash', path.join(binDirectory, 'bash'));
  symlinkSync('/usr/bin/dirname', path.join(binDirectory, 'dirname'));

  const environment = { ...process.env, PATH: binDirectory };
  delete environment.KB_NODE_MAJOR;
  delete environment.KB_DELIVERY_COMPOSE_COMMAND;
  const owner = spawnSync('/bin/bash', [composeOwner, 'resolve'], {
    cwd: repositoryRoot, env: environment, encoding: 'utf8',
  });
  assert.equal(owner.status, 127);
  const result = spawnSync(invoker, ['config', '--format', 'json'], {
    cwd: deliveryDirectory,
    env: environment,
    encoding: 'utf8',
  });

  assert.equal(result.status, 127, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, owner.stderr);
});
