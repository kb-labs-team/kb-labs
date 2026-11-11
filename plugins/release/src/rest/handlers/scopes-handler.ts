/**
 * Scopes handler - List available release scopes
 *
 * Returns list of packages/repos that can be released
 * Analogous to commit-plugin scopes
 */

import { defineHandler, findRepoRoot, discoverSubRepoPaths, rethrowForRest } from '@kb-labs/sdk';
import type { ScopesResponse, ReleaseScopeInfo } from '../../contracts/index.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export default defineHandler({
  async execute(ctx): Promise<ScopesResponse> {
    try {
    const cwd = ctx.cwd || process.cwd();
    const repoRoot = await findRepoRoot(cwd);

    const scopes: ReleaseScopeInfo[] = [];

    // 1. Add root scope (umbrella repository)
    try {
      const rootPackageJson = JSON.parse(
        await readFile(join(repoRoot, 'package.json'), 'utf-8')
      );

      scopes.push({
        id: 'root',
        name: rootPackageJson.name || 'Root',
        path: repoRoot,
        currentVersion: rootPackageJson.version,
        description: rootPackageJson.description,
        type: 'root',
      });
    } catch {
      // No package.json at root - skip root scope
    }

    // 2. Discover sub-repos via .gitmodules (works with nested layout)
    const subRepoPaths = discoverSubRepoPaths(repoRoot);

    for (const subRepoPath of subRepoPaths) {
      const pkgPath = join(subRepoPath, 'package.json');

      try {
        const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));

        if (!pkg.name) {continue;}

        // Check if it's a monorepo (has pnpm-workspace.yaml or lerna.json)
        const isMonorepo =
          (await fileExists(join(subRepoPath, 'pnpm-workspace.yaml'))) ||
          (await fileExists(join(subRepoPath, 'lerna.json')));

        scopes.push({
          id: pkg.name,
          name: pkg.displayName || pkg.name,
          path: subRepoPath,
          currentVersion: pkg.version,
          description: pkg.description,
          type: isMonorepo ? 'monorepo' : 'package',
        });
      } catch {
        // Skip sub-repos without valid package.json
      }
    }

    // Deduplicate by id (prevents virtual scroll bugs)
    const uniqueScopes = Array.from(
      new Map(scopes.map(scope => [scope.id, scope])).values()
    );

    // Sort by name
    uniqueScopes.sort((a, b) => a.name.localeCompare(b.name));

    return { scopes: uniqueScopes };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
