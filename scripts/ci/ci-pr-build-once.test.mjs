import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { test } from 'node:test';

// x296: CI (PR) builds the workspace once. Every later job that needs built
// packages consumes the build job's devkit store through one composite action,
// and that action's gate fails the job when a cacheable task rebuilds.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const readYaml = (path) => load(readFileSync(join(root, path), 'utf8'));
const ciPr = readYaml('.github/workflows/ci-pr.yml');
const consume = readYaml('.github/actions/devkit-store-consume/action.yml');
const CONSUME = './.github/actions/devkit-store-consume';

const jobs = Object.entries(ciPr.jobs);
const steps = (job) => job.steps ?? [];
const buildsWorkspace = (step) => typeof step.run === 'string' && /kb-devkit run build\b(?!.*--packages)/.test(step.run);
const consumers = jobs.filter(([, job]) => steps(job).some((step) => step.uses === CONSUME));

test('exactly one job builds the workspace; every job that needs built packages consumes its store', () => {
  const builders = jobs.filter(([, job]) => steps(job).some(buildsWorkspace)).map(([id]) => id);
  assert.deepEqual(builders, ['build']);
  assert.deepEqual(
    consumers.map(([id]) => id).sort(),
    ['checks', 'devkit-checks', 'full-unit-tests', 'launcher-e2e'],
  );
  for (const [id, job] of consumers) {
    const needs = [job.needs ?? []].flat();
    assert.ok(needs.includes('build'), `${id} must wait for the build whose store it consumes`);
    const installAt = steps(job).findIndex((step) => /pnpm install --frozen-lockfile/.test(step.run ?? ''));
    const consumeAt = steps(job).findIndex((step) => step.uses === CONSUME);
    assert.ok(installAt >= 0 && installAt < consumeAt, `${id} installs dependencies before restoring the build`);
  }
});

test('the tests no longer wait on each other or re-archive a second workspace build', () => {
  assert.deepEqual([ciPr.jobs['devkit-checks'].needs].flat().sort(), ['build', 'build-tools', 'e2e-test-plan']);
  assert.equal(ciPr.jobs['full-unit-tests'].needs, 'build');
  const text = JSON.stringify(ciPr);
  assert.ok(!text.includes('full-dist'), 'the second archive of a full rebuild is gone');
  assert.ok(!text.includes('dist-artifacts.tar'), 'the affected-only dist tarball is gone');
});

test('the build job ships the store and the baseline the consumers are gated against', () => {
  const build = ciPr.jobs.build;
  const warm = steps(build).find((step) => /devkit-build-gate\.mjs record/.test(step.run ?? ''));
  assert.ok(warm, 'a second pass records what a warm store still executes');
  assert.match(warm.run, /--out \.ci\/devkit-build-baseline\.json/);
  const upload = steps(build).find((step) => String(step.uses ?? '').startsWith('actions/upload-artifact@') && step.with?.name === 'devkit-store');
  assert.ok(upload, 'the store is uploaded as devkit-store');
  const pack = steps(build).find((step) => /tar .*devkit-store\.tar/.test(step.run ?? ''));
  assert.match(pack.run, /\.kb\/devkit/);
  assert.match(pack.run, /\.ci\/devkit-build-baseline\.json/);
  assert.equal(upload.with.path, 'devkit-store.tar');
});

test('the consume action downloads that store and gates the restore at 60 seconds', () => {
  const [download, unpack, gate] = consume.runs.steps;
  assert.equal(download.with.name, 'devkit-store');
  assert.match(unpack.run, /tar xf devkit-store\.tar/);
  assert.match(gate.run, /kb-devkit run build/);
  assert.match(gate.run, /devkit-build-gate\.mjs consume build-consume\.log --baseline \.ci\/devkit-build-baseline\.json --max-seconds "\$MAX_SECONDS"/);
  assert.equal(consume.inputs['max-seconds'].default, '60');
  assert.match(gate.run, /set -o pipefail/, 'a failing build must not be masked by tee');
});

test('the build job reads the master store read-only and the env matches the master writer', () => {
  const build = ciPr.jobs.build;
  const cas = steps(build).find((step) => step.uses === './.github/actions/devkit-cas');
  assert.ok(cas, 'restores through the one devkit-cas owner');
  assert.equal(cas.with, undefined, 'default mode is restore');
  const master = readYaml('.github/workflows/ci.yml').jobs.build;
  const masterBuild = steps(master).find(buildsWorkspace);
  const prBuild = steps(build).find(buildsWorkspace);
  assert.equal(masterBuild.env.NODE_ENV, 'production');
  assert.equal(prBuild.env.NODE_ENV, 'production', 'task keys do not hash env: both writers and readers build with one NODE_ENV');
});

test('test and test:cli stay --no-cache until the keys are hermetic', () => {
  const unit = steps(ciPr.jobs['full-unit-tests']).filter((step) => /kb-devkit run test(:cli)?\b/.test(step.run ?? ''));
  assert.equal(unit.length, 2);
  for (const step of unit) assert.match(step.run, /--no-cache/);
});
