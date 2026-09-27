#!/usr/bin/env node
/**
 * check-marketplace-lock — verifies .kb/marketplace.lock has no stale or malformed entries.
 *
 * Devkit external check (TypedCheckOutput v2). Self-filters to @kb-labs/devkit
 * so it runs exactly once (workspace-wide check, same pattern as check-ports
 * and check-assembly-hook).
 *   Input:  KB_DEVKIT_PACKAGE_NAME env or JSON on stdin
 *   Output: { issues: [{ check, severity, message, file }] }
 *
 * Rule: every `installed` entry's resolvedPath must exist on disk, and its
 * key must look like a real package id (`name` or `@scope/name`). Catches
 * drift (a package directory was deleted/moved but the lock entry wasn't)
 * and corruption (a malformed id/path written by a buggy install path)
 * before it rots silently for months — see the MKT-02 e2e diagnostics test,
 * which reads the same lock via `kb marketplace doctor`.
 *
 * Fix stale entries: `kb marketplace plugins link`/`unlink` the package again,
 * or remove the offending key from `.kb/marketplace.lock` by hand for a one-off.
 *
 * Standalone: node scripts/checks/check-marketplace-lock.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CHECK_NAME = 'check-marketplace-lock';
const ANCHOR_PACKAGE = '@kb-labs/devkit';
const DEVKIT_MODE = Boolean(process.env.KB_DEVKIT_MODE);

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const LOCK_PATH = join(ROOT, '.kb', 'marketplace.lock');

// @scope/name or bare name — no colons, no trailing slash, no path separators.
const VALID_ID = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

function validate() {
  const issues = [];

  if (!existsSync(LOCK_PATH)) {
    return issues; // no lock file — nothing to check
  }

  let lock;
  try {
    lock = JSON.parse(readFileSync(LOCK_PATH, 'utf-8'));
  } catch (err) {
    issues.push({
      check: CHECK_NAME,
      severity: 'error',
      message: `.kb/marketplace.lock is not valid JSON: ${err.message}`,
      file: '.kb/marketplace.lock',
    });
    return issues;
  }

  const installed = lock.installed ?? {};

  for (const [id, entry] of Object.entries(installed)) {
    if (!VALID_ID.test(id)) {
      issues.push({
        check: CHECK_NAME,
        severity: 'error',
        message: `.kb/marketplace.lock: malformed package id "${id}" — expected "name" or "@scope/name". Likely a corrupted install; remove or re-install this entry.`,
        file: '.kb/marketplace.lock',
      });
      continue;
    }

    const resolvedPath = entry?.resolvedPath;
    if (!resolvedPath || typeof resolvedPath !== 'string') {
      issues.push({
        check: CHECK_NAME,
        severity: 'error',
        message: `.kb/marketplace.lock: "${id}" has no resolvedPath.`,
        file: '.kb/marketplace.lock',
      });
      continue;
    }

    const full = join(ROOT, resolvedPath);
    if (!existsSync(full)) {
      issues.push({
        check: CHECK_NAME,
        severity: 'error',
        message: `.kb/marketplace.lock: "${id}" points at "${resolvedPath}", which no longer exists. Remove this entry from .kb/marketplace.lock (no CLI command prunes stale entries yet — "marketplace sync" only adds, "rehash" only rebuilds discovery hashes).`,
        file: '.kb/marketplace.lock',
      });
    }
  }

  return issues;
}

function printHuman(issues) {
  if (issues.length === 0) {
    process.stdout.write(`${CHECK_NAME}: OK — all marketplace.lock entries resolve\n`);
    return;
  }
  for (const i of issues) {
    process.stderr.write(`${i.severity.toUpperCase()}: ${i.message}\n`);
  }
  const errors = issues.filter((i) => i.severity === 'error').length;
  if (errors > 0) {
    process.stderr.write(`\n${CHECK_NAME}: ${errors} error(s) found\n`);
  }
}

if (DEVKIT_MODE) {
  let pkgName = process.env.KB_DEVKIT_PACKAGE_NAME ?? '';
  if (!pkgName) {
    try {
      const chunks = [];
      process.stdin.resume();
      process.stdin.setEncoding('utf-8');
      await new Promise((resolve) => {
        process.stdin.on('data', (c) => chunks.push(c));
        process.stdin.on('end', () => resolve());
        setTimeout(() => resolve(), 50);
      });
      const raw = chunks.join('');
      if (raw) pkgName = JSON.parse(raw)?.name ?? '';
    } catch { /* no JSON on stdin */ }
  }

  if (pkgName !== ANCHOR_PACKAGE) {
    process.stdout.write(JSON.stringify({ issues: [] }) + '\n');
    process.exit(0);
  }

  const issues = validate();
  process.stdout.write(JSON.stringify({ issues }) + '\n');
  process.exit(0); // devkit aggregates severity; never hard-fail the runner
} else {
  const issues = validate();
  printHuman(issues);
  process.exit(issues.some((i) => i.severity === 'error') ? 1 : 0);
}
