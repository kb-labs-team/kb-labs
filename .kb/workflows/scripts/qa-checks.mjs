#!/usr/bin/env node
// Step: QA Checks (diff-aware, local, fast)
// Env: ISSUE_NUMBER, BASE_BRANCH
import { spawnSync } from 'node:child_process';
import { run, workspaceRoot, emitKbOutput } from './lib/kb.mjs';

process.chdir(workspaceRoot());

const { BASE_BRANCH } = process.env;

// Type-check affected packages before running QA — catches TS errors that CI
// would catch later, preventing a commit→CI-fail→fix loop.
console.log('Running type-check on affected packages...');
const typeCheck = spawnSync('kb-devkit', ['run', 'type-check', '--affected'], { stdio: 'inherit' });
if (typeCheck.status !== 0) {
  emitKbOutput({ status: 'failed', blockers: ['type-check failed — fix TS errors before commit'], warnings: [] });
  process.exit(1);
}

const qaCheck = run('kb-devkit', ['check', '--only', 'new-tests', '--json'], {
  allowFailure: true,
  env: { ...process.env, KB_DEVKIT_BASE_REF: BASE_BRANCH },
});
const qaResultRaw = qaCheck.stdout || '{}';

let qaResult = {};
try {
  qaResult = JSON.parse(qaResultRaw);
} catch {
  qaResult = null;
}

if (qaResult === null) {
  emitKbOutput({ status: 'failed', blockers: ['kb-devkit check --only new-tests --json returned invalid JSON'], warnings: [] });
  process.exit(1);
}

const checkData = qaResult.data?.packages ?? qaResult.packages ?? {};
const issues = Object.values(checkData).flatMap((pkg) => pkg.issues ?? []);
const blockers = issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message);
const warnings = issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.message);
if (qaCheck.status !== 0 && blockers.length === 0) {
  const error = qaResult.error;
  const detail = [error?.message, error?.cause, error?.hint].filter(Boolean).join(' ');
  blockers.push(detail || 'kb-devkit check --only new-tests --json failed');
}
const status = blockers.length > 0 ? 'failed' : warnings.length > 0 ? 'warning' : 'passed';

for (const warning of warnings) console.log(warning);
emitKbOutput({ status, blockers, warnings, result: qaResult });
if (status === 'failed') process.exit(1);
