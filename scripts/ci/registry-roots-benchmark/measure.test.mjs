import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCliFailure, summarizeRootClosure, summarizeTaskRows, unwrapCliEnvelope } from './metrics.mjs';

test('unwraps the CLI envelope and validates scheduled task rows', () => {
  const payload = unwrapCliEnvelope({
    ok: true,
    status: 'success',
    data: {
      elapsed: '1s',
      summary: { scheduled: 2, passed: 2, failed: 0, cached: 1, blocked: 0, notAffected: 0 },
      results: [
        { Package: '@kb-labs/core', Task: 'build', Cached: true },
        { Package: '@kb-labs/fixture-adapter', Task: 'build', Cached: false },
      ],
    },
  });
  assert.equal(payload.summary.scheduled, 2);
  assert.deepEqual(summarizeTaskRows(payload.results), {
    task_result_rows: 2,
    cache_hits_from_task_rows: 1,
    non_cached_task_rows: 1,
    task_row_cache_hit_ratio: 0.5,
    cache_hit_status: 'partial',
    packages: ['@kb-labs/core', '@kb-labs/fixture-adapter'],
  });
});

test('fails closed on bare, unsuccessful, empty-task, and inconsistent responses', () => {
  assert.throws(() => unwrapCliEnvelope({ results: [], summary: { scheduled: 0 } }), /invalid or unsuccessful/);
  assert.throws(() => unwrapCliEnvelope({ ok: false, data: {} }), /invalid or unsuccessful/);
  assert.throws(() => unwrapCliEnvelope({ ok: true, data: { results: [], summary: { scheduled: 0 } } }), /no task results/);
  assert.throws(() => unwrapCliEnvelope({
    ok: true,
    data: { elapsed: '1s', results: [{}], summary: { scheduled: 2, blocked: 0, notAffected: 0 } },
  }), /task count mismatch/);
});

test('reports safe diagnostic context from the CLI failure envelope', () => {
  const failure = describeCliFailure({
    ok: false,
    error: {
      code: 'KB_DEVKIT_TASK_FAILED',
      message: 'Task failed with TOKEN=secret-value',
      hint: 'Retry with https://name:password@example.test and {"apiKey":"hidden"}',
    },
    data: { results: [{ Stderr: 'do not print this' }] },
  });
  assert.equal(failure, 'KB_DEVKIT_TASK_FAILED: Task failed with TOKEN=[REDACTED] — Retry with https://[REDACTED]@example.test and {"apiKey":"[REDACTED]"}');
  assert.doesNotMatch(failure, /secret-value|password|hidden|do not print this/);
});

test('marks one cache hit among many rows partial, never warm', () => {
  const summary = summarizeTaskRows([
    { Package: '@kb-labs/core', Task: 'build', Cached: true },
    { Package: '@kb-labs/fixture-adapter', Task: 'build', Cached: false },
    { Package: '@kb-labs/app', Task: 'build', Cached: false },
  ]);
  assert.equal(summary.task_row_cache_hit_ratio, 1 / 3);
  assert.equal(summary.cache_hit_status, 'partial');
});

test('reports zero and complete task-row hit coverage precisely', () => {
  assert.equal(summarizeTaskRows([{ Cached: false }]).cache_hit_status, 'no_hits');
  assert.equal(summarizeTaskRows([{ Cached: true }, { Cached: true }]).cache_hit_status, 'all_result_rows_cached');
});

test('confirms each explicit Registry root appears in actual scheduled package results', () => {
  assert.deepEqual(summarizeRootClosure(['@kb-labs/a'], ['@kb-labs/a', '@kb-labs/dependency']), {
    requested_root_count: 1,
    requested_roots_present_in_results: 1,
    dependency_closure_package_count: 1,
    dependency_closure_packages: ['@kb-labs/dependency'],
    missing_roots: [],
  });
  assert.throws(() => summarizeRootClosure(['@kb-labs/missing'], ['@kb-labs/dependency']), /absent from actual/);
});
