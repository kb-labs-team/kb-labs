import assert from 'node:assert/strict';
import test from 'node:test';
import { candidateBaseRef, candidateIntegrationBase } from './remote-selection-base.mjs';

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
