import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./aggregate.mjs', import.meta.url));
const baselineSha = '1'.repeat(40);
const candidateSha = '2'.repeat(40);
const harnessSha = '3'.repeat(40);
const modes = ['in-process', 'subprocess', 'worker-pool'];
function modeReport(mode, side, repeat) {
  const baseline = side === 'baseline';
  const p50 = baseline ? 10 : 20;
  const throughput = baseline
    ? [{ concurrency: 1, completed: 1000, failures: 0, duration_seconds: 10, calls_per_second: 100 }, { concurrency: 8, completed: 2000, failures: 0, duration_seconds: 10, calls_per_second: 200 }]
    : [{ concurrency: 1, completed: 1250, failures: 0, duration_seconds: 10, calls_per_second: 125 }, { concurrency: 8, completed: 2500, failures: 0, duration_seconds: 10, calls_per_second: 250 }];
  const executions = 631 + throughput.reduce((sum, row) => sum + row.completed, 0);
  return {
    mode,
    correctness: 'passed',
    workload_classification: 'ctx-ipc-microbenchmark',
    executions,
    host_calls: executions,
    host_call_sequence_coverage: { unique_sequences: executions, first_sequence: 0, last_sequence: executions - 1 },
    cold_first_execute_ms: baseline ? 100 + repeat : 110 + repeat,
    warm_latency: { count: 500, p50_ms: p50, p95_ms: p50 * 2, p99_ms: p50 * 3 },
    warm_latency_samples_ms: [
      ...Array(249).fill(p50 / 2),
      ...Array(225).fill(p50),
      ...Array(20).fill(p50 * 2),
      ...Array(6).fill(p50 * 3),
    ],
    throughput,
    reliability: { soak_calls: 100, failures: 0, final_health: { healthy: true }, backend_stats: { totalExecutions: executions, successCount: executions, errorCount: 0 } },
    rss: {
      sampled_peak_process_tree_rss_lower_bound_bytes: baseline ? 100 * 1024 * 1024 : 120 * 1024 * 1024,
      child_rss_status: mode === 'in-process' ? 'not_applicable_in_process' : mode === 'worker-pool' ? 'sampled_lower_bound' : 'unmeasurable_no_child_sampled',
      sampled_peak_child_rss_lower_bound_bytes: mode === 'worker-pool' ? (baseline ? 40 : 50) * 1024 * 1024 : null,
      process_count_after_shutdown: 1,
      child_process_samples: mode === 'worker-pool' ? 10 : 0,
      peak_child_process_count_observed: mode === 'worker-pool' ? 1 : 0,
    },
  };
}
function sourceReport(side, repeat) {
  const shift = (repeat - 1) % modes.length;
  const modeOrder = [...modes.slice(shift), ...modes.slice(0, shift)];
  const sourceSha = side === 'baseline' ? baselineSha : candidateSha;
  return {
    schema: 'kb.plugin-execution-benchmark.v1', stage: 'fast', workload_classification: 'ctx-ipc-microbenchmark',
    source_sha: sourceSha, harness_sha: harnessSha, repeat, node_version: 'v24.0.0', runner_image: 'ubuntu-26.04',
    mode_order: modeOrder, fixture: { version: 1, context_padding_bytes: 4096, host_call: 'cache.get benchmark:marker:<sequence>' },
    modes: modeOrder.map(mode => modeReport(mode, side, repeat)),
  };
}
function makePair(repeat) {
  const baseline = sourceReport('baseline', repeat);
  const candidate = sourceReport('candidate', repeat);
  return {
    schema: 'kb.plugin-execution-paired-benchmark.v1', baseline_sha: baselineSha, candidate_sha: candidateSha,
    harness_sha: harnessSha, repeat, mode_order: baseline.mode_order,
    measurement_order: repeat % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline'],
    baseline, candidate,
  };
}
function runAggregate(pairs) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'plugin-bench-aggregate-'));
  const inputDir = path.join(cwd, 'pairs');
  mkdirSync(inputDir);
  pairs.forEach((pair, index) => writeFileSync(path.join(inputDir, `repeat-${index + 1}.json`), JSON.stringify(pair)));
  const result = spawnSync(process.execPath, [script], {
    cwd, encoding: 'utf8',
    env: { ...process.env, BENCH_INPUT_DIR: inputDir, BENCH_BASELINE_SHA: baselineSha, BENCH_CANDIDATE_SHA: candidateSha, BENCH_HARNESS_SHA: harnessSha },
  });
  return { cwd, result };
}

test('aggregator validates five paired reports and emits correct medians and direction metadata', () => {
  const { cwd, result } = runAggregate([1, 2, 3, 4, 5].map(makePair));
  try {
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(readFileSync(path.join(cwd, '.benchmark/plugin-execution-benchmark/summary.json'), 'utf8'));
    assert.equal(summary.schema, 'kb.plugin-execution-benchmark-summary.v1');
    assert.equal(summary.workload_classification, 'ctx-ipc-microbenchmark');
    assert.equal(summary.repeats, 5);
    const p50 = summary.rows.find(row => row.mode === 'subprocess' && row.metric === 'warm p50 ms');
    assert.equal(p50.baseline_median, 10);
    assert.equal(p50.candidate_median, 20);
    assert.equal(p50.candidate_over_baseline_median_ratio, 2);
    assert.equal(p50.higher_is_better, false);
    const throughput = summary.rows.find(row => row.mode === 'worker-pool' && row.metric === 'verified workload throughput c=1 calls/s');
    assert.equal(throughput.candidate_over_baseline_median_ratio, 1.25);
    assert.equal(throughput.higher_is_better, true);
    const workerRss = summary.rows.find(row => row.mode === 'worker-pool' && row.metric === 'sampled child RSS lower-bound MiB');
    assert.equal(workerRss.baseline_median, 40);
    assert.equal(workerRss.candidate_median, 50);
    assert.equal(workerRss.candidate_over_baseline_median_ratio, 1.25);
    const subprocessRss = summary.rows.find(row => row.mode === 'subprocess' && row.metric === 'sampled child RSS lower-bound MiB');
    assert.equal(subprocessRss.baseline_median, null);
    assert.equal(subprocessRss.measurement_status, 'unmeasurable_no_child_sampled');
    const rss = summary.rows.find(row => row.mode === 'in-process' && row.metric.includes('RSS lower-bound'));
    assert.equal(rss.baseline_median, 100);
    assert.equal(rss.candidate_median, 120);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('aggregator rejects an absent plugin mode and emits no comparison summary', () => {
  const pairs = [1, 2, 3, 4, 5].map(makePair);
  pairs[2].candidate.modes.pop();
  const { cwd, result } = runAggregate(pairs);
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /incomplete candidate modes/);
    assert.throws(() => readFileSync(path.join(cwd, '.benchmark/plugin-execution-benchmark/summary.json')));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const [label, mutate, expectedError] of [
  ['counter mismatch', pair => { pair.candidate.modes[0].host_calls--; }, /counters disagree/],
  ['percentile mismatch', pair => { pair.candidate.modes[0].warm_latency.p95_ms++; }, /raw samples/],
  ['throughput execution count mismatch', pair => { pair.candidate.modes[0].executions++; pair.candidate.modes[0].host_calls++; pair.candidate.modes[0].reliability.backend_stats.totalExecutions++; pair.candidate.modes[0].reliability.backend_stats.successCount++; }, /counters disagree/],
  ['worker child RSS unobserved', pair => {
    const result = pair.candidate.modes.find(item => item.mode === 'worker-pool');
    result.rss.child_rss_status = 'unmeasurable_no_child_sampled';
    result.rss.sampled_peak_child_rss_lower_bound_bytes = null;
    result.rss.child_process_samples = 0;
    result.rss.peak_child_process_count_observed = 0;
  }, /worker-pool child RSS was not observed/],
]) {
  test(`aggregator rejects ${label}`, () => {
    const pairs = [1, 2, 3, 4, 5].map(makePair);
    mutate(pairs[0]);
    const { cwd, result } = runAggregate(pairs);
    try {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expectedError);
      assert.throws(() => readFileSync(path.join(cwd, '.benchmark/plugin-execution-benchmark/summary.json')));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
