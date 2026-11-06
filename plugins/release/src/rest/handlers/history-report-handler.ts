/**
 * History report handler - Get specific release report from history
 *
 * Reads: .kb/release/history/{scope}/{id}/report.json
 */

import { defineHandler, findRepoRoot, type RestInput, rethrowForRest } from '@kb-labs/sdk';
import type { HistoryReportResponse, ReleaseReport } from '../../contracts/index.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scopeToDir } from '../../shared/utils';

export interface HistoryReportParams {
  scope: string;  // Scope (e.g., "root" or "@kb-labs/shared")
  id: string;     // Release ID (folder name like 2026-01-04T12-30-00Z)
}

export default defineHandler({
  async execute(ctx, input: RestInput<unknown, unknown, HistoryReportParams>): Promise<HistoryReportResponse> {
    const { scope, id } = input.params!;
    const cwd = ctx.cwd ?? process.cwd();
    const repoRoot = await findRepoRoot(cwd);

    const scopeDir = scopeToDir(scope);
    const reportPath = join(repoRoot, '.kb/release/history', scopeDir, id, 'report.json');

    try {
      const reportRaw = await readFile(reportPath, 'utf-8');
      const report: ReleaseReport = JSON.parse(reportRaw);

      return {
        id,
        report,
      };
    } catch (error) {
      rethrowForRest(error);
    }
  }
});
