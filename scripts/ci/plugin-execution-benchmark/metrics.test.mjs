import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCorrectResult, digest } from './correctness.mjs';
import { median, percentiles } from './stats.mjs';

test('percentiles sort a copy and use nearest-rank indices', () => {
  const samples = [5, 1, 4, 2, 3];
  assert.deepEqual(percentiles(samples), { count: 5, p50_ms: 3, p95_ms: 5, p99_ms: 5 });
  assert.deepEqual(samples, [5, 1, 4, 2, 3]);
});

test('median supports paired ratios and validates empty/non-finite input', () => {
  assert.equal(median([1.2, 0.8, 1.0, 1.4, 0.9]), 1.0);
  assert.throws(() => median([]), /non-empty/);
  assert.throws(() => median([1, Number.NaN]), /finite/);
});

test('correctness compares nested objects independent of key order and catches changed values', () => {
  const expected = { requestId: 'r1', identity: { pluginId: 'p1', host: 'cli' }, sequence: 4 };
  const equivalent = { sequence: 4, identity: { host: 'cli', pluginId: 'p1' }, requestId: 'r1' };
  assert.equal(assertCorrectResult(equivalent, expected), digest(expected));
  assert.throws(() => assertCorrectResult({ ...equivalent, sequence: 5 }, expected), /does not match/);
});
