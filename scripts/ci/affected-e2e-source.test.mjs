import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { load } from 'js-yaml';
const workflow = (name) => load(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
// case: S-262.23
test('affected E2E preserves asynchronous triggers and pins every consumer to validated source', () => {
  const ci = workflow('ci-pr'); const affected = workflow('e2e-affected');
  assert.ok(affected.on.workflow_run); assert.ok(affected.on.workflow_dispatch); assert.ok(affected.on.pull_request);
  const source = ci.jobs['e2e-test-plan'].steps.find((step) => step.name === 'Record tested E2E source');
  assert.match(source.run, /git rev-parse HEAD/);
  const d = affected.jobs.discover;
  assert.ok(d.steps.some((step) => step.with?.['run-id'] === '${{ github.event.workflow_run.id }}'));
  assert.ok(d.steps.some((step) => /HEAD\^2/.test(step.run ?? '')));
  const producer = affected.jobs.prepare;
  assert.equal(producer.with['checkout-ref'], '${{ needs.discover.outputs.checkout-ref }}');
  assert.equal(producer.with['cache-mode'], 'off');
  const build = workflow('reusable-e2e-platform-build').jobs.build;
  assert.equal(build.steps.find((step) => step.name === 'Checkout').with['persist-credentials'], false);
  assert.ok(build.steps.some((step) => /source_sha.*SOURCE_REVISION/.test(step.run ?? '')));
  for (const id of ['docker-e2e', 'auth-e2e', 'oauth-e2e']) {
    assert.equal(affected.jobs[id].with['checkout-ref'], '${{ needs.discover.outputs.checkout-ref }}');
    assert.equal(affected.jobs[id].with['cache-mode'], 'off');
    assert.deepEqual(affected.jobs[id].needs, ['discover', 'prepare']);
    assert.equal(affected.jobs[id].with['prebuilt-artifact'], 'e2e-affected-prebuilt-${{ github.run_id }}');
  }
  for (const name of ['reusable-e2e-docker', 'reusable-e2e-playwright']) {
    const called = workflow(name); const checkout = called.jobs.e2e.steps.find((step) => step.name === 'Checkout');
    assert.equal(checkout.with['persist-credentials'], false);
    assert.match(checkout.with.ref, /inputs.checkout-ref/);
    assert.ok(called.jobs.e2e.steps.some((step) => /git rev-parse HEAD/.test(step.run ?? '')));
    assert.match(called.jobs.e2e.steps.find((step) => step.name === 'Verify immutable E2E bundle source').run, /source_sha == \$sha/);
  }
  assert.ok(!ci.jobs['ci-evidence'].needs.includes('docker-e2e'));
});

// case: S-262.23
test('matrix rejects invalid suite names and malformed entries before exposing output', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'affected-plan-'));
  try {
    mkdirSync(join(dir, '.ci'));
    const output = join(dir, 'output');
    const script = workflow('e2e-affected').jobs.discover.steps.find((s) => s.name === 'Create runner matrix').run;
    const run = (selected) => {
      writeFileSync(join(dir, '.ci/e2e-test-plan.json'), JSON.stringify({ selected }));
      writeFileSync(output, '');
      return spawnSync('bash', ['-e', '-c', script], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: output }, encoding: 'utf8' });
    };
    assert.equal(run([{ runner: 'docker', suites: ['e2e-gateway', 'e2e-auth'] }]).status, 0);
    assert.match(readFileSync(output, 'utf8'), /generic=\["gateway"\]\nhas-auth=true/);
    assert.notEqual(run([{ runner: 'docker', suites: ['e2e-bad/name'] }]).status, 0);
    assert.equal(readFileSync(output, 'utf8'), '');
    assert.notEqual(run([{ runner: 'docker', suites: 'e2e-gateway' }]).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
