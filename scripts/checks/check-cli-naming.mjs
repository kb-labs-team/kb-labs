#!/usr/bin/env node
import { writeCheckResult } from './lib/check-result.mjs';
/**
 * check-cli-naming — validates CLI manifest naming conventions
 *
 * Devkit external check (TypedCheckOutput v2).
 * Input:  JSON on stdin { package: { dir, name, ... }, ... }
 * Output: { issues: [{ check, severity, message, file, fix? }] }
 * Env:    KB_DEVKIT_PACKAGE_DIR, KB_DEVKIT_PACKAGE_NAME
 *
 * Rules enforced:
 *   1. Top-level namespace must be a single word (no hyphens)
 *   2. Top-level namespace must not be a reserved platform name
 *   3. No kebab-case in sub-level path segments — use proper subgroups instead
 *
 * Known violations are tracked in KNOWN_VIOLATIONS below — they are reported
 * as warnings (non-blocking) until renamed. Remove entries as commands are fixed.
 *
 * Reference: docs/plans/cli-naming-audit.md, ADR-0018
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ─── Reserved platform namespaces ────────────────────────────────────────────

const RESERVED_PLATFORM = new Set([
  'auth', 'platform', 'info', 'logs', 'docs',
  'registry', 'completion', '__complete', '__internal',
]);


// ─── Helpers ─────────────────────────────────────────────────────────────────

function readStdin() {
  const chunks = [];
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');
  return new Promise(resolve => {
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => resolve(chunks.join('')));
  });
}

function findManifestFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
      results.push(...findManifestFiles(join(dir, entry.name)));
    } else if (
      entry.isFile() &&
      /^manifest.*\.(ts|js)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.test.ts')
    ) {
      results.push(join(dir, entry.name));
    }
  }
  return results;
}

function extractCommandPaths(content) {
  const re = /\bpath:\s*['"`]([^'"`\n]+)['"`]/g;
  const paths = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    const p = m[1].trim();
    // Skip HTTP routes, file paths, template literals, and URL-like strings
    if (
      p.startsWith('/') ||        // HTTP route or absolute path
      p.startsWith('./') ||       // relative file path
      p.startsWith('../') ||      // relative file path
      p.includes('${') ||         // template literal
      /\.(yaml|yml|json|js|ts|md)$/.test(p)  // file extension
    ) {
      continue;
    }
    paths.push(p);
  }
  return [...new Set(paths)];
}


// ─── Main ─────────────────────────────────────────────────────────────────────

const CHECK_NAME = 'cli-naming';

async function main() {
  const raw = await readStdin();

  // Devkit passes JSON input; fall back to env var if stdin is empty/unparseable
  let pkgDir = process.env['KB_DEVKIT_PACKAGE_DIR'] ?? process.cwd();
  try {
    const input = JSON.parse(raw);
    pkgDir = input?.package?.dir ?? pkgDir;
  } catch { /* stdin may be plain package.json in manual runs */ }

  const srcDir = join(pkgDir, 'src');
  const manifestFiles = findManifestFiles(srcDir);
  const issues = [];

  // Track reported paths per file to avoid duplicate findings
  const reported = new Set();

  for (const filePath of manifestFiles) {
    let content;
    try { content = readFileSync(filePath, 'utf-8'); } catch { continue; }

    for (const cmdPath of extractCommandPaths(content)) {
      const key = `${filePath}:${cmdPath}`;
      if (reported.has(key)) continue;
      reported.add(key);
      const segments = cmdPath.split(/\s+/).filter(Boolean);
      if (segments.length === 0) continue;

      const topLevel = segments[0];
      const severity = 'error';

      // Rule 1 — top-level must be a single word (no hyphens)
      if (topLevel.includes('-')) {
        issues.push({
          check: CHECK_NAME,
          severity,
          message: `Top-level namespace "${topLevel}" contains hyphens — namespaces must be a single word`,
          file: filePath,
          fix: `Rename "${topLevel}" to a single word (e.g. "infra" instead of "infra-worker")`,
        });
        continue;
      }

      // Rule 2 — top-level must not be a reserved platform name
      if (RESERVED_PLATFORM.has(topLevel)) {
        issues.push({
          check: CHECK_NAME,
          severity,
          message: `Namespace "${topLevel}" is reserved by the KB Labs platform`,
          file: filePath,
          fix: `Choose a different top-level namespace. Reserved: ${[...RESERVED_PLATFORM].join(', ')}`,
        });
        continue;
      }

      // Rule 3 — no kebab-case in sub-level segments
      for (let i = 1; i < segments.length; i++) {
        if (segments[i].includes('-')) {
          issues.push({
            check: CHECK_NAME,
            severity,
            message: `"${cmdPath}" — segment "${segments[i]}" uses kebab-case; split into a subgroup instead`,
            file: filePath,
            fix: `Rename to: "${cmdPath.replace(/-/g, ' ')}" (or restructure as a proper subgroup)`,
          });
          break;
        }
      }
    }
  }

  writeCheckResult(issues);
  const hasErrors = issues.some(i => i.severity === 'error');
  process.exit(hasErrors ? 1 : 0);
}

main().catch(e => {
  process.stderr.write(String(e) + '\n');
  process.exit(1);
});
