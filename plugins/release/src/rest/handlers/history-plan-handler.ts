/**
 * History plan handler - Get specific release plan from history
 *
 * Reads: .kb/release/history/{scope}/{id}/report.json
 *
 * The plan is never persisted as a standalone plan.json — it's embedded in
 * the release report (see pipeline.ts's buildReport()). Older/persisted
 * reports predate a few ReleasePlanSchema-required fields (schemaVersion,
 * scope, createdAt), so we backfill them from data already on hand rather
 * than silently returning a plan that doesn't satisfy its own contract.
 */

import { defineHandler, findRepoRoot, type RestInput, rethrowForRest } from '@kb-labs/sdk';
import type { HistoryPlanResponse, ReleasePlan, ReleaseReport } from '../../contracts/index.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scopeToDir } from '../../shared/utils';

export interface HistoryPlanParams {
  scope: string;  // Scope (e.g., "root" or "@kb-labs/shared")
  id: string;     // Release ID (folder name like 2026-01-04T12-30-00Z)
}

export default defineHandler({
  async execute(ctx, input: RestInput<unknown, unknown, HistoryPlanParams>): Promise<HistoryPlanResponse> {
    const { scope, id } = input.params!;
    const cwd = ctx.cwd ?? process.cwd();
    const repoRoot = await findRepoRoot(cwd);

    const scopeDir = scopeToDir(scope);
    const reportPath = join(repoRoot, '.kb/release/history', scopeDir, id, 'report.json');

    try {
      const reportRaw = await readFile(reportPath, 'utf-8');
      const report: ReleaseReport = JSON.parse(reportRaw);

      if (!report.plan) {
        throw new Error(`No plan recorded for release ${id}`);
      }

      const plan: ReleasePlan = {
        ...report.plan,
        schemaVersion: report.plan.schemaVersion ?? '1.0',
        scope: report.plan.scope ?? scope,
        createdAt: report.plan.createdAt ?? report.ts,
      };

      return {
        id,
        plan,
      };
    } catch (error) {
      rethrowForRest(error);
    }
  }
});
