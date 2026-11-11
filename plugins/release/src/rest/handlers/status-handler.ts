/**
 * Status handler - Get current release status for a scope
 *
 * Checks:
 * - .kb/release/plans/{scope}/current/plan.json
 * - .kb/release/plans/{scope}/current/status.json
 * - .kb/release/plans/{scope}/current/changelog.md
 * - .kb/release/history/ for last release
 */

import { defineHandler, findRepoRoot, type RestInput, rethrowForRest } from '@kb-labs/sdk';
import type { StatusResponse, ReleasePlan, ReleaseScopeInfo, StatusInput } from '../../contracts/index.js';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { glob } from 'glob';
import { scopeToDir } from '../../shared/utils';

export default defineHandler({
  async execute(ctx, input: RestInput<StatusInput>): Promise<StatusResponse> {
    try {
      const scope = input.query?.scope || 'root';
      const cwd = ctx.cwd || process.cwd();
      const repoRoot = await findRepoRoot(cwd);

      // Get scope info (package metadata)
      const scopeInfo = await getScopeInfo(repoRoot, scope);

      // Paths for scope-specific files
      const scopeDirName = scopeToDir(scope);
      const scopeDir = join(repoRoot, '.kb/release/plans', scopeDirName, 'current');
      const planPath = join(scopeDir, 'plan.json');
      const changelogPath = join(scopeDir, 'changelog.md');

      // Check if plan exists
      const hasPlan = await fileExists(planPath);
      const hasChangelog = await fileExists(changelogPath);

      let planStatus: 'idle' | 'ready' | 'running' | 'completed' | 'failed' = 'idle';
      let packagesInPlan = 0;

      if (hasPlan) {
        try {
          const planContent = await readFile(planPath, 'utf-8');
          const plan: ReleasePlan = JSON.parse(planContent);

          packagesInPlan = plan.packages.length;

          // Determine status based on plan metadata
          if (plan.packages.some(pkg => pkg.isPublished)) {
            planStatus = 'completed';
          } else if (packagesInPlan > 0) {
            planStatus = 'ready';
          }
        } catch {
          planStatus = 'failed';
        }
      }

      // Check for last release in history
      let lastReleaseAt: string | undefined;
      let hasReport = false;

      try {
        const historyIndexPath = join(repoRoot, '.kb/release/history/index.json');
        const indexContent = await readFile(historyIndexPath, 'utf-8');
        const index = JSON.parse(indexContent);

        // Find last release for this scope
        const scopeReleases = (index.releases as Array<{ scope: string; timestamp: string }>).filter((r) => r.scope === scope);
        if (scopeReleases.length > 0) {
          hasReport = true;
          lastReleaseAt = scopeReleases[0]!.timestamp;
        }
      } catch {
        // No history index yet
      }

      return {
        scope,
        scopeInfo,
        hasPlan,
        hasReport,
        hasChangelog,
        planStatus,
        packagesInPlan,
        lastReleaseAt,
      };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});

/**
 * Get scope metadata (name, version, description) from package.json
 */
async function getScopeInfo(repoRoot: string, scope: string): Promise<ReleaseScopeInfo | undefined> {
  try {
    if (scope === 'root') {
      // Root scope
      const rootPkgPath = join(repoRoot, 'package.json');
      const pkg = JSON.parse(await readFile(rootPkgPath, 'utf-8'));

      return {
        id: 'root',
        name: pkg.name || 'Root',
        path: repoRoot,
        currentVersion: pkg.version,
        description: pkg.description,
        type: 'root',
      };
    }

    // Find package by name
    const packageJsonFiles = await glob('*/package.json', {
      cwd: repoRoot,
      ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
      absolute: true,
    });

    for (const pkgPath of packageJsonFiles) {
      try {
        const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));

        if (pkg.name === scope) {
          const pkgDir = join(pkgPath, '..');

          // Check if it's a monorepo
          const isMonorepo =
            (await fileExists(join(pkgDir, 'pnpm-workspace.yaml'))) ||
            (await fileExists(join(pkgDir, 'lerna.json')));

          return {
            id: pkg.name,
            name: pkg.displayName || pkg.name,
            path: pkgDir,
            currentVersion: pkg.version,
            description: pkg.description,
            type: isMonorepo ? 'monorepo' : 'package',
          };
        }
      } catch {
        // Skip invalid package.json
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
