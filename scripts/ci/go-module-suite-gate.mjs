#!/usr/bin/env node
import { writeCheckResult } from '../checks/lib/check-result.mjs';
import { spawnSync } from 'node:child_process';

const workspaceRoot = process.env.KB_DEVKIT_WORKSPACE_ROOT ?? process.cwd();
const checkName = process.env.KB_DEVKIT_CHECK_NAME;
const rerunCommand = `kb-devkit check --only ${checkName}`;
const suiteEnv = { ...process.env, KB_DEVKIT_CHECK_RERUN: rerunCommand };
const result = spawnSync(process.execPath, ['scripts/ci/go-module-suite.mjs'], {
  cwd: workspaceRoot,
  encoding: 'utf8',
  env: suiteEnv,
});
const message = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join('\n').trim()
  || `Go module suite exited ${result.status}`;
const issues = result.status === 0 ? [] : [{
  check: checkName,
  severity: 'error',
  message,
  fix: `Rerun with: ${rerunCommand}`,
  file: workspaceRoot,
}];
writeCheckResult(issues);
process.exitCode = result.status === 0 ? 0 : 1;
