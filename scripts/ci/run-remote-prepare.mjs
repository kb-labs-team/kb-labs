#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedTail, cacheRecord } from './remote-verify-stage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function runPrepareStage({ env = process.env, runCommand = defaultRunCommand, now = Date.now } = {}) {
  const resultPath = env.REMOTE_PREPARE_RESULT;
  if (!resultPath) throw new Error('REMOTE_PREPARE_RESULT is required by the remote prepare stage.');
  const profile = env.VERIFICATION_PROFILE;
  const affectedPath = env.REMOTE_AFFECTED_PACKAGES;
  const planPath = env.REMOTE_TEST_PLAN;
  const started = now();
  let selectedPackageCount = 0;
  let selectionReason = '';
  let selectionMode = 'full';
  let selectionBaseSha = '';
  let selectedPackages = [];
  const operations = [];
  const failures = [];

  const commands = [
    { name: 'install-workspace-dependencies', command: 'corepack', args: ['pnpm', 'install', '--frozen-lockfile'], cwd: root },
    { name: 'build-kb-devkit', command: 'make', args: ['build'], cwd: path.join(root, 'tools/kb-devkit') },
    {
      name: 'resolve-package-selection', command: process.execPath,
      args: ['scripts/ci/resolve-remote-selection.mjs', profile, affectedPath, './tools/kb-devkit/kb-devkit'], cwd: root,
    },
    {
      name: 'plan-test-matrix', command: process.execPath,
      args: ['scripts/ci/remote-verify-plan.mjs', profile, affectedPath, planPath, env.GITHUB_OUTPUT], cwd: root,
    },
  ];

  for (const item of commands) {
    const operationStarted = now();
    let commandResult;
    try {
      commandResult = runCommand(item.command, item.args, { cwd: item.cwd, env });
    } catch (error) {
      commandResult = { status: null, stdout: '', stderr: '', error };
    }
    const operationFinished = now();
    const output = [commandResult.stdout, commandResult.stderr, commandResult.error?.message].filter(Boolean).join('\n');
    const succeeded = commandResult.status === 0;
    const operation = {
      name: item.name,
      command: item.command,
      args: item.args,
      status: succeeded ? 'pass' : 'fail',
      durationMs: Math.max(0, operationFinished - operationStarted),
      logTail: boundedTail(output),
    };

    if (succeeded && item.name === 'resolve-package-selection') {
      try {
        const selection = JSON.parse(readFileSync(affectedPath, 'utf8'));
        if (!Number.isSafeInteger(selection.selectedPackageCount) || selection.selectedPackageCount < 0 || typeof selection.data?.selectionReason !== 'string' || !['affected', 'full'].includes(selection.data?.mode) || !/^[0-9a-f]{40}$/.test(selection.data?.baseSha ?? '') || !Array.isArray(selection.data?.packages)) {
          throw new Error('selection result is missing its package list, mode, base SHA, or reason');
        }
        selectedPackageCount = selection.selectedPackageCount;
        selectionReason = selection.data.selectionReason;
        selectionMode = selection.data.mode;
        selectionBaseSha = selection.data.baseSha;
        selectedPackages = selection.data.packages;
      } catch (error) {
        operation.status = 'fail';
        operation.logTail = error.message;
      }
    }

    operations.push(operation);
    if (operation.status === 'fail') {
      const exit = commandResult.status === null || commandResult.status === undefined ? 'unavailable' : commandResult.status;
      failures.push(`${item.name} failed with exit status ${exit}`);
      break;
    }
  }

  const finished = now();
  const stage = {
    name: 'prepare',
    status: failures.length === 0 ? 'pass' : 'fail',
    selectedPackageCount,
    selectionReason,
    selectionMode,
    selectionBaseSha,
    selectedPackages,
    failures,
    logTail: boundedTail(operations.map((operation) => operation.logTail).filter(Boolean).join('\n')),
    operations,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: Math.max(0, finished - started),
    cache: cacheRecord({ pnpm: env.PNPM_CACHE_HIT, go: env.GO_CACHE_HIT }),
  };
  writeFileSync(resultPath, `${JSON.stringify(stage, null, 2)}\n`);
  return stage;
}

function defaultRunCommand(command, args, options) {
  return spawnSync(command, args, { ...options, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const stage = runPrepareStage();
process.stdout.write(`prepare: ${stage.status} (${stage.durationMs} ms)\n`);
for (const failure of stage.failures) process.stdout.write(`${failure}\n`);
if (stage.logTail) process.stdout.write(`${stage.logTail}\n`);
if (stage.status !== 'pass') process.exitCode = 1;
