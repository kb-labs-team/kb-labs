/**
 * Entry point collection for dead code detection
 *
 * Collects all files that are "alive by definition" — entry points from
 * package.json, tsup.config.ts, manifest.ts, tests, and configs.
 *
 * Fail-open: if we can't parse a config, we emit a warning and treat
 * ALL files in the package as alive (zero false positives).
 */

import fs from 'node:fs';
import path from 'node:path';
import globby from 'globby';

export interface EntryPointResult {
  /** Absolute paths of entry point files (roots for BFS) */
  entryFiles: Set<string>;
  /** Files alive by convention (tests, configs) — not part of graph traversal */
  aliveByConvention: Set<string>;
  /** Non-fatal issues during parsing */
  warnings: string[];
  /** If true, couldn't parse configs — all files should be treated as alive */
  failOpen: boolean;
}

// Config file basenames that are always alive
const CONFIG_FILE_PATTERNS = [
  'tsup.config.ts',
  'tsup.config.mts',
  'tsup.config.js',
  'tsup.config.mjs',
  'tsup.bin.config.ts',
  'tsup.lib.config.ts',
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.js',
  'jest.config.ts',
  'jest.config.js',
  'eslint.config.js',
  'eslint.config.mjs',
  'vitest.setup.ts',
  'vitest.setup.js',
];

/**
 * Collect all entry points for a package.
 *
 * A file is an entry point if it's referenced by package.json, tsup.config.ts,
 * or manifest.ts. Tests and config files are always alive by convention.
 */
export async function collectEntryPoints(
  packageDir: string,
  packageJson: Record<string, unknown>,
): Promise<EntryPointResult> {
  const entryFiles = new Set<string>();
  const aliveByConvention = new Set<string>();
  const warnings: string[] = [];
  let failOpen = false;

  // 1. package.json entries
  collectPackageJsonEntries(packageDir, packageJson, entryFiles, warnings);

  // 2. tsup.config.ts entries
  const tsupOk = await collectTsupEntries(packageDir, entryFiles, warnings);
  if (!tsupOk) {
    failOpen = true;
  }

  // 3. manifest.ts handler paths
  collectManifestHandlers(packageDir, entryFiles, warnings);

  // 4. Dynamic imports (string literal only)
  await collectDynamicImportTargets(packageDir, entryFiles, warnings);

  // 5. Test files — always alive
  await collectTestFiles(packageDir, aliveByConvention);

  // 6. Config files — always alive
  collectConfigFiles(packageDir, aliveByConvention);

  // Fallback: if no entry points found at all, use src/index.ts
  if (entryFiles.size === 0) {
    const defaultEntry = path.join(packageDir, 'src', 'index.ts');
    if (fs.existsSync(defaultEntry)) {
      entryFiles.add(defaultEntry);
      warnings.push('No entry points found, using src/index.ts as default');
    }
  }

  return { entryFiles, aliveByConvention, warnings, failOpen };
}

/**
 * Map a dist/ path to its src/ counterpart.
 * dist/index.js → src/index.ts
 * dist/sandbox/bootstrap.js → src/sandbox/bootstrap.ts
 */
export function distPathToSrcPath(
  distPath: string,
  packageDir: string,
): string | null {
  // Normalize the path — remove leading ./ if present
  let normalized = distPath.replace(/^\.?\/?/, '');

  // Replace dist/ prefix with src/
  if (normalized.startsWith('dist/') || normalized.startsWith('dist\\')) {
    normalized = 'src/' + normalized.slice(5);
  }

  // Replace extensions
  normalized = normalized
    .replace(/\.d\.ts$/, '.ts')
    .replace(/\.js$/, '.ts')
    .replace(/\.mjs$/, '.ts')
    .replace(/\.cjs$/, '.ts');

  const absolute = path.resolve(packageDir, normalized);

  if (fs.existsSync(absolute)) {
    return absolute;
  }

  // Try index.ts fallback (for directory-style entries)
  const indexPath = path.join(absolute.replace(/\.ts$/, ''), 'index.ts');
  if (fs.existsSync(indexPath)) {
    return indexPath;
  }

  return null;
}

// --- Internal helpers ---

function collectPackageJsonEntries(
  packageDir: string,
  pkgJson: Record<string, unknown>,
  entryFiles: Set<string>,
  warnings: string[],
): void {
  // main, module, types fields
  for (const field of ['main', 'module', 'types', 'typings']) {
    const value = pkgJson[field];
    if (typeof value === 'string') {
      const srcPath = distPathToSrcPath(value, packageDir);
      if (srcPath) {
        entryFiles.add(srcPath);
      }
    }
  }

  // bin field (string or object)
  const bin = pkgJson['bin'];
  if (typeof bin === 'string') {
    const srcPath = distPathToSrcPath(bin, packageDir);
    if (srcPath) {entryFiles.add(srcPath);}
  } else if (bin && typeof bin === 'object') {
    for (const value of Object.values(bin as Record<string, string>)) {
      if (typeof value === 'string') {
        const srcPath = distPathToSrcPath(value, packageDir);
        if (srcPath) {entryFiles.add(srcPath);}
      }
    }
  }

  // exports field
  const exports = pkgJson['exports'];
  if (exports && typeof exports === 'object') {
    collectExportsEntries(
      packageDir,
      exports as Record<string, unknown>,
      entryFiles,
      warnings,
    );
  }
}

function collectExportsEntries(
  packageDir: string,
  exports: Record<string, unknown>,
  entryFiles: Set<string>,
  _warnings: string[],
): void {
  for (const [key, value] of Object.entries(exports)) {
    // Skip wildcard catch-all
    if (key.includes('*')) {continue;}

    const importPath = extractImportPath(value);
    if (importPath) {
      const srcPath = distPathToSrcPath(importPath, packageDir);
      if (srcPath) {
        entryFiles.add(srcPath);
      }
    }
  }
}

function extractImportPath(value: unknown): string | null {
  if (typeof value === 'string') {return value;}
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Try import, then default, then require
    for (const key of ['import', 'default', 'require']) {
      if (typeof obj[key] === 'string') {return obj[key] as string;}
    }
  }
  return null;
}

async function collectTsupEntries(
  packageDir: string,
  entryFiles: Set<string>,
  warnings: string[],
): Promise<boolean> {
  // Find tsup config files
  const tsupConfigs = [
    'tsup.config.ts',
    'tsup.config.mts',
    'tsup.config.js',
    'tsup.config.mjs',
    'tsup.bin.config.ts',
    'tsup.lib.config.ts',
  ];

  let foundAny = false;

  for (const configName of tsupConfigs) {
    const configPath = path.join(packageDir, configName);
    if (!fs.existsSync(configPath)) {continue;}

    foundAny = true;

    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const entries = parseTsupEntries(content);

      for (const entry of entries) {
        // Check if it's a glob
        if (entry.includes('*') || entry.includes('{')) {
          const expanded = await globby(entry, {
            cwd: packageDir,
            absolute: true,
          });
          for (const file of expanded) {
            entryFiles.add(file);
          }
        } else {
          const absolute = path.resolve(packageDir, entry);
          if (fs.existsSync(absolute)) {
            entryFiles.add(absolute);
          }
        }
      }
    } catch {
      warnings.push(`Failed to parse ${configName}`);
      return false; // Trigger fail-open
    }
  }

  // No tsup config is fine — not all packages use tsup
  if (!foundAny) {return true;}

  return true;
}

/**
 * Parse entry points from tsup config file content.
 * Handles: string, array of strings, object of strings.
 */
export function parseTsupEntries(content: string): string[] {
  const entries: string[] = [];

  // Pattern 1: entry: 'src/index.ts'
  const singleMatch = content.match(/entry\s*:\s*['"]([^'"]+)['"]/);
  if (singleMatch && singleMatch[1]) {
    entries.push(singleMatch[1]);
    return entries;
  }

  // Pattern 2: entry: ['src/index.ts', 'src/other.ts']
  // Pattern 3: entry: { index: 'src/index.ts', other: 'src/other.ts' }
  // Both can be extracted by finding all src/ paths within the entry block
  const entryBlockMatch = content.match(
    /entry\s*:\s*[\[{]([\s\S]*?)[\]}]/,
  );
  if (entryBlockMatch && entryBlockMatch[1]) {
    const block = entryBlockMatch[1];
    // Extract all quoted paths
    const pathPattern = /['"]([^'"]*?src\/[^'"]+)['"]/g;
    let match;
    while ((match = pathPattern.exec(block)) !== null) {
      if (match[1]) {entries.push(match[1]);}
    }
    return entries;
  }

  return entries;
}

function collectManifestHandlers(
  packageDir: string,
  entryFiles: Set<string>,
  warnings: string[],
): void {
  const manifestPath = path.join(packageDir, 'src', 'manifest.ts');
  if (!fs.existsSync(manifestPath)) {return;}

  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    const handlers = parseManifestHandlers(content);

    for (const handlerPath of handlers) {
      // Handler paths are like './cli/commands/run.js#default'
      // Strip the #export suffix
      const pathOnly = handlerPath.split('#')[0] ?? handlerPath;
      // Map .js → .ts and prepend src/
      const srcRelative = 'src/' + pathOnly.replace(/^\.\//, '').replace(/\.js$/, '.ts');
      const absolute = path.resolve(packageDir, srcRelative);

      if (fs.existsSync(absolute)) {
        entryFiles.add(absolute);
      }
    }

    // Also mark manifest.ts itself as an entry point
    entryFiles.add(manifestPath);
  } catch {
    warnings.push('Failed to parse manifest.ts');
  }
}

/**
 * Extract handler paths from manifest.ts content.
 * Matches: handler: './path/to/file.js#export' and handlerPath: './path/to/file.js'
 */
export function parseManifestHandlers(content: string): string[] {
  const handlers: string[] = [];
  const seen = new Set<string>();

  // Match handler: './path.js#export' and handlerPath: './path.js'
  const pattern = /(?:handler|handlerPath)\s*:\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const matchValue = match[1];
    if (!matchValue) {continue;}
    const raw = matchValue.split('#')[0] ?? matchValue;
    if (!seen.has(raw)) {
      seen.add(raw);
      handlers.push(raw);
    }
  }

  return handlers;
}

async function collectDynamicImportTargets(
  packageDir: string,
  entryFiles: Set<string>,
  _warnings: string[],
): Promise<void> {
  const srcDir = path.join(packageDir, 'src');
  if (!fs.existsSync(srcDir)) {return;}

  const sourceFiles = await globby('**/*.{ts,tsx}', {
    cwd: srcDir,
    absolute: true,
    ignore: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**'],
  });

  // Only extract string-literal dynamic imports (not template literals)
  const dynamicImportPattern = /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

  for (const file of sourceFiles) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      let match;
      while ((match = dynamicImportPattern.exec(content)) !== null) {
        const importPath = match[1];
        if (!importPath) {continue;}
        const resolved = resolveFilePath(importPath, file);
        if (resolved) {
          entryFiles.add(resolved);
        }
      }
    } catch {
      // Skip unreadable files
    }
  }
}

async function collectTestFiles(
  packageDir: string,
  aliveByConvention: Set<string>,
): Promise<void> {
  const srcDir = path.join(packageDir, 'src');
  if (!fs.existsSync(srcDir)) {return;}

  const testFiles = await globby(
    ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx', '**/__tests__/**/*.ts'],
    { cwd: srcDir, absolute: true },
  );

  for (const file of testFiles) {
    aliveByConvention.add(file);
  }
}

function collectConfigFiles(
  packageDir: string,
  aliveByConvention: Set<string>,
): void {
  for (const pattern of CONFIG_FILE_PATTERNS) {
    const configPath = path.join(packageDir, pattern);
    if (fs.existsSync(configPath)) {
      aliveByConvention.add(configPath);
    }
  }
}

/**
 * Resolve a relative import path to an absolute file path.
 * Handles ESM convention: import from './foo.js' → ./foo.ts
 */
function resolveFilePath(
  importPath: string,
  fromFile: string,
): string | null {
  const dir = path.dirname(fromFile);
  const base = path.resolve(dir, importPath);

  // Try direct with .js → .ts mapping
  const tsPath = base.replace(/\.js$/, '.ts');
  if (fs.existsSync(tsPath)) {return tsPath;}
  if (fs.existsSync(base)) {return base;}

  // Try with .ts extension
  if (fs.existsSync(base + '.ts')) {return base + '.ts';}
  if (fs.existsSync(base + '.tsx')) {return base + '.tsx';}

  // Try as directory with index.ts
  if (fs.existsSync(path.join(base, 'index.ts'))) {
    return path.join(base, 'index.ts');
  }

  return null;
}
