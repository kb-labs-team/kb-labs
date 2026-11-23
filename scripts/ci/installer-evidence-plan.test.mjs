import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { evidencePlan, selectLocalInstallerEvidence } from './installer-evidence-plan.mjs';

test('plan is derived from the candidate bytes and coverage runner profile', () => {
  const bytes = Buffer.from('{"schema":"kb.create.release-index/v2"}\n');
  const plan = evidencePlan(bytes, 'v24.11.1', { platform: 'linux', arch: 'x64' });
  assert.equal(plan.candidateId, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  assert.deepEqual(plan.profile, { os: 'linux-x64', runtime: 'node-24', surface: 'cli' });
  assert.throws(() => evidencePlan(Buffer.from('{}'), 'v24.11.1'), /unsupported schema/);
});

test('selector returns only local v3 PC-001.2 records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qa-evidence-plan-'));
  try {
    const write = (name, run) => writeFileSync(join(directory, name), JSON.stringify({ case_run: run }));
    write('installer-case-local-cli-default.json', {
      schema: 'kb.qa-case-run/v3', mode: 'local', claims: [{ claimId: 'PC-001.2' }],
    });
    write('installer-case-secured-cli-default.json', {
      schema: 'kb.qa-case-run/v3', mode: 'secured', claims: [{ claimId: 'PC-001.2' }],
    });
    write('installer-case-local-old.json', {
      schema: 'kb.qa-case-run/v2', mode: 'local', claims: [{ claimId: 'PC-001.2' }],
    });
    assert.deepEqual(selectLocalInstallerEvidence(directory), [join(directory, 'installer-case-local-cli-default.json')]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
