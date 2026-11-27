import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  const compute = coverage.steps.find(step => step.name === 'Compute and validate full local and secured case coverage');
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
  assert.equal(compute.env.KB_PLATFORM_ROOT, '${{ github.workspace }}');
  assert.match(compute.run, /qa coverage show --level all --mode/);
  assert.doesNotMatch(compute.run, /--evidence/);
  assert.match(legacyGate.run, /jq -e '\.releasePassed == true'/);
});

// case: S-261.3
test('installer coverage collects completed evidence after another runner crashes', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'installer-coverage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reports = path.join(directory, '.journey/reports');
  const cli = path.join(directory, 'cli/bin/dist');
  mkdirSync(reports, { recursive: true });
  mkdirSync(cli, { recursive: true });
  writeFileSync(path.join(reports, 'service-local.json'), JSON.stringify({
    schema: 'kb.service-journey/v1', status: 'FAIL', steps: [{ name: 'runner crash', status: 'FAIL' }],
  }));
  writeFileSync(path.join(reports, 'service-secured.json'), JSON.stringify({
    schema: 'kb.service-journey/v1', case_run: { schema: 'kb.qa-case-run/v2', mode: 'secured', claims: [] },
  }));
  writeFileSync(path.join(cli, 'bin.js'), `
    const args = process.argv.slice(2);
    if (args[args.indexOf('--run') + 1] !== '.journey/reports/service-secured.json') process.exit(1);
    const mode = args[args.indexOf('--mode') + 1];
    console.log(JSON.stringify({ ok: true, data: { schema: 'kb.qa-case-coverage/v1', mode, cases: [], releasePassed: false } }));
  `);

  const compute = workflow.jobs.coverage.steps.find(step => step.name === 'Compute and validate full local and secured case coverage');
  const run = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', compute.run], { cwd: directory, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /no claim evidence.*service-local\.json/i);
  for (const mode of ['local', 'secured']) {
    const report = JSON.parse(readFileSync(path.join(reports, `case-coverage/case-coverage-${mode}.json`), 'utf8'));
    assert.equal(report.mode, mode);
    assert.equal(report.releasePassed, false);
  }
});
