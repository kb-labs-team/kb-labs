import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { test } from 'node:test';
import { batchArguments, resolveSelection } from './journey-batch-selection.mjs';
import { isTrustedJourneyCacheInvocation, journeyCacheScope } from './resolve-journey-cache-scope.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = load(readFileSync(resolve(root, '.github/workflows/journey-batch.yml'), 'utf8'));
const encode = (ids) => Buffer.from(ids).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

// case: S-262.8
test('every trigger of the journey batch workflow resolves to an explicit selection', () => {
  const events = Object.keys(workflow.on);
  assert.ok(events.length > 0);
  for (const event of events) {
    const ref = event === 'push' ? 'batch/tag' : 'refs/pull/1/merge';
    const selection = resolveSelection(event, ref);
    assert.ok(selection === 'full' || /^cases:.+/.test(selection), `${event} -> ${selection}`);
  }
});

// case: S-262.8
test('a pushed cases ref yields its decoded non-empty case list; other batch refs run the full gating batch', () => {
  const ids = 'S-010,S-027.1';
  const selection = resolveSelection('push', `batch/t1/cases/${encode(ids)}`);
  assert.deepEqual(batchArguments(selection), ['--cases', ids]);
  assert.deepEqual(batchArguments(resolveSelection('push', 'batch/plain')), []);
});

// case: S-262.8
test('PR and dispatch run the full gating batch, never an empty --cases', () => {
  for (const event of ['pull_request', 'workflow_dispatch']) {
    assert.equal(resolveSelection(event, 'any'), 'full');
    assert.deepEqual(batchArguments('full'), []);
  }
});

// case: S-262.8
test('an undeclared trigger and an empty encoded selection are refused', () => {
  assert.throws(() => resolveSelection('schedule', 'x'), /no declared case selection for trigger "schedule"/);
  assert.throws(() => resolveSelection('push', `batch/t/cases/${encode('  ')}`), /empty case selection/);
  assert.throws(() => batchArguments(''), /unknown journey batch selection/);
});

// case: S-262.8
test('consumer jobs take the selection only from the producer-owned output', () => {
  for (const job of ['local', 'secured']) {
    const run = workflow.jobs[job].steps.map((step) => step.run ?? '').join('\n');
    assert.match(run, /journey-batch-selection\.mjs run "\$BATCH_SELECTION" --/);
    assert.doesNotMatch(run, /--cases|base64/);
  }
  assert.match(JSON.stringify(workflow.jobs.producer.steps), /journey-batch-selection\.mjs resolve/);
});

test('journey batch concurrency cancels stale runs only within the same ref', () => {
  const group = workflow.concurrency.group;
  assert.equal(workflow.concurrency['cancel-in-progress'], true);
  assert.match(group, /\$\{\{\s*github\.ref\s*\}\}/);
  const groupForRef = (ref) => group.replace(/\$\{\{\s*github\.ref\s*\}\}/, ref);

  assert.equal(groupForRef('refs/heads/batch/one'), groupForRef('refs/heads/batch/one'));
  assert.notEqual(groupForRef('refs/heads/batch/one'), groupForRef('refs/heads/batch/two'));
});

test('journey cache scope disables caching without an exact checkout and resolved base', () => {
  const commit = 'c'.repeat(40);
  const base = 'b'.repeat(40);
  assert.deepEqual(journeyCacheScope({ checkoutSha: commit, workflowSha: commit, baseSha: base, cacheAllowed: true }), {
    mode: 'read-write',
    scope: `journey-${base}`,
    sha: commit,
  });
  assert.deepEqual(journeyCacheScope({ checkoutSha: commit, workflowSha: commit, baseSha: '', cacheAllowed: true }), {
    mode: 'off',
    scope: 'uncacheable',
    sha: commit,
  });
  assert.deepEqual(journeyCacheScope({ checkoutSha: 'd'.repeat(40), workflowSha: commit, baseSha: base, cacheAllowed: true }), {
    mode: 'off',
    scope: 'uncacheable',
    sha: 'd'.repeat(40),
  });
  assert.notEqual(
    journeyCacheScope({ checkoutSha: commit, workflowSha: commit, baseSha: base, cacheAllowed: true }).scope,
    journeyCacheScope({ checkoutSha: commit, workflowSha: commit, baseSha: 'a'.repeat(40), cacheAllowed: true }).scope,
  );
  assert.equal(journeyCacheScope({ checkoutSha: commit, workflowSha: commit, baseSha: base, cacheAllowed: false }).mode, 'off');
});

test('journey cache trust excludes PR and reusable callers', () => {
  const identity = {
    eventName: 'push',
    workflowRef: 'kb-labs-team/kb-labs/.github/workflows/journey-batch.yml@refs/heads/batch/run',
    repository: 'kb-labs-team/kb-labs',
    ref: 'refs/heads/batch/run',
  };
  assert.equal(isTrustedJourneyCacheInvocation(identity), true);
  assert.equal(isTrustedJourneyCacheInvocation({ ...identity, eventName: 'pull_request' }), false);
  assert.equal(isTrustedJourneyCacheInvocation({ ...identity, workflowRef: 'kb-labs-team/kb-labs/.github/workflows/release-build-candidate.yml@refs/heads/develop' }), false);
});

test('journey producer is the sole CAS writer and saves its exact checked-out build', () => {
  const producer = workflow.jobs.producer;
  const checkout = producer.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  const scope = producer.steps.find((step) => step.id === 'cas-scope');
  const cache = producer.steps.find((step) => step.uses === './.github/actions/devkit-cas');
  const build = producer.steps.find((step) => step.name === 'Produce shared build and candidate');
  const upload = producer.steps.find((step) => step.with?.name === 'journey-build-candidate');

  assert.equal(checkout.with.ref, '${{ github.sha }}');
  assert.ok(scope);
  assert.ok(producer.steps.indexOf(scope) < producer.steps.indexOf(cache));
  assert.ok(producer.steps.indexOf(cache) < producer.steps.indexOf(build));
  assert.equal(cache.with.mode, '${{ steps.cas-scope.outputs.mode }}');
  assert.equal(cache.with.scope, '${{ steps.cas-scope.outputs.scope }}');
  assert.equal(producer.steps.filter((step) => step.uses === './.github/actions/devkit-cas').length, 1);
  assert.ok(producer.steps.indexOf(upload) > producer.steps.indexOf(build));
  assert.equal(upload.with.path, '${{ env.BATCH_PRODUCER_OUTPUT }}');
});
