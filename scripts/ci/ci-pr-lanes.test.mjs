import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ciPr = load(readFileSync(join(root, '.github/workflows/ci-pr.yml'), 'utf8'));
const devkit = load(readFileSync(join(root, 'devkit.yaml'), 'utf8'));

const jobs = Object.entries(ciPr.jobs);
const runs = (job) => (job.steps ?? []).filter((step) => typeof step.run === 'string');
const devkitTestRuns = (job) => runs(job).filter((step) => /kb-devkit run test(:cli)?\b/.test(step.run));

// The non-shipped set is the devkit.yaml categories that declare the lane; the
// workflow only names the lane, never a package.
const internalLane = [...new Set(Object.values(devkit.workspace.categories).map((c) => c.releaseLane).filter(Boolean))];

test('devkit.yaml declares exactly one non-shipped lane for the CI split to name', () => {
  assert.deepEqual(internalLane, ['internal-tool']);
});

test('test (full) gates the shipped lane only', () => {
  const full = ciPr.jobs['full-unit-tests'];
  const steps = devkitTestRuns(full);
  assert.ok(steps.length >= 2, 'test (full) must still run unit and CLI handler tests');
  for (const step of steps) assert.match(step.run, /--lane shipped\b/, `${step.name} must be limited to the shipped lane`);
});

test('full PR tests restore only shared CAS and keep the full build and cold release gate', () => {
  const full = ciPr.jobs['full-unit-tests'];
  const steps = full.steps ?? [];
  const restore = steps.find((step) => step.name === 'Restore kb-devkit shared CAS');
  const build = steps.find((step) => step.name === 'Build complete workspace for unit resolution');
  assert.ok(restore, 'full PR unit tests should restore the shared output CAS');
  assert.equal(restore.uses, './.github/actions/devkit-cas');
  assert.equal(restore.with.mode, 'read-write');
  assert.ok(steps.indexOf(restore) < steps.indexOf(build), 'CAS must be restored before the existing full build');
  assert.equal(runs(full).filter((step) => /kb-devkit run build/.test(step.run)).length, 1,
    'the PR job keeps one full build and does not add a second zone build');
  assert.match(build.run, /run build --json/);
  assert.doesNotMatch(build.run, /--affected|--diff-only|--zone|--zones|--no-cache/,
    'the full unit prerequisite build remains complete and cache-enabled');
  assert.match(build.run, /elapsed_seconds/);
  assert.match(build.run, /summary\.cached/);
  assert.match(build.run, /summary\.scheduled/);
  for (const step of devkitTestRuns(full)) assert.match(step.run, /--no-cache/);

  const release = ciPr.jobs['release-build-preflight'];
  assert.ok(!(release.steps ?? []).some((step) => step.uses === './.github/actions/devkit-cas'),
    'the authoritative cold release preflight must not restore PR CAS');
  const releaseAction = load(readFileSync(join(root, '.github/actions/release-build-preflight/action.yml'), 'utf8'));
  const goSetup = releaseAction.runs.steps.find((step) => step.uses?.startsWith('actions/setup-go@'));
  assert.equal(goSetup.with.cache, false, 'the release toolchain stays cold too');
});

test('internal tools run in their own visible job on their own affected inputs', () => {
  const lane = jobs.filter(([, job]) => devkitTestRuns(job).some((step) => step.run.includes(`--lane ${internalLane[0]}`)));
  assert.equal(lane.length, 1, 'exactly one job runs the internal-tool lane');
  const [id, job] = lane[0];
  assert.notEqual(id, 'full-unit-tests');
  assert.match(job.name, /internal tools/);
  const step = devkitTestRuns(job)[0];
  assert.match(step.run, /--affected --diff-only/, 'runs only when the tools inputs changed');
  assert.ok((job.steps ?? []).some((s) => String(s.uses ?? '').startsWith('actions/setup-go@')), 'same Go toolchain setup');
  assert.ok(ciPr.jobs['ci-evidence'].needs.includes(id), 'the lane is part of the CI evidence');
});

test('every devkit test job uploads its task logs when it fails', () => {
  const testJobs = jobs.filter(([, job]) => devkitTestRuns(job).length > 0);
  assert.equal(testJobs.length, 2);
  for (const [id, job] of testJobs) {
    const upload = (job.steps ?? []).find((s) => String(s.uses ?? '').startsWith('actions/upload-artifact@') && s.if === 'failure()');
    assert.ok(upload, `${id} must upload .kb/devkit/logs with if: failure()`);
    assert.equal(upload.with.path, '.kb/devkit/logs/');
    assert.match(upload.with.name, new RegExp(id));
  }
});
