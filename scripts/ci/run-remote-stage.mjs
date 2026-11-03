#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { runStage } from './remote-verify-stage.mjs';
import { measureBuildLimits } from './remote-build-resources.mjs';
import { mirrorStreamsToFile } from './remote-stage-output.mjs';

if (process.argv[2] === '--journey-batch-prepare') {
  const [output, baseline] = process.argv.slice(3);
  if (!output) throw new Error('Usage: node scripts/ci/run-remote-stage.mjs --journey-batch-prepare <output-dir> [baseline]');
  const result = spawnSync('bash', ['e2e/journey/batch.sh', 'prepare', output, ...(baseline ? [baseline] : [])], {
    cwd: process.cwd(), env: process.env, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const profile = JSON.parse(readFileSync(new URL('./verification-profile.json', import.meta.url), 'utf8'));
const stage = process.env.REMOTE_STAGE;
const stageLogPath = process.env.REMOTE_STAGE_LOG;
if (stageLogPath) mirrorStreamsToFile(stageLogPath, [process.stdout, process.stderr]);
const packageNames = process.env.REMOTE_PACKAGES ? process.env.REMOTE_PACKAGES.split(',') : undefined;
const shard = process.env.REMOTE_SHARD ? Number(process.env.REMOTE_SHARD) : undefined;
const packages = process.env.AFFECTED_PACKAGES ? process.env.AFFECTED_PACKAGES.split(',').filter(Boolean) : [];
const selectedPackageCount = Number(process.env.REMOTE_SELECTED_PACKAGE_COUNT);
const out = process.env.REMOTE_STAGE_RESULT;
if (!stage || !out) throw new Error('REMOTE_STAGE and REMOTE_STAGE_RESULT are required by the workflow shard invocation.');
if (!Number.isSafeInteger(selectedPackageCount) || selectedPackageCount < 0) throw new Error('REMOTE_SELECTED_PACKAGE_COUNT must be the resolved workspace package count from the prepare job.');
const cache = {
  pnpm: process.env.PNPM_CACHE_HIT,
  go: process.env.GO_CACHE_HIT,
  devkit: process.env.DEVKIT_CACHE_HIT,
};
const resourceSamplePath = process.env.REMOTE_RESOURCE_SAMPLES;
const result = await runStage({
  stage,
  packageNames,
  shard,
  packages,
  selectedPackageCount,
  cache,
  resourceSamplePath,
  affectedBuild: process.env.REMOTE_AFFECTED_BUILD === '1',
  devkitExecutable: process.env.REMOTE_DEVKIT_EXECUTABLE,
  partialResultPath: stage === profile.buildStage ? out : undefined,
  measureBuildLimits: stage === profile.buildStage ? () => {
    const limits = measureBuildLimits();
    process.stdout.write(`${profile.buildStage} resource limits: ${JSON.stringify(limits)}\n`);
    return limits;
  } : undefined,
  runCommand: (command, args, options) => new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.once('error', (error) => resolve({ status: 1, stdout, stderr, error }));
    child.once('close', (status, signal) => resolve({
      status: status ?? 1, stdout, stderr,
      ...(signal ? { error: new Error(`process terminated by ${signal}`) } : {}),
    }));
  }),
});
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${result.name}: ${result.status} (${result.durationMs} ms)\n${result.logTail}\n`);
process.exitCode = result.status === 'pass' ? 0 : 1;
