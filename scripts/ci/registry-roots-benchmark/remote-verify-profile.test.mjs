import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workflow = load(readFileSync(path.join(root, '.github/workflows/remote-verify.yml'), 'utf8'));
const benchmarkProfile = "github.event_name == 'workflow_dispatch' && github.event.inputs.profile == 'benchmark'";
const excludesBenchmark = `!(github.event_name == 'workflow_dispatch' && github.event.inputs.profile == 'benchmark')`;

test('remote-verify exposes benchmark without changing stream and candidate profiles', () => {
  const profile = workflow.on.workflow_dispatch.inputs.profile;
  assert.deepEqual(profile.options, ['stream', 'candidate', 'benchmark']);
  assert.equal(profile.default, 'candidate');
  assert.equal(workflow.on.push.branches[0], 'verify/**');
});

test('benchmark dispatch runs only the isolated build matrix, not verification stages', () => {
  const jobs = workflow.jobs;
  assert.equal(jobs['registry-roots-benchmark'].if, benchmarkProfile);
  for (const jobName of ['prepare', 'build', 'independent-test-shards', 'build-dependent-test-shards', 'internal-tool-test-shards', 'verdict']) {
    assert.ok(jobs[jobName].if.includes(excludesBenchmark), `${jobName} must skip benchmark dispatches`);
  }
  assert.equal(jobs['registry-roots-benchmark'].strategy['max-parallel'], 3);
  assert.deepEqual(jobs['registry-roots-benchmark'].strategy.matrix.strategy, ['affected', 'registry-roots']);
  assert.deepEqual(jobs['registry-roots-benchmark'].strategy.matrix.cache, ['cold', 'warm']);
  assert.deepEqual(jobs['registry-roots-benchmark'].strategy.matrix.repeat, [1, 2, 3]);
});

test('benchmark checks out the dispatch SHA with read-only permissions and no restored DevKit CAS', () => {
  const job = workflow.jobs['registry-roots-benchmark'];
  const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(job.env.BENCH_SOURCE_SHA, '${{ github.sha }}');
  assert.match(job.env.BENCH_OUTPUT, /^\.benchmark\/registry-roots-benchmark\//);
  assert.doesNotMatch(JSON.stringify(job.env), /runner\.temp/);
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.permissions.actions, 'read');
  assert.ok(!job.steps.some(step => step.uses === './.github/actions/devkit-cas'));
  assert.ok(!job.steps.some(step => /deploy|publish/i.test(step.name ?? '')));
  assert.doesNotMatch(JSON.stringify(job), /secrets\./);
});
