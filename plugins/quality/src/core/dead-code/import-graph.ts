/**
 * File-level import graph and BFS reachability analysis
 *
 * Builds a directed graph of file → imported files, then walks from
 * entry points to find all reachable (alive) files.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Import extraction regex patterns.
 * Tested across 350K+ LOC by devkit (devkit-check-imports.mjs).
 */
const IMPORT_PATTERNS: RegExp[] = [
  // Static imports: import X from 'module', import { X } from 'module', import 'module'
  /import\s+(?:[\w*{}\n\r\t, ]+\s+from\s+)?['"]([^'"]+)['"]/g,

  // Dynamic imports (string literal): import('./module'), import("./module")
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,

  // CommonJS require: require('./module'), require("./module")
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,

  // Re-exports: export { X } from 'module', export * from 'module'
  /export\s+(?:[\w*{}\n\r\t, ]+\s+)?from\s+['"]([^'"]+)['"]/g,
];

/**
 * Extensions to try when resolving imports, in priority order.
 */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Extract all import paths from a source file's content.
 * Returns raw import specifiers (both relative and package).
 */
export function extractFileImports(content: string): string[] {
  const imports: string[] = [];

  for (const pattern of IMPORT_PATTERNS) {
    // Reset regex state (global flag)
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const specifier = match[1];
      if (specifier) {
        imports.push(specifier);
      }
    }
  }

  return imports;
}

/**
 * Check if an import specifier is a relative/local import.
 */
export function isRelativeImport(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * Resolve a relative import to an absolute file path.
 *
 * Handles ESM convention where source code imports './foo.js'
 * but the actual file is './foo.ts'.
 */
export function resolveRelativeImport(
  specifier: string,
  sourceFile: string,
): string | null {
  const dir = path.dirname(sourceFile);
  const basePath = path.resolve(dir, specifier);

  // 1. ESM convention: strip .js and try .ts
  if (specifier.endsWith('.js')) {
    const tsPath = basePath.slice(0, -3) + '.ts';
    if (fs.existsSync(tsPath)) {return tsPath;}
    const tsxPath = basePath.slice(0, -3) + '.tsx';
    if (fs.existsSync(tsxPath)) {return tsxPath;}
  }

  // 2. Exact match
  if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
    return basePath;
  }

  // 3. Try adding extensions
  for (const ext of RESOLVE_EXTENSIONS) {
    const withExt = basePath + ext;
    if (fs.existsSync(withExt)) {return withExt;}
  }

  // 4. Try as directory with index file
  if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
    for (const ext of RESOLVE_EXTENSIONS) {
      const indexPath = path.join(basePath, 'index' + ext);
      if (fs.existsSync(indexPath)) {return indexPath;}
    }
  }

  // 5. Try as directory without existing check (basePath might not have extension)
  for (const ext of RESOLVE_EXTENSIONS) {
    const indexPath = path.join(basePath, 'index' + ext);
    if (fs.existsSync(indexPath)) {return indexPath;}
  }

  return null;
}

/**
 * Build a file-level import graph for all source files.
 *
 * Returns a map: absolute file path → set of absolute imported file paths.
 * Only includes relative imports (not external packages).
 */
export function buildFileImportGraph(
  sourceFiles: string[],
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();

  for (const file of sourceFiles) {
    const deps = new Set<string>();
    graph.set(file, deps);

    try {
      const content = fs.readFileSync(file, 'utf-8');
      const imports = extractFileImports(content);

      for (const specifier of imports) {
        if (!isRelativeImport(specifier)) {continue;}

        const resolved = resolveRelativeImport(specifier, file);
        if (resolved) {
          deps.add(resolved);
        }
      }
    } catch {
      // Skip unreadable files — they won't contribute edges
    }
  }

  return graph;
}

/**
 * BFS from entry points through the import graph.
 * Returns the set of all reachable file paths.
 */
export function findReachableFiles(
  entryPoints: Set<string>,
  importGraph: Map<string, Set<string>>,
): Set<string> {
  const visited = new Set<string>();
  const queue = [...entryPoints];

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (visited.has(current)) {continue;}
    visited.add(current);

    const deps = importGraph.get(current);
    if (deps) {
      for (const dep of deps) {
        if (!visited.has(dep)) {
          queue.push(dep);
        }
      }
    }
  }

  return visited;
}

/**
 * Count total edges in the import graph.
 */
export function countGraphEdges(graph: Map<string, Set<string>>): number {
  let count = 0;
  for (const deps of graph.values()) {
    count += deps.size;
  }
  return count;
}
