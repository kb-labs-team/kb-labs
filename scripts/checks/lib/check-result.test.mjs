import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { CHECK_RESULT_FILE_ENV } from './check-result.mjs';

test('check result helper writes synchronously before immediate process exit', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kb-check-result-'));
  const resultPath = path.join(root, 'result.json');
  try {
    const source = `import { writeCheckResult } from ${JSON.stringify(new URL('./check-result.mjs', import.meta.url).href)}; writeCheckResult([{severity:'warning',message:'saved'}]); process.stdout.write('x'.repeat(204800)); process.exit(0);`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, [CHECK_RESULT_FILE_ENV]: resultPath, KB_DEVKIT_CHECK_NAME: 'fixture' },
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')).issues[0], {
      severity: 'warning', message: 'saved', check: 'fixture',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
