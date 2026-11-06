#!/usr/bin/env node
import { writeCheckResult } from '../../../../../scripts/checks/lib/check-result.mjs';
/**
 * i18n-check.mjs — translation guard for KB Labs site.
 *
 * Source of truth: messages/en/**\/*.json + messages/ru/**\/*.json (per-namespace chunks).
 * The legacy monolithic messages/en.json and messages/ru.json are no longer read.
 *
 * Chunk format:
 *   _shared.json   → flat: { nav: {...}, footer: {...}, ... }  (multiple top-level keys)
 *   *.json         → wrapped: { [namespace]: { ... } }          (single top-level key)
 *
 * Runs in two modes:
 *
 *   STANDALONE  (direct invocation from sites/web/apps/web/):
 *     node scripts/i18n-check.mjs [--strict] [--no-color]
 *     Human-readable terminal output, exit 0/1.
 *
 *   DEVKIT  (via kb-devkit custom_check, language: typescript):
 *     Triggered in the package contexts declared by devkit.yaml. The runner
 *     owns package applicability; this script selects the workspace-wide or
 *     satellite hardcoded-only work for the supplied package context:
 *       @kb-labs/web-site     → all 4 checks (owns messages files)
 *       @kb-labs/web-site-ui  → HARDCODED only (kit has user-visible strings)
 *       @kb-labs/web-og       → HARDCODED only
 *       @kb-labs/docs-site    → HARDCODED only
 *       everything else       → skip ({"issues":[]})
 *     Output: {"issues":[...]} to stdout.
 *
 *   DEVKIT FIX  (via kb-devkit fix, KB_DEVKIT_MODE=fix):
 *     Removes UNUSED keys from chunk files.
 *     Returns remaining issues after the fix.
 *
 * Checks:
 *   1. MISMATCH   — en/ru chunks have different key sets            → error
 *   2. MISSING    — code references a key absent from messages       → error
 *   3. HARDCODED  — Cyrillic text ≥ 4 chars in .tsx not via t()     → error
 *   4. UNUSED     — messages key never referenced in source          → warning (--strict → error)
 *
 * Autofix (devkit fix / --fix):
 *   UNUSED keys are deleted from both en and ru chunk files.
 *
 * Suppression:
 *   // i18n-ignore  at end of any source line → skips HARDCODED for that line.
 *   Dynamic template-literal keys (t(`key.${x}`)) are excluded from #2 and #4.
 */

import {
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join, extname, relative, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Mode ─────────────────────────────────────────────────────────────────────

const DEVKIT_MODE = Boolean(process.env.KB_DEVKIT_MODE);
const DEVKIT_FIX  = process.env.KB_DEVKIT_MODE === 'fix';
const FIX_MODE    = DEVKIT_FIX || process.argv.includes('--fix');
const DRY_RUN     = process.env.KB_DEVKIT_DRY_RUN === 'true' || process.argv.includes('--dry-run');
const STRICT      = process.argv.includes('--strict') || (DEVKIT_MODE && !DEVKIT_FIX);
const NO_COLOR    = process.env.CI === 'true' || process.argv.includes('--no-color') || DEVKIT_MODE;

// ─── Shared utilities ─────────────────────────────────────────────────────────

const SOURCE_EXTS = new Set(['.tsx', '.ts']);

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (SOURCE_EXTS.has(extname(entry.name))) yield full;
  }
}

function* walkJson(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJson(full);
    else if (entry.name.endsWith('.json')) yield full;
  }
}

const CYRILLIC_RUN    = /[а-яёА-ЯЁ]{4,}/;
const STRIP_T_CALL    = /\bt(?:\.raw|\.rich)?\(\s*['"][^'"$`]+['"]/g;
const STRIP_LINE_TAIL = /\s+\/\/(?!.*i18n-ignore).*$/;

function extractHardcoded(filePath) {
  if (!filePath.endsWith('.tsx')) return [];
  const src    = readFileSync(filePath, 'utf8');
  const lines  = src.split('\n');
  const issues = [];
  let inBlock  = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (inBlock) { if (raw.includes('*/')) inBlock = false; continue; }
    if (raw.includes('/*') && !raw.includes('*/')) inBlock = true;
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    if (raw.includes('i18n-ignore')) continue;
    let line = raw.replace(STRIP_T_CALL, '');
    line = line.replace(STRIP_LINE_TAIL, '');
    if (CYRILLIC_RUN.test(line)) {
      issues.push({ file: filePath, line: i + 1, content: raw.trim().slice(0, 120) });
    }
  }
  return issues;
}

// ─── Chunk utilities ──────────────────────────────────────────────────────────

const ROOT         = join(fileURLToPath(import.meta.url), '..', '..');
const MESSAGES_DIR = join(ROOT, 'messages');

/**
 * Load all chunk files for a locale and merge into a single message object.
 * _shared.json is merged flat; all other chunks are wrapped in their namespace key.
 *
 * Returns { messages, chunkFiles } where chunkFiles maps absolute path → parsed JSON.
 */
function loadChunks(locale) {
  const localeDir = join(MESSAGES_DIR, locale);
  if (!existsSync(localeDir)) return { messages: {}, chunkFiles: new Map() };

  const messages   = {};
  const chunkFiles = new Map(); // absPath → raw parsed JSON

  for (const filePath of walkJson(localeDir)) {
    const raw  = readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    chunkFiles.set(filePath, data);

    if (basename(filePath) === '_shared.json') {
      // Flat merge — _shared has multiple top-level keys (nav, footer, ui, notFound, meta)
      Object.assign(messages, data);
    } else {
      // Wrapped — single top-level key = namespace
      Object.assign(messages, data);
    }
  }

  return { messages, chunkFiles };
}

function flattenKeys(obj, prefix = '', leavesOnly = false) {
  const out = new Set();
  const entries = Array.isArray(obj)
    ? obj.map((v, i) => [String(i), v])
    : Object.entries(obj ?? {});
  for (const [k, v] of entries) {
    const full   = prefix ? `${prefix}.${k}` : k;
    const isLeaf = v === null || typeof v !== 'object';
    if (isLeaf) {
      out.add(full);
    } else {
      if (!leavesOnly) out.add(full);
      for (const sub of flattenKeys(v, full, leavesOnly)) out.add(sub);
    }
  }
  return out;
}

// ─── JSON fix utilities ───────────────────────────────────────────────────────

/** Delete a leaf key at a dot-path and prune empty parent objects. */
function deleteDeep(obj, dotPath) {
  const parts = dotPath.split('.');
  const stack = [{ node: obj, key: null }];
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    if (next == null || typeof next !== 'object') return;
    stack.push({ node: cur, key: parts[i] });
    cur = next;
  }
  const last = parts[parts.length - 1];

  if (Array.isArray(cur)) {
    // Use splice for arrays to avoid sparse holes that serialize as null
    const idx = Number(last);
    if (!Number.isNaN(idx) && idx < cur.length) {
      cur.splice(idx, 1);
    }
  } else {
    if (!(last in cur)) return;
    delete cur[last];
  }

  // Prune empty parent objects/arrays bottom-up
  for (let i = stack.length - 1; i >= 1; i--) {
    const { node, key } = stack[i];
    if (!key) continue;
    const child = node[key];
    if (child == null) continue;
    if (Array.isArray(child) && child.length === 0) {
      delete node[key];
    } else if (!Array.isArray(child) && typeof child === 'object' && Object.keys(child).length === 0) {
      delete node[key];
    }
  }
}

/**
 * After leaf deletions, arrays become sparse → JSON.stringify → [null, null, ...]
 * which causes infinite --fix loops. Recursively remove dead collections.
 * Returns true if this node should be deleted by its parent.
 */
function pruneDeadCollections(node) {
  if (node === null || node === undefined) return true;
  if (typeof node !== 'object') return false;
  if (Array.isArray(node)) {
    let allDead = true;
    for (let i = 0; i < node.length; i++) {
      if (node[i] === null || node[i] === undefined) {
        // already dead
      } else if (typeof node[i] === 'object') {
        if (pruneDeadCollections(node[i])) {
          delete node[i];
        } else {
          allDead = false;
        }
      } else {
        allDead = false;
      }
    }
    return allDead;
  }
  let allDead = true;
  for (const key of Object.keys(node)) {
    if (pruneDeadCollections(node[key])) {
      delete node[key];
    } else {
      allDead = false;
    }
  }
  return allDead;
}

// ─── Devkit helpers ───────────────────────────────────────────────────────────

function exitWithJson(obj) {
  writeCheckResult(obj.issues);
  process.exit(0);
}

function toDevkitIssue(file, line, msg) {
  return { check: 'i18n-check', severity: 'error', message: msg, file, line };
}

// ─── DEVKIT self-filter ───────────────────────────────────────────────────────

if (DEVKIT_MODE) {
  const pkgName = process.env.KB_DEVKIT_PACKAGE_NAME ?? '';
  const pkgDir  = process.env.KB_DEVKIT_PACKAGE_DIR  ?? '';

  if (pkgName !== '@kb-labs/web-site') {
    // The remaining declared anchors receive the HARDCODED check only.
    const dirs  = ['src', 'app', 'components'].map(d => join(pkgDir, d)).filter(existsSync);
    const files = dirs.flatMap(d => [...walk(d)]);
    const found = files.flatMap(f => extractHardcoded(f));

    exitWithJson({
      issues: found.map(({ file, line }) =>
        toDevkitIssue(file, line, '[HARDCODED] Raw Cyrillic text — use a prop/token or add // i18n-ignore')),
    });
  }
}

// ─── Colors ───────────────────────────────────────────────────────────────────

const c = NO_COLOR
  ? { red: s => s, yellow: s => s, green: s => s, gray: s => s, bold: s => s }
  : {
      red:    s => `\x1b[31m${s}\x1b[0m`,
      yellow: s => `\x1b[33m${s}\x1b[0m`,
      green:  s => `\x1b[32m${s}\x1b[0m`,
      gray:   s => `\x1b[90m${s}\x1b[0m`,
      bold:   s => `\x1b[1m${s}\x1b[0m`,
    };

// ─── Load messages from chunks ────────────────────────────────────────────────

const SOURCE_DIRS = [join(ROOT, 'app'), join(ROOT, 'components')];

const { messages: enJson, chunkFiles: enChunks } = loadChunks('en');
const { messages: ruJson, chunkFiles: ruChunks } = loadChunks('ru');

const enAllKeys  = flattenKeys(enJson, '', false);
const enLeafKeys = flattenKeys(enJson, '', true);
const ruLeafKeys = flattenKeys(ruJson, '', true);

// ─── Source files ─────────────────────────────────────────────────────────────

const sourceFiles = SOURCE_DIRS.flatMap(d => [...walk(d)]);

// ─── Extract t() key references ───────────────────────────────────────────────

function posToLineFn(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') starts.push(i + 1);
  }
  return pos => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

const KEY_REGEX = /\bt(?:\.raw|\.rich)?\(\s*(['"])([^'"$`\n]+)\1/g;

// Detects namespace from getTranslations({ ..., namespace: 'X' }) or useTranslations('X')
const NS_REGEX = /(?:getTranslations\s*\(\s*\{[^}]*?namespace\s*:\s*['"]([^'"]+)['"]|useTranslations\s*\(\s*['"]([^'"]+)['"]\s*\))/g;

function extractRefs(filePath) {
  const src    = readFileSync(filePath, 'utf8');
  const lineOf = posToLineFn(src);

  const namespaces = new Set();
  NS_REGEX.lastIndex = 0;
  let nsm;
  while ((nsm = NS_REGEX.exec(src)) !== null) {
    const ns = nsm[1] || nsm[2];
    if (ns) namespaces.add(ns);
  }
  const singleNs = namespaces.size === 1 ? [...namespaces][0] : null;
  const hasNs    = namespaces.size > 0;

  const refs = [];
  KEY_REGEX.lastIndex = 0;
  let m;
  while ((m = KEY_REGEX.exec(src)) !== null) {
    const key = m[2].trim();
    if (!key || key.startsWith('{')) continue;
    if (!hasNs && !key.includes('.')) continue;
    const fullKey = singleNs ? `${singleNs}.${key}` : key;
    refs.push({ key: fullKey, file: filePath, line: lineOf(m.index) });
  }
  return refs;
}

const allRefs = sourceFiles.flatMap(f => extractRefs(f));

const refsByKey = new Map();
for (const ref of allRefs) {
  if (!refsByKey.has(ref.key)) refsByKey.set(ref.key, []);
  refsByKey.get(ref.key).push({ file: ref.file, line: ref.line });
}

// ─── Nav-config derived key check ────────────────────────────────────────────
// SiteHeader renders nav items via template literals: t(`nav.megamenu.${item.key}.title`)

const NAV_CONFIG_FILE = join(ROOT, 'components', 'nav-config.ts');
const navDerivedRefs  = [];

if (existsSync(NAV_CONFIG_FILE)) {
  const navSrc = readFileSync(NAV_CONFIG_FILE, 'utf8');
  const lineOf = posToLineFn(navSrc);

  // Derive nav.megamenu.X.title + nav.megamenu.X.description from NavItem `key:` values.
  const NAV_ITEM_KEY_REGEX = /\bkey\s*:\s*['"]([^'"]+)['"]/g;
  let nm;
  while ((nm = NAV_ITEM_KEY_REGEX.exec(navSrc)) !== null) {
    const itemKey = nm[1];
    const line    = lineOf(nm.index);
    for (const suffix of ['title', 'description']) {
      navDerivedRefs.push({ key: `nav.megamenu.${itemKey}.${suffix}`, file: NAV_CONFIG_FILE, line });
    }
  }

  // Register all direct string-valued nav keys: headingKey, labelKey, descKey.
  // These are passed as variables to t() in SiteHeader so the regex can't see them.
  const DIRECT_KEY_REGEX = /\b(?:headingKey|labelKey|descKey)\s*:\s*['"]([^'"]+)['"]/g;
  let dm;
  while ((dm = DIRECT_KEY_REGEX.exec(navSrc)) !== null) {
    navDerivedRefs.push({ key: dm[1], file: NAV_CONFIG_FILE, line: lineOf(dm.index) });
  }
}

for (const { key, file, line } of navDerivedRefs) {
  if (!refsByKey.has(key)) refsByKey.set(key, []);
  refsByKey.get(key).push({ file, line });
}

// ─── Shared top-level keys (available to client via NextIntlClientProvider in layout) ─────

const { messages: sharedMessages } = (() => {
  const sharedPath = join(MESSAGES_DIR, 'en', '_shared.json');
  if (!existsSync(sharedPath)) return { messages: {} };
  try {
    return { messages: JSON.parse(readFileSync(sharedPath, 'utf8')) };
  } catch {
    return { messages: {} };
  }
})();

const CLIENT_AVAILABLE_TOP_KEYS = new Set(Object.keys(sharedMessages));

// ─── Run checks ───────────────────────────────────────────────────────────────

// MISMATCH: compare merged en vs ru leaf key sets
const missingInRu = [...enLeafKeys].filter(k => !ruLeafKeys.has(k));
const extraInRu   = [...ruLeafKeys].filter(k => !enLeafKeys.has(k));

// MISSING: referenced in code but absent from merged messages
const missingRefs = [];
for (const [key, locs] of refsByKey) {
  if (!enAllKeys.has(key)) missingRefs.push({ key, locs });
}
missingRefs.sort((a, b) => a.key.localeCompare(b.key));

// CLIENT_LEAK: 'use client' components calling useTranslations() with keys outside _shared.json
// Suppress per-file with: // i18n-client-provided: <namespace> — documents that caller wraps with provider.
const CLIENT_PROVIDED_RE = /\/\/\s*i18n-client-provided\s*:/;

function isClientFile(filePath) {
  const src = readFileSync(filePath, 'utf8');
  return src.startsWith("'use client'") || src.startsWith('"use client"') || src.includes("\n'use client'") || src.includes('\n"use client"');
}

function isClientProvided(filePath) {
  const src = readFileSync(filePath, 'utf8');
  return CLIENT_PROVIDED_RE.test(src);
}

const clientLeakIssues = [];
for (const [key, locs] of refsByKey) {
  const topKey = key.split('.')[0];
  if (CLIENT_AVAILABLE_TOP_KEYS.has(topKey)) continue;
  for (const loc of locs) {
    if (!loc.file.endsWith('.tsx') && !loc.file.endsWith('.ts')) continue;
    if (!isClientFile(loc.file)) continue;
    if (isClientProvided(loc.file)) continue;
    clientLeakIssues.push({ key, file: loc.file, line: loc.line });
  }
}

// HARDCODED: Cyrillic text in .tsx not via t()
const hardcodedIssues = sourceFiles.flatMap(f => extractHardcoded(f));

// UNUSED: leaf keys never referenced (ancestor check for t.raw() coverage)
function isCoveredByAncestor(key) {
  const parts = key.split('.');
  for (let i = 1; i < parts.length; i++) {
    if (refsByKey.has(parts.slice(0, i).join('.'))) return true;
  }
  return false;
}

const unusedKeys = [...enLeafKeys].filter(k => !refsByKey.has(k) && !isCoveredByAncestor(k)).sort();

// ─── AUTOFIX: delete UNUSED keys from chunk files ─────────────────────────────

if (FIX_MODE && unusedKeys.length > 0) {
  // Group unused keys by which en chunk file they belong to.
  // A key belongs to chunk C if it starts with any top-level key of C.
  const chunkKeyPrefixes = new Map(); // chunkAbsPath → Set of top-level keys

  for (const [absPath, data] of enChunks) {
    chunkKeyPrefixes.set(absPath, new Set(Object.keys(data)));
  }

  /** Find the chunk file that owns a given dot-path key. */
  function findOwnerChunk(dotKey) {
    const topKey = dotKey.split('.')[0];
    for (const [absPath, prefixes] of chunkKeyPrefixes) {
      if (prefixes.has(topKey)) return absPath;
    }
    return null;
  }

  // Group keys by owner chunk
  const fixMap = new Map(); // en chunk absPath → keys to delete
  for (const key of unusedKeys) {
    const owner = findOwnerChunk(key);
    if (!owner) continue;
    if (!fixMap.has(owner)) fixMap.set(owner, []);
    fixMap.get(owner).push(key);
  }

  let totalFixed = 0;

  if (!DRY_RUN) {
    for (const [enPath, keys] of fixMap) {
      // Derive ru chunk path from en path
      const ruPath = enPath.replace(
        join(MESSAGES_DIR, 'en'),
        join(MESSAGES_DIR, 'ru'),
      );

      const enMut = JSON.parse(JSON.stringify(enChunks.get(enPath)));
      const ruData = existsSync(ruPath) ? JSON.parse(readFileSync(ruPath, 'utf8')) : {};
      const ruMut  = JSON.parse(JSON.stringify(ruData));

      for (const key of keys) {
        deleteDeep(enMut, key);
        deleteDeep(ruMut, key);
      }
      pruneDeadCollections(enMut);
      pruneDeadCollections(ruMut);

      writeFileSync(enPath, JSON.stringify(enMut, null, 2) + '\n', 'utf8');
      if (existsSync(ruPath)) {
        writeFileSync(ruPath, JSON.stringify(ruMut, null, 2) + '\n', 'utf8');
      }
      totalFixed += keys.length;
    }
  }

  if (DEVKIT_FIX) {
    const remaining = [];
    for (const { key, locs } of missingRefs) {
      for (const loc of locs) {
        remaining.push(toDevkitIssue(loc.file, loc.line, `[MISSING] Key "${key}" referenced in code but absent from messages`));
      }
    }
    for (const { file, line } of hardcodedIssues) {
      remaining.push(toDevkitIssue(file, line, '[HARDCODED] Raw Cyrillic text — use t() or add // i18n-ignore'));
    }
    exitWithJson({ issues: remaining });
  }

  if (!DEVKIT_MODE) {
    const action = DRY_RUN ? 'Would remove' : 'Removed';
    console.log(`✅  ${action} ${unusedKeys.length} unused keys from en + ru chunks`);
    process.exit(0);
  }
}

// ─── DEVKIT output ────────────────────────────────────────────────────────────

if (DEVKIT_MODE) {
  const issues = [];

  for (const k of missingInRu) {
    issues.push(toDevkitIssue(join(MESSAGES_DIR, 'ru'), 0,
      `[MISMATCH] Key "${k}" present in en chunks but missing from ru chunks`));
  }
  for (const k of extraInRu) {
    issues.push(toDevkitIssue(join(MESSAGES_DIR, 'en'), 0,
      `[MISMATCH] Key "${k}" present in ru chunks but missing from en chunks`));
  }
  for (const { key, locs } of missingRefs) {
    for (const loc of locs) {
      issues.push(toDevkitIssue(loc.file, loc.line,
        `[MISSING] Key "${key}" referenced in code but absent from messages`));
    }
  }
  for (const { file, line } of hardcodedIssues) {
    issues.push(toDevkitIssue(file, line,
      '[HARDCODED] Raw Cyrillic text — use t() or add // i18n-ignore'));
  }
  for (const { key, file, line } of clientLeakIssues) {
    issues.push(toDevkitIssue(file, line,
      `[CLIENT_LEAK] Key "${key}" used in 'use client' component but not available via NextIntlClientProvider — add a page-level <NextIntlClientProvider messages={{...}}> or move key to _shared.json`));
  }
  for (const key of unusedKeys) {
    issues.push({
      check: 'i18n-check',
      severity: 'warning',
      message: `[UNUSED] Key "${key}" in messages but never referenced in source`,
      file: join(MESSAGES_DIR, 'en'),
      autoFix: true,
      fix: 'node sites/web/apps/web/scripts/i18n-check.mjs --fix',
    });
  }

  exitWithJson({ issues });
}

// ─── STANDALONE output ────────────────────────────────────────────────────────

let exitCode = 0;
const SEP  = '─'.repeat(64);
const NL   = () => console.log();
const LINE = () => console.log(c.gray(SEP));

NL();
console.log(c.bold('KB Labs i18n Check'));
LINE();
console.log(c.gray(`Messages : ${enChunks.size} en chunks · ${ruChunks.size} ru chunks`));
console.log(c.gray(`Keys     : en ${enLeafKeys.size} leaves · ru ${ruLeafKeys.size} leaves`));
console.log(c.gray(`Source   : ${sourceFiles.length} files in app/ + components/`));
console.log(c.gray(`Refs     : ${refsByKey.size} unique keys referenced`));
NL();

// 1. MISMATCH
if (missingInRu.length > 0 || extraInRu.length > 0) {
  exitCode = 1;
  const total = missingInRu.length + extraInRu.length;
  console.log(c.red(c.bold(`❌  MISMATCH (${total}) — en and ru chunks have different key sets`)));
  NL();
  if (missingInRu.length > 0) {
    console.log(c.red(`   Missing in ru (${missingInRu.length}):`));
    missingInRu.slice(0, 20).forEach(k => console.log(c.red(`     · ${k}`)));
    if (missingInRu.length > 20) console.log(c.red(`     … and ${missingInRu.length - 20} more`));
    NL();
  }
  if (extraInRu.length > 0) {
    console.log(c.red(`   Extra in ru / missing in en (${extraInRu.length}):`));
    extraInRu.slice(0, 20).forEach(k => console.log(c.red(`     · ${k}`)));
    if (extraInRu.length > 20) console.log(c.red(`     … and ${extraInRu.length - 20} more`));
    NL();
  }
} else {
  console.log(c.green('✅  MISMATCH  — en and ru chunks are in sync'));
  NL();
}

// 2. MISSING
if (missingRefs.length > 0) {
  exitCode = 1;
  console.log(c.red(c.bold(`❌  MISSING (${missingRefs.length}) — referenced in code, absent from messages`)));
  console.log(c.red('   These render as the raw key string or throw at runtime.'));
  NL();
  for (const { key, locs } of missingRefs) {
    console.log(c.red(`   ${key}`));
    locs.slice(0, 3).forEach(loc =>
      console.log(c.gray(`     ${relative(ROOT, loc.file)}:${loc.line}`)));
    if (locs.length > 3) console.log(c.gray(`     … and ${locs.length - 3} more`));
  }
  NL();
} else {
  console.log(c.green('✅  MISSING   — no missing keys'));
  NL();
}

// 3. HARDCODED
if (hardcodedIssues.length > 0) {
  exitCode = 1;
  console.log(c.red(c.bold(`❌  HARDCODED (${hardcodedIssues.length}) — Cyrillic text in .tsx not via t()`)));
  console.log(c.red('   Add // i18n-ignore to intentionally skip a line.'));
  NL();
  hardcodedIssues.forEach(({ file, line, content }) => {
    console.log(c.red(`   ${relative(ROOT, file)}:${line}`));
    console.log(c.gray(`     ${content}`));
  });
  NL();
} else {
  console.log(c.green('✅  HARDCODED — no raw Cyrillic text found in .tsx'));
  NL();
}

// 4. CLIENT_LEAK
if (clientLeakIssues.length > 0) {
  exitCode = 1;
  console.log(c.red(c.bold(`❌  CLIENT_LEAK (${clientLeakIssues.length}) — keys used in 'use client' components not available via NextIntlClientProvider`)));
  console.log(c.red('   These render as the raw key string at runtime.'));
  console.log(c.red('   Fix: add a page-level <NextIntlClientProvider messages={{...}}> or move keys to _shared.json.'));
  NL();
  const seen = new Set();
  for (const { key, file, line } of clientLeakIssues) {
    const fileKey = `${key}|${file}`;
    if (seen.has(fileKey)) continue;
    seen.add(fileKey);
    console.log(c.red(`   ${key}`));
    console.log(c.gray(`     ${relative(ROOT, file)}:${line}`));
  }
  NL();
} else {
  console.log(c.green('✅  CLIENT_LEAK — all client-component keys are available via provider'));
  NL();
}

// 5. UNUSED
if (unusedKeys.length > 0) {
  if (STRICT) exitCode = 1;
  const icon  = STRICT ? c.red('❌') : c.yellow('⚠️ ');
  const label = STRICT
    ? `UNUSED (${unusedKeys.length}) — in messages but never referenced [strict]`
    : `UNUSED (${unusedKeys.length}) — in messages but never referenced`;
  console.log(`${icon}  ${c.bold(label)}`);
  if (!STRICT) {
    console.log(c.yellow('   Dynamic template-literal keys are excluded from analysis.'));
    console.log(c.yellow('   Run with --strict to make this fatal.\n'));
  } else {
    NL();
  }
  unusedKeys.slice(0, 40).forEach(k => console.log(STRICT ? c.red(`   · ${k}`) : c.yellow(`   · ${k}`)));
  if (unusedKeys.length > 40) console.log(c.yellow(`   … and ${unusedKeys.length - 40} more`));
  NL();
} else {
  console.log(c.green('✅  UNUSED    — every messages key is referenced'));
  NL();
}

// Summary
LINE();
if (exitCode === 0 && unusedKeys.length === 0) {
  console.log(c.green(c.bold('✅  All checks passed — i18n is clean.')));
} else if (exitCode === 0) {
  console.log(
    c.green('✅  No fatal errors.') +
    c.yellow(`  (${unusedKeys.length} unused — run --strict to enforce, --fix to remove)`),
  );
} else {
  const parts = [
    missingInRu.length + extraInRu.length > 0 && `${missingInRu.length + extraInRu.length} MISMATCH`,
    missingRefs.length > 0                    && `${missingRefs.length} MISSING`,
    hardcodedIssues.length > 0                && `${hardcodedIssues.length} HARDCODED`,
    clientLeakIssues.length > 0               && `${clientLeakIssues.length} CLIENT_LEAK`,
    STRICT && unusedKeys.length > 0           && `${unusedKeys.length} UNUSED`,
  ].filter(Boolean).join(' · ');
  console.log(c.red(c.bold(`❌  Failed: ${parts}`)));
}
NL();

process.exit(exitCode);
