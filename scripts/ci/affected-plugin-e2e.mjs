#!/usr/bin/env node
/**
 * Compute the affected per-plugin E2E matrix for CI.
 *
 * Reuses kb-devkit's REAL affected engine (transitive over the workspace dep
 * graph) — it does NOT re-derive "what changed". It takes the set of affected
 * package names (from `kb-devkit run <task> --affected --json` → results[].Package)
 * and marks a plugin-e2e suite affected when that suite's own workspace
 * dependencies intersect the affected set. (E2E packages have no build/lint/test
 * task, so they never appear in kb-devkit's task results directly; this bridges
 * the suite → its plugin packages using the suite's declared deps.)
 *
 * Source of truth for the suite list = the `plugin-e2e-suite` devkit category.
 *
 * Usage:
 *   kb-devkit run build --affected --diff-only --json | node scripts/ci/affected-plugin-e2e.mjs
 *   node scripts/ci/affected-plugin-e2e.mjs --packages @kb-labs/mind/core,@kb-labs/sdk
 *   node scripts/ci/affected-plugin-e2e.mjs --changed-files /tmp/changed-files
 *
 * Output (stdout, one line): {"suites":["mind"],"include":[{"suite":"mind"}]}
 *   - `suites`  — unique affected plugin-e2e suite names
 *   - `include` — GitHub Actions matrix `include` entries (empty array → no shards)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The plugin-e2e matrix — mirror of devkit.yaml `plugin-e2e-suite` category.
// suite = e2e/<dir>; deps are read live from that package's package.json.
const PLUGIN_E2E_SUITES = ['mind', 'workflows', 'marketplace', 'plugins'];

function suiteWorkspaceDeps(suite) {
  const pj = path.join(REPO_ROOT, 'e2e', suite, 'package.json');
  if (!fs.existsSync(pj)) {
    return [];
  }
  const json = JSON.parse(fs.readFileSync(pj, 'utf8'));
  const all = { ...(json.dependencies ?? {}), ...(json.devDependencies ?? {}) };
  return Object.keys(all).filter((d) => d.startsWith('@kb-labs/'));
}

function readAffectedFromArgs() {
  const i = process.argv.indexOf('--packages');
  if (i !== -1 && process.argv[i + 1]) {
    return process.argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
  }
  return null;
}

function readAffectedFromStdin() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    return [];
  }
  if (!raw.trim()) {
    return [];
  }
  const data = JSON.parse(raw);
  // kb-devkit `run --json` → { results: [{ Package, ... }] }
  const results = data.results ?? [];
  return results.map((r) => r.Package ?? r.package).filter(Boolean);
}

function readChangedFilesFromArgs() {
  const i = process.argv.indexOf('--changed-files');
  if (i === -1 || !process.argv[i + 1]) {
    return [];
  }
  return fs
    .readFileSync(process.argv[i + 1], 'utf8')
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean);
}

export function computeSuites({ affected = [], changedFiles = [] } = {}) {
  const globalInvalidator = changedFiles.some((file) =>
    /^(\.github\/workflows\/|e2e\/(shared|platform|publisher)\/|e2e\/docker-compose[^/]*$|scripts\/ci\/|devkit\.yaml$|pnpm-lock\.yaml$)/.test(file),
  );

  if (globalInvalidator) {
    return [...PLUGIN_E2E_SUITES];
  }

  const affectedSet = new Set(affected);
  const changedSuiteDirs = new Set(
    changedFiles
      .map((file) => file.match(/^e2e\/([^/]+)\//)?.[1])
      .filter((suite) => PLUGIN_E2E_SUITES.includes(suite)),
  );

  return PLUGIN_E2E_SUITES.filter(
    (suite) =>
      changedSuiteDirs.has(suite) ||
      suiteWorkspaceDeps(suite).some((dep) => affectedSet.has(dep)),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const affected = readAffectedFromArgs() ?? readAffectedFromStdin();
  const suites = computeSuites({
    affected,
    changedFiles: readChangedFilesFromArgs(),
  });

  process.stdout.write(
    JSON.stringify({ suites, include: suites.map((suite) => ({ suite })) }) + '\n',
  );
}
