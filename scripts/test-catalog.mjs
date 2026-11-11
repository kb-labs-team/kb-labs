#!/usr/bin/env node
/**
 * test-catalog — static test case extractor
 *
 * Scans all *.test.ts and *.spec.ts files across the monorepo,
 * extracts describe/it/test block names, and writes docs/test-catalog.md.
 *
 * Usage:
 *   node scripts/test-catalog.mjs             # writes docs/test-catalog.md
 *   node scripts/test-catalog.mjs --json      # prints JSON to stdout
 *   node scripts/test-catalog.mjs --check     # exits 1 if catalog is stale
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT_PATH = join(ROOT, 'docs/test-catalog.md');

const FLAG_JSON = process.argv.includes('--json');
const FLAG_CHECK = process.argv.includes('--check');

// ── file discovery ────────────────────────────────────────────────────────────

const EXCLUDE_DIRS = new Set([
  'node_modules', 'dist', 'fixtures', '.git', 'coverage', 'report', 'templates',
  '.worktrees', 'worktrees', // git worktrees — would duplicate everything
]);

function* walkFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile() && /\.(test|spec)\.ts$/.test(entry.name)) {
      yield full;
    }
  }
}

// ── parser ────────────────────────────────────────────────────────────────────

/**
 * Extracts test cases from a single file.
 * Returns { describes: [{ name, tests: [string] }] }
 * Handles nested describes by flattening: "outer > inner".
 */
function parseFile(content) {
  const lines = content.split('\n');
  const stack = []; // describe stack
  const result = []; // { suite, tests }
  let currentSuite = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // describe('name', or describe("name",
    const describeMatch = trimmed.match(/^(?:describe|describe\.skip|describe\.only)\s*\(\s*(['"`])(.*?)\1/);
    if (describeMatch) {
      const name = describeMatch[2];
      const fullName = stack.length > 0 ? `${stack.map(s => s.name).join(' > ')} > ${name}` : name;
      const suite = { name: fullName, tests: [] };
      result.push(suite);
      stack.push({ name, suite });
      currentSuite = suite;
      continue;
    }

    // it('name', or test('name', or it.skip, test.todo
    const testMatch = trimmed.match(/^(?:it|test)(?:\.skip|\.only|\.todo|\.concurrent|\.sequential)?\s*\(\s*(['"`])(.*?)\1/);
    if (testMatch) {
      const name = testMatch[2];
      const suite = currentSuite ?? (result.length > 0 ? result[result.length - 1] : null);
      if (suite) {
        suite.tests.push(name);
      } else {
        // top-level test without describe
        const loose = result.find(s => s.name === '(root)') ?? (() => {
          const s = { name: '(root)', tests: [] };
          result.push(s);
          return s;
        })();
        loose.tests.push(name);
      }
      continue;
    }

    // closing brace — pop stack heuristic (very rough, good enough for flat structures)
    if (trimmed === '});' || trimmed === '})') {
      if (stack.length > 0) {
        stack.pop();
        currentSuite = stack.length > 0 ? stack[stack.length - 1].suite : null;
      }
    }
  }

  return result;
}

// ── level detection ───────────────────────────────────────────────────────────

function detectLevel(relPath) {
  if (relPath.includes('__tests__/cli') || relPath.endsWith('.cli.test.ts')) return 'cli';
  if (relPath.includes('/sse/') || relPath.includes('.sse.')) return 'sse';
  if (relPath.includes('/ws/') || relPath.includes('.ws.')) return 'ws';
  if (relPath.includes('e2e/') || relPath.includes('.e2e.') || relPath.includes('.spec.ts')) return 'e2e';
  if (relPath.includes('integration')) return 'integration';
  return 'unit';
}

// ── package name lookup ───────────────────────────────────────────────────────

const pkgNameCache = new Map();

function findPackageName(filePath) {
  let dir = dirname(filePath);
  while (dir !== ROOT && dir !== '/') {
    if (pkgNameCache.has(dir)) return pkgNameCache.get(dir);
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        pkgNameCache.set(dir, pkg.name ?? dir);
        return pkg.name ?? dir;
      } catch {
        // continue searching upward
      }
    }
    dir = dirname(dir);
  }
  return relative(ROOT, dirname(filePath));
}

// ── main ──────────────────────────────────────────────────────────────────────

const LEVEL_ORDER = ['cli', 'sse', 'ws', 'integration', 'e2e', 'unit'];
const LEVEL_LABEL = {
  cli:         'CLI handler tests',
  sse:         'SSE integration tests',
  ws:          'WebSocket integration tests',
  integration: 'Integration tests',
  e2e:         'E2E / journey tests',
  unit:        'Unit tests',
};

const catalog = {}; // { pkgName: { level: { file: [suites] } } }
let totalTests = 0;
let totalFiles = 0;

for (const file of walkFiles(ROOT)) {
  const rel = relative(ROOT, file);
  const pkg = findPackageName(file);
  const level = detectLevel(rel);

  let content;
  try {
    content = readFileSync(file, 'utf-8');
  } catch {
    continue;
  }

  const suites = parseFile(content);
  const testCount = suites.reduce((n, s) => n + s.tests.length, 0);
  if (testCount === 0) continue;

  totalTests += testCount;
  totalFiles++;

  catalog[pkg] ??= {};
  catalog[pkg][level] ??= {};
  catalog[pkg][level][rel] = suites;
}

if (FLAG_JSON) {
  process.stdout.write(JSON.stringify({ totalTests, totalFiles, catalog }, null, 2));
  process.exit(0);
}

// ── markdown renderer ─────────────────────────────────────────────────────────

const lines = [];

lines.push(`# Test Catalog`);
lines.push('');
lines.push(`> Auto-generated by \`node scripts/test-catalog.mjs\`. Do not edit by hand.  `);
lines.push(`> ${totalTests} test cases across ${totalFiles} files.`);
lines.push('');

// Summary table
lines.push('## Summary');
lines.push('');
lines.push('| Package | CLI | SSE | WS | Integration | E2E | Unit | Total |');
lines.push('|---|---|---|---|---|---|---|---|');

const pkgsSorted = Object.keys(catalog).sort();
const grandTotals = { cli: 0, sse: 0, ws: 0, integration: 0, e2e: 0, unit: 0 };

for (const pkg of pkgsSorted) {
  const byLevel = catalog[pkg];
  const counts = {};
  for (const level of LEVEL_ORDER) {
    const files = byLevel[level] ?? {};
    const n = Object.values(files).flatMap(s => s).reduce((acc, s) => acc + s.tests.length, 0);
    counts[level] = n;
    grandTotals[level] += n;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const shortPkg = pkg.replace('@kb-labs/', '');
  lines.push(`| \`${shortPkg}\` | ${counts.cli || '—'} | ${counts.sse || '—'} | ${counts.ws || '—'} | ${counts.integration || '—'} | ${counts.e2e || '—'} | ${counts.unit || '—'} | **${total}** |`);
}

const gTotal = Object.values(grandTotals).reduce((a, b) => a + b, 0);
lines.push(`| **Total** | **${grandTotals.cli || '—'}** | **${grandTotals.sse || '—'}** | **${grandTotals.ws || '—'}** | **${grandTotals.integration || '—'}** | **${grandTotals.e2e || '—'}** | **${grandTotals.unit || '—'}** | **${gTotal}** |`);

lines.push('');

// Per-package detail
lines.push('## Test Cases by Package');
lines.push('');

for (const pkg of pkgsSorted) {
  const byLevel = catalog[pkg];
  const hasSomething = Object.values(byLevel).some(files => Object.keys(files).length > 0);
  if (!hasSomething) continue;

  lines.push(`### \`${pkg}\``);
  lines.push('');

  for (const level of LEVEL_ORDER) {
    const files = byLevel[level];
    if (!files || Object.keys(files).length === 0) continue;

    lines.push(`#### ${LEVEL_LABEL[level]}`);
    lines.push('');

    for (const [relFile, suites] of Object.entries(files).sort()) {
      lines.push(`**\`${relFile}\`**`);
      lines.push('');

      for (const suite of suites) {
        if (suite.name !== '(root)') {
          lines.push(`- **${suite.name}**`);
          for (const t of suite.tests) {
            lines.push(`  - ${t}`);
          }
        } else {
          for (const t of suite.tests) {
            lines.push(`- ${t}`);
          }
        }
      }
      lines.push('');
    }
  }
}

const output = lines.join('\n').replace(/[ \t]+$/gm, '');

if (FLAG_CHECK) {
  const existing = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, 'utf-8') : '';
  if (existing !== output) {
    process.stderr.write('test-catalog.md is stale. Run: node scripts/test-catalog.mjs\n');
    process.exit(1);
  }
  process.stdout.write('test-catalog.md is up to date.\n');
  process.exit(0);
}

writeFileSync(OUT_PATH, output, 'utf-8');
process.stdout.write(`✓ Wrote ${OUT_PATH} (${totalTests} tests, ${totalFiles} files)\n`);
