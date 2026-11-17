import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../../../.github/workflows/registry-roots-benchmark.yml', import.meta.url), 'utf8');

test('PR benchmark runs only for the exact label on same-repository PRs', () => {
  assert.match(workflow, /pull_request:\n\s+types: \[labeled\]/);
  assert.match(workflow, /github\.event\.label\.name == 'registry-roots-benchmark'/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.doesNotMatch(workflow, /^\s+push:/m);
});

test('benchmark limits hosted concurrency and does not persist checkout credentials', () => {
  assert.match(workflow, /max-parallel: 3/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(workflow, /secrets\./);
});
