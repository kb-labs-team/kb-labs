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

// x300: the case validator is one devkit custom_check. PR CI reaches it through
// the full `kb-devkit check` and the journey candidate build runs the same named
// check, so a misplaced `// case:` claim fails on the PR, not after the merge.
const CASE_CHECK = 'qa-case-claims';
const journey = load(readFileSync(join(root, '.github/workflows/reusable-installer-journey.yml'), 'utf8'));
const allRuns = (workflow) => Object.values(workflow.jobs).flatMap(runs);

test('qa case validator is declared once as a devkit check', () => {
  const declared = devkit.custom_checks.filter((c) => c.name === CASE_CHECK);
  assert.equal(declared.length, 1);
  assert.match(declared[0].run, /qa cases validate/);
  assert.deepEqual(declared[0].on, ['check']);
});

test('CI (PR) runs the case validator through the unfiltered devkit check', () => {
  const job = ciPr.jobs['devkit-checks'];
  const check = runs(job).find((step) => /kb-devkit check\s*$/.test(step.run.trim()));
  assert.ok(check, 'devkit-checks runs the full kb-devkit check, which includes the declared check');
  assert.ok(!/--only/.test(check.run), 'no --only filter may drop the case validator');
});

test('the journey candidate build reuses the devkit check instead of its own command', () => {
  const steps = allRuns(journey);
  assert.ok(steps.some((s) => new RegExp(`kb-devkit check --only ${CASE_CHECK}\\b`).test(s.run)));
  assert.ok(!steps.some((s) => /qa cases validate/.test(s.run)), 'no hand-written second copy');
});
