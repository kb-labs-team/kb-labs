import assert from 'node:assert/strict';
import test from 'node:test';
import { CALIBRATED_TASK_FOOTPRINT_BYTES, deriveBuildLimits, measureBuildLimits, sampleRunnerResources } from './remote-build-resources.mjs';

// case: S-262.7
test('build concurrency derives from runner capacity without a per-process heap ceiling', () => {
  const limits = deriveBuildLimits({
    cpuCount: 4,
    totalBytes: 16 * 1024 ** 3,
    availableBytes: 12 * 1024 ** 3,
    expectedTaskFootprintBytes: CALIBRATED_TASK_FOOTPRINT_BYTES,
  });
  assert.deepEqual(limits, {
    cpuCount: 4,
    memoryBudgetBytes: Math.floor(16 * 1024 ** 3 * 0.7),
    concurrency: 4,
    expectedTaskFootprintBytes: 2_536_468_480,
  });
  assert.equal('nodeHeapMb' in limits, false);
  assert.equal(deriveBuildLimits({
    cpuCount: 2,
    totalBytes: 4 * 1024 ** 3,
    availableBytes: 3 * 1024 ** 3,
    expectedTaskFootprintBytes: CALIBRATED_TASK_FOOTPRINT_BYTES,
  }).concurrency, 1);
});

// case: S-262.7
test('production capacity composition measures real-format meminfo and returns positive limits', () => {
  const limits = measureBuildLimits({
    readCpuCount: () => 4,
    readMeminfo: () => 'MemTotal:       16777216 kB\nMemFree: 100000 kB\nMemAvailable:   12582912 kB\n',
  });
  assert.equal(limits.cpuCount, 4);
  assert.ok(limits.memoryBudgetBytes > 0);
  assert.ok(limits.concurrency > 0);
});

// case: S-262.7
test('available memory caps concurrency and rejects capacity below one task', () => {
  const limits = deriveBuildLimits({
    cpuCount: 4,
    totalBytes: 16 * 1024 ** 3,
    availableBytes: 5 * 1024 ** 3,
    expectedTaskFootprintBytes: CALIBRATED_TASK_FOOTPRINT_BYTES,
  });
  assert.equal(limits.memoryBudgetBytes, 5 * 1024 ** 3);
  assert.equal(limits.concurrency, 2);
  assert.throws(() => deriveBuildLimits({
    cpuCount: 4,
    totalBytes: 16 * 1024 ** 3,
    availableBytes: 1024 ** 3,
    expectedTaskFootprintBytes: CALIBRATED_TASK_FOOTPRINT_BYTES,
  }), (error) => error.code === 'RUNNER_MEMORY_CAPACITY_INSUFFICIENT');
});

// case: S-262.7
test('resource sampler captures available memory, workspace disk, and top RSS processes', () => {
  const commands = [];
  const sample = sampleRunnerResources({
    workspaceRoot: '/workspace',
    readMeminfo: () => 'MemTotal:       16777216 kB\nMemAvailable:   12582912 kB\n',
    run: (command, args) => {
      commands.push([command, args]);
      if (command === 'df') return 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 100000 30000 70000 30% /workspace\n';
      return '2 2048 node\n1 1024 pnpm\n';
    },
    now: () => 1234,
  });

  assert.deepEqual(sample, {
    sampledAt: '1970-01-01T00:00:01.234Z',
    memory: { totalBytes: 17179869184, availableBytes: 12884901888, usedBytes: 4294967296 },
    disk: { availableBytes: 71680000, workspace: '/workspace' },
    topRss: [{ pid: 2, rssBytes: 2097152, command: 'node' }, { pid: 1, rssBytes: 1048576, command: 'pnpm' }],
  });
  assert.deepEqual(commands.map(([command]) => command), ['df', 'ps']);
});

// case: S-262.7
test('terminated build keeps an incrementally persisted partial result and resource sample', async () => {
  const { runStage } = await import('./remote-verify-stage.mjs');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'remote-build-partial-'));
  const resultPath = path.join(temporaryRoot, 'stage.json');
  const samplesPath = path.join(temporaryRoot, 'samples.jsonl');
  let complete;
  let pending;
  try {
    const expectedSample = { sampledAt: new Date(1000).toISOString(), memory: { totalBytes: 1000, availableBytes: 500, usedBytes: 500 }, disk: { availableBytes: 2000, workspace: temporaryRoot }, topRss: [] };
    pending = runStage({
      stage: 'workspace-build', packages: ['@fixture/a'], selectedPackageCount: 1,
      resourceSamplePath: samplesPath, partialResultPath: resultPath, sampleIntervalMs: 60_000,
      sampleResources: () => expectedSample,
      buildLimits: { cpuCount: 1, memoryBudgetBytes: 700, concurrency: 1, expectedTaskFootprintBytes: 500 },
      runCommand: async () => new Promise((resolve) => { complete = resolve; }),
      now: (() => { let value = 1000; return () => value += 1; })(),
    });
    const partial = JSON.parse(readFileSync(resultPath, 'utf8'));
    const samples = readFileSync(samplesPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(partial.name, 'workspace-build');
    assert.equal(partial.status, 'running');
    assert.ok(partial.durationMs >= 0);
    assert.deepEqual(partial.lastResourceSample, expectedSample);
    assert.deepEqual(samples, [expectedSample]);
    complete({ status: 1, stdout: '', stderr: 'stopped' });
    const finished = await pending;
    pending = undefined;
    assert.equal(finished.status, 'fail');
  } finally {
    if (pending && complete) {
      complete({ status: 1, stdout: '', stderr: 'test cleanup' });
      await pending;
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

// case: S-262.7
test('build fails visibly when its required resource sampler cannot produce evidence', async () => {
  const { runStage } = await import('./remote-verify-stage.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'remote-build-sampler-failure-'));
  try {
    const result = await runStage({
      stage: 'workspace-build', packages: ['@fixture/a'], selectedPackageCount: 1,
      resourceSamplePath: path.join(temporaryRoot, 'samples.jsonl'),
      partialResultPath: path.join(temporaryRoot, 'stage.json'),
      sampleResources: () => { throw new Error('df unavailable'); },
      buildLimits: { cpuCount: 1, memoryBudgetBytes: 700, concurrency: 1, expectedTaskFootprintBytes: 500 },
      runCommand: async () => ({ status: 0, stdout: 'built', stderr: '' }),
    });
    assert.equal(result.status, 'fail');
    assert.ok(result.failures.some((failure) => failure.includes('resource sampling failed: df unavailable')));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

// case: S-262.7
test('capacity measurement failure is written as a failed partial build with its typed cause', async () => {
  const { runStage } = await import('./remote-verify-stage.mjs');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'remote-build-measurement-failure-'));
  const resultPath = path.join(temporaryRoot, 'stage.json');
  let commandRan = false;
  try {
    const result = await runStage({
      stage: 'workspace-build', packages: ['@fixture/a'], selectedPackageCount: 1,
      partialResultPath: resultPath,
      measureBuildLimits: () => {
        const partial = JSON.parse(readFileSync(resultPath, 'utf8'));
        assert.equal(partial.status, 'running');
        throw Object.assign(new Error('Runner available memory cannot fit one build task.'), { code: 'RUNNER_MEMORY_CAPACITY_INSUFFICIENT' });
      },
      runCommand: async () => { commandRan = true; return { status: 0, stdout: 'built', stderr: '' }; },
    });
    assert.equal(commandRan, false);
    assert.equal(result.status, 'fail');
    assert.deepEqual(result.failures, ['build capacity measurement failed: Runner available memory cannot fit one build task.']);
    assert.equal(result.measurementErrorCode, 'RUNNER_MEMORY_CAPACITY_INSUFFICIENT');
    assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')), result);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

// case: S-262.7
test('zero MemAvailable is rejected by the capacity measurement parser', async () => {
  const { readRunnerMemory } = await import('./remote-build-resources.mjs');
  assert.throws(
    () => readRunnerMemory(() => 'MemTotal: 16777216 kB\nMemAvailable: 0 kB\n'),
    /MemAvailable must be a positive integer/,
  );
});

// case: S-262.7
test('capacity measurement preserves missing meminfo, invalid MemTotal, and CPU causes', async () => {
  const { deriveBuildLimits, readRunnerMemory } = await import('./remote-build-resources.mjs');
  assert.throws(
    () => readRunnerMemory(() => { throw new Error('fixture has no /proc/meminfo'); }),
    /Could not read Linux \/proc\/meminfo: fixture has no \/proc\/meminfo/,
  );
  assert.throws(
    () => readRunnerMemory(() => 'MemAvailable: 100 kB\n'),
    /missing a valid MemTotal value/,
  );
  assert.throws(
    () => readRunnerMemory(() => 'MemTotal: 0 kB\nMemAvailable: 100 kB\n'),
    /Runner MemTotal must be a positive integer/,
  );
  assert.throws(
    () => deriveBuildLimits({ cpuCount: 0, totalBytes: 1024, availableBytes: 512 }),
    /Runner CPU count must be a positive integer/,
  );
});
