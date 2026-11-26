import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareFindings, readDevkitFindings } from './devkit-baseline.mjs';

const finding = ['@kb-labs/example', 'deps', 'example/index.ts', 'inherited dependency finding'];
const newFinding = ['@kb-labs/example', 'deps', 'example/other.ts', 'new dependency finding'];
const workspace = '/runner/kb-labs';
const report = {
  ok: false,
  error: { code: 'KB_DEVKIT_STANDARDS_VIOLATIONS' },
  data: {
    ok: false,
    summary: { errors: 1, checksRun: 5, packagesChecked: 1 },
    results: [{
      package: finding[0],
      issues: [{ check: finding[1], file: `${workspace}/${finding[2]}`, message: finding[3], severity: 'error' }],
    }],
  },
};

// case: S-262.22
test('standards failure has a stable workspace-relative fingerprint', () => {
  assert.deepEqual(readDevkitFindings(report, workspace), [finding]);
  assert.doesNotThrow(() => compareFindings([finding], [finding], [finding]));
});

// case: S-262.22
test('rejects new findings and attempts to add them to the snapshot', () => {
  assert.throws(() => compareFindings([finding], [finding], [finding, newFinding]), /New findings/);
  assert.throws(() => compareFindings([finding], [finding, newFinding], [finding, newFinding]), /Unapproved snapshot/);
  assert.throws(() => compareFindings([finding], [finding], [finding, finding]), /New findings/);
});

// case: S-262.22
test('a recovered finding must be removed so it cannot return', () => {
  assert.throws(() => compareFindings([finding], [finding], []), /Remove resolved findings/);
  assert.equal(compareFindings([finding], [], []), 1);
});

// case: S-262.22
test('missing results and check execution failures cannot use the snapshot', () => {
  assert.throws(() => readDevkitFindings({}, workspace), /complete DevKit/);
  assert.throws(() => readDevkitFindings({ ...report, error: { code: 'KB_DEVKIT_CHECK_EXECUTION_FAILED' } }, workspace), /execution failed/);
  assert.throws(() => readDevkitFindings({ ...report, data: { ...report.data, results: [] } }, workspace), /complete DevKit/);
});
