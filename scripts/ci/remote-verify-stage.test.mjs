import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runStage } from './remote-verify-stage.mjs';

const profile = JSON.parse(readFileSync(new URL('./verification-profile.json', import.meta.url), 'utf8'));
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('journey workspace build uses the same measured concurrency entry and streams affected builds', async () => {
  let invocation;
  const result = await runStage({
    stage: profile.buildStage,
    packages: [],
    selectedPackageCount: 0,
    affectedBuild: true,
    buildLimits: { cpuCount: 4, memoryBudgetBytes: 1000, concurrency: 2, expectedTaskFootprintBytes: 500 },
    runCommand: async (command, args) => {
      invocation = [command, args];
      return { status: 0, stdout: JSON.stringify({ ok: true, data: { results: [{ Package: '@fixture/a', Task: 'build', OK: true }] } }), stderr: '' };
    },
  });

  assert.deepEqual(invocation, ['./tools/kb-devkit/kb-devkit', ['run', 'build', '--affected', '--concurrency', '2', '--json']]);
  assert.equal(result.status, 'pass');
  assert.equal(result.selectedPackageCount, 1);
});

// case: S-262.7
test('workspace package shard uses kb-devkit and records a stage result with elapsed time', async () => {
  let now = 1_000;
  let invocation;
  const result = await runStage({
    stage: profile.packageTestStage,
    packageNames: ['@kb-labs/core', '@kb-labs/cli'],
    selectedPackageCount: 41,
    shard: 3,
    runCommand: async (command, args) => {
      invocation = [command, args];
      now += 250;
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, data: { results: [{ Package: '@kb-labs/core', Task: 'test', OK: true }] } }),
        stderr: '',
      };
    },
    now: () => now,
  });

  assert.deepEqual(invocation, ['./tools/kb-devkit/kb-devkit', ['run', 'test', '--packages', '@kb-labs/core,@kb-labs/cli', '--concurrency', '1', '--json']]);
  assert.equal(result.name, `${profile.packageTestStage}:shard-3`);
  assert.deepEqual(result.packages, ['@kb-labs/core', '@kb-labs/cli']);
  assert.equal(result.status, 'pass');
  assert.equal(result.durationMs, 250);
  assert.equal(result.selectedPackageCount, 2);
});

test('manifest-backed Go suite preserves the planner shard identity and executed task result', async () => {
  let invocation;
  const result = await runStage({
    stage: 'kb-create-go-suite',
    packageNames: ['kb-create'],
    selectedPackageCount: 165,
    shard: 1,
    runCommand: async (command, args) => {
      invocation = [command, args];
      return { status: 0, stdout: JSON.stringify({ ok: true, data: { results: [{ Package: 'kb-create', Task: 'test', OK: true }] } }), stderr: '' };
    },
  });

  assert.deepEqual(invocation, ['./tools/kb-devkit/kb-devkit', ['run', 'test', '--packages', 'kb-create', '--concurrency', '1', '--json']]);
  assert.equal(result.name, 'kb-create-go-suite:shard-1');
  assert.deepEqual(result.packages, ['kb-create']);
  assert.equal(result.selectedPackageCount, 1);
  assert.equal(result.status, 'pass');
});

test('manifest-backed Go suite fails when kb-devkit reports zero executed tasks', async () => {
  const result = await runStage({
    stage: 'kb-create-go-suite',
    packageNames: ['kb-create'],
    selectedPackageCount: 165,
    shard: 1,
    runCommand: async () => ({ status: 0, stdout: '{"ok":true,"data":{"results":[]}}', stderr: '' }),
  });

  assert.equal(result.name, 'kb-create-go-suite:shard-1');
  assert.equal(result.status, 'fail');
  assert.ok(result.failures.some((failure) => failure.includes('without executing any tasks')));
});

// case: S-277.2
test('candidate internal-tool lane builds, tests, and checks each selected package', async () => {
  const invocations = [];
  const result = await runStage({
    stage: 'internal-tool-tests',
    packageNames: ['kb-runner'],
    selectedPackageCount: 4,
    shard: 1,
    runCommand: async (command, args) => {
      invocations.push([command, args]);
      return { status: 0, stdout: '{"ok":true}', stderr: '' };
    },
    now: (() => { let value = 0; return () => value += 10; })(),
  });

  assert.deepEqual(invocations, [
    ['./tools/kb-devkit/kb-devkit', ['run', 'build', '--packages', 'kb-runner', '--concurrency', '1', '--json']],
    ['./tools/kb-devkit/kb-devkit', ['run', 'test', '--packages', 'kb-runner', '--concurrency', '1', '--json']],
    ['./tools/kb-devkit/kb-devkit', ['check', '--internal-tool-package', 'kb-runner', '--json']],
  ]);
  assert.equal(result.name, 'internal-tool-tests:shard-1');
  assert.equal(result.selectedPackageCount, 1);
  assert.equal(result.status, 'pass');
});

// case: S-277.1
test('internal-tool stage retains stdout-only JSON failure evidence', async () => {
  const result = await runStage({
    stage: 'internal-tool-tests',
    packageNames: ['kb-runner'],
    selectedPackageCount: 1,
    shard: 1,
    runCommand: async (_command, args) => args[0] === 'run' && args[1] === 'test'
      ? { status: 1, stdout: '{"ok":false,"failures":["runner_test.go: failed"]}', stderr: '' }
      : { status: 0, stdout: '{"ok":true}', stderr: '' },
  });

  assert.equal(result.status, 'fail');
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /runner_test\.go: failed/);
});

// case: S-277.1
test('internal-tool failure evidence decodes task output and stores plain quotes once', async () => {
  const taskOutput = 'FAIL: TestRunner ("agent", "scheduler")';
  const result = await runStage({
    stage: 'internal-tool-tests',
    packageNames: ['kb-runner'],
    selectedPackageCount: 1,
    shard: 1,
    runCommand: async (_command, args) => args[0] === 'run' && args[1] === 'test'
      ? {
        status: 1,
        stdout: JSON.stringify({
          ok: false,
          data: { results: [{ OK: false, Package: 'kb-runner', Task: 'test', Stdout: taskOutput, Stderr: '' }] },
        }),
        stderr: '',
      }
      : { status: 0, stdout: '{"ok":true}', stderr: '' },
  });

  assert.equal(result.status, 'fail');
  assert.ok(result.failures.some((failure) => failure.includes(taskOutput)));
  assert.ok(result.failures.every((failure) => !failure.includes('\\"')));
});

// case: S-277.1
test('internal-tool package-check failure remains fail with its stdout evidence', async () => {
  const invocations = [];
  const result = await runStage({
    stage: 'internal-tool-tests',
    packageNames: ['kb-runner'],
    selectedPackageCount: 1,
    shard: 1,
    runCommand: async (_command, args) => {
      invocations.push(args);
      return args[0] === 'check'
        ? { status: 1, stdout: '{"ok":false,"issues":[{"check":"runner-package-rule","message":"package check failed"}]}', stderr: '' }
        : { status: 0, stdout: '{"ok":true}', stderr: '' };
    },
  });

  assert.equal(result.status, 'fail');
  assert.match(result.failures.join('\n'), /runner-package-rule.*package check failed/);
  assert.ok(invocations.some((args) => args[0] === 'check' && args.includes('--internal-tool-package')));
});
// case: S-262.7
test('journey unit shard records its failure instead of losing it before artifact upload', async () => {
  const result = await runStage({
    stage: profile.buildDependentTestStages.candidate[0],
    selectedPackageCount: 41,
    runCommand: async () => ({ status: 1, stdout: '', stderr: 'test failure' }),
    now: (() => { let value = 0; return () => value += 10; })(),
  });

  assert.equal(result.status, 'fail');
  assert.match(result.logTail, /test failure/);
  assert.equal(result.durationMs, 10);
  assert.equal(result.selectedPackageCount, 41);
});

// case: S-262.7
test('failed kb-devkit task contributes the task log tail identified by structured JSON', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'remote-stage-task-log-'));
  const fixtureRoot = path.join(temporaryRoot, 'workspace');
  const packageRoot = path.join(fixtureRoot, 'packages/site');
  const configPath = path.join(fixtureRoot, 'devkit.yaml');
  const binary = path.join(temporaryRoot, 'kb-devkit');
  const home = path.join(temporaryRoot, 'home');
  try {
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@fixture/site' }));
    writeFileSync(configPath, [
      'workspace:',
      '  categories:',
      '    site:',
      '      match: ["packages/site"]',
      '      preset: node-lib',
      'tasks:',
      '  build:',
      '    - categories: [site]',
      `      command: 'sh -c "echo ENOENT: no such file or directory, mkdir .next/export; echo Error occurred prerendering page /404; exit 1"'`,
      '',
    ].join('\n'));
    initializeTrackedWorkspace(fixtureRoot);
    execFileSync('go', ['build', '-o', binary, '.'], { cwd: path.join(repoRoot, 'tools/kb-devkit'), stdio: 'pipe' });

    let invocation;
    let childEnvironment;
    const result = await runStage({
      stage: profile.buildStage,
      packages: ['@fixture/site'],
      selectedPackageCount: 1,
      buildLimits: { cpuCount: 2, memoryBudgetBytes: 1_000_000, concurrency: 2, expectedTaskFootprintBytes: 500_000 },
      runCommand: async (command, args, options) => {
        invocation = [command, args];
        childEnvironment = options.env;
        return spawnSync(binary, ['--config', configPath, ...args], {
          cwd: fixtureRoot,
          encoding: 'utf8',
          env: { ...process.env, ...options.env, NODE_OPTIONS: '', HOME: home },
        });
      },
      now: (() => { let value = 0; return () => value += 10; })(),
    });

    assert.deepEqual(invocation, ['./tools/kb-devkit/kb-devkit', ['run', 'build', '--packages', '@fixture/site', '--concurrency', '2', '--json']]);
    assert.deepEqual(childEnvironment, {});
    assert.equal(result.status, 'fail');
    assert.ok(result.failures.some((line) => line.includes('@fixture/site:build — command exited with code 1')));
    assert.ok(result.taskFailures[0].logTail.includes('Error occurred prerendering page /404'));
    assert.ok(result.logTail.includes('Error occurred prerendering page /404'));
    assert.ok(readFileSync(result.taskFailures[0].logPath, 'utf8').includes('ENOENT: no such file or directory, mkdir .next/export'));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

// case: S-262.7
test('workspace build failures come from structured task errors, not streamed build output', async () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'remote-stage-structured-errors-'));
  const fixtureRoot = path.join(temporaryRoot, 'workspace');
  const packagesRoot = path.join(fixtureRoot, 'packages');
  const configPath = path.join(fixtureRoot, 'devkit.yaml');
  const binary = path.join(temporaryRoot, 'kb-devkit');
  const packageNames = ['mind', 'release', 'qa', 'agents', 'commit', 'quality'].map((name) => `@kb-labs/${name}`);
  const diagnostic = 'Error [ERR_WORKER_OUT_OF_MEMORY]: Worker terminated due to reaching memory limit: JS heap out of memory';
  try {
    for (const [index, packageName] of packageNames.entries()) {
      const packageRoot = path.join(packagesRoot, String(index));
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: packageName }));
    }
    writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    writeFileSync(configPath, [
      'workspace:',
      '  categories:',
      '    app:',
      '      match: ["packages/*"]',
      '      preset: node-lib',
      'tasks:',
      '  build:',
      '    - categories: [app]',
      '      command: >-',
      `        node -e 'console.log("ESM dist/core/services.js.map 72.00 B"); console.error("${diagnostic}"); process.exit(1)'`,
      '',
    ].join('\n'));
    initializeTrackedWorkspace(fixtureRoot);
    execFileSync('go', ['build', '-o', binary, '.'], { cwd: path.join(repoRoot, 'tools/kb-devkit'), stdio: 'pipe' });

    const result = await runStage({
      stage: profile.buildStage,
      packages: packageNames,
      selectedPackageCount: packageNames.length,
      buildLimits: { cpuCount: 4, memoryBudgetBytes: 11_736_487_526, concurrency: 4, expectedTaskFootprintBytes: 2_536_468_480 },
      runCommand: async (command, args, options) => spawnSync(binary, ['--config', configPath, ...args], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: { ...process.env, ...options.env, NODE_OPTIONS: '', HOME: path.join(temporaryRoot, 'home') },
      }),
    });

    assert.equal(result.status, 'fail');
    assert.equal(result.taskFailures.length, packageNames.length);
    assert.deepEqual(result.taskFailures.map((failure) => failure.package).sort(), packageNames.slice().sort());
    assert.ok(result.taskFailures.every((failure) => failure.task === 'build' && failure.exitCode === 1));
    assert.ok(result.taskFailures.every((failure) => failure.structuredResult.OK === false));
    assert.ok(result.taskFailures.every((failure) => failure.structuredResult.Package === failure.package));
    assert.ok(result.taskFailures.every((failure) => failure.structuredResult.Stderr.includes(diagnostic)));
    assert.deepEqual(result.failures.slice().sort(), packageNames.map((name) => `${name}:build — ${diagnostic}`).sort());
    assert.ok(result.taskFailures.every((failure) => failure.errorLine === diagnostic));
    assert.ok(!result.failures.some((failure) => failure.includes('ESM dist/core/services.js.map')));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function initializeTrackedWorkspace(root) {
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '--all'], { cwd: root });
}
