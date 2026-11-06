import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runExternalCheck } from './lib/run-external-check.mjs';

const script = fileURLToPath(new URL('./new-tests.mjs', import.meta.url));

test('new-tests emits the devkit external-check contract', () => {
  const env = { ...process.env };
  delete env.KB_DEVKIT_BASE_REF;
  const result = runExternalCheck(script, [], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(result.result, { issues: [] });
});
