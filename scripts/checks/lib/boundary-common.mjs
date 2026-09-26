/**
 * Shared helpers for the boundary / naming lints (tasks 0.2, 0.3, 0.5).
 *
 * Every lint is a pure `collect(root)` function returning raw violations, plus a
 * thin runner (`runLint`) that applies the shared exceptions file, reports stale
 * exceptions and speaks the devkit custom-check protocol (TypedCheckOutput v2,
 * same shape as check-ports / check-marketplace-lock).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

export const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const DEFAULT_EXCEPTIONS_FILE = resolve(HERE, '..', 'boundary-exceptions.json');
export const ANCHOR_PACKAGE = '@kb-labs/devkit';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.kb', '.turbo', 'coverage', 'build', '.next']);

// ─── Filesystem ──────────────────────────────────────────────────────────────

/** Repo-relative POSIX path. */
export function rel(root, abs) {
  return relative(root, abs).split(sep).join('/');
}

/**
 * Find package.json directories under `<root>/<base>` up to `maxDepth` levels
 * below `base` (mirrors devkit's `workspace.maxDepth`). Fixture packages are skipped.
 * @returns {{ dir: string, relDir: string, json: object }[]}
 */
export function findPackages(root, base, maxDepth = 3) {
  const out = [];
  const start = join(root, base);
  if (!existsSync(start)) return out;

  const walk = (dir, depth) => {
    const pj = join(dir, 'package.json');
    if (depth > 0 && existsSync(pj)) {
      try {
        out.push({ dir, relDir: rel(root, dir), json: JSON.parse(readFileSync(pj, 'utf-8')) });
      } catch {
        /* unparseable package.json is somebody else's problem */
      }
    }
    if (depth >= maxDepth) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name === 'fixtures') continue;
      walk(join(dir, e.name), depth + 1);
    }
  };
  walk(start, 0);
  return out;
}

/**
 * Real plugin packages: those that ship a `kb.plugin/3` manifest (package.json `kb.manifest`,
 * and the manifest source — or the built dist JSON — declares schema `kb.plugin/3`).
 * Daemons, engines, registries, runtimes and plain core/contracts packages under plugins/
 * are platform parts, not plugins, and are not returned.
 */
export function findPluginEntryPackages(root) {
  const out = [];
  for (const pkg of findPackages(root, 'plugins')) {
    const manifestRel = pkg.json?.kb?.manifest;
    if (typeof manifestRel !== 'string') continue;
    const candidates = [
      join(pkg.dir, 'src', 'manifest.ts'),
      join(pkg.dir, 'src', 'manifest.v3.ts'),
      join(pkg.dir, manifestRel.replace(/\.[cm]?js$/, '.json')),
    ];
    if (candidates.some((f) => /kb\.plugin\/3/.test(readText(f)))) out.push(pkg);
  }
  return out;
}

const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(?:test|spec|e2e)\.[cm]?[jt]sx?$|\.d\.ts$/;
const TEST_DIRS = new Set(['__tests__', '__mocks__', 'tests', 'test', 'e2e', 'fixtures', 'templates']);

/** Production source files of a package (tests, fixtures, build output, nested packages excluded). */
export function listSourceFiles(pkgDir) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || TEST_DIRS.has(e.name)) continue;
        // nested packages are scanned as their own package
        if (existsSync(join(dir, e.name, 'package.json'))) continue;
        walk(join(dir, e.name));
      } else if (e.isFile() && SOURCE_EXT.test(e.name) && !TEST_FILE.test(e.name)) {
        out.push(join(dir, e.name));
      }
    }
  };
  walk(pkgDir);
  return out;
}

export function readText(file) {
  try {
    if (!statSync(file).isFile()) return '';
    return readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

/** Blank out comments (keeping line structure) so commented-out code is not flagged. */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (_m, p1) => p1);
}

// ─── Exceptions ──────────────────────────────────────────────────────────────

/**
 * Exceptions file schema:
 * { "version": 1, "exceptions": [ { rule, package, target, since: "YYYY-MM-DD", reason } ] }
 * `target` is the offending import / dependency / command path / binary.
 */
export function loadExceptions(file = DEFAULT_EXCEPTIONS_FILE) {
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, 'utf-8'));
  const list = Array.isArray(data.exceptions) ? data.exceptions : [];
  for (const [i, ex] of list.entries()) {
    for (const k of ['rule', 'package', 'target', 'since', 'reason']) {
      if (typeof ex[k] !== 'string' || ex[k].trim() === '') {
        throw new Error(`${file}: exceptions[${i}] is missing required string field "${k}"`);
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ex.since)) {
      throw new Error(`${file}: exceptions[${i}].since must be YYYY-MM-DD`);
    }
  }
  return list;
}

export const violationKey = (v) => `${v.rule}\u0000${v.package}\u0000${v.target}`;

/**
 * Split violations into allowed (matched by an exception) and blocking, and find
 * exceptions of the given rules that no longer match anything (stale).
 */
export function applyExceptions(violations, exceptions, rules) {
  const byKey = new Map(exceptions.map((e) => [violationKey(e), e]));
  const used = new Set();
  const blocking = [];
  const allowed = [];
  for (const v of violations) {
    const k = violationKey(v);
    if (byKey.has(k)) {
      used.add(k);
      allowed.push(v);
    } else {
      blocking.push(v);
    }
  }
  // Packages a lint could not scan (e.g. manifest not built) cannot have their exceptions judged stale.
  const unscanned = new Set(violations.flatMap((v) => v.unscanned ?? []));
  const stale = exceptions.filter((e) => rules.includes(e.rule) && !used.has(violationKey(e)) && !unscanned.has(e.package));
  return { blocking, allowed, stale };
}

// ─── Runner ──────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.name       check name
 * @param {string[]} opts.rules    rule ids this lint owns (for stale detection)
 * @param {(root: string) => object[]} opts.collect
 * @param {string[]} [opts.argv]
 */
export async function runLint({ name, rules, collect, argv = process.argv.slice(2) }) {
  const flag = (n) => argv.includes(n);
  const opt = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = resolve(opt('--root') ?? REPO_ROOT);
  const exceptionsFile = resolve(opt('--exceptions') ?? DEFAULT_EXCEPTIONS_FILE);
  const useExceptions = !flag('--no-exceptions');

  const devkitMode = Boolean(process.env.KB_DEVKIT_MODE);
  if (devkitMode) {
    let pkgName = process.env.KB_DEVKIT_PACKAGE_NAME ?? '';
    if (!pkgName) {
      try {
        const chunks = [];
        process.stdin.resume();
        process.stdin.setEncoding('utf-8');
        await new Promise((res) => {
          process.stdin.on('data', (c) => chunks.push(c));
          process.stdin.on('end', () => res());
          setTimeout(() => res(), 50);
        });
        const raw = chunks.join('');
        if (raw) pkgName = JSON.parse(raw)?.name ?? '';
      } catch {
        /* no JSON on stdin */
      }
    }
    if (pkgName !== ANCHOR_PACKAGE) {
      process.stdout.write(JSON.stringify({ issues: [] }) + '\n');
      return 0;
    }
  }

  const raw = collect(root);
  const exceptions = useExceptions ? loadExceptions(exceptionsFile) : [];
  const { blocking, allowed, stale } = applyExceptions(raw, exceptions, rules);

  const issues = [
    ...blocking.filter((v) => !v.silent).map((v) => ({
      check: name,
      severity: v.severity ?? 'error',
      message: v.message,
      file: v.file ?? v.package,
      ...(v.fix ? { fix: v.fix } : {}),
    })),
    ...stale.map((e) => ({
      check: name,
      severity: 'warning',
      message: `Stale exception (no matching violation any more): ${e.rule} ${e.package} -> ${e.target}. Remove it from scripts/checks/boundary-exceptions.json.`,
      file: 'scripts/checks/boundary-exceptions.json',
    })),
  ];

  if (devkitMode) {
    process.stdout.write(JSON.stringify({ issues }) + '\n');
    return 0; // devkit aggregates severity
  }

  if (flag('--json')) {
    process.stdout.write(
      JSON.stringify(
        { name, total: raw.length, allowed: allowed.length, blocking: blocking.length, stale: stale.length, violations: raw, issues },
        null,
        2,
      ) + '\n',
    );
  } else {
    for (const i of issues) process.stderr.write(`${i.severity.toUpperCase()}: ${i.message}\n`);
    process.stdout.write(
      `${name}: ${raw.length} violation(s) found, ${allowed.length} covered by exceptions, ${blocking.length} blocking, ${stale.length} stale exception(s)\n`,
    );
  }
  return blocking.some((v) => (v.severity ?? 'error') === 'error') ? 1 : 0;
}
