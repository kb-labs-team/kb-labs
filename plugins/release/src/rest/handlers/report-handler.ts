/**
 * Report handler - Get latest release report
 *
 * Reads from .kb/release/history/index.json and returns most recent report
 */

import { defineHandler, findRepoRoot, rethrowForRest } from '@kb-labs/sdk';
import type { ReportResponse, ReleaseReport } from '../../contracts/index.js';

export default defineHandler({
  async execute(ctx, _input: unknown): Promise<ReportResponse> {
    try {
    const cwd = ctx.cwd ?? process.cwd();
    const repoRoot = await findRepoRoot(cwd);

    // Read history index to find latest report
    const indexPath = `${repoRoot}/.kb/release/history/index.json`;

    let raw: string;
    try {
      raw = await ctx.runtime.fs.readFile(indexPath, 'utf-8');
    } catch {
      // No history yet
      return {
        hasReport: false,
      };
    }

    try {
      const index = JSON.parse(raw);

      if (!index.releases || index.releases.length === 0) {
        return {
          hasReport: false,
        };
      }

      // Get most recent release
      const latest = index.releases[0];

      // Read the full report
      const reportPath = `${repoRoot}/.kb/release/history/${latest.id}/report.json`;
      const reportRaw = await ctx.runtime.fs.readFile(reportPath, 'utf-8');
      const report: ReleaseReport = JSON.parse(reportRaw);

      return {
        hasReport: true,
        report,
        scope: report.scope,
      };
    } catch (error) {
      ctx.platform?.logger?.error?.(
        'Failed to read release report',
        error instanceof Error ? error : undefined,
        {}
      );

      return {
        hasReport: false,
      };
    }
    } catch (err) {
      rethrowForRest(err);
    }
  }
});
