#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseVerdict } from './remote-verdict.mjs';
import { resourcePeaks } from './remote-build-resources.mjs';

const profile = JSON.parse(readFileSync(new URL('./verification-profile.json', import.meta.url), 'utf8'));
const MISSING_SHARD_LOG = 'Shard did not produce a result artifact.';

function readJSON(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function githubJobName(job) {
  if (job.job === 'prepare' || job.job === 'build') return job.job;
  if (job.stage === 'internal-tool-tests') return `Internal tool test ${job.shard ?? job.stage}`;
  const independent = Object.values(profile.independentTestStages).some((stages) => stages.includes(job.stage));
  return `${independent ? 'Independent' : 'Build-dependent'} test ${job.shard ?? job.stage}`;
}

function failureAnnotations(evidence) {
  return (evidence?.annotations ?? [])
    .filter((annotation) => annotation.annotation_level === 'failure')
    .map((annotation) => annotation.message ?? JSON.stringify(annotation));
}

function failFastMatrix(shard) {
  if (shard.packages) return `package:${shard.stage}`;
  if (profile.independentTestStages.stream.includes(shard.stage)) return 'independent';
  if (profile.buildDependentTestStages.stream.includes(shard.stage)) return 'build-dependent';
  return undefined;
}

function failFastReason(shard, matrix, resultsByName, evidenceByName, verificationProfile) {
  if (verificationProfile !== 'stream' || !shard.packages || evidenceByName.get(githubJobName(shard))?.conclusion !== 'cancelled') return undefined;
  const group = failFastMatrix(shard);
  if (!group) return undefined;
  const failedPeer = matrix.include.some((peer) => {
    if (peer === shard || failFastMatrix(peer) !== group) return false;
    const peerName = peer.packages ? `${peer.stage}:shard-${peer.shard}` : peer.stage;
    const peerArtifact = resultsByName.get(peerName);
    const peerConclusion = evidenceByName.get(githubJobName(peer))?.conclusion;
    return peerArtifact?.status === 'fail' || peerConclusion === 'failure';
  });
  return failedPeer ? 'cancelled by fail-fast after a peer in the same test matrix failed' : undefined;
}

function isDevkitStage(result) {
  return result.name === profile.buildStage || result.name.startsWith(`${profile.packageTestStage}:shard-`) || result.name.startsWith('internal-tool-tests:shard-');
}

function devkitFailureEvidence(result) {
  if (!isDevkitStage(result) || result.status === 'pass') return result;
  const taskFailures = Array.isArray(result.taskFailures) ? result.taskFailures : [];
  let failures;
  if (taskFailures.length) {
    failures = taskFailures.map((task) => {
      const structured = task.structuredResult ?? task;
      const identity = [task.package ?? structured.Package ?? task.Package, task.task ?? structured.Task ?? task.Task].filter(Boolean).join(':') || 'kb-devkit task';
      const exitCode = task.exitCode ?? structured.ExitCode ?? task.ExitCode;
      const logPath = task.logPath ?? structured.logPath;
      const outputTail = [structured.Stdout, structured.Stderr].filter((output) => typeof output === 'string' && output.trim()).join('\n').trim();
      const summary = `${identity} (exit code ${String(exitCode)}${logPath ? `; log ${logPath}` : ''})`;
      return outputTail ? `${summary}\n${outputTail}` : summary;
    });
  } else if (result.name.startsWith('internal-tool-tests:shard-') && Array.isArray(result.failures) && result.failures.length) {
    failures = result.failures;
  } else {
    const tail = result.logTail?.trim();
    failures = [tail ? `log-tail fallback: ${tail}` : 'log-tail fallback: no task output was recorded'];
  }
  return { ...result, failures };
}

function reconcileJobResult(result, jobName, declaredConclusion, evidence, githubJobsError) {
  const githubConclusion = declaredConclusion && declaredConclusion !== 'unknown'
    ? declaredConclusion
    : evidence?.conclusion;
  const evidenceFailure = githubJobsError ? `GitHub job evidence API read failed: ${githubJobsError}` : undefined;
  if (!githubConclusion) {
    const missing = evidenceFailure ?? `GitHub job conclusion could not be read for planned job ${jobName}.`;
    return {
      ...result,
      status: 'fail',
      failures: [...(result.failures ?? []), missing],
      logTail: [result.logTail, missing].filter(Boolean).join('\n'),
    };
  }

  const evidenceConclusion = evidence?.conclusion;
  const conclusions = [declaredConclusion, evidenceConclusion].filter((value) => value && value !== 'unknown');
  const nonSuccessConclusion = conclusions.find((value) => value !== 'success');
  const actualConclusion = nonSuccessConclusion ?? githubConclusion;
  const apiFailure = evidenceFailure && !evidence && declaredConclusion !== 'success' ? [evidenceFailure] : [];
  if (actualConclusion === 'success' && apiFailure.length === 0) return result;

  const steps = (evidence?.steps ?? []).map(({ name, conclusion, status }) => ({ name, ...(conclusion === undefined ? {} : { conclusion }), ...(status === undefined ? {} : { status }) }));
  const failedSteps = steps.filter((step) => step.conclusion === 'failure').map((step) => `GitHub step ${step.name} concluded failure.`);
  const annotations = failureAnnotations(evidence);
  const causes = [
    `GitHub job ${jobName} concluded ${actualConclusion}.`,
    ...failedSteps,
    ...annotations,
    ...apiFailure,
  ];
  if (conclusions.length > 1 && new Set(conclusions).size > 1) {
    causes.push(`GitHub job conclusion sources disagreed: ${conclusions.join(' versus ')}.`);
  }
  const status = actualConclusion === 'timed_out' ? 'timeout' : 'fail';
  return {
    ...result,
    status,
    failures: [...(result.failures ?? []), ...causes],
    logTail: [result.logTail, ...causes, ...(steps.length ? [`GitHub steps: ${JSON.stringify(steps)}`] : [])].filter(Boolean).join('\n'),
    githubConclusion: actualConclusion,
    ...(steps.length ? { steps } : {}),
  };
}

function missingShard(shard, selectedPackageCount, githubJobs, githubJobsError, results, verificationProfile) {
  const name = shard.packages ? `${shard.stage}:shard-${shard.shard}` : shard.stage;
  const count = shard.packages ? shard.packages.length : selectedPackageCount;
  if (githubJobsError) {
    return { name, status: 'fail', selectedPackageCount: count, failures: [`GitHub job evidence API read failed: ${githubJobsError}`], logTail: '' };
  }
  const evidence = githubJobs.find((job) => job.name === githubJobName(shard));
  if (!evidence) {
    return { name, status: 'fail', selectedPackageCount: count, failures: [`GitHub job evidence is missing for planned job ${githubJobName(shard)}.`], logTail: '' };
  }
  const steps = (evidence.steps ?? []).map(({ name: stepName, conclusion, status }) => ({ name: stepName, ...(conclusion === undefined ? {} : { conclusion }), ...(status === undefined ? {} : { status }) }));
  const annotations = failureAnnotations(evidence);
  const conclusion = evidence.conclusion ?? 'unknown';
  if (conclusion === 'skipped') {
    return { name, status: 'skipped', selectedPackageCount: count, failures: ['GitHub skipped this planned job.'], logTail: 'GitHub skipped this planned job.', githubConclusion: conclusion, steps };
  }
  if (conclusion === 'cancelled' && verificationProfile === 'stream') {
    const group = profile.independentTestStages.stream.includes(shard.stage) ? 'independent' : 'build-dependent';
    const failedPeer = results.some((result) => {
      const peer = shard.packages ? result.name.startsWith(`${shard.stage}:shard-`) : profile.independentTestStages.stream.includes(result.name) || profile.buildDependentTestStages.stream.includes(result.name);
      if (!peer || result.status !== 'fail') return false;
      const peerGroup = profile.independentTestStages.stream.includes(result.name) ? 'independent' : 'build-dependent';
      return peerGroup === group;
    });
    if (failedPeer) {
      const reason = 'cancelled by fail-fast after a peer in the same test matrix failed';
      return { name, status: 'skipped', selectedPackageCount: count, failures: [reason], logTail: reason, githubConclusion: conclusion, steps };
    }
  }
  const timedOut = conclusion === 'timed_out';
  const status = timedOut ? 'timeout' : 'fail';
  const failures = [...annotations];
  if (timedOut) failures.unshift(`GitHub job ${githubJobName(shard)} timed out.`);
  else if (!failures.length) failures.push(`GitHub job ${githubJobName(shard)} concluded ${conclusion} without a result artifact.`);
  return {
    name, status, selectedPackageCount: count, failures,
    logTail: `GitHub conclusion: ${conclusion}; steps: ${JSON.stringify(steps)}`,
    githubConclusion: conclusion, steps,
  };
}

export function aggregateVerdict({
  sha, prepare, prepareJobResult = 'unknown', build, buildJobResult = 'unknown', buildResourceSamples = [],
  matrix, results, selectedPackageCount, verificationProfile = 'stream', githubJobs = [], githubJobsError,
}) {
  if (!Number.isSafeInteger(selectedPackageCount) || selectedPackageCount < 0) throw new Error('Remote verdict requires the selected package count from the prepare job.');
  const prepareStageResult = prepare ?? {
    name: 'prepare',
    status: 'fail',
    selectedPackageCount,
    failures: [`Prepare job concluded ${prepareJobResult} without a prepare stage result artifact.`],
    logTail: MISSING_SHARD_LOG,
  };
  let buildStage = build;
  if (!buildStage || buildStage.status === 'running') {
    const samples = [...(buildStage?.resourceSamples ?? []), ...buildResourceSamples];
    const terminated = ['cancelled', 'timed_out', 'failure'].includes(buildJobResult);
    const cause = buildJobResult === 'timed_out'
      ? 'runner-timeout'
      : buildJobResult === 'cancelled' || (buildJobResult === 'failure' && samples.length > 0)
        ? 'runner-shutdown'
        : 'build-result-missing';
    const lastResourceSample = buildResourceSamples.at(-1) ?? buildStage?.lastResourceSample ?? samples.at(-1);
    buildStage = {
      name: profile.buildStage,
      status: 'fail',
      selectedPackageCount: buildStage?.selectedPackageCount ?? selectedPackageCount,
      failures: [...(buildStage?.failures ?? []), `${cause}: workspace build job concluded ${buildJobResult}${terminated ? ' before completing its stage result' : ' without a completed stage result'}.`],
      logTail: lastResourceSample ? `Last resource sample: ${JSON.stringify(lastResourceSample)}` : MISSING_SHARD_LOG,
      ...(buildStage?.durationMs === undefined ? {} : { durationMs: buildStage.durationMs }),
      ...(lastResourceSample ? { lastResourceSample } : {}),
      ...(samples.length ? { resourcePeaks: resourcePeaks(samples) } : {}),
    };
  } else if (buildResourceSamples.length) {
    const samples = [...(buildStage.resourceSamples ?? []), ...buildResourceSamples];
    buildStage = { ...buildStage, resourceSamples: samples, resourcePeaks: resourcePeaks(samples), lastResourceSample: samples.at(-1) };
  }
  const evidenceByName = new Map(githubJobs.map((job) => [job.name, job]));
  const prepareName = githubJobName({ job: 'prepare' });
  const buildName = githubJobName({ job: 'build' });
  const jobs = [
    reconcileJobResult(prepareStageResult, prepareName, prepareJobResult, evidenceByName.get(prepareName), githubJobsError),
    reconcileJobResult(buildStage ?? { name: profile.buildStage, status: 'fail', selectedPackageCount, failures: ['build-result-missing: no build stage result artifact.'], logTail: MISSING_SHARD_LOG }, buildName, buildJobResult, evidenceByName.get(buildName), githubJobsError),
  ];
  const byName = new Map();
  for (const result of results) {
    if (byName.has(result.name)) throw new Error(`Duplicate remote shard result ${result.name}.`);
    byName.set(result.name, result);
  }
  for (const shard of matrix.include) {
    const name = shard.packages ? `${shard.stage}:shard-${shard.shard}` : shard.stage;
    const jobName = githubJobName(shard);
    const result = byName.get(name);
    const cancellationReason = failFastReason(shard, matrix, byName, evidenceByName, verificationProfile);
    if (cancellationReason) {
      const evidence = evidenceByName.get(jobName);
      const count = shard.packages ? shard.packages.length : selectedPackageCount;
      jobs.push(result
        ? {
          ...devkitFailureEvidence(result),
          status: 'skipped',
          failures: [cancellationReason],
          logTail: [result.logTail, cancellationReason].filter(Boolean).join('\n'),
          githubConclusion: 'cancelled',
          testsBeforeCancel: result.status,
          ...(result.failures?.length ? { artifactFailures: result.failures } : {}),
        }
        : {
          name, status: 'skipped', selectedPackageCount: count, failures: [cancellationReason],
          logTail: cancellationReason, githubConclusion: 'cancelled',
          steps: (evidence?.steps ?? []).map(({ name: stepName, conclusion, status }) => ({ name: stepName, ...(conclusion === undefined ? {} : { conclusion }), ...(status === undefined ? {} : { status }) })),
        });
      continue;
    }
    jobs.push(result
      ? reconcileJobResult(devkitFailureEvidence(result), jobName, undefined, evidenceByName.get(jobName), githubJobsError)
      : missingShard(shard, selectedPackageCount, githubJobs, githubJobsError, jobs.slice(2), verificationProfile));
  }
  const internalToolJobs = [];
  for (const shard of matrix.internalTool?.include ?? []) {
    const name = `${shard.stage}:shard-${shard.shard}`;
    const result = byName.get(name);
    const jobName = githubJobName(shard);
    const reconciled = result
      ? reconcileJobResult(devkitFailureEvidence(result), jobName, undefined, evidenceByName.get(jobName), githubJobsError)
      : missingShard(shard, shard.packages.length, githubJobs, githubJobsError, internalToolJobs, verificationProfile);
    internalToolJobs.push({
      ...reconciled,
      jobConclusion: evidenceByName.get(jobName)?.conclusion ?? 'unknown',
    });
  }
  for (const job of jobs) {
    if (!Number.isSafeInteger(job.selectedPackageCount) || job.selectedPackageCount < 0) throw new Error(`Remote verdict stage ${job.name} is missing its selected package count.`);
  }
  const verdict = {
    schemaVersion: 1,
    sha,
    profile: verificationProfile,
    selection: {
      mode: prepareStageResult.selectionMode ?? 'full',
      baseSha: prepareStageResult.selectionBaseSha ?? '',
      reason: prepareStageResult.selectionReason ?? 'full: package selection did not complete',
      packages: prepareStageResult.selectedPackages ?? [],
    },
    status: jobs.every((job) => job.status === 'pass') ? 'pass' : 'fail',
    jobs,
    internalToolResults: {
      status: internalToolJobs.every((job) => job.status === 'pass') ? 'pass' : 'fail',
      jobs: internalToolJobs,
    },
    diagnostics: [],
  };
  return parseVerdict(verdict, sha);
}

export function fetchGitHubJobEvidence({ repository, runId, plannedJobs, runCommand }) {
  const jobsUrl = `repos/${repository}/actions/runs/${runId}/jobs?per_page=100`;
  const jobs = JSON.parse(runCommand(jobsUrl)).jobs ?? [];
  const missingNames = new Set(plannedJobs.map(githubJobName));
  const plannedEvidence = jobs.filter((job) => missingNames.has(job.name));
  const observedNames = new Set(plannedEvidence.map((job) => job.name));
  const absentNames = [...missingNames].filter((name) => !observedNames.has(name));
  if (absentNames.length) throw new Error(`GitHub job evidence is missing for planned job(s): ${absentNames.join(', ')}.`);
  return plannedEvidence.map((job) => {
    const checkRunId = job.check_run_url?.split('/').at(-1);
    const annotations = checkRunId && job.conclusion !== 'success'
      ? JSON.parse(runCommand(`repos/${repository}/check-runs/${checkRunId}/annotations?per_page=100`))
      : [];
    return { name: job.name, conclusion: job.conclusion, steps: job.steps ?? [], annotations };
  });
}

function main() {
  const [resultsDir, out] = process.argv.slice(2);
  const sha = verificationSha(process.env);
  const selectedPackageCount = Number(process.env.REMOTE_SELECTED_PACKAGE_COUNT);
  const rawMatrix = process.env.REMOTE_TEST_MATRIX;
  if (!resultsDir || !out || !/^[0-9a-f]{40}$/.test(sha ?? '') || !Number.isSafeInteger(selectedPackageCount) || selectedPackageCount < 0) throw new Error('Usage: set GITHUB_SHA and REMOTE_SELECTED_PACKAGE_COUNT, then run node scripts/ci/aggregate-remote-verdict.mjs <results-dir> <output>.');
  const matrix = rawMatrix ? JSON.parse(rawMatrix) : { include: [] };
  matrix.internalTool = process.env.REMOTE_INTERNAL_TOOL_MATRIX ? JSON.parse(process.env.REMOTE_INTERNAL_TOOL_MATRIX) : { include: [] };
  const files = existsSync(resultsDir) ? readdirSync(resultsDir).filter((name) => name.endsWith('.json')).map((name) => path.join(resultsDir, name)) : [];
  const results = files.map(readJSON);
  const prepare = results.find((result) => result.name === 'prepare');
  const build = results.find((result) => result.name === profile.buildStage);
  const resourceSampleFile = process.env.BUILD_RESOURCE_SAMPLES;
  const buildResourceSamples = resourceSampleFile && existsSync(resourceSampleFile)
    ? readFileSync(resourceSampleFile, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : [];
  let githubJobs = [];
  let githubJobsError;
  const plannedJobs = [{ job: 'prepare' }, { job: 'build' }, ...matrix.include, ...(matrix.internalTool?.include ?? [])];
  try {
    githubJobs = fetchGitHubJobEvidence({
      repository: process.env.GITHUB_REPOSITORY,
      runId: process.env.GITHUB_RUN_ID,
      plannedJobs,
      runCommand: (endpoint) => {
        const result = spawnSync('gh', ['api', endpoint], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error((result.stderr || result.stdout || `gh api exited ${result.status}`).trim());
        return result.stdout;
      },
    });
  } catch (error) {
    githubJobsError = error.message;
  }
  const verdict = aggregateVerdict({
    sha, prepare, prepareJobResult: process.env.PREPARE_JOB_RESULT, build,
    buildJobResult: process.env.BUILD_JOB_RESULT, buildResourceSamples, matrix,
    results: results.filter((result) => result !== prepare && result !== build), selectedPackageCount,
    githubJobs, githubJobsError,
    verificationProfile: process.env.VERIFICATION_PROFILE ?? 'stream',
  });
  writeFileSync(out, `${JSON.stringify(verdict, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = verdict.jobs.map((job) => `| ${job.name} | ${job.status} | ${job.durationMs ?? '—'} ms |`).join('\n');
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `# Remote verification: ${verdict.status}\n\n| Stage | Status | Duration |\n|---|---|---:|\n${rows}\n`);
  }
  process.stdout.write(`Remote verification ${verdict.status} for ${sha}; wrote ${out}.\n`);
  if (verdict.status !== 'pass') process.exitCode = 1;
}

export function verificationSha(env) {
  return env.VERIFICATION_SHA ?? env.GITHUB_SHA;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
