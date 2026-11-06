#!/usr/bin/env node
import { writeCheckResult } from './lib/check-result.mjs';
/**
 * check-marketplace-lock — validates the workspace lock under the scope
 * assigned to its root by the runtime root resolver.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { validateMarketplaceLockAtRoot } = await import('@kb-labs/core-discovery');
const { resolveRoots } = await import('../../core/workspace/dist/index.js');

const CHECK_NAME = 'check-marketplace-lock';
const DEVKIT_MODE = Boolean(process.env.KB_DEVKIT_MODE);
const WORKSPACE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LOCK_ROOT = process.env.KB_MARKETPLACE_LOCK_ROOT ?? WORKSPACE_ROOT;

export async function checkMarketplaceLock(root, roots) {
  const lockPath = join(root, '.kb', 'marketplace.lock');
  if (!existsSync(lockPath)) {return [];}

  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
  } catch (error) {
    return [issue(`.kb/marketplace.lock is not valid JSON: ${error.message}`)];
  }

  const validation = await validateMarketplaceLockAtRoot(lock, roots, root);
  if (!validation.valid) {
    const subject = validation.entry ? `"${validation.entry}"` : '.kb/marketplace.lock';
    const remediation = `Run "kb marketplace sync --scope ${validation.scope}" to regenerate .kb/marketplace.lock.`;
    return [issue(`${subject}: ${validation.reason}. ${remediation}`)];
  }

  return [];
}

function issue(message) {
  return { check: CHECK_NAME, severity: 'error', message, file: '.kb/marketplace.lock' };
}

function printHuman(issues) {
  if (issues.length === 0) {
    process.stdout.write(`${CHECK_NAME}: OK — marketplace.lock entries use schema v3\n`);
    return;
  }
  for (const item of issues) {process.stderr.write(`ERROR: ${item.message}\n`);}
  process.stderr.write(`\n${CHECK_NAME}: ${issues.length} error(s) found\n`);
}

async function main() {
  const roots = await resolveRoots({
    moduleUrl: import.meta.url,
    startDir: WORKSPACE_ROOT,
    env: process.env,
    projectScope: 'platform',
  });

  if (DEVKIT_MODE) {
    writeCheckResult(await checkMarketplaceLock(LOCK_ROOT, roots));
  } else {
    const issues = await checkMarketplaceLock(LOCK_ROOT, roots);
    printHuman(issues);
    process.exit(issues.some((item) => item.severity === 'error') ? 1 : 0);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
