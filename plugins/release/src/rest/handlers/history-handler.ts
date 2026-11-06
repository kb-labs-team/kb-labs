/**
 * History handler - List all release history
 *
 * Reads: .kb/release/history/{scope}/{releaseId}/report.json
 */

import { defineHandler, findRepoRoot, type RestInput, rethrowForRest } from '@kb-labs/sdk';
import type { HistoryResponse, ReleaseHistoryItem } from '../../contracts/index.js';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { dirToScope, scopeToDir } from '../../shared/utils';

export interface HistoryInput {
  scope?: string; // Optional scope filter
}

export default defineHandler({
  async execute(ctx, input: RestInput<HistoryInput>): Promise<HistoryResponse> {
    try {
    const filterScope = input.query?.scope; // Optional scope filter
    const cwd = ctx.cwd ?? process.cwd();
    const repoRoot = await findRepoRoot(cwd);
    const historyDir = join(repoRoot, '.kb/release/history');

    try {
      const releases: ReleaseHistoryItem[] = [];

      // Read all scope directories
      const scopeEntries = await readdir(historyDir, { withFileTypes: true });
      const scopeFolders = scopeEntries.filter((e) => e.isDirectory());

      for (const scopeFolder of scopeFolders) {
        const scopeDirName = scopeFolder.name; // e.g., 'kb-labs-shared' or 'root'
        const scope = dirToScope(scopeDirName); // Convert to '@kb-labs/shared' or 'root'

        // If filter provided, skip non-matching scopes
        if (filterScope) {
          const filterDirName = scopeToDir(filterScope);
          if (scopeDirName !== filterDirName) {
            continue;
          }
        }

        const scopeDir = join(historyDir, scopeDirName);

        // Read all release folders within this scope
        const releaseEntries = await readdir(scopeDir, { withFileTypes: true });
        const releaseFolders = releaseEntries.filter((e) => e.isDirectory());

        for (const releaseFolder of releaseFolders) {
          const releaseId = releaseFolder.name;
          const reportPath = join(scopeDir, releaseId, 'report.json');

          try {
            const reportRaw = await readFile(reportPath, 'utf-8');
            const report = JSON.parse(reportRaw);

            releases.push({
              id: releaseId,
              timestamp: report.ts,
              scope: report.scope || scope,
              version: report.result?.version,
              packages: report.result?.published || [],
              success: report.result?.ok || false,
              stage: report.stage,
              error: report.result?.errors?.[0],
              channel: report.plan?.channel,
              flow: report.plan?.flow,
            });
          } catch {
            // Skip invalid/incomplete releases
            continue;
          }
        }
      }

      // Sort by timestamp descending (newest first)
      releases.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      return { releases };
    } catch {
      // No history directory yet
      return { releases: [] };
    }
    } catch (err) {
      rethrowForRest(err);
    }
  }
});
