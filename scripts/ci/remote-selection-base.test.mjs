import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalRemoteBaseRef, candidateBaseRef, candidateFullFallbackReason, candidateSelectionBase } from './remote-selection-base.mjs';

test('candidate verification always selects the complete workspace', () => {
  assert.equal(candidateBaseRef({ profile: 'candidate', baseRef: 'origin/master', emptyTreeRef: 'EMPTY' }), 'EMPTY');
  for (const branch of ['agent/x231-test-strategy', 'batch/cases/S-010.1', 'verify/run/sha', 'verify-candidate/release/sha', 'master']) {
    const selection = candidateSelectionBase({ profile: 'candidate', branch, requestedBaseRef: 'origin/master', emptyTreeRef: 'EMPTY' });
    assert.equal(selection.baseRef, 'EMPTY', branch);
    assert.match(selection.fullReason, /candidate verification selects the complete workspace/);
  }
});

test('stream verification requires a base but only push verify refs can use master', () => {
  assert.throws(() => candidateBaseRef({ profile: 'stream', baseRef: '', emptyTreeRef: 'EMPTY' }), /default-branch/);
  assert.deepEqual(candidateSelectionBase({ profile: 'stream', branch: 'verify/run/sha', requestedBaseRef: 'origin/master', emptyTreeRef: 'EMPTY' }), {
    baseRef: 'origin/master', fullReason: '',
  });
  for (const [branch, requestedBaseRef] of [
    ['verify/run/sha', ''],
    ['verify/run/sha', 'origin/other'],
    ['master', 'origin/master'],
    ['release/1.0', 'origin/master'],
    ['agent/feature', 'origin/agent/j90-integration'],
  ]) {
    assert.equal(candidateSelectionBase({ profile: 'stream', branch, requestedBaseRef, emptyTreeRef: 'EMPTY' }).baseRef, 'EMPTY', `${branch} ${requestedBaseRef}`);
  }
});

test('canonical remote base resolution accepts only exact origin/master', () => {
  assert.equal(canonicalRemoteBaseRef('origin/master'), 'refs/remotes/origin/master');
  for (const ref of ['master', 'HEAD', 'origin/../master', 'refs/heads/master', 'origin/agent/j90-integration']) {
    assert.equal(canonicalRemoteBaseRef(ref), '', ref);
  }
});

test('candidate full fallback explains HEAD, empty diff, and empty affected results', () => {
  assert.match(candidateFullFallbackReason({ baseSha: 'a'.repeat(40), headSha: 'a'.repeat(40) }), /HEAD/);
  assert.match(candidateFullFallbackReason({ changedPathCount: 0 }), /diff is empty/);
  assert.match(candidateFullFallbackReason({ changedPathCount: 3, packages: [] }), /empty affected selection for a non-empty diff/);
  assert.equal(candidateFullFallbackReason({ changedPathCount: 3, packages: ['@kb-labs/core-platform'] }), '');
});
