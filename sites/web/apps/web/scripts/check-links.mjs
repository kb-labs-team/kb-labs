#!/usr/bin/env node
import { writeCheckResult } from '../../../../../scripts/checks/lib/check-result.mjs';
/**
 * check-links.mjs — broken-link guard for KB Labs sites.
 *
 * STANDALONE  (from workspace root or sites/web/apps/web/):
 *   node sites/web/apps/web/scripts/check-links.mjs [--strict] [--no-color]
 *   Human-readable output, exit 0/1.
 *
 * DEVKIT  (language: typescript, KB_DEVKIT_MODE set):
 *   Its anchor package is declared on the custom check in devkit.yaml.
 *   Output: {"issues":[...]} to stdout.
 *
 * Checks:
 *   1. BROKEN_INTERNAL — href points to a non-existent Next.js route → error
 *   2. BROKEN_EXTERNAL — HTTP HEAD on a controlled origin returns 4xx  → error
 *                        (5xx / timeout treated as warning)
 *
 * Suppression:
 *   // link-ignore  at end of the source line → skips all hrefs on that line.
 *
 * Controlled origins (HTTP-checked):
 *   kblabs.ru, docs.kblabs.ru, status.kblabs.ru
 *
 * Href patterns extracted:
 *   href="..."            JSX attribute (static string)
 *   href: "..."           Object/array literal property
 *   lp('...')             Locale-prefix helper (adds /${locale})
 *   href={`/${locale}/…`} Template literal (only when path is fully static)
 *
 * Source roots scanned:
 *   sites/web/apps/web/{app,components}/
 *   sites/web/apps/docs/{app,content}/   (if exists)
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Mode ─────────────────────────────────────────────────────────────────────

const DEVKIT_MODE = Boolean(process.env.KB_DEVKIT_MODE);
const NO_COLOR    = process.env.CI === 'true' || process.argv.includes('--no-color') || DEVKIT_MODE;
const CHECK_NAME  = 'check-links';

// ─── Config ───────────────────────────────────────────────────────────────────

const CROSS_DOMAIN_ORIGINS = new Set(['kblabs.ru', 'docs.kblabs.ru', 'status.kblabs.ru']);
const SCAN_EXTS  = new Set(['.tsx', '.ts', '.md', '.mdx']);
const SKIP_DIRS  = new Set(['node_modules', '.next', '.git', 'dist', 'out', 'build', '.turbo']);
const HEAD_TIMEOUT_MS = 8_000;
const SUPPRESS   = 'link-ignore';

// ─── Paths ────────────────────────────────────────────────────────────────────

const WEB_ROOT       = join(fileURLToPath(import.meta.url), '..', '..');
const WORKSPACE_ROOT = join(WEB_ROOT, '..', '..', '..', '..');
const DOCS_ROOT      = join(WORKSPACE_ROOT, 'sites', 'web', 'apps', 'docs');

const SCAN_DIRS = [
  join(WEB_ROOT, 'app'),
  join(WEB_ROOT, 'components'),
  join(DOCS_ROOT, 'app'),
  join(DOCS_ROOT, 'content'),
].filter(existsSync);

// ─── Devkit helpers ───────────────────────────────────────────────────────────

function exitWithJson(obj) {
  writeCheckResult(obj.issues);
  process.exit(0);
}

function toIssue(file, line, severity, message) {
  return { check: CHECK_NAME, severity, message, file, line };
}

// ─── Colors (standalone output) ───────────────────────────────────────────────

const c = NO_COLOR
  ? { red: s => s, yellow: s => s, green: s => s, gray: s => s, bold: s => s }
  : {
      red:    s => `\x1b[31m${s}\x1b[0m`,
      yellow: s => `\x1b[33m${s}\x1b[0m`,
      green:  s => `\x1b[32m${s}\x1b[0m`,
      gray:   s => `\x1b[90m${s}\x1b[0m`,
      bold:   s => `\x1b[1m${s}\x1b[0m`,
    };

// ─── File walker ──────────────────────────────────────────────────────────────

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (SCAN_EXTS.has(extname(entry.name))) yield full;
  }
}

// ─── Route discovery ─────────────────────────────────────────────────────────

/**
 * Walk app/[locale]/ and return:
 *   routes        — Set of exact static paths like '/about', '/product/kb-dev'
 *   dynamicRoutes — RegExp[] for dynamic segments like /blog/[slug]
 *
 * Excludes catch-all pages that call notFound() with no real content.
 */
function discoverRoutes(localeDir) {
  const routes        = new Set();
  const dynamicRoutes = [];

  function recurse(dir, segments) {
    const pageTsx = join(dir, 'page.tsx');
    const pageMdx = join(dir, 'page.mdx');

    if (existsSync(pageTsx) || existsSync(pageMdx)) {
      const isDynamic = segments.some(s => s.startsWith('['));

      if (isDynamic) {
        // Skip explicit 404 catch-alls (short file containing only notFound())
        const pageFile = existsSync(pageTsx) ? pageTsx : pageMdx;
        const content  = readFileSync(pageFile, 'utf8');
        if (content.includes('notFound()') && content.length < 300) return;

        // Convert segments to a RegExp
        const pattern = segments
          .map(s => {
            if (s.startsWith('[[...') || s.startsWith('[...')) return '.+';
            if (s.startsWith('[')) return '[^/]+';
            return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          })
          .join('/');
        dynamicRoutes.push(new RegExp('^/' + pattern + '$'));
      } else {
        routes.add(segments.length === 0 ? '/' : '/' + segments.join('/'));
      }
    }

    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      recurse(join(dir, entry.name), [...segments, entry.name]);
    }
  }

  recurse(localeDir, []);
  return { routes, dynamicRoutes };
}

function isValidRoute(rawPath, { routes, dynamicRoutes }) {
  const path = rawPath.split('#')[0].split('?')[0];
  if (!path || path === '/') return routes.has('/');
  if (routes.has(path)) return true;
  return dynamicRoutes.some(re => re.test(path));
}

// ─── Href extraction ──────────────────────────────────────────────────────────

/** Returns all { href, line } found in a source file, respecting // link-ignore. */
function extractLinks(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const lines   = content.split('\n');
  const found   = [];

  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i];
    const lineNum = i + 1;
    if (line.includes(SUPPRESS)) continue;

    const add = href => {
      const h = href.trim();
      if (h) found.push({ href: h, line: lineNum });
    };

    let m;

    // href="..." or href='...'  (JSX attribute)
    const reAttr = /href=["']([^"']+)["']/g;
    while ((m = reAttr.exec(line)) !== null) add(m[1]);

    // href: "..." or href: '...'  (object/array property)
    const reProp = /\bhref:\s*["']([^"']+)["']/g;
    while ((m = reProp.exec(line)) !== null) add(m[1]);

    // lp('...')  (locale-prefix helper — path is always internal)
    const reLp = /\blp\(\s*["']([^"']+)["']\s*\)/g;
    while ((m = reLp.exec(line)) !== null) add(m[1]);

    // href={`/${locale}/path`} — static path after ${locale} segment
    const reTpl = /href=\{`\/\$\{locale\}([^`${}]*)`\}/g;
    while ((m = reTpl.exec(line)) !== null) {
      const path = m[1] || '/';
      add(path === '' ? '/' : path);
    }
  }

  return found;
}

// ─── External HTTP check ──────────────────────────────────────────────────────

async function headCheck(urls) {
  const results = new Map();

  await Promise.allSettled(
    [...urls].map(async url => {
      try {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), HEAD_TIMEOUT_MS);
        const res   = await fetch(url, {
          method:   'HEAD',
          redirect: 'follow',
          signal:   ctrl.signal,
          headers:  { 'User-Agent': 'kb-labs-link-checker/1.0' },
        });
        clearTimeout(timer);
        results.set(url, { ok: res.ok, status: res.status });
      } catch (err) {
        const timedOut = err.name === 'AbortError';
        results.set(url, { ok: false, status: 0, timedOut });
      }
    }),
  );

  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const localeDir = join(WEB_ROOT, 'app', '[locale]');
  const routeMap  = discoverRoutes(localeDir);

  // Collect all links from all source files
  const internalBroken  = []; // { href, file, line }
  const externalToCheck = new Map(); // url → [{file, line}]

  for (const dir of SCAN_DIRS) {
    for (const filePath of walk(dir)) {
      for (const { href, line } of extractLinks(filePath)) {
        // Skip non-navigable schemes
        if (/^(mailto:|tel:|javascript:|#)/.test(href)) continue;

        if (href.startsWith('https://') || href.startsWith('http://')) {
          // External — only HTTP-check if it's a controlled origin
          let host;
          try { host = new URL(href).hostname; } catch { continue; }

          if (CROSS_DOMAIN_ORIGINS.has(host)) {
            const list = externalToCheck.get(href) ?? [];
            list.push({ file: filePath, line });
            externalToCheck.set(href, list);
          }
        } else if (href.startsWith('/')) {
          // Internal — validate against discovered routes
          if (!isValidRoute(href, routeMap)) {
            internalBroken.push({ href, file: filePath, line });
          }
        }
        // Relative paths (e.g. ../foo) — skip (rare in Next.js app router)
      }
    }
  }

  // Deduplicate external URLs and run HEAD checks
  const externalResults = externalToCheck.size > 0
    ? await headCheck(new Set(externalToCheck.keys()))
    : new Map();

  // ─── Build issues ────────────────────────────────────────────────────────

  const issues = [];

  for (const { href, file, line } of internalBroken) {
    const rel = relative(WORKSPACE_ROOT, file);
    issues.push(toIssue(rel, line, 'error',
      `[BROKEN_INTERNAL] No route for "${href}" — add a page.tsx or fix the path`));
  }

  for (const [url, refs] of externalToCheck) {
    const result = externalResults.get(url);
    if (!result || result.ok) continue;

    for (const { file, line } of refs) {
      const rel = relative(WORKSPACE_ROOT, file);
      if (result.timedOut) {
        issues.push(toIssue(rel, line, 'warning',
          `[BROKEN_EXTERNAL] HEAD "${url}" timed out after ${HEAD_TIMEOUT_MS}ms`));
      } else if (result.status >= 400 && result.status < 500) {
        issues.push(toIssue(rel, line, 'error',
          `[BROKEN_EXTERNAL] HEAD "${url}" returned ${result.status}`));
      } else {
        issues.push(toIssue(rel, line, 'warning',
          `[BROKEN_EXTERNAL] HEAD "${url}" returned ${result.status}`));
      }
    }
  }

  // ─── Output ──────────────────────────────────────────────────────────────

  if (DEVKIT_MODE) {
    exitWithJson({ issues });
  }

  // Standalone: human-readable
  const errors   = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');

  if (issues.length === 0) {
    console.log(c.green('✓ No broken links found.'));
    process.exit(0);
  }

  for (const issue of issues) {
    const prefix = issue.severity === 'error' ? c.red('error') : c.yellow('warn');
    console.log(`${prefix}  ${c.gray(issue.file)}:${issue.line}  ${issue.message}`);
  }

  console.log('');
  console.log(
    `Found ${c.bold(String(errors.length))} error(s), ${c.bold(String(warnings.length))} warning(s).`,
  );

  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('check-links: fatal error:', err.message);
  process.exit(1);
});
