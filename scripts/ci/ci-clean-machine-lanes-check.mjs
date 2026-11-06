#!/usr/bin/env node
import { writeCheckResult } from '../checks/lib/check-result.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const checks = [
  ['Go suite and workflow contract tests', [process.execPath, '--test', 'scripts/ci/go-module-suite.test.mjs']],
  ['Journey unit tests', ['python3', '-m', 'unittest', 'discover', '-s', 'e2e/journey', '-p', 'test_*.py']],
];
const checkName = process.env.KB_DEVKIT_CHECK_NAME;
const workspaceRoot = process.env.KB_DEVKIT_WORKSPACE_ROOT ?? process.cwd();
const issues = [];

function resolveGoCaches() {
  const result = spawnSync('go', ['env', 'GOMODCACHE', 'GOCACHE'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error('Could not resolve Go caches for the isolated HOME check: ' + (result.error?.message || result.stderr.trim()));
  }
  const [moduleCache, buildCache] = result.stdout.trim().split(/\r?\n/);
  if (!moduleCache || !buildCache) throw new Error('Go returned empty module or build cache paths.');
  return { GOMODCACHE: moduleCache, GOCACHE: buildCache };
}
const rerun = `Rerun with: kb-devkit check --only ${checkName}`;
const journeyHome = mkdtempSync(path.join(os.tmpdir(), 'kb-ci-clean-machine-home-'));
try {
  for (const [name, [command, ...args]] of checks) {
    const env = name === 'Journey unit tests'
      ? { ...process.env, ...resolveGoCaches(), HOME: journeyHome }
      : process.env;
    if (name === 'Journey unit tests') {
      for (const key of ['KB_PLATFORM_ROOT', 'KB_HOME', 'KB_NET_OFFSET', 'GOFLAGS']) delete env[key];
    }
    const result = spawnSync(command, args, { encoding: 'utf8', env });
    if (result.error || result.status !== 0) {
      const detail = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      issues.push({
        check: checkName,
        severity: 'error',
        message: `${name} failed.\n${detail}`,
        fix: rerun,
        file: workspaceRoot,
      });
    }
  }
} finally {
  try {
    rmSync(journeyHome, { recursive: true, force: true });
  } catch (error) {
    issues.push({
      check: checkName,
      severity: 'error',
      message: 'Could not remove isolated HOME: ' + error.message,
      fix: rerun,
      file: workspaceRoot,
    });
  }
}
writeCheckResult(issues);
process.exitCode = issues.length === 0 ? 0 : 1;
