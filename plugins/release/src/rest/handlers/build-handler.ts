/**
 * Build handler — thin adapter over core buildPackages().
 */

import { defineHandler, findRepoRoot, type RestInput, rethrowForRest } from '@kb-labs/sdk';
import type { BuildRequest, BuildResponse } from '../../contracts/index.js';
import { buildPackages, type PackageVersion } from '../../core/index.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { scopeToDir } from '../../shared/utils';
import { join } from 'node:path';

// ── helpers ────────────────────────────────────────────────────────────────

async function copyChangelogToPackages(
  repoRoot: string,
  packages: Array<{ name: string; path: string }>,
  results: Array<{ name: string; success: boolean }>,
  changelogContent: string,
): Promise<void> {
  for (const r of results) {
    if (!r.success) {
      break;
    }
    const pkg = packages.find(p => p.name === r.name);
    if (!pkg) {
      continue;
    }
    const pkgPath = pkg.path.startsWith('/') ? pkg.path : join(repoRoot, pkg.path);
    try {
      await writeFile(join(pkgPath, 'CHANGELOG.md'), changelogContent, 'utf-8');
      const distDir = join(pkgPath, 'dist');
      if (!existsSync(distDir)) {
        await mkdir(distDir, { recursive: true });
      }
      await writeFile(join(distDir, 'CHANGELOG.md'), changelogContent, 'utf-8');
    } catch { /* skip */ }
  }
}

export default defineHandler({
  async execute(ctx, input: RestInput<unknown, BuildRequest>): Promise<BuildResponse> {
    try {
      const scope = input.body?.scope || 'root';
      const cwd = ctx.cwd ?? process.cwd();
      const repoRoot = await findRepoRoot(cwd);
      const startTime = Date.now();

      // Read plan
      const scopeDir = scopeToDir(scope);
      const planPath = join(repoRoot, '.kb/release/plans', scopeDir, 'current', 'plan.json');

      let plan: { packages: Array<{ name: string; path: string; currentVersion: string; nextVersion: string; bump: unknown }> };
      try {
        plan = JSON.parse(await readFile(planPath, 'utf-8'));
      } catch {
        return { scope, success: false, packages: [], builtCount: 0, totalCount: 0, totalDurationMs: Date.now() - startTime };
      }

      // Build via core
      const results = await buildPackages(plan.packages as unknown as PackageVersion[], { logger: ctx.platform?.logger, shell: ctx.api.shell });

      // Copy changelog if exists
      const changelogPath = join(repoRoot, '.kb/release/plans', scopeDir, 'current', 'changelog.md');
      let changelogContent: string | undefined;
      try { changelogContent = await readFile(changelogPath, 'utf-8'); } catch { /* skip */ }

      if (changelogContent) {
        await copyChangelogToPackages(repoRoot, plan.packages, results, changelogContent);
      }

      const builtCount = results.filter(r => r.success).length;
      return {
        scope,
        success: results.every(r => r.success),
        packages: results.map(r => ({ name: r.name, success: r.success, error: r.error, durationMs: r.durationMs })),
        builtCount,
        totalCount: plan.packages.length,
        totalDurationMs: Date.now() - startTime,
      };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
