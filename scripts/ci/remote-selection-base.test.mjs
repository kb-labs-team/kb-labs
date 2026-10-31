import assert from 'node:assert/strict';
import test from 'node:test';
import { candidateBaseRef, candidateFullFallbackReason, candidateIntegrationBase, candidateSelectionBase } from './remote-selection-base.mjs';

test('candidate agent stream uses the integration base while unbased candidates stay full', () => {
  assert.equal(candidateBaseRef({ profile: 'candidate', baseRef: 'origin/agent/j90-integration', emptyTreeRef: 'EMPTY' }), 'origin/agent/j90-integration');
  assert.equal(candidateBaseRef({ profile: 'candidate', baseRef: '', emptyTreeRef: 'EMPTY' }), 'EMPTY');
});

test('stream verification requires its configured default-branch base', () => {
  assert.throws(() => candidateBaseRef({ profile: 'stream', baseRef: '', emptyTreeRef: 'EMPTY' }), /default-branch/);
});

test('only agent work branches select the integration base', () => {
  assert.equal(candidateIntegrationBase('agent/x231-test-strategy'), 'origin/agent/j90-integration');
  assert.equal(candidateIntegrationBase('agent/j90-integration'), '');
  assert.equal(candidateIntegrationBase('master'), '');
  assert.equal(candidateIntegrationBase('release/1.0'), '');
});

test('candidate ref eligibility rejects protected and non-agent refs regardless of a supplied base', () => {
  for (const branch of ['agent/j90-integration', 'master', 'release/1.0', 'feature/other']) {
    const decision = candidateSelectionBase({ branch, requestedBaseRef: 'origin/agent/j90-integration', emptyTreeRef: 'EMPTY' });
    assert.equal(decision.baseRef, 'EMPTY', branch);
    assert.match(decision.fullReason, /full: ref .* is not an eligible agent stream ref/, branch);
  }
  assert.deepEqual(candidateSelectionBase({
    branch: 'agent/x231-test-strategy', requestedBaseRef: 'origin/agent/j90-integration', emptyTreeRef: 'EMPTY',
  }), { baseRef: 'origin/agent/j90-integration', fullReason: '' });
  assert.equal(candidateSelectionBase({
    branch: 'agent/x231-test-strategy', requestedBaseRef: 'HEAD', emptyTreeRef: 'EMPTY',
  }).baseRef, 'EMPTY');
});

test('candidate full fallback explains HEAD, empty diff, and empty affected results', () => {
  assert.match(candidateFullFallbackReason({ baseSha: 'a'.repeat(40), headSha: 'a'.repeat(40) }), /HEAD/);
  assert.match(candidateFullFallbackReason({ changedPathCount: 0 }), /diff is empty/);
  assert.match(candidateFullFallbackReason({ changedPathCount: 3, packages: [] }), /empty affected selection for a non-empty diff/);
  assert.equal(candidateFullFallbackReason({ changedPathCount: 3, packages: ['@kb-labs/core-platform'] }), '');
});
