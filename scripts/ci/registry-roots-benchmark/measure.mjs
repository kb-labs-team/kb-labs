import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { unwrapCliEnvelope, summarizeTaskRows, summarizeRootClosure } from './metrics.mjs';
import { performance } from 'node:perf_hooks';
const { registryJourneyBuildRoots } = await import(pathToFileURL(`${process.cwd()}/e2e/journey/registry-build-roots.mjs`));

const strategy = process.env.BENCH_STRATEGY;
const cacheMode = process.env.BENCH_CACHE_MODE;
const repeat = Number(process.env.BENCH_REPEAT ?? 1);
const outputPath = process.env.BENCH_OUTPUT;
const sha = process.env.BENCH_SOURCE_SHA;
if (!['affected', 'registry-roots'].includes(strategy)) throw new Error('invalid BENCH_STRATEGY');
if (!['cold', 'warm'].includes(cacheMode)) throw new Error('invalid BENCH_CACHE_MODE');
if (!/^\d+$/.test(String(repeat))) throw new Error('invalid BENCH_REPEAT');
if (!/^[a-f0-9]{40}$/i.test(sha ?? '')) throw new Error('BENCH_SOURCE_SHA must be a full immutable commit SHA');
if (!outputPath) throw new Error('BENCH_OUTPUT is required');

const roots = strategy === 'registry-roots' ? registryJourneyBuildRoots() : [];
const rootsDigest = createHash('sha256').update(roots.join('\n')).digest('hex');
const commandArgs = strategy === 'affected'
  ? ['run', 'build', '--affected', '--json']
  : ['run', 'build', '--packages', roots.join(','), '--json'];
const binary = `${process.env.RUNNER_TEMP}/kb-devkit-bench`;
const cacheState = `${process.cwd()}/.kb/devkit`;
if (existsSync(cacheState)) throw new Error('refusing to benchmark: .kb/devkit already exists before this job-owned run');

function run(label, noCache) {
  const args = [...commandArgs];
  if (noCache) args.splice(args.length - 1, 0, '--no-cache');
  const start = performance.now();
  const result = spawnSync(binary, args, { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const wallMs = Math.round(performance.now() - start);
  const raw = result.stdout.trim();
  let envelope;
  try { envelope = JSON.parse(raw); } catch {
    throw new Error(`${label} output was not JSON (exit ${result.status}); stderr is in the Actions log`);
  }
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status}); stderr is in the Actions log`);
  const payload = unwrapCliEnvelope(envelope);
  const rows = payload.results;
  return {
    label,
    command: ['kb-devkit', ...args].join(' '),
    wall_ms: wallMs,
    reported_elapsed: payload.elapsed,
    scheduled: payload.summary.scheduled,
    passed: payload.summary.passed,
    failed: payload.summary.failed,
    blocked: payload.summary.blocked,
    cached: payload.summary.cached,
    not_affected: payload.summary.notAffected,
    ...summarizeTaskRows(rows),
  };
}

// --no-cache bypasses lookup but still stores successful task results. Warm
// mode primes this exact selector, then resets only this fresh job's state
// directory so the measured command selects the same tasks again and hits CAS.
let primer = null;
if (cacheMode === 'warm') {
  primer = run('unmeasured-primer', true);
  if (!existsSync(cacheState)) throw new Error('primer did not create expected job-owned .kb/devkit state');
  rmSync(cacheState, { recursive: true, force: false });
}
const measurement = run('measured', cacheMode === 'cold');
const rootClosure = strategy === 'registry-roots'
  ? summarizeRootClosure(roots, measurement.packages)
  : null;


const report = {
  schema: 'kb.registry-roots-benchmark.v1',
  source_sha: sha,
  strategy,
  selection_semantics: strategy === 'affected'
    ? 'fresh checkout with no prior clean task state; DevKit selects all dirty package tasks'
    : 'explicit Registry journey package roots plus task dependencies',
  cache_mode: cacheMode,
  repeat,
  runner_image: process.env.ImageOS ?? process.env.RUNNER_OS ?? 'unknown',
  node_version: process.version,
  roots_count: roots.length,
  selected_package_count: measurement.packages.length,
  roots_sha256: rootsDigest,
  root_closure: rootClosure,
  roots,
  primer: primer && {
    wall_ms: primer.wall_ms,
    scheduled: primer.scheduled,
    cached: primer.cached,
    packages: primer.packages,
  },
  cache_note: 'TaskResult does not expose cacheability. The task-row hit ratio includes explicitly uncacheable tasks, so partial/no-hit status is diagnostic and never claimed as a fully warm cache.',
  result: measurement,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report)}\n`);
