#!/usr/bin/env node
/**
 * check-manifest-command-naming — command naming rules for `kb.plugin/3` manifests.
 *
 * Task 0.5. Reference: docs/architecture/target/06-command-naming.md sections 1-3.
 *
 * Rules (ids):
 *   command-verb-vocabulary  the last segment of a multi-segment command path is a verb from
 *                            the closed vocabulary (list show add remove create delete install
 *                            uninstall enable disable get set update run status doctor start stop).
 *                            Single-segment paths (`kb <namespace>` default command) are not checked.
 *   command-path-case        every path segment is lowercase kebab-case ([a-z][a-z0-9]*(-[a-z0-9]+)*).
 *   command-operation-type   operationType, when set, is read | mutate | analyze | execute.
 *   mutate-json-flag         a command with operationType 'mutate' declares a `--json` flag.
 *
 * `--dry-run` for mutate commands is intentionally NOT checked: the registry injects it for
 * every command that declares operationType 'mutate' (cli/commands/src/registry/archetype-flags.ts,
 * applied in registry/service.ts), so a manifest cannot lack it at runtime. `--json` is NOT
 * injected (mutate gets `--output`, `--dry-run`, `--yes`), hence the explicit check.
 *
 * Source: the build-emitted `dist/manifest.json` of every plugin package whose package.json
 * declares `kb.manifest` (fully resolved, so flags built via helpers are visible). Packages
 * that are not built yet yield a `manifest-not-built` warning (not an error) — run the build
 * first for a complete result. With KB_DEVKIT_BASE_REF set (CI) the lint is affected-aware: an
 * unbuilt package with changed files still warns, an unchanged unbuilt one is skipped silently, built
 * ones are always linted; if the diff cannot be computed it falls back to reporting every unbuilt one.
 *
 * Existing violations live in scripts/checks/boundary-exceptions.json (target = command path).
 * Note: the older scripts/checks/check-cli-naming.mjs (ADR-0018 namespace rules) is separate.
 *
 * Devkit custom check (runs once, anchored to @kb-labs/devkit).
 * Standalone: node scripts/checks/check-manifest-command-naming.mjs [--root <dir>] [--json] [--no-exceptions]
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { findPluginEntryPackages, runLint } from './lib/boundary-common.mjs';

export const CHECK_NAME = 'manifest-command-naming';
export const RULES = ['command-verb-vocabulary', 'command-path-case', 'mutate-json-flag', 'command-operation-type'];

export const VERBS = new Set([
  'list', 'show', 'add', 'remove', 'create', 'delete', 'install', 'uninstall',
  'enable', 'disable', 'get', 'set', 'update', 'run', 'status', 'doctor', 'start', 'stop',
]);

// read/mutate/analyze per 06 section 3; 'execute' is a valid fourth type (author decision).
export const OPERATION_TYPES = new Set(['read', 'mutate', 'analyze', 'execute']);

const KEBAB_SEGMENT = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Validate one manifest's cli.commands.
 * @returns {{ rule: string, target: string, message: string, fix: string }[]}
 */
export function validateManifest(manifest) {
  const out = [];
  if (manifest?.schema !== 'kb.plugin/3') return out;
  const seen = new Set();
  for (const cmd of manifest.cli?.commands ?? []) {
    const path = typeof cmd?.path === 'string' ? cmd.path.trim() : '';
    if (!path) continue;
    const segments = path.split(/\s+/);

    const report = (rule, message, fix) => {
      const key = `${rule}\u0000${path}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ rule, target: path, message: `"${path}" — ${message}`, fix });
    };

    const badSegment = segments.find((s) => !KEBAB_SEGMENT.test(s));
    if (badSegment !== undefined) {
      report(
        'command-path-case',
        `segment "${badSegment}" is not lowercase kebab-case`,
        'Use lowercase kebab-case path segments (06-command-naming.md section 1).',
      );
    }

    if (segments.length > 1) {
      const verb = segments[segments.length - 1];
      if (!VERBS.has(verb)) {
        report(
          'command-verb-vocabulary',
          `verb "${verb}" is not in the closed vocabulary (${[...VERBS].join(', ')})`,
          'Rename to a vocabulary verb, or propose a new verb through review (06-command-naming.md section 2).',
        );
      }
    }

    if (cmd.operationType !== undefined && !OPERATION_TYPES.has(cmd.operationType)) {
      report(
        'command-operation-type',
        `operationType "${cmd.operationType}" is not one of ${[...OPERATION_TYPES].join(', ')}`,
        'Use read, mutate, analyze or execute.',
      );
    }

    if (cmd.operationType === 'mutate') {
      const flags = Array.isArray(cmd.flags) ? cmd.flags : Object.entries(cmd.flags ?? {}).map(([name, f]) => ({ ...f, name }));
      if (!flags.some((f) => f?.name === 'json')) {
        report(
          'mutate-json-flag',
          "operationType 'mutate' must declare a --json flag (--dry-run is injected by the registry)",
          "Add a boolean `json` flag to the command's flags.",
        );
      }
    }
  }
  return out;
}

/**
 * Files changed vs KB_DEVKIT_BASE_REF (`a...b`, `a..b` or a bare ref; CI sets the merge-base form).
 * @returns {{ files: string[] } | { error: string }}
 */
export function changedFiles(root, ref) {
  const r = spawnSync('git', ['diff', '--name-only', ref], { cwd: root, encoding: 'utf-8' });
  if (r.error || r.status !== 0) {
    return { error: (r.error?.message ?? r.stderr ?? '').trim() || `git diff exited ${r.status}` };
  }
  return { files: r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) };
}

export function collect(root, env = process.env) {
  const violations = [];
  const baseRef = env.KB_DEVKIT_BASE_REF;
  let changed = null; // null = not affected-aware: every unbuilt package is reported
  if (baseRef) {
    const res = changedFiles(root, baseRef);
    if ('error' in res) {
      violations.push({
        rule: 'manifest-diff-unavailable',
        severity: 'warning',
        package: '(workspace)',
        target: baseRef,
        file: 'plugins',
        message: `cannot compute changed files against ${baseRef} (${res.error}); reporting every unbuilt plugin manifest (shallow clone?)`,
      });
    } else {
      changed = res.files;
    }
  }
  /** unbuilt packages with no changes: skipped silently, still not judgeable for stale exceptions */
  const skipped = [];
  /** packages whose manifest could not be read (their exceptions cannot be judged stale) */
  const unscanned = [];
  for (const pkg of findPluginEntryPackages(root)) {
    const manifestRel = pkg.json?.kb?.manifest;
    if (typeof manifestRel !== 'string') continue;
    // dist/manifest.json sits next to the compiled manifest module
    const jsonPath = join(pkg.dir, manifestRel.replace(/\.[cm]?js$/, '.json'));
    if (!existsSync(jsonPath)) {
      if (changed && !changed.some((f) => f.startsWith(`${pkg.relDir}/`))) skipped.push(pkg.relDir);
      else unscanned.push(pkg.relDir);
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    } catch (err) {
      unscanned.push(pkg.relDir);
      violations.push({
        rule: 'manifest-unreadable',
        severity: 'error',
        package: pkg.relDir,
        target: manifestRel,
        file: `${pkg.relDir}/package.json`,
        message: `${pkg.relDir}: cannot parse ${manifestRel.replace(/\.[cm]?js$/, '.json')}: ${err.message}`,
      });
      continue;
    }
    for (const v of validateManifest(manifest)) {
      violations.push({
        ...v,
        package: pkg.relDir,
        file: `${pkg.relDir}/${manifestRel.replace(/^\.\//, '')}`,
        message: `${pkg.relDir}: ${v.message}`,
      });
    }
  }
  if (unscanned.length > 0) {
    violations.push({
      rule: 'manifest-not-built',
      severity: 'warning',
      package: '(workspace)',
      target: 'dist/manifest.json',
      unscanned,
      file: 'plugins',
      message: `${unscanned.length} plugin manifest(s) not built, command names not linted (run \`kb-devkit run build\` first): ${unscanned.join(', ')}`,
    });
  }
  if (skipped.length > 0) {
    violations.push({
      rule: 'manifest-not-built',
      severity: 'info',
      silent: true,
      package: '(workspace)',
      target: 'dist/manifest.json',
      unscanned: skipped,
      file: 'plugins',
      message: `${skipped.length} unchanged plugin manifest(s) not built, skipped`,
    });
  }
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runLint({ name: CHECK_NAME, rules: RULES, collect });
}
