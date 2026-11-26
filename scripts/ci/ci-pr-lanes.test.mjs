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
const reusablePlaywrightE2e = load(readFileSync(join(root, '.github/workflows/reusable-e2e-playwright.yml'), 'utf8'));
const installerJourney = load(readFileSync(join(root, '.github/workflows/reusable-installer-journey.yml'), 'utf8'));

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

// case: S-262.7
test('master unit tests use the shipped lane while lint and type-check stay workspace-wide', () => {
  const ci = load(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
  const steps = ci.jobs.checks.steps;
  const shipped = steps.find((step) => step.name === 'Run ${{ matrix.task }} (shipped lane)');
  const broad = steps.find((step) => step.name === 'Run ${{ matrix.task }} (lint / type-check)');

  assert.equal(shipped.if, "matrix.task == 'test' || matrix.task == 'test:cli'");
  assert.match(shipped.run, /kb-devkit run \$\{\{ matrix\.task \}\} --lane shipped --no-cache/);
  assert.equal(broad.if, "matrix.task == 'lint' || matrix.task == 'type-check'");
  assert.match(broad.run, /kb-devkit run \$\{\{ matrix\.task \}\} --no-cache/);
  assert.doesNotMatch(broad.run, /--lane/);
});

test('full workspace dist is built once and shared by full tests and Devkit checks', () => {
  const producerId = 'full-dist-for-devkit-build';
  const producer = ciPr.jobs[producerId];
  const consumers = [ciPr.jobs['full-unit-tests'], ciPr.jobs['devkit-checks']];

  assert.ok(producer, 'the shared full-dist producer must exist');
  assert.equal(producer.steps.filter((step) => /kb-devkit run build\b/.test(step.run ?? '')).length, 1);
  assert.equal(producer.steps.find((step) => /kb-devkit run build\b/.test(step.run ?? '')).run, './tools/kb-devkit/kb-devkit run build');
  assert.ok(producer.steps.some((step) => step.with?.name === 'full-dist-for-devkit-checks'));
  for (const consumer of consumers) {
    assert.ok(consumer.needs.includes(producerId), 'both consumers must depend on the producer');
    assert.ok(consumer.steps.some((step) => step.with?.name === 'full-dist-for-devkit-checks'));
  }
  assert.ok(!ciPr.jobs['devkit-checks'].needs.includes('full-unit-tests'), 'Devkit checks can run alongside full tests');
  assert.equal(ciPr.jobs['full-unit-tests'].name, 'test (full)');
  assert.ok(ciPr.jobs['ci-evidence'].needs.includes(producerId));
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

// case: S-262.22
test('CI (PR) validates QA cases from the restored CLI dist before repository checks', () => {
  const job = ciPr.jobs['devkit-checks'];
  const steps = job.steps ?? [];
  const find = (name) => steps.findIndex((step) => step.name === name);
  const validatorIndex = find('Validate QA cases and test claims');
  const validator = steps[validatorIndex];
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const installerSteps = runs(installerJourney.jobs.prepare);
  const installerValidator = installerSteps.find((step) => step.name === 'Validate QA cases and test claims');

  assert.equal(validator.run, 'pnpm kb qa cases validate');
  assert.equal(packageJson.scripts.kb, 'node ./cli/bin/dist/bin.js',
    'the validator uses the built CLI bundled by the dist artifact');
  assert.ok(job.steps.some((step) => step.with?.name === 'full-dist-for-devkit-checks'));
  assert.ok(find('Install dependencies and provision pinned pnpm for clean Go tests') < validatorIndex);
  assert.ok(find('Register checkout for project-scoped CLI checks') < validatorIndex);
  assert.ok(find('Lint workflow definitions') > validatorIndex);
  assert.ok(find('Devkit workspace checks (structure, dependencies, boundaries)') > validatorIndex);
  assert.equal(installerValidator.run, 'pnpm kb qa cases validate',
    'release candidate preparation keeps its existing validation step');
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

// case: S-262.22
test('master checks its own snapshot and release candidate keeps strict workspace checks', () => {
  const ci = load(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
  const profile = JSON.parse(readFileSync(join(root, 'scripts/ci/verification-profile.json'), 'utf8'));
  const steps = runs(ci.jobs['devkit-checks']);
  const compare = steps.find((step) => step.run.includes('scripts/ci/devkit-baseline.mjs'));

  assert.equal(compare.if, "github.ref == 'refs/heads/master'");
  assert.equal(compare.shell, 'bash');
  assert.match(compare.run, /devkit-baseline\.mjs "\$report" "\$GITHUB_SHA"/);
  assert.ok(steps.some((step) => step.if === "github.ref != 'refs/heads/master'" &&
    step.run === './tools/kb-devkit/kb-devkit check'));
  assert.deepEqual(profile.stages['kb-devkit-check'].args, ['check']);
  assert.ok(profile.buildDependentTestStages.candidate.includes('kb-devkit-check'));
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
  assert.match(affectedE2e.jobs.evidence.if, /always\(\) && github\.event_name == 'workflow_dispatch'/);
  assert.ok(ciPr.jobs['ci-evidence'].needs.includes('affected-e2e'));
  assert.ok(ciPr.jobs['ci-evidence'].needs.includes('e2e-platform'));
  assert.equal(ciPr.jobs['ci-evidence'].with['artifact-pattern'], '*platform-logs-${{ github.run_id }}*');
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
  const playwright = reusablePlaywrightE2e.jobs.e2e.steps;
  assert.equal(playwright.find((step) => step.name === 'Checkout').with.ref, checkout.with.ref);
  const platformLogs = playwright.find((step) => step.with?.name?.includes('platform-logs'));
  assert.match(platformLogs.with.name, /inputs\.artifact-prefix \|\| inputs\.suite/);
});
