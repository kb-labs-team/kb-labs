/**
 * History changelog handler - Get specific changelog from history
 *
 * Reads: .kb/release/history/{scope}/{id}/report.json
 *
 * The changelog is never persisted as a standalone changelog.md — it's
 * embedded in the release report at result.changelog. It's legitimately
 * absent for some releases (e.g. canary channel skips changelog generation
 * — see pipeline.ts), in which case we return an empty string rather than
 * throwing; the caller distinguishes "no changelog" from "release not found".
 */

import { defineHandler, findRepoRoot, type RestInput, rethrowForRest } from '@kb-labs/sdk';
import type { HistoryChangelogResponse, ReleaseReport } from '../../contracts/index.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scopeToDir } from '../../shared/utils';

export interface HistoryChangelogParams {
  scope: string;  // Scope (e.g., "root" or "@kb-labs/shared")
  id: string;     // Release ID (folder name like 2026-01-04T12-30-00Z)
}

export default defineHandler({
  async execute(ctx, input: RestInput<unknown, unknown, HistoryChangelogParams>): Promise<HistoryChangelogResponse> {
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
        markdown: report.result?.changelog ?? '',
        scope,
      };
    } catch (error) {
      rethrowForRest(error);
    }
  }
});
