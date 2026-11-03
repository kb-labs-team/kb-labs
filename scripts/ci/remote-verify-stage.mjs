import { appendFileSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resourcePeaks, sampleRunnerResources } from './remote-build-resources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const profile = JSON.parse(readFileSync(new URL('./verification-profile.json', import.meta.url), 'utf8'));
const stageDefinitions = Object.entries(profile.stages).map(([id, definition]) => ({ id, ...definition }));

function failingNames(log) {
  return log.split(/\r?\n/).filter((line) => /(^FAIL\s|^--- FAIL:|Tests\s+\d+ failed|ERR_PNPM|^✖\s|^FAILED\s)/.test(line)).slice(-40);
}

export function boundedTail(log) {
  return log.split(/\r?\n/).slice(-80).join('\n').slice(-12_000);
}

function internalToolCommandOutput(outcome) {
  let envelope;
  try {
    envelope = JSON.parse(outcome.stdout ?? '');
  } catch {
    return [outcome.stderr, outcome.stdout, outcome.error?.message].filter(Boolean).join('\n');
  }
  const failedTasks = envelope?.data?.results?.filter((task) => task?.OK === false) ?? [];
  const taskOutput = failedTasks.flatMap((task) => [task.Stderr, task.Stdout]).filter((text) => typeof text === 'string' && text.trim());
  return [outcome.stderr, ...taskOutput, ...(taskOutput.length ? [] : [outcome.stdout]), outcome.error?.message].filter(Boolean).join('\n');
}

function cacheStatus(value) {
  if (value === 'true') return 'exact-hit';
  if (value === 'false') return 'miss-or-restore-prefix';
  return 'unavailable';
}

export async function runStage({
  stage, packageNames, packages, selectedPackageCount, shard, runCommand, now = Date.now, cache = {},
  resourceSamplePath, partialResultPath, sampleIntervalMs = 30_000,
  sampleResources = () => sampleRunnerResources({ workspaceRoot: root, now }),
  buildLimits, measureBuildLimits, affectedBuild = false, devkitExecutable = './tools/kb-devkit/kb-devkit',
}) {
  const definition = stageDefinitions.find((entry) => entry.id === stage);
  if (!definition) throw new Error(`Unknown verification stage ${stage}; use the registered stages in scripts/ci/verification-profile.json.`);
  if (!Number.isSafeInteger(selectedPackageCount) || selectedPackageCount < 0) throw new Error(`${stage} requires the selected package count from the remote verification plan.`);
  const startedAt = now();
  let command;
  let args;
  let packageName;
  let name = stage;
  const internalToolStage = stage === 'internal-tool-tests';
  if (stage === profile.buildStage) {
    name = stage;
    const selected = packages ?? [];
    if (selected.length === 0 && !affectedBuild) {
      const at = now();
      return {
        name, status: 'pass', failures: [], logTail: 'kb-devkit selected no affected workspace packages; build had no work.',
        selectedPackageCount: 0,
        startedAt: new Date(at).toISOString(), finishedAt: new Date(at).toISOString(), durationMs: 0, cache: cacheRecord(cache),
      };
    }
    command = devkitExecutable;
  } else if (stage === profile.packageTestStage) {
    if (!Array.isArray(packageNames) || packageNames.length === 0 || packageNames.some((packageName) => typeof packageName !== 'string' || !packageName)) throw new Error(`${profile.packageTestStage} requires packages selected by kb-devkit affected --json.`);
    if (!Number.isSafeInteger(shard) || shard < 1) throw new Error(`${profile.packageTestStage} requires a positive shard number from the remote verification plan.`);
    command = './tools/kb-devkit/kb-devkit';
    args = ['run', 'test', '--packages', packageNames.join(','), '--concurrency', '1', '--json'];
    name = `${stage}:shard-${shard}`;
  } else if (internalToolStage) {
    if (!Array.isArray(packageNames) || packageNames.length === 0 || packageNames.some((packageName) => typeof packageName !== 'string' || !packageName)) throw new Error('internal-tool-tests requires packages selected by the kb-devkit release classification.');
    if (!Number.isSafeInteger(shard) || shard < 1) throw new Error('internal-tool-tests requires a positive shard number from the remote verification plan.');
    command = './tools/kb-devkit/kb-devkit';
    args = [];
    name = `${stage}:shard-${shard}`;
  } else if (definition.runner === 'kb-devkit-test-package') {
    packageName = packageNameFromManifest(stage, definition);
    if (!Array.isArray(packageNames) || !packageNames.includes(packageName)) throw new Error(`Verification stage ${stage} package ${packageName} is absent from its manifest-backed package selection. Rerun the remote selector: node scripts/ci/resolve-remote-selection.mjs "$VERIFICATION_PROFILE" "$RUNNER_TEMP/affected-packages.json" ./tools/kb-devkit/kb-devkit.`);
    if (!Number.isSafeInteger(shard) || shard < 1) throw new Error(`${stage} requires a positive shard number from the remote verification plan.`);
    command = './tools/kb-devkit/kb-devkit';
    args = ['run', 'test', '--packages', packageName, '--concurrency', '1', '--json'];
    name = `${stage}:shard-${shard}`;
  } else {
    [command, args] = commandFor(definition);
  }
  const buildSamples = [];
  const sampleFailures = [];
  const persistPartial = (status = 'running') => {
    if (!partialResultPath) return;
    const partial = {
      name, status, selectedPackageCount: stage === profile.packageTestStage || internalToolStage || definition.runner === 'kb-devkit-test-package' ? packageNames.length : selectedPackageCount,
      failures: [...sampleFailures], logTail: '', startedAt: new Date(startedAt).toISOString(),
      finishedAt: null, durationMs: Math.max(0, now() - startedAt),
      ...(stage === profile.buildStage ? { resourceLimits: buildLimits, resourcePeaks: resourcePeaks(buildSamples), lastResourceSample: buildSamples.at(-1) } : {}),
      cache: cacheRecord(cache),
    };
    writeAtomicJSON(partialResultPath, partial);
  };
  if (stage === profile.buildStage) {
    persistPartial();
    try {
      if (measureBuildLimits) buildLimits = measureBuildLimits();
      if (!buildLimits) throw new Error('Runner capacity measurement did not produce build limits.');
    } catch (error) {
      const finishedAt = now();
      process.stderr.write(`build capacity measurement failed: ${error.message}\n`);
      const result = {
        name,
        status: 'fail',
        selectedPackageCount,
        failures: [`build capacity measurement failed: ${error.message}`],
        logTail: `Build was not started because capacity measurement failed: ${error.message}`,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        durationMs: Math.max(0, finishedAt - startedAt),
        ...(typeof error.code === 'string' ? { measurementErrorCode: error.code } : {}),
        cache: cacheRecord(cache),
      };
      if (partialResultPath) writeAtomicJSON(partialResultPath, result);
      return result;
    }
    args = affectedBuild
      ? ['run', 'build', '--affected', '--concurrency', String(buildLimits.concurrency), '--json']
      : ['run', 'build', '--packages', (packages ?? []).join(','), '--concurrency', String(buildLimits.concurrency), '--json'];
  }
  const captureResourceSample = () => {
    try {
      const sample = sampleResources();
      buildSamples.push(sample);
      if (resourceSamplePath) appendFileSync(resourceSamplePath, `${JSON.stringify(sample)}\n`);
      process.stdout.write(`workspace-build resource sample: ${JSON.stringify(sample)}\n`);
      persistPartial();
    } catch (error) {
      const failure = `resource sampling failed: ${error.message}`;
      sampleFailures.push(failure);
      process.stderr.write(`${failure}\n`);
      persistPartial();
    }
  };
  const isBuild = stage === profile.buildStage && Boolean(resourceSamplePath && partialResultPath);
  if (isBuild) captureResourceSample();
  const timer = isBuild ? setInterval(captureResourceSample, sampleIntervalMs) : undefined;
  persistPartial();
  let result;
  try {
    if (internalToolStage) {
      const commands = [
        ['internal-tool build', './tools/kb-devkit/kb-devkit', ['run', 'build', '--packages', packageNames.join(','), '--concurrency', '1', '--json']],
        ['internal-tool test', './tools/kb-devkit/kb-devkit', ['run', 'test', '--packages', packageNames.join(','), '--concurrency', '1', '--json']],
        ...packageNames.map((packageName) => [`internal-tool check ${packageName}`, './tools/kb-devkit/kb-devkit', ['check', '--internal-tool-package', packageName, '--json']]),
      ];
      const outcomes = [];
      for (const [label, executable, commandArgs] of commands) {
        const outcome = await runCommand(executable, commandArgs, { cwd: root, env: {} });
        outcomes.push({ label, ...outcome });
      }
      result = {
        status: outcomes.every((outcome) => outcome.status === 0) ? 0 : 1,
        stdout: outcomes.map((outcome) => `${outcome.label} (exit ${outcome.status})\n${outcome.stdout ?? ''}`).join('\n'),
        stderr: outcomes.map((outcome) => `${outcome.label} (exit ${outcome.status})\n${outcome.stderr ?? outcome.error?.message ?? ''}`).filter((output) => output.trim()).join('\n'),
        internalToolFailures: outcomes.filter((outcome) => outcome.status !== 0).map((outcome) => `${outcome.label} exited ${outcome.status}: ${boundedTail(internalToolCommandOutput(outcome))}`),
      };
    } else {
      result = await runCommand(command, args, { cwd: root, env: {} });
    }
  } finally {
    if (timer) clearInterval(timer);
  }
  if (isBuild) captureResourceSample();
  const finishedAt = now();
  const log = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n');
  const taskFailures = devkitTaskFailures(stage, result);
  const taskLogOutput = taskFailures.map((failure) => {
    const label = [failure.package, failure.task].filter(Boolean).join(':');
    return [label, failure.logPath, failure.logTail || failure.error].filter(Boolean).join('\n');
  }).join('\n\n');
  const isDevkitStage = stage === profile.buildStage || stage === profile.packageTestStage || internalToolStage || definition.runner === 'kb-devkit-test-package';
  const visibleLog = taskFailures.length ? taskLogOutput : isDevkitStage ? (result.stderr || '') : log;
  const failures = internalToolStage
    ? result.internalToolFailures
    : stage === profile.buildStage
    ? taskFailures.map(formatBuildTaskFailure)
    : [...failingNames(log), ...taskFailures.flatMap((failure) => (failure.logTail || failure.error || '').split(/\r?\n/).filter(Boolean)), ...sampleFailures];
  const stageResult = {
    name,
    status: result.status === 0 && taskFailures.length === 0 && sampleFailures.length === 0 ? 'pass' : 'fail',
    selectedPackageCount: stage === profile.packageTestStage || internalToolStage || definition.runner === 'kb-devkit-test-package'
      ? packageNames.length
      : affectedBuild ? JSON.parse(result.stdout).data.results.length : selectedPackageCount,
    failures: [...failures, ...sampleFailures],
    taskFailures,
    logTail: boundedTail(visibleLog),
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: Math.max(0, finishedAt - startedAt),
    ...(stage === profile.packageTestStage || internalToolStage || definition.runner === 'kb-devkit-test-package' ? { packages: packageNames } : {}),
    cache: cacheRecord(cache),
    ...(stage === profile.buildStage ? {
      resourceLimits: buildLimits,
      resourcePeaks: resourcePeaks(buildSamples),
      lastResourceSample: buildSamples.at(-1),
    } : {}),
  };
  if (partialResultPath) writeAtomicJSON(partialResultPath, stageResult);
  return stageResult;
}

function writeAtomicJSON(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

function packageNameFromManifest(stage, definition) {
  if (typeof definition.packageManifest !== 'string' || definition.packageManifest.length === 0) throw new Error(`Verification stage ${stage} requires a package manifest registered by its stage definition.`);
  const manifest = JSON.parse(readFileSync(path.resolve(root, definition.packageManifest), 'utf8'));
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) throw new Error(`Verification stage ${stage} package manifest ${definition.packageManifest} has no package name.`);
  return manifest.name;
}

function devkitTaskFailures(stage, result) {
  const taskStage = stage === profile.buildStage || stage === profile.packageTestStage
    || stageDefinitions.find((entry) => entry.id === stage)?.runner === 'kb-devkit-test-package';
  if (!taskStage) return [];
  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch (error) {
    return [{ error: `kb-devkit run --json returned invalid JSON: ${error.message}` }];
  }
  const results = envelope?.data?.results;
  if (!Array.isArray(results)) {
    return [{ error: 'kb-devkit run --json returned no structured task results.' }];
  }
  if (result.status === 0 && envelope?.ok !== true) {
    return [{ error: 'kb-devkit run --json reported a non-passing envelope for a successful process.' }];
  }
  if (results.length === 0) {
    return [{ error: 'kb-devkit run --json completed without executing any tasks.' }];
  }
  if (result.status !== 0 && envelope?.ok !== false) {
    return [{ error: 'kb-devkit run --json returned no structured task results for a failed stage.' }];
  }
  return results.filter((task) => task?.OK === false).map((task) => {
    const failure = {
      package: task.Package,
      task: task.Task,
      exitCode: task.ExitCode,
      structuredResult: { ...task, Stdout: boundedTail(task.Stdout ?? ''), Stderr: boundedTail(task.Stderr ?? '') },
      errorLine: firstStructuredErrorLine(task),
      logPath: task.logPath,
    };
    if (typeof task.logPath !== 'string' || task.logPath.length === 0) {
      return { ...failure, error: 'failed task result did not include its structured logPath.' };
    }
    try {
      failure.logTail = boundedTail(readFileSync(task.logPath, 'utf8'));
    } catch (error) {
      failure.error = `could not read task log: ${error.message}`;
    }
    return failure;
  });
}

function firstStructuredErrorLine(task) {
  for (const value of [task.Stderr, task.Error]) {
    if (typeof value !== 'string') continue;
    const firstLine = value.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (firstLine) return firstLine;
  }
  return `task exited with code ${String(task.ExitCode)}`;
}

function formatBuildTaskFailure(failure) {
  const identity = [failure.package, failure.task].filter((part) => typeof part === 'string' && part.length > 0).join(':') || 'kb-devkit build';
  return `${identity} — ${failure.errorLine ?? failure.error ?? `task exited with code ${String(failure.exitCode)}`}`;
}

function commandFor(definition) {
  if (definition.runner === 'node-test-directory') {
    const files = readdirSync(path.join(root, definition.directory), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
      .map((entry) => path.join(definition.directory, entry.name))
      .sort();
    return [process.execPath, ['--test', ...files]];
  }
  if (definition.runner === 'node-script') return [process.execPath, [definition.script, ...definition.args]];
  if (definition.runner === 'process' || definition.runner === 'executable') return [definition.command, definition.args];
  throw new Error(`Unsupported verification runner ${definition.runner}; declare a supported runner in scripts/ci/verification-profile.json.`);
}

export function cacheRecord(cache) {
  return {
    pnpm: cacheStatus(cache.pnpm),
    go: cacheStatus(cache.go),
    devkit: cacheStatus(cache.devkit),
  };
}
