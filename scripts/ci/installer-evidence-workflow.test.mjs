import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = load(readFileSync(path.join(root, '.github/workflows/reusable-installer-journey.yml'), 'utf8'));

test('installer journey uploads v3 case records and relative evidence artifacts for restoration', () => {
  const upload = workflow.jobs.journey.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  const restore = workflow.jobs.coverage.steps.find(step => step.name === 'Restore journey results');

  assert.ok(upload, 'journey job uploads retained results');
  assert.match(upload.if, /always\(\)/, 'results are uploaded after a journey failure');
  for (const retainedPath of [
    '.journey/reports/service-*.json',
    '.journey/reports/installer-case-*.json',
    '.journey/reports/qa-evidence/**',
    '.journey/reports/invocations/**',
  ]) {
    assert.ok(upload.with.path.includes(retainedPath), `upload must retain ${retainedPath}`);
  }

  assert.equal(restore.with.path, '.journey/reports');
  assert.equal(restore.with['merge-multiple'], true, 'restoration keeps report-relative evidence refs resolvable');
});

test('hosted PC-001 diagnostic runs independently of the legacy release gate', () => {
  const coverage = workflow.jobs.coverage;
  const diagnosticJob = workflow.jobs.evidence_diagnostic;
  const candidate = diagnosticJob.steps.find(step => step.name === 'Restore candidate for diagnostics');
  const preparePlan = diagnosticJob.steps.find(step => step.name === 'Prepare an independent diagnostic plan');
  const diagnostic = diagnosticJob.steps.find(step => step.name === 'Evaluate hosted PC-001.2 evidence diagnostically');
  const upload = diagnosticJob.steps.find(step => step.name === 'Upload diagnostic evidence evaluation');
  const legacyGate = coverage.steps.find(step => step.name === 'Enforce local and secured release case coverage');
  assert.deepEqual(diagnosticJob.needs, ['prepare', 'journey']);
  assert.match(diagnosticJob.if, /always\(\)/);
  assert.equal(diagnosticJob['continue-on-error'], true);
  assert.equal(candidate['continue-on-error'], true);
  assert.equal(candidate.with.name, 'installer-journey-candidate');
  assert.equal(candidate.with.path, '.journey/candidate');
  assert.match(preparePlan.run, /installer-evidence-plan\.mjs/);
  assert.match(diagnostic.run, /--evidence-plan/);
  assert.match(diagnostic.run, /--level all/);
  assert.equal(diagnostic['continue-on-error'], true);
  assert.match(upload.if, /always\(\)/);
  assert.ok(!coverage.steps.some(step => step.name === 'Restore sealed candidate for independent evidence plan'));
  assert.match(legacyGate.run, /qa coverage show --level release --mode/);
  assert.doesNotMatch(legacyGate.run, /--evidence/);
});
