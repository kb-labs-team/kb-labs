import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './remote-verify-options.mjs';

// case: S-262.6
test('requires an explicit verdict path and resolves it from the invoking directory', () => {
  assert.deepEqual(parseArgs(['stream-name', '--out', '../reports/result.json'], '/work/tree'), {
    stream: 'stream-name',
    attach: undefined,
    profile: 'stream',
    out: '/work/reports/result.json',
  });
  assert.equal(parseArgs(['stream-name', '--profile', 'candidate', '--out', '/tmp/candidate.json']).profile, 'candidate');
  assert.throws(() => parseArgs(['stream-name'], '/work/tree'), /--out path is required/);
});

// case: S-262.6
test('accepts an existing run or verification ref without a stream name', () => {
  assert.equal(parseArgs(['--attach', '40194225801', '--out', '/tmp/result.json']).attach, '40194225801');
  assert.equal(parseArgs(['--attach', 'verify/stream/20261025T120000Z-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '--out', '/tmp/result.json']).attach.startsWith('verify/'), true);
  assert.throws(() => parseArgs(['stream', '--attach', '17', '--out', '/tmp/result.json']), /exactly one/);
});
