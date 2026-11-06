#!/usr/bin/env node
import { writeCheckResult } from '../../../../../scripts/checks/lib/check-result.mjs';
/**
 * docs-audit.mjs — KB Labs Docs structural audit
 *
 * Checks (all rules sourced from CONVENTIONS.md):
 *   1. Coverage    — every sitemap.config.json slug has a matching MDX file
 *   2. Orphans     — every MDX file in content/en/ is listed in the sitemap
 *   3. Frontmatter — every MDX has a required `title` field
 *   4. Naming      — all filenames and directories are kebab-case
 *   5. Index       — every content directory has index.mdx + _meta.json
 *   6. Depth       — no file or directory exceeds 2 levels inside content/en/
 *   7. Owners      — every non-auto page has at least one owner defined
 *
 * Runs in two modes:
 *   Devkit (KB_DEVKIT_MODE=true) → JSON result for the declared docs-site anchor
 *   Standalone                   → human-readable output (run from docs app root)
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

const DEVKIT_MODE = Boolean(process.env.KB_DEVKIT_MODE);

const cwd = DEVKIT_MODE ? (process.env.KB_DEVKIT_PACKAGE_DIR ?? process.cwd()) : process.cwd();
const contentDir = join(cwd, 'content', 'en');
const sitemapPath = join(cwd, 'sitemap.config.json');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isKebabCase(str) {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(str);
}

function extractTitle(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  const m = match[1].match(/^title:\s*(.+)$/m);
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null;
}

function walkContent(dir, depth = 0) {
  const files = [];
  const dirs = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('_') || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      dirs.push({ path: full, rel: relative(contentDir, full), depth });
      const sub = walkContent(full, depth + 1);
      files.push(...sub.files);
      dirs.push(...sub.dirs);
    } else if (entry.endsWith('.mdx')) {
      files.push({ path: full, rel: relative(contentDir, full) });
    }
  }
  return { files, dirs };
}

function collectSlugs(sitemap) {
  const map = new Map();
  function addPages(pages) {
    for (const page of pages ?? []) {
      map.set(page.slug, page);
    }
  }
  for (const section of sitemap.sections ?? []) {
    addPages(section.pages);
    for (const sub of section.subsections ?? []) {
      addPages(sub.pages);
    }
  }
  return map;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const items = [];

  if (!existsSync(sitemapPath)) {
    items.push({ target: 'sitemap.config.json', severity: 'error', message: 'sitemap.config.json not found — run from the docs app root' });
    return finish(items);
  }

  if (!existsSync(contentDir)) {
    items.push({ target: 'content/en/', severity: 'error', message: 'content/en/ directory not found' });
    return finish(items);
  }

  const sitemap = JSON.parse(readFileSync(sitemapPath, 'utf-8'));
  const slugMap = collectSlugs(sitemap);
  const { files, dirs } = walkContent(contentDir);
  const fileSet = new Set(files.map(f => f.rel));

  // ── 1. Coverage: every sitemap slug → file exists ────────────────────────
  for (const [slug, page] of slugMap) {
    if (page.type === 'auto') continue;
    if (page.status === 'missing') continue;

    // slug can resolve as direct file OR as /index.mdx
    const direct = `${slug}.mdx`;
    const asIndex = `${slug}/index.mdx`;
    // handle slugs already ending in /index (file path style)
    const resolved = slug.endsWith('/index')
      ? `${slug}.mdx`
      : null;

    const found = fileSet.has(direct) || fileSet.has(asIndex) || (resolved && fileSet.has(resolved));
    if (!found) {
      items.push({
        target: `content/en/${direct}`,
        severity: 'error',
        message: `Sitemap slug "${slug}" has no matching MDX file`,
      });
    }
  }

  // ── 2. Orphans: every file → in sitemap ──────────────────────────────────
  const knownFiles = new Set();
  for (const [slug] of slugMap) {
    knownFiles.add(`${slug}.mdx`);
    knownFiles.add(`${slug}/index.mdx`);
    if (slug.endsWith('/index')) knownFiles.add(`${slug}.mdx`);
  }
  // Section and subsection index.mdx files are implicit roots — always known
  for (const section of sitemap.sections ?? []) {
    knownFiles.add(`${section.id}/index.mdx`);
    for (const sub of section.subsections ?? []) {
      knownFiles.add(`${sub.id}/index.mdx`);
    }
  }

  for (const file of files) {
    if (!knownFiles.has(file.rel)) {
      items.push({
        target: `content/en/${file.rel}`,
        severity: 'warning',
        message: `Not listed in sitemap.config.json — add an entry or delete the file`,
      });
    }
  }

  // ── 3. Frontmatter: title required ────────────────────────────────────────
  for (const file of files) {
    const content = readFileSync(file.path, 'utf-8');
    if (!extractTitle(content)) {
      items.push({
        target: `content/en/${file.rel}`,
        severity: 'error',
        message: 'Missing required frontmatter field: title',
      });
    }
  }

  // ── 4. Naming: kebab-case ─────────────────────────────────────────────────
  for (const file of files) {
    const name = basename(file.rel, '.mdx');
    if (name !== 'index' && !isKebabCase(name)) {
      items.push({
        target: `content/en/${file.rel}`,
        severity: 'error',
        message: `Filename "${name}" violates kebab-case convention (CONVENTIONS.md §File Naming)`,
      });
    }
  }
  for (const dir of dirs) {
    const name = basename(dir.rel);
    if (!isKebabCase(name)) {
      items.push({
        target: `content/en/${dir.rel}/`,
        severity: 'error',
        message: `Directory "${name}" violates kebab-case convention (CONVENTIONS.md §File Naming)`,
      });
    }
  }

  // ── 5. Index: every dir has index.mdx + _meta.json ───────────────────────
  for (const dir of dirs) {
    if (!existsSync(join(dir.path, 'index.mdx'))) {
      items.push({
        target: `content/en/${dir.rel}/index.mdx`,
        severity: 'error',
        message: `Directory "${dir.rel}" has no index.mdx — section root required by CONVENTIONS.md`,
      });
    }
    if (!existsSync(join(dir.path, '_meta.json'))) {
      items.push({
        target: `content/en/${dir.rel}/_meta.json`,
        severity: 'warning',
        message: `Directory "${dir.rel}" has no _meta.json — sidebar order and title will be auto-derived`,
      });
    }
  }

  // ── 6. Depth: max 2 levels ────────────────────────────────────────────────
  for (const dir of dirs) {
    if (dir.depth > 1) {
      items.push({
        target: `content/en/${dir.rel}/`,
        severity: 'error',
        message: `Exceeds max depth of 2: "${dir.rel}" (depth ${dir.depth + 1}) — CONVENTIONS.md §URL Structure`,
      });
    }
  }
  for (const file of files) {
    const depth = file.rel.split('/').length - 1;
    if (depth > 2) {
      items.push({
        target: `content/en/${file.rel}`,
        severity: 'error',
        message: `Exceeds max depth of 2: "${file.rel}" (depth ${depth}) — CONVENTIONS.md §URL Structure`,
      });
    }
  }

  // ── 7. Owners: every non-auto, non-static page has at least one owner ──────
  for (const [slug, page] of slugMap) {
    if (page.type === 'auto') continue;
    if (page.static) continue;
    if (!page.owners || page.owners.length === 0) {
      items.push({
        target: `sitemap.config.json#${slug}`,
        severity: 'warning',
        message: `Slug "${slug}" has no owners — PR-bot cannot flag it. Add owners or set "static": true if it has no code dependency.`,
      });
    }
  }

  // ── 8. i18n parity (only when content/ru/ exists) ─────────────────────────
  const locales = readdirSync(join(cwd, 'content'))
    .filter(l => l !== 'en' && existsSync(join(cwd, 'content', l)));

  for (const locale of locales) {
    const localeDir = join(cwd, 'content', locale);
    const { files: localeFiles } = walkContent(localeDir);
    const localeSet = new Set(localeFiles.map(f => f.rel));

    // Pages in en/ missing from locale
    for (const file of files) {
      if (!localeSet.has(file.rel)) {
        items.push({
          target: `content/${locale}/${file.rel}`,
          severity: 'warning',
          message: `Missing ${locale}/ translation for content/en/${file.rel}`,
        });
      }
    }

    // Pages in locale/ missing from en/ (orphaned translation)
    for (const localeFile of localeFiles) {
      if (!fileSet.has(localeFile.rel)) {
        items.push({
          target: `content/${locale}/${localeFile.rel}`,
          severity: 'error',
          message: `Translation content/${locale}/${localeFile.rel} has no matching en/ source — source was deleted or renamed`,
        });
      }
    }
  }

  finish(items);
}

function finish(items) {
  const errors = items.filter(i => i.severity === 'error');
  const warnings = items.filter(i => i.severity === 'warning');
  const result = { ok: errors.length === 0, items };

  if (DEVKIT_MODE) {
    writeCheckResult(items.map(({ target, ...issue }) => ({ ...issue, file: target })));
  } else {
    if (items.length === 0) {
      console.log('✓ All doc conventions pass');
    } else {
      for (const item of items) {
        const icon = item.severity === 'error' ? '✗' : '⚠';
        console.log(`\n${icon} [${item.severity}] ${item.target}`);
        console.log(`  ${item.message}`);
      }
      console.log(`\n─────────────────────────────────────`);
      console.log(`${errors.length} error(s)   ${warnings.length} warning(s)`);
      if (errors.length > 0) process.exitCode = 1;
    }
  }
}

main();
