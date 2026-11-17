import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const baselineRoot = path.resolve(process.env.BENCH_BASELINE_ROOT ?? '');
const candidateRoot = path.resolve(process.env.BENCH_CANDIDATE_ROOT ?? '');
const baselineSha = process.env.BENCH_BASELINE_SHA;
const candidateSha = process.env.BENCH_CANDIDATE_SHA;
const repeat = Number(process.env.BENCH_REPEAT);
const outputPath = process.env.BENCH_OUTPUT;
const harnessSha = process.env.BENCH_HARNESS_SHA;
const stage = process.env.BENCH_STAGE ?? 'fast';
const soakCalls = Number(process.env.BENCH_SOAK_CALLS ?? (stage === 'fast' ? 100 : 2_000));
if (!/^[a-f0-9]{40}$/i.test(baselineSha ?? '') || !/^[a-f0-9]{40}$/i.test(candidateSha ?? '')) throw new Error('paired benchmark requires full baseline and candidate SHAs');
if (!['fast', 'long-soak'].includes(stage) || !Number.isInteger(soakCalls) || soakCalls < 1) throw new Error('invalid benchmark stage or soak count');
if (baselineSha === candidateSha) throw new Error('baseline and candidate SHAs must differ for a before/after comparison');
if (!Number.isInteger(repeat) || repeat < 1 || !outputPath) throw new Error('invalid repeat or missing output path');
if (!/^[a-f0-9]{40}$/i.test(harnessSha ?? '')) throw new Error('paired benchmark requires a full harness SHA');
const resolvedOutputPath = path.resolve(outputPath);
const outputDir = path.dirname(resolvedOutputPath);
mkdirSync(outputDir, { recursive: true });
function checkedSha(root, expected) {
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (actual !== expected) throw new Error(`checkout SHA mismatch at ${root}: expected ${expected}, got ${actual}`);
}
checkedSha(baselineRoot, baselineSha);
checkedSha(candidateRoot, candidateSha);
const baselineFirst = repeat % 2 === 1;
const baseModes = ['in-process', 'subprocess', 'worker-pool'];
const shift = (repeat - 1) % baseModes.length;
const modeOrder = [...baseModes.slice(shift), ...baseModes.slice(0, shift)];
const outputs = {};
for (const side of baselineFirst ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
  const sourceRoot = side === 'baseline' ? baselineRoot : candidateRoot;
  const sha = side === 'baseline' ? baselineSha : candidateSha;
  const resultPath = path.join(outputDir, `${side}.json`);
  const child = spawnSync(process.execPath, [path.join(harnessRoot, 'scripts/ci/plugin-execution-benchmark/measure.mjs')], {
    cwd: sourceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env, BENCH_SOURCE_ROOT: sourceRoot, BENCH_SOURCE_SHA: sha,
      BENCH_HARNESS_SHA: harnessSha, BENCH_REPEAT: String(repeat), BENCH_MODE_ORDER: modeOrder.join(','), BENCH_OUTPUT: resultPath,
    },
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`${side} workload failed with exit ${child.status}; pair is invalid`);
  outputs[side] = JSON.parse(readFileSync(resultPath, 'utf8'));
}
for (const side of ['baseline', 'candidate']) {
  if (outputs[side].source_sha !== (side === 'baseline' ? baselineSha : candidateSha)) throw new Error(`${side} report has wrong SHA`);
  if (outputs[side].harness_sha !== harnessSha || outputs[side].repeat !== repeat || outputs[side].stage !== stage) throw new Error(`${side} report provenance/stage mismatch`);
  const measuredModes = new Set(outputs[side].modes.map(result => result.mode));
  if (measuredModes.size !== 3 || !['in-process', 'subprocess', 'worker-pool'].every(mode => measuredModes.has(mode))) throw new Error(`${side} omitted or duplicated an execution mode`);
  if (outputs[side].modes.some(result => result.correctness !== 'passed' || result.reliability.soak_calls !== soakCalls || result.reliability.failures !== 0 || result.reliability.final_health?.healthy !== true || result.reliability.backend_stats.totalExecutions !== result.executions || result.reliability.backend_stats.successCount !== result.executions || result.reliability.backend_stats.errorCount !== 0 || result.host_calls !== result.executions || result.host_call_sequence_coverage?.unique_sequences !== result.executions || result.host_call_sequence_coverage?.first_sequence !== 0 || result.host_call_sequence_coverage?.last_sequence !== result.executions - 1)) throw new Error(`${side} mode correctness/reliability report invalid`);
  const workerRss = outputs[side].modes.find(result => result.mode === 'worker-pool').rss;
  if (workerRss.child_rss_status !== 'sampled_lower_bound' || workerRss.child_process_samples <= 0 || workerRss.sampled_peak_child_rss_lower_bound_bytes <= 0) throw new Error(`${side} worker-pool child RSS was not observed`);
}
const report = {
  schema: 'kb.plugin-execution-paired-benchmark.v1', baseline_sha: baselineSha, candidate_sha: candidateSha,
  harness_sha: harnessSha, repeat, stage, soak_calls_per_mode: soakCalls, measurement_order: baselineFirst ? ['baseline', 'candidate'] : ['candidate', 'baseline'],
  mode_order: modeOrder, baseline: outputs.baseline, candidate: outputs.candidate,
};
writeFileSync(resolvedOutputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report)}\n`);
