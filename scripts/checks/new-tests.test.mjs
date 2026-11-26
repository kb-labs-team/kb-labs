import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runExternalCheck } from './lib/run-external-check.mjs';

const script = fileURLToPath(new URL('./new-tests.mjs', import.meta.url));

test('new-tests emits the devkit external-check contract', () => {
  const env = { KB_DEVKIT_BASE_REF: 'HEAD' };
  const result = runExternalCheck(script, [], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(result.result, { issues: [] });
});

test('new-tests accepts the complete base...head diff ref from Devkit CI', () => {
  const result = runExternalCheck(script, [], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { KB_DEVKIT_BASE_REF: 'HEAD...HEAD' },
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(Array.isArray(result.result?.issues));
});
