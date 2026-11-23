import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { evidencePlan, selectLocalInstallerEvidence } from './installer-evidence-plan.mjs';
import { summarizeInstallerEvidence } from './summarize-installer-evidence.mjs';

test('plan is derived from candidate bytes and checked-in runtime policy, not evaluator host', () => {
  const bytes = Buffer.from('{"schema":"kb.create.release-index/v2"}\n');
  const policy = Buffer.from('{"requiredMajor":24,"nodeBaseImage":"node:24-bookworm"}');
  const plan = evidencePlan(bytes, policy);
  assert.equal(plan.candidateId, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  assert.deepEqual(plan.profile, { os: 'linux', runtime: 'node-24', surface: 'cli' });
  assert.throws(() => evidencePlan(Buffer.from('{}'), policy), /unsupported schema/);
  assert.throws(() => evidencePlan(bytes, Buffer.from('{"requiredMajor":"24"}')), /required Node major/);
});

test('selector returns only local v3 PC-001.2 records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qa-evidence-plan-'));
  try {
    const write = (name, run) => writeFileSync(join(directory, name), JSON.stringify({ case_run: run }));
    write('installer-case-local-cli-default.json', {
      schema: 'kb.qa-case-run/v3', mode: 'local', claims: [{ claimId: 'PC-001.2', status: 'PASS' }],
    });
    write('installer-case-secured-cli-default.json', {
      schema: 'kb.qa-case-run/v3', mode: 'secured', claims: [{ claimId: 'PC-001.2' }],
    });
    write('installer-case-local-old.json', {
      schema: 'kb.qa-case-run/v2', mode: 'local', claims: [{ claimId: 'S-001.1', status: 'PASS' }],
    });
    write('installer-case-local-missing-claim.json', {
      schema: 'kb.qa-case-run/v3', mode: 'local', selection: ['PC-001.2'], claims: [],
    });
    writeFileSync(join(directory, 'installer-case-local-empty.json'), '{}');
    writeFileSync(join(directory, 'installer-case-local-null.json'), '{"case_run":null}');
    writeFileSync(join(directory, 'installer-case-local-no-claims.json'), JSON.stringify({
      case_run: { schema: 'kb.qa-case-run/v3', mode: 'local' },
    }));
    writeFileSync(join(directory, 'installer-case-local-corrupt.json'), '{ invalid json');
    const selection = selectLocalInstallerEvidence(directory);
    assert.deepEqual(selection.records, [{ path: join(directory, 'installer-case-local-cli-default.json'), behaviorStatus: 'PASS' }]);
    assert.deepEqual(selection.invalid.map(({ path }) => path), [
      join(directory, 'installer-case-local-corrupt.json'),
      join(directory, 'installer-case-local-empty.json'),
      join(directory, 'installer-case-local-missing-claim.json'),
      join(directory, 'installer-case-local-no-claims.json'),
      join(directory, 'installer-case-local-null.json'),
    ]);
    assert.match(selection.invalid[0].reason, /JSON/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('summary unwraps the real CLI data envelope and exposes PC-001.2 PASS beside NOT RUN cells', () => {
  const result = summarizeInstallerEvidence({
    ok: true,
    data: {
      schema: 'kb.qa-case-coverage/v2', releasePassed: false,
      cases: [{ id: 'PC-001', steps: [
        { stepId: 'PC-001.2', status: 'PASS', evidenceStatus: 'COMPLETE' },
        { stepId: 'PC-001.3', status: 'NOT RUN', evidenceStatus: 'INCOMPLETE' },
      ] }],
    },
  }, { records: [{ path: 'installer-case-local-agent-commit-default.json', behaviorStatus: 'PASS' }], invalid: [] });
  assert.deepEqual(result, {
    status: 'PASS', behaviorStatus: 'PASS', evidenceStatus: 'COMPLETE', releasePassed: false,
    selectedRunRecords: ['installer-case-local-agent-commit-default.json'], observedBehaviorStatuses: ['PASS'], invalidRunRecords: [],
  });
});

test('summary preserves observed FAIL without a candidate and forces corrupted input INCOMPLETE', () => {
  const evaluation = { schema: 'kb.qa-case-coverage/v2', releasePassed: false, cases: [{ id: 'PC-001', steps: [
    { stepId: 'PC-001.2', status: 'PASS', evidenceStatus: 'COMPLETE' },
  ] }] };
  assert.equal(summarizeInstallerEvidence(undefined, { records: [], invalid: [] }).status, 'INCOMPLETE');
  const noCandidate = summarizeInstallerEvidence(undefined, {
    records: [{ path: 'installer-case-local-attempt.json', behaviorStatus: 'FAIL' }], invalid: [],
  });
  assert.equal(noCandidate.status, 'INCOMPLETE');
  assert.equal(noCandidate.behaviorStatus, 'FAIL');
  assert.equal(noCandidate.evidenceStatus, 'INCOMPLETE');
  const conflictingAttempts = summarizeInstallerEvidence(undefined, {
    records: [
      { path: 'pass.json', behaviorStatus: 'PASS' },
      { path: 'fail.json', behaviorStatus: 'FAIL' },
    ], invalid: [],
  });
  assert.equal(conflictingAttempts.behaviorStatus, 'FAIL');
  assert.deepEqual(conflictingAttempts.observedBehaviorStatuses, ['PASS', 'FAIL']);

  const corrupted = summarizeInstallerEvidence(evaluation, {
    records: [{ path: 'valid.json', behaviorStatus: 'PASS' }], invalid: [{ path: 'broken.json', reason: 'invalid JSON' }],
  });
  assert.equal(corrupted.status, 'INCOMPLETE');
  assert.equal(corrupted.evidenceStatus, 'INCOMPLETE');
  assert.equal(corrupted.releasePassed, false);
});
