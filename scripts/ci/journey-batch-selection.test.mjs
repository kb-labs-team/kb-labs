import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { test } from 'node:test';
import { batchArguments, resolveSelection, selectionIds, sharedUnitSuiteMode } from './journey-batch-selection.mjs';
import { validateJourneyCaseDeclarations } from './journey-case-claims-preflight.mjs';

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
    assert.ok(selection === 'full' || /^cases:.+/.test(selection) || /^area:[a-z][a-z0-9-]*$/.test(selection), `${event} -> ${selection}`);
  }
});

// case: S-262.8
test('a pushed cases ref yields its decoded non-empty case list; other batch refs run the full gating batch', () => {
  const ids = 'S-010,S-027.1';
  const selection = resolveSelection('push', `batch/t1/cases/${encode(ids)}`);
  assert.deepEqual(batchArguments(selection), ['--cases', ids]);
  assert.equal(selectionIds(selection), ids);
  assert.deepEqual(batchArguments(resolveSelection('push', 'batch/plain')), []);
  assert.equal(selectionIds('full'), '');
});

// case: S-262.18
test('a pushed area ref selects that QA catalog area as a partial run', () => {
  const selection = resolveSelection('push', 'batch/t1/areas/marketplace');
  assert.equal(selection, 'area:marketplace');
  assert.deepEqual(batchArguments(selection), ['--area', 'marketplace']);
  assert.equal(selectionIds(selection), '@area:marketplace');
  assert.equal(sharedUnitSuiteMode(selection), 'skip');
  assert.equal(sharedUnitSuiteMode(resolveSelection('push', 'batch/t1/areas/studio')),
    'skip');
});

// case: S-262.8
test('manual dispatch uses the full batch and a PR cannot start it', () => {
  assert.equal(resolveSelection('workflow_dispatch', 'any'), 'full');
  assert.deepEqual(batchArguments('full'), []);
  assert.throws(() => resolveSelection('pull_request', 'any'), /no declared case selection/);
});

test('full journey runs use independent concurrency groups without a PR trigger', () => {
  assert.equal(workflow.concurrency.group, 'journey-batch-${{ github.run_id }}');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.on.pull_request, undefined);
});

// case: S-262.21
test('ordinary PRs run only affected Journey and release keeps the installer matrix', () => {
  const pullRequest = load(readFileSync(resolve(root, '.github/workflows/journey-pr.yml'), 'utf8'));
  const installer = load(readFileSync(resolve(root, '.github/workflows/installer-journey.yml'), 'utf8'));
  const release = load(readFileSync(resolve(root, '.github/workflows/release-build-candidate.yml'), 'utf8'));
  assert.deepEqual(pullRequest.on.pull_request, { branches: ['master'] });
  assert.equal(pullRequest.defaults.run.shell, 'bash');
  assert.equal(pullRequest.jobs['baseline-delta'].name, 'Journey baseline delta');
  assert.equal(pullRequest.jobs['baseline-delta'].if, 'always()');
  assert.deepEqual(Object.keys(installer.on), ['workflow_dispatch']);
  assert.equal(release.jobs['journey-gate'].uses, './.github/workflows/reusable-installer-journey.yml');
});

// case: S-262.8
test('only an explicit case selection skips the shared generic unit suite', () => {
  const targeted = resolveSelection('push', `batch/t1/cases/${encode('S-268.1')}`);
  assert.equal(sharedUnitSuiteMode(targeted), 'skip');
  for (const selection of [
    resolveSelection('push', 'batch/plain'),
    resolveSelection('workflow_dispatch', 'main'),
  ]) {
    assert.equal(sharedUnitSuiteMode(selection), 'run');
  }
  assert.throws(() => sharedUnitSuiteMode(''), /unknown journey batch selection/);
  assert.throws(() => sharedUnitSuiteMode(`cases:${encode('  ')}`), /unknown journey batch selection/);
});

// case: S-262.8
test('an undeclared trigger and an empty encoded selection are refused', () => {
  assert.throws(() => resolveSelection('schedule', 'x'), /no declared case selection for trigger "schedule"/);
  assert.throws(() => resolveSelection('push', `batch/t/cases/${encode('  ')}`), /empty case selection/);
  assert.throws(() => resolveSelection('push', 'batch/t/areas/Marketplace'), /invalid or empty product area/);
  assert.throws(() => batchArguments('area:Bad'), /unknown journey batch selection/);
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
  const prepare = workflow.jobs.producer.steps.find((step) => step.name === 'Produce shared build and candidate');
  assert.equal(prepare.env?.BATCH_SELECTION, '${{ steps.selection.outputs.selection }}');
});

// case: S-262.17
test('summary job decodes the producer-owned selection for missing mode artifacts', () => {
  const summary = workflow.jobs.summary;
  assert.equal(summary.env.BATCH_SELECTION, '${{ needs.producer.outputs.selection }}');
  const run = summary.steps.map((step) => step.run ?? '').join('\n');
  assert.match(run, /journey-batch-selection\.mjs ids "\$BATCH_SELECTION"/);
  assert.match(run, /batch\.sh summarize .*--selection "\$selection_ids"/);
});

test('batch producer runs the dist-free journey preflight before producing build artifacts', () => {
  const steps = workflow.jobs.producer.steps;
  const dependencies = steps.findIndex((step) => step.name === 'Install workspace dependencies');
  const preflight = steps.findIndex((step) => step.name === 'Run journey static preflight');
  const producerBuild = steps.findIndex((step) => step.name === 'Produce shared build and candidate');

  assert.ok(dependencies >= 0, 'the batch producer installs workspace dependencies');
  assert.ok(preflight >= 0, 'the batch producer runs the journey preflight');
  assert.ok(dependencies < preflight, 'the preflight can use the installed workspace toolchain');
  assert.ok(preflight < producerBuild, 'the preflight runs before the producer build stage');
  assert.equal(steps[preflight].run, 'bash e2e/journey/static-preflight.sh');
});

test('journey case preflight uses the QA scanner to reject dynamic cases declarations', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'journey-case-preflight-'));
  try {
    const scenarios = resolve(fixture, 'docs/qa/scenarios');
    const journey = resolve(fixture, 'e2e/journey');
    mkdirSync(scenarios, { recursive: true });
    mkdirSync(journey, { recursive: true });
    writeFileSync(resolve(scenarios, 'S-001-fixture.md'), [
      '---',
      'id: S-001',
      'title: Fixture',
      'persona: solo-developer',
      'area: journey',
      'priority: P1',
      'status: active',
      'release: false',
      'modes: [local]',
      'surfaces: [cli]',
      '---',
      '',
      '## Goal',
      'Exercise the journey declaration scanner.',
      '',
      '## Steps',
      '| # | Action | Expected |',
      '|---|---|---|',
      '| S-001.1 | Run the check | The declaration is reported |',
      '',
    ].join('\n'));
    writeFileSync(resolve(journey, 'secured_execution_steps.py'), [
      'case_ids = ["S-001.1"]',
      'journey.step("dynamic claim", "auth", check, cases=case_ids)',
      '',
    ].join('\n'));

    const result = validateJourneyCaseDeclarations(fixture);
    assert.equal(result.diagnostics.length, 1);
    assert.match(result.diagnostics[0].file, /secured_execution_steps\.py$/);
    assert.equal(result.diagnostics[0].message,
      'case claim outside a literal cases=[...]; the validator cannot see it');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
