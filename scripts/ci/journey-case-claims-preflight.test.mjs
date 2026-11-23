import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateJourneyCaseDeclarations } from './journey-case-claims-preflight.mjs';

test('journey evidence helper references do not create a second case claim', () => {
  const result = validateJourneyCaseDeclarations();

  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.caseCount > 0);
  assert.ok(result.journeyClaimCount > 0);
});
