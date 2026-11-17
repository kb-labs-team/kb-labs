import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { percentiles } from './stats.mjs';
import { assertCorrectResult } from './correctness.mjs';

const root = path.resolve(process.env.BENCH_SOURCE_ROOT ?? process.cwd());
const sha = process.env.BENCH_SOURCE_SHA;
const repeat = Number(process.env.BENCH_REPEAT);
const modeOrder = (process.env.BENCH_MODE_ORDER ?? 'in-process,subprocess,worker-pool').split(',');
const outputPath = process.env.BENCH_OUTPUT;
const stage = process.env.BENCH_STAGE ?? 'fast';
const soakCallsRequested = Number(process.env.BENCH_SOAK_CALLS ?? (stage === 'fast' ? 100 : 2_000));
if (!/^[a-f0-9]{40}$/i.test(sha ?? '')) throw new Error('BENCH_SOURCE_SHA must be a full SHA');
if (!Number.isInteger(repeat) || repeat < 1) throw new Error('BENCH_REPEAT must be a positive integer');
if (!['fast', 'long-soak'].includes(stage)) throw new Error('BENCH_STAGE must be fast or long-soak');
if (!Number.isInteger(soakCallsRequested) || soakCallsRequested < 1) throw new Error('BENCH_SOAK_CALLS must be a positive integer');
if (!outputPath) throw new Error('BENCH_OUTPUT is required');
if (new Set(modeOrder).size !== 3 || modeOrder.some(mode => !['in-process', 'subprocess', 'worker-pool'].includes(mode))) {
  throw new Error('BENCH_MODE_ORDER must contain each supported mode exactly once');
}

const packageDist = path.join(root, 'core/plugin-execution-factory/dist');
const { createExecutionBackend } = await import(pathToFileURL(path.join(packageDist, 'construct.js')).href);
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'kb-ctx-ipc-bench-'));
const marker = 'host-cache-marker-v1';
const padding = 'x'.repeat(4096);
writeFileSync(path.join(fixtureRoot, 'package.json'), '{"type":"module"}\n');
writeFileSync(path.join(fixtureRoot, 'handler.js'), `export default { async execute(ctx, input) {\n  const hostCall = await ctx.platform.cache.get('benchmark:marker:' + input.sequence);\n  return { requestId: ctx.requestId, pluginId: ctx.pluginId, host: ctx.host, marker: hostCall, padding: ctx.hostContext.flags.padding, sequence: input.sequence };\n} };\n`);

const logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  async flush() {}, child() { return this; },
};
function readProcessTreeRss(rootPid) {
  const entries = new Map();
  for (const name of readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).split(' ');
      entries.set(Number(name), { ppid: Number(fields[1]), pid: Number(name) });
    } catch {}
  }
  const pids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries.values()) {
      if (pids.has(entry.ppid) && !pids.has(entry.pid)) { pids.add(entry.pid); changed = true; }
    }
  }
  let rssKb = 0;
  let rootRssKb = 0;
  for (const pid of pids) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      if (match) {
        rssKb += Number(match[1]);
        if (pid === rootPid) rootRssKb = Number(match[1]);
      }
    } catch {}
  }
  return { rss_bytes: rssKb * 1024, child_rss_bytes: Math.max(0, rssKb - rootRssKb) * 1024, child_process_count: Math.max(0, pids.size - 1), process_count: pids.size };
}

async function measureMode(mode) {
  const hostCalls = [];
  const rssBeforeStart = readProcessTreeRss(process.pid);
  const platform = {
    logger,
    cache: {
      async get(key) { hostCalls.push(key); return key.startsWith('benchmark:marker:') ? marker : null; },
      async set() {}, async delete() {}, async clear() {}, async zadd() {}, async zrangebyscore() { return []; }, async zrem() {}, async setIfNotExists() { return false; },
    },
    getAdapter() { return undefined; },
  };
  const constructStart = performance.now();
  const backend = createExecutionBackend({ platform, mode, workerPool: { min: 1, max: 1, warmup: { mode: 'none', topN: 0, maxHandlers: 0 } } });
  const backendConstructMs = performance.now() - constructStart;
  const rssObservations = { peakTreeBytes: rssBeforeStart.rss_bytes, peakChildBytes: rssBeforeStart.child_rss_bytes, peakChildProcessCount: rssBeforeStart.child_process_count, childSamples: rssBeforeStart.child_process_count ? 1 : 0 };
  const sampleRss = () => {
    const sample = readProcessTreeRss(process.pid);
    rssObservations.peakTreeBytes = Math.max(rssObservations.peakTreeBytes, sample.rss_bytes);
    rssObservations.peakChildBytes = Math.max(rssObservations.peakChildBytes, sample.child_rss_bytes);
    rssObservations.peakChildProcessCount = Math.max(rssObservations.peakChildProcessCount, sample.child_process_count);
    if (sample.child_process_count > 0) rssObservations.childSamples++;
    return sample;
  };
  sampleRss();
  const sampler = setInterval(sampleRss, 100);
  const latencies = [];
  let nextSequence = 0;
  let shutdownComplete = false;
  const requestId = sequence => `ctx-ipc-${sha.slice(0, 12)}-${repeat}-${mode}-${sequence}`;
  const execute = async () => {
    const sequence = nextSequence++;
    const id = requestId(sequence);
    const expected = { requestId: id, pluginId: '@kb-labs/ctx-ipc-bench', host: 'cli', marker, padding, sequence };
    const backendStart = performance.now();
    const result = await backend.execute({
      executionId: id,
      handlerRef: './handler.js',
      pluginRoot: fixtureRoot,
      input: { sequence },
      descriptor: {
        hostType: 'cli', pluginId: '@kb-labs/ctx-ipc-bench', pluginVersion: '1.0.0', requestId: id,
        permissions: { platform: { cache: true } },
        hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: { padding } },
      },
    });
    const backendDurationMs = performance.now() - backendStart;
    if (!result.ok) throw new Error(`${mode} execute ${sequence} failed: ${result.error?.error?.message ?? 'unknown error'}`);
    try { assertCorrectResult(result.data, expected); } catch { throw new Error(`${mode} correctness mismatch at sequence ${sequence}`); }
    if (result.data.marker !== marker) throw new Error(`${mode} host-call response mismatch at sequence ${sequence}`);
    return { data: result.data, backend_duration_ms: backendDurationMs };
  };
  try {
    const coldFirst = await execute();
    const rssAfterCold = sampleRss();
    const firstExecuteMs = coldFirst.backend_duration_ms;
    for (let i = 0; i < 30; i++) await execute();
    if (stage === 'fast') {
      for (let i = 0; i < 500; i++) {
        const measured = await execute(); latencies.push(measured.backend_duration_ms);
      }
    }
    const warmLatency = stage === 'fast' ? percentiles(latencies) : null;
    const rssAfterWarm = sampleRss();
    const throughput = [];
    for (const concurrency of stage === 'fast' ? [1, 8] : []) {
      const throughputStart = performance.now();
      const until = throughputStart + 10_000;
      let completed = 0;
      let failures = 0;
      const workers = Array.from({ length: concurrency }, async () => {
        while (performance.now() < until) {
          try { await execute(); completed++; } catch { failures++; }
        }
      });
      await Promise.all(workers);
      const seconds = (performance.now() - throughputStart) / 1000;
      throughput.push({ concurrency, duration_seconds: seconds, completed, failures, calls_per_second: completed / seconds });
      if (failures) throw new Error(`${mode} throughput had ${failures} failures`);
    }
    const soakStart = nextSequence;
    for (let i = 0; i < soakCallsRequested; i++) await execute();
    const soakCalls = nextSequence - soakStart;
    const finalHealth = await backend.health();
    const finalStats = await backend.stats();
    if (finalStats.totalExecutions !== nextSequence || finalStats.successCount !== nextSequence || finalStats.errorCount !== 0) throw new Error(`${mode} backend statistics disagree with validated execute count`);
    if (finalHealth.healthy !== true) throw new Error(`${mode} unhealthy or health not verifiable at end of soak`);
    clearInterval(sampler);
    const beforeShutdown = sampleRss();
    await backend.shutdown();
    shutdownComplete = true;
    await new Promise(resolve => setTimeout(resolve, 250));
    const afterShutdown = sampleRss();
    const expectedHostCalls = nextSequence;
    const hostSequences = hostCalls.map(key => Number(key.slice('benchmark:marker:'.length))).sort((a, b) => a - b);
    if (hostCalls.length !== expectedHostCalls || hostCalls.some(key => !key.startsWith('benchmark:marker:')) || hostSequences.some((sequence, index) => sequence !== index)) throw new Error(`${mode} host-call total or sequence coverage mismatch`);
    if (afterShutdown.process_count > 1) throw new Error(`${mode} left child processes alive after shutdown`);
    return {
      mode, correctness: 'passed', workload_classification: 'ctx-ipc-microbenchmark', executions: nextSequence, host_calls: hostCalls.length, host_call_sequence_coverage: { unique_sequences: hostSequences.length, first_sequence: hostSequences[0] ?? null, last_sequence: hostSequences.at(-1) ?? null },
      backend_construct_ms: backendConstructMs, cold_first_execute_ms: firstExecuteMs, cold_first_execute_includes_backend_startup: true,
      warm_latency: warmLatency, warm_latency_samples_ms: latencies, throughput, reliability: { soak_calls: soakCalls, failures: 0, final_health: finalHealth, backend_stats: finalStats },
      rss: { sample_method: '/proc process-tree VmRSS sampled every 100ms plus phase boundaries; reported peaks are sampled lower bounds', before_start_bytes: rssBeforeStart.rss_bytes, after_first_execute_bytes: rssAfterCold.rss_bytes, after_warm_latency_bytes: rssAfterWarm.rss_bytes, sampled_peak_process_tree_rss_lower_bound_bytes: rssObservations.peakTreeBytes, sampled_peak_child_rss_lower_bound_bytes: mode === 'in-process' ? null : rssObservations.childSamples ? rssObservations.peakChildBytes : null, child_rss_status: mode === 'in-process' ? 'not_applicable_in_process' : rssObservations.childSamples ? 'sampled_lower_bound' : 'unmeasurable_no_child_sampled', child_process_samples: rssObservations.childSamples, peak_child_process_count_observed: rssObservations.peakChildProcessCount, before_shutdown_bytes: beforeShutdown.rss_bytes, after_shutdown_bytes: afterShutdown.rss_bytes, process_count_after_shutdown: afterShutdown.process_count },
    };
  } finally {
    clearInterval(sampler);
    if (!shutdownComplete) await backend.shutdown().catch(() => {});
  }
}

try {
  const modes = [];
  for (const mode of modeOrder) modes.push(await measureMode(mode));
  const report = {
    schema: 'kb.plugin-execution-benchmark.v1', stage, workload_classification: 'ctx-ipc-microbenchmark', source_sha: sha, repeat, node_version: process.version,
    runner_image: process.env.ImageOS ?? process.env.RUNNER_OS ?? 'unknown', harness_sha: process.env.BENCH_HARNESS_SHA,
    mode_order: modeOrder, fixture: { version: 1, context_padding_bytes: padding.length, host_call: 'cache.get benchmark:marker:<sequence>' }, modes,
  };
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
