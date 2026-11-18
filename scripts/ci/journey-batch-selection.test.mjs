import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { test } from 'node:test';
import { batchArguments, resolveSelection } from './journey-batch-selection.mjs';
import { validateJourneyCaseDeclarations } from './journey-case-claims-preflight.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = load(readFileSync(resolve(root, '.github/workflows/journey-batch.yml'), 'utf8'));
const reuseVerdict = readFileSync(resolve(root, 'e2e/journey/reuse_case_verdict.py'), 'utf8');
const reuseOverlay = readFileSync(resolve(root, 'e2e/journey/reuse_candidate_overlay.py'), 'utf8');
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

// case: S-262.18
test('selected-case reuse dispatches skip producer and gating summary jobs', () => {
  assert.equal(workflow.on.workflow_dispatch.inputs.run_mode.default, 'full');
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.run_mode.options,
    ['full', 'reuse_candidate', 'reuse_candidate_overlay']);
  for (const job of ['producer', 'local', 'secured', 'summary']) {
    assert.match(workflow.jobs[job].if, /run_mode != 'reuse_candidate'/);
    assert.match(workflow.jobs[job].if, /run_mode != 'reuse_candidate_overlay'/);
  }
  const reuse = workflow.jobs['reuse-candidate'];
  assert.match(reuse.if, /run_mode == 'reuse_candidate'/);
  assert.match(reuse.if, /run_mode == 'reuse_candidate_overlay'/);
  assert.deepEqual(reuse.needs ?? [], [], 'reuse can only consume the explicitly selected prior run');
  assert.deepEqual(reuse.permissions, { contents: 'read', actions: 'read' });
  const checkout = reuse.steps.find((step) => step.uses?.includes('actions/checkout'));
  assert.equal(checkout.with.ref, '${{ github.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  const inputValidation = reuse.steps.find((step) => step.name === 'Validate selected candidate inputs');
  assert.match(inputValidation.run, /reuse_candidate_overlay requires distinct source and harness SHAs/);
  const checkoutTree = reuse.steps.find((step) => step.name === 'Create candidate source checkout and validate harness identity');
  assert.match(checkoutTree.run, /reuse_candidate_overlay/);
  assert.match(checkoutTree.run, /reuse_candidate_overlay\.py/);
  assert.match(checkoutTree.run, /reuse_case_verdict\.py/);
  assert.doesNotMatch(inputValidation.run, /candidate source SHA to equal the workflow harness SHA/);
  assert.ok(reuse.steps.indexOf(checkoutTree) < reuse.steps.findIndex((step) => step.name === 'Download and verify the exact candidate artifact'));
  assert.match(reuseOverlay, /merge-base/);
  assert.match(reuseOverlay, /--is-ancestor/);
  assert.match(reuseOverlay, /"diff", "--no-renames", "--raw", "-z"/);
  assert.match(reuseOverlay, /EXPECTED_DIFF/);
  assert.match(reuseOverlay, /OVERLAY_PATHS/);
  assert.match(reuseOverlay, /hash-object.*--no-filters/);
  assert.match(reuseOverlay, /binary_output=binary/);
  const sourceRun = reuse.steps.find((step) => step.name === 'Verify source run identity and result');
  assert.deepEqual(sourceRun.env, { GH_TOKEN: '${{ github.token }}' });
  assert.match(sourceRun.run, /Shared build and candidate/);
  assert.match(sourceRun.run, /candidate-artifacts/);
  const download = reuse.steps.find((step) => step.name === 'Download and verify the exact candidate artifact');
  assert.deepEqual(download.env, { GH_TOKEN: '${{ github.token }}' });
  assert.match(download.run, /actions\/artifacts\/\$artifact_id\/zip/);
  assert.match(download.run, /sha256sum/);
  assert.match(download.run, /candidate-artifact\.zip/);
  const allocation = reuse.steps.findIndex((step) => step.name === 'Allocate candidate input outside the checkout');
  assert.ok(allocation >= 0 && allocation < reuse.steps.indexOf(download));
  assert.match(reuse.steps[allocation].run, /mktemp -d "\$RUNNER_TEMP/);
  assert.match(download.run, /normalized = path\.parts/);
  assert.ok(reuse.steps.indexOf(download) < reuse.steps.findIndex((step) => step.name === 'Install workspace dependencies'),
    'candidate bytes and their API digest are checked before dependency installation');
  const verify = reuse.steps.findIndex((step) => step.name === 'Verify producer metadata');
  const overlay = reuse.steps.findIndex((step) => step.name === 'Apply the reviewed harness overlay after candidate identity checks');
  const run = reuse.steps.findIndex((step) => step.name === 'Run the selected case against the reused candidate');
  assert.ok(verify >= 0 && verify < overlay && overlay < run,
    'producer metadata, run SHA and archive digest are verified before overlay and journey execution');
  assert.match(reuse.steps[verify].run, /candidateArchiveSha256/);
  assert.match(reuse.steps[verify].run, /verify-run/);
  assert.match(reuse.steps[verify].run, /verify-candidate/);
  assert.match(reuse.steps[overlay].run, /reuse_candidate_overlay\.py overlay/);
  assert.match(reuse.steps[overlay].run, /harnessOverlayApplication/);
  assert.match(reuse.steps[run].run, /--cases "\$CASE_ID"/);
  assert.match(reuse.steps[run].run, /python3 "\$CASE_VERDICT_HELPER" "\$JOURNEY_MODE" "\$CASE_ID"/);
  assert.match(reuseVerdict, /selection_from_coverage\(coverage_results\(\), requested, mode=mode/);
  assert.match(reuseVerdict, /set\(case_run\.get\("selection", \[\]\)\) != selection/);
  assert.match(reuseVerdict, /expected = set\(selected\.get\("steps", \[\]\)\)/);
  assert.match(reuseVerdict, /metadata\.get\("result"\) != "PASS"/);
  assert.match(reuse.steps[run].run, /candidate_reused = pathlib\.Path\(extracted_run_path\)\.is_file\(\)/);
  assert.match(reuse.steps[run].run, /candidateReused=\{str\(candidate_reused\)\.lower\(\)\}/);
  assert.match(reuse.steps[run].run, /"platformReused": False/);
  assert.match(reuse.steps[run].run, /"candidateSha": sha, "harnessSha": harness_sha/);
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
