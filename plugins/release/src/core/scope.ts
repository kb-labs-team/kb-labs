/**
 * Scope utilities — resolve scope name to filesystem path.
 *
 * "scope" is a filter/selector concept (e.g. "@kb-labs/release", "installer/kb-labs-create").
 * "scopePath" is the resolved absolute filesystem path used for checks (runIn: scopePath) and git ops.
 *
 * Discovery (planRelease) always uses repoRoot + scope filter — never scopePath directly.
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import globby from 'globby';

/**
 * Resolve a scope name to an absolute filesystem path.
 *
 * - 'root' → repoRoot
 * - '@kb-labs/foo' → directory containing package.json with that name
 * - 'installer/kb-labs-create' → repoRoot/installer/kb-labs-create (direct path)
 *
 * Used only where a physical path is required:
 *   - checks with runIn: 'scopePath'
 *   - git commit/tag cwd
 *   - changelog gitCwd
 *
 * NOT used for package discovery — planRelease always takes (repoRoot, scope).
 */
export async function resolveScopePath(repoRoot: string, scope: string): Promise<string> {
  if (!scope || scope === 'root') {
    return repoRoot;
  }

  // Scoped npm package name → scan package.json files
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

  // Direct relative path (e.g. 'installer/kb-labs-create', 'plugins/kb-labs-mind')
  return join(repoRoot, scope);
}
