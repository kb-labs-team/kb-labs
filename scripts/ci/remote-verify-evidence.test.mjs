import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { persistFailureEvidence } from './remote-verify-evidence.mjs';

test('a failing job writes its failed-step log and references the saved path in the verdict', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'remote-verify-evidence-'));
  const verdictPath = path.join(temporaryRoot, 'result.json');
  try {
    const verdict = persistFailureEvidence(verdictPath, {
      jobs: [{ name: 'Unit tests', status: 'fail', failures: ['Run unit tests'] }],
    }, [{ name: 'Unit tests', log: 'Run unit tests\nassertion failed\n' }], [
      { name: 'remote-result-unit.json', content: '{"findings":["assertion failed"]}\n' },
    ]);
    const logPath = path.join(temporaryRoot, verdict.jobs[0].evidence.logPath);
    const findingsPath = path.join(temporaryRoot, verdict.structuredFindings[0].path);
    assert.equal(existsSync(logPath), true);
    assert.equal(readFileSync(logPath, 'utf8'), 'Run unit tests\nassertion failed\n');
    assert.deepEqual(JSON.parse(readFileSync(findingsPath, 'utf8')), { findings: ['assertion failed'] });
    assert.match(verdict.jobs[0].evidence.logPath, /\.failed-logs\//);
    assert.match(verdict.structuredFindings[0].path, /\.failed-logs\//);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
