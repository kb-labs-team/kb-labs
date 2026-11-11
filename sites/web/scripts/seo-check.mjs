#!/usr/bin/env node
import { writeCheckResult } from '../../../scripts/checks/lib/check-result.mjs';
/**
 * SEO sanity check for kblabs.ru + docs.kblabs.ru
 *
 * Checks:
 *  1. Every page.tsx in apps/web and apps/docs has generateMetadata or export const metadata
 *  2. Every blog post in content/blog/en/ has a matching file in content/blog/ru/
 *  3. Every static route in apps/web/app/sitemap.ts has a corresponding page.tsx
 *
 * Exit code 0 = all good, 1 = issues found.
 *
 * Devkit integration: when KB_DEVKIT_MODE is set, outputs { issues: Issue[] } JSON to stdout
 * instead of printing to console. Self-filters: skips all packages except kb-labs-web.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEVKIT_MODE = Boolean(process.env.KB_DEVKIT_MODE);
const CHECK_NAME = 'seo-lint';

// Self-filter: only kb-labs-web (sites/web) has SEO pages to check.
if (DEVKIT_MODE && (process.env.KB_DEVKIT_PACKAGE_NAME ?? '') !== 'kb-labs-web') {
  writeCheckResult([]);
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let errors = 0;
let warnings = 0;
const issues = [];

function error(msg) {
  if (!DEVKIT_MODE) { console.error(`  ✗ ${msg}`); }
  issues.push({ check: CHECK_NAME, severity: 'error', message: msg });
  errors++;
}

function warn(msg) {
  if (!DEVKIT_MODE) { console.warn(`  ⚠ ${msg}`); }
  issues.push({ check: CHECK_NAME, severity: 'warning', message: msg });
  warnings++;
}

function ok(msg) {
  if (!DEVKIT_MODE) { console.log(`  ✓ ${msg}`); }
}

// ─── 1. All page.tsx have metadata ───────────────────────────────────────────

if (!DEVKIT_MODE) { console.log('\n[1] Checking page.tsx files for generateMetadata / export const metadata...'); }

const SKIP_PAGES = [
  // Root stubs and redirect/catch-all pages — no metadata needed
  'app/layout.tsx',
  'app/not-found.tsx',
  'app/page.tsx',                        // docs root: redirect('/ru')
  'app/[locale]/[...rest]/page.tsx',     // web catch-all: notFound()
];

function checkPagesInDir(appDir, appName) {
  const pageFiles = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) { return; }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.next') { continue; }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === 'page.tsx') {
        pageFiles.push(full);
      }
    }
  }

  walk(path.join(appDir, 'app'));

  for (const file of pageFiles) {
    const rel = path.relative(appDir, file);
    if (SKIP_PAGES.some((s) => rel.endsWith(s))) { continue; }

    const content = fs.readFileSync(file, 'utf8');
    const hasMetadata =
      content.includes('generateMetadata') ||
      content.includes('export const metadata');

    if (!hasMetadata) {
      error(`[${appName}] ${rel} — missing generateMetadata or export const metadata`);
    }
  }

  ok(`[${appName}] Scanned ${pageFiles.length} page.tsx files`);
}

checkPagesInDir(path.join(ROOT, 'apps/web'), 'web');
checkPagesInDir(path.join(ROOT, 'apps/docs'), 'docs');

// ─── 2. Blog translation parity ───────────────────────────────────────────────

if (!DEVKIT_MODE) { console.log('\n[2] Checking blog translation parity (en ↔ ru)...'); }

const blogEn = path.join(ROOT, 'content/blog/en');
const blogRu = path.join(ROOT, 'content/blog/ru');

if (fs.existsSync(blogEn)) {
  const enPosts = fs.readdirSync(blogEn).filter((f) => f.endsWith('.mdx'));
  const ruPosts = new Set(fs.existsSync(blogRu) ? fs.readdirSync(blogRu).filter((f) => f.endsWith('.mdx')) : []);

  let missing = 0;
  for (const post of enPosts) {
    if (!ruPosts.has(post)) {
      warn(`blog post '${post}' exists in en/ but not in ru/`);
      missing++;
    }
  }

  if (missing === 0) {
    ok(`All ${enPosts.length} blog posts have ru/ translations`);
  }
} else {
  warn('content/blog/en/ not found — skipping blog check');
}

// ─── 3. Sitemap routes vs actual pages ───────────────────────────────────────

if (!DEVKIT_MODE) { console.log('\n[3] Checking sitemap routes have matching page.tsx in apps/web...'); }

const sitemapFile = path.join(ROOT, 'apps/web/app/sitemap.ts');
if (fs.existsSync(sitemapFile)) {
  const sitemapContent = fs.readFileSync(sitemapFile, 'utf8');

  const pathMatches = sitemapContent.match(/\{ path: '([^']*)', priority:/g) ?? [];
  const sitemapPaths = pathMatches.map((m) => {
    const match = m.match(/path: '([^']*)'/);
    return match ? match[1] : null;
  }).filter(Boolean);

  const webAppDir = path.join(ROOT, 'apps/web/app/[locale]');

  let missing = 0;
  for (const routePath of sitemapPaths) {
    const normalized = routePath === '' ? '' : routePath;
    const pageCandidate = path.join(webAppDir, normalized, 'page.tsx');

    if (!fs.existsSync(pageCandidate)) {
      warn(`Sitemap route '${routePath || '/'}' has no matching apps/web/app/[locale]${normalized}/page.tsx`);
      missing++;
    }
  }

  if (missing === 0) {
    ok(`All ${sitemapPaths.length} sitemap routes have matching page.tsx`);
  }
} else {
  warn('apps/web/app/sitemap.ts not found — skipping sitemap check');
}

// ─── Summary ─────────────────────────────────────────────────────────────────

if (DEVKIT_MODE) {
  writeCheckResult(issues);
  process.exit(0);
}

console.log('\n─────────────────────────────────────────────');
if (errors === 0 && warnings === 0) {
  console.log('✅ All SEO checks passed.\n');
  process.exit(0);
} else {
  if (errors > 0) { console.error(`❌ ${errors} error(s), ${warnings} warning(s).\n`); }
  else { console.warn(`⚠  0 errors, ${warnings} warning(s).\n`); }
  process.exit(errors > 0 ? 1 : 0);
}
