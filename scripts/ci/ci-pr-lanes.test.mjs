import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ciPr = load(readFileSync(join(root, '.github/workflows/ci-pr.yml'), 'utf8'));
const devkit = load(readFileSync(join(root, 'devkit.yaml'), 'utf8'));
const affectedE2e = load(readFileSync(join(root, '.github/workflows/e2e-affected.yml'), 'utf8'));
const reusableDockerE2e = load(readFileSync(join(root, '.github/workflows/reusable-e2e-docker.yml'), 'utf8'));

const jobs = Object.entries(ciPr.jobs);
const runs = (job) => (job.steps ?? []).filter((step) => typeof step.run === 'string');
const devkitTestRuns = (job) => runs(job).filter((step) => /kb-devkit run test(:cli)?\b/.test(step.run));

// The non-shipped set is the devkit.yaml categories that declare the lane; the
// workflow only names the lane, never a package.
const internalLane = [...new Set(Object.values(devkit.workspace.categories).map((c) => c.releaseLane).filter(Boolean))];

test('devkit.yaml declares exactly one non-shipped lane for the CI split to name', () => {
  assert.deepEqual(internalLane, ['internal-tool']);
});

// case: S-262.7
test('workspace package tests run the declared test script for plugin-entry packages', () => {
  const pluginTest = devkit.tasks.test.find((task) => task.categories?.includes('plugin-entry'));

  assert.ok(pluginTest, 'plugin-entry packages must have a workspace test task');
  assert.equal(pluginTest.command, 'pnpm run test');
  assert.deepEqual(pluginTest.deps, ['build']);

  const registryPackage = JSON.parse(readFileSync(join(root, 'plugins/marketplace-registry/package.json'), 'utf8'));
  assert.match(registryPackage.scripts.test, /vitest run/);
  assert.match(registryPackage.scripts['test:cli'], /vitest run --config vitest\.cli\.config\.ts/);
  assert.notEqual(pluginTest.command, 'pnpm run test:cli');
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

// case: S-262.23
test('affected E2E is triggered once from CI(PR) and checks out the planned SHA', () => {
  assert.ok(ciPr.on.pull_request.types.includes('synchronize'));
  assert.equal(ciPr.on.workflow_run, undefined, 'affected E2E must not duplicate CI(PR) through workflow_run');
  assert.equal(affectedE2e.on.pull_request, undefined, 'the reusable workflow must not add a second automatic PR trigger');
  assert.ok(affectedE2e.on.workflow_call, 'CI(PR) calls the existing Affected E2E workflow');
  assert.ok(affectedE2e.on.workflow_dispatch.inputs['pr-number']);
  assert.ok(affectedE2e.on.workflow_dispatch.inputs['replay-run-id']);

  const caller = ciPr.jobs['affected-e2e'];
  assert.equal(caller.needs, 'e2e-test-plan');
  assert.equal(caller.with['generic-suites'], '${{ needs.e2e-test-plan.outputs.generic }}');
  assert.equal(caller.with['has-auth'], '${{ needs.e2e-test-plan.outputs.has_auth }}');
  assert.equal(caller.with['checkout-ref'], '${{ github.sha }}');

  const discover = affectedE2e.jobs.discover;
  assert.match(discover.if, /inputs\.checkout-ref != ''/);
  assert.doesNotMatch(discover.if, /github\.event_name == 'workflow_call'/);
  assert.match(discover.if, /workflow_dispatch.*replay-run-id == ''/);
  assert.match(affectedE2e.jobs['replay-evidence'].if, /workflow_dispatch.*replay-run-id != ''/);
  const resolveManualPr = discover.steps.find((step) => step.name === 'Resolve pull request refs');
  assert.equal(resolveManualPr.if, "inputs.checkout-ref == ''");
  assert.match(resolveManualPr.with.script, /pr\.base\.sha/);

  const planStep = ciPr.jobs['e2e-test-plan'].steps.find((step) => step.name === 'Resolve zones from the complete PR diff');
  assert.equal(planStep.env.KB_DEVKIT_BASE_REF, '${{ github.event.pull_request.base.sha }}...HEAD');

  for (const jobId of ['docker-e2e', 'auth-e2e', 'oauth-e2e']) {
    assert.equal(affectedE2e.jobs[jobId].with['checkout-ref'], '${{ needs.discover.outputs.checkout-ref }}');
  }
  const checkout = reusableDockerE2e.jobs.e2e.steps.find((step) => step.name === 'Checkout');
  assert.equal(checkout.with.ref, '${{ inputs.checkout-ref || github.sha }}');
});
