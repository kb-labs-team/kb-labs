#!/usr/bin/env node
import { writeCheckResult } from '../../../../../scripts/checks/lib/check-result.mjs';
/**
 * seo-check.mjs — SEO guard for KB Labs marketing site.
 *
 * Runs in two modes:
 *
 *   STANDALONE  (direct invocation from sites/web/apps/web/):
 *     node scripts/seo-check.mjs [--no-color]
 *     Human-readable terminal output, exit 0/1.
 *
 *   DEVKIT  (via kb-devkit custom_check, language: typescript):
 *     Triggered when KB_DEVKIT_MODE is set. Its anchor package is declared in devkit.yaml.
 *     Output: {"issues":[...]} to stdout.
 *
 * Checks (per static page.tsx under app/[locale]/):
 *   1. NO_METADATA    — page.tsx has no generateMetadata or export const metadata  → error
 *   2. NO_SEGMENT     — buildPageMetadata called without imageSegment              → error
 *   3. MISSING_OG     — imageSegment !== 'default' but opengraph-image.tsx missing → error
 *   4. BAD_OG_KEYS    — opengraph-image.tsx doesn't use .meta. translation keys    → error
 *   5. TITLE_LENGTH   — meta title < 15 or > 65 chars (en or ru)                  → error
 *   6. TITLE_BRAND    — meta title missing "KB Labs" brand                         → warning
 *   7. DESC_LENGTH    — meta description < 70 or > 165 chars (en or ru)            → error
 *   8. NO_JSONLD      — page.tsx has no JSON-LD script                             → warning
 *
 * Suppression:
 *   // seo-ignore og-image   → suppress MISSING_OG for that file
 *   // seo-ignore og-keys    → suppress BAD_OG_KEYS for that file
 *   // seo-ignore jsonld     → suppress NO_JSONLD for that file
 *   // seo-ignore title-brand → suppress TITLE_BRAND for that file
 *
 * Dynamic routes ([slug]) are skipped for checks 3-8 (external data, can't validate).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Mode ─────────────────────────────────────────────────────────────────────

const DEVKIT_MODE = Boolean(process.env.KB_DEVKIT_MODE);
const NO_COLOR    = process.env.CI === 'true' || process.argv.includes('--no-color') || DEVKIT_MODE;

function exitWithJson(obj) {
  writeCheckResult(obj.issues);
  process.exit(0);
}

// ─── Paths ────────────────────────────────────────────────────────────────────

const ROOT = DEVKIT_MODE
  ? (process.env.KB_DEVKIT_PACKAGE_DIR ?? process.cwd())
  : join(fileURLToPath(import.meta.url), '..', '..');

const LOCALE_DIR  = join(ROOT, 'app', '[locale]');
const MESSAGES_EN = join(ROOT, 'messages', 'en.json');
const MESSAGES_RU = join(ROOT, 'messages', 'ru.json');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const c = NO_COLOR
  ? { red: s => s, yellow: s => s, green: s => s, gray: s => s, bold: s => s, cyan: s => s }
  : {
      red:    s => `\x1b[31m${s}\x1b[0m`,
      yellow: s => `\x1b[33m${s}\x1b[0m`,
      green:  s => `\x1b[32m${s}\x1b[0m`,
      gray:   s => `\x1b[90m${s}\x1b[0m`,
      bold:   s => `\x1b[1m${s}\x1b[0m`,
      cyan:   s => `\x1b[36m${s}\x1b[0m`,
    };

function toDevkitIssue(file, line, msg, severity = 'error') {
  return { check: 'seo-check', severity, message: msg, file, line };
}

/** Read dot-path from a nested object, e.g. "blog.meta.title" */
function dotGet(obj, path) {
  return path.split('.').reduce((acc, k) => acc?.[k], obj);
}

// ─── Load messages ────────────────────────────────────────────────────────────

let messagesEn = {};
let messagesRu = {};
try { messagesEn = JSON.parse(readFileSync(MESSAGES_EN, 'utf8')); } catch { /* optional */ }
try { messagesRu = JSON.parse(readFileSync(MESSAGES_RU, 'utf8')); } catch { /* optional */ }

// ─── Discover page.tsx files ──────────────────────────────────────────────────

/**
 * Recursively find page.tsx files under dir.
 * Skips node_modules and any segment that contains "[" in its name (dynamic routes).
 */
function findPageFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip dynamic route segments — can't statically validate their meta
      if (entry.name.startsWith('[')) continue;
      results.push(...findPageFiles(full));
    } else if (entry.name === 'page.tsx') {
      results.push(full);
    }
  }
  return results;
}

const pageFiles = findPageFiles(LOCALE_DIR);

// ─── Resolve i18n key value ───────────────────────────────────────────────────

/**
 * Given a translation call like t('about.meta.title') or t('meta.title') with
 * namespace 'solutionCodeQuality', resolve the final value from messages.
 *
 * Handles both:
 *   - t('full.dot.path') with no namespace (or namespace already in key)
 *   - t('relative.key') with getTranslations({ namespace: 'xxx' }) — we detect
 *     the namespace from the file source
 */
function resolveKey(messages, fullKey) {
  return dotGet(messages, fullKey);
}

/**
 * Extract meta title/description dot-paths from a page.tsx source.
 * Returns array of {type: 'title'|'description', key: 'full.dot.path'} objects.
 *
 * Handles:
 *   - t('full.path') with default namespace
 *   - namespace-relative t('meta.title') with namespace: 'solutionCodeQuality'
 *   - template literals like `${t('marketplace.meta.title')} — KB Labs`
 */
function extractMetaKeys(source) {
  const results = [];

  // Extract namespace from getTranslations({ locale, namespace: 'xxx' }) in generateMetadata
  // Only look inside generateMetadata function scope
  const genMetaMatch = source.match(/generateMetadata[\s\S]*?(?=\nexport\s+(?:default|async\s+function\s+\w+(?!Metadata))|\n\n\/\/)/);
  const genMetaSource = genMetaMatch ? genMetaMatch[0] : source;

  const nsMatch = genMetaSource.match(/getTranslations\s*\(\s*\{[^}]*namespace\s*:\s*['"]([^'"]+)['"]/);
  const namespace = nsMatch ? nsMatch[1] : null;

  // Find t('...') calls in title and description positions of buildPageMetadata
  const buildMetaMatch = source.match(/buildPageMetadata\s*\(\s*\{([\s\S]*?)\}\s*\)/);
  if (!buildMetaMatch) return results;

  const block = buildMetaMatch[1];

  for (const [field, type] of [['title', 'title'], ['description', 'description']]) {
    // Match: title: t('some.key') or title: `prefix${t('some.key')}suffix`
    const fieldMatch = block.match(new RegExp(`${field}\\s*:\\s*(?:\`[^$]*\\$\\{)?t\\s*\\(\\s*['"]([^'"]+)['"]`));
    if (!fieldMatch) continue;

    let key = fieldMatch[1];
    // If namespace is set and key doesn't start with namespace (relative key)
    if (namespace && !key.startsWith(namespace + '.')) {
      key = `${namespace}.${key}`;
    }
    results.push({ type, key });
  }

  return results;
}

// ─── Run checks ───────────────────────────────────────────────────────────────

const issues = [];

for (const file of pageFiles) {
  const source = readFileSync(file, 'utf8');
  const relFile = relative(ROOT, file);

  // Suppression flags
  const suppressOgImage  = source.includes('seo-ignore og-image');
  const suppressOgKeys   = source.includes('seo-ignore og-keys');
  const suppressJsonLd   = source.includes('seo-ignore jsonld');
  const suppressTitleBrand = source.includes('seo-ignore title-brand');

  // ── Check 1: NO_METADATA ────────────────────────────────────────────────────
  const hasGenerateMetadata = /export\s+async\s+function\s+generateMetadata/.test(source);
  const hasExportMetadata   = /export\s+const\s+metadata\s*=/.test(source);
  if (!hasGenerateMetadata && !hasExportMetadata) {
    issues.push(toDevkitIssue(file, 1,
      `[NO_METADATA] ${relFile} — no generateMetadata or export const metadata found`));
    continue; // no point in further checks
  }

  const usesBuildPageMetadata = source.includes('buildPageMetadata');
  if (!usesBuildPageMetadata) continue; // page uses custom metadata, skip remaining checks

  // ── Check 2: NO_SEGMENT ─────────────────────────────────────────────────────
  if (!source.includes('imageSegment')) {
    issues.push(toDevkitIssue(file, 1,
      `[NO_SEGMENT] ${relFile} — buildPageMetadata called without imageSegment`));
    continue;
  }

  // ── Check 3: MISSING_OG ─────────────────────────────────────────────────────
  if (!suppressOgImage) {
    const segmentMatch = source.match(/imageSegment\s*:\s*['"]([^'"]+)['"]/);
    if (segmentMatch) {
      const segment = segmentMatch[1];
      if (segment !== 'default') {
        const ogFile = join(LOCALE_DIR, segment, 'opengraph-image.tsx');
        if (!existsSync(ogFile)) {
          issues.push(toDevkitIssue(file, 1,
            `[MISSING_OG] ${relFile} — imageSegment '${segment}' has no opengraph-image.tsx at app/[locale]/${segment}/`));
        }
      }
    }
  }

  // ── Check 4: BAD_OG_KEYS ────────────────────────────────────────────────────
  if (!suppressOgKeys) {
    const segmentMatch = source.match(/imageSegment\s*:\s*['"]([^'"]+)['"]/);
    if (segmentMatch && segmentMatch[1] !== 'default') {
      const segment = segmentMatch[1];
      const ogFile = join(LOCALE_DIR, segment, 'opengraph-image.tsx');
      if (existsSync(ogFile)) {
        const ogSource = readFileSync(ogFile, 'utf8');
        // OG image must use .meta. keys, not hero/subtitle/etc.
        const tCalls = [...ogSource.matchAll(/\bt\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
        const usesMetaKey = tCalls.some(k => k.includes('meta.') || k.includes('Meta'));
        if (tCalls.length > 0 && !usesMetaKey) {
          issues.push(toDevkitIssue(ogFile, 1,
            `[BAD_OG_KEYS] ${relative(ROOT, ogFile)} — uses non-meta keys (${tCalls.slice(0, 2).join(', ')}); use .meta.title/.meta.description to stay in sync with page metadata`));
        }
      }
    }
  }

  // ── Checks 5-7: title/description lengths ───────────────────────────────────
  const metaKeys = extractMetaKeys(source);

  for (const { type, key } of metaKeys) {
    for (const [lang, messages] of [['en', messagesEn], ['ru', messagesRu]]) {
      const value = resolveKey(messages, key);
      if (value == null || typeof value !== 'string') continue;

      if (type === 'title') {
        if (value.length < 15 || value.length > 65) {
          issues.push(toDevkitIssue(file, 1,
            `[TITLE_LENGTH] ${relFile} — ${lang} title "${value}" is ${value.length} chars (expected 15–65)`));
        }
        if (!suppressTitleBrand && !value.includes('KB Labs')) {
          issues.push(toDevkitIssue(file, 1,
            `[TITLE_BRAND] ${relFile} — ${lang} title "${value}" missing "KB Labs" brand (title.absolute bypasses layout template)`,
            'warning'));
        }
      }

      if (type === 'description') {
        if (value.length < 70 || value.length > 165) {
          issues.push(toDevkitIssue(file, 1,
            `[DESC_LENGTH] ${relFile} — ${lang} description is ${value.length} chars (expected 70–165)`));
        }
      }
    }
  }

  // ── Check 8: NO_JSONLD ──────────────────────────────────────────────────────
  if (!suppressJsonLd) {
    const hasJsonLd = source.includes('application/ld+json') || source.includes('JSON-LD') || source.includes('@context');
    if (!hasJsonLd) {
      issues.push(toDevkitIssue(file, 1,
        `[NO_JSONLD] ${relFile} — no JSON-LD structured data; add or suppress with // seo-ignore jsonld`,
        'warning'));
    }
  }
}

// ─── Output ───────────────────────────────────────────────────────────────────

if (DEVKIT_MODE) {
  exitWithJson({ issues });
}

// ── Standalone human-readable output ──────────────────────────────────────────

const SEP  = '─'.repeat(64);
const NL   = () => console.log();
const LINE = () => console.log(c.gray(SEP));

const errors   = issues.filter(i => i.severity === 'error');
const warnings = issues.filter(i => i.severity === 'warning');

NL();
console.log(c.bold('SEO CHECK'));
LINE();
console.log(c.gray(`Checked ${pageFiles.length} page.tsx files`));
NL();

if (issues.length === 0) {
  console.log(c.green('✓ All checks passed'));
} else {
  for (const issue of issues) {
    const icon = issue.severity === 'error' ? c.red('✖') : c.yellow('⚠');
    console.log(`${icon}  ${issue.message}`);
  }
}

NL();
LINE();
const errLabel = errors.length === 0 ? c.green(`${errors.length} errors`) : c.red(`${errors.length} errors`);
const warnLabel = warnings.length === 0 ? c.green(`${warnings.length} warnings`) : c.yellow(`${warnings.length} warnings`);
console.log(`${errLabel}  ${warnLabel}`);
NL();

process.exit(errors.length > 0 ? 1 : 0);
