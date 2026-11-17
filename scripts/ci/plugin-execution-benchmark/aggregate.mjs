import { median, percentiles } from './stats.mjs';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const inputDir = process.env.BENCH_INPUT_DIR ?? '.benchmark/plugin-execution-benchmark/pairs';
const baselineSha = process.env.BENCH_BASELINE_SHA;
const candidateSha = process.env.BENCH_CANDIDATE_SHA;
const harnessSha = process.env.BENCH_HARNESS_SHA;
if (!/^[a-f0-9]{40}$/i.test(baselineSha ?? '') || !/^[a-f0-9]{40}$/i.test(candidateSha ?? '') || !/^[a-f0-9]{40}$/i.test(harnessSha ?? '')) throw new Error('benchmark summary requires full provenance SHAs');
const files = readdirSync(inputDir).filter(name => /^repeat-\d+\.json$/.test(name)).sort();
if (files.length !== 5) throw new Error(`expected exactly five paired artifacts, found ${files.length}`);
const pairs = files.map(name => JSON.parse(readFileSync(path.join(inputDir, name), 'utf8')));
if (baselineSha === candidateSha) throw new Error('baseline and candidate SHAs must differ');
const expectedRepeats = [1, 2, 3, 4, 5];
for (let i = 0; i < pairs.length; i++) {
  const pair = pairs[i];
  if (pair.schema !== 'kb.plugin-execution-paired-benchmark.v1' || pair.repeat !== expectedRepeats[i]) throw new Error(`invalid pair artifact ${files[i]}`);
  if (pair.baseline_sha !== baselineSha || pair.candidate_sha !== candidateSha || pair.harness_sha !== harnessSha) throw new Error(`SHA provenance mismatch in ${files[i]}`);
  const expectedOrder = pair.repeat % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
  const expectedModes = ['in-process', 'subprocess', 'worker-pool'];
  const modeShift = (pair.repeat - 1) % expectedModes.length;
  const rotatedModes = [...expectedModes.slice(modeShift), ...expectedModes.slice(0, modeShift)];
  if (JSON.stringify(pair.measurement_order) !== JSON.stringify(expectedOrder)) throw new Error(`revision order mismatch in ${files[i]}`);
  if (JSON.stringify(pair.mode_order) !== JSON.stringify(rotatedModes) || JSON.stringify(pair.baseline.mode_order) !== JSON.stringify(pair.candidate.mode_order) || JSON.stringify(pair.mode_order) !== JSON.stringify(pair.baseline.mode_order)) throw new Error(`mode order mismatch in ${files[i]}`);
  if (pair.baseline.runner_image !== pair.candidate.runner_image || pair.baseline.node_version !== pair.candidate.node_version || JSON.stringify(pair.baseline.fixture) !== JSON.stringify(pair.candidate.fixture)) throw new Error(`runner/tooling/fixture mismatch in ${files[i]}`);
  for (const side of ['baseline', 'candidate']) {
    const report = pair[side];
    if (report.source_sha !== (side === 'baseline' ? baselineSha : candidateSha)) throw new Error(`wrong source SHA in ${files[i]} ${side}`);
    if (report.harness_sha !== harnessSha || report.repeat !== pair.repeat) throw new Error(`harness/repeat mismatch in ${files[i]} ${side}`);
    if (report.schema !== 'kb.plugin-execution-benchmark.v1' || report.stage !== 'fast' || report.workload_classification !== 'ctx-ipc-microbenchmark' || report.modes.length !== 3) throw new Error(`incomplete ${side} modes in ${files[i]}`);
    const modes = new Set(report.modes.map(item => item.mode));
    if (modes.size !== 3 || !['in-process', 'subprocess', 'worker-pool'].every(mode => modes.has(mode))) throw new Error(`missing/duplicate mode in ${files[i]}`);
    for (const result of report.modes) {
      if (result.correctness !== 'passed' || result.reliability.failures !== 0 || result.reliability.soak_calls !== 100 || result.reliability.final_health?.healthy !== true) throw new Error(`invalid correctness/reliability in ${files[i]} ${side}/${result.mode}`);
      const backendStats = result.reliability.backend_stats;
      const throughputCount = Array.isArray(result.throughput) ? result.throughput.reduce((sum, row) => sum + row.completed, 0) : Number.NaN;
      const expectedExecutions = 1 + 30 + 500 + 100 + throughputCount;
      if (![result.executions, result.host_calls, backendStats?.totalExecutions, backendStats?.successCount, backendStats?.errorCount].every(Number.isInteger) || result.executions !== expectedExecutions || result.executions !== result.host_calls || result.host_calls !== backendStats.totalExecutions || result.host_calls !== backendStats.successCount || backendStats.errorCount !== 0 || result.host_call_sequence_coverage?.unique_sequences !== result.host_calls || result.host_call_sequence_coverage?.first_sequence !== 0 || result.host_call_sequence_coverage?.last_sequence !== result.host_calls - 1) throw new Error(`execution, host-call, and backend counters disagree in ${files[i]} ${side}/${result.mode}`);
      if (result.warm_latency.count !== 500 || result.warm_latency_samples_ms?.length !== 500 || result.throughput.length !== 2) throw new Error(`incomplete samples in ${files[i]} ${side}/${result.mode}`);
      const recomputedWarmLatency = percentiles(result.warm_latency_samples_ms);
      if (['count', 'p50_ms', 'p95_ms', 'p99_ms'].some(key => result.warm_latency[key] !== recomputedWarmLatency[key])) throw new Error(`warm latency summary disagrees with raw samples in ${files[i]} ${side}/${result.mode}`);
      if (!Number.isFinite(result.cold_first_execute_ms) || result.cold_first_execute_ms <= 0 || !Number.isFinite(result.rss.sampled_peak_process_tree_rss_lower_bound_bytes) || result.rss.sampled_peak_process_tree_rss_lower_bound_bytes <= 0) throw new Error(`invalid latency/RSS metrics in ${files[i]} ${side}/${result.mode}`);
      if (result.rss.process_count_after_shutdown !== 1 || !['sampled_lower_bound', 'unmeasurable_no_child_sampled', 'not_applicable_in_process'].includes(result.rss.child_rss_status)) throw new Error(`invalid child RSS observability in ${files[i]} ${side}/${result.mode}`);
      if (result.mode === 'in-process' && (result.rss.child_rss_status !== 'not_applicable_in_process' || result.rss.sampled_peak_child_rss_lower_bound_bytes !== null)) throw new Error(`in-process cannot report child RSS in ${files[i]} ${side}`);
      if (result.mode === 'worker-pool' && (result.rss.child_rss_status !== 'sampled_lower_bound' || !Number.isInteger(result.rss.child_process_samples) || result.rss.child_process_samples <= 0 || !Number.isInteger(result.rss.peak_child_process_count_observed) || result.rss.peak_child_process_count_observed <= 0 || !Number.isFinite(result.rss.sampled_peak_child_rss_lower_bound_bytes) || result.rss.sampled_peak_child_rss_lower_bound_bytes <= 0)) throw new Error(`worker-pool child RSS was not observed in ${files[i]} ${side}`);
      if (result.mode === 'subprocess' && result.rss.child_rss_status === 'sampled_lower_bound' && (!Number.isFinite(result.rss.sampled_peak_child_rss_lower_bound_bytes) || result.rss.sampled_peak_child_rss_lower_bound_bytes <= 0 || !Number.isInteger(result.rss.child_process_samples) || result.rss.child_process_samples <= 0 || !Number.isInteger(result.rss.peak_child_process_count_observed) || result.rss.peak_child_process_count_observed <= 0)) throw new Error(`invalid subprocess child RSS in ${files[i]} ${side}`);
      if (result.mode !== 'in-process' && result.rss.child_rss_status === 'unmeasurable_no_child_sampled' && (result.rss.sampled_peak_child_rss_lower_bound_bytes !== null || result.rss.child_process_samples !== 0 || result.rss.peak_child_process_count_observed !== 0)) throw new Error(`unmeasurable child RSS must not carry a value in ${files[i]} ${side}/${result.mode}`);
      const concurrencyValues = result.throughput.map(row => row.concurrency).sort((a, b) => a - b);
      if (JSON.stringify(concurrencyValues) !== JSON.stringify([1, 8]) || result.throughput.some(row => !Number.isInteger(row.completed) || row.failures !== 0 || row.completed <= 0 || !Number.isFinite(row.duration_seconds) || row.duration_seconds < 10 || !Number.isFinite(row.calls_per_second) || Math.abs(row.calls_per_second - row.completed / row.duration_seconds) > 1e-9)) throw new Error(`invalid throughput in ${files[i]} ${side}/${result.mode}`);
    }
  }
}

const modes = ['in-process', 'subprocess', 'worker-pool'];
const rows = [];
for (const mode of modes) {
  for (const [label, getter, higherIsBetter] of [
    ['cold first execute ms', item => item.cold_first_execute_ms, false],
    ['warm p50 ms', item => item.warm_latency.p50_ms, false],
    ['warm p95 ms', item => item.warm_latency.p95_ms, false],
    ['verified workload throughput c=1 calls/s', item => item.throughput.find(row => row.concurrency === 1).calls_per_second, true],
    ['verified workload throughput c=8 calls/s', item => item.throughput.find(row => row.concurrency === 8).calls_per_second, true],
    ['sampled process-tree RSS lower-bound MiB', item => item.rss.sampled_peak_process_tree_rss_lower_bound_bytes / (1024 * 1024), false],
  ]) {
    const baseline = pairs.map(pair => getter(pair.baseline.modes.find(item => item.mode === mode)));
    const candidate = pairs.map(pair => getter(pair.candidate.modes.find(item => item.mode === mode)));
    const ratios = pairs.map(pair => {
      const b = getter(pair.baseline.modes.find(item => item.mode === mode));
      const c = getter(pair.candidate.modes.find(item => item.mode === mode));
      return c / b;
    });
    rows.push({ mode, metric: label, baseline_median: median(baseline), candidate_median: median(candidate), candidate_over_baseline_median_ratio: median(ratios), higher_is_better: higherIsBetter, repeat_ratios: ratios });
  }
  const baselineChild = pairs.map(pair => pair.baseline.modes.find(item => item.mode === mode));
  const candidateChild = pairs.map(pair => pair.candidate.modes.find(item => item.mode === mode));
  const allChildRssObserved = [...baselineChild, ...candidateChild].every(item => item.rss.child_rss_status === 'sampled_lower_bound');
  const childStatus = mode === 'in-process' ? 'not_applicable_in_process' : allChildRssObserved ? 'sampled_lower_bound' : 'unmeasurable_no_child_sampled';
  const childBaselineValues = baselineChild.map(item => item.rss.sampled_peak_child_rss_lower_bound_bytes / (1024 * 1024));
  const childCandidateValues = candidateChild.map(item => item.rss.sampled_peak_child_rss_lower_bound_bytes / (1024 * 1024));
  rows.push({
    mode, metric: 'sampled child RSS lower-bound MiB', measurement_status: childStatus,
    baseline_median: allChildRssObserved ? median(childBaselineValues) : null,
    candidate_median: allChildRssObserved ? median(childCandidateValues) : null,
    candidate_over_baseline_median_ratio: allChildRssObserved ? median(pairs.map((pair, index) => childCandidateValues[index] / childBaselineValues[index])) : null,
    higher_is_better: false,
  });
}
const result = { schema: 'kb.plugin-execution-benchmark-summary.v1', workload_classification: 'ctx-ipc-microbenchmark', baseline_sha: baselineSha, candidate_sha: candidateSha, harness_sha: harnessSha, repeats: pairs.length, aggregation: 'median of paired per-repeat values; ratio is median of within-repeat candidate/baseline ratios', rows };
mkdirSync('.benchmark/plugin-execution-benchmark', { recursive: true });
writeFileSync('.benchmark/plugin-execution-benchmark/summary.json', `${JSON.stringify(result, null, 2)}\n`);
const fmt = value => value === null || value === undefined ? 'unmeasurable' : Number(value).toFixed(3);
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  const table = ['| Mode | Metric | Baseline median | Candidate median | Candidate / baseline |', '|---|---|---:|---:|---:|', ...rows.map(row => `| ${row.mode} | ${row.metric}${row.measurement_status ? ` (${row.measurement_status})` : ''} | ${fmt(row.baseline_median)} | ${fmt(row.candidate_median)} | ${fmt(row.candidate_over_baseline_median_ratio)}× |`)].join('\n');
  writeFileSync(summaryPath, `# Plugin execution paired benchmark\n\nBaseline: \`${baselineSha}\`  \nCandidate: \`${candidateSha}\`  \nHarness: \`${harnessSha}\`  \nValid paired repeats: ${pairs.length}\n\n${table}\n`);
}
console.log(JSON.stringify(result));
