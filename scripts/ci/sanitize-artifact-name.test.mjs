import test from 'node:test';
import assert from 'node:assert/strict';
import { journeyArtifactName, sanitizeArtifactComponent } from './sanitize-artifact-name.mjs';

test('journey artifact names sanitize all matrix components', () => {
  assert.equal(journeyArtifactName('ubuntu-latest', 'service-local:explore'),
    'service-journey-results-ubuntu-latest-service-local-explore');
  assert.equal(journeyArtifactName('macos-latest', 'runner|scenario/variant'),
    'service-journey-results-macos-latest-runner-scenario-variant');
  assert.equal(sanitizeArtifactComponent('***'), 'unknown');
});
