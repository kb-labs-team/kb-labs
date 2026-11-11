import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { githubJobName, verificationSha } from './aggregate-remote-verdict.mjs';
import { aggregateVerdict, fetchGitHubJobEvidence } from './aggregate-remote-verdict.mjs';

const profile = JSON.parse(readFileSync(new URL('./verification-profile.json', import.meta.url), 'utf8'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const passingPrepare = () => ({
  name: 'prepare', status: 'pass', selectedPackageCount: 41, failures: [], logTail: '', durationMs: 100,
});

// case: S-262.7
test('uses the explicitly requested SHA for a reusable verification verdict', () => {
  const targetSha = 'a'.repeat(40);
  assert.equal(verificationSha({ VERIFICATION_SHA: targetSha, GITHUB_SHA: 'b'.repeat(40) }), targetSha);
  assert.equal(verificationSha({ GITHUB_SHA: targetSha }), targetSha);
});

// case: S-262.7
test('aggregates every shard with the existing verdict shape and per-stage timing', () => {
  const verdict = aggregateVerdict({
    sha: 'a'.repeat(40),
    prepare: passingPrepare(),
    build: { name: profile.buildStage, status: 'pass', selectedPackageCount: 41, failures: [], logTail: '', durationMs: 300 },
    matrix: { include: [{ stage: profile.buildDependentTestStages.candidate[0] }, { stage: profile.packageTestStage, shard: 1, packages: ['@kb-labs/core'] }] },
    results: [
      { name: profile.buildDependentTestStages.candidate[0], status: 'pass', selectedPackageCount: 41, failures: [], logTail: '', durationMs: 70 },
      { name: `${profile.packageTestStage}:shard-1`, status: 'fail', selectedPackageCount: 1, failures: ['test failed'], logTail: 'test failed', durationMs: 40 },
    ],
    selectedPackageCount: 41, prepareJobResult: 'success', buildJobResult: 'success',
    githubJobs: [
      { name: `Build-dependent test ${profile.buildDependentTestStages.candidate[0]}`, conclusion: 'success', steps: [], annotations: [] },
      { name: `Build-dependent test 1`, conclusion: 'failure', steps: [], annotations: [] },
    ], verificationProfile: 'candidate',
  });

  assert.equal(verdict.schemaVersion, 1);
  assert.equal(verdict.status, 'fail');
  assert.deepEqual(verdict.jobs.map(({ name }) => name), ['prepare', profile.buildStage, profile.buildDependentTestStages.candidate[0], `${profile.packageTestStage}:shard-1`]);
  assert.deepEqual(verdict.jobs.map(({ durationMs }) => durationMs), [100, 300, 70, 40]);
  assert.deepEqual(verdict.jobs.map(({ selectedPackageCount }) => selectedPackageCount), [41, 41, 41, 1]);
});

// case: S-277.1
test('candidate verdict reports internal-tool failures without using them for the candidate status', () => {
  const verdict = aggregateVerdict({
    sha: 'd'.repeat(40),
    prepare: passingPrepare(),
    build: { name: profile.buildStage, status: 'pass', selectedPackageCount: 1, failures: [], logTail: '', durationMs: 10 },
    matrix: {
      include: [{ stage: profile.packageTestStage, shard: 1, packages: ['@kb-labs/core'] }],
      internalTool: { include: [{ stage: 'internal-tool-tests', shard: 1, packages: ['kb-runner'] }] },
    },
    results: [
      { name: `${profile.packageTestStage}:shard-1`, status: 'pass', selectedPackageCount: 1, failures: [], logTail: '', durationMs: 10 },
      { name: 'internal-tool-tests:shard-1', status: 'fail', selectedPackageCount: 1, failures: ['runner test failed'], logTail: 'runner test failed', durationMs: 20 },
    ],
    selectedPackageCount: 1,
    prepareJobResult: 'success', buildJobResult: 'success', verificationProfile: 'candidate',
    githubJobs: [
      { name: 'Build-dependent test 1', conclusion: 'success', steps: [], annotations: [] },
      { name: 'Internal tool test 1', conclusion: 'success', steps: [], annotations: [] },
    ],
  });

  assert.equal(verdict.status, 'pass');
  assert.equal(verdict.internalToolResults.status, 'fail');
  assert.deepEqual(verdict.internalToolResults.jobs.map(({ name, status }) => [name, status]), [['internal-tool-tests:shard-1', 'fail']]);
  assert.equal(verdict.internalToolResults.jobs[0].jobConclusion, 'success');
});

// case: S-277.1
test('candidate internalToolResults preserve stdout-only package failure evidence', () => {
  const stdoutFailure = 'internal-tool test kb-runner exited 1: {"ok":false,"failures":["runner_test.go: failed"]}';
  const verdict = aggregateVerdict({
    sha: 'f'.repeat(40),
    prepare: passingPrepare(),
    build: { name: profile.buildStage, status: 'pass', selectedPackageCount: 1, failures: [], logTail: '', durationMs: 10 },
    matrix: { include: [{ stage: profile.packageTestStage, shard: 1, packages: ['@kb-labs/core'] }], internalTool: { include: [{ stage: 'internal-tool-tests', shard: 1, packages: ['kb-runner'] }] } },
    results: [
      { name: `${profile.packageTestStage}:shard-1`, status: 'pass', selectedPackageCount: 1, failures: [], logTail: '', durationMs: 10 },
      { name: 'internal-tool-tests:shard-1', status: 'fail', failures: [stdoutFailure], logTail: '', durationMs: 20 },
    ],
    selectedPackageCount: 1, prepareJobResult: 'success', buildJobResult: 'success', verificationProfile: 'candidate',
    githubJobs: [
      { name: 'Build-dependent test 1', conclusion: 'success', steps: [], annotations: [] },
      { name: 'Internal tool test 1', conclusion: 'success', steps: [], annotations: [] },
    ],
  });

  assert.equal(verdict.status, 'pass');
  assert.equal(verdict.internalToolResults.status, 'fail');
  assert.deepEqual(verdict.internalToolResults.jobs[0].failures, [stdoutFailure]);
});

// case: S-277.1
test('candidate Go suite excludes runner while its failed Go test remains an internal result', () => {
  const registry = spawnSync(process.execPath, ['scripts/read-go-binary-registry.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(registry.status, 0, registry.stderr || registry.stdout);
  assert.ok(!JSON.parse(registry.stdout).includes('tools/kb-runner'));
  const verdict = aggregateVerdict({
    sha: 'a'.repeat(40),
    prepare: passingPrepare(),
    build: { name: profile.buildStage, status: 'pass', selectedPackageCount: 1, failures: [], logTail: '', durationMs: 10 },
    matrix: {
      include: [
        { stage: profile.packageTestStage, shard: 1, packages: ['@kb-labs/core'] },
        { stage: 'kb-devkit-check' },
      ],
      internalTool: { include: [{ stage: 'internal-tool-tests', shard: 1, packages: ['kb-runner'] }] },
    },
    results: [
      { name: `${profile.packageTestStage}:shard-1`, status: 'pass', selectedPackageCount: 1, failures: [], logTail: '', durationMs: 10 },
      { name: 'kb-devkit-check', status: 'pass', selectedPackageCount: 166, failures: [], logTail: 'workspace Go suite ran gating modules', durationMs: 10 },
      { name: 'internal-tool-tests:shard-1', status: 'fail', selectedPackageCount: 1, failures: ['kb-runner go test: runner_test.go failed'], logTail: '', durationMs: 20 },
    ],
    selectedPackageCount: 1,
    prepareJobResult: 'success', buildJobResult: 'success', verificationProfile: 'candidate',
    githubJobs: [
      { name: 'Build-dependent test 1', conclusion: 'success', steps: [], annotations: [] },
      { name: 'Build-dependent test kb-devkit-check', conclusion: 'success', steps: [], annotations: [] },
      { name: 'Internal tool test 1', conclusion: 'success', steps: [], annotations: [] },
    ],
  });

  assert.equal(verdict.status, 'pass');
  assert.equal(verdict.jobs.find(({ name }) => name === 'kb-devkit-check').status, 'pass');
  assert.equal(verdict.internalToolResults.status, 'fail');
  assert.match(verdict.internalToolResults.jobs[0].failures.join('\n'), /runner_test\.go failed/);
});

// case: S-277.2
test('stream verdict fails when the kb-runner package-test shard fails', () => {
  const verdict = aggregateVerdict({
    sha: 'e'.repeat(40),
    prepare: passingPrepare(),
    build: { name: profile.buildStage, status: 'pass', selectedPackageCount: 1, failures: [], logTail: '', durationMs: 10 },
    matrix: { include: [{ stage: profile.packageTestStage, shard: 1, packages: ['kb-runner'] }] },
    results: [{ name: `${profile.packageTestStage}:shard-1`, status: 'fail', selectedPackageCount: 1, failures: ['runner test failed'], logTail: 'runner test failed', durationMs: 20 }],
    selectedPackageCount: 1,
    prepareJobResult: 'success', buildJobResult: 'success', verificationProfile: 'stream',
    githubJobs: [{ name: 'Build-dependent test 1', conclusion: 'failure', steps: [], annotations: [] }],
  });

  assert.equal(verdict.status, 'fail');
  assert.equal(verdict.jobs.at(-1).status, 'fail');
});

// case: S-262.7
test('marks matrix shards cancelled by stream fail-fast as skipped, never as a passing verdict', () => {
  const verdict = aggregateVerdict({
    sha: 'b'.repeat(40),
    prepare: passingPrepare(),
    build: { name: profile.buildStage, status: 'pass', selectedPackageCount: 41, failures: [], logTail: '', durationMs: 300 },
    matrix: { include: [{ stage: profile.packageTestStage, shard: 1, packages: ['@kb-labs/a'] }, { stage: profile.packageTestStage, shard: 2, packages: ['@kb-labs/b'] }] },
    results: [{ name: `${profile.packageTestStage}:shard-1`, status: 'fail', selectedPackageCount: 1, failures: ['failed'], logTail: 'failed', durationMs: 70 }],
    githubJobs: [
      { name: 'Build-dependent test 1', conclusion: 'failure', steps: [], annotations: [] },
      { name: 'Build-dependent test 2', conclusion: 'cancelled', steps: [], annotations: [] },
    ],
    selectedPackageCount: 41, prepareJobResult: 'success', buildJobResult: 'success', verificationProfile: 'stream',
  });

  assert.equal(verdict.status, 'fail');
  assert.equal(verdict.jobs[3].name, `${profile.packageTestStage}:shard-2`);
  assert.equal(verdict.jobs[3].status, 'skipped');
  assert.match(verdict.jobs[3].failures[0], /cancelled by fail-fast/);
  assert.equal(verdict.jobs[3].selectedPackageCount, 1);
});


// case: S-262.7
test('aggregates the prepare stage and fails with its named cause', () => {
  const prepare = {
    name: 'prepare',
    status: 'fail',
    selectedPackageCount: 0,
    failures: ['install-workspace-dependencies exited with status 17'],
    logTail: 'pnpm registry unavailable',
    durationMs: 1250,
    cache: { pnpm: 'miss-or-restore-prefix', go: 'exact-hit', devkit: 'unavailable' },
  };
  const verdict = aggregateVerdict({
    sha: 'c'.repeat(40), prepare, prepareJobResult: 'failure', build: undefined, buildJobResult: 'skipped', matrix: { include: [] }, results: [], selectedPackageCount: 0,
  });

  assert.equal(verdict.status, 'fail');
  assert.deepEqual(verdict.jobs.map(({ name }) => name), ['prepare', profile.buildStage]);
  assert.equal(verdict.jobs[0].status, 'fail');
  assert.equal(verdict.jobs[0].durationMs, 1250);
  assert.deepEqual(verdict.jobs[0].failures, [...prepare.failures, 'GitHub job prepare concluded failure.']);
  assert.match(verdict.jobs[0].logTail, /pnpm registry unavailable/);
});

// case: S-262.7
test('selection reason is preserved in prepare verdict evidence', () => {
  const prepare = {
    ...passingPrepare(), selectionReason: 'full: configured shared input core/plugin-contracts/src/color-policy.mjs',
    selectionMode: 'full', selectionBaseSha: 'd'.repeat(40), selectedPackages: ['@kb-labs/core-platform', '@kb-labs/cli'],
  };
  const verdict = aggregateVerdict({
    sha: 'f'.repeat(40), prepare, prepareJobResult: 'success', build: undefined, buildJobResult: 'success', matrix: { include: [] }, results: [], selectedPackageCount: 41,
  });
  assert.equal(verdict.jobs[0].selectionReason, 'full: configured shared input core/plugin-contracts/src/color-policy.mjs');
  assert.deepEqual(verdict.selection, {
    mode: 'full', baseSha: 'd'.repeat(40),
    reason: 'full: configured shared input core/plugin-contracts/src/color-policy.mjs',
    packages: ['@kb-labs/core-platform', '@kb-labs/cli'],
  });
});

// case: S-262.7
test('missing build result after runner shutdown retains the last persisted resource sample', () => {
  const sample = {
    sampledAt: '2026-10-26T23:51:45.000Z',
    memory: { totalBytes: 16 * 1024 ** 3, availableBytes: 512 * 1024 ** 2, usedBytes: 15.5 * 1024 ** 3 },
    disk: { availableBytes: 5 * 1024 ** 3, workspace: '/home/runner/work/repository' },
    topRss: [{ pid: 100, rssBytes: 8 * 1024 ** 3, command: 'node' }],
  };
  const verdict = aggregateVerdict({
    sha: 'e'.repeat(40), prepare: passingPrepare(), prepareJobResult: 'success', build: undefined, buildJobResult: 'failure',
    buildResourceSamples: [sample], matrix: { include: [] }, results: [], selectedPackageCount: 160,
  });

  assert.equal(verdict.status, 'fail');
  assert.equal(verdict.jobs[1].name, profile.buildStage);
  assert.equal(verdict.jobs[1].status, 'fail');
  assert.ok(verdict.jobs[1].failures.some((failure) => failure.includes('runner-shutdown')));
  assert.deepEqual(verdict.jobs[1].lastResourceSample, sample);
  assert.equal(verdict.jobs[1].resourcePeaks.peakMemoryBytes, sample.memory.usedBytes);
  assert.equal(verdict.jobs[1].resourcePeaks.minimumFreeDiskBytes, sample.disk.availableBytes);
});

// case: S-262.7
test('real prepare result producer records a named command failure for aggregation', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'remote-prepare-result-'));
  const binDir = path.join(temporaryRoot, 'bin');
  const preparePath = path.join(temporaryRoot, 'prepare.json');
  const fakeCorepack = path.join(binDir, 'corepack');
  try {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(fakeCorepack, '#!/bin/sh\nprintf "registry unavailable\n"\nexit 17\n');
    chmodSync(fakeCorepack, 0o755);
    const result = spawnSync(process.execPath, ['scripts/ci/run-remote-prepare.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        VERIFICATION_PROFILE: 'stream',
        DEFAULT_BRANCH: 'main',
        REMOTE_PREPARE_RESULT: preparePath,
        REMOTE_AFFECTED_PACKAGES: path.join(temporaryRoot, 'affected.json'),
        REMOTE_TEST_PLAN: path.join(temporaryRoot, 'plan.json'),
        GITHUB_OUTPUT: path.join(temporaryRoot, 'github-output'),
        PNPM_CACHE_HIT: 'false',
        GO_CACHE_HIT: 'true',
      },
    });
    assert.equal(result.status, 1, result.stderr);
    const prepare = JSON.parse(readFileSync(preparePath, 'utf8'));
    const verdict = aggregateVerdict({
      sha: 'd'.repeat(40), prepare, prepareJobResult: 'failure', build: undefined, buildJobResult: 'skipped', matrix: { include: [] }, results: [], selectedPackageCount: 0,
    });

    assert.equal(prepare.name, 'prepare');
    assert.equal(prepare.status, 'fail');
    assert.ok(prepare.durationMs >= 0);
    assert.equal(prepare.selectedPackageCount, 0);
    assert.deepEqual(prepare.cache, { pnpm: 'miss-or-restore-prefix', go: 'exact-hit', devkit: 'unavailable' });
    assert.equal(prepare.operations[0].name, 'install-workspace-dependencies');
    assert.equal(prepare.operations[0].status, 'fail');
    assert.ok(prepare.failures.some((failure) => failure.includes('install-workspace-dependencies')));
    assert.match(prepare.logTail, /registry unavailable/);
    assert.equal(verdict.jobs[0].name, 'prepare');
    assert.equal(verdict.jobs[0].status, 'fail');
    assert.ok(verdict.jobs[0].failures.some((failure) => failure.includes('install-workspace-dependencies')));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

// case: S-262.7
test('missing shard artifacts retain GitHub runner-loss conclusion, failed steps, and annotations', () => {
  const shard = { stage: profile.buildDependentTestStages.candidate[0] };
  const verdict = aggregateVerdict({
    sha: 'a'.repeat(40), prepare: passingPrepare(),
    build: { name: profile.buildStage, status: 'pass', selectedPackageCount: 41, failures: [], logTail: '' },
    matrix: { include: [shard] }, results: [], selectedPackageCount: 41, prepareJobResult: 'success', buildJobResult: 'success',
    githubJobs: [{
      name: `Build-dependent test ${shard.stage}`, conclusion: 'failure',
      steps: [{ name: 'Run build-dependent test', conclusion: 'in_progress' }],
      annotations: [
        { annotation_level: 'failure', message: 'The hosted runner lost communication with the server.' },
        { annotation_level: 'notice', message: 'The ubuntu-latest label will migrate to Ubuntu 26.' },
      ],
    }], verificationProfile: 'candidate',
  });

  const job = verdict.jobs.at(-1);
  assert.equal(job.status, 'fail');
  assert.equal(job.githubConclusion, 'failure');
  assert.deepEqual(job.steps, [{ name: 'Run build-dependent test', conclusion: 'in_progress' }]);
  assert.match(job.failures.join('\n'), /lost communication with the server/);
  assert.ok(!job.failures.some((failure) => failure.includes('Ubuntu 26')));
  assert.match(job.logTail, /in_progress/);
});

// case: S-262.7
test('only a cancelled peer in the same fail-fast matrix is reported as skipped by fail-fast', () => {
  const stage = profile.packageTestStage;
  const verdict = aggregateVerdict({
    sha: 'b'.repeat(40), prepare: passingPrepare(),
    build: { name: profile.buildStage, status: 'pass', selectedPackageCount: 41, failures: [], logTail: '' },
    matrix: { include: [{ stage, shard: 1, packages: ['@kb-labs/a'] }, { stage, shard: 2, packages: ['@kb-labs/b'] }] },
    results: [{ name: `${stage}:shard-1`, status: 'fail', selectedPackageCount: 1, failures: ['test failed'], logTail: 'test failed' }],
    selectedPackageCount: 41, prepareJobResult: 'success', buildJobResult: 'success',
    githubJobs: [{ name: `Build-dependent test 2`, conclusion: 'cancelled', steps: [], annotations: [] }],
    verificationProfile: 'stream',
  });

  assert.equal(verdict.jobs.at(-1).status, 'skipped');
  assert.deepEqual(verdict.jobs.at(-1).failures, ['cancelled by fail-fast after a peer in the same test matrix failed']);
  assert.equal(verdict.jobs.at(-1).logTail, 'cancelled by fail-fast after a peer in the same test matrix failed');
});

// case: S-262.7
test('fail-fast cancellation overrides a pass artifact and ignores notice annotations as failures', () => {
  const stage = profile.packageTestStage;
  const verdict = aggregateVerdict({
    sha: 'f'.repeat(40), prepare: passingPrepare(),
    build: { name: profile.buildStage, status: 'pass', selectedPackageCount: 41, failures: [], logTail: '' },
    matrix: { include: [
      { stage, shard: 1, packages: ['@kb-labs/a'] },
      { stage, shard: 6, packages: ['@kb-labs/b'] },
      { stage, shard: 12, packages: ['@kb-labs/c'] },
    ] },
    results: [
      { name: `${stage}:shard-1`, status: 'pass', selectedPackageCount: 1, failures: [], logTail: 'tests passed' },
      { name: `${stage}:shard-6`, status: 'fail', selectedPackageCount: 1, failures: ['test failed'], logTail: 'test failed' },
      { name: `${stage}:shard-12`, status: 'pass', selectedPackageCount: 1, failures: [], logTail: 'tests passed' },
    ],
    selectedPackageCount: 41, prepareJobResult: 'success', buildJobResult: 'success', verificationProfile: 'stream',
    githubJobs: [
      { name: 'Build-dependent test 1', conclusion: 'cancelled', steps: [], annotations: [
        { annotation_level: 'notice', message: 'The ubuntu-latest label will migrate to Ubuntu 26.' },
      ] },
      { name: 'Build-dependent test 6', conclusion: 'failure', steps: [], annotations: [] },
      { name: 'Build-dependent test 12', conclusion: 'cancelled', steps: [], annotations: [] },
    ],
  });

  const cancelledPass = verdict.jobs.find((job) => job.name === `${stage}:shard-1`);
  const cancelledPassAfterFailure = verdict.jobs.find((job) => job.name === `${stage}:shard-12`);
  for (const job of [cancelledPass, cancelledPassAfterFailure]) {
    assert.equal(job.status, 'skipped');
    assert.equal(job.testsBeforeCancel, 'pass');
    assert.ok(job.failures.some((failure) => failure.includes('cancelled by fail-fast')));
    assert.ok(!job.failures.some((failure) => failure.includes('Ubuntu 26')));
  }
});

// case: S-262.7
test('devkit task cause uses only that failed task structured output', () => {
  const stage = profile.packageTestStage;
  const failedTaskOutput = 'FAIL src/__tests__/projects.integration.test.ts > kb-host project routing > answers KB_PROJECT_RUNTIME_START_FAILED\nError: listen EADDRINUSE: address already in use 127.0.0.1:44107';
  const passingTaskNoise = '[WARN] Adapter "storage" using InMemory fallback';
  const taskLogPath = '/home/runner/work/kb-labs-backup/kb-labs-backup/.kb/devkit/logs/62340c390a5aedf3af87c4f63748a52fdc1b207869387111783eb0295c71fafe.log';
  const verdict = aggregateVerdict({
    sha: '9'.repeat(40), prepare: passingPrepare(),
    build: { name: profile.buildStage, status: 'pass', selectedPackageCount: 41, failures: [], logTail: '' },
    matrix: { include: [{ stage, shard: 19, packages: ['@kb-labs/host-app'] }] },
    results: [{
      name: `${stage}:shard-19`, status: 'fail', selectedPackageCount: 1,
      failures: [passingTaskNoise], logTail: passingTaskNoise,
      taskFailures: [{
        package: '@kb-labs/host-app', task: 'test', exitCode: 1, logPath: taskLogPath,
        structuredResult: {
          Package: '@kb-labs/host-app', Task: 'test', OK: false, ExitCode: 1, logPath: taskLogPath,
          Stdout: failedTaskOutput, Stderr: '',
        },
      }],
    }],
    selectedPackageCount: 41, prepareJobResult: 'success', buildJobResult: 'success', verificationProfile: 'candidate',
    githubJobs: [{ name: 'Build-dependent test 19', conclusion: 'failure', steps: [], annotations: [] }],
  });

  const job = verdict.jobs.at(-1);
  const [taskCause] = job.failures;
  assert.ok(taskCause.includes('@kb-labs/host-app:test'));
  assert.ok(taskCause.includes('exit code 1'));
  assert.ok(taskCause.includes(taskLogPath));
  assert.ok(taskCause.includes('FAIL src/__tests__/projects.integration.test.ts'));
  assert.ok(taskCause.includes('EADDRINUSE'));
  assert.ok(!job.failures.some((failure) => failure.includes('Adapter "storage"')));
});

// case: S-262.7
test('devkit task log tail is labeled as fallback only when structured task results are absent', () => {
  const stage = profile.packageTestStage;
  const tail = '[WARN] Adapter "storage" using InMemory fallback';
  const verdict = aggregateVerdict({
    sha: '8'.repeat(40), prepare: passingPrepare(),
    build: { name: profile.buildStage, status: 'pass', selectedPackageCount: 41, failures: [], logTail: '' },
    matrix: { include: [{ stage, shard: 4, packages: ['@kb-labs/other'] }] },
    results: [{ name: `${stage}:shard-4`, status: 'fail', selectedPackageCount: 1, failures: [], logTail: tail, taskFailures: [] }],
    selectedPackageCount: 41, prepareJobResult: 'success', buildJobResult: 'success', verificationProfile: 'candidate',
    githubJobs: [{ name: 'Build-dependent test 4', conclusion: 'failure', steps: [], annotations: [] }],
  });

  assert.deepEqual(verdict.jobs.at(-1).failures, [`log-tail fallback: ${tail}`, 'GitHub job Build-dependent test 4 concluded failure.']);
});

// case: S-262.7
test('a missing shard with GitHub timed_out conclusion is a named timeout', () => {
  const stage = profile.buildDependentTestStages.candidate[0];
  const verdict = aggregateVerdict({
    sha: 'c'.repeat(40), prepare: passingPrepare(),
    build: { name: profile.buildStage, status: 'pass', selectedPackageCount: 41, failures: [], logTail: '' },
    matrix: { include: [{ stage }] }, results: [], selectedPackageCount: 41, prepareJobResult: 'success', buildJobResult: 'success',
    githubJobs: [{ name: `Build-dependent test ${stage}`, conclusion: 'timed_out', steps: [], annotations: [] }],
    verificationProfile: 'candidate',
  });

  assert.equal(verdict.jobs.at(-1).name, stage);
  assert.equal(verdict.jobs.at(-1).status, 'timeout');
  assert.match(verdict.jobs.at(-1).failures.join('\n'), /timed out/);
});

// case: S-262.7
test('GitHub job evidence API failure names the missing shard and API error', () => {
  const stage = profile.buildDependentTestStages.candidate[0];
  const verdict = aggregateVerdict({
    sha: 'd'.repeat(40), prepare: passingPrepare(),
    build: { name: profile.buildStage, status: 'pass', selectedPackageCount: 41, failures: [], logTail: '' },
    matrix: { include: [{ stage }] }, results: [], selectedPackageCount: 41, prepareJobResult: 'success', buildJobResult: 'success',
    githubJobsError: 'gh api: HTTP 403',
  });

  assert.equal(verdict.jobs.at(-1).status, 'fail');
  assert.match(verdict.jobs.at(-1).failures.join('\n'), /GitHub job evidence API read failed: gh api: HTTP 403/);
});


// case: S-262.7
test('GitHub job evidence fetch reads job steps and annotations from the Actions API', () => {
  const calls = [];
  const evidence = fetchGitHubJobEvidence({
    repository: 'kb-labs/workspace', runId: '42',
    plannedJobs: [{ stage: profile.buildDependentTestStages.candidate[0] }],
    runCommand: (endpoint) => {
      calls.push(endpoint);
      if (endpoint.endsWith('/jobs?per_page=100')) return JSON.stringify({ jobs: [{
        name: githubJobName({ stage: profile.buildDependentTestStages.candidate[0] }), conclusion: 'failure', steps: [{ name: 'test', conclusion: 'in_progress' }],
        check_run_url: 'https://api.github.com/repos/kb-labs/workspace/check-runs/123',
      }] });
      return JSON.stringify([{ message: 'hosted runner lost communication' }]);
    },
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0], /actions\/runs\/42\/jobs/);
  assert.match(calls[1], /check-runs\/123\/annotations/);
  assert.equal(evidence[0].steps[0].conclusion, 'in_progress');
  assert.equal(evidence[0].annotations[0].message, 'hosted runner lost communication');
});

// case: S-262.7
test('a passing build stage artifact cannot override a failed enclosing build job', () => {
  const verdict = aggregateVerdict({
    sha: 'e'.repeat(40), prepare: passingPrepare(), prepareJobResult: 'success',
    build: { name: profile.buildStage, status: 'pass', selectedPackageCount: 0, failures: [], logTail: '', durationMs: 12 },
    buildJobResult: 'failure',
    githubJobs: [{
      name: 'build', conclusion: 'failure',
      steps: [{ name: 'Upload workspace build artifact', conclusion: 'failure', status: 'completed' }],
      annotations: [{ annotation_level: 'failure', message: 'Artifact upload failed.' }],
    }],
    matrix: { include: [] }, results: [], selectedPackageCount: 0,
  });

  assert.equal(verdict.status, 'fail');
  assert.equal(verdict.jobs[1].status, 'fail');
  assert.match(verdict.jobs[1].failures.join('\n'), /GitHub job build concluded failure/);
  assert.match(verdict.jobs[1].failures.join('\n'), /Upload workspace build artifact/);
  assert.match(verdict.jobs[1].failures.join('\n'), /Artifact upload failed/);
});

// case: S-262.7
test('a passing matrix stage artifact cannot override a failed enclosing shard job', () => {
  const stage = profile.buildDependentTestStages.candidate[0];
  const verdict = aggregateVerdict({
    sha: 'f'.repeat(40), prepare: passingPrepare(), prepareJobResult: 'success',
    build: { name: profile.buildStage, status: 'pass', selectedPackageCount: 41, failures: [], logTail: '' },
    buildJobResult: 'success',
    matrix: { include: [{ stage }] },
    results: [{ name: stage, status: 'pass', selectedPackageCount: 41, failures: [], logTail: '', durationMs: 22 }],
    selectedPackageCount: 41,
    githubJobs: [{
      name: `Build-dependent test ${stage}`, conclusion: 'failure',
      steps: [{ name: 'Upload build-dependent result', conclusion: 'failure', status: 'completed' }],
      annotations: [{ annotation_level: 'failure', message: 'Result artifact upload failed.' }],
    }], verificationProfile: 'candidate',
  });

  const job = verdict.jobs.at(-1);
  assert.equal(verdict.status, 'fail');
  assert.equal(job.status, 'fail');
  assert.match(job.failures.join('\n'), /GitHub job .* concluded failure/);
  assert.match(job.failures.join('\n'), /Upload build-dependent result/);
  assert.match(job.failures.join('\n'), /Result artifact upload failed/);
});


// case: S-262.7
test('a planned job with no readable GitHub conclusion fails by name', () => {
  const verdict = aggregateVerdict({
    sha: '9'.repeat(40), prepare: passingPrepare(), prepareJobResult: 'success',
    build: { name: profile.buildStage, status: 'pass', selectedPackageCount: 0, failures: [], logTail: '' },
    buildJobResult: 'unknown', githubJobsError: 'gh api: HTTP 403',
    matrix: { include: [] }, results: [], selectedPackageCount: 0,
  });

  assert.equal(verdict.jobs[1].status, 'fail');
  assert.match(verdict.jobs[1].failures.join('\n'), /GitHub job evidence API read failed: gh api: HTTP 403/);
});
