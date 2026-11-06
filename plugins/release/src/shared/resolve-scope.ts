import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import globby from 'globby';

/**
 * Resolve scope name to absolute filesystem path.
 * Scans all package.json in repoRoot to find the matching package by name.
 */
export async function resolveScopePath(repoRoot: string, scope: string): Promise<string> {
  if (scope === 'root') {
    return repoRoot;
  }

  if (scope.startsWith('@')) {
    const packageJsonPaths = await globby('**/package.json', {
      cwd: repoRoot,
      absolute: true,
      onlyFiles: true,
      ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**', '**/.*/**'],
    });

    for (const pkgJsonPath of packageJsonPaths) {
      try {
        const pkg = JSON.parse(await readFile(pkgJsonPath, 'utf-8'));
        if (pkg.name === scope) {
          return join(pkgJsonPath, '..');
        }
      } catch { /* skip */ }
    }
  }

  // Direct path or fallback
  return join(repoRoot, scope);
}
